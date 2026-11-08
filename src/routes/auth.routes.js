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
  // Fallback minimal version
  authenticate = (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Authentication required' });

      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'default_secret_key'
      );
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
// REGISTER USER — with promo code attribution
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
      promo_code,          // ← NEW
      business_name,       // ← helpful for agents (falls back to full_name)
      county,
      sub_county,
    } = req.body;

    console.log('📦 Registration request:', {
      phone_number,
      full_name,
      email,
      user_type,
      has_promo_code: Boolean(promo_code),
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
      [phone_number, email || null]
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
    const finalUserType = ['customer', 'agent'].includes(user_type) ? user_type : 'customer';

    const result = await client.query(
      `INSERT INTO users (
          phone_number, email, full_name, password_hash, user_type,
          county, sub_county,
          is_verified, is_active, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING id, phone_number, email, full_name, user_type, is_verified, is_active, created_at`,
      [
        phone_number,
        email || null,
        full_name,
        password_hash,
        finalUserType,
        county || null,
        sub_county || null,
        is_verified !== undefined ? is_verified : true,
        is_active !== undefined ? is_active : true,
      ]
    );

    const newUser = result.rows[0];

    // ── Create Agent Profile if registering as agent ──
    if (newUser.user_type === 'agent') {
      const partnerCode = `WTG-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      await client.query(
        `INSERT INTO agents (
            id, business_name, partner_code, is_approved, is_active,
            is_online, service_radius, commission_rate, wallet_balance, status
         ) VALUES ($1, $2, $3, false, true, false, 5000, 10.00, 0, 'ACTIVE')`,
        [newUser.id, business_name || full_name, partnerCode]
      );
      console.log('✅ Agent profile created for:', full_name, '| Code:', partnerCode);
    }

    // ── Promo code attribution ──
    let promoAttribution = null;
    if (promo_code && String(promo_code).trim()) {
      const code = String(promo_code).trim().toUpperCase();
      const pc = await client.query(
        `SELECT pc.id, pc.marketer_id, pc.code, pc.period, pc.applies_to,
                m.full_name AS marketer_name
         FROM promo_codes pc
         JOIN marketers m ON m.id = pc.marketer_id
         WHERE pc.code = $1
           AND pc.is_active = true
           AND m.is_approved = true
           AND m.is_active = true`,
        [code]
      );

      if (
        pc.rows.length > 0 &&
        (pc.rows[0].applies_to === 'both' || pc.rows[0].applies_to === finalUserType)
      ) {
        try {
          await client.query(
            `INSERT INTO marketer_registrations (marketer_id, user_id, user_type)
             VALUES ($1, $2, $3)`,
            [pc.rows[0].marketer_id, newUser.id, finalUserType]
          );
          promoAttribution = {
            marketer_name: pc.rows[0].marketer_name,
            code: pc.rows[0].code,
            period: pc.rows[0].period,
          };
          console.log('🎯 Promo code applied:', code, '→', pc.rows[0].marketer_name);
        } catch (e) {
          if (e.code !== '23505') throw e;
        }
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
      promo_attribution: promoAttribution,
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
// =====================================================
router.post('/push-token', authenticate, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' });
    }
    const trimmed = token.trim().slice(0, 255);
    if (!trimmed) return res.status(400).json({ error: 'token is empty' });

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

// =====================================================
// PUT /api/auth/change-password
// =====================================================
router.put('/change-password', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};

    if (!current_password || !new_password) {
      return res.status(400).json({
        error: 'current_password and new_password are required',
      });
    }
    if (typeof new_password !== 'string' || new_password.length < 6) {
      return res.status(400).json({
        error: 'New password must be at least 6 characters',
      });
    }
    if (new_password.length > 128) {
      return res.status(400).json({
        error: 'New password is too long',
      });
    }
    if (current_password === new_password) {
      return res.status(400).json({
        error: 'New password must be different from the current one',
      });
    }

    const userRes = await pool.query(
      'SELECT id, password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { password_hash } = userRes.rows[0];
    const matches = await bcrypt.compare(current_password, password_hash);
    if (!matches) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(new_password, salt);

    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.id]
    );

    console.log(`🔐 Password changed for user ${req.user.id}`);
    res.json({ success: true, message: 'Password updated' });
  } catch (err) {
    console.error('PUT /auth/change-password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;