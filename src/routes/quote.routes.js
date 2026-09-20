// 📁 backend/src/routes/quote.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');
const {
  latLngToHex,
  hexesUpToRing,
  approximateRadiusKm,
  extendedFeeForRing,
} = require('../utils/hexGrid');

const MAX_RING = 4;               // search up to ring 4 (~8 km)
const QUOTE_TTL_SECONDS = 120;    // 2 minutes

// =====================================================
// POST /api/orders/quote
// Body: { lat, lng, items: [{ product_id, quantity }] }
// =====================================================
router.post('/quote', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const { lat, lng, items } = req.body;

    if (!lat || !lng || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'lat, lng and items[] are required',
      });
    }

    const customerId = req.user.id;
    const productIds = items.map((i) => i.product_id);
    const productCount = items.length;

    // Resolve product prices once
    const { rows: products } = await client.query(
      `SELECT id, name, brand_name, base_price, image_url
       FROM products
       WHERE id = ANY($1::uuid[]) AND is_active = true`,
      [productIds]
    );
    if (products.length !== productIds.length) {
      return res.status(404).json({ error: 'One or more products not found' });
    }
    const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

    // Walk the rings from 1 to MAX_RING, find the first ring that has
    // at least one online, approved, in-stock agent covering ALL items.
    const customerHex = latLngToHex(Number(lat), Number(lng));

    let chosen = null;
    let chosenRing = null;

    for (let ring = 1; ring <= MAX_RING; ring++) {
      const hexes = hexesUpToRing(customerHex, ring);

      // Candidate agents in this ring who have ALL requested products in stock
      const { rows: candidates } = await client.query(
        `
        SELECT
          a.id                AS agent_id,
          a.partner_code,
          a.rating,
          a.current_order_count,
          a.max_order_capacity,
          a.location,
          COUNT(DISTINCT ai.product_id) AS items_covered
        FROM agents a
        JOIN agent_inventory ai ON ai.agent_id = a.id
        WHERE a.hex_id = ANY($1::bigint[])
          AND a.is_online = true
          AND a.is_approved = true
          AND a.current_order_count < a.max_order_capacity
          AND ai.product_id = ANY($2::uuid[])
          AND ai.is_available = true
          AND ai.stock_quantity > 0
        GROUP BY a.id, a.partner_code, a.rating, a.current_order_count,
                 a.max_order_capacity, a.location
        HAVING COUNT(DISTINCT ai.product_id) = $3
        ORDER BY a.current_order_count ASC, a.rating DESC NULLS LAST
        LIMIT 1
        `,
        [hexes, productIds, productCount]
      );

      if (candidates.length > 0) {
        chosen = candidates[0];
        chosenRing = ring;
        break;
      }
    }

    if (!chosen) {
      return res.status(404).json({
        error: 'No partner available in your area right now',
        max_radius_km: approximateRadiusKm(MAX_RING),
      });
    }

    // Compute distance in km (real meters, not hex-based)
    const { rows: distRows } = await client.query(
      `SELECT ROUND((ST_Distance(location,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
      ) / 1000)::numeric, 2) AS distance_km
      FROM agents WHERE id = $3`,
      [Number(lng), Number(lat), chosen.agent_id]
    );
    const distanceKm = Number(distRows[0]?.distance_km) || 0;
    const etaMinutes = Math.max(1, Math.round(distanceKm * 4));

    // Fetch the priced items from this agent's inventory
    const { rows: pricedRows } = await client.query(
      `SELECT
         p.id, p.name, p.brand_name, p.base_price,
         (p.base_price + ai.price_modifier)::numeric(10,2) AS unit_price,
         ai.stock_quantity
       FROM products p
       JOIN agent_inventory ai
         ON ai.product_id = p.id AND ai.agent_id = $1
       WHERE p.id = ANY($2::uuid[])`,
      [chosen.agent_id, productIds]
    );
    const pricedMap = Object.fromEntries(pricedRows.map((r) => [r.id, r]));

    let itemsTotal = 0;
    const pricedItems = items.map((reqItem) => {
      const p = pricedMap[reqItem.product_id];
      const qty = Number(reqItem.quantity) || 1;
      const unitPrice = Number(p.unit_price);
      const lineTotal = unitPrice * qty;
      itemsTotal += lineTotal;
      return {
        product_id: p.id,
        name: p.name,
        brand_name: p.brand_name,
        quantity: qty,
        unit_price: unitPrice,
        line_total: lineTotal,
      };
    });

    const extendedFee = extendedFeeForRing(chosenRing);
    const grandTotal = itemsTotal + extendedFee;
    const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000);

    // Persist quote
    const { rows: qrows } = await client.query(
      `INSERT INTO order_quotes
        (customer_id, agent_id, items, items_total, extended_fee,
         grand_total, distance_km, hex_ring, expires_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        customerId,
        chosen.agent_id,
        JSON.stringify(pricedItems),
        itemsTotal,
        extendedFee,
        grandTotal,
        distanceKm,
        chosenRing,
        expiresAt,
      ]
    );

    // Customer-facing response — NO agent details
    return res.json({
      quote_id: qrows[0].id,
      expires_at: expiresAt.toISOString(),
      items: pricedItems,
      items_total: itemsTotal,
      extended_fee: extendedFee,
      extended_applies: extendedFee > 0,
      grand_total: grandTotal,
      eta_minutes: etaMinutes,
      distance_km: distanceKm,
      delivery_label: extendedFee > 0
        ? `Delivery to your area adds KES ${extendedFee} and may take longer`
        : 'Free delivery',
      // Partner code is returned for the ORDER, not for display
      // The app should NOT show this to the customer.
      _internal_partner_code: chosen.partner_code,
    });
  } catch (err) {
    console.error('POST /orders/quote error:', err);
    res.status(500).json({
      error: 'Failed to generate quote',
      details: err.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;