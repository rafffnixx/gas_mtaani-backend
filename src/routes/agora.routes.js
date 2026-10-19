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

// GET APP ID
router.get('/app-id', (req, res) => {
  if (!APP_ID) return res.status(500).json({ error: 'Agora not configured' });
  res.json({ app_id: APP_ID });
});

// =====================================================
// ORDER CALL TOKEN
// =====================================================
router.post('/order-call/token', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { order_id } = req.body || {};

    if (!order_id) return res.status(400).json({ error: 'order_id is required' });

    const orderRes = await pool.query(
      `SELECT id, customer_id, agent_id, order_number
       FROM orders WHERE id = $1`,
      [order_id]
    );

    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    const order = orderRes.rows[0];
    const isCustomer = order.customer_id === userId;
    const isAgent = order.agent_id === userId;

    if (!isCustomer && !isAgent) {
      return res.status(403).json({ error: 'You are not a party to this order' });
    }

    const calleeId = isCustomer ? order.agent_id : order.customer_id;
    
    // ── CHECK CALLEE STATUS ──
    let isCalleeOnline = false;
    let statusText = 'Calling...';

    if (calleeId) {
      const calleeRes = await pool.query(
        `SELECT is_online FROM agents WHERE id = $1`,
        [calleeId]
      );
      if (calleeRes.rows.length > 0) {
        isCalleeOnline = calleeRes.rows[0].is_online;
        statusText = isCalleeOnline ? 'Ringing...' : 'Calling...';
      }
    }

    const channelName = orderChannelName(order_id);
    const uid = Math.floor(Math.random() * 1000000) + 1000;
    const token = generateToken(channelName, uid, 3600);

    // ── LOG THE CALL ──
    const logRes = await pool.query(
      `INSERT INTO call_logs (caller_id, callee_id, order_id, status)
       VALUES ($1, $2, $3, 'initiated')
       RETURNING id`,
      [userId, calleeId, order_id]
    );

    res.json({
      success: true,
      token,
      app_id: APP_ID,
      channel_name: channelName,
      uid,
      expires_in: 3600,
      order_number: order.order_number,
      status_text: statusText,
      is_callee_online: isCalleeOnline,
      call_log_id: logRes.rows[0].id 
    });
  } catch (error) {
    console.error('Order call token error:', error);
    res.status(500).json({ error: 'Failed to generate call token' });
  }
});

// =====================================================
// RING THE OTHER PARTY ON AN ORDER
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

    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    const order = orderRes.rows[0];
    const isCustomer = order.customer_id === userId;
    const isAgent = order.agent_id === userId;

    if (!isCustomer && !isAgent) {
      return res.status(403).json({ error: 'You are not a party to this order' });
    }

    const calleeId = isCustomer ? order.agent_id : order.customer_id;
    if (!calleeId) return res.status(400).json({ error: 'Order has no counterparty yet' });

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
// END CALL (Update duration)
// =====================================================
router.post('/call/:logId/end', authenticate, async (req, res) => {
  try {
    const { logId } = req.params;
    const { duration_seconds } = req.body;

    await pool.query(
      `UPDATE call_logs
       SET status = 'ended', duration_seconds = $1, ended_at = NOW()
       WHERE id = $2`,
      [duration_seconds || 0, logId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('End call error:', error);
    res.status(500).json({ error: 'Failed to end call' });
  }
});

// =====================================================
// CALL HISTORY
// =====================================================
router.get('/history', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT c.*, 
              o.order_number,
              u1.full_name AS caller_name,
              u2.full_name AS callee_name
       FROM call_logs c
       LEFT JOIN orders o ON c.order_id = o.id
       LEFT JOIN users u1 ON c.caller_id = u1.id
       LEFT JOIN users u2 ON c.callee_id = u2.id
       WHERE c.caller_id = $1 OR c.callee_id = $1
       ORDER BY c.created_at DESC
       LIMIT 50`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Call history error:', error);
    res.status(500).json({ error: 'Failed to fetch call history' });
  }
});

// =====================================================
// SUPPORT CALLS (Keep existing logic)
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

router.get('/support-calls/pending', authenticate, async (req, res) => {
  try {
    if (req.user.user_type !== 'admin') return res.status(403).json({ error: 'Admin only' });

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
    res.status(500).json({ error: 'Failed to fetch pending calls' });
  }
});

router.post('/support-calls/:callId/answer', authenticate, async (req, res) => {
  try {
    if (req.user.user_type !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { callId } = req.params;
    const adminId = req.user.id;

    const callRes = await pool.query(
      `SELECT id, channel_name, status FROM support_calls WHERE id = $1`,
      [callId]
    );

    if (callRes.rows.length === 0) return res.status(404).json({ error: 'Support call not found' });

    const call = callRes.rows[0];
    if (call.status !== 'ringing') return res.status(400).json({ error: `Call is already ${call.status}` });

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
    res.status(500).json({ error: 'Failed to answer support call' });
  }
});

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
    res.status(500).json({ error: 'Failed to end call' });
  }
});

module.exports = router;