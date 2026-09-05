const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

const authenticate = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret_key');
        const result = await pool.query(
            'SELECT id, full_name, phone_number, user_type, is_verified FROM users WHERE id = $1',
            [decoded.userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }
        
        req.user = result.rows[0];
        next();
    } catch (error) {
        console.error('Auth error:', error);
        return res.status(401).json({ error: 'Invalid token' });
    }
};

const isAgent = async (req, res, next) => {
    if (req.user.user_type !== 'agent') {
        return res.status(403).json({ error: 'Agent access required' });
    }
    
    const result = await pool.query(
        'SELECT is_approved FROM agents WHERE id = $1',
        [req.user.id]
    );
    
    if (result.rows.length === 0 || !result.rows[0].is_approved) {
        return res.status(403).json({ error: 'Agent account not approved' });
    }
    
    next();
};

module.exports = { authenticate, isAgent };