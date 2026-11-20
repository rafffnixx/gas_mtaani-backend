// 📁 backend/server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://localhost:19006',
  'http://localhost:8081',
  'https://admingasmtaani.vercel.app',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
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

// 👈 THE FIX: Only parse JSON if it's NOT a multipart upload
const jsonParser = express.json();
const urlencodedParser = express.urlencoded({ extended: true });

app.use((req, res, next) => {
  if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
    return next(); // Skip JSON parsing for file uploads
  }
  jsonParser(req, res, next);
});

app.use((req, res, next) => {
  if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
    return next();
  }
  urlencodedParser(req, res, next);
});

app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ... (all your existing routes remain exactly the same)

const authRoutes          = require('./routes/auth.routes');
const adminAuthRoutes     = require('./routes/adminAuth.routes');
const customerRoutes      = require('./routes/customer.routes');
const customerWalletRoutes = require('./routes/customerWallet.routes');
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
const marketerRoutes = require('./routes/marketer.routes');

const { startOrderSweeper }        = require('./services/orderSweeper');
const { startGracePeriodScheduler } = require('./services/gracePeriodScheduler');

app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/auth',      authRoutes);
app.use('/api/customers/wallet', customerWalletRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/products',  productRoutes);
app.use('/api/chat',      chatRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/agora', agoraRoutes);
app.use('/api/agents/business-hours', businessHoursRoutes);
app.use('/api/agents', agentDocumentsRoutes);
app.use('/api/agents',    agentRoutes);
app.use('/api/users/notification-preferences', notificationPreferencesRoutes);
app.use('/api/orders',    quoteRoutes);
app.use('/api/orders',    orderRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/payments',  paymentRoutes);
app.use('/api/marketers', marketerRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Gas Mtaani API is running' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
  console.log(`🚀 Gas Mtaani API running on port ${PORT}`);
  startOrderSweeper();
  startGracePeriodScheduler();
});