const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');

// =====================================================
// CREATE ORDER (Customer)
// =====================================================
router.post('/', authenticate, async (req, res) => {
    try {
        const customerId = req.user.id;
        const { 
            product_id, 
            quantity = 1, 
            delivery_address, 
            customer_latitude, 
            customer_longitude,
            special_instructions 
        } = req.body;

        // Validate required fields
        if (!product_id || !delivery_address || !customer_latitude || !customer_longitude) {
            return res.status(400).json({ 
                error: 'Missing required fields: product_id, delivery_address, customer_latitude, customer_longitude' 
            });
        }

        // Get product details
        const productResult = await pool.query(
            'SELECT * FROM products WHERE id = $1 AND is_active = true',
            [product_id]
        );
        
        if (productResult.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found or inactive' });
        }
        
        const product = productResult.rows[0];
        
        // Find nearest agent
        const agentResult = await pool.query(
            `SELECT * FROM find_nearest_agents($1, $2, $3, 5000, 1)`,
            [customer_latitude, customer_longitude, product_id]
        );
        
        if (agentResult.rows.length === 0) {
            return res.status(404).json({ 
                error: 'No available agents within your area. Please try again later.' 
            });
        }
        
        const agent = agentResult.rows[0];
        
        // Calculate delivery fee (KSH 10 per km, min 50, max 100)
        const distance = parseFloat(agent.distance_km) || 0;
        let deliveryFee = distance * 10;
        deliveryFee = Math.max(50, Math.min(100, deliveryFee));
        
        // Generate order number
        const orderNumber = `GM-${Date.now().toString().slice(-8)}`;
        
        // Calculate total
        const totalAmount = (product.base_price * quantity) + deliveryFee;
        
        // Create order
        const orderResult = await pool.query(
            `INSERT INTO orders (
                order_number, customer_id, agent_id, product_id,
                quantity, product_price, delivery_fee, total_amount,
                customer_latitude, customer_longitude, delivery_address,
                special_instructions, status, assigned_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'assigned', CURRENT_TIMESTAMP)
            RETURNING *`,
            [
                orderNumber,
                customerId,
                agent.agent_id,
                product_id,
                quantity,
                product.base_price,
                deliveryFee,
                totalAmount,
                customer_latitude,
                customer_longitude,
                delivery_address,
                special_instructions || null
            ]
        );
        
        // Update agent's current order count
        await pool.query(
            'UPDATE agents SET current_order_count = current_order_count + 1 WHERE id = $1',
            [agent.agent_id]
        );
        
        res.status(201).json({
            success: true,
            message: 'Order placed successfully',
            order: orderResult.rows[0],
            agent: {
                id: agent.agent_id,
                business_name: agent.business_name,
                distance_km: agent.distance_km,
                rating: agent.rating
            }
        });
        
    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({ error: 'Failed to create order', details: error.message });
    }
});

