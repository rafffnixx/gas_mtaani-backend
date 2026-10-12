// 📁 backend/src/routes/order.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');
const { notifyOrderEvent } = require('../services/notificationService');
const {
  runAgentSearch,
  clearAllTimers,
  scheduleSearchTimeout,
} = require('../services/orderSearch');

// =====================================================
// CREATE ORDER (Customer)
// =====================================================
router.post('/', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = req.user.id;
    const {
      quote_id,
      payment_method,
      delivery_address,
      special_instructions,
      customer_latitude,
      customer_longitude,
      customer_address_id,
      location_source,
      county_code,
      constituency_code,
      ward_code,
      area_name,
      landmark,
    } = req.body;

    if (!quote_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'quote_id is required' });
    }
    if (!delivery_address) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'delivery_address is required' });
    }

    const allowedMethods = ['pesapal', 'delivery', 'cash'];
    const chosenMethod = allowedMethods.includes(payment_method)
      ? payment_method
      : 'delivery';

    const initialStatus = chosenMethod === 'pesapal' ? 'pending' : 'searching';

    const qr = await client.query(
      `SELECT * FROM order_quotes
       WHERE id = $1 AND customer_id = $2
       FOR UPDATE`,
      [quote_id, customerId]
    );
    if (qr.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Quote not found' });
    }
    const quote = qr.rows[0];

    if (quote.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Quote is ${quote.status}`,
        hint: 'Request a new quote',
      });
    }
    if (new Date(quote.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      await client.query(
        `UPDATE order_quotes SET status = 'expired' WHERE id = $1`,
        [quote_id]
      );
      return res.status(410).json({
        error: 'Quote expired',
        hint: 'Request a new quote',
      });
    }

    const orderNumber = `GM-${Date.now().toString().slice(-8)}`;
    const firstItem = quote.items[0];

    const orderRes = await client.query(
      `INSERT INTO orders (
         order_number, customer_id, agent_id,
         product_id, quantity, product_price,
         delivery_fee, total_amount,
         customer_latitude, customer_longitude, delivery_address,
         special_instructions, payment_method,
         customer_address_id, location_source,
         county_code, constituency_code, ward_code, area_name, landmark,
         extended_fee,
         status, payment_status, reassignment_count,
         excluded_agent_ids,
         created_at, updated_at
       ) VALUES (
         $1,$2,NULL,
         $3,$4,$5,
         0,$6,
         $7,$8,$9,
         $10,$11,
         $12,$13,
         $14,$15,$16,$17,$18,
         0,
         $19, 'pending', 0,
         '{}',
         NOW(), NOW()
       )
       RETURNING *`,
      [
        orderNumber,
        customerId,
        firstItem.product_id,
        firstItem.quantity,
        firstItem.unit_price,
        quote.grand_total,
        customer_latitude ?? null,
        customer_longitude ?? null,
        delivery_address,
        special_instructions || null,
        chosenMethod,
        customer_address_id || null,
        location_source || null,
        county_code || null,
        constituency_code || null,
        ward_code || null,
        area_name || null,
        landmark || null,
        initialStatus,
      ]
    );
    const order = orderRes.rows[0];

    for (const item of quote.items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [order.id, item.product_id, item.quantity, item.unit_price]
      );
    }

    const threadRes = await client.query(
      `INSERT INTO chat_threads
         (type, order_id, customer_id, agent_id, status, subject,
          category, priority, created_at, updated_at)
       VALUES ('order', $1, $2, NULL, 'open', $3, 'order', 'normal', NOW(), NOW())
       RETURNING id`,
      [order.id, customerId, `Order #${orderNumber}`]
    );
    const threadId = threadRes.rows[0].id;

    const openingBody =
      chosenMethod === 'pesapal'
        ? `Order #${orderNumber} placed — awaiting payment`
        : `Order #${orderNumber} placed — finding a partner`;

    await client.query(
      `INSERT INTO chat_messages
         (thread_id, sender_id, sender_role, body, created_at)
       VALUES ($1, NULL, 'system', $2, NOW())`,
      [threadId, openingBody]
    );
    await client.query(
      `UPDATE chat_threads
       SET last_message_at = NOW(),
           last_message_preview = LEFT($1, 200)
       WHERE id = $2`,
      [openingBody, threadId]
    );

    await client.query(
      `UPDATE order_quotes SET status = 'used' WHERE id = $1`,
      [quote_id]
    );

    await client.query('COMMIT');

    await notifyOrderEvent(order, initialStatus);

    if (chosenMethod !== 'pesapal') {
      runAgentSearch(order.id).catch((err) =>
        console.error('runAgentSearch failed:', err)
      );
      scheduleSearchTimeout(order.id);
    } else {
      console.log(
        `⏸  Order ${order.order_number} pending Pesapal payment — search deferred`
      );
    }

    return res.status(201).json({
      success: true,
      message:
        chosenMethod === 'pesapal'
          ? 'Order created — complete payment to dispatch'
          : 'Order placed — finding a partner',
      order: {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        total_amount: Number(order.total_amount),
        payment_status: order.payment_status,
        payment_method: order.payment_method,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create order error:', error);
    res.status(500).json({
      error: 'Failed to create order',
      details: error.message,
    });
  } finally {
    client.release();
  }
});

