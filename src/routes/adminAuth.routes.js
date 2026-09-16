// 📁 backend/routes/adminAuth.routes.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// =====================================================
// POST /api/admin/auth/login
// Only users with user_type = 'admin' can log in here.
// =====================================================
router.post('/login', async (req, res) => {
  try {
    const { phone_number, password } = req.body;

    if (!phone_number || !password) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and password required',
      });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE phone_number = $1',
      [phone_number]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
    }

    const user = result.rows[0];

    // Reject non-admin users at the source
    if (user.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'This account does not have admin access',
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Account is deactivated. Please contact support.',
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
    }

    // Admin-specific JWT — shorter expiry than the mobile app
    const token = jwt.sign(
      { userId: user.id, userType: 'admin', scope: 'admin' },
      process.env.JWT_SECRET || 'default_secret_key',
      { expiresIn: '12h' }
    );

    // Update last login
    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Optional: audit log
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, created_at)
         VALUES ($1, 'admin_login', 'auth', NOW())`,
        [user.id]
      );
    } catch (auditErr) {
      console.warn('Audit log skipped:', auditErr.message);
    }

    return res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          full_name: user.full_name,
          phone_number: user.phone_number,
          email: user.email,
          user_type: user.user_type,
          is_verified: user.is_verified,
          is_active: user.is_active,
          created_at: user.created_at,
        },
      },
    });
  } catch (error) {
    console.error('Admin login error:', error);
    return res.status(500).json({
      success: false,
      error: 'Login failed',
    });
  }
});

// =====================================================
// GET /api/admin/auth/me
// Returns the current admin's profile.
// =====================================================
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret_key');

    if (decoded.userType !== 'admin' || decoded.scope !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const result = await pool.query(
      `SELECT id, full_name, phone_number, email, user_type, is_verified, is_active, created_at
       FROM users WHERE id = $1 AND user_type = 'admin'`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Admin not found' });
    }

    return res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Admin /me error:', error);
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
});

module.exports = router;