// 📁 backend/src/routes/customer.routes.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

// Business WhatsApp number — change here, used by mobile via /request-pin
const BUSINESS_WHATSAPP = process.env.BUSINESS_WHATSAPP || '2547115016167';

// How long a pending pin stays alive before it's auto-purged
const PENDING_PIN_TTL_MINUTES = 30;

// =====================================================
// GET /api/customers/addresses
// Also purges expired whatsapp_pending rows (older than TTL).
// =====================================================
router.get('/addresses', async (req, res) => {
  try {
    const userId = req.user.id;

    // Clean up stale pending pins for this user
    await pool.query(
      `DELETE FROM customer_addresses
       WHERE user_id = $1
         AND location_source = 'whatsapp_pending'
         AND created_at < NOW() - ($2 || ' minutes')::interval`,
      [userId, String(PENDING_PIN_TTL_MINUTES)]
    );

    const { rows } = await pool.query(
      `SELECT id, label, address, latitude, longitude, location_source,
              county_code, constituency_code, ward_code, area_name, landmark,
              instructions, is_default, created_at
       FROM customer_addresses
       WHERE user_id = $1
       ORDER BY
         CASE location_source
           WHEN 'whatsapp_pending' THEN 0
           WHEN 'whatsapp'         THEN 1
           WHEN 'gps'              THEN 2
           ELSE 3
         END,
         is_default DESC,
         created_at DESC`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /customers/addresses error:', err);
    res.status(500).json({ error: 'Failed to load addresses' });
  }
});

// =====================================================
// POST /api/customers/addresses/request-pin
// Creates a whatsapp_pending row (or reuses an existing one)
// and returns the WhatsApp deep-link the mobile app should open.
// =====================================================
router.post('/addresses/request-pin', async (req, res) => {
  try {
    const userId = req.user.id;

    // Reuse any recent pending pin for this user
    const existing = await pool.query(
      `SELECT id FROM customer_addresses
       WHERE user_id = $1
         AND location_source = 'whatsapp_pending'
         AND created_at > NOW() - ($2 || ' minutes')::interval
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, String(PENDING_PIN_TTL_MINUTES)]
    );

    let pinId;
    if (existing.rows.length > 0) {
      pinId = existing.rows[0].id;
    } else {
      pinId = `pin-${crypto.randomUUID()}`;
      await pool.query(
        `INSERT INTO customer_addresses
           (id, user_id, label, address, location_source, is_default)
         VALUES ($1, $2, $3, $4, $5, false)`,
        [pinId, userId, 'WhatsApp Pin', 'Awaiting pin…', 'whatsapp_pending']
      );
    }

    // Look up the customer's name for the WhatsApp template
    const u = await pool.query(
      `SELECT full_name, phone_number FROM users WHERE id = $1`,
      [userId]
    );
    const customer = u.rows[0] || {};

    const message =
      `Hi Gas Mtaani, I want to place an order and share my delivery pin.\n\n` +
      `Name: ${customer.full_name || ''}\n` +
      `Phone: ${customer.phone_number || ''}\n` +
      `Pin ref: ${pinId}\n\n` +
      `Please tap the attachment 📎 → Location → Send your current location.`;

    const waUrl = `https://wa.me/${BUSINESS_WHATSAPP}?text=${encodeURIComponent(message)}`;

    res.json({ pin_id: pinId, wa_url: waUrl });
  } catch (err) {
    console.error('POST /customers/addresses/request-pin error:', err);
    res.status(500).json({ error: 'Failed to start pin request' });
  }
});

// =====================================================
// POST /api/customers/addresses  (create or update — unchanged)
// =====================================================
router.post('/addresses', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.id;
    const {
      id, label, address, latitude, longitude, location_source,
      county_code, constituency_code, ward_code, area_name, landmark,
      instructions, is_default,
    } = req.body;

    if (!address || !String(address).trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'address is required' });
    }

    if (is_default) {
      await client.query(
        `UPDATE customer_addresses SET is_default = false WHERE user_id = $1`,
        [userId]
      );
    }

    const finalId = id || `addr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { rows } = await client.query(
      `INSERT INTO customer_addresses
         (id, user_id, label, address, latitude, longitude, location_source,
          county_code, constituency_code, ward_code, area_name, landmark,
          instructions, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         label              = EXCLUDED.label,
         address            = EXCLUDED.address,
         latitude           = EXCLUDED.latitude,
         longitude          = EXCLUDED.longitude,
         location_source    = EXCLUDED.location_source,
         county_code        = EXCLUDED.county_code,
         constituency_code  = EXCLUDED.constituency_code,
         ward_code          = EXCLUDED.ward_code,
         area_name          = EXCLUDED.area_name,
         landmark           = EXCLUDED.landmark,
         instructions       = EXCLUDED.instructions,
         is_default         = EXCLUDED.is_default,
         updated_at         = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        finalId, userId, label || 'Address', address,
        latitude ?? null, longitude ?? null, location_source ?? null,
        county_code ?? null, constituency_code ?? null, ward_code ?? null,
        area_name ?? null, landmark ?? null, instructions ?? null,
        !!is_default,
      ]
    );

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /customers/addresses error:', err);
    res.status(500).json({ error: 'Failed to save address' });
  } finally {
    client.release();
  }
});

// =====================================================
// PUT /api/customers/addresses/:id/default  (unchanged)
// =====================================================
router.put('/addresses/:id/default', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.id;
    const { id } = req.params;

    await client.query(
      `UPDATE customer_addresses SET is_default = false WHERE user_id = $1`,
      [userId]
    );
    const { rows } = await client.query(
      `UPDATE customer_addresses
       SET is_default = true, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Address not found' });
    }
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /customers/addresses/:id/default error:', err);
    res.status(500).json({ error: 'Failed to set default' });
  } finally {
    client.release();
  }
});

// =====================================================
// DELETE /api/customers/addresses/:id  (unchanged)
// =====================================================
router.delete('/addresses/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM customer_addresses WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Address not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /customers/addresses error:', err);
    res.status(500).json({ error: 'Failed to delete address' });
  }
});

module.exports = router;