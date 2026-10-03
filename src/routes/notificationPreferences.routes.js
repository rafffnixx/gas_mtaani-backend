// 📁 backend/src/routes/notificationPreferences.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');

const ALLOWED_KEYS = [
  'new_orders',
  'order_updates',
  'chat_messages',
  'payments',
  'promotions',
  'sound',
  'vibration',
];

const DEFAULTS = {
  new_orders: true,
  order_updates: true,
  chat_messages: true,
  payments: true,
  promotions: false,
  sound: true,
  vibration: true,
};

// =====================================================
// GET /api/users/notification-preferences
// Returns the current user's notification preferences.
// Creates a default row on first call if none exists.
// =====================================================
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const existing = await pool.query(
      'SELECT * FROM notification_preferences WHERE user_id = $1',
      [userId]
    );

    if (existing.rows.length > 0) {
      return res.json(existing.rows[0]);
    }

    // Create defaults on first access
    const inserted = await pool.query(
      `INSERT INTO notification_preferences (user_id)
       VALUES ($1)
       RETURNING *`,
      [userId]
    );

    res.json(inserted.rows[0]);
  } catch (err) {
    console.error('GET notification-preferences error:', err);
    res.status(500).json({ error: 'Failed to load preferences' });
  }
});

// =====================================================
// PUT /api/users/notification-preferences
// Body: { new_orders?: bool, ... }
// Partial update — only the keys sent are changed.
// =====================================================
router.put('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const body = req.body || {};

    // Filter to allowed keys only
    const updates = {};
    for (const key of ALLOWED_KEYS) {
      if (typeof body[key] === 'boolean') {
        updates[key] = body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Ensure a row exists
    await pool.query(
      `INSERT INTO notification_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    // Build dynamic SET clause
    const setClauses = Object.keys(updates).map(
      (key, i) => `${key} = $${i + 1}`
    );
    const values = Object.values(updates);
    values.push(userId);

    const result = await pool.query(
      `UPDATE notification_preferences
       SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE user_id = $${values.length}
       RETURNING *`,
      values
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT notification-preferences error:', err);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

module.exports = router;