// 📁 backend/src/routes/admin.routes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate, isAdmin } = require('../middleware/auth.middleware');

// Apply JWT + admin role check to every route in this file
router.use(authenticate);
router.use(isAdmin);

// ============================================
// DASHBOARD STATS
// ============================================
router.get('/dashboard', async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM users WHERE user_type = 'customer') as total_customers,
                (SELECT COUNT(*) FROM agent_profiles WHERE is_approved = true) as total_agents,
                (SELECT COUNT(*) FROM agent_profiles WHERE is_approved = false) as pending_agents,
                (SELECT COUNT(*) FROM orders) as total_orders,
                (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURRENT_DATE) as today_orders,
                (SELECT COALESCE(SUM(total_amount), 0) FROM orders) as total_revenue,
                (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE DATE(created_at) = CURRENT_DATE) as today_revenue
        `);
        res.json(stats.rows[0] || {});
    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ============================================
// LIVE DASHBOARD
// ============================================
router.get('/live/stats', isAdmin, async (req, res) => {
    try {
        const onlineAgents = await pool.query(
            'SELECT COUNT(*) FROM agent_profiles WHERE is_online = true AND is_approved = true'
        );
        
        const activeUsers = await pool.query(
            "SELECT COUNT(*) FROM users WHERE last_login >= CURRENT_DATE"
        );
        
        const pendingOrders = await pool.query(
            "SELECT COUNT(*) FROM orders WHERE status IN ('pending', 'assigned')"
        );
        
        const todayOrders = await pool.query(
            "SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURRENT_DATE"
        );
        
        const todayRevenue = await pool.query(
            "SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE DATE(created_at) = CURRENT_DATE AND status = 'confirmed'"
        );
        
        const liveOrders = await pool.query(`
            SELECT o.*, u.full_name as customer_name 
            FROM orders o
            JOIN users u ON o.customer_id = u.id
            ORDER BY o.created_at DESC
            LIMIT 10
        `);
        
        const agents = await pool.query(`
            SELECT a.*, u.full_name, u.phone_number
            FROM agent_profiles a
            JOIN users u ON a.user_id = u.id
            WHERE a.is_online = true AND a.is_approved = true
            LIMIT 10
        `);
        
        const recentSignups = await pool.query(`
            SELECT id, full_name, phone_number, user_type, created_at
            FROM users
            ORDER BY created_at DESC
            LIMIT 10
        `);
        
        res.json({
            stats: {
                onlineAgents: parseInt(onlineAgents.rows[0].count) || 0,
                activeUsers: parseInt(activeUsers.rows[0].count) || 0,
                pendingOrders: parseInt(pendingOrders.rows[0].count) || 0,
                todayOrders: parseInt(todayOrders.rows[0].count) || 0,
                todayRevenue: parseFloat(todayRevenue.rows[0].coalesce) || 0,
            },
            liveOrders: liveOrders.rows || [],
            activeAgents: agents.rows || [],
            recentSignups: recentSignups.rows || [],
        });
    } catch (error) {
        console.error('Live dashboard error:', error);
        res.status(500).json({ error: 'Failed to fetch live data' });
    }
});

// ============================================
// ✅ CUSTOMERS - SPECIFIC ROUTES FIRST
// ============================================

// GET customers list (for dropdown) - MUST come before /customers/:id
router.get('/customers/list', isAdmin, async (req, res) => {
    try {
        const { search } = req.query;
        
        let query = `
            SELECT id, full_name, phone_number, email, is_active
            FROM users
            WHERE user_type = 'customer' AND is_active = true
        `;
        const params = [];
        
        if (search && search.length > 0) {
            query += ` AND (full_name ILIKE $1 OR phone_number ILIKE $1)`;
            params.push(`%${search}%`);
        }
        
        query += ` ORDER BY full_name LIMIT 50`;
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching customers list:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch customers'
        });
    }
});

// GET customers

// ============================================
// GET CUSTOMERS - FIXED with order counts
// ============================================
router.get('/customers', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                u.id,
                u.full_name,
                u.phone_number,
                u.email,
                u.is_active,
                u.is_verified,
                u.user_type,
                u.created_at as joined_at,
                COALESCE(COUNT(o.id), 0) as orders_count,
                COALESCE(SUM(o.total_amount), 0) as total_spent,
                MAX(o.created_at) as last_order,
                COALESCE(AVG(CASE WHEN o.status = 'delivered' THEN o.customer_rating END), 0) as rating
            FROM users u
            LEFT JOIN orders o ON u.id = o.customer_id
            WHERE u.user_type = 'customer'
            GROUP BY u.id, u.full_name, u.phone_number, u.email, u.is_active, u.is_verified, u.user_type, u.created_at
            ORDER BY u.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Customers error:', error);
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// GET customer by ID - parameter route
router.get('/customers/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT 
                u.id,
                u.full_name,
                u.phone_number,
                u.email,
                u.is_active,
                u.created_at as joined_at,
                COUNT(o.id) as orders_count,
                COALESCE(SUM(o.total_amount), 0) as total_spent,
                MAX(o.created_at) as last_order,
                COALESCE(AVG(o.customer_rating), 0) as rating
            FROM users u
            LEFT JOIN orders o ON u.id = o.customer_id
            WHERE u.id = $1 AND u.user_type = 'customer'
            GROUP BY u.id
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Customer details error:', error);
        res.status(500).json({ error: 'Failed to fetch customer details' });
    }
});

router.put('/customers/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { full_name, phone_number, email, is_active } = req.body;
        
        const result = await pool.query(
            `UPDATE users 
             SET full_name = $1, phone_number = $2, email = $3, is_active = $4, updated_at = CURRENT_TIMESTAMP
             WHERE id = $5 AND user_type = 'customer'
             RETURNING *`,
            [full_name, phone_number, email, is_active, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Update customer error:', error);
        res.status(500).json({ error: 'Failed to update customer' });
    }
});

router.delete('/customers/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(
            'UPDATE users SET is_active = false, deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_type = \'customer\'',
            [id]
        );
        res.json({ success: true, message: 'Customer moved to trash' });
    } catch (error) {
        console.error('Delete customer error:', error);
        res.status(500).json({ error: 'Failed to delete customer' });
    }
});

router.put('/customers/:id/toggle-status', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;
        
        const result = await pool.query(
            'UPDATE users SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_type = \'customer\' RETURNING *',
            [is_active, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Toggle customer status error:', error);
        res.status(500).json({ error: 'Failed to toggle customer status' });
    }
});

// 📁 backend/src/routes/admin.routes.js

// Add these routes after the existing customer routes

// ============================================
// CUSTOMER PROFILE - ADD THESE ROUTES
// ============================================

// GET customer orders
router.get('/customers/:id/orders', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT 
                o.id,
                o.order_number,
                o.total_amount,
                o.status,
                o.created_at,
                o.updated_at,
                o.quantity,
                o.product_price,
                o.delivery_fee,
                o.payment_method,
                o.payment_status,
                p.name as product_name,
                p.brand_name as product_brand
            FROM orders o
            LEFT JOIN products p ON o.product_id = p.id
            WHERE o.customer_id = $1
            ORDER BY o.created_at DESC
        `, [id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching customer orders:', error);
        res.status(500).json({ error: 'Failed to fetch customer orders' });
    }
});

