// 📁 backend/routes/adminAuth.routes.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// =====================================================
// TEMPORARY DEBUG — remove after diagnosing
// =====================================================
router.get('/debug/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    const { rows: users } = await pool.query(
      `SELECT id, phone_number, full_name, user_type,
              LENGTH(user_type)         AS char_count,
              '[' || user_type || ']'   AS bracketed,
              is_active, is_verified
       FROM users WHERE phone_number = $1`,
      [phone]
    );

    const { rows: meta } = await pool.query(
      `SELECT
         current_database()                                   AS db_name,
         current_user                                         AS db_user,
         inet_server_addr()::text                             AS db_host,
         inet_server_port()                                   AS db_port,
         (SELECT COUNT(*) FROM users)                         AS user_count,
         (SELECT COUNT(*) FROM users WHERE user_type='admin') AS admin_count`
    );

    res.json({
      query: { phone },
      user_count: users.length,
      users,
      server: meta[0],
    });
  } catch (err) {
    console.error('Debug route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// POST /api/admin/auth/login
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

    // Pick the admin row if multiple users share the same phone.
    // Also trim the user_type on read in case it was saved with whitespace.
    const result = await pool.query(
      `SELECT *,
              TRIM(user_type) AS user_type_clean
       FROM users
       WHERE phone_number = $1
       ORDER BY (TRIM(user_type) = 'admin') DESC, created_at ASC
       LIMIT 1`,
      [phone_number]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
    }

    const user = result.rows[0];
    const userType = user.user_type_clean || user.user_type;

    if (userType !== 'admin') {
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

    const token = jwt.sign(
      { userId: user.id, userType: 'admin', scope: 'admin' },
      process.env.JWT_SECRET || 'default_secret_key',
      { expiresIn: '12h' }
    );

    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Optional audit log — swallow errors (table may not have entity_type)
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, created_at)
         VALUES ($1, 'admin_login', NOW())`,
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
          user_type: userType,
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