// 📁 backend/routes/order.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');

// =====================================================
// CREATE ORDER (Customer) — consumes a pre-validated quote
// Body: { quote_id, payment_method, delivery_address,
//         special_instructions, customer_latitude, customer_longitude,
//         customer_address_id, location_source, county_code,
//         constituency_code, ward_code, area_name, landmark }
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

    // --------------------------------------------------
    // 1. Load and lock the quote
    // --------------------------------------------------
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

    // --------------------------------------------------
    // 2. Re-verify agent is still online and has capacity
    // --------------------------------------------------
    const agentRes = await client.query(
      `SELECT id, partner_code, is_online, current_order_count,
              max_order_capacity
       FROM agents WHERE id = $1`,
      [quote.agent_id]
    );
    const agent = agentRes.rows[0];
    if (!agent) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Assigned partner no longer exists' });
    }
    if (!agent.is_online) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Assigned partner is offline',
        hint: 'Request a new quote',
      });
    }
    if (agent.current_order_count >= agent.max_order_capacity) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Assigned partner is at capacity',
        hint: 'Request a new quote',
      });
    }

    // --------------------------------------------------
    // 3. Re-verify and deduct stock for every line
    // --------------------------------------------------
    const items = quote.items; // [{ product_id, quantity, unit_price, ... }]

    for (const item of items) {
      const inv = await client.query(
        `SELECT id, stock_quantity FROM agent_inventory
         WHERE agent_id = $1 AND product_id = $2
           AND is_available = true
         FOR UPDATE`,
        [quote.agent_id, item.product_id]
      );
      if (inv.rows.length === 0 || inv.rows[0].stock_quantity < item.quantity) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Insufficient stock for ${item.name}`,
          product_id: item.product_id,
          hint: 'Request a new quote',
        });
      }
      await client.query(
        `UPDATE agent_inventory
         SET stock_quantity = stock_quantity - $1,
             is_available   = CASE
               WHEN stock_quantity - $1 <= 0 THEN false
               ELSE is_available
             END,
             updated_at     = NOW()
         WHERE id = $2`,
        [item.quantity, inv.rows[0].id]
      );
    }

    // --------------------------------------------------
    // 4. Create the order — already assigned
    // --------------------------------------------------
    const orderNumber = `GM-${Date.now().toString().slice(-8)}`;
    const firstItem = items[0];

    const orderRes = await client.query(
      `INSERT INTO orders (
         order_number, customer_id, agent_id,
         product_id, quantity, product_price,
         delivery_fee, total_amount,
         customer_latitude, customer_longitude, delivery_address,
         special_instructions, payment_method,
         customer_address_id, location_source,
         county_code, constituency_code, ward_code, area_name, landmark,
         assigned_partner_code, extended_fee, hex_ring,
         status, assigned_at, created_at, updated_at
       ) VALUES (
         $1,$2,$3,
         $4,$5,$6,
         $7,$8,
         $9,$10,$11,
         $12,$13,
         $14,$15,
         $16,$17,$18,$19,$20,
         $21,$22,$23,
         'assigned', NOW(), NOW(), NOW()
       )
       RETURNING *`,
      [
        orderNumber,
        customerId,
        quote.agent_id,
        firstItem.product_id,
        firstItem.quantity,
        firstItem.unit_price,
        0, // delivery_fee is 0 — it's baked into the product price
        quote.grand_total,
        customer_latitude ?? null,
        customer_longitude ?? null,
        delivery_address,
        special_instructions || null,
        payment_method || 'pesapal',
        customer_address_id || null,
        location_source || null,
        county_code || null,
        constituency_code || null,
        ward_code || null,
        area_name || null,
        landmark || null,
        agent.partner_code,
        quote.extended_fee || 0,
        quote.hex_ring || null,
      ]
    );
    const order = orderRes.rows[0];

    // --------------------------------------------------
    // 5. Persist all line items
    // --------------------------------------------------
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [order.id, item.product_id, item.quantity, item.unit_price]
      );
    }

    // --------------------------------------------------
    // 6. Bump agent load, mark quote used
    // --------------------------------------------------
    await client.query(
      `UPDATE agents
       SET current_order_count = current_order_count + 1,
           updated_at          = NOW()
       WHERE id = $1`,
      [quote.agent_id]
    );

    await client.query(
      `UPDATE order_quotes SET status = 'used' WHERE id = $1`,
      [quote_id]
    );

    await client.query('COMMIT');

    // Customer-facing response — no agent details
    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      order: {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        total_amount: Number(order.total_amount),
        extended_fee: Number(order.extended_fee || 0),
        payment_status: order.payment_status,
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

    // Attach items[] to each order
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
// GET ORDER DETAILS (customer's own) — includes line items
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

    // Fetch all line items for this order
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
// ACCEPT ORDER (Agent) — stock already deducted at order creation.
// This handler only flips status to 'accepted'.
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
       SET status      = 'accepted',
           accepted_at = NOW(),
           updated_at  = NOW()
       WHERE id = $1
       RETURNING *`,
      [orderId]
    );

    res.json({
      success: true,
      message: 'Order accepted',
      order: updated.rows[0],
    });
  } catch (error) {
    console.error('Accept order error:', error);
    res.status(500).json({ error: 'Failed to accept order', details: error.message });
  }
});

