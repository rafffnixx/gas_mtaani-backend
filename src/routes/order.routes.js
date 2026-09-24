// 📁 backend/src/routes/order.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');
const { latLngToHex, hexesUpToRing } = require('../utils/hexGrid');
const { notifyOrderEvent } = require('../services/notificationService');

// =====================================================
// CREATE ORDER (Customer)
//
// payment_method accepts three values:
//   'pesapal'   → customer chose "Pay Now" at checkout
//   'delivery'  → customer chose "Pay on Delivery" (decide method later)
//   'cash'      → legacy; treat as 'delivery' with cash pre-selected
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

    // Validate payment_method
    const allowedMethods = ['pesapal', 'delivery', 'cash'];
    const chosenMethod = allowedMethods.includes(payment_method)
      ? payment_method
      : 'delivery'; // safe default — customer can decide at delivery

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

    // Payment status starts 'pending' for all methods now.
    // 'pesapal' orders get paid via the app right after creation.
    // 'delivery' orders wait until customer confirms receipt.
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
         status, payment_status, created_at, updated_at
       ) VALUES (
         $1,$2,NULL,
         $3,$4,$5,
         0,$6,
         $7,$8,$9,
         $10,$11,
         $12,$13,
         $14,$15,$16,$17,$18,
         0,
         'searching', 'pending', NOW(), NOW()
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

    await client.query(
      `UPDATE order_quotes SET status = 'used' WHERE id = $1`,
      [quote_id]
    );

    await client.query('COMMIT');

    await notifyOrderEvent(order, 'pending');

    runAgentSearch(order.id).catch((err) =>
      console.error('runAgentSearch failed:', err)
    );
    scheduleAutoCancel(order.id, 2 * 60 * 1000);

    return res.status(201).json({
      success: true,
      message: 'Order placed — finding a partner',
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
// BACKGROUND: Find an agent for this order.
// =====================================================
async function runAgentSearch(orderId) {
  try {
    const { rows } = await pool.query(
      `SELECT id, customer_latitude, customer_longitude, status
       FROM orders WHERE id = $1`,
      [orderId]
    );
    if (rows.length === 0) return;
    const order = rows[0];

    if (order.status !== 'searching') return;

    if (order.customer_latitude == null || order.customer_longitude == null) {
      console.warn(`Order ${orderId} has no coords — cannot search`);
      return;
    }

    const lat = Number(order.customer_latitude);
    const lng = Number(order.customer_longitude);

    const itemsRes = await pool.query(
      `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
      [orderId]
    );
    const items = itemsRes.rows;
    if (items.length === 0) return;

    const productIds = items.map((i) => i.product_id);
    const itemCount = items.length;

    const customerHex = latLngToHex(lat, lng);

    for (let ring = 1; ring <= 4; ring++) {
      const hexes = hexesUpToRing(customerHex, ring);

      const { rows: candidates } = await pool.query(
        `
        SELECT
          a.id                AS agent_id,
          a.partner_code,
          a.rating,
          a.current_order_count,
          COUNT(DISTINCT ai.product_id) AS items_covered
        FROM agents a
        JOIN agent_inventory ai ON ai.agent_id = a.id
        WHERE a.hex_id = ANY($1::bigint[])
          AND a.is_online = true
          AND a.is_approved = true
          AND a.current_order_count < a.max_order_capacity
          AND ai.product_id = ANY($2::uuid[])
          AND ai.stock_quantity > 0
        GROUP BY a.id, a.partner_code, a.rating, a.current_order_count
        HAVING COUNT(DISTINCT ai.product_id) = $3
        ORDER BY a.current_order_count ASC, a.rating DESC NULLS LAST
        LIMIT 1
        `,
        [hexes, productIds, itemCount]
      );

      if (candidates.length > 0) {
        const agent = candidates[0];

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const lock = await client.query(
            `SELECT status FROM orders WHERE id = $1 FOR UPDATE`,
            [orderId]
          );
          if (lock.rows[0]?.status !== 'searching') {
            await client.query('ROLLBACK');
            return;
          }

          for (const item of items) {
            const inv = await client.query(
              `SELECT id, stock_quantity FROM agent_inventory
               WHERE agent_id = $1 AND product_id = $2
               FOR UPDATE`,
              [agent.agent_id, item.product_id]
            );
            if (
              inv.rows.length === 0 ||
              inv.rows[0].stock_quantity < item.quantity
            ) {
              await client.query('ROLLBACK');
              throw new Error('Stock changed during assignment');
            }
            await client.query(
              `UPDATE agent_inventory
               SET stock_quantity = stock_quantity - $1,
                   is_available = CASE
                     WHEN stock_quantity - $1 <= 0 THEN false
                     ELSE is_available
                   END,
                   updated_at = NOW()
               WHERE id = $2`,
              [item.quantity, inv.rows[0].id]
            );
          }

          const assignedRes = await client.query(
            `UPDATE orders
             SET agent_id = $1,
                 assigned_partner_code = $2,
                 hex_ring = $3,
                 status = 'assigned',
                 assigned_at = NOW(),
                 updated_at = NOW()
             WHERE id = $4
             RETURNING *`,
            [agent.agent_id, agent.partner_code, ring, orderId]
          );

          await client.query(
            `UPDATE agents
             SET current_order_count = current_order_count + 1,
                 updated_at = NOW()
             WHERE id = $1`,
            [agent.agent_id]
          );

          await client.query('COMMIT');

          await notifyOrderEvent(assignedRes.rows[0], 'assigned');

          console.log(
            `✅ Order ${orderId} assigned to ${agent.partner_code} (ring ${ring})`
          );
          return;
        } catch (err) {
          console.error('Assignment transaction failed:', err.message);
        } finally {
          client.release();
        }
      }
    }

    console.log(`❌ No agent found for order ${orderId}`);
  } catch (err) {
    console.error('runAgentSearch error:', err);
  }
}

// =====================================================
// BACKGROUND: Auto-cancel an order if still 'searching' after N ms
// =====================================================
function scheduleAutoCancel(orderId, delayMs) {
  setTimeout(async () => {
    try {
      const { rows, rowCount } = await pool.query(
        `UPDATE orders
         SET status = 'cancelled',
             cancellation_reason = 'no_agent_available',
             cancelled_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND status = 'searching'
         RETURNING *`,
        [orderId]
      );
      if (rowCount > 0) {
        console.log(`⏱  Order ${orderId} auto-cancelled (no agent in 2 min)`);
        await notifyOrderEvent(rows[0], 'cancelled');
      }
    } catch (err) {
      console.error('Auto-cancel error:', err);
    }
  }, delayMs);
}

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
// assigned → accepted
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
// accepted → out_for_delivery
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
// out_for_delivery → delivered
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
// delivered → confirmed
// Payment is handled separately (via collect-cash, payment-confirmed,
// or choose-payment-method → then one of the two).
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
// confirmed + payment_method='delivery' → set to 'cash' or 'pesapal'
//
// This is Stage 2 of the two-stage flow. Called from PaymentScreen
// when the customer taps "Pay Cash" or "Pay with M-PESA" on the chooser.
//
// After this call, the order's payment_method reflects the final decision,
// and the customer can proceed with the corresponding action:
//   - cash      → PUT /collect-cash will close the order
//   - pesapal   → POST /payments/pesapal/initiate + PUT /payment-confirmed
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
// confirmed + payment_method='cash' → signals intent to pay cash
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

    // Notify the agent that the customer is ready to pay cash
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
// confirmed + payment_method='pesapal' → returns order id for Pesapal initiate
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
    if (order.status !== 'confirmed') {
      return res.status(400).json({
        error: 'Confirm receipt before paying',
        status: order.status,
      });
    }
    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Already paid' });
    }

    // The app will call /payments/pesapal/initiate separately.
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
// confirmed + payment_method='cash' → paid + closed
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

    // Credit the agent — 90/10 split on items, extended fee 100% to agent
    const extendedFee = Number(closedOrder.extended_fee || 0);
    const itemsTotal = Number(closedOrder.total_amount) - extendedFee;
    const commission = itemsTotal * 0.10;
    const netFromItems = itemsTotal - commission;
    const netAmount = netFromItems + extendedFee;

    await client.query(
      `UPDATE agents
       SET current_order_count = GREATEST(0, current_order_count - 1),
           total_deliveries = total_deliveries + 1,
           total_earnings = total_earnings + $1,
           available_balance = available_balance + $1,
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

    await client.query('COMMIT');

    await notifyOrderEvent(closedOrder, 'cash_collected');

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
// confirmed + payment_method='pesapal' → paid + closed
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

      await client.query(
        `UPDATE agents
         SET current_order_count = GREATEST(0, current_order_count - 1),
             total_deliveries = total_deliveries + 1,
             total_earnings = total_earnings + $1,
             available_balance = available_balance + $1,
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

      await client.query('COMMIT');

      await notifyOrderEvent(closedOrder, 'paid');

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
      `SELECT id, status, agent_id FROM orders WHERE id = $1 FOR UPDATE`,
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

    const result = await client.query(
      `UPDATE orders
       SET status = 'declined',
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

    await notifyOrderEvent(result.rows[0], 'declined');

    res.json({ success: true, message: 'Order declined', order: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Decline order error:', error);
    res.status(500).json({ error: 'Failed to decline order' });
  } finally {
    client.release();
  }
});

// =====================================================
// CANCEL ORDER BY AGENT — restores stock
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

