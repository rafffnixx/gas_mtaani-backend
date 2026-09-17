// 📁 backend/src/routes/payment.routes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');

// -----------------------------------------------------------
// Pesapal v3 client (pesapal-v3-node)
// -----------------------------------------------------------
const Pesapal = require('pesapal-v3-node');

const pesapalEnv =
  (process.env.PESAPAL_ENVIRONMENT || 'sandbox').toLowerCase() === 'production'
    ? 'production'
    : 'sandbox';

const pesapal = new Pesapal({
  consumerKey: process.env.PESAPAL_CONSUMER_KEY,
  consumerSecret: process.env.PESAPAL_CONSUMER_SECRET,
  environment: pesapalEnv,
});

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://gas-mtaani-backend.onrender.com';

// =====================================================
// POST /api/payments/pesapal/initiate
// =====================================================
router.post('/pesapal/initiate', authenticate, async (req, res) => {
  try {
    const { orderId } = req.body;
    const userId = req.user.id;

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const orderResult = await pool.query(
      `SELECT id, order_number, total_amount, payment_status
       FROM orders
       WHERE id = $1 AND customer_id = $2`,
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderResult.rows[0];

    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Order is already paid' });
    }

    const userResult = await pool.query(
      `SELECT email, phone_number, full_name FROM users WHERE id = $1`,
      [userId]
    );
    const user = userResult.rows[0] || {};

    const nameParts = (user.full_name || 'Gas Mtaani Customer').split(' ');
    const firstName = nameParts[0] || 'Customer';
    const lastName = nameParts.slice(1).join(' ') || 'User';

    const result = await pesapal.submitOrderRequest({
      id: order.order_number,
      currency: 'KES',
      amount: Number(order.total_amount),
      description: `Gas Mtaani Order ${order.order_number}`,
      callback_url: `${PUBLIC_BASE_URL}/api/payments/pesapal/callback`,
      notification_id: process.env.PESAPAL_IPN_ID,
      billing_address: {
        email_address: user.email || 'customer@gasmtaani.co.ke',
        phone_number: user.phone_number || '254700000000',
        first_name: firstName,
        last_name: lastName,
      },
    });

    const trackingId = result?.order_tracking_id;
    const redirectUrl = result?.redirect_url;

    if (!trackingId || !redirectUrl) {
      console.error('Pesapal submitOrderRequest unexpected response:', result);
      return res.status(502).json({
        error: 'Payment initiation failed',
        details: result,
      });
    }

    await pool.query(
      `UPDATE orders
       SET payment_reference = $1,
           payment_status = 'pending',
           payment_method = 'pesapal'
       WHERE id = $2`,
      [trackingId, orderId]
    );

    return res.json({
      success: true,
      orderTrackingId: trackingId,
      redirectUrl,
    });
  } catch (error) {
    console.error('Pesapal initiate error:', error?.response?.data || error);
    res.status(500).json({
      error: 'Failed to initiate Pesapal payment',
      details: error?.response?.data?.message || error.message,
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
        const status = await pesapal.getTransactionStatus(OrderTrackingId);
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
          verifyErr?.response?.data || verifyErr.message
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
// GET /api/payments/pesapal/ipn
// =====================================================
router.get('/pesapal/ipn', async (req, res) => {
  try {
    const {
      OrderTrackingId,
      OrderMerchantReference,
      OrderNotificationType,
    } = req.query;

    if (!OrderTrackingId) {
      return res.status(400).json({ error: 'Missing OrderTrackingId' });
    }

    const status = await pesapal.getTransactionStatus(OrderTrackingId);
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
      console.log(
        `❌ Pesapal IPN: order ${OrderMerchantReference} — ${desc}`
      );
    } else {
      console.log(
        `⏳ Pesapal IPN: order ${OrderMerchantReference} — ${
          desc || 'pending'
        }`
      );
    }

    res.status(200).json({
      orderNotificationType: OrderNotificationType || 'IPNCHANGE',
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      status: 200,
    });
  } catch (error) {
    console.error('Pesapal IPN error:', error?.response?.data || error);
    res.status(500).json({ error: 'IPN processing failed' });
  }
});

module.exports = router;