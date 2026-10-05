// 📁 backend/server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================
// Security headers
// ============================================
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ============================================
// CORS — explicit allowed origins
// ============================================
const allowedOrigins = [
  // Local development
  'http://localhost:5173',   // Vite dev server
  'http://localhost:4173',   // Vite preview server
  'http://localhost:3000',   // CRA / general dev
  'http://localhost:19006',  // Expo web
  'http://localhost:8081',   // Metro / RN debugger

  // Production admin panel
  'https://admingasmtaani.vercel.app',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no Origin header
    // (mobile apps, curl, server-to-server, Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Allow any Vercel preview URL for this project
    if (/^https:\/\/admingasmtaani[a-z0-9-]*\.vercel\.app$/.test(origin)) {
      return callback(null, true);
    }

    console.warn('🚫 CORS blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// Static assets (product images, logos, etc.)
// ============================================
// Files in backend/assets/ are served at /assets/*
// e.g. backend/assets/products/progas-13kg.jpg
//   → https://<host>/assets/products/progas-13kg.jpg
app.use(
  '/assets',
  express.static(path.join(__dirname, '..', 'assets'), {
    maxAge: '7d',
    immutable: false,
    fallthrough: true,
  })
);

// Files uploaded at runtime (agent documents, etc.)
//   → https://<host>/uploads/agent-documents/...
app.use(
  '/uploads',
  express.static(path.join(__dirname, '..', 'uploads'), {
    maxAge: '7d',
    immutable: false,
    fallthrough: true,
  })
);

// ============================================
// Routes
// ============================================
const authRoutes          = require('./routes/auth.routes');
const adminAuthRoutes     = require('./routes/adminAuth.routes');
const customerRoutes      = require('./routes/customer.routes');
const productRoutes       = require('./routes/product.routes');
const agentRoutes         = require('./routes/agent.routes');
const orderRoutes         = require('./routes/order.routes');
const adminRoutes         = require('./routes/admin.routes');
const paymentRoutes       = require('./routes/payment.routes');
const quoteRoutes         = require('./routes/quote.routes');
const chatRoutes          = require('./routes/chat.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const agoraRoutes         = require('./routes/agora.routes');
const businessHoursRoutes = require('./routes/businessHours.routes');
const notificationPreferencesRoutes = require('./routes/notificationPreferences.routes');
const agentDocumentsRoutes = require('./routes/agentDocuments.routes');

// Mount admin auth BEFORE /api/admin so /api/admin/auth/* takes priority
app.use('/api/admin/auth', adminAuthRoutes);

// Existing routes
app.use('/api/auth',      authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/products',  productRoutes);
app.use('/api/chat',      chatRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/agora', agoraRoutes);

// ⚠️  business-hours and documents must be mounted BEFORE /api/agents so
//     they aren't shadowed by an /:id route inside agent.routes.js.

app.use('/api/agents/business-hours', businessHoursRoutes);

app.use('/api/agents', agentDocumentsRoutes);   // ← handles GET /documents and POST /upload-docs

// Now mount the general agents router
app.use('/api/agents',    agentRoutes);

// Notification preferences — mounted on its own path, no shadowing risk
app.use('/api/users/notification-preferences', notificationPreferencesRoutes);

// ⚠️  quoteRoutes must be mounted BEFORE orderRoutes so /api/orders/quote
//     isn't shadowed by the catch-all GET /:orderId in order.routes.js
app.use('/api/orders',    quoteRoutes);
app.use('/api/orders',    orderRoutes);

app.use('/api/admin',     adminRoutes);
app.use('/api/payments',  paymentRoutes);

// ============================================
// Health check
// ============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Gas Mtaani API is running',
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// 404 handler
// ============================================
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ============================================
// Error handler
// ============================================
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ============================================
// Start server
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Gas Mtaani API running on port ${PORT}`);
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔑 Admin auth:   http://localhost:${PORT}/api/admin/auth`);
  console.log(`👤 Customers:    http://localhost:${PORT}/api/customers`);
  console.log(`🔑 Admin routes: http://localhost:${PORT}/api/admin`);
  console.log(`🖼  Assets:      http://localhost:${PORT}/assets/*`);
  console.log(`📤 Uploads:      http://localhost:${PORT}/uploads/*`);
  console.log(`💬 Quotes:       http://localhost:${PORT}/api/orders/quote`);
  console.log(`🔔 Notifications: http://localhost:${PORT}/api/notifications`);
  console.log(`📞 Agora:        http://localhost:${PORT}/api/agora`);
  console.log(`🕒 Business hrs: http://localhost:${PORT}/api/agents/business-hours`);
  console.log(`📄 Docs:         http://localhost:${PORT}/api/agents/documents`);
  console.log(`⚙️  Prefs:        http://localhost:${PORT}/api/users/notification-preferences`);
});