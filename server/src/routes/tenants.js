const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize, superAdminOnly } = require('../middleware/auth');
const momoConfig = require('../config/momo');

const router = express.Router();

// ── Validation for tenant-authored presentation fields ─────────────────────
// These end up interpolated into HTML we serve (client/api/seo.js) and into CSS
// custom properties (TenantThemeInjector). The renderer escapes them, but a
// value that cannot be malformed in the first place is one fewer thing
// depending on that escaping staying correct.

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// ── Currency ───────────────────────────────────────────────────────────────
// Currency is a STORE-level setting, not a per-product one, because the money
// path only ever handles one currency at a time: an order carries a single
// `total_amount`, a tenant has a single wallet balance, and a MoMo
// request-to-pay takes exactly one currency. Per-product currency would need FX
// rates on every cart total and a wallet per currency.
//
// It is also not merely a label. momoClient sends `momoConfig.currency` — the
// platform's settlement currency — so a store displaying USD while MoMo settles
// in RWF would show a price it cannot actually charge. The setting is therefore
// pinned to the settlement currency and validated on write.
const SETTLEMENT_CURRENCY = momoConfig.currency;

/** ISO 4217 codes: three uppercase letters. */
const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * The store's currency.
 *
 * A stored value is honoured only if we can actually settle in it. Existing
 * tenants predate this setting — the seeded demo store carries
 * `settings.currency = 'USD'` from before MoMo existed — and returning that
 * while the platform collects in RWF is precisely the quote-one-amount,
 * charge-another failure this is meant to prevent. A stale or unsettleable
 * value is therefore ignored rather than trusted, so no storefront can display
 * a price we cannot take.
 */
function tenantCurrency(settings) {
  const stored = settings?.currency;
  if (stored && String(stored).toUpperCase() === SETTLEMENT_CURRENCY) {
    return SETTLEMENT_CURRENCY;
  }
  return SETTLEMENT_CURRENCY;
}

/** True when a tenant has a stored currency we cannot settle in. */
function hasStaleCurrency(settings) {
  const stored = settings?.currency;
  return Boolean(stored) && String(stored).toUpperCase() !== SETTLEMENT_CURRENCY;
}
const TWITTER_HANDLE = /^@?[A-Za-z0-9_]{1,15}$/;
const OG_LOCALE = /^[a-z]{2}(?:_[A-Z]{2})?$/;

const TEXT_LIMITS = {
  seoTitle: 70,
  seoDescription: 200,
  seoKeywords: 250,
  author: 100,
};

/** An https URL, or null. Rules out javascript:/data: before they are stored. */
function cleanUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return undefined; // signals "invalid"
    return url.href;
  } catch {
    return undefined;
  }
}

/** Trimmed, length-capped plain text with control characters removed. */
function cleanText(value, max) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

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

