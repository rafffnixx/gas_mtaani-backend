// 📁 backend/src/routes/chat.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

// =====================================================
// GET /api/chat/threads
// List all threads for the current user
// =====================================================
router.get('/threads', async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.user_type;

    let where = '';
    if (userType === 'agent') {
      where = `WHERE (t.agent_id = $1) OR (t.type = 'support' AND t.customer_id = $1)`;
    } else if (userType === 'admin') {
      where = `WHERE t.type = 'support'`;
    } else {
      where = `WHERE t.customer_id = $1`;
    }

    const { rows } = await pool.query(
      `
      SELECT
        t.id,
        t.type,
        t.status,
        t.order_id,
        t.customer_id,
        t.agent_id,
        t.last_message_at,
        t.last_message_preview,
        t.created_at,
        o.order_number,
        o.status AS order_status,
        o.assigned_partner_code,

        CASE
          WHEN t.type = 'support' THEN 'Gas Mtaani Support'
          WHEN t.customer_id = $1 THEN 'Partner ' || COALESCE(o.assigned_partner_code, 'GMNBR-XXX')
          ELSE 'Customer'
        END AS display_name,

        (
          SELECT COUNT(*)::int FROM chat_messages m
          WHERE m.thread_id = t.id
            AND m.sender_id <> $1
            AND m.read_at IS NULL
        ) AS unread_count
      FROM chat_threads t
      LEFT JOIN orders o ON o.id = t.order_id
      ${where}
      ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
      LIMIT 100
      `,
      [userId]
    );

    res.json(rows);
  } catch (err) {
    console.error('GET /chat/threads error:', err);
    res.status(500).json({ error: 'Failed to load threads' });
  }
});

// =====================================================
// POST /api/chat/threads
// Create or find a thread.
//   {}                 → support thread for the current user
//   { order_id: "..." } → order thread
// =====================================================
router.post('/threads', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userId = req.user.id;
    const userType = req.user.user_type;
    const { order_id } = req.body || {};

    // ---------- SUPPORT THREAD ----------
    if (!order_id) {
      if (userType === 'admin') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Admins cannot open support threads' });
      }

      // Look for an existing support thread for this user
      const existing = await client.query(
        `SELECT * FROM chat_threads
         WHERE customer_id = $1 AND type = 'support'
         LIMIT 1`,
        [userId]
      );

      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return res.json(existing.rows[0]);
      }

      // Create a new support thread
      const { rows } = await client.query(
        `INSERT INTO chat_threads
           (type, customer_id, status, created_at, updated_at)
         VALUES ('support', $1, 'open', NOW(), NOW())
         RETURNING *`,
        [userId]
      );

      await client.query('COMMIT');
      return res.json(rows[0]);
    }

    // ---------- ORDER THREAD ----------
    const orderRes = await client.query(
      `SELECT id, customer_id, agent_id FROM orders WHERE id = $1`,
      [order_id]
    );
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderRes.rows[0];

    if (order.customer_id !== userId && order.agent_id !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your order' });
    }

    // Check for an existing thread for this order
    const existing = await client.query(
      `SELECT * FROM chat_threads WHERE order_id = $1 LIMIT 1`,
      [order_id]
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return res.json(existing.rows[0]);
    }

    const { rows } = await client.query(
      `INSERT INTO chat_threads
         (type, order_id, customer_id, agent_id, status, created_at, updated_at)
       VALUES ('order', $1, $2, $3, 'open', NOW(), NOW())
       RETURNING *`,
      [order_id, order.customer_id, order.agent_id]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /chat/threads error:', err);
    res.status(500).json({
      error: 'Failed to create thread',
      details: err.message,
    });
  } finally {
    client.release();
  }
});

// =====================================================
// GET /api/chat/threads/:id/messages
// =====================================================
router.get('/threads/:id/messages', async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.user_type;
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const before = req.query.before;

    const threadRes = await pool.query(
      `SELECT * FROM chat_threads WHERE id = $1`,
      [id]
    );
    if (threadRes.rows.length === 0) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    const thread = threadRes.rows[0];

    const isParty =
      thread.customer_id === userId || thread.agent_id === userId;
    const isAdmin = userType === 'admin';
    if (!isParty && !(isAdmin && thread.type === 'support')) {
      return res.status(403).json({ error: 'Not your thread' });
    }

    const params = [id, limit];
    let where = `WHERE m.thread_id = $1`;
    if (before) {
      params.push(before);
      where += ` AND m.created_at < $3`;
    }

    const { rows } = await pool.query(
      `
      SELECT
        m.id, m.thread_id, m.sender_id, m.sender_role,
        m.body, m.read_at, m.created_at,
        u.full_name AS sender_name
      FROM chat_messages m
      JOIN users u ON u.id = m.sender_id
      ${where}
      ORDER BY m.created_at DESC
      LIMIT $2
      `,
      params
    );

    res.json(rows.reverse());
  } catch (err) {
    console.error('GET /chat/messages error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// =====================================================
// POST /api/chat/threads/:id/messages
// =====================================================
router.post('/threads/:id/messages', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userId = req.user.id;
    const userType = req.user.user_type;
    const { id } = req.params;
    const body = (req.body?.body || '').trim();

    if (!body) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Message body is required' });
    }

    const threadRes = await client.query(
      `SELECT * FROM chat_threads WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (threadRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Thread not found' });
    }
    const thread = threadRes.rows[0];

    if (thread.status === 'closed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Thread is closed' });
    }

    const isParty = thread.customer_id === userId || thread.agent_id === userId;
    const isAdmin = userType === 'admin';
    if (!isParty && !(isAdmin && thread.type === 'support')) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your thread' });
    }

    const { rows } = await client.query(
      `
      INSERT INTO chat_messages (thread_id, sender_id, sender_role, body, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
      `,
      [id, userId, userType === 'admin' ? 'admin' : userType, body]
    );

    await client.query(
      `
      UPDATE chat_threads
      SET last_message_at = NOW(),
          last_message_preview = LEFT($1, 200),
          updated_at = NOW()
      WHERE id = $2
      `,
      [body, id]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /chat/messages error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  } finally {
    client.release();
  }
});

// =====================================================
// POST /api/chat/threads/:id/read
// =====================================================
router.post('/threads/:id/read', async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    await pool.query(
      `
      UPDATE chat_messages
      SET read_at = NOW()
      WHERE thread_id = $1
        AND sender_id <> $2
        AND read_at IS NULL
      `,
      [id, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('POST /chat/read error:', err);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

module.exports = router;