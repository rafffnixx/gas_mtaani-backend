// 📁 backend/routes/agent.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');

// ================================================================
// DASHBOARD
// ================================================================
router.get('/dashboard', authenticate, isAgent, async (req, res) => {
  try {
    const agentId = req.user.id;

    const agentResult = await pool.query(
      'SELECT * FROM agents WHERE id = $1',
      [agentId]
    );

    const statsResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending', 'assigned'))          AS new_orders,
         COUNT(*) FILTER (WHERE status = 'accepted')                         AS active_orders,
         COUNT(*) FILTER (WHERE status IN ('delivered', 'confirmed'))        AS completed_orders,
         COUNT(*) FILTER (WHERE status IN ('delivered', 'confirmed') AND DATE(created_at) = CURRENT_DATE) AS today_deliveries,
         COALESCE(SUM(total_amount) FILTER (WHERE status IN ('delivered', 'confirmed') AND DATE(created_at) = CURRENT_DATE), 0) AS today_earnings
       FROM orders
       WHERE agent_id = $1`,
      [agentId]
    );

    res.json({
      agent: agentResult.rows[0] || {},
      stats: statsResult.rows[0] || {},
    });
  } catch (error) {
    console.error('Dashboard error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to fetch dashboard', detail: error.message });
  }
});

// ================================================================
// STATUS — approval check
// ================================================================
router.get('/status', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT business_name, is_online, rating, total_deliveries, is_approved
       FROM agents WHERE id = $1`,
      [req.user.id]
    );
    const agent = rows[0];
    if (!agent) {
      return res.status(403).json({ error: 'Agent account not approved' });
    }
    if (!agent.is_approved) {
      return res.status(403).json({ error: 'Agent account not approved' });
    }
    res.json({
      business_name: agent.business_name,
      is_online: agent.is_online ?? false,
      rating: Number(agent.rating || 0),
      total_deliveries: agent.total_deliveries || 0,
    });
  } catch (error) {
    console.error('Status error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to fetch status', detail: error.message });
  }
});

// ================================================================
// ONLINE TOGGLE
// ================================================================
router.put('/online', authenticate, isAgent, async (req, res) => {
  try {
    const { is_online } = req.body;
    const agentId = req.user.id;

    const result = await pool.query(
      'UPDATE agents SET is_online = $1 WHERE id = $2 RETURNING is_online',
      [is_online, agentId]
    );

    res.json({
      success: true,
      is_online: result.rows[0]?.is_online || false,
    });
  } catch (error) {
    console.error('Toggle online error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to update status', detail: error.message });
  }
});

// ================================================================
// INVENTORY
// ================================================================
router.get('/inventory', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ai.id,
              ai.product_id,
              ai.stock_quantity,
              ai.is_available,
              ai.min_stock_level,
              ai.max_stock_level,
              ai.reorder_quantity,
              ai.price_modifier,
              p.name        AS product_name,
              p.brand_name  AS brand_name,
              p.image_url   AS image_url,
              p.weight_kg   AS weight_kg,
              p.base_price  AS price,
              p.product_type
       FROM agent_inventory ai
       JOIN products p ON p.id = ai.product_id
       WHERE ai.agent_id = $1
       ORDER BY p.name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Inventory list error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to fetch inventory', detail: error.message });
  }
});

