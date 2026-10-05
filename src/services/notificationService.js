// 📁 backend/src/services/notificationService.js
// Matches the existing `notifications` table:
//   id, user_id, title, message, type, data, is_read, created_at

const { pool } = require('../config/database');
const { render } = require('./notificationTemplates');
const { sendPushToUser } = require('./pushService');

// The `type` column has a CHECK constraint:
//   type IN ('order', 'payment', 'system', 'promotion')
// Specific event names (order_accepted, payment_received, etc.) live inside
// the `data` jsonb as data.event.
function typeForEvent(eventType) {
  if (!eventType) return 'system';
  if (eventType.startsWith('order')) return 'order';
  if (eventType.startsWith('payment') || eventType.startsWith('refund')) {
    return 'payment';
  }
  if (eventType === 'promo' || eventType === 'promotion') return 'promotion';
  return 'system';
}

// --------------------------------------------------
// Order event → chat thread system message
// --------------------------------------------------
const ORDER_EVENT_MESSAGES = {
  pending:         'Order placed — finding a partner',
  searching:       'Searching for the nearest partner',
  assigned:        'You received a new order to deliver',
  accepted:        'Agent accepted the order',
  out_for_delivery:'Your order is on the way',
  delivered:       'Order delivered — please confirm receipt',
  confirmed:       'Customer confirmed receipt',
  paid:            'Payment received — order closed',
  cash_collected:  'Cash received — order closed',
  cancelled:       'Order cancelled',
  declined:        'Agent declined the order',
};

/**
 * Append a system message to the order's chat thread.
 * Silent no-op if the thread doesn't exist or the status is unknown.
 */
async function appendOrderChatMessage(order, status, { client = null } = {}) {
  if (!order?.id) return;
  const body = ORDER_EVENT_MESSAGES[status];
  if (!body) return;

  const runner = client || pool;
  try {
    // Find the order's thread
    const threadRes = await runner.query(
      `SELECT id FROM chat_threads WHERE order_id = $1 LIMIT 1`,
      [order.id]
    );
    if (threadRes.rows.length === 0) return;

    const threadId = threadRes.rows[0].id;

    // Insert the system message
    await runner.query(
      `INSERT INTO chat_messages
         (thread_id, sender_id, sender_role, body, created_at)
       VALUES ($1, NULL, 'system', $2, NOW())`,
      [threadId, body]
    );

    // Update the thread's last-message fields so it surfaces at the top
    // of the thread list
    await runner.query(
      `UPDATE chat_threads
       SET last_message_at = NOW(),
           last_message_preview = LEFT($1, 200),
           updated_at = NOW()
       WHERE id = $2`,
      [body, threadId]
    );
  } catch (err) {
    // Best-effort — never crash the caller
    console.error('appendOrderChatMessage failed:', err.message);
  }
}

/**
 * Create a notification, then fire a push for it.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.eventType       e.g. 'order_status'
 * @param {string} opts.templateKey     e.g. 'order_status_customer'
 * @param {object} [opts.ctx]           variables passed to the template
 * @param {string} [opts.groupKey]      e.g. 'order:<uuid>'
 * @param {object} [opts.payloadOverride] force a specific payload
 * @param {object} [opts.client]        optional pg client (for transactions)
 * @param {boolean} [opts.skipPush]     set true to skip push (e.g. bulk backfill)
 */
async function createNotification({
  userId,
  eventType,
  templateKey,
  ctx = {},
  groupKey = null,
  payloadOverride = null,
  client = null,
  skipPush = false,
}) {
  if (!userId || !eventType || !templateKey) return null;

  const { title, body, payload } = render(templateKey, ctx);
  const basePayload = payloadOverride || payload;

  const data = {
    ...basePayload,
    event: eventType,
    ...(groupKey ? { group_key: groupKey } : {}),
  };

  const runner = client || pool;

  try {
    const { rows } = await runner.query(
      `
      INSERT INTO notifications
        (user_id, title, message, type, data, is_read, created_at)
      SELECT
        $1::uuid,
        $2::varchar,
        $3::text,
        $4::varchar,
        $5::jsonb,
        false,
        NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE user_id = $1::uuid
          AND type = $4::varchar
          AND data->>'event' = $6::text
          AND ($7::text IS NULL OR data->>'group_key' = $7::text)
          AND created_at > NOW() - INTERVAL '1 minute'
      )
      RETURNING *
      `,
      [
        userId,
        title,
        body,
        typeForEvent(eventType),
        JSON.stringify(data),
        eventType,
        groupKey,
      ]
    );

    const notification = rows[0] || null;

    if (notification && !skipPush) {
      sendPushToUser(userId, {
        title,
        body,
        data: {
          notificationId: notification.id,
          ...data,
        },
      }).catch((e) =>
        console.warn('push fan-out failed:', e?.message)
      );
    }

    return notification;
  } catch (err) {
    console.error('createNotification failed:', err.message);
    return null;
  }
}