// =====================================================
// GET CUSTOMER ORDERS
// =====================================================
router.get('/customer', authenticate, async (req, res) => {
  try {
    const customerId = req.user.id;

    const result = await pool.query(
      `SELECT o.*,
              p.name        AS product_name,
              p.brand_name,
              p.image_url
       FROM orders o
       LEFT JOIN products p ON o.product_id = p.id
       WHERE o.customer_id = $1
       ORDER BY o.created_at DESC`,
      [customerId]
    );

    const orderIds = result.rows.map((r) => r.id);
    let itemsByOrder = {};
    if (orderIds.length > 0) {
      const itemsRes = await pool.query(
        `SELECT oi.order_id, oi.product_id, oi.quantity, oi.unit_price,
                p.name AS product_name, p.brand_name, p.image_url
         FROM order_items oi
         LEFT JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = ANY($1::uuid[])`,
        [orderIds]
      );
      itemsByOrder = itemsRes.rows.reduce((acc, row) => {
        if (!acc[row.order_id]) acc[row.order_id] = [];
        acc[row.order_id].push(row);
        return acc;
      }, {});
    }

    const data = result.rows.map((r) => ({
      ...r,
      items: itemsByOrder[r.id] || [],
    }));

    res.json(data);
  } catch (error) {
    console.error('Customer orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// =====================================================
// GET ORDER DETAILS (customer's own)
// =====================================================
router.get('/:orderId', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const customerId = req.user.id;

    const result = await pool.query(
      `SELECT o.*,
              p.name        AS product_name,
              p.brand_name,
              p.image_url
       FROM orders o
       LEFT JOIN products p ON o.product_id = p.id
       WHERE o.id = $1 AND o.customer_id = $2`,
      [orderId, customerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const itemsRes = await pool.query(
      `SELECT oi.id, oi.product_id, oi.quantity, oi.unit_price,
              p.name AS product_name, p.brand_name, p.image_url
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1
       ORDER BY oi.created_at ASC`,
      [orderId]
    );

    res.json({
      ...result.rows[0],
      items: itemsRes.rows,
    });
  } catch (error) {
    console.error('Order detail error:', error);
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

// =====================================================
// ACCEPT ORDER (Agent)
// =====================================================
router.put('/:orderId/accept', authenticate, isAgent, async (req, res) => {
  try {
    const agentId = req.user.id;
    const { orderId } = req.params;

    const orderRes = await pool.query(
      `SELECT id, status, agent_id FROM orders WHERE id = $1`,
      [orderId]
    );
    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderRes.rows[0];

    if (order.agent_id !== agentId) {
      return res.status(403).json({ error: 'This order is not assigned to you' });
    }
    if (order.status !== 'assigned') {
      return res.status(400).json({
        error: 'Order cannot be accepted in its current state',
        status: order.status,
      });
    }

    const updated = await pool.query(
      `UPDATE orders
       SET status = 'accepted',
           accepted_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [orderId]
    );

    clearAllTimers(orderId);

    await notifyOrderEvent(updated.rows[0], 'accepted');

    res.json({
      success: true,
      message: 'Order accepted',
      order: updated.rows[0],
    });
  } catch (error) {
    console.error('Accept order error:', error);
    res.status(500).json({ error: 'Failed to accept order' });
  }
});

// =====================================================
// OUT FOR DELIVERY (Agent)
// =====================================================
router.put(
  '/:orderId/out-for-delivery',
  authenticate,
  isAgent,
  async (req, res) => {
    try {
      const agentId = req.user.id;
      const { orderId } = req.params;

      const result = await pool.query(
        `UPDATE orders
         SET status = 'out_for_delivery',
             out_for_delivery_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND agent_id = $2 AND status = 'accepted'
         RETURNING *`,
        [orderId, agentId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Order not found or cannot be marked out for delivery',
        });
      }

      await notifyOrderEvent(result.rows[0], 'out_for_delivery');

      res.json({
        success: true,
        message: 'Order is out for delivery',
        order: result.rows[0],
      });
    } catch (error) {
      console.error('Out for delivery error:', error);
      res.status(500).json({ error: 'Failed to mark out for delivery' });
    }
  }
);

// =====================================================
// MARK AS DELIVERED (Agent)
// =====================================================
router.put('/:orderId/deliver', authenticate, isAgent, async (req, res) => {
  try {
    const agentId = req.user.id;
    const { orderId } = req.params;

    const result = await pool.query(
      `UPDATE orders
       SET status = 'delivered',
           delivered_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND agent_id = $2 AND status = 'out_for_delivery'
       RETURNING *`,
      [orderId, agentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Order not found or cannot be delivered',
      });
    }

    await notifyOrderEvent(result.rows[0], 'delivered');

    res.json({
      success: true,
      message: 'Order marked as delivered',
      order: result.rows[0],
    });
  } catch (error) {
    console.error('Deliver order error:', error);
    res.status(500).json({ error: 'Failed to mark as delivered' });
  }
});

// =====================================================
// CONFIRM RECEIPT (Customer)
// =====================================================
router.put('/:orderId/confirm', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = req.user.id;
    const { orderId } = req.params;
    const { rating, feedback } = req.body;

    const result = await client.query(
      `UPDATE orders
       SET status = 'confirmed',
           confirmed_at = NOW(),
           customer_rating = $2,
           customer_feedback = $3,
           updated_at = NOW()
       WHERE id = $1 AND customer_id = $4 AND status = 'delivered'
       RETURNING *`,
      [orderId, rating || null, feedback || null, customerId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'Order not found or cannot be confirmed',
      });
    }
    const order = result.rows[0];

    await client.query('COMMIT');

    await notifyOrderEvent(order, 'confirmed');

    res.json({
      success: true,
      message: 'Receipt confirmed — complete payment to close the order',
      order,
      payment_pending: order.payment_status !== 'paid',
      payment_method: order.payment_method,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Confirm order error:', error);
    res.status(500).json({ error: 'Failed to confirm delivery' });
  } finally {
    client.release();
  }
});

// =====================================================
// CHOOSE PAYMENT METHOD (Customer)
// =====================================================
router.put(
  '/:orderId/choose-payment-method',
  authenticate,
  async (req, res) => {
    try {
      const customerId = req.user.id;
      const { orderId } = req.params;
      const { method } = req.body || {};

      if (!['cash', 'pesapal'].includes(method)) {
        return res.status(400).json({
          error: 'method must be "cash" or "pesapal"',
        });
      }

      const result = await pool.query(
        `UPDATE orders
         SET payment_method = $1,
             updated_at = NOW()
         WHERE id = $2
           AND customer_id = $3
           AND status = 'confirmed'
           AND payment_status <> 'paid'
           AND payment_method = 'delivery'
         RETURNING *`,
        [method, orderId, customerId]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          error: 'Cannot choose a payment method for this order in its current state',
        });
      }

      res.json({
        success: true,
        message: `Payment method set to ${method}`,
        order: result.rows[0],
      });
    } catch (error) {
      console.error('Choose payment method error:', error);
      res.status(500).json({ error: 'Failed to set payment method' });
    }
  }
);

// =====================================================
// PAY CASH (Customer)
// =====================================================
router.put('/:orderId/pay-cash', authenticate, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { orderId } = req.params;

    const result = await pool.query(
      `UPDATE orders
       SET customer_pay_cash_intent_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND customer_id = $2
         AND status = 'confirmed'
         AND payment_method = 'cash'
         AND payment_status <> 'paid'
       RETURNING *`,
      [orderId, customerId]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        error: 'Cannot signal cash payment for this order',
      });
    }

    try {
      const { createNotification } = require('../services/notificationService');
      await createNotification({
        userId: result.rows[0].agent_id,
        eventType: 'payment_pending',
        templateKey: 'cash_ready',
        groupKey: `order:${orderId}`,
        ctx: {
          order_number: result.rows[0].order_number,
          order_id: orderId,
          amount: result.rows[0].total_amount,
        },
      });
    } catch (e) {
      console.warn('cash_ready notify failed:', e.message);
    }

    res.json({
      success: true,
      message: "Agent notified — pay them in cash when they arrive.",
      order: result.rows[0],
    });
  } catch (error) {
    console.error('Pay cash error:', error);
    res.status(500).json({ error: 'Failed to signal cash payment' });
  }
});

// =====================================================
// PAY ONLINE (Customer)
// =====================================================
router.post('/:orderId/pay-online', authenticate, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { orderId } = req.params;

    const result = await pool.query(
      `SELECT id, status, payment_method, payment_status, order_number, total_amount
       FROM orders
       WHERE id = $1 AND customer_id = $2`,
      [orderId, customerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = result.rows[0];

    if (order.payment_method !== 'pesapal') {
      return res.status(400).json({
        error: 'This is not a Pesapal order',
      });
    }
    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Already paid' });
    }

    res.json({
      success: true,
      order_id: order.id,
      order_number: order.order_number,
      amount: Number(order.total_amount),
      message: 'Ready for payment — call initiate endpoint',
    });
  } catch (error) {
    console.error('Pay online error:', error);
    res.status(500).json({ error: 'Failed to start online payment' });
  }
});

// =====================================================
// COLLECT CASH (Agent)
// =====================================================
router.put('/:orderId/collect-cash', authenticate, isAgent, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const agentId = req.user.id;
    const { orderId } = req.params;

    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND agent_id = $2 FOR UPDATE`,
      [orderId, agentId]
    );
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderRes.rows[0];

    if (order.payment_method !== 'cash') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'This order is not a cash order',
      });
    }
    if (order.status !== 'confirmed') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Cash can only be collected after the customer confirms receipt',
        status: order.status,
      });
    }
    if (order.payment_status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cash already collected' });
    }

    const updated = await client.query(
      `UPDATE orders
       SET payment_status = 'paid',
           payment_collected_at = NOW(),
           status = 'closed',
           closed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [orderId]
    );
    const closedOrder = updated.rows[0];

    const extendedFee = Number(closedOrder.extended_fee || 0);
    const itemsTotal = Number(closedOrder.total_amount) - extendedFee;
    const commission = itemsTotal * 0.10;
    const netFromItems = itemsTotal - commission;
    const netAmount = netFromItems + extendedFee;

    // ── Wallet: cash order, agent already has the money → they owe commission.
    //    Debit the wallet by the commission only.
    await client.query(
      `UPDATE agents
       SET current_order_count = GREATEST(0, current_order_count - 1),
           total_deliveries = total_deliveries + 1,
           total_earnings = total_earnings + $1,
           wallet_balance = wallet_balance - $2,
           updated_at = NOW()
       WHERE id = $3`,
      [netAmount, commission, agentId]
    );

    await client.query(
      `INSERT INTO agent_earnings
         (agent_id, order_id, amount, admin_commission, net_amount, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        agentId,
        orderId,
        closedOrder.total_amount,
        commission - extendedFee,
        netAmount,
      ]
    );

    await client.query(
      `INSERT INTO wallet_ledger (agent_id, order_id, type, amount, balance_after)
       SELECT $1, $2, 'CASH_COMMISSION', $3, wallet_balance
       FROM agents WHERE id = $1`,
      [agentId, orderId, -commission]
    );

    await client.query('COMMIT');

    await notifyOrderEvent(closedOrder, 'cash_collected');

    try {
      const walletService = require('../services/walletService');
      await walletService.updateBreachState(agentId);
    } catch (e) {
      console.warn('updateBreachState failed:', e.message);
    }

    res.json({
      success: true,
      message: 'Cash collected — order closed',
      order: closedOrder,
      credited: netAmount,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Collect cash error:', error);
    res.status(500).json({ error: 'Failed to collect cash' });
  } finally {
    client.release();
  }
});

// =====================================================
// PAYMENT CONFIRMED (Agent)
// =====================================================
router.put(
  '/:orderId/payment-confirmed',
  authenticate,
  isAgent,
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const agentId = req.user.id;
      const { orderId } = req.params;

      const orderRes = await client.query(
        `SELECT * FROM orders WHERE id = $1 AND agent_id = $2 FOR UPDATE`,
        [orderId, agentId]
      );
      if (orderRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Order not found' });
      }
      const order = orderRes.rows[0];

      if (order.payment_method === 'cash') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'This is a cash order — use collect-cash instead',
        });
      }
      if (order.payment_method === 'delivery') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Customer has not chosen a payment method yet',
        });
      }
      if (order.status !== 'confirmed') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Payment can only be confirmed after the customer confirms receipt',
          status: order.status,
        });
      }
      if (order.payment_status === 'paid') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Payment already confirmed' });
      }

      const updated = await client.query(
        `UPDATE orders
         SET payment_status = 'paid',
             payment_confirmed_by_agent_at = NOW(),
             status = 'closed',
             closed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [orderId]
      );
      const closedOrder = updated.rows[0];

      const extendedFee = Number(closedOrder.extended_fee || 0);
      const itemsTotal = Number(closedOrder.total_amount) - extendedFee;
      const commission = itemsTotal * 0.10;
      const netFromItems = itemsTotal - commission;
      const netAmount = netFromItems + extendedFee;

      // ── Wallet: online order, agent earns the net amount.
      await client.query(
        `UPDATE agents
         SET current_order_count = GREATEST(0, current_order_count - 1),
             total_deliveries = total_deliveries + 1,
             total_earnings = total_earnings + $1,
             wallet_balance = wallet_balance + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [netAmount, agentId]
      );

      await client.query(
        `INSERT INTO agent_earnings
           (agent_id, order_id, amount, admin_commission, net_amount, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          agentId,
          orderId,
          closedOrder.total_amount,
          commission - extendedFee,
          netAmount,
        ]
      );

      await client.query(
        `INSERT INTO wallet_ledger (agent_id, order_id, type, amount, balance_after)
         SELECT $1, $2, 'MPESA_EARNING', $3, wallet_balance
         FROM agents WHERE id = $1`,
        [agentId, orderId, netAmount]
      );

      await client.query('COMMIT');

      await notifyOrderEvent(closedOrder, 'paid');

      try {
        const walletService = require('../services/walletService');
        await walletService.updateBreachState(agentId);
      } catch (e) {
        console.warn('updateBreachState failed:', e.message);
      }

      res.json({
        success: true,
        message: 'Payment confirmed — order closed',
        order: closedOrder,
        credited: netAmount,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Payment confirmed error:', error);
      res.status(500).json({ error: 'Failed to confirm payment' });
    } finally {
      client.release();
    }
  }
);

// =====================================================
// DECLINE ORDER (Agent)
// =====================================================
router.put('/:orderId/decline', authenticate, isAgent, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const agentId = req.user.id;
    const { orderId } = req.params;
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A reason is required to decline' });
    }

    const orderRes = await client.query(
      `SELECT id, status, agent_id, excluded_agent_ids, reassignment_count,
              order_number
       FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderRes.rows[0];

    if (order.agent_id !== agentId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This order is not assigned to you' });
    }
    if (order.status !== 'assigned') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Order cannot be declined in its current state',
        status: order.status,
      });
    }

    const itemsRes = await client.query(
      `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
      [orderId]
    );
    for (const it of itemsRes.rows) {
      await client.query(
        `UPDATE agent_inventory
         SET stock_quantity = stock_quantity + $1,
             is_available = true,
             updated_at = NOW()
         WHERE agent_id = $2 AND product_id = $3`,
        [it.quantity, agentId, it.product_id]
      );
    }

    const newExcluded = [
      ...(order.excluded_agent_ids || []),
      agentId,
    ].filter(Boolean);

    const reset = await client.query(
      `UPDATE orders
       SET status = 'searching',
           agent_id = NULL,
           assigned_partner_code = NULL,
           assigned_at = NULL,
           hex_ring = NULL,
           excluded_agent_ids = $2::uuid[],
           reassignment_count = reassignment_count + 1,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [orderId, newExcluded]
    );

    await client.query(
      `UPDATE chat_threads
       SET agent_id = NULL, updated_at = NOW()
       WHERE order_id = $1`,
      [orderId]
    );

    await client.query(
      `UPDATE agents
       SET current_order_count = GREATEST(0, current_order_count - 1),
           updated_at = NOW()
       WHERE id = $1`,
      [agentId]
    );

    await client.query('COMMIT');

    clearAllTimers(orderId);

    await notifyOrderEvent(reset.rows[0], 'searching');

    runAgentSearch(orderId).catch((err) =>
      console.error('Post-decline search failed:', err)
    );
    scheduleSearchTimeout(orderId);

    res.json({
      success: true,
      message: 'Order declined — searching for another partner',
      order: reset.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Decline order error:', error);
    res.status(500).json({ error: 'Failed to decline order' });
  } finally {
    client.release();
  }
});

