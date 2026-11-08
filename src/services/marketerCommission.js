// backend/src/services/marketerCommission.js
//
// Two commission paths:
//   1. processFirstOrderCommission  → customer's first delivered order
//   2. processFirstAgentCommission  → agent's first delivered order
//
// Call each INSIDE the delivery transaction:
//
//   await processFirstOrderCommission(client, order.id, order.customer_id);
//   await processFirstAgentCommission(client, order.id, order.agent_id);
//   await client.query('COMMIT');

async function processFirstOrderCommission(client, orderId, customerId) {
  try {
    if (!customerId) return null;

    const firstOrder = await client.query(
      `SELECT id FROM orders
       WHERE customer_id = $1 AND status = 'delivered'
       ORDER BY created_at ASC LIMIT 1`,
      [customerId]
    );
    if (firstOrder.rows[0]?.id !== orderId) return null;

    const reg = await client.query(
      `SELECT id, marketer_id FROM marketer_registrations
       WHERE user_id = $1 AND user_type = 'customer' AND first_order_id IS NULL`,
      [customerId]
    );
    if (reg.rows.length === 0) return null;

    const { id: registrationId, marketer_id } = reg.rows[0];

    const rate = await client.query(
      `SELECT commission_rate FROM marketers WHERE id = $1`,
      [marketer_id]
    );
    const amount = Number(rate.rows[0]?.commission_rate || 50);

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
    if (commission.rows.length === 0) return null;

    await client.query(
      `UPDATE marketers
       SET total_earned = total_earned + $1, updated_at = now()
       WHERE id = $2`,
      [amount, marketer_id]
    );

    console.log(
      `💰 Customer first-order commission: KES ${amount} to marketer ${marketer_id}`
    );
    return { marketer_id, amount, commission_id: commission.rows[0].id };
  } catch (err) {
    console.error('processFirstOrderCommission error:', err);
    throw err;
  }
}

async function processFirstAgentCommission(client, orderId, agentId) {
  try {
    if (!agentId) return null;

    const firstOrder = await client.query(
      `SELECT id FROM orders
       WHERE agent_id = $1 AND status = 'delivered'
       ORDER BY created_at ASC LIMIT 1`,
      [agentId]
    );
    if (firstOrder.rows[0]?.id !== orderId) return null;

    const reg = await client.query(
      `SELECT id, marketer_id FROM marketer_registrations
       WHERE user_id = $1 AND user_type = 'agent' AND first_order_id IS NULL`,
      [agentId]
    );
    if (reg.rows.length === 0) return null;

    const { id: registrationId, marketer_id } = reg.rows[0];

    const rate = await client.query(
      `SELECT commission_rate FROM marketers WHERE id = $1`,
      [marketer_id]
    );
    const amount = Number(rate.rows[0]?.commission_rate || 50);

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
    if (commission.rows.length === 0) return null;

    await client.query(
      `UPDATE marketers
       SET total_earned = total_earned + $1, updated_at = now()
       WHERE id = $2`,
      [amount, marketer_id]
    );

    console.log(
      `💰 Agent first-delivery commission: KES ${amount} to marketer ${marketer_id}`
    );
    return { marketer_id, amount, commission_id: commission.rows[0].id };
  } catch (err) {
    console.error('processFirstAgentCommission error:', err);
    throw err;
  }
}

module.exports = {
  processFirstOrderCommission,
  processFirstAgentCommission,
};