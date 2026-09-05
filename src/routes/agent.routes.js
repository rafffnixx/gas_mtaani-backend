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