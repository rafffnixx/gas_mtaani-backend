// backend/src/routes/marketer.routes.js
const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const { pool }   = require('../config/database');
const marketerAuth = require('../middleware/marketerAuth.middleware');
const isAdmin      = require('../middleware/isAdmin.middleware');

// ============================================================
// PUBLIC — SIGNUP
// ============================================================
router.post('/auth/register', async (req, res) => {
  try {
    const { full_name, phone_number, email, password, mpesa_number, mpesa_name } = req.body || {};

    if (!full_name || !phone_number || !password) {
      return res.status(400).json({ error: 'full_name, phone_number and password are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const normalized = String(phone_number).replace(/[^0-9]/g, '').replace(/^0/, '254');

    const exists = await pool.query(
      `SELECT id FROM marketers WHERE phone_number = $1`, [normalized]
    );
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered' });
    }

    const hash = await bcrypt.hash(password, 10);
    const referral = `MKT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const { rows } = await pool.query(
      `INSERT INTO marketers
         (full_name, phone_number, email, password_hash, referral_code,
          mpesa_number, mpesa_name, is_approved)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false)
       RETURNING id, full_name, phone_number, referral_code, is_approved`,
      [full_name, normalized, email || null, hash, referral,
       mpesa_number || null, mpesa_name || null]
    );

    res.status(201).json({
      message: 'Signup received. Awaiting admin approval before you can log in.',
      marketer: rows[0],
    });
  } catch (err) {
    console.error('Marketer signup error:', err);
    res.status(500).json({ error: 'Signup failed', detail: err.message });
  }
});

// ============================================================
// PUBLIC — LOGIN
// ============================================================
router.post('/auth/login', async (req, res) => {
  try {
    const { phone_number, password } = req.body || {};
    if (!phone_number || !password) {
      return res.status(400).json({ error: 'phone_number and password are required' });
    }
    const normalized = String(phone_number).replace(/[^0-9]/g, '').replace(/^0/, '254');

    const { rows } = await pool.query(
      `SELECT id, full_name, phone_number, password_hash, is_active, is_approved
       FROM marketers WHERE phone_number = $1`,
      [normalized]
    );
    const m = rows[0];
    if (!m) return res.status(401).json({ error: 'Invalid credentials' });
    if (!m.is_active) return res.status(403).json({ error: 'Account deactivated' });
    if (!m.is_approved) return res.status(403).json({ error: 'Awaiting admin approval' });

    const ok = await bcrypt.compare(password, m.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: m.id, user_type: 'marketer' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({
      token,
      marketer: {
        id: m.id,
        full_name: m.full_name,
        phone_number: m.phone_number,
      },
    });
  } catch (err) {
    console.error('Marketer login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================================
// PUBLIC — Validate a promo code (mobile app calls this live)
// ============================================================
router.get('/promo-code/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ valid: false, error: 'code required' });

    const { rows } = await pool.query(
      `SELECT pc.code, pc.period, pc.applies_to,
              m.full_name AS marketer_name
       FROM promo_codes pc
       JOIN marketers m ON m.id = pc.marketer_id
       WHERE pc.code = $1
         AND pc.is_active = true
         AND m.is_approved = true
         AND m.is_active = true`,
      [code]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        valid: false,
        error: "Invalid or expired code. Ask your promoter for this month's code.",
      });
    }

    res.json({
      valid: true,
      code: rows[0].code,
      marketer_name: rows[0].marketer_name,
      period: rows[0].period,
      applies_to: rows[0].applies_to,
    });
  } catch (err) {
    console.error('Promo code lookup error:', err);
    res.status(500).json({ valid: false, error: 'Lookup failed' });
  }
});

// ============================================================
// AUTHENTICATED — PROFILE + STATS
// ============================================================
router.get('/auth/me', marketerAuth, async (req, res) => {
  try {
    const marketerId = req.user.id;

    const profile = await pool.query(
      `SELECT id, full_name, phone_number, email, referral_code,
              commission_rate, total_earned, total_withdrawn,
              mpesa_number, mpesa_name, is_approved, created_at
       FROM marketers WHERE id = $1`,
      [marketerId]
    );
    if (profile.rows.length === 0) return res.status(404).json({ error: 'Marketer not found' });

    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE true)                                  AS registrations,
         COUNT(*) FILTER (WHERE first_order_id IS NOT NULL)            AS first_orders
       FROM marketer_registrations WHERE marketer_id = $1`,
      [marketerId]
    );

    const commissions = await pool.query(
      `SELECT status, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
       FROM marketer_commissions
       WHERE marketer_id = $1 GROUP BY status`,
      [marketerId]
    );

    const withdrawals = await pool.query(
      `SELECT status, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
       FROM marketer_withdrawals
       WHERE marketer_id = $1 GROUP BY status`,
      [marketerId]
    );

    const available = await pool.query(
      `SELECT
         COALESCE((SELECT SUM(amount) FROM marketer_commissions
                   WHERE marketer_id = $1 AND status = 'approved'), 0)
         -
         COALESCE((SELECT SUM(amount) FROM marketer_withdrawals
                   WHERE marketer_id = $1
                     AND status IN ('pending','processing','paid')), 0)
         AS available`,
      [marketerId]
    );

    // ── Current month's active promo code ──
    const currentPromo = await pool.query(
      `SELECT code, period FROM promo_codes
       WHERE marketer_id = $1 AND is_active = true
       ORDER BY created_at DESC LIMIT 1`,
      [marketerId]
    );

    res.json({
      ...profile.rows[0],
      current_promo_code: currentPromo.rows[0]?.code || null,
      current_promo_period: currentPromo.rows[0]?.period || null,
      stats: {
        registrations: Number(counts.rows[0].registrations),
        first_orders:  Number(counts.rows[0].first_orders),
        commissions_by_status: commissions.rows,
        withdrawals_by_status: withdrawals.rows,
        available_balance: Number(available.rows[0].available),
      },
    });
  } catch (err) {
    console.error('Marketer me error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ============================================================
// REGISTRATIONS — read-only list of people attributed via code
// ============================================================
router.get('/registrations', marketerAuth, async (req, res) => {
  try {
    const marketerId = req.user.id;
    const { rows } = await pool.query(
      `SELECT r.id,
              r.registered_at,
              r.user_type,
              r.first_order_id,
              r.first_order_at,
              u.id            AS user_id,
              u.full_name     AS user_name,
              u.phone_number  AS user_phone,
              (r.first_order_id IS NOT NULL) AS has_first_order,
              c.amount AS commission_amount,
              c.status AS commission_status
       FROM marketer_registrations r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN marketer_commissions c ON c.registration_id = r.id
       WHERE r.marketer_id = $1
       ORDER BY r.registered_at DESC`,
      [marketerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('List registrations error:', err);
    res.status(500).json({ error: 'Failed to list registrations' });
  }
});

// ============================================================
// COMMISSIONS
// ============================================================
router.get('/commissions', marketerAuth, async (req, res) => {
  try {
    const marketerId = req.user.id;
    const { status } = req.query;
    const params = [marketerId];
    let where = `WHERE c.marketer_id = $1`;
    if (status) {
      params.push(status);
      where += ` AND c.status = $2`;
    }
    const { rows } = await pool.query(
      `SELECT c.id, c.order_id, c.amount, c.status,
              c.created_at, c.approved_at, c.paid_at,
              u.full_name AS user_name,
              r.user_type
       FROM marketer_commissions c
       JOIN marketer_registrations r ON r.id = c.registration_id
       JOIN users u ON u.id = r.user_id
       ${where}
       ORDER BY c.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('List commissions error:', err);
    res.status(500).json({ error: 'Failed to list commissions' });
  }
});

// ============================================================
// WITHDRAWALS
// ============================================================
router.get('/withdrawals', marketerAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, amount, status, mpesa_number, mpesa_name,
              requested_at, processed_at, paid_at, admin_notes
       FROM marketer_withdrawals
       WHERE marketer_id = $1
       ORDER BY requested_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('List withdrawals error:', err);
    res.status(500).json({ error: 'Failed to list withdrawals' });
  }
});

router.post('/withdrawals', marketerAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const marketerId = req.user.id;
    const { amount, mpesa_number, mpesa_name } = req.body || {};

    const amt = Number(amount);
    if (!amt || amt < 500) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Minimum withdrawal is KES 500' });
    }

    const mpesaRow = await client.query(
      `SELECT mpesa_number, mpesa_name FROM marketers WHERE id = $1`,
      [marketerId]
    );
    const finalMpesa = mpesa_number || mpesaRow.rows[0]?.mpesa_number;
    if (!finalMpesa) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'M-Pesa number is required' });
    }

    const bal = await client.query(
      `SELECT
         COALESCE((SELECT SUM(amount) FROM marketer_commissions
                   WHERE marketer_id = $1 AND status = 'approved'), 0)
         -
         COALESCE((SELECT SUM(amount) FROM marketer_withdrawals
                   WHERE marketer_id = $1
                     AND status IN ('pending','processing','paid')), 0)
         AS available`,
      [marketerId]
    );
    const available = Number(bal.rows[0].available);
    if (amt > available) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient balance. Available: KES ${available.toFixed(2)}`,
      });
    }

    const ins = await client.query(
      `INSERT INTO marketer_withdrawals
         (marketer_id, amount, mpesa_number, mpesa_name, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [marketerId, amt, finalMpesa, mpesa_name || mpesaRow.rows[0]?.mpesa_name || null]
    );

    await client.query('COMMIT');
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create withdrawal error:', err);
    res.status(500).json({ error: 'Withdrawal failed' });
  } finally {
    client.release();
  }
});

// ============================================================
// ADMIN — MARKETER MANAGEMENT
// ============================================================
router.get('/admin/list', isAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.full_name, m.phone_number, m.email, m.referral_code,
              m.is_active, m.is_approved, m.commission_rate,
              m.total_earned, m.total_withdrawn, m.created_at,
              (SELECT COUNT(*) FROM marketer_registrations WHERE marketer_id = m.id) AS registrations
       FROM marketers m
       ORDER BY m.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin list marketers error:', err);
    res.status(500).json({ error: 'Failed to list marketers' });
  }
});

router.put('/admin/:id/approve', isAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE marketers SET is_approved = true, is_active = true, updated_at = now()
       WHERE id = $1 RETURNING id, full_name, is_approved`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Marketer not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Approve marketer error:', err);
    res.status(500).json({ error: 'Approve failed' });
  }
});

router.put('/admin/:id/reject', isAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE marketers SET is_active = false, updated_at = now()
       WHERE id = $1 RETURNING id, full_name, is_active`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Marketer not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Reject marketer error:', err);
    res.status(500).json({ error: 'Reject failed' });
  }
});

router.put('/admin/:id/commission-rate', isAdmin, async (req, res) => {
  try {
    const rate = Number(req.body?.commission_rate);
    if (!Number.isFinite(rate) || rate < 0) {
      return res.status(400).json({ error: 'Invalid commission_rate' });
    }
    const { rows } = await pool.query(
      `UPDATE marketers SET commission_rate = $1, updated_at = now()
       WHERE id = $2 RETURNING id, commission_rate`,
      [rate, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Marketer not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Update rate error:', err);
    res.status(500).json({ error: 'Rate update failed' });
  }
});

// ============================================================
// ADMIN — PROMO CODES
// ============================================================
router.get('/admin/promo-codes', isAdmin, async (req, res) => {
  try {
    const { period } = req.query;
    const params = [];
    let where = '';
    if (period) {
      params.push(period);
      where = 'WHERE pc.period = $1';
    }
    const { rows } = await pool.query(
      `SELECT pc.id, pc.code, pc.period, pc.applies_to, pc.is_active,
              pc.created_at, pc.deactivated_at,
              m.id AS marketer_id, m.full_name, m.phone_number
       FROM promo_codes pc
       JOIN marketers m ON m.id = pc.marketer_id
       ${where}
       ORDER BY pc.created_at DESC, m.full_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('List promo codes error:', err);
    res.status(500).json({ error: 'Failed to list promo codes' });
  }
});

router.post('/admin/promo-codes/rotate', isAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const period = String(req.body?.period || new Date().toISOString().slice(0, 7)); // YYYY-MM
    const monthAbbr = new Date(period + '-01')
      .toLocaleString('en', { month: 'short' })
      .toUpperCase();
    const yearShort = period.slice(2, 4);
    const prefix = `${monthAbbr}${yearShort}`;

    // Deactivate all currently active codes
    await client.query(
      `UPDATE promo_codes
       SET is_active = false, deactivated_at = now()
       WHERE is_active = true`
    );

    // Generate for every approved, active marketer
    const marketers = await client.query(
      `SELECT id, referral_code FROM marketers
       WHERE is_approved = true AND is_active = true`
    );

    const created = [];
    for (const m of marketers.rows) {
      const code = `${prefix}-${m.referral_code}`.toUpperCase();
      const ins = await client.query(
        `INSERT INTO promo_codes (marketer_id, code, period, applies_to, is_active)
         VALUES ($1, $2, $3, 'both', true)
         ON CONFLICT (marketer_id, period) DO UPDATE SET
           code = EXCLUDED.code,
           is_active = true,
           deactivated_at = NULL
         RETURNING code, period`,
        [m.id, code, period]
      );
      created.push(ins.rows[0]);
    }

    await client.query('COMMIT');
    res.json({ period, count: created.length, codes: created });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Rotate promo codes error:', err);
    res.status(500).json({ error: 'Rotation failed', detail: err.message });
  } finally {
    client.release();
  }
});

// ============================================================
// ADMIN — COMMISSIONS
// ============================================================
router.get('/admin/commissions', isAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE c.status = $1`;
    }
    const { rows } = await pool.query(
      `SELECT c.id, c.amount, c.status, c.created_at, c.approved_at,
              m.full_name AS marketer_name, m.phone_number AS marketer_phone,
              u.full_name AS user_name, r.user_type, c.order_id
       FROM marketer_commissions c
       JOIN marketers m ON m.id = c.marketer_id
       JOIN marketer_registrations r ON r.id = c.registration_id
       JOIN users u ON u.id = r.user_id
       ${where}
       ORDER BY c.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin list commissions error:', err);
    res.status(500).json({ error: 'Failed to list commissions' });
  }
});