// GET customer payments
router.get('/customers/:id/payments', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT 
                p.id,
                p.transaction_id,
                p.amount,
                p.payment_method,
                p.status,
                p.created_at,
                p.updated_at,
                p.mpesa_receipt_number
            FROM payments p
            WHERE p.user_id = $1
            ORDER BY p.created_at DESC
        `, [id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching customer payments:', error);
        // Return empty array if payments table doesn't exist
        res.json([]);
    }
});

// GET customer chats
router.get('/customers/:id/chats', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        // Check if chat table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'chats'
            )
        `);
        
        if (!tableCheck.rows[0].exists) {
            return res.json([]);
        }
        
        const result = await pool.query(`
            SELECT 
                c.id,
                c.message,
                c.created_at,
                c.status,
                u.full_name as agent_name
            FROM chats c
            LEFT JOIN users u ON c.agent_id = u.id
            WHERE c.customer_id = $1
            ORDER BY c.created_at DESC
            LIMIT 20
        `, [id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching customer chats:', error);
        res.json([]);
    }
});

// GET customer support tickets
router.get('/customers/:id/tickets', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        // Check if support_tickets table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'support_tickets'
            )
        `);
        
        if (!tableCheck.rows[0].exists) {
            return res.json([]);
        }
        
        const result = await pool.query(`
            SELECT 
                st.id,
                st.subject,
                st.status,
                st.priority,
                st.created_at,
                st.updated_at,
                st.resolved_at
            FROM support_tickets st
            WHERE st.customer_id = $1
            ORDER BY st.created_at DESC
            LIMIT 20
        `, [id]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching customer tickets:', error);
        res.json([]);
    }
});


// ============================================
// ✅ AGENTS - SPECIFIC ROUTES FIRST
// ============================================

// GET agents list (for dropdown) - MUST come before /agents/:id
router.get('/agents/list', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                a.id, 
                a.business_name,
                a.is_approved,
                a.is_active,
                u.full_name,
                u.phone_number
            FROM agent_profiles a
            JOIN users u ON a.user_id = u.id
            WHERE a.is_approved = true AND a.is_active = true
            ORDER BY a.business_name
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching agents list:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch agents'
        });
    }
});

// GET agents
// 📁 backend/src/routes/admin.routes.js

// ============================================
// GET AGENTS - FIXED with proper delivery counts
// ============================================
router.get('/agents', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                a.id,
                a.user_id,
                a.business_name,
                a.business_address,
                a.business_registration,
                a.is_approved,
                a.is_active,
                a.is_online,
                a.commission_rate,
                a.approval_date,
                a.created_at,
                a.updated_at,
                u.full_name,
                u.phone_number,
                u.email,
                u.is_verified,
                u.last_login,
                COALESCE(COUNT(DISTINCT o.id), 0) as delivery_count,
                COALESCE(SUM(o.total_amount), 0) as total_revenue,
                COALESCE(AVG(o.customer_rating), 0) as rating
            FROM agent_profiles a
            JOIN users u ON a.user_id = u.id
            LEFT JOIN orders o ON a.id = o.agent_id
            GROUP BY 
                a.id, a.user_id, a.business_name, a.business_address, 
                a.business_registration, a.is_approved, a.is_active, 
                a.is_online, a.commission_rate, a.approval_date, 
                a.created_at, a.updated_at,
                u.full_name, u.phone_number, u.email, u.is_verified, u.last_login
            ORDER BY delivery_count DESC, a.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Admin agents error:', error);
        res.status(500).json({ error: 'Failed to fetch agents' });
    }
});

router.get('/agents/pending', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.*, a.* 
            FROM agent_profiles a
            JOIN users u ON a.user_id = u.id
            WHERE a.is_approved = false
            ORDER BY a.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Pending agents error:', error);
        res.status(500).json({ error: 'Failed to fetch pending agents' });
    }
});

// GET agent by ID - parameter route
router.get('/agents/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT u.*, a.* 
            FROM agent_profiles a
            JOIN users u ON a.user_id = u.id
            WHERE a.id = $1
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Agent details error:', error);
        res.status(500).json({ error: 'Failed to fetch agent details' });
    }
});

router.put('/agents/:id/approve', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `UPDATE agent_profiles 
             SET is_approved = true, approval_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 
             RETURNING *`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Approve agent error:', error);
        res.status(500).json({ error: 'Failed to approve agent' });
    }
});

router.delete('/agents/:id/reject', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(
            'UPDATE agent_profiles SET is_active = false, deleted_at = CURRENT_TIMESTAMP WHERE id = $1',
            [id]
        );
        res.json({ success: true, message: 'Agent rejected' });
    } catch (error) {
        console.error('Reject agent error:', error);
        res.status(500).json({ error: 'Failed to reject agent' });
    }
});

router.put('/agents/:id/ban', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'UPDATE agent_profiles SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Ban agent error:', error);
        res.status(500).json({ error: 'Failed to ban agent' });
    }
});

router.put('/agents/:id/unban', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'UPDATE agent_profiles SET is_active = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Unban agent error:', error);
        res.status(500).json({ error: 'Failed to unban agent' });
    }
});

// 📁 backend/src/routes/admin.routes.js

// ============================================
// GET AGENT ORDERS - ADD THIS ENDPOINT
// ============================================
router.get('/agents/:id/orders', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query(`
            SELECT 
                o.id,
                o.order_number,
                o.total_amount,
                o.status,
                o.created_at,
                o.updated_at,
                u.full_name as customer_name,
                u.phone_number as customer_phone,
                p.name as product_name,
                p.brand_name as product_brand,
                o.quantity,
                o.product_price,
                o.delivery_address,
                o.payment_method,
                o.payment_status
            FROM orders o
            LEFT JOIN users u ON o.customer_id = u.id
            LEFT JOIN products p ON o.product_id = p.id
            WHERE o.agent_id = $1
            ORDER BY o.created_at DESC
        `, [id]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching agent orders:', error);
        res.status(500).json({ error: 'Failed to fetch agent orders' });
    }
});

// ============================================
// GET AGENT PAYMENTS - ADD THIS ENDPOINT
// ============================================
router.get('/agents/:id/payments', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query(`
            SELECT 
                p.id,
                p.transaction_id,
                p.amount,
                p.payment_method,
                p.status,
                p.created_at,
                p.updated_at
            FROM payments p
            WHERE p.user_id = (SELECT user_id FROM agent_profiles WHERE id = $1)
            ORDER BY p.created_at DESC
        `, [id]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching agent payments:', error);
        res.json([]);
    }
});

// ============================================
// GET AGENT CHATS - ADD THIS ENDPOINT
// ============================================
router.get('/agents/:id/chats', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check if chats table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'chats'
            )
        `);
        
        if (!tableCheck.rows[0].exists) {
            return res.json([]);
        }
        
        const result = await pool.query(`
            SELECT 
                c.id,
                c.message,
                c.created_at,
                c.status,
                u.full_name as customer_name
            FROM chats c
            LEFT JOIN users u ON c.customer_id = u.id
            WHERE c.agent_id = $1
            ORDER BY c.created_at DESC
            LIMIT 20
        `, [id]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching agent chats:', error);
        res.json([]);
    }
});

