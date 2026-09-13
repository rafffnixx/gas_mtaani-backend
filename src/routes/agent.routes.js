const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');

// Get agent dashboard stats
router.get('/dashboard', authenticate, isAgent, async (req, res) => {
    try {
        const agentId = req.user.id;
        
        // Get agent details
        const agentResult = await pool.query(
            'SELECT * FROM agents WHERE id = $1',
            [agentId]
        );
        
        // Get order stats
        const statsResult = await pool.query(
            `SELECT 
                COUNT(*) FILTER (WHERE status IN ('pending', 'assigned')) as new_orders,
                COUNT(*) FILTER (WHERE status = 'accepted') as active_orders,
                COUNT(*) FILTER (WHERE status = 'confirmed') as completed_orders,
                COUNT(*) FILTER (WHERE status = 'confirmed' AND DATE(created_at) = CURRENT_DATE) as today_deliveries,
                COALESCE(SUM(total_amount) FILTER (WHERE status = 'confirmed' AND DATE(created_at) = CURRENT_DATE), 0) as today_earnings
             FROM orders 
             WHERE agent_id = $1`,
            [agentId]
        );
        
        res.json({
            agent: agentResult.rows[0] || {},
            stats: statsResult.rows[0] || {}
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard' });
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

// Toggle online status
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
            is_online: result.rows[0]?.is_online || false
        });
    } catch (error) {
        console.error('Toggle online error:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

module.exports = router;