router.put('/admin/commissions/:id/approve', isAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE marketer_commissions
       SET status = 'approved', approved_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Commission not found or already approved' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Approve commission error:', err);
    res.status(500).json({ error: 'Approve failed' });
  }
});

// ============================================================
// ADMIN — WITHDRAWALS
// ============================================================
router.get('/admin/withdrawals', isAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE w.status = $1`;
    }
    const { rows } = await pool.query(
      `SELECT w.*, m.full_name AS marketer_name, m.phone_number AS marketer_phone
       FROM marketer_withdrawals w
       JOIN marketers m ON m.id = w.marketer_id
       ${where}
       ORDER BY w.requested_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin list withdrawals error:', err);
    res.status(500).json({ error: 'Failed to list withdrawals' });
  }
});

router.put('/admin/withdrawals/:id/process', isAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { status, admin_notes } = req.body || {};
    if (!['processing', 'paid', 'rejected'].includes(status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid status' });
    }

    const w = await client.query(
      `SELECT * FROM marketer_withdrawals WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (w.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Withdrawal not found' });
    }
    const row = w.rows[0];
    if (row.status === 'paid' || row.status === 'rejected') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Withdrawal already finalized' });
    }

    if (status === 'paid') {
      await client.query(
        `UPDATE marketers SET total_withdrawn = total_withdrawn + $1,
           updated_at = now()
         WHERE id = $2`,
        [row.amount, row.marketer_id]
      );
      const result = await client.query(
        `UPDATE marketer_withdrawals
         SET status = 'paid', admin_notes = $1, processed_at = now(), paid_at = now()
         WHERE id = $2 RETURNING *`,
        [admin_notes || null, req.params.id]
      );
      await client.query('COMMIT');
      return res.json(result.rows[0]);
    }

    const result = await client.query(
      `UPDATE marketer_withdrawals
       SET status = $1, admin_notes = $2, processed_at = now()
       WHERE id = $3 RETURNING *`,
      [status, admin_notes || null, req.params.id]
    );
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Process withdrawal error:', err);
    res.status(500).json({ error: 'Process failed' });
  } finally {
    client.release();
  }
});

module.exports = router;