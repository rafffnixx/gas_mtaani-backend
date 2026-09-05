const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// Generate order number (e.g., GM-2024-001)
const generateOrderNumber = async () => {
    const result = await pool.query(
        "SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURRENT_DATE"
    );
    const count = parseInt(result.rows[0].count) + 1;
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `GM-${date}-${String(count).padStart(4, '0')}`;
};

// The Auto-Assignment Algorithm
const findBestAgent = async (customerLat, customerLng, productId, requestedQuantity = 1) => {
    console.log('🔍 Finding best agent for order...');
    console.log(`📍 Customer location: ${customerLat}, ${customerLng}`);
    
    // Query to find the best agent using PostGIS
    const query = `
        WITH available_agents AS (
            SELECT 
                a.id,
                a.business_name,
                a.current_order_count,
                a.max_order_capacity,
                a.rating,
                ST_Distance(a.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) as distance_meters
            FROM agents a
            JOIN agent_inventory ai ON a.id = ai.agent_id
            WHERE 
                a.is_online = true
                AND a.is_approved = true
                AND a.is_active = true
                AND a.current_order_count < a.max_order_capacity
                AND ai.product_id = $3
                AND ai.is_available = true
                AND ai.stock_quantity >= $4
                AND ST_DWithin(
                    a.location,
                    ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
                    a.service_radius
                )
        )
        SELECT 
            id,
            business_name,
            current_order_count,
            max_order_capacity,
            rating,
            distance_meters,
            ROUND(distance_meters / 1000, 1) as distance_km
        FROM available_agents
        ORDER BY 
            current_order_count ASC,  -- Load balancing: agents with least orders first
            distance_meters ASC       -- Then nearest
        LIMIT 1
    `;
    
    const result = await pool.query(query, [
        customerLat,
        customerLng,
        productId,
        requestedQuantity
    ]);
    
    if (result.rows.length === 0) {
        console.log('❌ No available agents found');
        return null;
    }
    
    console.log('✅ Best agent found:', result.rows[0]);
    return result.rows[0];
};

// Create new order
const createOrder = async (req, res) => {
    try {
        const {
            productId,
            quantity = 1,
            deliveryAddress,
            customerLatitude,
            customerLongitude,
            specialInstructions
        } = req.body;
        
        const customerId = req.user.id;
        
        // Validate product exists and is active
        const productResult = await pool.query(
            'SELECT * FROM products WHERE id = $1 AND is_active = true',
            [productId]
        );
        
        if (productResult.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found or inactive' });
        }
        
        const product = productResult.rows[0];
        
        // Find best agent
        const bestAgent = await findBestAgent(
            customerLatitude,
            customerLongitude,
            productId,
            quantity
        );
        
        if (!bestAgent) {
            return res.status(404).json({ 
                error: 'No available agents within your area. Please try again later.' 
            });
        }
        
        // Calculate delivery fee (e.g., KSH 10 per km, min KSH 50, max KSH 100)
        let deliveryFee = bestAgent.distance_km * 10;
        deliveryFee = Math.max(50, Math.min(100, deliveryFee)); // Clamp between 50-100
        
        const totalAmount = (product.base_price * quantity) + deliveryFee;
        
        // Generate order number
        const orderNumber = await generateOrderNumber();
        
        // Create the order
        const orderId = uuidv4();
        const orderResult = await pool.query(
            `INSERT INTO orders (
                id, order_number, customer_id, agent_id, product_id,
                quantity, product_price, delivery_fee, total_amount,
                customer_latitude, customer_longitude, delivery_address,
                status, assigned_at, special_instructions
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING *`,
            [
                orderId,
                orderNumber,
                customerId,
                bestAgent.id,
                productId,
                quantity,
                product.base_price,
                deliveryFee,
                totalAmount,
                customerLatitude,
                customerLongitude,
                deliveryAddress,
                'assigned',
                new Date(),
                specialInstructions || null
            ]
        );
        
        // Update agent's current order count
        await pool.query(
            'UPDATE agents SET current_order_count = current_order_count + 1 WHERE id = $1',
            [bestAgent.id]
        );
        
        // Get the full order details
        const fullOrder = await pool.query(
            `SELECT o.*, p.name as product_name, p.brand_name, 
             a.business_name, a.phone_number
             FROM orders o
             JOIN products p ON o.product_id = p.id
             JOIN users a ON o.agent_id = a.id
             WHERE o.id = $1`,
            [orderId]
        );
        
        // Emit real-time notification to the assigned agent
        const io = req.app.get('io');
        io.to(`agent_${bestAgent.id}`).emit('new_order', fullOrder.rows[0]);
        
        res.status(201).json({
            success: true,
            order: fullOrder.rows[0],
            message: `Order placed successfully! Assigned to ${bestAgent.business_name}`
        });
        
    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
};

// Accept order (Agent)
const acceptOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        const agentId = req.user.id;
        
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
        
        // Get customer details for notification
        const customer = await pool.query(
            'SELECT id FROM users WHERE id = (SELECT customer_id FROM orders WHERE id = $1)',
            [orderId]
        );
        
        // Emit to customer
        const io = req.app.get('io');
        io.to(`customer_${customer.rows[0].id}`).emit('order_accepted', result.rows[0]);
        
        res.json({ success: true, order: result.rows[0] });
        
    } catch (error) {
        console.error('Accept order error:', error);
        res.status(500).json({ error: 'Failed to accept order' });
    }
};

// Mark as delivered
const markDelivered = async (req, res) => {
    try {
        const { orderId } = req.params;
        const agentId = req.user.id;
        
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
        
        // Notify customer to confirm
        const customer = await pool.query(
            'SELECT id FROM users WHERE id = (SELECT customer_id FROM orders WHERE id = $1)',
            [orderId]
        );
        
        const io = req.app.get('io');
        io.to(`customer_${customer.rows[0].id}`).emit('delivery_completed', result.rows[0]);
        
        res.json({ success: true, order: result.rows[0] });
        
    } catch (error) {
        console.error('Mark delivered error:', error);
        res.status(500).json({ error: 'Failed to mark as delivered' });
    }
};

// Customer confirms delivery
const confirmDelivery = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { rating, feedback } = req.body;
        const customerId = req.user.id;
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP,
                 customer_rating = $2, customer_feedback = $3,
                 payment_status = 'paid'
             WHERE id = $1 AND customer_id = $4 AND status = 'delivered'
             RETURNING *`,
            [orderId, rating, feedback, customerId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found or cannot be confirmed' });
        }
        
        const order = result.rows[0];
        
        // Update agent's current order count (decrease)
        await pool.query(
            'UPDATE agents SET current_order_count = current_order_count - 1, total_deliveries = total_deliveries + 1 WHERE id = $1',
            [order.agent_id]
        );
        
        // Create agent earnings record
        const commission = order.total_amount * 0.10; // 10% commission
        const netAmount = order.total_amount - commission;
        
        await pool.query(
            `INSERT INTO agent_earnings (agent_id, order_id, amount, commission, net_amount)
             VALUES ($1, $2, $3, $4, $5)`,
            [order.agent_id, orderId, order.total_amount, commission, netAmount]
        );
        
        res.json({ success: true, order: result.rows[0] });
        
    } catch (error) {
        console.error('Confirm delivery error:', error);
        res.status(500).json({ error: 'Failed to confirm delivery' });
    }
};

module.exports = {
    createOrder,
    acceptOrder,
    markDelivered,
    confirmDelivery,
    findBestAgent
};