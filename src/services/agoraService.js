// 📁 backend/src/services/agoraService.js
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const { pool } = require('../config/database');

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

if (!APP_ID || !APP_CERTIFICATE) {
  console.error('⚠️  AGORA_APP_ID or AGORA_APP_CERTIFICATE is not set. Agora calls will fail.');
}

/**
 * Generate an RTC token for a channel.
 */
function generateToken(channelName, uid, expireSeconds = 3600) {
  if (!APP_ID || !APP_CERTIFICATE) {
    throw new Error('Agora credentials not configured on server');
  }

  const role = RtcRole.PUBLISHER;
  const uidNum = typeof uid === 'string' ? parseInt(uid, 10) : uid;
  if (isNaN(uidNum)) throw new Error('uid must be a number');

  const now = Math.floor(Date.now() / 1000);
  const privilegeExpire = now + expireSeconds;

  return RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channelName,
    uidNum,
    role,
    privilegeExpire,
    privilegeExpire
  );
}

function orderChannelName(orderId) {
  return `order:${orderId}`;
}

function supportChannelName(callId) {
  return `support:${callId}`;
}

/**
 * Send an Expo push message directly via Expo's push API.
 * Looks up the user's expo_push_token from the DB.
 *
 * @param {string} userId
 * @param {Object} message — { title, body, data }
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function sendPushToUser(userId, message) {
  // 1. Look up the token
  const res = await pool.query(
    `SELECT expo_push_token FROM users WHERE id = $1`,
    [userId]
  );

  if (res.rows.length === 0) {
    return { sent: false, reason: 'user_not_found' };
  }

  const token = res.rows[0].expo_push_token;
  if (!token) {
    return { sent: false, reason: 'no_push_token' };
  }

  // 2. Send to Expo
  const payload = {
    to: token,
    sound: 'default',
    priority: 'high',
    title: message.title,
    body: message.body,
    data: message.data || {},
    // Android: make it vibrate and pop as a heads-up notification
    channelId: 'default',
  };

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();

  // Expo returns { data: { status: 'ok' | 'error', ... } }
  if (result?.data?.status === 'error') {
    console.error('Expo push error:', result.data);
    return { sent: false, reason: result.data.message || 'expo_error' };
  }

  return { sent: true };
}

/**
 * Ring the other party on an order. Generates a token for them
 * and sends a push notification with the channel details.
 *
 * @param {Object} opts
 * @param {string} opts.orderId
 * @param {string} opts.calleeId    — user id to ring
 * @param {string} opts.callerName  — display name shown in the incoming call screen
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function ringOrderCounterparty({ orderId, calleeId, callerName }) {
  const channelName = orderChannelName(orderId);
  const uid = Math.floor(Math.random() * 1000000) + 1000;
  const token = generateToken(channelName, uid, 3600);

  try {
    const result = await sendPushToUser(calleeId, {
      title: 'Incoming call',
      body: `${callerName || 'Someone'} is calling about your order.`,
      data: {
        type: 'incoming_call',
        app_id: APP_ID,
        token,
        channel_name: channelName,
        uid,
        title: callerName || 'Order Call',
        subtitle: 'Voice call',
      },
    });
    return result;
  } catch (err) {
    console.error('ringOrderCounterparty push failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = {
  generateToken,
  orderChannelName,
  supportChannelName,
  ringOrderCounterparty,
  sendPushToUser,
  APP_ID,
};