// ============================================
// GET AGENT SUPPORT TICKETS - ADD THIS ENDPOINT
// ============================================
router.get('/agents/:id/tickets', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check if support_tickets table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'support_tickets'
            )
        `);
        
        if (!tableCheck.rows[0].exists) {
            return res.json([]);
        }
        
        const result = await pool.query(`
            SELECT 
                st.id,
                st.subject,
                st.status,
                st.priority,
                st.created_at,
                st.updated_at
            FROM support_tickets st
            WHERE st.agent_id = $1
            ORDER BY st.created_at DESC
            LIMIT 20
        `, [id]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching agent tickets:', error);
        res.json([]);
    }
});

// ============================================
// ✅ PRODUCTS - SPECIFIC ROUTES FIRST
// ============================================

// GET products list (for dropdown) - MUST come before /products/:id
router.get('/products/list', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id, 
                name, 
                brand_name, 
                base_price, 
                product_type,
                is_active
            FROM products
            WHERE is_active = true
            ORDER BY brand_name, name
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching products list:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch products'
        });
    }
});

// GET products
router.get('/products', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products ORDER BY brand_name, name'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Products error:', error);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// GET product by ID - parameter route
router.get('/products/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT * FROM products WHERE id = $1',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Product details error:', error);
        res.status(500).json({ error: 'Failed to fetch product details' });
    }
});

router.post('/products', isAdmin, async (req, res) => {
    try {
        const { brand_name, weight_kg, product_type, name, description, base_price, delivery_price_per_km, image_url } = req.body;
        
        const result = await pool.query(
            `INSERT INTO products (brand_name, weight_kg, product_type, name, description, base_price, delivery_price_per_km, image_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [brand_name, weight_kg, product_type, name, description, base_price, delivery_price_per_km || 10, image_url]
        );
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Create product error:', error);
        res.status(500).json({ error: 'Failed to create product' });
    }
});

router.put('/products/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { brand_name, weight_kg, product_type, name, description, base_price, delivery_price_per_km, image_url, is_active } = req.body;
        
        const result = await pool.query(
            `UPDATE products SET 
                brand_name = $1, 
                weight_kg = $2, 
                product_type = $3, 
                name = $4, 
                description = $5, 
                base_price = $6, 
                delivery_price_per_km = $7,
                image_url = $8, 
                is_active = $9,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $10 
             RETURNING *`,
            [brand_name, weight_kg, product_type, name, description, base_price, delivery_price_per_km || 10, image_url, is_active, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ error: 'Failed to update product' });
    }
});

router.delete('/products/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(
            'UPDATE products SET is_active = false, deleted_at = CURRENT_TIMESTAMP WHERE id = $1',
            [id]
        );
        res.json({ success: true, message: 'Product moved to trash' });
    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({ error: 'Failed to delete product' });
    }
});

router.put('/products/:id/toggle-status', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;
        
        const result = await pool.query(
            'UPDATE products SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [is_active, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Toggle product status error:', error);
        res.status(500).json({ error: 'Failed to toggle product status' });
    }
});

