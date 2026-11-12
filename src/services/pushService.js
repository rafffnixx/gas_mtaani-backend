// 📁 backend/src/services/pushService.js
const { pool } = require('../config/database');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send a push to one user.
 * Routes calls to the 'incoming-call' channel (MAX priority)
 * and normal messages to the 'default' channel (HIGH priority).
 *
 * @param {string} userId
 * @param {object} payload
 * @param {string} payload.title
 * @param {string} payload.body
 * @param {object} [payload.data]  deep-link payload for the client
 */
async function sendPushToUser(userId, { title, body, data = {} }) {
  if (!userId || !title || !body) return null;

  try {
    const { rows } = await pool.query(
      `SELECT expo_push_token FROM users WHERE id = $1`,
      [userId]
    );
    const token = rows[0]?.expo_push_token;
    if (!token) return null; // user hasn't registered for push

    // Check if this is an incoming call
    const isCall = data.type === 'incoming_call';

    const message = {
      to: token,
      sound: 'default',
      title,
      body,
      data,
      priority: isCall ? 'max' : 'high',
      // If it's a call, use the high-priority channel and category.
      channelId: isCall ? 'incoming-call' : 'default',
      ...(isCall && { 
        categoryId: 'incoming_call',
        ttl: 60, // 60 seconds expiry so it doesn't get stuck in FCM buffer
      }),
    };

    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      // Expo expects an array of messages
      body: JSON.stringify([message]),
    });

    const result = await res.json().catch(() => null);

    // If the token is dead, clear it
    const ticket = result?.data?.[0];
    if (ticket?.status === 'error') {
      const errCode = ticket?.details?.error;
      if (errCode === 'DeviceNotRegistered') {
        await pool.query(
          `UPDATE users SET expo_push_token = NULL WHERE id = $1`,
          [userId]
        );
        console.log(`🧹 Cleared dead push token for user ${userId}`);
      } else {
        console.warn('Expo push error:', ticket);
      }
    }

    return result;
  } catch (e) {
    console.error('sendPushToUser failed:', e.message);
    return null;
  }
}

module.exports = { sendPushToUser };