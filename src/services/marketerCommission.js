// backend/src/services/marketerCommission.js
//
// Call this INSIDE the transaction that sets order status to 'delivered':
//
//   const { rows: [order] } = await client.query(
//     `UPDATE orders SET status = 'delivered', updated_at = now()
//      WHERE id = $1 RETURNING *`, [orderId]
//   );
//   await processFirstOrderCommission(client, order.id, order.customer_id);
//
// Pass the SAME `client` so a rollback also rolls back the commission.

async function processFirstOrderCommission(client, orderId, customerId) {
  try {
    // 1. Is this order the customer's FIRST delivered order?
    const firstOrder = await client.query(
      `SELECT id FROM orders
       WHERE customer_id = $1 AND status = 'delivered'
       ORDER BY created_at ASC
       LIMIT 1`,
      [customerId]
    );
    if (firstOrder.rows[0]?.id !== orderId) {
      return null; // not first
    }

    // 2. Is the customer attributed to a marketer (not yet credited)?
    const reg = await client.query(
      `SELECT id, marketer_id FROM marketer_registrations
       WHERE customer_id = $1 AND first_order_id IS NULL`,
      [customerId]
    );
    if (reg.rows.length === 0) {
      return null; // not a marketer-registered customer
    }

    const { id: registrationId, marketer_id } = reg.rows[0];

    // 3. Read the marketer's commission rate
    const rate = await client.query(
      `SELECT commission_rate FROM marketers WHERE id = $1`,
      [marketer_id]
    );
    const amount = Number(rate.rows[0]?.commission_rate || 50);

    // 4. Stamp the registration + create commission + bump totals
    await client.query(
      `UPDATE marketer_registrations
       SET first_order_id = $1, first_order_at = now()
       WHERE id = $2`,
      [orderId, registrationId]
    );

    const commission = await client.query(
      `INSERT INTO marketer_commissions
         (marketer_id, registration_id, order_id, amount, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (order_id) DO NOTHING
       RETURNING *`,
      [marketer_id, registrationId, orderId, amount]
    );

    if (commission.rows.length === 0) {
      return null; // already credited (race or duplicate delivered webhook)
    }

    await client.query(
      `UPDATE marketers SET total_earned = total_earned + $1,
         updated_at = now()
       WHERE id = $2`,
      [amount, marketer_id]
    );

    return { marketer_id, amount, commission_id: commission.rows[0].id };
  } catch (err) {
    console.error('processFirstOrderCommission error:', err);
    throw err; // propagate → caller's transaction rolls back
  }
}

module.exports = { processFirstOrderCommission };