router.get('/products/:id/price-history', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT * FROM product_price_history 
             WHERE product_id = $1 
             ORDER BY created_at DESC`,
            [id]
        );
        res.json(result.rows || []);
    } catch (error) {
        console.error('Price history error:', error);
        res.json([]);
    }
});

// ============================================
// INVENTORY MANAGEMENT
// ============================================
router.get('/inventory', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                ai.*,
                p.name as product_name,
                p.brand_name,
                p.base_price
            FROM agent_inventory ai
            JOIN products p ON ai.product_id = p.id
            ORDER BY p.brand_name
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Inventory error:', error);
        res.json([]);
    }
});

router.put('/inventory/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { stock_quantity, min_stock_level, max_stock_level } = req.body;
        
        const result = await pool.query(
            `UPDATE agent_inventory 
             SET stock_quantity = $1, min_stock_level = $2, max_stock_level = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING *`,
            [stock_quantity, min_stock_level, max_stock_level, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Inventory item not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Update inventory error:', error);
        res.status(500).json({ error: 'Failed to update inventory' });
    }
});

// ============================================
// ORDERS MANAGEMENT
// ============================================
router.get('/orders', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                o.id,
                o.order_number,
                o.customer_id,
                o.agent_id,
                o.status,
                o.payment_status,
                o.payment_method,
                o.total_amount,
                o.delivery_address,
                o.special_instructions as delivery_instructions,
                o.created_at,
                o.updated_at,
                u.full_name as customer_name,
                u.phone_number as customer_phone,
                u.email as customer_email,
                COALESCE(a.business_name, 'Unassigned') as agent_business,
                p.name as product_name,
                o.quantity,
                o.product_price as unit_price
            FROM orders o
            LEFT JOIN users u ON o.customer_id = u.id
            LEFT JOIN agent_profiles a ON o.agent_id = a.id
            LEFT JOIN products p ON o.product_id = p.id
            ORDER BY o.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Orders error:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// GET order by ID - parameter route
router.get('/orders/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT 
                o.*,
                u.full_name as customer_name,
                u.phone_number as customer_phone,
                u.email as customer_email,
                COALESCE(a.business_name, 'Unassigned') as agent_business,
                p.name as product_name,
                p.brand_name as product_brand
            FROM orders o
            LEFT JOIN users u ON o.customer_id = u.id
            LEFT JOIN agent_profiles a ON o.agent_id = a.id
            LEFT JOIN products p ON o.product_id = p.id
            WHERE o.id = $1
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Order details error:', error);
        res.status(500).json({ error: 'Failed to fetch order details' });
    }
});

router.put('/orders/:id/status', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        const validStatuses = ['pending', 'assigned', 'accepted', 'picked_up', 'out_for_delivery', 'delivered', 'confirmed', 'cancelled', 'declined'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }
        
        const checkOrder = await pool.query(
            'SELECT id FROM orders WHERE id = $1',
            [id]
        );
        
        if (checkOrder.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = $1, 
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING 
                id, 
                order_number, 
                status, 
                updated_at`,
            [status, id]
        );
        
        console.log(`✅ Order ${id} status updated to: ${status}`);
        
        res.json({
            success: true,
            message: 'Order status updated successfully',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Update order status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update order status'
        });
    }
});

router.put('/orders/:id/cancel', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = 'cancelled', 
                 cancelled_at = CURRENT_TIMESTAMP,
                 cancellation_reason = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING *`,
            [reason || 'Cancelled by admin', id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Cancel order error:', error);
        res.status(500).json({ error: 'Failed to cancel order' });
    }
});

// 📁 backend/src/routes/admin.routes.js

// ============================================
// ASSIGN AGENT TO ORDER - FIXED (sets status to assigned)
// ============================================
router.put('/orders/:id/assign-agent', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { agent_id } = req.body;
        
        console.log('📦 Assign agent request:', { orderId: id, agentId: agent_id });
        
        if (!agent_id) {
            return res.status(400).json({
                success: false,
                message: 'Agent ID is required'
            });
        }
        
        // 1. Check if order exists
        const orderCheck = await pool.query(
            'SELECT id, status FROM orders WHERE id = $1',
            [id]
        );
        
        if (orderCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }
        
        console.log('📦 Current order status:', orderCheck.rows[0].status);
        
        // 2. Check if agent exists and is approved
        const agentCheck = await pool.query(
            'SELECT id, business_name FROM agent_profiles WHERE id = $1 AND is_approved = true',
            [agent_id]
        );
        
        if (agentCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Approved agent not found'
            });
        }
        
        console.log('✅ Agent found:', agentCheck.rows[0].business_name);
        
        // 3. ✅ FIXED: Update order with agent AND set status to 'assigned'
        const result = await pool.query(
            `UPDATE orders 
             SET 
                 agent_id = $1, 
                 status = 'assigned',        -- ← This is the key fix!
                 assigned_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING 
                id, 
                order_number, 
                agent_id, 
                status,
                assigned_at,
                updated_at`,
            [agent_id, id]
        );
        
        console.log('✅ Order updated:', result.rows[0]);
        console.log('✅ New status:', result.rows[0].status);
        
        res.json({
            success: true,
            message: 'Agent assigned successfully. Order status updated to assigned.',
            data: result.rows[0]
        });
        
    } catch (error) {
        console.error('❌ Assign agent error:', error);
        console.error('❌ Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Failed to assign agent',
            error: error.message
        });
    }
});

// ============================================
// ADMIN CREATE ORDER FOR CUSTOMER
// ============================================
// 📁 backend/src/routes/admin.routes.js

// ============================================
// ADMIN CREATE ORDER FOR CUSTOMER - FIXED
// ============================================


// ============================================
// ADMIN CREATE ORDER FOR CUSTOMER - WITH DIRECT AGENT ASSIGNMENT
// ============================================
router.post('/orders/create', isAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const {
            customer_id,
            product_id,
            quantity,
            agent_id,
            delivery_address,
            special_instructions,
            payment_method,
            payment_status,
            delivery_fee,
        } = req.body;

        console.log('📦 Create order request:', JSON.stringify(req.body, null, 2));

        // 1. Check customer exists
        const customerCheck = await client.query(
            'SELECT id, full_name, phone_number FROM users WHERE id = $1 AND user_type = \'customer\' AND is_active = true',
            [customer_id]
        );
        
        if (customerCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Customer not found or inactive'
            });
        }
        
        const customer = customerCheck.rows[0];
        console.log('✅ Customer found:', customer.full_name);
        
        // 2. Check product exists
        const productCheck = await client.query(
            'SELECT id, name, brand_name, base_price FROM products WHERE id = $1 AND is_active = true',
            [product_id]
        );
        
        if (productCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Product not found or inactive'
            });
        }
        
        const product = productCheck.rows[0];
        console.log('✅ Product found:', product.name);
        
        // 3. Check agent if provided
        let agentInfo = null;
        let orderStatus = 'pending';
        
        if (agent_id) {
            const agentCheck = await client.query(
                'SELECT id, business_name FROM agent_profiles WHERE id = $1 AND is_approved = true AND is_active = true',
                [agent_id]
            );
            
            if (agentCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Agent not found, not approved, or inactive'
                });
            }
            agentInfo = agentCheck.rows[0];
            orderStatus = 'assigned';  // ✅ If agent is assigned, status is 'assigned'
            console.log('✅ Agent found:', agentInfo.business_name);
            console.log('✅ Order will be created with status: assigned');
        }
        
        // 4. Validate
        if (!quantity || quantity < 1) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Quantity must be at least 1'
            });
        }
        
        if (!delivery_address) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Delivery address is required'
            });
        }

        // 5. Calculate totals
        const unit_price = parseFloat(product.base_price);
        const subtotal = unit_price * quantity;
        const deliveryFee = parseFloat(delivery_fee) || 100;
        const total = subtotal + deliveryFee;
        
        console.log('💰 Calculated totals:', { unit_price, subtotal, deliveryFee, total });
        
        // 6. Generate order number
        const timestamp = Date.now().toString().slice(-8);
        const random = Math.random().toString(36).substring(2, 6).toUpperCase();
        const orderNumber = `ADM${timestamp}${random}`;
        
        console.log('📦 Generated order number:', orderNumber);
        
        // 7. ✅ Insert order with correct status
        const insertResult = await client.query(
            `INSERT INTO orders (
                order_number,
                customer_id,
                agent_id,
                product_id,
                quantity,
                product_price,
                delivery_fee,
                total_amount,
                delivery_address,
                special_instructions,
                status,
                payment_method,
                payment_status,
                assigned_at,
                created_at,
                updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
            RETURNING id, order_number, status, total_amount, created_at, assigned_at`,
            [
                orderNumber,
                customer_id,
                agent_id || null,
                product_id,
                quantity,
                unit_price,
                deliveryFee,
                total,
                delivery_address,
                special_instructions || null,
                orderStatus,  // ✅ 'pending' or 'assigned'
                payment_method || 'cash',
                payment_status || 'pending',
                agent_id ? new Date() : null  // ✅ Set assigned_at if agent provided
            ]
        );
        
        const order = insertResult.rows[0];
        console.log('✅ Order inserted:', order);
        console.log('✅ Order status:', order.status);
        
        // 8. Insert order item if table exists
        try {
            const itemCheck = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'order_items'
                )
            `);
            
            if (itemCheck.rows[0].exists) {
                await client.query(
                    `INSERT INTO order_items (
                        order_id,
                        product_id,
                        quantity,
                        unit_price,
                        total_price
                    ) VALUES ($1, $2, $3, $4, $5)`,
                    [order.id, product_id, quantity, unit_price, subtotal]
                );
                console.log('✅ Order item inserted');
            }
        } catch (err) {
            console.log('📝 Note: order_items insert skipped:', err.message);
        }
        
        await client.query('COMMIT');
        
        console.log('✅ Order created successfully:', order.order_number);
        console.log('✅ Final status:', order.status);
        
        res.status(201).json({
            success: true,
            message: agent_id 
                ? 'Order created and assigned to agent successfully!' 
                : 'Order created successfully for customer',
            data: {
                order: {
                    id: order.id,
                    order_number: order.order_number,
                    status: order.status,
                    total_amount: order.total_amount,
                    created_at: order.created_at,
                    assigned_at: order.assigned_at
                },
                customer: {
                    id: customer.id,
                    full_name: customer.full_name,
                    phone_number: customer.phone_number
                },
                product: {
                    id: product.id,
                    name: product.name,
                    brand_name: product.brand_name,
                    price: unit_price
                },
                quantity: quantity,
                delivery_address: delivery_address,
                agent: agentInfo ? {
                    id: agentInfo.id,
                    business_name: agentInfo.business_name
                } : null,
                payment: {
                    method: payment_method || 'cash',
                    status: payment_status || 'pending'
                }
            }
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Admin create order error:', error);
        console.error('❌ Error stack:', error.stack);
        
        res.status(500).json({
            success: false,
            message: 'Failed to create order',
            error: error.message
        });
    } finally {
        client.release();
    }
});

