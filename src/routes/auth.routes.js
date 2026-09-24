// 📁 backend/src/routes/auth.routes.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// Use the shared auth middleware (validates the JWT and sets req.user)
let authenticate;
try {
  ({ authenticate } = require('../middleware/auth.middleware'));
} catch (e) {
  // Fallback: define a minimal inline version in case the export name
  // is different — this keeps /push-token from crashing on startup.
  authenticate = (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Authentication required' });

      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'default_secret_key'
      );
      // Some middleware variants store `id`; the JWT uses `userId`.
      req.user = {
        id: decoded.userId || decoded.id,
        user_type: decoded.userType || decoded.user_type,
      };
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

// ============================================
// REGISTER USER - COMPLETE FIX
// ============================================
router.post('/register', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      phone_number,
      email,
      full_name,
      password,
      user_type,
      is_verified,
      is_active,
    } = req.body;

    console.log('📦 Registration request:', {
      phone_number,
      full_name,
      email,
      user_type,
      is_verified,
      is_active,
    });

    if (!phone_number || !full_name || !password) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: phone_number, full_name, password',
      });
    }

    const existingUser = await client.query(
      'SELECT id FROM users WHERE phone_number = $1 OR email = $2',
      [phone_number, email]
    );

    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'User with this phone number or email already exists',
      });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await client.query(
      `INSERT INTO users (
          phone_number, email, full_name, password_hash, user_type,
          is_verified, is_active, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING id, phone_number, email, full_name, user_type, is_verified, is_active, created_at`,
      [
        phone_number,
        email || null,
        full_name,
        password_hash,
        user_type || 'customer',
        is_verified !== undefined ? is_verified : true,
        is_active !== undefined ? is_active : true,
      ]
    );

    const newUser = result.rows[0];

    if (user_type === 'agent') {
      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'agent_profiles'
        )
      `);

      if (tableCheck.rows[0].exists) {
        await client.query(
          `INSERT INTO agent_profiles (
              user_id, business_name, is_approved, is_active, created_at, updated_at
           ) VALUES ($1, $2, false, true, NOW(), NOW())`,
          [newUser.id, full_name + ' - Agent']
        );
        console.log('✅ Agent profile created for:', full_name);
      }
    }

    await client.query('COMMIT');

    console.log('✅ User registered successfully:', newUser.phone_number);

    const token = jwt.sign(
      { userId: newUser.id, userType: newUser.user_type },
      process.env.JWT_SECRET || 'default_secret_key',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        token,
        user: {
          id: newUser.id,
          full_name: newUser.full_name,
          phone_number: newUser.phone_number,
          email: newUser.email,
          user_type: newUser.user_type,
          is_verified: newUser.is_verified,
          is_active: newUser.is_active,
          created_at: newUser.created_at,
        },
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed',
      details: error.message,
    });
  } finally {
    client.release();
  }
});

// ============================================
// LOGIN USER
// ============================================
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
      { userId: user.id, userType: user.user_type },
      process.env.JWT_SECRET || 'default_secret_key',
      { expiresIn: '7d' }
    );

    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    res.json({
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
    console.error('❌ Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed',
    });
  }
});

// ============================================
// GET CURRENT USER
// ============================================
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'default_secret_key'
    );

    const result = await pool.query(
      `SELECT id, full_name, phone_number, email, user_type,
              is_verified, is_active, created_at
       FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.json({
      success: true,
      user: result.rows[0],
    });
  } catch (error) {
    console.error('❌ Get user error:', error);
    res.status(401).json({
      success: false,
      error: 'Invalid token',
    });
  }
});

// =====================================================
// POST /api/auth/push-token
// Save (or refresh) the Expo push token for the current user.
// Called by the mobile app after login and on app boot.
// =====================================================
router.post('/push-token', authenticate, async (req, res) => {
  try {
    const { token } = req.body || {};

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' });
    }

    // Cap length to fit VARCHAR(255)
    const trimmed = token.trim().slice(0, 255);
    if (!trimmed) {
      return res.status(400).json({ error: 'token is empty' });
    }

    await pool.query(
      `UPDATE users SET expo_push_token = $1 WHERE id = $2`,
      [trimmed, req.user.id]
    );

    console.log(
      `📲 Push token saved for user ${req.user.id}:`,
      trimmed.slice(0, 30) + '...'
    );

    res.json({ success: true });
  } catch (err) {
    console.error('POST /auth/push-token error:', err);
    res.status(500).json({ error: 'Failed to save push token' });
  }
});

// =====================================================
// DELETE /api/auth/push-token
// Clear the push token on logout so the user stops
// receiving notifications on this device.
// =====================================================
router.delete('/push-token', authenticate, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET expo_push_token = NULL WHERE id = $1`,
      [req.user.id]
    );

    console.log(`🔕 Push token cleared for user ${req.user.id}`);

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /auth/push-token error:', err);
    res.status(500).json({ error: 'Failed to clear push token' });
  }
});

module.exports = router;