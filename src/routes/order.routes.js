// 📁 backend/routes/order.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');

// =====================================================
// CREATE ORDER (Customer) — supports single or multi-item
// =====================================================
router.post('/', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = req.user.id;
    const {
      // multi-item
      items,
      // single-item (backwards compat)
      product_id,
      quantity = 1,
      // delivery
      delivery_address,
      customer_latitude,
      customer_longitude,
      special_instructions,
      payment_method,
      // location hierarchy
      location_source,
      county_code,
      constituency_code,
      ward_code,
      area_name,
      landmark,
      customer_address_id,
    } = req.body;

    // ---- Normalize items ----
    const normalizedItems =
      Array.isArray(items) && items.length > 0
        ? items.map((it) => ({
            product_id: it.product_id || it.id,
            quantity: Number(it.quantity) || 1,
          }))
        : product_id
        ? [{ product_id, quantity: Number(quantity) || 1 }]
        : [];

    if (!normalizedItems.length || !delivery_address) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Missing required fields: items[] (or product_id) and delivery_address',
      });
    }

    // GPS is optional now (manual / WhatsApp-pin paths have no coords)
    const hasCoords =
      customer_latitude != null &&
      customer_longitude != null &&
      !Number.isNaN(Number(customer_latitude)) &&
      !Number.isNaN(Number(customer_longitude));

    // ---- Resolve all products ----
    const productIds = [...new Set(normalizedItems.map((i) => i.product_id))];
    const productsRes = await client.query(
      `SELECT id, name, base_price
       FROM products
       WHERE id = ANY($1::uuid[]) AND is_active = true`,
      [productIds]
    );
    const productsById = Object.fromEntries(productsRes.rows.map((p) => [p.id, p]));

    for (const it of normalizedItems) {
      if (!productsById[it.product_id]) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: `Product not found or inactive: ${it.product_id}`,
        });
      }
    }

    // ---- Subtotal ----
    let subtotal = 0;
    for (const it of normalizedItems) {
      subtotal += Number(productsById[it.product_id].base_price) * it.quantity;
    }

    // ---- Nearest agent (only when coords available) ----
    let agent = null;
    let deliveryFee = 100; // flat fallback

    if (hasCoords) {
      const anchorProductId = normalizedItems[0].product_id;
      const agentResult = await client.query(
        `SELECT * FROM find_nearest_agents($1, $2, $3, 5000, 1)`,
        [customer_latitude, customer_longitude, anchorProductId]
      );

      if (agentResult.rows.length > 0) {
        agent = agentResult.rows[0];
        const distance = parseFloat(agent.distance_km) || 0;
        deliveryFee = Math.max(50, Math.min(100, distance * 10));
      } else {
        console.warn(
          `No agent found near ${customer_latitude},${customer_longitude} for product ${anchorProductId}`
        );
      }
    }

    const orderNumber = `GM-${Date.now().toString().slice(-8)}`;
    const totalAmount = subtotal + deliveryFee;

    // Legacy single-item fields on `orders` — keep first item for old code paths
    const firstItem = normalizedItems[0];
    const firstProduct = productsById[firstItem.product_id];
    const orderStatus = agent ? 'assigned' : 'pending';

    const orderResult = await client.query(
      `INSERT INTO orders (
         order_number, customer_id, agent_id,
         product_id, quantity, product_price,
         delivery_fee, total_amount,
         customer_latitude, customer_longitude, delivery_address,
         special_instructions,
         payment_method,
         location_source, county_code, constituency_code, ward_code,
         area_name, landmark, customer_address_id,
         status, assigned_at, created_at, updated_at
       ) VALUES (
         $1,$2,$3,
         $4,$5,$6,
         $7,$8,
         $9,$10,$11,
         $12,
         $13,
         $14,$15,$16,$17,
         $18,$19,$20,
         $21,
         CASE WHEN $3::uuid IS NULL THEN NULL ELSE NOW() END,
         NOW(), NOW()
       )
       RETURNING *`,
      [
        orderNumber,
        customerId,
        agent ? agent.agent_id : null,
        firstItem.product_id,
        firstItem.quantity,
        firstProduct.base_price,
        deliveryFee,
        totalAmount,
        hasCoords ? customer_latitude : null,
        hasCoords ? customer_longitude : null,
        delivery_address,
        special_instructions || null,
        payment_method || 'mpesa',
        location_source || null,
        county_code || null,
        constituency_code || null,
        ward_code || null,
        area_name || null,
        landmark || null,
        customer_address_id || null,
        orderStatus,
      ]
    );

    const order = orderResult.rows[0];

    // ---- Persist all line items ----
    for (const it of normalizedItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [order.id, it.product_id, it.quantity, productsById[it.product_id].base_price]
      );
    }

    // ---- Bump agent load ----
    if (agent) {
      await client.query(
        `UPDATE agents
         SET current_order_count = current_order_count + 1,
             updated_at          = NOW()
         WHERE id = $1`,
        [agent.agent_id]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      order,
      items: normalizedItems,
      agent: agent
        ? {
            id: agent.agent_id,
            business_name: agent.business_name,
            distance_km: agent.distance_km,
            rating: agent.rating,
          }
        : null,
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
              p.image_url,
              a.business_name AS agent_business,
              u.full_name     AS agent_name
       FROM orders o
       LEFT JOIN products p ON o.product_id = p.id
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
              p.image_url,
              a.business_name AS agent_business,
              u.full_name     AS agent_name,
              u.phone_number  AS agent_phone
       FROM orders o
       LEFT JOIN products p ON o.product_id = p.id
       LEFT JOIN agents a ON o.agent_id = a.id
       LEFT JOIN users u  ON a.id = u.id
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
       JOIN products p ON oi.product_id = p.id
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
// ACCEPT ORDER (Agent) — deducts stock for every item
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

    // Get all line items for this order
    const itemsRes = await client.query(
      `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
      [orderId]
    );
    let lineItems = itemsRes.rows;

    // Fallback for legacy orders that only have the first item on `orders`
    if (lineItems.length === 0) {
      lineItems = [{ product_id: order.product_id, quantity: order.quantity }];
    }

    // Check & deduct stock for every line
    for (const it of lineItems) {
      const invRes = await client.query(
        `SELECT id, stock_quantity, is_available
         FROM agent_inventory
         WHERE agent_id = $1 AND product_id = $2
         FOR UPDATE`,
        [agentId, it.product_id]
      );
      if (invRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `You do not have product ${it.product_id} in your inventory`,
          code: 'no_inventory',
        });
      }
      const inv = invRes.rows[0];

      if (!inv.is_available) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Product ${it.product_id} is marked unavailable in your inventory`,
          code: 'not_available',
        });
      }
      if (inv.stock_quantity < it.quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Not enough stock for product ${it.product_id}. You have ${inv.stock_quantity}, order needs ${it.quantity}.`,
          code: 'insufficient_stock',
          available: inv.stock_quantity,
          required: it.quantity,
        });
      }

      await client.query(
        `UPDATE agent_inventory
         SET stock_quantity = stock_quantity - $1,
             is_available   = CASE WHEN stock_quantity - $1 <= 0 THEN false ELSE is_available END,
             updated_at     = NOW()
         WHERE id = $2`,
        [it.quantity, inv.id]
      );
    }

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
      items_accepted: lineItems.length,
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

    // Restore stock if the agent had already accepted
    if (order.agent_id && order.status === 'accepted') {
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