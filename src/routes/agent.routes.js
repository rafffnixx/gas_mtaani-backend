// 📁 backend/routes/agent.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');

// ================================================================
// DASHBOARD
// ================================================================
router.get('/dashboard', authenticate, isAgent, async (req, res) => {
  try {
    const agentId = req.user.id;

    const agentResult = await pool.query(
      'SELECT * FROM agents WHERE id = $1',
      [agentId]
    );

    const statsResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending', 'assigned'))          AS new_orders,
         COUNT(*) FILTER (WHERE status = 'accepted')                         AS active_orders,
         COUNT(*) FILTER (WHERE status = 'confirmed')                        AS completed_orders,
         COUNT(*) FILTER (WHERE status = 'confirmed' AND DATE(created_at) = CURRENT_DATE) AS today_deliveries,
         COALESCE(SUM(total_amount) FILTER (WHERE status = 'confirmed' AND DATE(created_at) = CURRENT_DATE), 0) AS today_earnings
       FROM orders
       WHERE agent_id = $1`,
      [agentId]
    );

    res.json({
      agent: agentResult.rows[0] || {},
      stats: statsResult.rows[0] || {},
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

// ================================================================
// STATUS — approval check
// ================================================================
router.get('/status', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT business_name, is_online, rating, total_deliveries, is_approved
       FROM agents WHERE id = $1`,
      [req.user.id]
    );
    const agent = rows[0];
    if (!agent) {
      return res.status(403).json({ error: 'Agent account not approved' });
    }
    if (!agent.is_approved) {
      return res.status(403).json({ error: 'Agent account not approved' });
    }
    res.json({
      business_name: agent.business_name,
      is_online: agent.is_online ?? false,
      rating: Number(agent.rating || 0),
      total_deliveries: agent.total_deliveries || 0,
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ================================================================
// ONLINE TOGGLE
// ================================================================
router.put('/online', authenticate, isAgent, async (req, res) => {
  try {
    const { is_online } = req.body;
    const agentId = req.user.id;

    const result = await pool.query(
      'UPDATE agents SET is_online = $1 WHERE id = $2 RETURNING is_online',
      [is_online, agentId]
    );

    res.json({
      success: true,
      is_online: result.rows[0]?.is_online || false,
    });
  } catch (error) {
    console.error('Toggle online error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ================================================================
// INVENTORY
// ================================================================
router.get('/inventory', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ai.id,
              ai.product_id,
              p.name        AS product_name,
              p.brand_name  AS brand_name,
              p.image_url   AS image_url,
              p.price       AS price,
              p.weight_kg   AS weight_kg,
              ai.stock,
              ai.is_available
       FROM agent_inventory ai
       JOIN products p ON p.id = ai.product_id
       WHERE ai.agent_id = $1
       ORDER BY p.name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Inventory list error:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

router.post('/inventory', authenticate, isAgent, async (req, res) => {
  try {
    const { product_id, stock, stock_quantity, is_available } = req.body;
    const qty = stock ?? stock_quantity ?? 0;

    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO agent_inventory (agent_id, product_id, stock, is_available)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, product_id)
       DO UPDATE SET stock = EXCLUDED.stock,
                     is_available = EXCLUDED.is_available
       RETURNING *`,
      [req.user.id, product_id, qty, !!is_available]
    );

    res.json(rows[0]);
  } catch (error) {
    console.error('Inventory add error:', error);
    res.status(500).json({ error: 'Failed to add inventory' });
  }
});

router.put('/inventory/:id', authenticate, isAgent, async (req, res) => {
  try {
    const { stock, stock_quantity, is_available } = req.body;
    const qty = stock ?? stock_quantity;

    await pool.query(
      `UPDATE agent_inventory
       SET stock = COALESCE($1, stock),
           is_available = COALESCE($2, is_available)
       WHERE id = $3 AND agent_id = $4`,
      [qty, is_available, req.params.id, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Inventory update error:', error);
    res.status(500).json({ error: 'Failed to update inventory' });
  }
});

router.delete('/inventory/:id', authenticate, isAgent, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM agent_inventory WHERE id = $1 AND agent_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Inventory delete error:', error);
    res.status(500).json({ error: 'Failed to delete inventory' });
  }
});

// ================================================================
// EARNINGS
// ================================================================
router.get('/earnings', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE DATE(created_at) = CURRENT_DATE), 0)             AS today,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)     AS this_week,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)    AS this_month,
         COALESCE(SUM(amount), 0)                                                            AS total
       FROM agent_earnings
       WHERE agent_id = $1`,
      [req.user.id]
    );

    const balances = await pool.query(
      `SELECT total_earnings, available_balance FROM agents WHERE id = $1`,
      [req.user.id]
    );

    const summary = rows[0] || {};
    const b = balances.rows[0] || {};

    res.json({
      today: Number(summary.today || 0),
      this_week: Number(summary.this_week || 0),
      this_month: Number(summary.this_month || 0),
      total: Number(b.total_earnings || summary.total || 0),
      available_balance: Number(b.available_balance || 0),
      transactions: [],
    });
  } catch (error) {
    console.error('Earnings error:', error);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// ================================================================
// ORDERS
// ================================================================
router.get('/orders/new', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM orders
       WHERE status = 'pending'
       ORDER BY created_at DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (error) {
    console.error('New orders error:', error);
    res.status(500).json({ error: 'Failed to fetch new orders' });
  }
});

router.get('/orders', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM orders
       WHERE agent_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.post('/orders/:id/accept', authenticate, isAgent, async (req, res) => {
  try {
    await pool.query(
      `UPDATE orders SET agent_id = $1, status = 'accepted'
       WHERE id = $2 AND status = 'pending'`,
      [req.user.id, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Accept order error:', error);
    res.status(500).json({ error: 'Failed to accept order' });
  }
});

router.post('/orders/:id/decline', authenticate, isAgent, async (req, res) => {
  try {
    await pool.query(
      `UPDATE orders SET status = 'declined', decline_reason = $1
       WHERE id = $2`,
      [req.body.reason || null, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Decline order error:', error);
    res.status(500).json({ error: 'Failed to decline order' });
  }
});

router.post('/orders/:id/pickup', authenticate, isAgent, async (req, res) => {
  try {
    await pool.query(
      `UPDATE orders SET status = 'picked_up'
       WHERE id = $1 AND agent_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Pickup error:', error);
    res.status(500).json({ error: 'Failed to mark picked up' });
  }
});

router.post('/orders/:id/deliver', authenticate, isAgent, async (req, res) => {
  try {
    await pool.query(
      `UPDATE orders SET status = 'delivered', delivered_at = NOW()
       WHERE id = $1 AND agent_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Deliver error:', error);
    res.status(500).json({ error: 'Failed to mark delivered' });
  }
});

// ================================================================
// WITHDRAWALS
// ================================================================
router.post('/withdraw', authenticate, isAgent, async (req, res) => {
  try {
    const { amount, method } = req.body;
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    await pool.query(
      `INSERT INTO withdrawals (agent_id, amount, method, status)
       VALUES ($1, $2, $3, 'pending')`,
      [req.user.id, amount, method || 'mpesa']
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'Failed to request withdrawal' });
  }
});

router.get('/withdrawals', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM withdrawals WHERE agent_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Withdrawals error:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

module.exports = router;