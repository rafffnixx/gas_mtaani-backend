// 📁 backend/src/services/orderSearch.js
//
// Shared agent-search + reassignment + timeout logic.
// Used by BOTH order.routes.js (order creation) and payment.routes.js
// (deferred search after Pesapal payment confirms).
//
// The timers Maps live here at module scope so they survive across
// requests and are shared between the two routes.

const { pool } = require('../config/database');
const { latLngToHex, hexesUpToRing } = require('../utils/hexGrid');
const { notifyOrderEvent } = require('./notificationService');

// ---------------------------------------------------------
// Timers — module-level. Every searching / assigned order
// has at most one of each.
// ---------------------------------------------------------
const reassignTimers = new Map();   // orderId -> timeout handle
const searchTimers   = new Map();   // orderId -> timeout handle

const REASSIGN_AFTER_MS  = Number(process.env.REASSIGN_AFTER_MS)  || 3 * 60 * 1000;
const SEARCH_TIMEOUT_MS  = Number(process.env.SEARCH_TIMEOUT_MS)  || 3 * 60 * 1000;
const MAX_REASSIGNMENTS  = Number(process.env.MAX_REASSIGNMENTS)  || 2;

function clearReassignTimer(orderId) {
  const handle = reassignTimers.get(orderId);
  if (handle) {
    clearTimeout(handle);
    reassignTimers.delete(orderId);
  }
}

function clearSearchTimer(orderId) {
  const handle = searchTimers.get(orderId);
  if (handle) {
    clearTimeout(handle);
    searchTimers.delete(orderId);
  }
}

function clearAllTimers(orderId) {
  clearReassignTimer(orderId);
  clearSearchTimer(orderId);
}

// ---------------------------------------------------------
// Schedule the search-timeout timer for a searching order
// ---------------------------------------------------------
function scheduleSearchTimeout(orderId) {
  clearSearchTimer(orderId);
  const handle = setTimeout(() => {
    searchTimers.delete(orderId);
    handleSearchTimeout(orderId).catch((err) =>
      console.error('handleSearchTimeout failed:', err)
    );
  }, SEARCH_TIMEOUT_MS);
  searchTimers.set(orderId, handle);
}

// ---------------------------------------------------------
// Schedule the reassign timer for an assigned order
// ---------------------------------------------------------
function scheduleReassignTimeout(orderId) {
  clearReassignTimer(orderId);
  const handle = setTimeout(() => {
    reassignTimers.delete(orderId);
    handleReassignment(orderId).catch((err) =>
      console.error('handleReassignment failed:', err)
    );
  }, REASSIGN_AFTER_MS);
  reassignTimers.set(orderId, handle);
}

