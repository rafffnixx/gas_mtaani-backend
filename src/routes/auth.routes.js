// 📁 backend/src/routes/auth.routes.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const {
  generateVerificationCode,
  sendVerificationCodeEmail,
  sendPasswordResetCodeEmail,
} = require('../services/emailService');

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
// REGISTER USER — with promo code + email verification
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
      promo_code,
      business_name,
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

    // EMAIL IS NOW REQUIRED
    if (!phone_number || !full_name || !password || !email) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: phone_number, full_name, email, password',
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    const existingUser = await client.query(
      'SELECT id FROM users WHERE phone_number = $1 OR email = $2',
      [phone_number, email.toLowerCase()]
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

    // Generate 6-digit verification code (10 min expiry)
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const result = await client.query(
      `INSERT INTO users (
          phone_number, email, full_name, password_hash, user_type,
          county, sub_county, is_verified, is_active, email_verified,
          email_verification_code, email_verification_expires_at, email_verification_attempts,
          created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $11, 0, NOW(), NOW())
       RETURNING id, phone_number, email, full_name, user_type, is_verified, is_active, email_verified, created_at`,
      [
        phone_number,
        email.toLowerCase(),
        full_name,
        password_hash,
        finalUserType,
        county || null,
        sub_county || null,
        is_verified !== undefined ? is_verified : false,
        is_active !== undefined ? is_active : true,
        code,
        expiresAt,
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
      const pcCode = String(promo_code).trim().toUpperCase();
      const pc = await client.query(
        `SELECT pc.id, pc.marketer_id, pc.code, pc.period, pc.applies_to,
                m.full_name AS marketer_name
         FROM promo_codes pc
         JOIN marketers m ON m.id = pc.marketer_id
         WHERE pc.code = $1
           AND pc.is_active = true
           AND m.is_approved = true
           AND m.is_active = true`,
        [pcCode]
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
          console.log('🎯 Promo code applied:', pcCode, '→', pc.rows[0].marketer_name);
        } catch (e) {
          if (e.code !== '23505') throw e;
        }
      }
    }

    await client.query('COMMIT');

    console.log('✅ User registered successfully (pending email verify):', newUser.phone_number);

    // Send the verification email asynchronously
    sendVerificationCodeEmail({
      to: newUser.email,
      fullName: newUser.full_name,
      code,
    }).catch((err) => console.error('Verification email failed:', err.message));

    // Return 201 but NO JWT — user must verify first
    res.status(201).json({
      success: true,
      message: 'User registered successfully. Check your email for a 6-digit verification code.',
      promo_attribution: promoAttribution,
      data: {
        user: {
          id: newUser.id,
          full_name: newUser.full_name,
          phone_number: newUser.phone_number,
          email: newUser.email,
          user_type: newUser.user_type,
          is_verified: newUser.is_verified,
          email_verified: newUser.email_verified,
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
// VERIFY EMAIL (6-digit code)
// ============================================
router.post('/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ success: false, error: 'Email and code required' });
    }

    const result = await pool.query(
      `SELECT id, full_name, email, phone_number, user_type, is_active,
              email_verified, email_verification_code,
              email_verification_expires_at, email_verification_attempts
       FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid email or code' });
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return res.json({ success: true, message: 'Email already verified. You can log in.' });
    }

    // Rate limit: max 5 attempts per code
    if (user.email_verification_attempts >= 5) {
      return res.status(429).json({
        success: false,
        error: 'Too many attempts. Request a new code.',
      });
    }

    // Check code
    if (user.email_verification_code !== String(code).trim()) {
      await pool.query(
        `UPDATE users SET email_verification_attempts = email_verification_attempts + 1 WHERE id = $1`,
        [user.id]
      );
      return res.status(400).json({ success: false, error: 'Invalid code' });
    }

    // Check expiry
    if (new Date(user.email_verification_expires_at) < new Date()) {
      return res.status(400).json({ success: false, error: 'Code expired. Request a new one.' });
    }

    // Mark verified
    await pool.query(
      `UPDATE users
       SET email_verified = true,
           email_verified_at = NOW(),
           email_verification_code = NULL,
           email_verification_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    // Issue JWT so user is immediately logged in
    const token = jwt.sign(
      { userId: user.id, userType: user.user_type },
      process.env.JWT_SECRET || 'default_secret_key',
      { expiresIn: '7d' }
    );

    await pool.query(
      'UPDATE users SET last_login = NOW() WHERE id = $1',
      [user.id]
    );

    console.log(`✅ Email verified: ${user.email}`);

    res.json({
      success: true,
      message: 'Email verified successfully',
      data: {
        token,
        user: {
          id: user.id,
          full_name: user.full_name,
          phone_number: user.phone_number,
          email: user.email,
          user_type: user.user_type,
          email_verified: true,
          is_active: user.is_active,
        },
      },
    });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ============================================
// RESEND VERIFICATION CODE
// ============================================
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });

    const result = await pool.query(
      `SELECT id, full_name, email, email_verified, email_verification_expires_at
       FROM users WHERE LOWER(email) = LOWER($1) AND is_active = true`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If this account exists, a new code has been sent.' });
    }

    const user = result.rows[0];
    if (user.email_verified) {
      return res.status(400).json({ success: false, error: 'Email already verified' });
    }

    // Rate limit: 1 resend per 60 seconds
    if (user.email_verification_expires_at &&
        new Date(user.email_verification_expires_at).getTime() - Date.now() > 9 * 60 * 1000) {
      return res.status(429).json({
        success: false,
        error: 'Please wait before requesting another code',
      });
    }

    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `UPDATE users
       SET email_verification_code = $1,
           email_verification_expires_at = $2,
           email_verification_attempts = 0,
           updated_at = NOW()
       WHERE id = $3`,
      [code, expiresAt, user.id]
    );

    sendVerificationCodeEmail({
      to: user.email,
      fullName: user.full_name,
      code,
    }).catch(err => console.error('Resend verify failed:', err.message));

    res.json({ success: true, message: 'Verification code sent.' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ success: false, error: 'Failed' });
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

    // BLOCK LOGIN IF EMAIL IS NOT VERIFIED
    if (!user.email_verified) {
      return res.status(403).json({
        success: false,
        error: 'Please verify your email first',
        needs_verification: true,
        email: user.email,
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
          email_verified: user.email_verified,
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
// FORGOT PASSWORD (Send Code)
// ============================================
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });

    const successResponse = { success: true, message: 'If this email is registered, you will receive a code.' };

    const result = await pool.query(
      `SELECT id, full_name, email, password_reset_expires_at
       FROM users WHERE LOWER(email) = LOWER($1) AND is_active = true`,
      [email]
    );

    if (result.rows.length === 0) return res.json(successResponse);

    const user = result.rows[0];

    // Rate limit: 1 per 60 seconds (using expires_at offset)
    if (user.password_reset_expires_at &&
        new Date(user.password_reset_expires_at).getTime() - Date.now() > 14 * 60 * 1000) {
      return res.json(successResponse);
    }

    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Reuse password_reset_token column for the code
    await pool.query(
      `UPDATE users
       SET password_reset_token = $1,
           password_reset_expires_at = $2,
           password_reset_used_at = NULL,
           updated_at = NOW()
       WHERE id = $3`,
      [code, expiresAt, user.id]
    );

    sendPasswordResetCodeEmail({
      to: user.email,
      fullName: user.full_name,
      code,
    }).catch(err => console.error('Reset email failed:', err.message));

    return res.json(successResponse);
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ success: false, error: 'Request failed' });
  }
});

// ============================================
// RESET PASSWORD (Submit Code + New Password)
// ============================================
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, new_password } = req.body;

    if (!email || !code || !new_password) {
      return res.status(400).json({ success: false, error: 'Email, code, and new_password required' });
    }
    if (new_password.length < 6 || new_password.length > 128) {
      return res.status(400).json({ success: false, error: 'Password must be 6-128 chars' });
    }

    const result = await pool.query(
      `SELECT id, full_name, email FROM users
       WHERE LOWER(email) = LOWER($1)
         AND password_reset_token = $2
         AND password_reset_expires_at > NOW()
         AND password_reset_used_at IS NULL
         AND is_active = true`,
      [email, String(code).trim()]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired code',
      });
    }

    const user = result.rows[0];
    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(new_password, salt);

    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           password_reset_token = NULL,
           password_reset_expires_at = NULL,
           password_reset_used_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [newHash, user.id]
    );

    console.log(`🔐 Password reset for user ${user.id} (${user.email})`);
    res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, error: 'Reset failed' });
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
              is_verified, is_active, email_verified, created_at
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