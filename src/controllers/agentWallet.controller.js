// 📁 backend/src/controllers/agentWallet.controller.js

const { pool } = require('../config/database');
const walletService = require('../services/walletService');

// GET /api/agent/wallet
const getWallet = async (req, res) => {
  try {
    const agentId = req.user.id;
    const r = await pool.query(
      `SELECT wallet_balance, status, flagged, flag_reason,
              breached_at, grace_period_ends_at, debt_at_flagging,
              commission_rate, available_balance, total_earnings, withdrawn
       FROM agents WHERE id = $1`,
      [agentId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Agent not found' });

    const a = r.rows[0];
    let daysRemaining = null;
    if (a.grace_period_ends_at) {
      const ms = new Date(a.grace_period_ends_at) - new Date();
      daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
    }

    res.json({
      walletBalance: Number(a.wallet_balance),
      status: a.status,
      flagged: a.flagged,
      flagReason: a.flag_reason,
      debtAtFlagging: a.debt_at_flagging ? Number(a.debt_at_flagging) : null,
      breachedAt: a.breached_at,
      gracePeriodEndsAt: a.grace_period_ends_at,
      daysRemaining,
      commissionRate: Number(a.commission_rate),
      availableBalance: Number(a.available_balance),
      totalEarnings: Number(a.total_earnings),
      withdrawn: Number(a.withdrawn),
    });
  } catch (err) {
    console.error('getWallet error:', err);
    res.status(500).json({ error: 'Failed to load wallet' });
  }
};

// GET /api/agent/wallet/ledger?limit=50
const getLedger = async (req, res) => {
  try {
    const agentId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await pool.query(
      `SELECT id, type, amount, balance_after, order_id, created_at
       FROM wallet_ledger
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [agentId, limit]
    );
    res.json({ entries: r.rows });
  } catch (err) {
    console.error('getLedger error:', err);
    res.status(500).json({ error: 'Failed to load ledger' });
  }
};

// POST /api/agent/settle  { amount }
// For cash agents paying their commission back to the platform.
const settle = async (req, res) => {
  try {
    const agentId = req.user.id;
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const r = await pool.query(
      'SELECT wallet_balance FROM agents WHERE id = $1',
      [agentId]
    );
    const bal = Number(r.rows[0].wallet_balance);
    if (bal >= 0) {
      return res.status(400).json({ error: 'Nothing to settle — balance is positive' });
    }

    const payTo = process.env.ADMIN_MPESA_NUMBER || '254700000000';
    const reference = `AGT-${agentId.slice(0, 8)}-SETTLE`;

    // Return instructions — the agent completes the M-Pesa payment in their
    // own M-Pesa app, and the C2B webhook will credit their wallet.
    res.json({
      payTo,
      amount: Math.min(amount, Math.abs(bal)),
      reference,
      currentBalance: bal,
      message: 'Send the amount via M-Pesa, then wait for confirmation.',
    });
  } catch (err) {
    console.error('settle error:', err);
    res.status(500).json({ error: 'Failed to create settlement' });
  }
};

// POST /api/agent/withdraw  { amount }
const withdraw = async (req, res) => {
  try {
    const agentId = req.user.id;
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const r = await pool.query(
      'SELECT wallet_balance, flagged, mpesa_number FROM agents WHERE id = $1',
      [agentId]
    );
    const a = r.rows[0];
    if (a.flagged) return res.status(403).json({ error: 'Account blocked' });

    const bal = Number(a.wallet_balance);
    if (bal <= 0) {
      return res.status(400).json({
        error: 'Nothing to withdraw — settle your commission first.',
        walletBalance: bal,
      });
    }
    if (amount > bal) {
      return res.status(400).json({ error: 'Amount exceeds wallet balance' });
    }

    // Debit the wallet and queue a payout (existing payout system handles the M-Pesa B2C call)
    await walletService.debit(agentId, amount, 'WITHDRAWAL');
    await walletService.updateBreachState(agentId);

    res.json({
      success: true,
      amount,
      newBalance: +(bal - amount).toFixed(2),
      message: 'Withdrawal queued — you will receive an M-Pesa confirmation shortly.',
    });
  } catch (err) {
    console.error('withdraw error:', err);
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
};

module.exports = { getWallet, getLedger, settle, withdraw };