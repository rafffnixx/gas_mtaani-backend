// 📁 backend/src/services/pushService.js
// Sends Expo push notifications for a given user.

const { pool } = require('../config/database');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send a push to one user (looks up their expo_push_token).
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

    const message = {
      to: token,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId: 'default',
    };

    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(message),
    });

    const result = await res.json().catch(() => null);

    // If the token is dead, clear it
    const ticket = result?.data;
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