router.post('/inventory', authenticate, isAgent, async (req, res) => {
  try {
    const { product_id, stock, stock_quantity, is_available } = req.body;
    const qty = stock ?? stock_quantity ?? 0;

    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO agent_inventory (agent_id, product_id, stock_quantity, is_available)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, product_id)
       DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity,
                     is_available   = EXCLUDED.is_available
       RETURNING *`,
      [req.user.id, product_id, qty, !!is_available]
    );

    res.json(rows[0]);
  } catch (error) {
    console.error('Inventory add error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to add inventory', detail: error.message });
  }
});

router.put('/inventory/:id', authenticate, isAgent, async (req, res) => {
  try {
    const { stock, stock_quantity, is_available } = req.body;
    const qty = stock ?? stock_quantity;

    await pool.query(
      `UPDATE agent_inventory
       SET stock_quantity = COALESCE($1, stock_quantity),
           is_available   = COALESCE($2, is_available)
       WHERE id = $3 AND agent_id = $4`,
      [qty, is_available, req.params.id, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Inventory update error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to update inventory', detail: error.message });
  }
});

router.delete('/inventory/:id', authenticate, isAgent, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM agent_inventory WHERE id = $1 AND agent_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Inventory delete error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to delete inventory', detail: error.message });
  }
});

// ================================================================
// EARNINGS
// ================================================================
router.get('/earnings', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE DATE(created_at) = CURRENT_DATE), 0)             AS today,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)     AS this_week,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)    AS this_month,
         COALESCE(SUM(amount), 0)                                                            AS total
       FROM agent_earnings
       WHERE agent_id = $1`,
      [req.user.id]
    );

    const balances = await pool.query(
      `SELECT total_earnings, available_balance FROM agents WHERE id = $1`,
      [req.user.id]
    );

    const summary = rows[0] || {};
    const b = balances.rows[0] || {};

    res.json({
      today: Number(summary.today || 0),
      this_week: Number(summary.this_week || 0),
      this_month: Number(summary.this_month || 0),
      total: Number(b.total_earnings || summary.total || 0),
      available_balance: Number(b.available_balance || 0),
      transactions: [],
    });
  } catch (error) {
    console.error('Earnings error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to fetch earnings', detail: error.message });
  }
});

// ================================================================
// ORDERS
// ================================================================
router.get('/orders/new', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*,
              u.full_name AS customer_name,
              u.phone_number AS customer_phone,
              p.name        AS product_name,
              p.brand_name  AS brand_name,
              p.image_url   AS product_image
       FROM orders o
       LEFT JOIN users u    ON u.id = o.customer_id
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.status IN ('pending', 'assigned')
       ORDER BY o.created_at DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (error) {
    console.error('New orders error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to fetch new orders', detail: error.message });
  }
});

router.get('/orders', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*,
              u.full_name AS customer_name,
              u.phone_number AS customer_phone,
              p.name        AS product_name,
              p.brand_name  AS brand_name,
              p.image_url   AS product_image
       FROM orders o
       LEFT JOIN users u    ON u.id = o.customer_id
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.agent_id = $1
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Orders error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to fetch orders', detail: error.message });
  }
});

