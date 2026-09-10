const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { resolveTenant } = require('./middleware/tenant');
const { globalLimiter, webhookLimiter } = require('./middleware/rateLimit');

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
const reviewsRoutes = require('./routes/reviews');
const complaintsRoutes = require('./routes/complaints');
const categoriesRoutes = require('./routes/categories');
const uploadsRoutes = require('./routes/uploads');
const platformRoutes = require('./routes/platform');

const app = express();

// Render (and any other PaaS) terminates TLS at a proxy, so without this every
// request appears to come from the proxy's address — which would make the rate
// limiters below count the whole internet as one client, and would make
// `secure` cookies look insecure. `1` = trust exactly one proxy hop.
app.set('trust proxy', 1);

// Middleware
app.use(helmet({
  // This is a JSON API on its own origin; it serves no HTML and embeds nothing.
  // A restrictive default-src costs nothing here and blocks a stray HTML error
  // page from ever loading anything.
  contentSecurityPolicy: {
    directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  },
  // The client is on a different host (Vercel) and links to API-hosted images
  // are not a thing, so the strictest CORP is fine.
  crossOriginResourcePolicy: { policy: 'same-site' },
  hsts: { maxAge: 15552000, includeSubDomains: true },
}));

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));

// 10mb was sized for image payloads that no longer go through this API — images
// are uploaded straight to storage via a signed URL (routes/uploads.js). Every
// remaining endpoint takes small JSON, and an oversized body is the cheap half
// of a DoS, so keep the ceiling low.
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// Backstop limiter for every route. Tighter per-route limiters are applied at
// their own mount points below and run first.
app.use('/api', globalLimiter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Tenant routes (super admin — no tenant scoping)
app.use('/api/tenants', tenantsRoutes);

// Platform administration (super admin). Deliberately not tenant-scoped: these
// read and write across every store, so there is no slug to resolve.
app.use('/api/platform', platformRoutes);

// MoMo callback — no tenant scoping (identified by reference id) and no
// auth (MTN calls this directly, not a logged-in user).
app.use('/api/momo', webhookLimiter, momoWebhookRoutes);

// All other routes require tenant resolution
app.use('/api/auth', resolveTenant, authRoutes);
app.use('/api/menu', resolveTenant, menuRoutes);
app.use('/api/categories', resolveTenant, categoriesRoutes);
app.use('/api/addons', resolveTenant, addonsRoutes);
app.use('/api/orders', resolveTenant, ordersRoutes);
app.use('/api/delivery', resolveTenant, deliveryRoutes);
app.use('/api/analytics', resolveTenant, analyticsRoutes);
app.use('/api/notifications', resolveTenant, notificationsRoutes);
app.use('/api/wallet', resolveTenant, walletRoutes);
app.use('/api/refunds', resolveTenant, refundsRoutes);
app.use('/api/reviews', resolveTenant, reviewsRoutes);
app.use('/api/complaints', resolveTenant, complaintsRoutes);
app.use('/api/uploads', resolveTenant, uploadsRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, _next) => {
  // Supabase unreachable: upstream and transient, not our bug. A 503 with
  // Retry-After tells the caller to try again, instead of a 500 that reads as
  // "this is broken" — or, without the client timeout, no answer at all until
  // the platform gateway returns a 502.
  if (err?.code === 'SUPABASE_TIMEOUT') {
    console.error('Upstream timeout:', err.message);
    res.set('Retry-After', '30');
    return res.status(503).json({
      error: 'Temporarily unavailable. Please try again in a moment.',
      code: 'UPSTREAM_UNAVAILABLE',
    });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;