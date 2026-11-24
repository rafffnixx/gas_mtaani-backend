// 📁 backend/src/services/walletService.js
//
// Source of truth for agent wallet movements.
// Every credit/debit writes a row to wallet_ledger AND updates agents.wallet_balance.
// Never update wallet_balance without going through here.

const { pool } = require('../config/database');

const BLOCK_THRESHOLD = Number(process.env.WALLET_BLOCK_THRESHOLD) || -1000;
const GRACE_MONTHS = Number(process.env.WALLET_GRACE_MONTHS) || 3;

/**
 * Record a wallet movement.
 *
 * By default runs in its own transaction. Pass `externalClient` to participate
 * in a caller-owned transaction (the caller MUST have already run BEGIN and
 * MUST eventually COMMIT or ROLLBACK).
 *
 * @param {string} agentId
 * @param {number} amount          positive = credit, negative = debit
 * @param {string} type            CASH_COMMISSION | MPESA_EARNING | SETTLEMENT | WITHDRAWAL
 * @param {string|null} orderId
 * @param {object|null} externalClient  optional pg client inside an open tx
 * @returns {Promise<{balanceAfter:number}>}
 */
async function record(agentId, amount, type, orderId = null, externalClient = null) {
  const runner = externalClient || (await pool.connect());
  const ownsTx = !externalClient;

  try {
    if (ownsTx) await runner.query('BEGIN');

    // 1. Lock the agent row
    const agentRes = await runner.query(
      'SELECT wallet_balance FROM agents WHERE id = $1 FOR UPDATE',
      [agentId]
    );
    if (agentRes.rows.length === 0) {
      const err = new Error(`Agent ${agentId} not found`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }

    const before = Number(agentRes.rows[0].wallet_balance) || 0;
    const after = +(before + Number(amount)).toFixed(2);

    // 2. Update cached balance
    await runner.query(
      'UPDATE agents SET wallet_balance = $1, updated_at = NOW() WHERE id = $2',
      [after, agentId]
    );

    // 3. Write ledger row
    await runner.query(
      `INSERT INTO wallet_ledger (agent_id, order_id, type, amount, balance_after)
       VALUES ($1, $2, $3, $4, $5)`,
      [agentId, orderId, type, amount, after]
    );

    if (ownsTx) await runner.query('COMMIT');
    return { balanceAfter: after };
  } catch (err) {
    if (ownsTx) await runner.query('ROLLBACK');
    throw err;
  } finally {
    if (ownsTx) runner.release();
  }
}

const credit = (agentId, amount, type, orderId = null, externalClient = null) =>
  record(agentId, Math.abs(amount), type, orderId, externalClient);

const debit = (agentId, amount, type, orderId = null, externalClient = null) =>
  record(agentId, -Math.abs(amount), type, orderId, externalClient);

/**
 * Recompute grace/block state after any wallet change.
 * Called by the scheduler and after every ledger write.
 */
async function updateBreachState(agentId) {
  const r = await pool.query(
    `SELECT wallet_balance, breached_at, grace_period_ends_at, flagged, status
     FROM agents WHERE id = $1`,
    [agentId]
  );
  if (r.rows.length === 0) return null;
  const a = r.rows[0];
  const bal = Number(a.wallet_balance);

  if (bal > BLOCK_THRESHOLD) {
    if (a.breached_at && !a.flagged) {
      await pool.query(
        `UPDATE agents
         SET breached_at = NULL,
             grace_period_ends_at = NULL,
             status = 'ACTIVE',
             updated_at = NOW()
         WHERE id = $1`,
        [agentId]
      );
    }
    return { status: a.flagged ? 'FLAGGED_DEBTOR' : 'ACTIVE' };
  }

  if (!a.breached_at) {
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + GRACE_MONTHS);

    await pool.query(
      `UPDATE agents
       SET breached_at = $1,
           grace_period_ends_at = $2,
           status = 'GRACE_PERIOD',
           updated_at = NOW()
       WHERE id = $3`,
      [now, end, agentId]
    );
    return { status: 'GRACE_PERIOD', gracePeriodEndsAt: end };
  }

  return {
    status: a.status,
    gracePeriodEndsAt: a.grace_period_ends_at,
    flagged: a.flagged,
  };
}

/**
 * Throws a structured error if the agent cannot take new orders.
 */
async function assertAgentCanReceiveOrders(agentId) {
  const r = await pool.query(
    `SELECT wallet_balance, flagged, status, grace_period_ends_at, flag_reason
     FROM agents WHERE id = $1`,
    [agentId]
  );
  if (r.rows.length === 0) {
    const err = new Error('Agent not found');
    err.code = 'AGENT_NOT_FOUND';
    throw err;
  }
  const a = r.rows[0];

  if (a.flagged) {
    const err = new Error('Account permanently blocked for unpaid commission.');
    err.code = 'AGENT_BLOCKED';
    err.flagged = true;
    err.walletBalance = Number(a.wallet_balance);
    err.reason = a.flag_reason;
    throw err;
  }

  const bal = Number(a.wallet_balance);
  if (bal <= BLOCK_THRESHOLD) {
    if (!a.grace_period_ends_at) {
      await updateBreachState(agentId);
    } else if (new Date(a.grace_period_ends_at) < new Date()) {
      await permanentlyBlock(agentId, 'Grace period expired with unpaid commission');
      const err = new Error('Grace period expired. Account permanently blocked.');
      err.code = 'AGENT_BLOCKED';
      err.flagged = true;
      err.walletBalance = bal;
      throw err;
    }
  }
  return true;
}

/**
 * Permanently flag an agent. Idempotent.
 */
async function permanentlyBlock(agentId, reason) {
  const r = await pool.query(
    `UPDATE agents
     SET flagged = TRUE,
         flagged_at = NOW(),
         flag_reason = $1,
         debt_at_flagging = wallet_balance,
         status = 'FLAGGED_DEBTOR',
         updated_at = NOW()
     WHERE id = $2 AND flagged = FALSE
     RETURNING id, wallet_balance`,
    [reason, agentId]
  );
  return r.rows[0] || null;
}

/**
 * Manual admin unblock. Requires a reason.
 */
async function unblock(agentId, adminId, reason) {
  await pool.query(
    `UPDATE agents
     SET flagged = FALSE,
         flagged_at = NULL,
         flag_reason = NULL,
         debt_at_flagging = NULL,
         breached_at = NULL,
         grace_period_ends_at = NULL,
         status = 'ACTIVE',
         updated_at = NOW()
     WHERE id = $1`,
    [agentId]
  );
  await pool.query(
    `INSERT INTO wallet_ledger (agent_id, type, amount, balance_after)
     SELECT id, 'ADMIN_UNBLOCK', 0, wallet_balance
     FROM agents WHERE id = $1`,
    [agentId]
  );
  console.log(`[wallet] admin ${adminId} unblocked ${agentId}: ${reason}`);
}

module.exports = {
  record,
  credit,
  debit,
  updateBreachState,
  assertAgentCanReceiveOrders,
  permanentlyBlock,
  unblock,
  BLOCK_THRESHOLD,
  GRACE_MONTHS,
};