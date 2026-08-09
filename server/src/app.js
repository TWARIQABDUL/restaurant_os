const express = require('express');
const cors = require('cors');
const { resolveTenant } = require('./middleware/tenant');

const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const addonsRoutes = require('./routes/addons');
const ordersRoutes = require('./routes/orders');
const deliveryRoutes = require('./routes/delivery');
const analyticsRoutes = require('./routes/analytics');
const tenantsRoutes = require('./routes/tenants');
const notificationsRoutes = require('./routes/notifications');
const walletRoutes = require('./routes/wallet');
const refundsRoutes = require('./routes/refunds');
const momoWebhookRoutes = require('./routes/momoWebhook');

const app = express();

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Tenant routes (super admin — no tenant scoping)
app.use('/api/tenants', tenantsRoutes);

// MoMo callback — no tenant scoping (identified by reference id) and no
// auth (MTN calls this directly, not a logged-in user).
app.use('/api/momo', momoWebhookRoutes);

// All other routes require tenant resolution
app.use('/api/auth', resolveTenant, authRoutes);
app.use('/api/menu', resolveTenant, menuRoutes);
app.use('/api/addons', resolveTenant, addonsRoutes);
app.use('/api/orders', resolveTenant, ordersRoutes);
app.use('/api/delivery', resolveTenant, deliveryRoutes);
app.use('/api/analytics', resolveTenant, analyticsRoutes);
app.use('/api/notifications', resolveTenant, notificationsRoutes);
app.use('/api/wallet', resolveTenant, walletRoutes);
app.use('/api/refunds', resolveTenant, refundsRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;