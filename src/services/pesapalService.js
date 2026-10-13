// 📁 backend/src/services/pesapalService.js
//
// Shared PesaPal v3 helpers — used by both order payments and
// agent commission settlements.

const PESAPAL_ENV = (process.env.PESAPAL_ENVIRONMENT || 'sandbox').toLowerCase();
const PESAPAL_BASE =
  PESAPAL_ENV === 'production'
    ? 'https://pay.pesapal.com/v3'
    : 'https://cybqa.pesapal.com/pesapalv3';

const CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://gas-mtaani-backend.onrender.com';

let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;

  const res = await fetch(`${PESAPAL_BASE}/api/Auth/RequestToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      consumer_key: CONSUMER_KEY,
      consumer_secret: CONSUMER_SECRET,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.token) {
    throw new Error(
      `Pesapal auth failed (${res.status}): ${
        data?.error?.message || data?.message || JSON.stringify(data)
      }`
    );
  }
  tokenCache = { token: data.token, expiresAt: now + 4 * 60 * 1000 };
  return data.token;
}

async function submitOrder(payload) {
  const token = await getToken();
  const res = await fetch(`${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`SubmitOrderRequest failed (${res.status})`);
    err.details = data;
    throw err;
  }
  return data;
}

async function getTransactionStatus(orderTrackingId) {
  const token = await getToken();
  const url = `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(
    orderTrackingId
  )}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`GetTransactionStatus failed (${res.status})`);
    err.details = data;
    throw err;
  }
  return data;
}

module.exports = {
  getToken,
  submitOrder,
  getTransactionStatus,
  PESAPAL_BASE,
  PUBLIC_BASE_URL,
  IPN_ID: process.env.PESAPAL_IPN_ID,
  SETTLE_IPN_ID:
    process.env.PESAPAL_SETTLE_IPN_ID || process.env.PESAPAL_IPN_ID,
};