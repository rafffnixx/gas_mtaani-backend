// 📁 backend/src/services/agoraService.js
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

if (!APP_ID || !APP_CERTIFICATE) {
  console.error('⚠️  AGORA_APP_ID or AGORA_APP_CERTIFICATE is not set. Agora calls will fail.');
}

/**
 * Generate an RTC token for a channel.
 * @param {string} channelName - The Agora channel name
 * @param {number|string} uid - User ID (integer recommended for RN SDK)
 * @param {number} expireSeconds - Token lifetime in seconds (default 3600 = 1h)
 * @returns {string} RTC token
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

  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channelName,
    uidNum,
    role,
    privilegeExpire,
    privilegeExpire
  );

  return token;
}

/**
 * Deterministic channel name for an order call.
 * Both parties derive the same name from the order ID.
 */
function orderChannelName(orderId) {
  return `order:${orderId}`;
}

/**
 * Deterministic channel name for a support call.
 */
function supportChannelName(callId) {
  return `support:${callId}`;
}

module.exports = {
  generateToken,
  orderChannelName,
  supportChannelName,
  APP_ID,
};