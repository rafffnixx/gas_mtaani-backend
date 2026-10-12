// 📁 backend/src/controllers/adminAgent.controller.js

const { pool } = require('../config/database');
const walletService = require('../services/walletService');

// GET /api/admin/agents/flagged
const listFlagged = async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.id, a.business_name, a.mpesa_number, a.id_number,
              a.wallet_balance, a.status, a.flagged, a.flag_reason,
              a.flagged_at, a.debt_at_flagging,
              a.breached_at, a.grace_period_ends_at
       FROM agents a
       WHERE a.flagged = TRUE OR a.status IN ('GRACE_PERIOD', 'FLAGGED_DEBTOR', 'BLACKLISTED')
       ORDER BY a.flagged_at DESC NULLS LAST, a.breached_at DESC NULLS LAST`
    );
    res.json({ agents: r.rows });
  } catch (err) {
    console.error('listFlagged error:', err);
    res.status(500).json({ error: 'Failed to load agents' });
  }
};

// POST /api/admin/agent/:id/unblock  { reason }
const unblock = async (req, res) => {
  try {
    const { id } = req.params;
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Reason is required' });

    await walletService.unblock(id, req.user.id, reason);
    res.json({ success: true });
  } catch (err) {
    console.error('unblock error:', err);
    res.status(500).json({ error: 'Failed to unblock' });
  }
};

// POST /api/admin/agent/:id/blacklist  { reason }
const blacklist = async (req, res) => {
  try {
    const { id } = req.params;
    const reason = (req.body.reason || 'Manual blacklist').trim();

    const r = await pool.query(
      `SELECT mpesa_number, id_number, business_name, wallet_balance
       FROM agents WHERE id = $1`,
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Agent not found' });
    const a = r.rows[0];

    await pool.query(
      `INSERT INTO blacklist_entries
       (phone, id_number, business_name, debt_amount, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [a.mpesa_number, a.id_number, a.business_name, a.wallet_balance, reason]
    );
    await pool.query(
      `UPDATE agents SET status = 'BLACKLISTED', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('blacklist error:', err);
    res.status(500).json({ error: 'Failed to blacklist' });
  }
};

module.exports = { listFlagged, unblock, blacklist };