// 📁 backend/src/services/settlementService.js
//
// Handles agents paying their owed commission back to the platform
// via PesaPal. Flow:
//   1. Agent taps "Settle" → POST /api/agents/settle/initiate
//   2. This service creates a commission_settlements row, calls PesaPal,
//      returns the redirect_url.
//   3. Agent pays on PesaPal.
//   4. PesaPal IPN hits /api/agents/settle/ipn → this service verifies and
//      credits the wallet with +amount.

const { pool } = require('../config/database');
const walletService = require('./walletService');
const pesapal = require('./pesapalService');

const PUBLIC_BASE_URL = pesapal.PUBLIC_BASE_URL;
const SETTLE_IPN_ID = pesapal.SETTLE_IPN_ID;

async function initiate(agentId, amount) {
  const agentRes = await pool.query(
    `SELECT wallet_balance, mpesa_number, mpesa_name
     FROM agents WHERE id = $1`,
    [agentId]
  );
  if (agentRes.rows.length === 0) throw new Error('Agent not found');

  const agent = agentRes.rows[0];
  const bal = Number(agent.wallet_balance || 0);
  if (bal >= 0) {
    const err = new Error('Nothing to settle — wallet balance is not negative');
    err.code = 'NOTHING_TO_SETTLE';
    throw err;
  }

  const owed = Math.abs(bal);
  const pay = Math.min(Number(amount) || owed, owed);
  if (pay <= 0) throw new Error('Invalid settlement amount');

  const contactRes = await pool.query(
    `SELECT email, phone_number, full_name FROM users WHERE id = $1`,
    [agentId]
  );
  const contact = contactRes.rows[0] || {};
  const parts = (contact.full_name || 'Agent').split(' ');

  const reference = `SETTLE-${agentId.slice(0, 8)}-${Date.now()}`;

  const ins = await pool.query(
    `INSERT INTO commission_settlements (agent_id, amount, reference, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id`,
    [agentId, pay, reference]
  );
  const settlementId = ins.rows[0].id;

  const payload = {
    id: reference,
    currency: 'KES',
    amount: pay,
    description: `Gas Mtaani commission settlement ${reference}`,
    callback_url: `${PUBLIC_BASE_URL}/api/agents/settle/callback`,
    notification_id: SETTLE_IPN_ID,
    billing_address: {
      email_address: contact.email || 'agent@gasmtaani.co.ke',
      phone_number: contact.phone_number || agent.mpesa_number || '254700000000',
      country_code: 'KE',
      first_name: parts[0] || 'Agent',
      last_name: parts.slice(1).join(' ') || 'User',
    },
  };

  const result = await pesapal.submitOrder(payload);
  if (!result?.order_tracking_id || !result?.redirect_url) {
    throw new Error('PesaPal did not return a redirect URL');
  }

  await pool.query(
    `UPDATE commission_settlements SET tracking_id = $1 WHERE id = $2`,
    [result.order_tracking_id, settlementId]
  );

  return {
    settlementId,
    reference,
    amount: pay,
    redirectUrl: result.redirect_url,
    trackingId: result.order_tracking_id,
  };
}

async function applyOutcome({ trackingId }) {
  const status = await pesapal.getTransactionStatus(trackingId);
  const desc = status?.payment_status_description;

  const r = await pool.query(
    `SELECT id, agent_id, amount, status
     FROM commission_settlements
     WHERE tracking_id = $1`,
    [trackingId]
  );
  if (r.rows.length === 0) {
    console.warn(`[settlement] no row for tracking ${trackingId}`);
    return null;
  }
  const s = r.rows[0];

  if (desc === 'Completed' && s.status !== 'completed') {
    await walletService.credit(s.agent_id, s.amount, 'SETTLEMENT');
    await walletService.updateBreachState(s.agent_id);

    await pool.query(
      `UPDATE commission_settlements
       SET status = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [s.id]
    );

    console.log(
      `[settlement] agent ${s.agent_id} credited ${s.amount} (tracking ${trackingId})`
    );
    return { status: 'completed', agentId: s.agent_id, amount: s.amount };
  }

  if (['Failed', 'Invalid', 'Reversed'].includes(desc)) {
    await pool.query(
      `UPDATE commission_settlements SET status = 'failed' WHERE id = $1`,
      [s.id]
    );
    return { status: 'failed', agentId: s.agent_id };
  }

  return { status: 'pending', agentId: s.agent_id };
}

module.exports = { initiate, applyOutcome };