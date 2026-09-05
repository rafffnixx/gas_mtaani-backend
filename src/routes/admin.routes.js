const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Simple admin check (you can add proper auth later)
const isAdmin = (req, res, next) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== (process.env.ADMIN_API_KEY || 'admin_secret_key_123')) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// Get all agents (admin only)
router.get('/agents', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.*, a.* 
             FROM agents a
             JOIN users u ON a.id = u.id
             ORDER BY a.created_at DESC`
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Admin agents error:', error);
        res.status(500).json({ error: 'Failed to fetch agents' });
    }
});

// Get dashboard stats (admin)
router.get('/dashboard', isAdmin, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM users WHERE user_type = 'customer') as total_customers,
                (SELECT COUNT(*) FROM agents WHERE is_approved = true) as total_agents,
                (SELECT COUNT(*) FROM agents WHERE is_approved = false) as pending_agents,
                (SELECT COUNT(*) FROM orders WHERE status = 'confirmed') as total_orders,
                (SELECT COUNT(*) FROM orders WHERE status = 'confirmed' AND DATE(created_at) = CURRENT_DATE) as today_orders,
                (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status = 'confirmed') as total_revenue,
                (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status = 'confirmed' AND DATE(created_at) = CURRENT_DATE) as today_revenue
        `);
        
        res.json(stats.rows[0] || {});
    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

module.exports = router;