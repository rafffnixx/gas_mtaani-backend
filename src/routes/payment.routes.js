// 📁 backend/src/routes/payment.routes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');

// -----------------------------------------------------------
// Pesapal v3 — plain HTTP, no SDK
// -----------------------------------------------------------
const PESAPAL_ENV = (process.env.PESAPAL_ENVIRONMENT || 'sandbox').toLowerCase();
const PESAPAL_BASE =
  PESAPAL_ENV === 'production'
    ? 'https://pay.pesapal.com/v3'
    : 'https://cybqa.pesapal.com/pesapalv3';

const CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;
const IPN_ID = process.env.PESAPAL_IPN_ID;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://gas-mtaani-backend.onrender.com';

// Token cache
let tokenCache = { token: null, expiresAt: 0 };

async function getPesapalToken() {
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

async function submitPesapalOrder(payload) {
  const token = await getPesapalToken();
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

async function getPesapalTransactionStatus(orderTrackingId) {
  const token = await getPesapalToken();
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

// =====================================================
// POST /api/payments/pesapal/initiate
// =====================================================
router.post('/pesapal/initiate', authenticate, async (req, res) => {
  try {
    const { orderId } = req.body;
    const userId = req.user.id;

    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    const orderResult = await pool.query(
      `SELECT id, order_number, total_amount, payment_status
       FROM orders WHERE id = $1 AND customer_id = $2`,
      [orderId, userId]
    );
    if (orderResult.rows.length === 0)
      return res.status(404).json({ error: 'Order not found' });

    const order = orderResult.rows[0];
    if (order.payment_status === 'paid')
      return res.status(400).json({ error: 'Order is already paid' });

    const userResult = await pool.query(
      `SELECT email, phone_number, full_name FROM users WHERE id = $1`,
      [userId]
    );
    const user = userResult.rows[0] || {};
    const parts = (user.full_name || 'Gas Mtaani Customer').split(' ');

    const payload = {
      id: order.order_number,
      currency: 'KES',
      amount: Number(order.total_amount),
      description: `Gas Mtaani Order ${order.order_number}`,
      callback_url: `${PUBLIC_BASE_URL}/api/payments/pesapal/callback`,
      notification_id: IPN_ID,
      billing_address: {
        email_address: user.email || 'customer@gasmtaani.co.ke',
        phone_number: user.phone_number || '254700000000',
        country_code: 'KE',
        first_name: parts[0] || 'Customer',
        last_name: parts.slice(1).join(' ') || 'User',
      },
    };

    const result = await submitPesapalOrder(payload);
    const trackingId = result?.order_tracking_id;
    const redirectUrl = result?.redirect_url;

    if (!trackingId || !redirectUrl) {
      console.error('Pesapal unexpected response:', result);
      return res
        .status(502)
        .json({ error: 'Payment initiation failed', details: result });
    }

    await pool.query(
      `UPDATE orders
       SET payment_reference = $1,
           payment_status = 'pending',
           payment_method = 'pesapal'
       WHERE id = $2`,
      [trackingId, orderId]
    );

    res.json({ success: true, orderTrackingId: trackingId, redirectUrl });
  } catch (error) {
    console.error('Pesapal initiate error:', error?.details || error.message);
    res.status(500).json({
      error: 'Failed to initiate Pesapal payment',
      details: error?.details || error.message,
    });
  }
});

// =====================================================
// GET /api/payments/pesapal/callback
// =====================================================
router.get('/pesapal/callback', async (req, res) => {
  try {
    const { OrderTrackingId, OrderMerchantReference } = req.query;

    if (OrderTrackingId) {
      try {
        const status = await getPesapalTransactionStatus(OrderTrackingId);
        const desc = status?.payment_status_description;

        if (desc === 'Completed') {
          await pool.query(
            `UPDATE orders
             SET payment_status = 'paid',
                 mpesa_transaction_id = COALESCE($1, mpesa_transaction_id)
             WHERE payment_reference = $2`,
            [status?.confirmation_code || null, OrderTrackingId]
          );
        } else if (['Failed', 'Invalid', 'Reversed'].includes(desc)) {
          await pool.query(
            `UPDATE orders SET payment_status = 'failed' WHERE payment_reference = $1`,
            [OrderTrackingId]
          );
        }
      } catch (verifyErr) {
        console.warn(
          'Pesapal callback verify failed:',
          verifyErr?.details || verifyErr.message
        );
      }
    }

    const deepLink = `gasmtaani://payment-result?trackingId=${
      OrderTrackingId || ''
    }&orderId=${OrderMerchantReference || ''}`;
    res.redirect(deepLink);
  } catch (error) {
    console.error('Pesapal callback error:', error);
    res.status(500).send('Payment callback failed');
  }
});

// =====================================================
// GET + POST /api/payments/pesapal/ipn
// =====================================================
async function handleIPN(req, res) {
  try {
    const src = { ...req.query, ...req.body };
    const OrderTrackingId =
      src.OrderTrackingId || src.order_tracking_id || src.orderTrackingId;
    const OrderMerchantReference =
      src.OrderMerchantReference ||
      src.order_merchant_reference ||
      src.orderMerchantReference;
    const OrderNotificationType =
      src.OrderNotificationType || src.order_notification_type || 'IPNCHANGE';

    if (!OrderTrackingId) {
      return res
        .status(400)
        .json({ error: 'Missing OrderTrackingId in IPN payload' });
    }

    const status = await getPesapalTransactionStatus(OrderTrackingId);
    const desc = status?.payment_status_description;

    if (desc === 'Completed') {
      await pool.query(
        `UPDATE orders
         SET payment_status = 'paid',
             mpesa_transaction_id = COALESCE($1, mpesa_transaction_id)
         WHERE payment_reference = $2`,
        [status?.confirmation_code || null, OrderTrackingId]
      );
      console.log(`✅ Pesapal IPN: order ${OrderMerchantReference} paid.`);
    } else if (['Failed', 'Invalid', 'Reversed'].includes(desc)) {
      await pool.query(
        `UPDATE orders SET payment_status = 'failed' WHERE payment_reference = $1`,
        [OrderTrackingId]
      );
      console.log(`❌ Pesapal IPN: order ${OrderMerchantReference} — ${desc}`);
    } else {
      console.log(
        `⏳ Pesapal IPN: order ${OrderMerchantReference} — ${desc || 'pending'}`
      );
    }

    res.status(200).json({
      orderNotificationType: OrderNotificationType,
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      status: 200,
    });
  } catch (error) {
    console.error('Pesapal IPN error:', error?.details || error);
    res.status(500).json({ error: 'IPN processing failed' });
  }
}

router.get('/pesapal/ipn', handleIPN);
router.post('/pesapal/ipn', handleIPN);

module.exports = router;