/**
 * Fire the same event to multiple users.
 */
async function createNotificationForMany({ userIds, ...rest }) {
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  const results = await Promise.all(
    userIds.map((userId) => createNotification({ userId, ...rest }))
  );
  return results.filter(Boolean);
}

/**
 * Fire the correct notification(s) for an order event, AND append a system
 * message to the order's chat thread so the thread shows the full timeline.
 *
 * Called from every route that changes order status.
 *
 * @param {object} order   full order row (id, order_number, customer_id, agent_id)
 * @param {string} status  new status
 * @param {object} [opts]  { client } for transaction safety
 */
async function notifyOrderEvent(order, status, opts = {}) {
  if (!order || !order.id) return;

  const { client = null } = opts;

  const ctx = {
    order_number: order.order_number,
    order_id: order.id,
    status,
  };

  // ---- Customer notification ----
  if (order.customer_id) {
    await createNotification({
      userId: order.customer_id,
      eventType: 'order_status',
      templateKey: 'order_status_customer',
      groupKey: `order:${order.id}`,
      ctx,
      client,
    });
  }

  // ---- Agent notification ----
  // agents.id === users.id, so use order.agent_id directly. No lookup needed.
  if (order.agent_id) {
    await createNotification({
      userId: order.agent_id,
      eventType: 'order_status',
      templateKey: 'order_status_agent',
      groupKey: `order:${order.id}`,
      ctx,
      client,
    });
  }

  // ---- Append a system message to the order's chat thread ----
  // One message per event, seen by both parties (same thread).
  await appendOrderChatMessage(order, status, { client });
}

/**
 * List notifications for a user (newest first).
 */
async function listNotifications(userId, { limit = 50, unreadOnly = false } = {}) {
  const params = [userId, limit];
  let where = `WHERE user_id = $1::uuid`;
  if (unreadOnly) where += ` AND is_read = false`;

  const { rows } = await pool.query(
    `
    SELECT id, user_id, title, message, type, data, is_read, created_at
    FROM notifications
    ${where}
    ORDER BY created_at DESC
    LIMIT $2::int
    `,
    params
  );
  return rows;
}

/**
 * Unread count for a user.
 */
async function unreadCount(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM notifications
     WHERE user_id = $1::uuid AND is_read = false`,
    [userId]
  );
  return rows[0]?.count || 0;
}

/**
 * Mark one notification as read.
 */
async function markRead(userId, notificationId) {
  const { rows } = await pool.query(
    `UPDATE notifications
     SET is_read = true
     WHERE id = $1::uuid AND user_id = $2::uuid AND is_read = false
     RETURNING *`,
    [notificationId, userId]
  );
  return rows[0] || null;
}

/**
 * Mark all notifications for a user as read.
 */
async function markAllRead(userId) {
  await pool.query(
    `UPDATE notifications
     SET is_read = true
     WHERE user_id = $1::uuid AND is_read = false`,
    [userId]
  );
  return true;
}

/**
 * Mark every notification in a group as read
 * (e.g. when the user opens a specific chat thread).
 */
async function markGroupRead(userId, groupKey) {
  if (!groupKey) return;
  await pool.query(
    `UPDATE notifications
     SET is_read = true
     WHERE user_id = $1::uuid
       AND data->>'group_key' = $2::text
       AND is_read = false`,
    [userId, groupKey]
  );
}

module.exports = {
  createNotification,
  createNotificationForMany,
  notifyOrderEvent,
  appendOrderChatMessage,
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  markGroupRead,
};