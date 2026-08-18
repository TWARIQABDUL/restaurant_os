const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize, superAdminOnly } = require('../middleware/auth');

const router = express.Router();

// POST /api/tenants — Create tenant (Super Admin)
router.post(
  '/',
  authenticate,
  superAdminOnly,
  [
    body('name').trim().notEmpty().withMessage('Restaurant name is required'),
    body('slug').trim().notEmpty().withMessage('Slug is required')
      .matches(/^[a-z0-9-]+$/).withMessage('Slug must be lowercase alphanumeric with hyphens'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, slug, logo_url, settings } = req.body;

      const { data: tenant, error } = await supabase
        .from('tenants')
        .insert({
          name,
          slug,
          logo_url: logo_url || null,
          settings: settings || {},
          active: true,
        })
        .select('*')
        .single();

      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'Slug already taken' });
        }
        return res.status(500).json({ error: 'Failed to create tenant' });
      }

      res.status(201).json({ tenant });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/tenants — List all tenants (Super Admin)
router.get('/', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch tenants' });
    }

    res.json({ tenants: tenants || [] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/tenants/:id — Update tenant (Super Admin)
router.put('/:id', authenticate, superAdminOnly, async (req, res) => {
  try {
    const updates = {};
    const allowedFields = ['name', 'slug', 'logo_url', 'settings'];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    const { data: tenant, error } = await supabase
      .from('tenants')
      .update(updates)
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.json({ tenant });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tenants/me/payment-settings — read back current settlement mode + payout phone
router.get('/me/payment-settings', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('id, name, settings')
      .eq('id', req.user.tenant_id)
      .single();

    if (error || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.json({
      payment_settings: {
        settlementMode: tenant.settings?.payments?.settlementMode || 'manual',
        payoutPhone: tenant.settings?.payments?.payoutPhone || '',
        acceptedPaymentMethods: tenant.settings?.payments?.acceptedPaymentMethods || ['cash_on_delivery', 'mobile_money', 'bank_transfer'],
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/tenants/me/payment-settings — tenant admin configures their OWN
// settlement mode + payout number. Scoped via the authenticated user's own
// tenant_id (not superAdminOnly) since this route group isn't slug-resolved.
router.patch(
  '/me/payment-settings',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const { settlementMode, payoutPhone, acceptedPaymentMethods } = req.body;

      if (settlementMode !== undefined && !['manual', 'auto'].includes(settlementMode)) {
        return res.status(400).json({ error: 'settlementMode must be "manual" or "auto"' });
      }

      const validMethods = ['cash_on_delivery', 'mobile_money', 'bank_transfer'];
      if (acceptedPaymentMethods !== undefined) {
        if (!Array.isArray(acceptedPaymentMethods) || acceptedPaymentMethods.length === 0) {
          return res.status(400).json({ error: 'At least one payment method must be enabled' });
        }
        const invalid = acceptedPaymentMethods.filter(m => !validMethods.includes(m));
        if (invalid.length > 0) {
          return res.status(400).json({ error: `Invalid payment methods: ${invalid.join(', ')}` });
        }
      }

      const { data: current, error: fetchErr } = await supabase
        .from('tenants')
        .select('settings')
        .eq('id', req.user.tenant_id)
        .single();

      if (fetchErr || !current) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const nextSettings = {
        ...current.settings,
        payments: {
          ...(current.settings?.payments || {}),
          ...(settlementMode !== undefined ? { settlementMode } : {}),
          ...(payoutPhone !== undefined ? { payoutPhone } : {}),
          ...(acceptedPaymentMethods !== undefined ? { acceptedPaymentMethods } : {}),
        },
      };

      const { data: tenant, error } = await supabase
        .from('tenants')
        .update({ settings: nextSettings })
        .eq('id', req.user.tenant_id)
        .select('id, name, settings')
        .single();

      if (error) {
        return res.status(500).json({ error: 'Failed to update payment settings' });
      }

      res.json({ tenant });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/tenants/:id/toggle — Activate/deactivate (Super Admin)
router.patch('/:id/toggle', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { data: current } = await supabase
      .from('tenants')
      .select('active')
      .eq('id', req.params.id)
      .single();

    if (!current) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: tenant, error } = await supabase
      .from('tenants')
      .update({ active: !current.active })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to toggle tenant' });
    }

    res.json({ tenant });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tenants/public — List all active tenants (for sitemap)
router.get('/public', async (req, res) => {
  try {
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('slug, name, updated_at')
      .eq('active', true)
      .order('name', { ascending: true });

    if (error) throw error;

    res.json({ tenants: tenants || [] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tenants/public/:slug — Fetch public tenant info (Public)
router.get('/public/:slug', async (req, res) => {
  try {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('id, name, slug, logo_url, settings')
      .eq('slug', req.params.slug)
      .eq('active', true)
      .single();

    if (error || !tenant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    res.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        logo_url: tenant.logo_url,
        seo: tenant.settings?.seo || {},
        acceptedPaymentMethods: tenant.settings?.payments?.acceptedPaymentMethods || ['cash_on_delivery', 'mobile_money', 'bank_transfer']
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tenants/me/seo-settings — read back current seo settings
router.get('/me/seo-settings', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('id, name, settings')
      .eq('id', req.user.tenant_id)
      .single();

    if (error || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.json({
      seo_settings: tenant.settings?.seo || {},
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/tenants/me/seo-settings — tenant admin configures their OWN SEO settings
router.patch('/me/seo-settings', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { 
      seoTitle, seoDescription, seoKeywords, 
      faviconUrl, themeColor, twitterHandle, ogLocale, author 
    } = req.body;

    const { data: current, error: fetchErr } = await supabase
      .from('tenants')
      .select('settings')
      .eq('id', req.user.tenant_id)
      .single();

    if (fetchErr || !current) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const nextSettings = {
      ...current.settings,
      seo: {
        ...(current.settings?.seo || {}),
        ...(seoTitle !== undefined ? { seoTitle } : {}),
        ...(seoDescription !== undefined ? { seoDescription } : {}),
        ...(seoKeywords !== undefined ? { seoKeywords } : {}),
        ...(faviconUrl !== undefined ? { faviconUrl } : {}),
        ...(themeColor !== undefined ? { themeColor } : {}),
        ...(twitterHandle !== undefined ? { twitterHandle } : {}),
        ...(ogLocale !== undefined ? { ogLocale } : {}),
        ...(author !== undefined ? { author } : {}),
      },
    };

    const { data: tenant, error } = await supabase
      .from('tenants')
      .update({ settings: nextSettings })
      .eq('id', req.user.tenant_id)
      .select('id, name, settings')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update SEO settings' });
    }

    res.json({ seo_settings: tenant.settings?.seo || {} });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;