// ============================================
// GET CUSTOMER ORDERS (Admin view)
// ============================================
router.get('/orders/customer/:customerId', isAdmin, async (req, res) => {
    try {
        const { customerId } = req.params;
        
        const result = await pool.query(`
            SELECT 
                o.*,
                p.name as product_name,
                p.brand_name as product_brand,
                u.full_name as customer_name,
                u.phone_number as customer_phone,
                a.business_name as agent_name
            FROM orders o
            LEFT JOIN products p ON o.product_id = p.id
            LEFT JOIN users u ON o.customer_id = u.id
            LEFT JOIN agent_profiles a ON o.agent_id = a.id
            WHERE o.customer_id = $1
            ORDER BY o.created_at DESC
        `, [customerId]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching customer orders:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch customer orders'
        });
    }
});

// ============================================
// BULK ORDER STATUS UPDATE
// ============================================
router.put('/orders/bulk-status', isAdmin, async (req, res) => {
    try {
        const { orderIds, status } = req.body;
        
        const validStatuses = ['pending', 'assigned', 'accepted', 'picked_up', 'out_for_delivery', 'delivered', 'confirmed', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        
        const result = await pool.query(
            'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2) RETURNING *',
            [status, orderIds]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Bulk update error:', error);
        res.status(500).json({ error: 'Failed to bulk update orders' });
    }
});

// ============================================
// WITHDRAWALS MANAGEMENT
// ============================================
router.get('/withdrawals', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT w.*, 
                   u.full_name as agent_name,
                   u.phone_number as agent_phone
            FROM withdrawals w
            LEFT JOIN users u ON w.agent_id = u.id
            ORDER BY w.requested_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Withdrawals error:', error);
        res.json([]);
    }
});

router.get('/withdrawals/pending', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT w.*, 
                   u.full_name as agent_name,
                   u.phone_number as agent_phone
            FROM withdrawals w
            LEFT JOIN users u ON w.agent_id = u.id
            WHERE w.status = 'pending'
            ORDER BY w.requested_at ASC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Pending withdrawals error:', error);
        res.json([]);
    }
});

router.put('/withdrawals/:id/process', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        const result = await pool.query(
            `UPDATE withdrawals 
             SET status = $1, 
                 processed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING *`,
            [status, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Process withdrawal error:', error);
        res.status(500).json({ error: 'Failed to process withdrawal' });
    }
});

router.put('/withdrawals/:id/approve', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `UPDATE withdrawals 
             SET status = 'approved', 
                 processed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Approve withdrawal error:', error);
        res.status(500).json({ error: 'Failed to approve withdrawal' });
    }
});

router.put('/withdrawals/:id/reject', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `UPDATE withdrawals 
             SET status = 'rejected', 
                 processed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Reject withdrawal error:', error);
        res.status(500).json({ error: 'Failed to reject withdrawal' });
    }
});

