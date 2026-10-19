// 📁 backend/src/routes/customerWallet.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');
const customerWalletService = require('../services/customerWalletService');

// GET /api/customers/wallet
router.get('/', authenticate, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT wallet_balance, mpesa_number, bank_name, bank_account_no 
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = r.rows[0];
    
    res.json({
      walletBalance: Number(user.wallet_balance || 0),
      hasPayoutDetails: !!(user.mpesa_number || (user.bank_name && user.bank_account_no))
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

// GET /api/customers/wallet/ledger
router.get('/ledger', authenticate, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT wl.*, o.order_number 
       FROM customer_wallet_ledger wl
       LEFT JOIN orders o ON wl.order_id = o.id
       WHERE wl.customer_id = $1
       ORDER BY wl.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ entries: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

// POST /api/customers/wallet/withdraw
router.post('/withdraw', authenticate, async (req, res) => {
  try {
    const { amount, method } = req.body;
    const amt = Number(amount);

    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const userRes = await pool.query(
      'SELECT wallet_balance, mpesa_number, bank_name, bank_account_no, full_name FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userRes.rows[0];
    const bal = Number(user.wallet_balance || 0);

    if (amt > bal) return res.status(400).json({ error: 'Insufficient balance' });

    // Create withdrawal request
    await pool.query(
      `INSERT INTO customer_withdrawals (customer_id, amount, method, account_name, account_number)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, amt, method, user.full_name, method === 'mpesa' ? user.mpesa_number : user.bank_account_no]
    );

    // Debit wallet
    await customerWalletService.debit(req.user.id, amt, 'WITHDRAWAL');

    res.json({ success: true, message: 'Withdrawal requested' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

module.exports = router;