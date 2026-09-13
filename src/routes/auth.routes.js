// 📁 backend/src/routes/auth.routes.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// ============================================
// REGISTER USER - COMPLETE FIX
// ============================================
router.post('/register', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { 
            phone_number, 
            email, 
            full_name, 
            password, 
            user_type,
            is_verified,
            is_active 
        } = req.body;

        console.log('📦 Registration request:', { 
            phone_number, 
            full_name, 
            email, 
            user_type,
            is_verified,
            is_active 
        });

        // Validate required fields
        if (!phone_number || !full_name || !password) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                success: false,
                error: 'Missing required fields: phone_number, full_name, password' 
            });
        }

        // Check if user already exists
        const existingUser = await client.query(
            'SELECT id FROM users WHERE phone_number = $1 OR email = $2',
            [phone_number, email]
        );

        if (existingUser.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                success: false,
                error: 'User with this phone number or email already exists' 
            });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        // Insert user with all fields
        const result = await client.query(
            `INSERT INTO users (
                phone_number, 
                email, 
                full_name, 
                password_hash, 
                user_type,
                is_verified,
                is_active,
                created_at,
                updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
            RETURNING id, phone_number, email, full_name, user_type, is_verified, is_active, created_at`,
            [
                phone_number, 
                email || null, 
                full_name, 
                password_hash, 
                user_type || 'customer',
                is_verified !== undefined ? is_verified : true,
                is_active !== undefined ? is_active : true
            ]
        );

        const newUser = result.rows[0];

        // If user_type is 'agent', also create agent profile
        if (user_type === 'agent') {
            // Check if agent_profiles table exists
            const tableCheck = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'agent_profiles'
                )
            `);

            if (tableCheck.rows[0].exists) {
                await client.query(
                    `INSERT INTO agent_profiles (
                        user_id,
                        business_name,
                        is_approved,
                        is_active,
                        created_at,
                        updated_at
                    ) VALUES ($1, $2, false, true, NOW(), NOW())`,
                    [newUser.id, full_name + ' - Agent']
                );
                console.log('✅ Agent profile created for:', full_name);
            }
        }

        await client.query('COMMIT');

        console.log('✅ User registered successfully:', newUser.phone_number);

        // Generate JWT token
        const token = jwt.sign(
            { userId: newUser.id, userType: newUser.user_type },
            process.env.JWT_SECRET || 'default_secret_key',
            { expiresIn: '7d' }
        );

        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: {
                token,
                user: {
                    id: newUser.id,
                    full_name: newUser.full_name,
                    phone_number: newUser.phone_number,
                    email: newUser.email,
                    user_type: newUser.user_type,
                    is_verified: newUser.is_verified,
                    is_active: newUser.is_active,
                    created_at: newUser.created_at
                }
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Registration error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Registration failed', 
            details: error.message 
        });
    } finally {
        client.release();
    }
});

// ============================================
// LOGIN USER
// ============================================
router.post('/login', async (req, res) => {
    try {
        const { phone_number, password } = req.body;

        if (!phone_number || !password) {
            return res.status(400).json({ 
                success: false,
                error: 'Phone number and password required' 
            });
        }

        // Get user
        const result = await pool.query(
            'SELECT * FROM users WHERE phone_number = $1',
            [phone_number]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ 
                success: false,
                error: 'Invalid credentials' 
            });
        }

        const user = result.rows[0];

        // Check if user is active
        if (!user.is_active) {
            return res.status(403).json({ 
                success: false,
                error: 'Account is deactivated. Please contact support.' 
            });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ 
                success: false,
                error: 'Invalid credentials' 
            });
        }

        // Generate token
        const token = jwt.sign(
            { userId: user.id, userType: user.user_type },
            process.env.JWT_SECRET || 'default_secret_key',
            { expiresIn: '7d' }
        );

        // Update last login
        await pool.query(
            'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
            [user.id]
        );

        res.json({
            success: true,
            data: {
                token,
                user: {
                    id: user.id,
                    full_name: user.full_name,
                    phone_number: user.phone_number,
                    email: user.email,
                    user_type: user.user_type,
                    is_verified: user.is_verified,
                    is_active: user.is_active,
                    created_at: user.created_at
                }
            }
        });

    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Login failed' 
        });
    }
});

// ============================================
// GET CURRENT USER
// ============================================
router.get('/me', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ 
                success: false,
                error: 'Authentication required' 
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret_key');
        
        const result = await pool.query(
            `SELECT 
                id, 
                full_name, 
                phone_number, 
                email, 
                user_type, 
                is_verified,
                is_active,
                created_at
            FROM users 
            WHERE id = $1`,
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false,
                error: 'User not found' 
            });
        }

        res.json({
            success: true,
            user: result.rows[0]
        });

    } catch (error) {
        console.error('❌ Get user error:', error);
        res.status(401).json({ 
            success: false,
            error: 'Invalid token' 
        });
    }
});

module.exports = router;