// =====================================================
// DECLINE ORDER (Agent) — from New tab
// Stock restored (it was deducted at order creation).
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

    // Restore stock since it was deducted when the order was created
    const itemsRes = await client.query(
      `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
      [orderId]
    );
    for (const it of itemsRes.rows) {
      await client.query(
        `UPDATE agent_inventory
         SET stock_quantity = stock_quantity + $1,
             is_available   = true,
             updated_at     = NOW()
         WHERE agent_id = $2 AND product_id = $3`,
        [it.quantity, agentId, it.product_id]
      );
    }

    const result = await client.query(
      `UPDATE orders
       SET status              = 'declined',
           cancellation_reason = $1,
           cancelled_at        = NOW(),
           updated_at          = NOW()
       WHERE id = $2
       RETURNING *`,
      [reason.trim(), orderId]
    );

    await client.query(
      `UPDATE agents
       SET current_order_count = GREATEST(0, current_order_count - 1),
           updated_at          = NOW()
       WHERE id = $1`,
      [agentId]
    );

    await client.query('COMMIT');
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
// MARK AS DELIVERED (Agent) — no stock change
// =====================================================
router.put('/:orderId/deliver', authenticate, isAgent, async (req, res) => {
  try {
    const agentId = req.user.id;
    const { orderId } = req.params;

    const result = await pool.query(
      `UPDATE orders
       SET status       = 'delivered',
           delivered_at = NOW(),
           updated_at   = NOW()
       WHERE id = $1 AND agent_id = $2 AND status = 'accepted'
       RETURNING *`,
      [orderId, agentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found or cannot be delivered' });
    }

    res.json({ success: true, message: 'Order marked as delivered', order: result.rows[0] });
  } catch (error) {
    console.error('Deliver order error:', error);
    res.status(500).json({ error: 'Failed to mark as delivered' });
  }
});

// =====================================================
// CANCEL ORDER BY AGENT — from Active tab
// Reason required. Stock restored for every line.
// =====================================================
router.put('/:orderId/cancel-by-agent', authenticate, isAgent, async (req, res) => {
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
    if (!['accepted', 'picked_up', 'out_for_delivery'].includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Only accepted orders can be cancelled',
        status: order.status,
      });
    }

    // Get all line items for this order
    const itemsRes = await client.query(
      `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
      [orderId]
    );
    let lineItems = itemsRes.rows;
    if (lineItems.length === 0) {
      lineItems = [{ product_id: order.product_id, quantity: order.quantity }];
    }

    // Restore stock for every line
    for (const it of lineItems) {
      await client.query(
        `UPDATE agent_inventory
         SET stock_quantity = stock_quantity + $1,
             is_available   = true,
             updated_at     = NOW()
         WHERE agent_id = $2 AND product_id = $3`,
        [it.quantity, agentId, it.product_id]
      );
    }

    const result = await client.query(
      `UPDATE orders
       SET status              = 'cancelled',
           cancellation_reason = $1,
           cancelled_at        = NOW(),
           updated_at          = NOW()
       WHERE id = $2
       RETURNING *`,
      [reason.trim(), orderId]
    );

    await client.query(
      `UPDATE agents
       SET current_order_count = GREATEST(0, current_order_count - 1),
           updated_at          = NOW()
       WHERE id = $1`,
      [agentId]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Order cancelled', order: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Agent cancel order error:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  } finally {
    client.release();
  }
});