router.put('/withdrawals/:id/mark-paid', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `UPDATE withdrawals 
             SET status = 'paid', 
                 paid_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Mark paid error:', error);
        res.status(500).json({ error: 'Failed to mark as paid' });
    }
});

// ============================================
// PROMOTIONS
// ============================================
router.get('/promotions', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM promotions 
            ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Promotions error:', error);
        res.json([]);
    }
});

router.post('/promotions', isAdmin, async (req, res) => {
    try {
        const { code, type, value, min_order, max_discount, expires_at, is_active } = req.body;
        
        const result = await pool.query(
            `INSERT INTO promotions (code, type, value, min_order, max_discount, expires_at, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [code, type, value, min_order, max_discount, expires_at, is_active]
        );
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Create promotion error:', error);
        res.status(500).json({ error: 'Failed to create promotion' });
    }
});

router.put('/promotions/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { code, type, value, min_order, max_discount, expires_at, is_active } = req.body;
        
        const result = await pool.query(
            `UPDATE promotions 
             SET code = $1, type = $2, value = $3, min_order = $4, max_discount = $5, expires_at = $6, is_active = $7, updated_at = CURRENT_TIMESTAMP
             WHERE id = $8
             RETURNING *`,
            [code, type, value, min_order, max_discount, expires_at, is_active, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Promotion not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Update promotion error:', error);
        res.status(500).json({ error: 'Failed to update promotion' });
    }
});

router.delete('/promotions/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM promotions WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete promotion error:', error);
        res.status(500).json({ error: 'Failed to delete promotion' });
    }
});

// ============================================
// SETTINGS
// ============================================
router.get('/settings', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT key, value, group_name, updated_at FROM settings ORDER BY group_name, key'
        );
        
        const settingsObj = {};
        result.rows.forEach(row => {
            settingsObj[row.key] = row.value;
        });
        
        res.json(settingsObj);
    } catch (error) {
        console.error('Settings error:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

router.get('/settings/:group', isAdmin, async (req, res) => {
    try {
        const { group } = req.params;
        const result = await pool.query(
            'SELECT key, value FROM settings WHERE group_name = $1',
            [group]
        );
        
        const settingsObj = {};
        result.rows.forEach(row => {
            settingsObj[row.key] = row.value;
        });
        
        res.json(settingsObj);
    } catch (error) {
        console.error('Settings group error:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

router.get('/settings/:key', isAdmin, async (req, res) => {
    try {
        const { key } = req.params;
        const result = await pool.query(
            'SELECT value FROM settings WHERE key = $1',
            [key]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Setting not found' });
        }
        
        res.json(result.rows[0].value);
    } catch (error) {
        console.error('Setting error:', error);
        res.status(500).json({ error: 'Failed to fetch setting' });
    }
});

router.put('/settings', isAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const settings = req.body;
        
        for (const [key, value] of Object.entries(settings)) {
            await client.query(
                `INSERT INTO settings (key, value, group_name, updated_at)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET 
                     value = EXCLUDED.value,
                     updated_at = CURRENT_TIMESTAMP`,
                [key, value, key]
            );
        }
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Settings updated successfully',
            updated_at: new Date().toISOString()
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Update settings error:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    } finally {
        client.release();
    }
});

router.put('/settings/:key', isAdmin, async (req, res) => {
    try {
        const { key } = req.params;
        const value = req.body;
        
        const result = await pool.query(
            `INSERT INTO settings (key, value, group_name, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET 
                 value = EXCLUDED.value,
                 updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [key, value, key]
        );
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Update setting error:', error);
        res.status(500).json({ error: 'Failed to update setting' });
    }
});

router.post('/settings/reset', isAdmin, async (req, res) => {
    try {
        const defaultSettings = {
            general: {
                app_name: 'Gas Mtaani',
                contact_email: 'support@gasmtaani.co.ke',
                contact_phone: '0712345678',
                support_hours: '8:00 AM - 10:00 PM',
            },
            delivery: {
                max_radius: 5,
                base_fee: 50,
                fee_per_km: 10,
                night_delivery_fee: 50,
                peak_hours_surcharge: 20,
                peak_hours: '6:00 PM - 9:00 PM',
            },
            commission: {
                admin_commission: 10,
                agent_commission: 90,
                min_commission: 50,
            },
            payments: {
                mpesa_shortcode: '174379',
                mpesa_consumer_key: '',
                mpesa_passkey: '',
            },
            notifications: {
                sms_provider: "Africa's Talking",
                push_enabled: true,
                email_enabled: true,
                push_api_key: '',
            },
        };
        
        for (const [key, value] of Object.entries(defaultSettings)) {
            await pool.query(
                `INSERT INTO settings (key, value, group_name, updated_at)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET 
                     value = EXCLUDED.value,
                     updated_at = CURRENT_TIMESTAMP`,
                [key, value, key]
            );
        }
        
        res.json({
            success: true,
            message: 'Settings reset to defaults',
            defaults: defaultSettings
        });
    } catch (error) {
        console.error('Reset settings error:', error);
        res.status(500).json({ error: 'Failed to reset settings' });
    }
});

// ============================================
// SUPPORT TICKETS
// ============================================
router.get('/support/tickets', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                st.*,
                u.full_name as customer_name,
                u.phone_number as customer_phone,
                u.email as customer_email
            FROM support_tickets st
            LEFT JOIN users u ON st.customer_id = u.id
            ORDER BY st.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Support tickets error:', error);
        res.json([]);
    }
});

router.get('/support/tickets/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT 
                st.*,
                u.full_name as customer_name,
                u.phone_number as customer_phone,
                u.email as customer_email
            FROM support_tickets st
            LEFT JOIN users u ON st.customer_id = u.id
            WHERE st.id = $1
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Ticket details error:', error);
        res.status(500).json({ error: 'Failed to fetch ticket details' });
    }
});

router.put('/support/tickets/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, priority, assigned_to } = req.body;
        
        const result = await pool.query(
            `UPDATE support_tickets 
             SET status = COALESCE($1, status),
                 priority = COALESCE($2, priority),
                 assigned_to = COALESCE($3, assigned_to),
                 resolved_at = CASE WHEN $1 = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING *`,
            [status, priority, assigned_to, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Update ticket error:', error);
        res.status(500).json({ error: 'Failed to update ticket' });
    }
});

router.post('/support/tickets/:id/reply', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { message } = req.body;
        
        await pool.query(
            `UPDATE support_tickets 
             SET status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id]
        );
        
        res.json({ success: true, message: 'Reply sent successfully' });
    } catch (error) {
        console.error('Reply error:', error);
        res.status(500).json({ error: 'Failed to send reply' });
    }
});

router.delete('/support/tickets/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM support_tickets WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete ticket error:', error);
        res.status(500).json({ error: 'Failed to delete ticket' });
    }
});

