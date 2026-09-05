const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// Register
router.post('/register', async (req, res) => {
    try {
        const { phone_number, email, full_name, password, user_type } = req.body;
        
        // Validate
        if (!phone_number || !full_name || !password) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Check if user exists
        const existingUser = await pool.query(
            'SELECT id FROM users WHERE phone_number = $1 OR email = $2',
            [phone_number, email]
        );
        
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'User already exists' });
        }
        
        // Hash password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        
        // Insert user
        const result = await pool.query(
            `INSERT INTO users (phone_number, email, full_name, password_hash, user_type)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, phone_number, email, full_name, user_type, is_verified`,
            [phone_number, email || null, full_name, password_hash, user_type || 'customer']
        );
        
        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Registration failed', details: error.message });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { phone_number, password } = req.body;
        
        if (!phone_number || !password) {
            return res.status(400).json({ error: 'Phone number and password required' });
        }
        
        // Get user
        const result = await pool.query(
            'SELECT * FROM users WHERE phone_number = $1',
            [phone_number]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        
        // Check password
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid credentials' });
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
            token,
            user: {
                id: user.id,
                full_name: user.full_name,
                phone_number: user.phone_number,
                email: user.email,
                user_type: user.user_type,
                is_verified: user.is_verified
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Get current user
router.get('/me', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret_key');
        const result = await pool.query(
            'SELECT id, full_name, phone_number, email, user_type, is_verified FROM users WHERE id = $1',
            [decoded.userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Get user error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
});

module.exports = router;