// 📁 backend/src/services/notificationService.js
// Matches the existing `notifications` table:
//   id, user_id, title, message, type, data, is_read, created_at

const { pool } = require('../config/database');
const { render } = require('./notificationTemplates');

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

/**
 * Create a notification.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.eventType       e.g. 'order_status'
 * @param {string} opts.templateKey     e.g. 'order_status_customer'
 * @param {object} [opts.ctx]           variables passed to the template
 * @param {string} [opts.groupKey]      e.g. 'order:<uuid>'
 * @param {object} [opts.payloadOverride] force a specific payload
 * @param {object} [opts.client]        optional pg client (for transactions)
 */
async function createNotification({
  userId,
  eventType,
  templateKey,
  ctx = {},
  groupKey = null,
  payloadOverride = null,
  client = null,
}) {
  if (!userId || !eventType || !templateKey) return null;

  const { title, body, payload } = render(templateKey, ctx);
  const basePayload = payloadOverride || payload;

  // Merge event + group_key into the `data` jsonb
  const data = {
    ...basePayload,
    event: eventType,
    ...(groupKey ? { group_key: groupKey } : {}),
  };

  const runner = client || pool;

  try {
    // Dedup: skip if the same event for the same user in the same minute exists.
    const { rows } = await runner.query(
      `
      INSERT INTO notifications
        (user_id, title, message, type, data, is_read, created_at)
      SELECT $1, $2, $3, $4, $5::jsonb, false, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE user_id = $1
          AND type = $4
          AND data->>'event' = $6
          AND ($7::text IS NULL OR data->>'group_key' = $7)
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
    return rows[0] || null;
  } catch (err) {
    // Notifications are best-effort; never crash the caller's transaction.
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
 * Fire the correct notification(s) for an order event.
 * Called from every route that changes order status.
 *
 * `order.agent_id` refers to agents.id, but notifications.user_id
 * expects users.id. This helper resolves the mapping before inserting.
 *
 * @param {object} order   full order row (id, order_number, customer_id, agent_id)
 * @param {string} status  new status
 * @param {object} [opts]  { client } for transaction safety
 */
async function notifyOrderEvent(order, status, opts = {}) {
  if (!order || !order.id) return;

  const { client = null } = opts;
  const runner = client || pool;

  const ctx = {
    order_number: order.order_number,
    order_id: order.id,
    status,
  };

  // ---- Customer ----
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

  // ---- Agent ----
  // order.agent_id is agents.id — resolve to users.id first.
  if (order.agent_id) {
    try {
      const { rows } = await runner.query(
        `SELECT user_id FROM agents WHERE id = $1`,
        [order.agent_id]
      );
      const agentUserId = rows[0]?.user_id;

      if (agentUserId) {
        await createNotification({
          userId: agentUserId,
          eventType: 'order_status',
          templateKey: 'order_status_agent',
          groupKey: `order:${order.id}`,
          ctx,
          client,
        });
      } else {
        console.warn(
          `notifyOrderEvent: no users.id for agents.id=${order.agent_id}`
        );
      }
    } catch (e) {
      console.error(
        `notifyOrderEvent: agent lookup failed for agents.id=${order.agent_id}:`,
        e.message
      );
    }
  }
}

/**
 * List notifications for a user (newest first).
 */
async function listNotifications(userId, { limit = 50, unreadOnly = false } = {}) {
  const params = [userId, limit];
  let where = `WHERE user_id = $1`;
  if (unreadOnly) where += ` AND is_read = false`;

  const { rows } = await pool.query(
    `
    SELECT id, user_id, title, message, type, data, is_read, created_at
    FROM notifications
    ${where}
    ORDER BY created_at DESC
    LIMIT $2
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
     WHERE user_id = $1 AND is_read = false`,
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
     WHERE id = $1 AND user_id = $2 AND is_read = false
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
     WHERE user_id = $1 AND is_read = false`,
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
     WHERE user_id = $1
       AND data->>'group_key' = $2
       AND is_read = false`,
    [userId, groupKey]
  );
}

module.exports = {
  createNotification,
  createNotificationForMany,
  notifyOrderEvent,
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  markGroupRead,
};