const { Pool } = require('pg');
require('dotenv').config();

// Use DATABASE_URL if available, otherwise build from individual variables
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Or use individual variables if DATABASE_URL is not set
// const pool = new Pool({
//     host: process.env.DB_HOST,
//     port: parseInt(process.env.DB_PORT || '5432'),
//     database: process.env.DB_NAME,
//     user: process.env.DB_USER,
//     password: process.env.DB_PASSWORD,
//     ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
// });

// Test connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection failed:', err.stack);
    } else {
        console.log('✅ Database connected successfully');
        release();
    }
});

module.exports = { pool };