// =====================================================
// GET CUSTOMER ORDERS
// =====================================================
router.get('/customer', authenticate, async (req, res) => {
    try {
        const customerId = req.user.id;
        
        const result = await pool.query(
            `SELECT o.*, 
                    p.name as product_name, 
                    p.brand_name,
                    p.image_url,
                    a.business_name as agent_business,
                    u.full_name as agent_name
             FROM orders o
             JOIN products p ON o.product_id = p.id
             LEFT JOIN agents a ON o.agent_id = a.id
             LEFT JOIN users u ON a.id = u.id
             WHERE o.customer_id = $1
             ORDER BY o.created_at DESC`,
            [customerId]
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error('Customer orders error:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// =====================================================
// GET ORDER DETAILS
// =====================================================
router.get('/:orderId', authenticate, async (req, res) => {
    try {
        const { orderId } = req.params;
        const customerId = req.user.id;
        
        const result = await pool.query(
            `SELECT o.*, 
                    p.name as product_name, 
                    p.brand_name,
                    p.image_url,
                    a.business_name as agent_business,
                    u.full_name as agent_name,
                    u.phone_number as agent_phone
             FROM orders o
             JOIN products p ON o.product_id = p.id
             LEFT JOIN agents a ON o.agent_id = a.id
             LEFT JOIN users u ON a.id = u.id
             WHERE o.id = $1 AND o.customer_id = $2`,
            [orderId, customerId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Order detail error:', error);
        res.status(500).json({ error: 'Failed to fetch order details' });
    }
});

// =====================================================
// CONFIRM DELIVERY (Customer)
// =====================================================
router.put('/:orderId/confirm', authenticate, async (req, res) => {
    try {
        const customerId = req.user.id;
        const { orderId } = req.params;
        const { rating, feedback } = req.body;
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = 'confirmed', 
                 confirmed_at = CURRENT_TIMESTAMP,
                 customer_rating = $2, 
                 customer_feedback = $3,
                 payment_status = 'paid'
             WHERE id = $1 AND customer_id = $4 AND status = 'delivered'
             RETURNING *`,
            [orderId, rating || null, feedback || null, customerId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found or cannot be confirmed' });
        }
        
        const order = result.rows[0];
        
        // Update agent stats
        await pool.query(
            `UPDATE agents 
             SET current_order_count = current_order_count - 1,
                 total_deliveries = total_deliveries + 1
             WHERE id = $1`,
            [order.agent_id]
        );
        
        // Create earnings record (10% commission)
        const commission = order.total_amount * 0.10;
        const netAmount = order.total_amount - commission;
        
        await pool.query(
            `INSERT INTO agent_earnings (agent_id, order_id, amount, admin_commission, net_amount)
             VALUES ($1, $2, $3, $4, $5)`,
            [order.agent_id, orderId, order.total_amount, commission, netAmount]
        );
        
        res.json({
            success: true,
            message: 'Order confirmed successfully',
            order: result.rows[0]
        });
        
    } catch (error) {
        console.error('Confirm order error:', error);
        res.status(500).json({ error: 'Failed to confirm delivery' });
    }
});

// =====================================================
// ACCEPT ORDER (Agent)
// =====================================================
router.put('/:orderId/accept', authenticate, isAgent, async (req, res) => {
    try {
        const agentId = req.user.id;
        const { orderId } = req.params;
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND agent_id = $2 AND status = 'assigned'
             RETURNING *`,
            [orderId, agentId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found or cannot be accepted' });
        }
        
        res.json({
            success: true,
            message: 'Order accepted',
            order: result.rows[0]
        });
        
    } catch (error) {
        console.error('Accept order error:', error);
        res.status(500).json({ error: 'Failed to accept order' });
    }
});

// =====================================================
// DECLINE ORDER (Agent)
// =====================================================
router.put('/:orderId/decline', authenticate, isAgent, async (req, res) => {
    try {
        const agentId = req.user.id;
        const { orderId } = req.params;
        const { reason } = req.body;
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = 'declined', 
                 cancellation_reason = $3,
                 cancelled_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND agent_id = $2 AND status IN ('assigned', 'accepted')
             RETURNING *`,
            [orderId, agentId, reason || 'Agent declined']
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found or cannot be declined' });
        }
        
        // Decrease agent's order count
        await pool.query(
            'UPDATE agents SET current_order_count = current_order_count - 1 WHERE id = $1',
            [agentId]
        );
        
        res.json({
            success: true,
            message: 'Order declined',
            order: result.rows[0]
        });
        
    } catch (error) {
        console.error('Decline order error:', error);
        res.status(500).json({ error: 'Failed to decline order' });
    }
});

// =====================================================
// MARK AS DELIVERED (Agent)
// =====================================================
router.put('/:orderId/deliver', authenticate, isAgent, async (req, res) => {
    try {
        const agentId = req.user.id;
        const { orderId } = req.params;
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND agent_id = $2 AND status = 'accepted'
             RETURNING *`,
            [orderId, agentId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found or cannot be delivered' });
        }
        
        res.json({
            success: true,
            message: 'Order marked as delivered',
            order: result.rows[0]
        });
        
    } catch (error) {
        console.error('Deliver order error:', error);
        res.status(500).json({ error: 'Failed to mark as delivered' });
    }
});

// =====================================================
// AGENT ORDERS (Get orders for agent)
// =====================================================
router.get('/agent/orders', authenticate, isAgent, async (req, res) => {
    try {
        const agentId = req.user.id;
        const { status } = req.query;
        
        let query = `
            SELECT o.*, 
                   p.name as product_name, 
                   p.brand_name,
                   u.full_name as customer_name,
                   u.phone_number as customer_phone
            FROM orders o
            JOIN products p ON o.product_id = p.id
            JOIN users u ON o.customer_id = u.id
            WHERE o.agent_id = $1
        `;
        const params = [agentId];
        
        if (status) {
            query += ` AND o.status = $2`;
            params.push(status);
        }
        
        query += ` ORDER BY o.created_at DESC`;
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Agent orders error:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// =====================================================
// CANCEL ORDER (Customer)
// =====================================================
router.put('/:orderId/cancel', authenticate, async (req, res) => {
    try {
        const customerId = req.user.id;
        const { orderId } = req.params;
        const { reason } = req.body;
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = 'cancelled', 
                 cancelled_at = CURRENT_TIMESTAMP,
                 cancellation_reason = $3
             WHERE id = $1 AND customer_id = $2 AND status IN ('pending', 'assigned')
             RETURNING *`,
            [orderId, customerId, reason || 'Cancelled by customer']
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found or cannot be cancelled' });
        }
        
        // If agent was assigned, decrease their order count
        const order = result.rows[0];
        if (order.agent_id) {
            await pool.query(
                'UPDATE agents SET current_order_count = current_order_count - 1 WHERE id = $1',
                [order.agent_id]
            );
        }
        
        res.json({
            success: true,
            message: 'Order cancelled',
            order: result.rows[0]
        });
        
    } catch (error) {
        console.error('Cancel order error:', error);
        res.status(500).json({ error: 'Failed to cancel order' });
    }
});

module.exports = router;