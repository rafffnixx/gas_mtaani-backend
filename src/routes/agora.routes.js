// 📁 backend/src/routes/agora.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');
const {
  generateToken,
  orderChannelName,
  supportChannelName,
  APP_ID,
} = require('../services/agoraService');
const { sendPushToUser } = require('../services/pushService');

// GET APP ID
router.get('/app-id', (req, res) => {
  if (!APP_ID) return res.status(500).json({ error: 'Agora not configured' });
  res.json({ app_id: APP_ID });
});

// =====================================================
// ORDER CALLS (Customer <-> Agent)
// =====================================================
router.post('/order-call/token', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { order_id } = req.body || {};

    if (!order_id) return res.status(400).json({ error: 'order_id is required' });

    const orderRes = await pool.query(
      `SELECT id, customer_id, agent_id, order_number, status
       FROM orders WHERE id = $1`,
      [order_id]
    );

    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderRes.rows[0];

    if (!['accepted', 'out_for_delivery', 'delivered'].includes(order.status)) {
      return res.status(403).json({ error: 'You can only call after the agent accepts the order.' });
    }

    const isCustomer = order.customer_id === userId;
    const isAgent = order.agent_id === userId;
    if (!isCustomer && !isAgent) return res.status(403).json({ error: 'You are not a party to this order' });

    const calleeId = isCustomer ? order.agent_id : order.customer_id;

    // Auto-cleanup stuck calls older than 1 minute
    await pool.query(
      `UPDATE call_logs SET status = 'ended', ended_at = NOW() 
       WHERE status IN ('initiated', 'answered') AND created_at < NOW() - INTERVAL '1 minute'`
    );

    const busyRes = await pool.query(
      `SELECT id FROM call_logs 
       WHERE (caller_id = $1 OR callee_id = $1 OR caller_id = $2 OR callee_id = $2)
         AND status IN ('initiated', 'answered') AND created_at > NOW() - INTERVAL '45 seconds'`,
      [userId, calleeId]
    );
    if (busyRes.rows.length > 0) return res.status(409).json({ error: 'User is currently on another call.' });

    let isCalleeOnline = false;
    let statusText = 'Calling...';
    if (calleeId) {
      const calleeRes = await pool.query(`SELECT is_online FROM agents WHERE id = $1`, [calleeId]);
      if (calleeRes.rows.length > 0) {
        isCalleeOnline = calleeRes.rows[0].is_online;
        statusText = isCalleeOnline ? 'Ringing...' : 'Calling...';
      }
    }

    const channelName = orderChannelName(order_id);
    const uid = Math.floor(Math.random() * 1000000) + 1000;
    const token = generateToken(channelName, uid, 3600);

    const logRes = await pool.query(
      `INSERT INTO call_logs (caller_id, callee_id, order_id, status) VALUES ($1, $2, $3, 'initiated') RETURNING id`,
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

router.post('/order-call/:orderId/ring', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;

    const orderRes = await pool.query(
      `SELECT o.id, o.customer_id, o.agent_id, o.order_number, o.status,
              cu.full_name AS customer_name, au.business_name AS agent_name
       FROM orders o
       LEFT JOIN users cu ON cu.id = o.customer_id
       LEFT JOIN agents au ON au.id = o.agent_id
       WHERE o.id = $1`,
      [orderId]
    );

    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    const order = orderRes.rows[0];
    const isCustomer = order.customer_id === userId;
    const isAgent = order.agent_id === userId;
    if (!isCustomer && !isAgent) return res.status(403).json({ error: 'You are not a party to this order' });

    if (!['accepted', 'out_for_delivery', 'delivered'].includes(order.status)) {
      return res.status(403).json({ error: 'You can only call after the agent accepts the order.' });
    }

    const calleeId = isCustomer ? order.agent_id : order.customer_id;
    if (!calleeId) return res.status(400).json({ error: 'Order has no counterparty yet' });

    await pool.query(
      `UPDATE call_logs SET status = 'ended', ended_at = NOW() 
       WHERE status IN ('initiated', 'answered') AND created_at < NOW() - INTERVAL '1 minute'`
    );

    const busyRes = await pool.query(
      `SELECT id FROM call_logs 
       WHERE (caller_id = $1 OR callee_id = $1 OR caller_id = $2 OR callee_id = $2)
         AND status IN ('initiated', 'answered') AND created_at > NOW() - INTERVAL '45 seconds'`,
      [userId, calleeId]
    );
    if (busyRes.rows.length > 0) return res.status(409).json({ error: 'User is currently on another call.' });

    const logRes = await pool.query(
      `INSERT INTO call_logs (caller_id, callee_id, order_id, status) VALUES ($1, $2, $3, 'initiated') RETURNING id`,
      [userId, calleeId, orderId]
    );
    const callLogId = logRes.rows[0].id;

    const callerName = isCustomer ? order.customer_name : order.agent_name;

    const result = await sendPushToUser(calleeId, {
      title: 'Incoming Call',
      body: `${callerName} is calling you`,
      data: {
        type: 'incoming_call',             
        orderId: orderId,
        callLogId: callLogId,               
        channelName: `order:${orderId}`,   
        callerName: callerName,            
      },
    });

    res.json({
      success: true,
      push_sent: result?.data?.[0]?.status === 'ok',
      reason: result?.data?.[0]?.message || null,
    });
  } catch (error) {
    console.error('Ring order error:', error);
    res.status(500).json({ error: 'Failed to ring counterparty' });
  }
});

