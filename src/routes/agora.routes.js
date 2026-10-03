// 📁 backend/src/routes/agora.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');
const {
  generateToken,
  orderChannelName,
  supportChannelName,
  ringOrderCounterparty,
  APP_ID,
} = require('../services/agoraService');

// =====================================================
// GET APP ID
// Client fetches this once at startup.
// App ID is public — safe to expose.
// =====================================================
router.get('/app-id', (req, res) => {
  if (!APP_ID) {
    return res.status(500).json({ error: 'Agora not configured' });
  }
  res.json({ app_id: APP_ID });
});

// =====================================================
// ORDER CALL TOKEN
// Both customer and agent call this to join the same channel.
// Verifies the caller is a party to the order.
// Does NOT expose phone numbers.
// =====================================================
router.post('/order-call/token', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { order_id } = req.body || {};

    if (!order_id) {
      return res.status(400).json({ error: 'order_id is required' });
    }

    const orderRes = await pool.query(
      `SELECT id, customer_id, agent_id, order_number
       FROM orders WHERE id = $1`,
      [order_id]
    );

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderRes.rows[0];
    const isCustomer = order.customer_id === userId;
    const isAgent = order.agent_id === userId;

    if (!isCustomer && !isAgent) {
      return res.status(403).json({ error: 'You are not a party to this order' });
    }

    const channelName = orderChannelName(order_id);
    const uid = Math.floor(Math.random() * 1000000) + 1000;
    const token = generateToken(channelName, uid, 3600);

    await pool.query(
      `INSERT INTO call_sessions (order_id, caller_id, channel_name, status)
       VALUES ($1, $2, $3, 'ringing')`,
      [order_id, userId, channelName]
    );

    res.json({
      success: true,
      token,
      app_id: APP_ID,
      channel_name: channelName,
      uid,
      expires_in: 3600,
      order_number: order.order_number,
    });
  } catch (error) {
    console.error('Order call token error:', error);
    res.status(500).json({ error: 'Failed to generate call token' });
  }
});

// =====================================================
// RING THE OTHER PARTY ON AN ORDER
// Caller hits this after getting their own token.
// Sends a push to the counterparty with the channel details.
// =====================================================
router.post('/order-call/:orderId/ring', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;

    const orderRes = await pool.query(
      `SELECT o.id, o.customer_id, o.agent_id, o.order_number,
              cu.full_name AS customer_name, au.full_name AS agent_name
       FROM orders o
       LEFT JOIN users cu ON cu.id = o.customer_id
       LEFT JOIN users au ON au.id = o.agent_id
       WHERE o.id = $1`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderRes.rows[0];
    const isCustomer = order.customer_id === userId;
    const isAgent = order.agent_id === userId;

    if (!isCustomer && !isAgent) {
      return res.status(403).json({ error: 'You are not a party to this order' });
    }

    const calleeId = isCustomer ? order.agent_id : order.customer_id;
    if (!calleeId) {
      return res.status(400).json({ error: 'Order has no counterparty yet' });
    }

    const callerName = isCustomer ? order.customer_name : order.agent_name;

    const result = await ringOrderCounterparty({
      orderId,
      calleeId,
      callerName,
    });

    res.json({
      success: true,
      push_sent: result.sent,
      reason: result.reason || null,
    });
  } catch (error) {
    console.error('Ring order error:', error);
    res.status(500).json({ error: 'Failed to ring counterparty' });
  }
});

// =====================================================
// SUPPORT CALL TOKEN
// Customer or agent requests support. Creates a support_calls row.
// Admin web polls for 'ringing' calls and joins the channel.
// =====================================================
router.post('/support-call/token', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.user_type;

    if (!['customer', 'agent'].includes(userType)) {
      return res.status(403).json({ error: 'Only customers and agents can request support calls' });
    }

    const insertRes = await pool.query(
      `INSERT INTO support_calls (caller_id, caller_type, status, channel_name)
       VALUES ($1, $2, 'ringing', 'pending')
       RETURNING id`,
      [userId, userType]
    );

    const callId = insertRes.rows[0].id;
    const channelName = supportChannelName(callId);
    const uid = Math.floor(Math.random() * 1000000) + 1000;
    const token = generateToken(channelName, uid, 3600);

    await pool.query(
      `UPDATE support_calls SET channel_name = $1 WHERE id = $2`,
      [channelName, callId]
    );

    res.json({
      success: true,
      token,
      app_id: APP_ID,
      channel_name: channelName,
      uid,
      expires_in: 3600,
      call_id: callId,
    });
  } catch (error) {
    console.error('Support call token error:', error);
    res.status(500).json({ error: 'Failed to create support call' });
  }
});

// =====================================================
// PENDING SUPPORT CALLS (Admin only)
// =====================================================
router.get('/support-calls/pending', authenticate, async (req, res) => {
  try {
    if (req.user.user_type !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const result = await pool.query(
      `SELECT sc.id, sc.caller_id, sc.caller_type, sc.channel_name,
              sc.created_at,
              u.full_name AS caller_name, u.phone_number AS caller_phone
       FROM support_calls sc
       LEFT JOIN users u ON u.id = sc.caller_id
       WHERE sc.status = 'ringing'
       ORDER BY sc.created_at ASC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Pending support calls error:', error);
    res.status(500).json({ error: 'Failed to fetch pending calls' });
  }
});

// =====================================================
// ANSWER SUPPORT CALL (Admin only)
// =====================================================
router.post('/support-calls/:callId/answer', authenticate, async (req, res) => {
  try {
    if (req.user.user_type !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { callId } = req.params;
    const adminId = req.user.id;

    const callRes = await pool.query(
      `SELECT id, channel_name, status FROM support_calls WHERE id = $1`,
      [callId]
    );

    if (callRes.rows.length === 0) {
      return res.status(404).json({ error: 'Support call not found' });
    }

    const call = callRes.rows[0];
    if (call.status !== 'ringing') {
      return res.status(400).json({ error: `Call is already ${call.status}` });
    }

    const uid = Math.floor(Math.random() * 1000000) + 1000;
    const token = generateToken(call.channel_name, uid, 3600);

    await pool.query(
      `UPDATE support_calls
       SET status = 'answered', admin_id = $1, answered_at = NOW()
       WHERE id = $2`,
      [adminId, callId]
    );

    res.json({
      success: true,
      token,
      app_id: APP_ID,
      channel_name: call.channel_name,
      uid,
      expires_in: 3600,
    });
  } catch (error) {
    console.error('Answer support call error:', error);
    res.status(500).json({ error: 'Failed to answer support call' });
  }
});

// =====================================================
// END SUPPORT CALL
// =====================================================
router.post('/support-calls/:callId/end', authenticate, async (req, res) => {
  try {
    const { callId } = req.params;

    await pool.query(
      `UPDATE support_calls
       SET status = 'ended', ended_at = NOW()
       WHERE id = $1 AND status IN ('ringing', 'answered')`,
      [callId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('End support call error:', error);
    res.status(500).json({ error: 'Failed to end call' });
  }
});

module.exports = router;