// 📁 backend/src/routes/product.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware');

// =====================================================
// Config
// =====================================================
const DEFAULT_RADIUS_M = 5000;      // 5 km
const MINUTES_PER_KM   = 4;         // 1 km = 4 min
const UNDER_5_LABEL    = 'Under 5 min';

// =====================================================
// Helpers
// =====================================================
function formatEta(distanceKm) {
  const minutes = Math.max(0, Math.round(Number(distanceKm) * MINUTES_PER_KM));
  if (minutes < 5) {
    return { eta_minutes: minutes, eta_label: UNDER_5_LABEL };
  }
  return { eta_minutes: minutes, eta_label: `~${minutes} min` };
}

// =====================================================
// GET /api/products
// All active products (catalogue)
// =====================================================
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM products
       WHERE is_active = true
       ORDER BY brand_name, weight_kg`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// =====================================================
// GET /api/products/nearby?lat=&lng=&radius=
// Products available from agents within `radius` of the customer.
// MUST be declared before '/:id' so it doesn't get captured.
// =====================================================
router.get('/nearby', authenticate, async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseInt(req.query.radius, 10) || DEFAULT_RADIUS_M;

    if (
      Number.isNaN(lat) ||
      Number.isNaN(lng) ||
      lat < -90 || lat > 90 ||
      lng < -180 || lng > 180
    ) {
      return res.status(400).json({
        error: 'Valid lat and lng query parameters are required',
      });
    }

    const { rows } = await pool.query(
      `SELECT
         p.id,
         p.name,
         p.brand_name,
         p.image_url,
         p.product_type,
         p.weight_kg,
         p.description,
         p.base_price,
         (p.base_price + ai.price_modifier)              AS selling_price,
         ai.stock_quantity,
         a.id                                            AS nearest_agent_id,
         a.business_name                                 AS nearest_agent_name,
         a.rating                                        AS nearest_agent_rating,
         ROUND(
           (ST_Distance(
             a.location,
             ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
           ) / 1000)::numeric,
           2
         )                                               AS distance_km
       FROM products p
       CROSS JOIN LATERAL find_nearest_agents($1, $2, p.id, $3, 1) fna
       JOIN agents a
         ON a.id = fna.agent_id
       JOIN agent_inventory ai
         ON ai.agent_id = fna.agent_id
        AND ai.product_id = p.id
       WHERE p.is_active = true
       ORDER BY distance_km ASC, p.brand_name ASC, p.name ASC`,
      [lat, lng, radius]
    );

    // Enrich with ETA + normalised shape for the mobile app
    const products = rows.map((row) => {
      const eta = formatEta(row.distance_km);
      return {
        id: row.id,
        name: row.name,
        brand_name: row.brand_name,
        image_url: row.image_url,
        product_type: row.product_type,
        weight_kg: row.weight_kg,
        description: row.description,
        base_price: Number(row.base_price),
        display_price: Number(row.selling_price),
        available_stock: row.stock_quantity,
        distance_km: Number(row.distance_km),
        eta_minutes: eta.eta_minutes,
        eta_label: eta.eta_label,
        nearest_agent: {
          id: row.nearest_agent_id,
          business_name: row.nearest_agent_name,
          rating: row.nearest_agent_rating,
        },
      };
    });

    res.json({
      success: true,
      radius_m: radius,
      customer: { latitude: lat, longitude: lng },
      count: products.length,
      products,
    });
  } catch (error) {
    console.error('Nearby products error:', error);
    res.status(500).json({
      error: 'Failed to fetch nearby products',
      details: error.message,
    });
  }
});

// =====================================================
// GET /api/products/search/:query
// =====================================================
router.get('/search/:query', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM products
       WHERE is_active = true
       AND (name ILIKE $1 OR brand_name ILIKE $1)
       ORDER BY brand_name`,
      [`%${req.params.query}%`]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// =====================================================
// GET /api/products/:id
// MUST be after /nearby and /search
// =====================================================
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM products WHERE id = $1 AND is_active = true',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Product error:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

module.exports = router;