router.post('/call/:logId/end', authenticate, async (req, res) => {
  try {
    const { logId } = req.params;
    const { duration_seconds } = req.body;

    await pool.query(
      `UPDATE call_logs SET status = 'ended', duration_seconds = $1, ended_at = NOW() WHERE id = $2`,
      [duration_seconds || 0, logId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('End call error:', error);
    res.status(500).json({ error: 'Failed to end call' });
  }
});

// =====================================================
// SUPPORT CALLS (Customer/Agent -> Admin Web)
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

    // 🔔 RING ALL ADMINS INSTANTLY VIA SOCKET.IO
    if (global.io) {
      global.io.to('admins').emit('incoming_call', {
        callId,
        callerName: req.user.full_name || 'User',
        callerType: userType,
      });
    }

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
      `UPDATE support_calls SET status = 'answered', admin_id = $1, answered_at = NOW() WHERE id = $2`,
      [adminId, callId]
    );

    // Fetch Admin Name for the broadcast
    const adminRes = await pool.query(`SELECT full_name FROM users WHERE id = $1`, [adminId]);
    const adminName = adminRes.rows[0]?.full_name || 'Another Admin';

    // 🛑 STOP RINGING ON OTHER DEVICES
    if (global.io) {
      global.io.to('admins').emit('call_answered_by_other', {
        callId,
        adminName: adminName,
      });
    }

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

router.post('/support-calls/:callId/end', authenticate, async (req, res) => {
  try {
    const { callId } = req.params;

    await pool.query(
      `UPDATE support_calls SET status = 'ended', ended_at = NOW() WHERE id = $1 AND status IN ('ringing', 'answered')`,
      [callId]
    );

    if (global.io) {
      global.io.to('admins').emit('call_ended', { callId });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('End support call error:', error);
    res.status(500).json({ error: 'Failed to end call' });
  }
});

// =====================================================
// ADMIN PROACTIVE CALL (Admin -> Customer/Agent)
// =====================================================
router.post('/admin-call/ring', authenticate, async (req, res) => {
  try {
    if (req.user.user_type !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { target_user_id } = req.body; 
    const adminId = req.user.id;

    if (!target_user_id) return res.status(400).json({ error: 'target_user_id is required' });

    // 🛑 FIX: Set caller_id = adminId to satisfy the DB constraint
    const insertRes = await pool.query(
      `INSERT INTO support_calls (caller_id, admin_id, caller_type, target_user_id, status, channel_name)
       VALUES ($1, $2, 'admin', $3, 'ringing', 'pending')
       RETURNING id`,
      [adminId, adminId, target_user_id]
    );

    const callId = insertRes.rows[0].id;
    const channelName = supportChannelName(callId);

    await pool.query(
      `UPDATE support_calls SET channel_name = $1 WHERE id = $2`,
      [channelName, callId]
    );

    const result = await sendPushToUser(target_user_id, {
      title: 'Incoming Support Call',
      body: 'Gas Mtaani Support is calling you.',
      data: {
        type: 'incoming_call',
        orderId: callId,           
        callLogId: callId,         
        channelName: channelName,
        callerName: 'Gas Mtaani Support',
      },
    });

    res.json({
      success: true,
      message: 'Ringing user...',
      push_sent: result?.data?.[0]?.status === 'ok',
      call_id: callId,
    });

  } catch (error) {
    console.error('Admin ring error:', error);
    res.status(500).json({ error: 'Failed to ring user' });
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

module.exports = router;