// ============================================
// NOTIFICATIONS
// ============================================
router.get('/notifications', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                n.*,
                u.full_name as user_name
            FROM notifications n
            LEFT JOIN users u ON n.user_id = u.id
            ORDER BY n.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Notifications error:', error);
        res.json([]);
    }
});

router.post('/notifications', isAdmin, async (req, res) => {
    try {
        const { title, message, type, send_to, user_id } = req.body;
        
        const result = await pool.query(
            `INSERT INTO notifications (title, message, type, send_to, user_id, status, sent_at)
             VALUES ($1, $2, $3, $4, $5, 'sent', CURRENT_TIMESTAMP)
             RETURNING *`,
            [title, message, type, send_to || 'all', user_id || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Create notification error:', error);
        res.status(500).json({ error: 'Failed to send notification' });
    }
});

router.delete('/notifications/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM notifications WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete notification error:', error);
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

router.put('/notifications/:id/read', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'UPDATE notifications SET is_read = true WHERE id = $1 RETURNING *',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Notification not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// ============================================
// ANALYTICS
// ============================================
router.get('/analytics', isAdmin, async (req, res) => {
    try {
        const revenue = await pool.query(`
            SELECT 
                COALESCE(SUM(o.total_amount), 0) as total_revenue,
                COALESCE(SUM(o.total_amount) FILTER (WHERE DATE(o.created_at) = CURRENT_DATE), 0) as daily_revenue,
                COALESCE(SUM(o.total_amount) FILTER (WHERE DATE(o.created_at) >= DATE_TRUNC('month', CURRENT_DATE)), 0) as monthly_revenue,
                COALESCE(SUM(o.total_amount) FILTER (WHERE DATE(o.created_at) >= DATE_TRUNC('year', CURRENT_DATE)), 0) as yearly_revenue
            FROM orders o
            WHERE o.status IN ('confirmed', 'delivered')
        `);
        
        const orders = await pool.query(`
            SELECT 
                COUNT(*) as total_orders,
                COALESCE(AVG(o.total_amount), 0) as avg_order_value,
                COUNT(*) FILTER (WHERE DATE(o.created_at) = CURRENT_DATE) as today_orders,
                COUNT(*) FILTER (WHERE DATE(o.created_at) >= DATE_TRUNC('month', CURRENT_DATE)) as monthly_orders
            FROM orders o
            WHERE o.status IN ('confirmed', 'delivered')
        `);
        
        const topAgents = await pool.query(`
            SELECT 
                a.business_name,
                COUNT(o.id) as delivery_count,
                COALESCE(SUM(o.total_amount), 0) as revenue,
                COALESCE(AVG(o.customer_rating), 0) as rating
            FROM agent_profiles a
            LEFT JOIN orders o ON a.id = o.agent_id AND o.status IN ('confirmed', 'delivered')
            GROUP BY a.id, a.business_name
            ORDER BY delivery_count DESC
            LIMIT 5
        `);
        
        const customers = await pool.query(`
            SELECT 
                COUNT(*) as total_customers,
                COUNT(*) FILTER (WHERE u.created_at >= DATE_TRUNC('month', CURRENT_DATE)) as new_customers,
                COUNT(DISTINCT o.customer_id) FILTER (WHERE o.created_at >= DATE_TRUNC('month', CURRENT_DATE)) as repeat_customers
            FROM users u
            LEFT JOIN orders o ON u.id = o.customer_id AND o.created_at >= DATE_TRUNC('month', CURRENT_DATE)
            WHERE u.user_type = 'customer'
        `);
        
        res.json({
            revenue: revenue.rows[0] || {},
            orders: orders.rows[0] || {},
            topAgents: topAgents.rows || [],
            customers: customers.rows[0] || {},
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// ============================================
// REPORTS
// ============================================
router.get('/reports/sales', isAdmin, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        
        const result = await pool.query(`
            SELECT 
                DATE(o.created_at) as date,
                COUNT(*) as orders,
                COALESCE(SUM(o.total_amount), 0) as revenue,
                COALESCE(AVG(o.total_amount), 0) as avg_order
            FROM orders o
            WHERE o.status IN ('confirmed', 'delivered')
                AND ($1::date IS NULL OR DATE(o.created_at) >= $1)
                AND ($2::date IS NULL OR DATE(o.created_at) <= $2)
            GROUP BY DATE(o.created_at)
            ORDER BY DATE(o.created_at) DESC
        `, [start_date || null, end_date || null]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Sales report error:', error);
        res.status(500).json({ error: 'Failed to generate sales report' });
    }
});

router.get('/reports/agents', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                a.business_name,
                COUNT(o.id) as deliveries,
                COALESCE(SUM(o.total_amount), 0) as revenue,
                COALESCE(AVG(o.customer_rating), 0) as rating,
                COALESCE(SUM(o.total_amount) * 0.1, 0) as commission
            FROM agent_profiles a
            LEFT JOIN orders o ON a.id = o.agent_id AND o.status = 'confirmed'
            GROUP BY a.id, a.business_name
            ORDER BY deliveries DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Agent report error:', error);
        res.status(500).json({ error: 'Failed to generate agent report' });
    }
});

router.get('/reports/customers', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                u.full_name,
                u.phone_number,
                COUNT(o.id) as orders,
                COALESCE(SUM(o.total_amount), 0) as spent,
                MAX(o.created_at) as last_order
            FROM users u
            LEFT JOIN orders o ON u.id = o.customer_id AND o.status = 'confirmed'
            WHERE u.user_type = 'customer'
            GROUP BY u.id, u.full_name, u.phone_number
            ORDER BY spent DESC
            LIMIT 50
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Customer report error:', error);
        res.status(500).json({ error: 'Failed to generate customer report' });
    }
});

// ============================================
// TRASH
// ============================================
router.get('/trash', isAdmin, async (req, res) => {
    try {
        const customers = await pool.query(
            "SELECT 'customer' as type, id, full_name as name, phone_number, deleted_at FROM users WHERE is_active = false AND user_type = 'customer'"
        );
        
        const agents = await pool.query(
            "SELECT 'agent' as type, a.id, u.full_name as name, u.phone_number, a.deleted_at FROM agent_profiles a JOIN users u ON a.user_id = u.id WHERE a.is_active = false"
        );
        
        const products = await pool.query(
            "SELECT 'product' as type, id, name, brand_name, deleted_at FROM products WHERE is_active = false"
        );
        
        const orders = await pool.query(
            "SELECT 'order' as type, id, order_number as name, total_amount, cancelled_at as deleted_at FROM orders WHERE status = 'cancelled'"
        );
        
        const allItems = [...customers.rows, ...agents.rows, ...products.rows, ...orders.rows];
        res.json(allItems);
    } catch (error) {
        console.error('Trash error:', error);
        res.json([]);
    }
});

router.put('/trash/restore/:type/:id', isAdmin, async (req, res) => {
    try {
        const { type, id } = req.params;
        
        switch(type) {
            case 'customer':
                await pool.query('UPDATE users SET is_active = true, deleted_at = NULL WHERE id = $1', [id]);
                break;
            case 'agent':
                await pool.query('UPDATE agent_profiles SET is_active = true, deleted_at = NULL WHERE id = $1', [id]);
                break;
            case 'product':
                await pool.query('UPDATE products SET is_active = true, deleted_at = NULL WHERE id = $1', [id]);
                break;
            case 'order':
                await pool.query('UPDATE orders SET status = \'pending\', cancelled_at = NULL WHERE id = $1', [id]);
                break;
            default:
                return res.status(400).json({ error: 'Invalid type' });
        }
        
        res.json({ success: true, message: 'Item restored successfully' });
    } catch (error) {
        console.error('Restore error:', error);
        res.status(500).json({ error: 'Failed to restore item' });
    }
});

router.delete('/trash/permanent/:type/:id', isAdmin, async (req, res) => {
    try {
        const { type, id } = req.params;
        
        switch(type) {
            case 'customer':
                await pool.query('DELETE FROM users WHERE id = $1', [id]);
                break;
            case 'agent':
                await pool.query('DELETE FROM agent_profiles WHERE id = $1', [id]);
                break;
            case 'product':
                await pool.query('DELETE FROM products WHERE id = $1', [id]);
                break;
            case 'order':
                await pool.query('DELETE FROM orders WHERE id = $1', [id]);
                break;
            default:
                return res.status(400).json({ error: 'Invalid type' });
        }
        
        res.json({ success: true, message: 'Item permanently deleted' });
    } catch (error) {
        console.error('Permanent delete error:', error);
        res.status(500).json({ error: 'Failed to permanently delete item' });
    }
});

// ============================================
// EXPORTS
// ============================================
router.get('/exports/orders', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                o.order_number,
                u.full_name as customer_name,
                u.phone_number,
                p.name as product_name,
                o.quantity,
                o.total_amount,
                o.status,
                o.created_at
            FROM orders o
            LEFT JOIN users u ON o.customer_id = u.id
            LEFT JOIN products p ON o.product_id = p.id
            ORDER BY o.created_at DESC
        `);
        
        const rows = result.rows;
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No orders to export' });
        }
        
        const headers = Object.keys(rows[0]);
        const csv = [
            headers.join(','),
            ...rows.map(row => headers.map(h => JSON.stringify(row[h] || '')).join(','))
        ].join('\n');
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=orders_${new Date().toISOString().slice(0,10)}.csv`);
        res.send(csv);
    } catch (error) {
        console.error('Export orders error:', error);
        res.status(500).json({ error: 'Failed to export orders' });
    }
});

