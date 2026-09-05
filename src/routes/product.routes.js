const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');

// Get all products
router.get('/', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products WHERE is_active = true ORDER BY brand_name, weight_kg'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Products error:', error);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// Get product by ID
router.get('/:id', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products WHERE id = $1 AND is_active = true',
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Product error:', error);
        res.status(500).json({ error: 'Failed to fetch product' });
    }
});

// Search products
router.get('/search/:query', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM products 
             WHERE is_active = true 
             AND (name ILIKE $1 OR brand_name ILIKE $1)
             ORDER BY brand_name`,
            [`%${req.params.query}%`]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});

module.exports = router;