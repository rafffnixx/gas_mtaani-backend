// 📁 backend/routes/order.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');

// =====================================================
// CREATE ORDER (Customer)
// =====================================================
router.post('/', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = req.user.id;
    const {
      product_id,
      quantity = 1,
      delivery_address,
      customer_latitude,
      customer_longitude,
      special_instructions,
    } = req.body;

    if (!product_id || !delivery_address || !customer_latitude || !customer_longitude) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Missing required fields: product_id, delivery_address, customer_latitude, customer_longitude',
      });
    }

    // Product lookup
    const productResult = await client.query(
      'SELECT * FROM products WHERE id = $1 AND is_active = true',
      [product_id]
    );
    if (productResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found or inactive' });
    }
    const product = productResult.rows[0];

    // Nearest agent (requires the find_nearest_agents SQL function)
    const agentResult = await client.query(
      `SELECT * FROM find_nearest_agents($1, $2, $3, 5000, 1)`,
      [customer_latitude, customer_longitude, product_id]
    );
    if (agentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'No available agents within your area. Please try again later.',
      });
    }
    const agent = agentResult.rows[0];

    // Delivery fee: 10 KES/km, min 50, max 100
    const distance = parseFloat(agent.distance_km) || 0;
    let deliveryFee = distance * 10;
    deliveryFee = Math.max(50, Math.min(100, deliveryFee));

    const orderNumber = `GM-${Date.now().toString().slice(-8)}`;
    const totalAmount = product.base_price * quantity + deliveryFee;

    const orderResult = await client.query(
      `INSERT INTO orders (
         order_number, customer_id, agent_id, product_id,
         quantity, product_price, delivery_fee, total_amount,
         customer_latitude, customer_longitude, delivery_address,
         special_instructions, status, assigned_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'assigned',NOW(),NOW(),NOW())
       RETURNING *`,
      [
        orderNumber,
        customerId,
        agent.agent_id,
        product_id,
        quantity,
        product.base_price,
        deliveryFee,
        totalAmount,
        customer_latitude,
        customer_longitude,
        delivery_address,
        special_instructions || null,
      ]
    );

    // Bump the agent's in-flight counter. Stock is NOT deducted here —
    // only on accept, per the flow we agreed on.
    await client.query(
      'UPDATE agents SET current_order_count = current_order_count + 1, updated_at = NOW() WHERE id = $1',
      [agent.agent_id]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      order: orderResult.rows[0],
      agent: {
        id: agent.agent_id,
        business_name: agent.business_name,
        distance_km: agent.distance_km,
        rating: agent.rating,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
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
              p.image_url,
              a.business_name AS agent_business,
              u.full_name     AS agent_name
       FROM orders o
       JOIN products p ON o.product_id = p.id
       LEFT JOIN agents a ON o.agent_id = a.id
       LEFT JOIN users u  ON a.id = u.id
       WHERE o.customer_id = $1
       ORDER BY o.created_at DESC`,
      [customerId]
    );

    res.json(result.rows);
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
              p.image_url,
              a.business_name AS agent_business,
              u.full_name     AS agent_name,
              u.phone_number  AS agent_phone
       FROM orders o
       JOIN products p ON o.product_id = p.id
       LEFT JOIN agents a ON o.agent_id = a.id
       LEFT JOIN users u  ON a.id = u.id
       WHERE o.id = $1 AND o.customer_id = $2`,
      [orderId, customerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Order detail error:', error);
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

// =====================================================
// ACCEPT ORDER (Agent) — deducts stock
// =====================================================
router.put('/:orderId/accept', authenticate, isAgent, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const agentId = req.user.id;
    const { orderId } = req.params;

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
    if (order.status !== 'assigned') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Order cannot be accepted in its current state',
        status: order.status,
      });
    }

    const invRes = await client.query(
      `SELECT id, stock_quantity, is_available
       FROM agent_inventory
       WHERE agent_id = $1 AND product_id = $2
       FOR UPDATE`,
      [agentId, order.product_id]
    );
    if (invRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'You do not have this product in your inventory',
        code: 'no_inventory',
      });
    }
    const inv = invRes.rows[0];

    if (!inv.is_available) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'This product is marked unavailable in your inventory',
        code: 'not_available',
      });
    }
    if (inv.stock_quantity < order.quantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Not enough stock. You have ${inv.stock_quantity}, order needs ${order.quantity}.`,
        code: 'insufficient_stock',
        available: inv.stock_quantity,
        required: order.quantity,
      });
    }

    // Deduct stock
    await client.query(
      `UPDATE agent_inventory
       SET stock_quantity = stock_quantity - $1,
           is_available   = CASE WHEN stock_quantity - $1 <= 0 THEN false ELSE is_available END,
           updated_at     = NOW()
       WHERE id = $2`,
      [order.quantity, inv.id]
    );

    const updated = await client.query(
      `UPDATE orders
       SET status      = 'accepted',
           accepted_at = NOW(),
           updated_at  = NOW()
       WHERE id = $1
       RETURNING *`,
      [orderId]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      message: 'Order accepted',
      order: updated.rows[0],
      stock_remaining: inv.stock_quantity - order.quantity,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Accept order error:', error);
    res.status(500).json({ error: 'Failed to accept order', details: error.message });
  } finally {
    client.release();
  }
});

// =====================================================
// DECLINE ORDER (Agent) — from New tab
// Reason required. No stock change (nothing deducted yet).
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

    // Release the agent's slot
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
// Reason required. Stock restored.
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

    // Restore stock
    await client.query(
      `UPDATE agent_inventory
       SET stock_quantity = stock_quantity + $1,
           is_available   = true,
           updated_at     = NOW()
       WHERE agent_id = $2 AND product_id = $3`,
      [order.quantity, agentId, order.product_id]
    );

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

    // Release the slot
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
// CONFIRM DELIVERY (Customer) — credits agent, keeps stock consumed
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

    // Update agent stats
    await client.query(
      `UPDATE agents
       SET current_order_count = GREATEST(0, current_order_count - 1),
           total_deliveries    = total_deliveries + 1,
           updated_at          = NOW()
       WHERE id = $1`,
      [order.agent_id]
    );

    // Earnings — 10% admin commission, 90% to the agent
    const commission = Number(order.total_amount) * 0.10;
    const netAmount  = Number(order.total_amount) - commission;

    await client.query(
      `INSERT INTO agent_earnings (agent_id, order_id, amount, admin_commission, net_amount, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [order.agent_id, orderId, order.total_amount, commission, netAmount]
    );

    // Bump the agent's wallet
    await client.query(
      `UPDATE agents
       SET total_earnings    = total_earnings    + $1,
           available_balance = available_balance + $1,
           updated_at        = NOW()
       WHERE id = $2`,
      [netAmount, order.agent_id]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      message: 'Order confirmed successfully',
      order: result.rows[0],
      credited: netAmount,
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
// If the agent already accepted, restore stock.
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

    // Restore stock if the agent had already accepted
    if (order.agent_id && order.status === 'accepted') {
      await client.query(
        `UPDATE agent_inventory
         SET stock_quantity = stock_quantity + $1,
             is_available   = true,
             updated_at     = NOW()
         WHERE agent_id = $2 AND product_id = $3`,
        [order.quantity, order.agent_id, order.product_id]
      );

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