// =====================================================
// BACKGROUND: Find an agent for this order.
// Excludes agents in orders.excluded_agent_ids.
// =====================================================
async function runAgentSearch(orderId) {
  try {
    const { rows } = await pool.query(
      `SELECT id, customer_latitude, customer_longitude, status,
              excluded_agent_ids, reassignment_count
       FROM orders WHERE id = $1`,
      [orderId]
    );
    if (rows.length === 0) return;
    const order = rows[0];

    if (order.status !== 'searching') return;

    if (order.customer_latitude == null || order.customer_longitude == null) {
      console.warn(`Order ${orderId} has no coords — cannot search`);
      return;
    }

    const lat = Number(order.customer_latitude);
    const lng = Number(order.customer_longitude);
    const excluded = order.excluded_agent_ids || [];

    const itemsRes = await pool.query(
      `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
      [orderId]
    );
    const items = itemsRes.rows;
    if (items.length === 0) return;

    const productIds = items.map((i) => i.product_id);
    const itemCount = items.length;

    const customerHex = latLngToHex(lat, lng);

    for (let ring = 1; ring <= 4; ring++) {
      const hexes = hexesUpToRing(customerHex, ring);

      const { rows: candidates } = await pool.query(
        `
        SELECT
          a.id                AS agent_id,
          a.partner_code,
          a.rating,
          a.current_order_count,
          COUNT(DISTINCT ai.product_id) AS items_covered
        FROM agents a
        JOIN agent_inventory ai ON ai.agent_id = a.id
        WHERE a.hex_id = ANY($1::bigint[])
          AND a.is_online = true
          AND a.is_approved = true
          AND a.current_order_count < a.max_order_capacity
          AND ai.product_id = ANY($2::uuid[])
          AND ai.stock_quantity > 0
          AND NOT (a.id = ANY($4::uuid[]))
        GROUP BY a.id, a.partner_code, a.rating, a.current_order_count
        HAVING COUNT(DISTINCT ai.product_id) = $3
        ORDER BY a.current_order_count ASC, a.rating DESC NULLS LAST
        LIMIT 1
        `,
        [hexes, productIds, itemCount, excluded]
      );

      if (candidates.length > 0) {
        const agent = candidates[0];

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const lock = await client.query(
            `SELECT status FROM orders WHERE id = $1 FOR UPDATE`,
            [orderId]
          );
          if (lock.rows[0]?.status !== 'searching') {
            await client.query('ROLLBACK');
            return;
          }

          for (const item of items) {
            const inv = await client.query(
              `SELECT id, stock_quantity FROM agent_inventory
               WHERE agent_id = $1 AND product_id = $2
               FOR UPDATE`,
              [agent.agent_id, item.product_id]
            );
            if (
              inv.rows.length === 0 ||
              inv.rows[0].stock_quantity < item.quantity
            ) {
              await client.query('ROLLBACK');
              throw new Error('Stock changed during assignment');
            }
            await client.query(
              `UPDATE agent_inventory
               SET stock_quantity = stock_quantity - $1,
                   is_available = CASE
                     WHEN stock_quantity - $1 <= 0 THEN false
                     ELSE is_available
                   END,
                   updated_at = NOW()
               WHERE id = $2`,
              [item.quantity, inv.rows[0].id]
            );
          }

          const assignedRes = await client.query(
            `UPDATE orders
             SET agent_id = $1,
                 assigned_partner_code = $2,
                 hex_ring = $3,
                 status = 'assigned',
                 assigned_at = NOW(),
                 last_assigned_at = NOW(),
                 updated_at = NOW()
             WHERE id = $4
             RETURNING *`,
            [agent.agent_id, agent.partner_code, ring, orderId]
          );

          await client.query(
            `UPDATE chat_threads
             SET agent_id = $1, updated_at = NOW()
             WHERE order_id = $2 AND agent_id IS NULL`,
            [agent.agent_id, orderId]
          );

          await client.query(
            `UPDATE agents
             SET current_order_count = current_order_count + 1,
                 updated_at = NOW()
             WHERE id = $1`,
            [agent.agent_id]
          );

          await client.query('COMMIT');

          await notifyOrderEvent(assignedRes.rows[0], 'assigned');

          clearSearchTimer(orderId);
          scheduleReassignTimeout(orderId);

          console.log(
            `✅ Order ${orderId} assigned to ${agent.partner_code} (ring ${ring})`
          );
          return;
        } catch (err) {
          console.error('Assignment transaction failed:', err.message);
        } finally {
          client.release();
        }
      }
    }

    console.log(`❌ No agent found for order ${orderId} on this pass`);
  } catch (err) {
    console.error('runAgentSearch error:', err);
  }
}

// =====================================================
// Reassignment handler
// =====================================================
async function handleReassignment(orderId) {
  try {
    const { rows } = await pool.query(
      `SELECT id, status, agent_id, reassignment_count,
              excluded_agent_ids, order_number
       FROM orders WHERE id = $1`,
      [orderId]
    );
    if (rows.length === 0) return;
    const order = rows[0];

    if (order.status !== 'assigned') {
      console.log(
        `⏭  Reassignment skipped for ${order.order_number} (status=${order.status})`
      );
      return;
    }

    const newExcluded = [
      ...(order.excluded_agent_ids || []),
      order.agent_id,
    ].filter(Boolean);

    if ((order.reassignment_count || 0) >= MAX_REASSIGNMENTS) {
      const cancelled = await pool.query(
        `UPDATE orders
         SET status = 'cancelled',
             cancellation_reason = 'no_agent_available',
             cancelled_at = NOW(),
             excluded_agent_ids = $2::uuid[],
             reassignment_count = reassignment_count + 1,
             updated_at = NOW()
         WHERE id = $1 AND status = 'assigned'
         RETURNING *`,
        [orderId, newExcluded]
      );

      await pool.query(
        `UPDATE agents
         SET current_order_count = GREATEST(0, current_order_count - 1),
             updated_at = NOW()
         WHERE id = $1`,
        [order.agent_id]
      );

      clearAllTimers(orderId);

      if (cancelled.rows[0]) {
        await notifyOrderEvent(cancelled.rows[0], 'cancelled');
        console.log(
          `⏱  Order ${order.order_number} cancelled — no agent accepted after ${MAX_REASSIGNMENTS + 1} attempts`
        );
      }
      return;
    }

    const reset = await pool.query(
      `UPDATE orders
       SET status = 'searching',
           agent_id = NULL,
           assigned_partner_code = NULL,
           assigned_at = NULL,
           hex_ring = NULL,
           excluded_agent_ids = $2::uuid[],
           reassignment_count = reassignment_count + 1,
           updated_at = NOW()
       WHERE id = $1 AND status = 'assigned'
       RETURNING *`,
      [orderId, newExcluded]
    );

    await pool.query(
      `UPDATE chat_threads
       SET agent_id = NULL, updated_at = NOW()
       WHERE order_id = $1`,
      [orderId]
    );

    await pool.query(
      `UPDATE agents
       SET current_order_count = GREATEST(0, current_order_count - 1),
           updated_at = NOW()
       WHERE id = $1`,
      [order.agent_id]
    );

    if (reset.rows[0]) {
      await notifyOrderEvent(reset.rows[0], 'searching');
      console.log(
        `🔄 Order ${order.order_number} reassigned (attempt ${(order.reassignment_count || 0) + 1}/${MAX_REASSIGNMENTS})`
      );

      runAgentSearch(orderId).catch((err) =>
        console.error('Reassign search failed:', err)
      );

      scheduleSearchTimeout(orderId);
    }
  } catch (err) {
    console.error('handleReassignment error:', err);
  }
}

// =====================================================
// Search timeout
// =====================================================
async function handleSearchTimeout(orderId) {
  try {
    const result = await pool.query(
      `UPDATE orders
       SET status = 'cancelled',
           cancellation_reason = 'no_agent_available',
           cancelled_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND status = 'searching'
       RETURNING *`,
      [orderId]
    );

    clearAllTimers(orderId);

    if (result.rows[0]) {
      await notifyOrderEvent(result.rows[0], 'cancelled');
      console.log(
        `⏱  Order ${result.rows[0].order_number} cancelled — no agent available in radius`
      );
    }
  } catch (err) {
    console.error('handleSearchTimeout error:', err);
  }
}

// =====================================================
// PUBLIC: begin search for an order (called after payment success)
// =====================================================
async function startSearchForOrder(orderId) {
  clearAllTimers(orderId);
  runAgentSearch(orderId).catch((err) =>
    console.error('runAgentSearch failed:', err)
  );
  scheduleSearchTimeout(orderId);
}

module.exports = {
  runAgentSearch,
  handleReassignment,
  handleSearchTimeout,
  clearAllTimers,
  clearReassignTimer,
  clearSearchTimer,
  scheduleReassignTimeout,
  scheduleSearchTimeout,
  startSearchForOrder,
  MAX_REASSIGNMENTS,
  REASSIGN_AFTER_MS,
  SEARCH_TIMEOUT_MS,
};