// 📁 backend/src/routes/payment.routes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');
const { initialisePesapal } = require('pesapal3-sdk');

// Initialize the Pesapal instance
const pesapal = initialisePesapal({
  PESAPAL_ENVIRONMENT: process.env.PESAPAL_ENV || 'sandbox',
  PESAPAL_CONSUMER_KEY: process.env.PESAPAL_CONSUMER_KEY,
  PESAPAL_CONSUMER_SECRET: process.env.PESAPAL_CONSUMER_SECRET,
  PESAPAL_IPN_URL: 'https://gas-mtaani-backend.onrender.com/api/payments/pesapal/ipn',
});

// =====================================================
// POST /api/payments/pesapal/initiate
// Called by the mobile app to get a redirect URL
// =====================================================
router.post('/pesapal/initiate', authenticate, async (req, res) => {
  try {
    const { orderId } = req.body;
    const userId = req.user.id;

    // 1. Fetch the order from your DB
    const orderResult = await pool.query(
      `SELECT id, order_number, total_amount FROM orders WHERE id = $1 AND customer_id = $2`,
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderResult.rows[0];

    // 2. Fetch customer details for Pesapal billing
    const userResult = await pool.query(
      `SELECT email, phone_number, full_name FROM users WHERE id = $1`,
      [userId]
    );
    const user = userResult.rows[0];

    // 3. Build the order details for Pesapal
    const paymentDetails = {
      amount: parseFloat(order.total_amount),
      currency: 'KES',
      description: `Gas Mtaani Order ${order.order_number}`,
      callback_url: `https://gas-mtaani-backend.onrender.com/api/payments/pesapal/callback`,
      notification_id: process.env.PESAPAL_IPN_ID,
      billing_address: {
        email_address: user.email || 'customer@gasmtaani.co.ke',
        phone_number: user.phone_number,
        first_name: user.full_name.split(' ')[0] || 'Customer',
        last_name: user.full_name.split(' ')[1] || 'User',
      },
    };

    // 4. Submit to Pesapal
    const ordered = await pesapal.submitOrder(paymentDetails);

    if (ordered.success) {
      // 5. Save the tracking ID against the order
      const trackingId = ordered.response.order_tracking_id;
      await pool.query(
        `UPDATE orders 
         SET payment_reference = $1, payment_status = 'pending', payment_method = 'pesapal'
         WHERE id = $2`,
        [trackingId, orderId]
      );

      return res.json({
        success: true,
        redirectUrl: ordered.response.redirect_url,
        orderTrackingId: trackingId,
      });
    } else {
      console.error('Pesapal submission error:', ordered.error);
      return res.status(400).json({ error: 'Payment initiation failed', details: ordered.error });
    }
  } catch (error) {
    console.error('Pesapal initiate error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// =====================================================
// GET /api/payments/pesapal/callback
// User is redirected here after payment on Pesapal's page
// =====================================================
router.get('/pesapal/callback', async (req, res) => {
  // Pesapal sends the customer here. We just redirect them back to the app.
  // The actual verification happens via the IPN below.
  const { OrderTrackingId, OrderMerchantReference } = req.query;

  // Deep link back to your mobile app (adjust 'gasmtaani://' to your scheme)
  const appRedirect = `gasmtaani://payment-result?trackingId=${OrderTrackingId}&orderId=${OrderMerchantReference}`;
  
  res.redirect(appRedirect);
});

// =====================================================
// GET /api/payments/pesapal/ipn
// Silent server-to-server notification from Pesapal
// This is where you update the DB reliably.
// =====================================================
router.get('/pesapal/ipn', async (req, res) => {
  try {
    const { OrderTrackingId, OrderMerchantReference, OrderNotificationType } = req.query;

    // 1. Verify the transaction status with Pesapal (Do not trust the query params alone)
    const statusResponse = await pesapal.getTransactionStatus(OrderTrackingId);

    if (statusResponse.success) {
      const statusData = statusResponse.response;
      
      if (statusData.payment_status_description === 'Completed') {
        // 2. Mark order as paid
        await pool.query(
          `UPDATE orders 
           SET payment_status = 'paid', mpesa_transaction_id = $1
           WHERE id = $2`,
          [statusData.confirmation_code, OrderMerchantReference]
        );
        console.log(`✅ Order ${OrderMerchantReference} paid via Pesapal.`);
      } else if (['Failed', 'Invalid', 'Reversed'].includes(statusData.payment_status_description)) {
        // 3. Mark as failed
        await pool.query(
          `UPDATE orders SET payment_status = 'failed' WHERE id = $1`,
          [OrderMerchantReference]
        );
        console.log(`❌ Order ${OrderMerchantReference} failed. Status: ${statusData.payment_status_description}`);
      }
    }

    // 4. MUST respond to Pesapal with a 200 JSON to confirm receipt
    res.json({
      orderNotificationType: OrderNotificationType || 'IPNCHANGE',
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      status: 200,
    });
  } catch (error) {
    console.error('Pesapal IPN error:', error);
    // Respond with 500 if we couldn't process it, so Pesapal might retry
    res.status(500).json({ error: 'IPN processing failed' });
  }
});

module.exports = router;