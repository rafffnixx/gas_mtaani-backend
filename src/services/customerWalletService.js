// 📁 backend/src/services/customerWalletService.js
const { pool } = require('../config/database');

/**
 * Add or deduct money from a customer's wallet safely.
 * @param {string} customerId 
 * @param {number} amount Positive to add, Negative to deduct
 * @param {string} type e.g., 'REFUND', 'ORDER_PAYMENT', 'WITHDRAWAL'
 * @param {string|null} orderId 
 */
async function record(customerId, amount, type, orderId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the customer row
    const userRes = await client.query(
      'SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE',
      [customerId]
    );
    if (userRes.rows.length === 0) throw new Error('Customer not found');

    const before = Number(userRes.rows[0].wallet_balance) || 0;
    const after = +(before + Number(amount)).toFixed(2);

    if (after < 0) throw new Error('Insufficient wallet balance');

    // Update the balance
    await client.query(
      'UPDATE users SET wallet_balance = $1, updated_at = NOW() WHERE id = $2',
      [after, customerId]
    );

    // Write to ledger
    await client.query(
      `INSERT INTO customer_wallet_ledger (customer_id, order_id, type, amount, balance_after)
       VALUES ($1, $2, $3, $4, $5)`,
      [customerId, orderId, type, amount, after]
    );

    await client.query('COMMIT');
    return { balanceAfter: after };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const credit = (customerId, amount, type, orderId = null) =>
  record(customerId, Math.abs(amount), type, orderId);

const debit = (customerId, amount, type, orderId = null) =>
  record(customerId, -Math.abs(amount), type, orderId);

module.exports = { record, credit, debit };