// =====================================================
// CANCEL ORDER BY AGENT
// =====================================================
router.put(
  '/:orderId/cancel-by-agent',
  authenticate,
  isAgent,
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const agentId = req.user.id;
      const { orderId } = req.params;
      const { reason } = req.body;

      if (!reason || !reason.trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A reason is required to cancel' });
      }

      const orderRes = await client.query(
        `SELECT id, product_id, quantity, status, agent_id
         FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      );
      if (orderRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Order not found' });
      }
      const order = orderRes.rows[0];

      if (order.agent_id !== agentId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'This order is not assigned to you' });
      }
      if (!['accepted', 'out_for_delivery'].includes(order.status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Only accepted or out-for-delivery orders can be cancelled',
          status: order.status,
        });
      }

      const itemsRes = await client.query(
        `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
        [orderId]
      );
      let lineItems = itemsRes.rows;
      if (lineItems.length === 0) {
        lineItems = [
          { product_id: order.product_id, quantity: order.quantity },
        ];
      }

      for (const it of lineItems) {
        await client.query(
          `UPDATE agent_inventory
           SET stock_quantity = stock_quantity + $1,
               is_available = true,
               updated_at = NOW()
           WHERE agent_id = $2 AND product_id = $3`,
          [it.quantity, agentId, it.product_id]
        );
      }

      const result = await client.query(
        `UPDATE orders
         SET status = 'cancelled',
             cancellation_reason = $1,
             cancelled_at = NOW(),
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [reason.trim(), orderId]
      );

      await client.query(
        `UPDATE agents
         SET current_order_count = GREATEST(0, current_order_count - 1),
             updated_at = NOW()
         WHERE id = $1`,
        [agentId]
      );

      await client.query('COMMIT');

      clearAllTimers(orderId);

      await notifyOrderEvent(result.rows[0], 'cancelled');

      res.json({
        success: true,
        message: 'Order cancelled',
        order: result.rows[0],
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Agent cancel order error:', error);
      res.status(500).json({ error: 'Failed to cancel order' });
    } finally {
      client.release();
    }
  }
);

// =====================================================
// CANCEL ORDER (Customer)
// =====================================================
router.put('/:orderId/cancel', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = req.user.id;
    const { orderId } = req.params;
    const { reason } = req.body;

    const orderRes = await client.query(
      `SELECT id, product_id, quantity, status, agent_id, customer_id
       FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderRes.rows[0];

    if (order.customer_id !== customerId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your order' });
    }
    if (
      !['pending', 'searching', 'assigned', 'accepted'].includes(order.status)
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Order cannot be cancelled in its current state',
        status: order.status,
      });
    }

    if (order.agent_id && ['assigned', 'accepted'].includes(order.status)) {
      const itemsRes = await client.query(
        `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
        [orderId]
      );
      let lineItems = itemsRes.rows;
      if (lineItems.length === 0) {
        lineItems = [
          { product_id: order.product_id, quantity: order.quantity },
        ];
      }

      for (const it of lineItems) {
        await client.query(
          `UPDATE agent_inventory
           SET stock_quantity = stock_quantity + $1,
               is_available = true,
               updated_at = NOW()
           WHERE agent_id = $2 AND product_id = $3`,
          [it.quantity, order.agent_id, it.product_id]
        );
      }

      await client.query(
        `UPDATE agents
         SET current_order_count = GREATEST(0, current_order_count - 1),
             updated_at = NOW()
         WHERE id = $1`,
        [order.agent_id]
      );
    }

    const result = await client.query(
      `UPDATE orders
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancellation_reason = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reason || 'Cancelled by customer', orderId]
    );

    await client.query('COMMIT');

    clearAllTimers(orderId);

    await notifyOrderEvent(result.rows[0], 'cancelled');

    res.json({
      success: true,
      message: 'Order cancelled',
      order: result.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Cancel order error:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  } finally {
    client.release();
  }
});

module.exports = router;