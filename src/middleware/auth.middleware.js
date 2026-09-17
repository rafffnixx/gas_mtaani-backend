// 📁 backend/src/middleware/auth.middleware.js
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// =====================================================
// Authenticate — verify JWT and attach req.user
// =====================================================
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'default_secret_key'
    );

    const result = await pool.query(
      'SELECT id, full_name, phone_number, user_type, is_verified, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// =====================================================
// Is Agent — user must be an approved agent
// =====================================================
const isAgent = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

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
  } catch (error) {
    console.error('isAgent error:', error.message);
    return res.status(500).json({ error: 'Failed to verify agent' });
  }
};

// =====================================================
// 👇 NEW: Is Admin — user must have user_type = 'admin'
// =====================================================
const isAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.user.user_type !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('isAdmin error:', error.message);
    return res.status(500).json({ error: 'Failed to verify admin' });
  }
};

// =====================================================
// 👇 NEW: Require Admin Key — simple header check
// for extra protection on destructive admin endpoints
// =====================================================
const requireAdminKey = (req, res, next) => {
  const key = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_KEY || 'adminsecretkey_123';

  if (!key || key !== expected) {
    return res.status(403).json({ error: 'Invalid admin key' });
  }

  next();
};

module.exports = {
  authenticate,
  isAgent,
  isAdmin,
  requireAdminKey,
};