router.get('/exports/customers', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                full_name,
                phone_number,
                email,
                is_active,
                created_at as joined_date
            FROM users
            WHERE user_type = 'customer'
            ORDER BY created_at DESC
        `);
        
        const rows = result.rows;
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No customers to export' });
        }
        
        const headers = Object.keys(rows[0]);
        const csv = [
            headers.join(','),
            ...rows.map(row => headers.map(h => JSON.stringify(row[h] || '')).join(','))
        ].join('\n');
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=customers_${new Date().toISOString().slice(0,10)}.csv`);
        res.send(csv);
    } catch (error) {
        console.error('Export customers error:', error);
        res.status(500).json({ error: 'Failed to export customers' });
    }
});

router.get('/exports/products', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                name,
                brand_name,
                base_price as price,
                product_type,
                weight_kg,
                is_active
            FROM products
            ORDER BY brand_name
        `);
        
        const rows = result.rows;
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No products to export' });
        }
        
        const headers = Object.keys(rows[0]);
        const csv = [
            headers.join(','),
            ...rows.map(row => headers.map(h => JSON.stringify(row[h] || '')).join(','))
        ].join('\n');
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=products_${new Date().toISOString().slice(0,10)}.csv`);
        res.send(csv);
    } catch (error) {
        console.error('Export products error:', error);
        res.status(500).json({ error: 'Failed to export products' });
    }
});

// ============================================
// BULK ACTIONS
// ============================================
router.delete('/products/bulk', isAdmin, async (req, res) => {
    try {
        const { productIds } = req.body;
        const result = await pool.query(
            'UPDATE products SET is_active = false, deleted_at = CURRENT_TIMESTAMP WHERE id = ANY($1) RETURNING id',
            [productIds]
        );
        res.json({ deleted: result.rows.length });
    } catch (error) {
        console.error('Bulk delete error:', error);
        res.status(500).json({ error: 'Failed to bulk delete products' });
    }
});

router.put('/agents/bulk-approve', isAdmin, async (req, res) => {
    try {
        const { agentIds } = req.body;
        const result = await pool.query(
            'UPDATE agent_profiles SET is_approved = true, approval_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1) RETURNING *',
            [agentIds]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Bulk approve error:', error);
        res.status(500).json({ error: 'Failed to bulk approve agents' });
    }
});





// ================================================================
// TEMPORARY DEBUG — remove after diagnosing
// ================================================================
router.get('/debug/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    const { rows: users } = await pool.query(
      `SELECT id, phone_number, full_name, user_type, is_active, is_verified
       FROM users WHERE phone_number = $1`,
      [phone]
    );

    const { rows: meta } = await pool.query(
      `SELECT
         current_database()                                 AS db_name,
         current_user                                       AS db_user,
         inet_server_addr()::text                           AS db_host,
         inet_server_port()                                 AS db_port,
         (SELECT COUNT(*) FROM users)                       AS user_count,
         (SELECT COUNT(*) FROM users WHERE user_type='admin') AS admin_count`
    );

    res.json({
      query: { phone },
      users,
      server: meta[0],
    });
  } catch (err) {
    console.error('Debug route error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;