// =====================================================
// CONFIRM DELIVERY (Customer) — 90/10 split on items,
// extended fee 100% to agent
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
       SET status            = 'confirmed',
           confirmed_at      = NOW(),
           customer_rating   = $2,
           customer_feedback = $3,
           payment_status    = 'paid',
           updated_at        = NOW()
       WHERE id = $1 AND customer_id = $4 AND status = 'delivered'
       RETURNING *`,
      [orderId, rating || null, feedback || null, customerId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found or cannot be confirmed' });
    }
    const order = result.rows[0];

    // Agent gets 90% of items_total, plus 100% of extended_fee
    const extendedFee  = Number(order.extended_fee || 0);
    const itemsTotal   = Number(order.total_amount) - extendedFee;
    const commission   = itemsTotal * 0.10;
    const netFromItems = itemsTotal - commission;
    const netAmount    = netFromItems + extendedFee;

    // Update agent stats
    await client.query(
      `UPDATE agents
       SET current_order_count = GREATEST(0, current_order_count - 1),
           total_deliveries    = total_deliveries + 1,
           total_earnings      = total_earnings + $1,
           available_balance   = available_balance + $1,
           updated_at          = NOW()
       WHERE id = $2`,
      [netAmount, order.agent_id]
    );

    // Record the earnings split
    await client.query(
      `INSERT INTO agent_earnings
         (agent_id, order_id, amount, admin_commission, net_amount, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        order.agent_id,
        orderId,
        order.total_amount,
        commission - extendedFee,
        netAmount,
      ]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      message: 'Order confirmed successfully',
      order,
      credited: netAmount,
      breakdown: {
        items_total: itemsTotal,
        commission,
        extended_fee: extendedFee,
        net_amount: netAmount,
      },
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
// CANCEL ORDER (Customer)
// If the agent already accepted, restore stock for every line.
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
    if (!['pending', 'assigned', 'accepted'].includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Order cannot be cancelled in its current state',
        status: order.status,
      });
    }

    // Restore stock if the agent hadn't accepted yet (stock was deducted at order creation)
    if (order.agent_id && ['assigned', 'accepted'].includes(order.status)) {
      const itemsRes = await client.query(
        `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
        [orderId]
      );
      let lineItems = itemsRes.rows;
      if (lineItems.length === 0) {
        lineItems = [{ product_id: order.product_id, quantity: order.quantity }];
      }

      for (const it of lineItems) {
        await client.query(
          `UPDATE agent_inventory
           SET stock_quantity = stock_quantity + $1,
               is_available   = true,
               updated_at     = NOW()
           WHERE agent_id = $2 AND product_id = $3`,
          [it.quantity, order.agent_id, it.product_id]
        );
      }
    }

    // Release the agent slot if assigned or accepted
    if (order.agent_id && ['assigned', 'accepted'].includes(order.status)) {
      await client.query(
        `UPDATE agents
         SET current_order_count = GREATEST(0, current_order_count - 1),
             updated_at          = NOW()
         WHERE id = $1`,
        [order.agent_id]
      );
    }

    const result = await client.query(
      `UPDATE orders
       SET status              = 'cancelled',
           cancelled_at        = NOW(),
           cancellation_reason = $1,
           updated_at          = NOW()
       WHERE id = $2
       RETURNING *`,
      [reason || 'Cancelled by customer', orderId]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Order cancelled', order: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Cancel order error:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  } finally {
    client.release();
  }
});

module.exports = router;