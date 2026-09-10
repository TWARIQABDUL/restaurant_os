const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');
const { issueSession, clearSession, issueSocketTicket } = require('../services/session');
const { authLimiter, signupLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// A real bcrypt hash of a value nobody can supply. Compared against when the
// email doesn't exist, so a miss costs the same work as a wrong password —
// otherwise the response time alone tells an attacker which emails are real.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);

// Slugs that must not become storefronts: they collide with the client's own
// routes (see GLOBAL_ROUTES in client/src/services/api.js), with the Vercel
// rewrites, or would let someone impersonate the platform itself.
const RESERVED_SLUGS = new Set([
  'admin', 'manager', 'delivery', 'super-admin', 'login', 'register', 'logout',
  'api', 'backend', 'www', 'app', 'static', 'assets', 'public', 'track',
  'checkout', 'cart', 'account', 'settings', 'support', 'help', 'billing',
  'sitemap', 'robots', 'favicon', 'restaurant-os', 'security', 'status',
]);

// POST /api/auth/register — Customer self-registration
router.post(
  '/register',
  authLimiter,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('phone').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, password, phone } = req.body;
      const tenantId = req.tenant.id;

      // Check if email already exists for this tenant
      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .eq('tenant_id', tenantId)
        .single();

      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const { data: user, error } = await supabase
        .from('users')
        .insert({
          name,
          email,
          password_hash: passwordHash,
          role: 'customer',
          phone: phone || null,
          tenant_id: tenantId,
        })
        .select('id, name, email, role')
        .single();

      if (error) {
        console.error('Registration error:', error);
        return res.status(500).json({ error: 'Registration failed' });
      }

      // Link any previous guest orders placed with this phone number to the new account
      if (phone) {
        await supabase
          .from('orders')
          .update({ customer_id: user.id })
          .eq('tenant_id', tenantId)
          .eq('guest_phone', phone)
          .is('customer_id', null);
      }

      // Sets the httpOnly session cookie. The token is still returned in the
      // body for pre-migration clients; new clients ignore it.
      const token = issueSession(res, { ...user, tenant_id: tenantId });

      res.status(201).json({ user, token });
    } catch (err) {
      console.error('Register error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/auth/register-tenant — Public self-serve onboarding or Super Admin provisioning
router.post(
  '/register-tenant',
  signupLimiter,
  [
    body('restaurantName').trim().notEmpty().withMessage('Restaurant name is required'),
    body('slug').trim().notEmpty().withMessage('Slug is required')
      .matches(/^[a-z0-9-]+$/).withMessage('Slug must be lowercase alphanumeric with hyphens'),
    body('adminName').trim().notEmpty().withMessage('Admin name is required'),
    body('adminEmail').isEmail().withMessage('Valid admin email is required'),
    body('adminPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { restaurantName, slug, adminName, adminEmail, adminPassword } = req.body;

      if (RESERVED_SLUGS.has(slug)) {
        return res.status(409).json({ error: 'That URL handle is reserved. Please choose another.' });
      }

      // 1. Check if slug already exists
      const { data: existingTenant } = await supabase
        .from('tenants')
        .select('id')
        .eq('slug', slug)
        .single();

      if (existingTenant) {
        return res.status(409).json({ error: 'Slug (URL handle) is already taken' });
      }

      // 2. Create the tenant
      const { data: tenant, error: tenantError } = await supabase
        .from('tenants')
        .insert({
          name: restaurantName,
          slug,
          active: true,
        })
        .select('id, name, slug')
        .single();

      if (tenantError) {
        console.error('Tenant creation error:', tenantError);
        return res.status(500).json({ error: 'Failed to provision tenant' });
      }

      // 3. Create the admin user
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      const { data: user, error: userError } = await supabase
        .from('users')
        .insert({
          name: adminName,
          email: adminEmail,
          password_hash: passwordHash,
          role: 'admin',
          tenant_id: tenant.id,
        })
        .select('id, name, email, role, tenant_id')
        .single();

      if (userError) {
        console.error('Admin creation error:', userError);
        // Fallback: we could delete the tenant here for safety, but Supabase doesn't easily support transactions via the JS client unless via RPC.
        return res.status(500).json({ error: 'Tenant created, but admin creation failed' });
      }

      // 4. Generate Auth Token (httpOnly cookie + body for pre-migration clients)
      const token = issueSession(res, { ...user, tenant_id: tenant.id });

      res.status(201).json({ tenant, user, token });
    } catch (err) {
      console.error('Register Tenant error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/auth/login
router.post(
  '/login',
  authLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password } = req.body;
      const tenantId = req.tenant.id;

      // Scoped to the store this login was made against. Without the tenant
      // filter this fetched every account on the platform sharing the address
      // and bcrypt-compared against each in turn — which turned any storefront
      // into a credential-testing oracle for every other store, and made one
      // login attempt cost N hashes. UNIQUE(email, tenant_id) makes this at
      // most one row.
      const SELECT = `
        id, name, email, password_hash, role, phone, plate_number, tenant_id,
        tenants ( slug )
      `;

      const { data: scopedUser, error } = await supabase
        .from('users')
        .select(SELECT)
        .eq('email', email)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      let candidate = error ? null : scopedUser;

      // super_admin is the one role that legitimately signs in from anywhere:
      // it acts across tenants, and the dashboard it lands on has no slug in
      // the URL, so the store this request resolved to is arbitrary. Restricted
      // to that single role, so it cannot be used to probe ordinary accounts on
      // other stores — which is what the unscoped query above used to allow.
      if (!candidate) {
        const { data: superAdmin } = await supabase
          .from('users')
          .select(SELECT)
          .eq('email', email)
          .eq('role', 'super_admin')
          .maybeSingle();
        candidate = superAdmin || null;
      }

      // Compare against a dummy hash when there's no such user, so a miss costs
      // the same time as a wrong password and the response can't be used to
      // enumerate which addresses are registered.
      const validPassword = await bcrypt.compare(
        password,
        candidate?.password_hash || DUMMY_PASSWORD_HASH
      );

      const user = candidate && validPassword ? candidate : null;

      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = issueSession(res, user);

      const { password_hash, ...userWithoutPassword } = user;
      res.json({ user: userWithoutPassword, token });
    } catch (err) {
      console.error('Login error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/auth/me — Current user profile
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/logout — Clear the session cookie.
// Not authenticated on purpose: an expired or already-invalid session should
// still be able to clean itself up rather than getting a 401.
router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// GET /api/auth/socket-ticket — Short-lived credential for the Socket.io handshake.
//
// Socket.io connects directly to this host rather than through the client's
// same-origin rewrite (Render's static rewrites don't carry WebSockets), so the
// session cookie isn't sent with it. The browser can't read the httpOnly cookie
// to pass the token itself, so it asks for a ticket instead — 60s, single
// purpose, useless as a session.
router.get('/socket-ticket', authenticate, (req, res) => {
  res.json({ ticket: issueSocketTicket(req.user) });
});

// GET /api/auth/staff — Admin list staff members
router.get('/staff', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { data: staff, error } = await supabase
      .from('users')
      .select('id, name, email, role, phone, plate_number, created_at')
      .eq('tenant_id', req.tenant.id)
      .in('role', ['admin', 'manager', 'delivery'])
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Fetch staff error:', error);
      return res.status(500).json({ error: 'Failed to fetch staff members' });
    }

    res.json({ staff });
  } catch (err) {
    console.error('Fetch staff error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/create-staff — Admin creates manager/delivery accounts
router.post(
  '/create-staff',
  authenticate,
  authorize('admin'),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['manager', 'delivery']).withMessage('Role must be manager or delivery'),
    body('phone').optional().trim(),
    body('plate_number').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, password, role, phone, plate_number } = req.body;
      const tenantId = req.tenant.id;

      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .eq('tenant_id', tenantId)
        .single();

      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const { data: user, error } = await supabase
        .from('users')
        .insert({
          name,
          email,
          password_hash: passwordHash,
          role,
          phone: phone || null,
          plate_number: role === 'delivery' ? (plate_number || null) : null,
          tenant_id: tenantId,
        })
        .select('id, name, email, role, phone, plate_number')
        .single();

      if (error) {
        console.error('Create staff error:', error);
        return res.status(500).json({ error: 'Failed to create staff account' });
      }

      res.status(201).json({ user });
    } catch (err) {
      console.error('Create staff error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