router.post('/orders/:id/accept', authenticate, isAgent, async (req, res) => {
  try {
    await pool.query(
      `UPDATE orders
       SET agent_id = $1, status = 'accepted'
       WHERE id = $2 AND status IN ('pending', 'assigned')`,
      [req.user.id, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Accept order error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to accept order', detail: error.message });
  }
});

router.post('/orders/:id/decline', authenticate, isAgent, async (req, res) => {
  try {
    const { reason } = req.body;
    await pool.query(
      `UPDATE orders SET status = 'declined' WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true, reason: reason || null });
  } catch (error) {
    console.error('Decline order error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to decline order', detail: error.message });
  }
});

router.post('/orders/:id/pickup', authenticate, isAgent, async (req, res) => {
  try {
    await pool.query(
      `UPDATE orders SET status = 'picked_up'
       WHERE id = $1 AND agent_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Pickup error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to mark picked up', detail: error.message });
  }
});

router.post('/orders/:id/deliver', authenticate, isAgent, async (req, res) => {
  try {
    await pool.query(
      `UPDATE orders SET status = 'delivered'
       WHERE id = $1 AND agent_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Deliver error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to mark delivered', detail: error.message });
  }
});

// ================================================================
// PAYOUT DETAILS  (M-PESA + Bank, stored on the agents row)
// ================================================================
router.get('/payout-details', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT mpesa_number, mpesa_name,
              bank_name, bank_account_name, bank_account_no, bank_branch,
              preferred_payout,
              total_earnings, available_balance
       FROM agents WHERE id = $1`,
      [req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Payout details fetch error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to fetch payout details', detail: error.message });
  }
});

router.put('/payout-details', authenticate, isAgent, async (req, res) => {
  try {
    const {
      mpesa_number,
      mpesa_name,
      bank_name,
      bank_account_name,
      bank_account_no,
      bank_branch,
      preferred_payout,
    } = req.body;

    if (preferred_payout && !['mpesa', 'bank'].includes(preferred_payout)) {
      return res.status(400).json({ error: 'preferred_payout must be mpesa or bank' });
    }
    if (preferred_payout === 'mpesa' && !mpesa_number) {
      return res.status(400).json({ error: 'mpesa_number is required when M-PESA is preferred' });
    }
    if (preferred_payout === 'bank' && (!bank_name || !bank_account_no)) {
      return res.status(400).json({ error: 'bank_name and bank_account_no are required when Bank is preferred' });
    }

    const { rows } = await pool.query(
      `UPDATE agents
       SET mpesa_number      = COALESCE($1, mpesa_number),
           mpesa_name        = COALESCE($2, mpesa_name),
           bank_name         = COALESCE($3, bank_name),
           bank_account_name = COALESCE($4, bank_account_name),
           bank_account_no   = COALESCE($5, bank_account_no),
           bank_branch       = COALESCE($6, bank_branch),
           preferred_payout  = COALESCE($7, preferred_payout),
           updated_at        = NOW()
       WHERE id = $8
       RETURNING mpesa_number, mpesa_name,
                 bank_name, bank_account_name, bank_account_no, bank_branch,
                 preferred_payout`,
      [
        mpesa_number,
        mpesa_name,
        bank_name,
        bank_account_name,
        bank_account_no,
        bank_branch,
        preferred_payout,
        req.user.id,
      ]
    );

    res.json(rows[0]);
  } catch (error) {
    console.error('Payout details update error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to update payout details', detail: error.message });
  }
});

// ================================================================
// WITHDRAWALS
// ================================================================
router.post('/withdraw', authenticate, isAgent, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { amount, method } = req.body;
    const amt = Number(amount);

    if (!amt || amt <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Lock the agent row so two withdrawals can't overspend
    const { rows } = await client.query(
      `SELECT available_balance,
              preferred_payout,
              mpesa_number, mpesa_name,
              bank_name, bank_account_name, bank_account_no
       FROM agents
       WHERE id = $1
       FOR UPDATE`,
      [req.user.id]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = rows[0];
    const chosen = method || agent.preferred_payout || 'mpesa';

    // Validate destination
    if (chosen === 'mpesa' && !agent.mpesa_number) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'No M-PESA number on file. Add your payout details first.',
        code: 'no_payout_details',
      });
    }
    if (chosen === 'bank' && (!agent.bank_name || !agent.bank_account_no)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'No bank account on file. Add your payout details first.',
        code: 'no_payout_details',
      });
    }

    // Check balance
    if (amt > Number(agent.available_balance || 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient balance. Available: KES ${Number(agent.available_balance || 0).toLocaleString()}`,
        code: 'insufficient_balance',
      });
    }

    // Snapshot the destination
    const dest = chosen === 'mpesa'
      ? { name: agent.mpesa_name, number: agent.mpesa_number, bank: null }
      : { name: agent.bank_account_name, number: agent.bank_account_no, bank: agent.bank_name };

    // Insert withdrawal
    const w = await client.query(
      `INSERT INTO withdrawals
         (agent_id, amount, method, status,
          account_name, account_number, bank_name, created_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, NOW())
       RETURNING *`,
      [req.user.id, amt, chosen, dest.name, dest.number, dest.bank]
    );

    // Hold the funds — subtract now, admin marks paid later
    await client.query(
      `UPDATE agents
       SET available_balance = available_balance - $1,
           updated_at        = NOW()
       WHERE id = $2`,
      [amt, req.user.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, withdrawal: w.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Withdraw error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to request withdrawal', detail: error.message });
  } finally {
    client.release();
  }
});

router.get('/withdrawals', authenticate, isAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM withdrawals WHERE agent_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Withdrawals error:', error.message, error.detail || '');
    res.status(500).json({ error: 'Failed to fetch withdrawals', detail: error.message });
  }
});

module.exports = router;