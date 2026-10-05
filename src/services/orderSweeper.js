// 📁 backend/src/services/orderSweeper.js
//
// Runs a periodic sweep of the orders table, rescuing any orders that
// are stuck in transient states. This handles the case where the
// in-process setTimeout timers in order.routes.js are lost because the
// server restarted (deploy, crash, Render idle spin-down, etc.).
//
// Every 60s:
//   1. Orders stuck in 'assigned' past REASSIGN_AFTER_MS →
//        - if MAX_REASSIGNMENTS not reached: exclude agent, reset to 'searching'
//        - if MAX_REASSIGNMENTS reached: cancel with 'no_agent_available'
//   2. Orders stuck in 'searching' past SEARCH_TIMEOUT_MS →
//        - cancel with 'no_agent_available'
//
// The sweeper uses the DB as the source of truth, so it survives restarts.

const { pool } = require('../config/database');
const { notifyOrderEvent } = require('./notificationService');

// Same defaults as order.routes.js — override via env vars for testing
const REASSIGN_AFTER_MS = Number(process.env.REASSIGN_AFTER_MS) || 3 * 60 * 1000;
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS) || 3 * 60 * 1000;
const MAX_REASSIGNMENTS = Number(process.env.MAX_REASSIGNMENTS) || 2;

const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 60 * 1000;

let started = false;
let intervalHandle = null;

async function sweep() {
  const startedAt = Date.now();
  let rescuedAssigned = 0;
  let rescuedSearching = 0;

  try {
    // ─────────────────────────────────────────────
    // 1. Stuck in 'assigned' past the accept window
    // ─────────────────────────────────────────────
    const staleAssigned = await pool.query(
      `SELECT id, order_number, agent_id, excluded_agent_ids,
              reassignment_count
       FROM orders
       WHERE status = 'assigned'
         AND last_assigned_at IS NOT NULL
         AND last_assigned_at < NOW() - ($1::bigint || ' milliseconds')::interval`,
      [REASSIGN_AFTER_MS]
    );

    for (const order of staleAssigned.rows) {
      try {
        const newExcluded = [
          ...(order.excluded_agent_ids || []),
          order.agent_id,
        ].filter(Boolean);

        const isMaxed =
          (order.reassignment_count || 0) >= MAX_REASSIGNMENTS;

        if (isMaxed) {
          // Cancel outright
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
            [order.id, newExcluded]
          );

          // Free the agent's slot
          if (order.agent_id) {
            await pool.query(
              `UPDATE agents
               SET current_order_count = GREATEST(0, current_order_count - 1),
                   updated_at = NOW()
               WHERE id = $1`,
              [order.agent_id]
            );
          }

          // Unlink the thread
          await pool.query(
            `UPDATE chat_threads SET agent_id = NULL WHERE order_id = $1`,
            [order.id]
          );

          if (cancelled.rows[0]) {
            await notifyOrderEvent(cancelled.rows[0], 'cancelled');
            console.log(
              `🧹 [sweeper] Cancelled ${order.order_number} — no agent accepted after ${MAX_REASSIGNMENTS + 1} attempts`
            );
            rescuedAssigned++;
          }
        } else {
          // Reassign: reset to searching
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
            [order.id, newExcluded]
          );

          // Free the agent's slot
          if (order.agent_id) {
            await pool.query(
              `UPDATE agents
               SET current_order_count = GREATEST(0, current_order_count - 1),
                   updated_at = NOW()
               WHERE id = $1`,
              [order.agent_id]
            );
          }

          // Unlink the thread
          await pool.query(
            `UPDATE chat_threads SET agent_id = NULL WHERE order_id = $1`,
            [order.id]
          );

          if (reset.rows[0]) {
            await notifyOrderEvent(reset.rows[0], 'searching');
            console.log(
              `🧹 [sweeper] Reassigned ${order.order_number} (attempt ${(order.reassignment_count || 0) + 1}/${MAX_REASSIGNMENTS})`
            );
            rescuedAssigned++;
          }
        }
      } catch (err) {
        console.error(
          `[sweeper] failed to handle ${order.order_number}:`,
          err.message
        );
      }
    }

    // ─────────────────────────────────────────────
    // 2. Stuck in 'searching' past the search timeout
    // ─────────────────────────────────────────────
    const staleSearching = await pool.query(
      `UPDATE orders
       SET status = 'cancelled',
           cancellation_reason = 'no_agent_available',
           cancelled_at = NOW(),
           updated_at = NOW()
       WHERE status = 'searching'
         AND created_at < NOW() - ($1::bigint || ' milliseconds')::interval
       RETURNING *`,
      [SEARCH_TIMEOUT_MS]
    );

    for (const order of staleSearching.rows) {
      try {
        await notifyOrderEvent(order, 'cancelled');
        console.log(
          `🧹 [sweeper] Cancelled ${order.order_number} — no agent in radius`
        );
        rescuedSearching++;
      } catch (err) {
        console.error(
          `[sweeper] failed to notify ${order.order_number}:`,
          err.message
        );
      }
    }

    const elapsed = Date.now() - startedAt;
    if (rescuedAssigned + rescuedSearching > 0) {
      console.log(
        `🧹 [sweeper] rescued ${rescuedAssigned} assigned + ${rescuedSearching} searching in ${elapsed}ms`
      );
    }
  } catch (err) {
    console.error('[sweeper] sweep error:', err.message);
  }
}

function startOrderSweeper() {
  if (started) return;
  started = true;

  console.log(
    `🧹 Order sweeper started — every ${SWEEP_INTERVAL_MS / 1000}s ` +
      `(reassign after ${REASSIGN_AFTER_MS / 1000}s, ` +
      `timeout after ${SEARCH_TIMEOUT_MS / 1000}s, ` +
      `max reassignments ${MAX_REASSIGNMENTS})`
  );

  // First sweep 10s after boot — catches any orders that got stuck during
  // the restart window.
  setTimeout(() => {
    sweep().catch((err) => console.error('[sweeper] initial sweep error:', err));
  }, 10 * 1000);

  intervalHandle = setInterval(() => {
    sweep().catch((err) => console.error('[sweeper] interval sweep error:', err));
  }, SWEEP_INTERVAL_MS);
}

function stopOrderSweeper() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}

module.exports = {
  startOrderSweeper,
  stopOrderSweeper,
  sweep,
};