// GET /api/tenants/analytics — Platform-wide analytics (Super Admin)
router.get('/analytics', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { count: totalTenants } = await supabase.from('tenants').select('*', { count: 'exact', head: true });
    const { count: activeTenants } = await supabase.from('tenants').select('*', { count: 'exact', head: true }).eq('active', true);

    const { data: wallets } = await supabase.from('wallets').select('available_balance, pending_balance');
    let heldBalances = 0;
    let clearedBalances = 0;
    for (const w of (wallets || [])) {
      heldBalances += parseFloat(w.pending_balance || 0);
      clearedBalances += parseFloat(w.available_balance || 0);
    }

    const { data: orders } = await supabase.from('orders')
      .select('total_amount, created_at')
      .eq('payment_status', 'paid')
      .not('status', 'eq', 'rejected');

    let totalRevenue = 0;
    const dailyRevenue = {};
    for (const o of (orders || [])) {
      const amt = parseFloat(o.total_amount || 0);
      totalRevenue += amt;
      const date = o.created_at.split('T')[0];
      dailyRevenue[date] = (dailyRevenue[date] || 0) + amt;
    }
    
    // Convert dailyRevenue to array for chart, sorted by date
    const revenueHistory = Object.entries(dailyRevenue)
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const { count: totalOrders } = await supabase.from('orders').select('*', { count: 'exact', head: true });

    res.json({
      analytics: {
        totalTenants: totalTenants || 0,
        activeTenants: activeTenants || 0,
        heldBalances,
        clearedBalances,
        totalRevenue,
        totalOrders: totalOrders || 0,
        revenueHistory
      }
    });
  } catch (err) {
    console.error('Super admin analytics error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
        currency: tenantCurrency(tenant.settings),
        // What the platform's MoMo account actually settles in. Surfaced so an
        // admin can see why the currency is fixed rather than assuming the
        // field is broken.
        settlementCurrency: SETTLEMENT_CURRENCY,
        currencyLocked: true,
        // A leftover currency from before this setting was enforced. It is not
        // being used — prices already show the settlement currency — but the
        // admin should know their stored value was overridden rather than
        // wonder why the field does not say what the database says.
        staleCurrency: hasStaleCurrency(tenant.settings) ? String(tenant.settings.currency).toUpperCase() : null,
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
      const { settlementMode, payoutPhone, acceptedPaymentMethods, currency } = req.body;

      if (currency !== undefined) {
        const code = String(currency).toUpperCase();
        if (!CURRENCY_CODE.test(code)) {
          return res.status(400).json({ error: 'Currency must be a 3-letter ISO code, e.g. RWF' });
        }
        if (code !== SETTLEMENT_CURRENCY) {
          return res.status(400).json({
            error: `This platform settles in ${SETTLEMENT_CURRENCY}, so your store must price in ${SETTLEMENT_CURRENCY}. `
              + 'Displaying a different currency would show customers a price we cannot charge them.',
            code: 'CURRENCY_NOT_SETTLEABLE',
            settlementCurrency: SETTLEMENT_CURRENCY,
          });
        }
      }

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
        // Currency sits at the top of settings rather than under `payments`: it
        // governs how every price is displayed, not just how money is taken.
        ...(currency !== undefined ? { currency: String(currency).toUpperCase() } : {}),
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
    // Slug and name only: this feeds the public sitemap. created_at was also
    // being returned, which published the full customer list *and* the signup
    // timeline to anyone who curled it.
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('slug, name')
      .eq('active', true)
      .order('name', { ascending: true })
      .limit(5000);

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
        theme: tenant.settings?.theme || {},
        currency: tenantCurrency(tenant.settings),
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

    const clean = {};

    for (const [field, value] of Object.entries({ seoTitle, seoDescription, seoKeywords, author })) {
      if (value !== undefined) clean[field] = cleanText(value, TEXT_LIMITS[field]);
    }

    if (faviconUrl !== undefined) {
      const url = cleanUrl(faviconUrl);
      if (url === undefined) {
        return res.status(400).json({ error: 'faviconUrl must be an https URL' });
      }
      clean.faviconUrl = url;
    }

    if (themeColor !== undefined && !HEX_COLOR.test(String(themeColor))) {
      return res.status(400).json({ error: 'themeColor must be a hex colour like #DC2626' });
    }
    if (themeColor !== undefined) clean.themeColor = String(themeColor);

    if (twitterHandle !== undefined && twitterHandle !== '' && !TWITTER_HANDLE.test(String(twitterHandle))) {
      return res.status(400).json({ error: 'twitterHandle must be a Twitter/X handle, e.g. @yourshop' });
    }
    if (twitterHandle !== undefined) clean.twitterHandle = String(twitterHandle);

    if (ogLocale !== undefined && !OG_LOCALE.test(String(ogLocale))) {
      return res.status(400).json({ error: 'ogLocale must look like "en" or "en_US"' });
    }
    if (ogLocale !== undefined) clean.ogLocale = String(ogLocale);

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
        ...clean,
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

// GET /api/tenants/me/theme — read back current theme settings
router.get('/me/theme', authenticate, authorize('admin', 'manager'), async (req, res) => {
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
      theme: tenant.settings?.theme || {},
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/tenants/me/theme — update current theme settings
router.patch('/me/theme', authenticate, authorize('admin', 'manager'), async (req, res) => {
  try {
    // Theme values are written into CSS custom properties on the client, so
    // restrict them to hex — that keeps url(), var() and stray punctuation out
    // of the stylesheet rather than relying on the browser to reject them.
    const theme = {};
    for (const key of ['primaryColor', 'accentColor', 'secondaryColor', 'backgroundColor', 'textColor']) {
      const value = req.body[key];
      if (value === undefined) continue;
      if (value === null || value === '') { theme[key] = null; continue; }
      if (!HEX_COLOR.test(String(value))) {
        return res.status(400).json({ error: `${key} must be a hex colour like #DC2626` });
      }
      theme[key] = String(value);
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
      theme: {
        ...(current.settings?.theme || {}),
        ...theme,
      },
    };

    const { data: tenant, error } = await supabase
      .from('tenants')
      .update({ settings: nextSettings })
      .eq('id', req.user.tenant_id)
      .select('id, name, settings')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update theme settings' });
    }

    res.json({ theme: tenant.settings?.theme || {} });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;