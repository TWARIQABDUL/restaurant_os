const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register — Customer self-registration
router.post(
  '/register',
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

      const token = jwt.sign(
        { userId: user.id, tenantId, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
      );

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

      // 4. Generate Auth Token
      const token = jwt.sign(
        { userId: user.id, tenantId: tenant.id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
      );

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

      const { data: users, error } = await supabase
        .from('users')
        .select(`
          id, name, email, password_hash, role, phone, plate_number, tenant_id,
          tenants ( slug )
        `)
        .eq('email', email);

      if (error || !users || users.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      let user = null;
      for (const u of users) {
        const validPassword = await bcrypt.compare(password, u.password_hash);
        if (validPassword) {
          user = u;
          break;
        }
      }

      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = jwt.sign(
        { userId: user.id, tenantId: user.tenant_id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
      );

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
