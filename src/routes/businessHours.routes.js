// 📁 backend/src/routes/businessHours.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DEFAULT_HOURS = {
  mon: { open: '08:00', close: '20:00', closed: false },
  tue: { open: '08:00', close: '20:00', closed: false },
  wed: { open: '08:00', close: '20:00', closed: false },
  thu: { open: '08:00', close: '20:00', closed: false },
  fri: { open: '08:00', close: '20:00', closed: false },
  sat: { open: '08:00', close: '20:00', closed: false },
  sun: { open: '08:00', close: '20:00', closed: true },
};

// Basic HH:MM validation
function isValidTime(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

function sanitizeHours(input) {
  const out = {};
  for (const day of DAYS) {
    const v = input?.[day] || {};
    out[day] = {
      open: isValidTime(v.open) ? v.open : '08:00',
      close: isValidTime(v.close) ? v.close : '20:00',
      closed: !!v.closed,
    };
  }
  return out;
}

// =====================================================
// GET /api/agents/business-hours
// Creates a default row on first access.
// =====================================================
router.get('/', authenticate, isAgent, async (req, res) => {
  try {
    const agentId = req.user.id;

    const existing = await pool.query(
      'SELECT * FROM agent_business_hours WHERE agent_id = $1',
      [agentId]
    );

    if (existing.rows.length > 0) {
      return res.json(existing.rows[0]);
    }

    const inserted = await pool.query(
      `INSERT INTO agent_business_hours (agent_id, is_always_open, hours)
       VALUES ($1, true, $2::jsonb)
       RETURNING *`,
      [agentId, JSON.stringify(DEFAULT_HOURS)]
    );

    res.json(inserted.rows[0]);
  } catch (err) {
    console.error('GET business-hours error:', err);
    res.status(500).json({ error: 'Failed to load business hours' });
  }
});

// =====================================================
// PUT /api/agents/business-hours
// Body: { is_always_open, hours: { mon: {open, close, closed}, ... } }
// =====================================================
router.put('/', authenticate, isAgent, async (req, res) => {
  try {
    const agentId = req.user.id;
    const { is_always_open, hours } = req.body || {};

    if (hours && typeof hours !== 'object') {
      return res.status(400).json({ error: 'hours must be an object' });
    }

    const sanitized = hours ? sanitizeHours(hours) : null;

    // Ensure row exists
    await pool.query(
      `INSERT INTO agent_business_hours (agent_id)
       VALUES ($1)
       ON CONFLICT (agent_id) DO NOTHING`,
      [agentId]
    );

    const setClauses = [];
    const values = [];

    if (typeof is_always_open === 'boolean') {
      values.push(is_always_open);
      setClauses.push(`is_always_open = $${values.length}`);
    }

    if (sanitized) {
      values.push(JSON.stringify(sanitized));
      setClauses.push(`hours = $${values.length}::jsonb`);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(agentId);
    const result = await pool.query(
      `UPDATE agent_business_hours
       SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE agent_id = $${values.length}
       RETURNING *`,
      values
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT business-hours error:', err);
    res.status(500).json({ error: 'Failed to save business hours' });
  }
});

module.exports = router;