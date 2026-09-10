const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize, superAdminOnly } = require('../middleware/auth');
const momoConfig = require('../config/momo');
const bcrypt = require('bcryptjs');
const platformSettings = require('../services/platformSettings');

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
function tenantCurrency(settings, allowed) {
  const stored = String(settings?.currency || '').toUpperCase();
  if (!stored) return SETTLEMENT_CURRENCY;
  // A currency the platform no longer supports is ignored rather than trusted:
  // super admin removing it must not leave a storefront quoting in it.
  if (allowed && !allowed.includes(stored)) return SETTLEMENT_CURRENCY;
  return stored;
}

/** A stored currency the platform no longer allows. */
function staleCurrency(settings, allowed) {
  const stored = String(settings?.currency || '').toUpperCase();
  if (!stored || !allowed) return null;
  return allowed.includes(stored) ? null : stored;
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
      .select('total_amount, created_at, tenant_id')
      .eq('payment_status', 'paid')
      .not('status', 'eq', 'rejected');

    // Revenue is grouped by currency, not summed flat.
    //
    // Now that stores can price in different currencies, adding 1,000 KES to
    // 1,000 EUR produces a number that means nothing. The headline figure is
    // the settlement currency — the one every store's mobile money passes
    // through — and anything else is reported separately rather than folded in.
    const allowedForAnalytics = await platformSettings.allowedCurrencies();
    const { data: allTenants } = await supabase.from('tenants').select('id, settings');
    const currencyByTenant = new Map(
      (allTenants || []).map((t) => [t.id, tenantCurrency(t.settings, allowedForAnalytics)])
    );

    const revenueByCurrency = {};
    let totalRevenue = 0;
    const dailyRevenue = {};

    for (const o of (orders || [])) {
      const amt = parseFloat(o.total_amount || 0);
      const cur = currencyByTenant.get(o.tenant_id) || SETTLEMENT_CURRENCY;
      revenueByCurrency[cur] = (revenueByCurrency[cur] || 0) + amt;

      // The headline total and the chart cover the settlement currency only, so
      // the trend line is a like-for-like comparison rather than a mixed sum.
      if (cur === SETTLEMENT_CURRENCY) {
        totalRevenue += amt;
        const date = o.created_at.split('T')[0];
        dailyRevenue[date] = (dailyRevenue[date] || 0) + amt;
      }
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
        // What totalRevenue and revenueHistory are denominated in.
        currency: SETTLEMENT_CURRENCY,
        // Every currency in play, so a store priced in something else is not
        // silently missing from the platform's numbers.
        revenueByCurrency,
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

    const allowed = await platformSettings.allowedCurrencies();
    const currency = tenantCurrency(tenant.settings, allowed);

    res.json({
      payment_settings: {
        settlementMode: tenant.settings?.payments?.settlementMode || 'manual',
        payoutPhone: tenant.settings?.payments?.payoutPhone || '',
        acceptedPaymentMethods: tenant.settings?.payments?.acceptedPaymentMethods || ['cash_on_delivery', 'mobile_money', 'bank_transfer'],
        currency,
        // The list super admin supports. The UI offers exactly these and
        // nothing else, so a store cannot type in a currency the platform
        // does not carry.
        allowedCurrencies: allowed,
        // What MTN actually settles this platform's account in. Mobile money is
        // only collectable in this currency, so a store priced in anything else
        // can still take cash and bank transfer but not MoMo.
        settlementCurrency: SETTLEMENT_CURRENCY,
        momoAvailable: platformSettings.isSettleable(currency),
        // A stored currency the platform has since stopped supporting. Not in
        // use — prices already fall back — but the admin should know rather
        // than wonder why the field disagrees with the database.
        staleCurrency: staleCurrency(tenant.settings, allowed),
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

      const allowed = await platformSettings.allowedCurrencies();
      let nextCurrency;

      if (currency !== undefined) {
        const code = String(currency).toUpperCase();
        if (!CURRENCY_CODE.test(code)) {
          return res.status(400).json({ error: 'Currency must be a 3-letter ISO code, e.g. RWF' });
        }
        if (!allowed.includes(code)) {
          return res.status(400).json({
            error: `This platform does not support ${code}. Choose one of: ${allowed.join(', ')}.`,
            code: 'CURRENCY_NOT_ALLOWED',
            allowedCurrencies: allowed,
          });
        }
        nextCurrency = code;
      }

      if (settlementMode !== undefined && !['manual', 'auto'].includes(settlementMode)) {
        return res.status(400).json({ error: 'settlementMode must be "manual" or "auto"' });
      }

      const validMethods = ['cash_on_delivery', 'mobile_money', 'bank_transfer'];
      let methods = acceptedPaymentMethods;

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

      // Mobile money gating.
      //
      // momoClient charges in the platform's settlement currency, so a store
      // priced in anything else cannot collect through MoMo — it would show one
      // amount and charge another. Cash and bank transfer are untouched: no
      // settlement is involved, so they work in any allowed currency.
      //
      // Evaluated against the END state, not just what this request changes, so
      // switching currency and payment methods in one save is judged together.
      const effectiveCurrency = nextCurrency || tenantCurrency(current.settings, allowed);
      const momoCollectable = platformSettings.isSettleable(effectiveCurrency);

      let droppedMomo = false;
      if (!momoCollectable) {
        const base = methods !== undefined
          ? methods
          : (current.settings?.payments?.acceptedPaymentMethods || validMethods);

        if (base.includes('mobile_money')) {
          const filtered = base.filter((m) => m !== 'mobile_money');
          if (filtered.length === 0) {
            return res.status(400).json({
              error: `Mobile money cannot collect in ${effectiveCurrency} — this platform settles in `
                + `${SETTLEMENT_CURRENCY}. Enable cash on delivery or bank transfer before switching `
                + 'currency, so your store still has a way to take payment.',
              code: 'NO_PAYMENT_METHOD_LEFT',
              settlementCurrency: SETTLEMENT_CURRENCY,
            });
          }
          methods = filtered;
          droppedMomo = true;
        }
      }

      const nextSettings = {
        ...current.settings,
        // Currency sits at the top of settings rather than under `payments`: it
        // governs how every price is displayed, not just how money is taken.
        ...(nextCurrency !== undefined ? { currency: nextCurrency } : {}),
        payments: {
          ...(current.settings?.payments || {}),
          ...(settlementMode !== undefined ? { settlementMode } : {}),
          ...(payoutPhone !== undefined ? { payoutPhone } : {}),
          ...(methods !== undefined ? { acceptedPaymentMethods: methods } : {}),
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

      res.json({
        tenant,
        currency: effectiveCurrency,
        momoAvailable: momoCollectable,
        // Say so plainly rather than letting the seller discover mobile money
        // has quietly vanished from their checkout.
        notice: droppedMomo
          ? `Mobile money was turned off because it cannot collect in ${effectiveCurrency}. `
            + `This platform settles mobile money in ${SETTLEMENT_CURRENCY}.`
          : undefined,
      });
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

    const allowedList = await platformSettings.allowedCurrencies();
    const publicCurrency = tenantCurrency(tenant.settings, allowedList);

    // Never advertise a payment method that cannot actually take money in this
    // store's currency — the storefront renders exactly this list.
    const configured = tenant.settings?.payments?.acceptedPaymentMethods
      || ['cash_on_delivery', 'mobile_money', 'bank_transfer'];
    const offered = platformSettings.isSettleable(publicCurrency)
      ? configured
      : configured.filter((m) => m !== 'mobile_money');

    res.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        logo_url: tenant.logo_url,
        seo: tenant.settings?.seo || {},
        theme: tenant.settings?.theme || {},
        currency: publicCurrency,
        acceptedPaymentMethods: offered
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

// ── Super admin: one store in detail ───────────────────────────────────────
//
// Everything a super admin needs to answer "how is this store doing, and is
// anything stuck?" without logging in as them.
router.get('/:id/overview', authenticate, superAdminOnly, async (req, res) => {
  try {
    const tenantId = req.params.id;

    const { data: tenant } = await supabase
      .from('tenants')
      .select('id, name, slug, logo_url, active, settings, created_at')
      .eq('id', tenantId)
      .maybeSingle();

    if (!tenant) return res.status(404).json({ error: 'Store not found' });

    const overviewAllowed = await platformSettings.allowedCurrencies();

    const [orders, wallet, staff, products, pendingRefunds, lastOrder] = await Promise.all([
      supabase.from('orders')
        .select('status, payment_status, total_amount, created_at')
        .eq('tenant_id', tenantId),
      supabase.from('wallets')
        .select('available_balance, pending_balance, currency')
        .eq('tenant_id', tenantId).maybeSingle(),
      supabase.from('users')
        .select('id, name, email, role, created_at')
        .eq('tenant_id', tenantId).in('role', ['admin', 'manager', 'delivery'])
        .order('role'),
      supabase.from('menu_items')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
      supabase.from('refund_requests')
        .select('id, order:orders!inner(tenant_id)', { count: 'exact', head: true })
        .eq('status', 'pending').eq('order.tenant_id', tenantId),
      supabase.from('orders')
        .select('created_at').eq('tenant_id', tenantId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);

    const all = orders.data || [];
    const paid = all.filter((o) => o.payment_status === 'paid' && o.status !== 'rejected');
    const revenue = paid.reduce((sum, o) => sum + parseFloat(o.total_amount || 0), 0);

    const byStatus = {};
    for (const o of all) byStatus[o.status] = (byStatus[o.status] || 0) + 1;

    res.json({
      overview: {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          logo_url: tenant.logo_url,
          active: tenant.active,
          created_at: tenant.created_at,
          currency: tenantCurrency(tenant.settings, overviewAllowed),
          storedCurrency: tenant.settings?.currency || null,
          settlementMode: tenant.settings?.payments?.settlementMode || 'manual',
          payoutPhone: tenant.settings?.payments?.payoutPhone || null,
          acceptedPaymentMethods: tenant.settings?.payments?.acceptedPaymentMethods
            || ['cash_on_delivery', 'mobile_money', 'bank_transfer'],
        },
        orders: {
          total: all.length,
          paid: paid.length,
          byStatus,
          revenue,
          lastOrderAt: lastOrder.data?.created_at || null,
        },
        wallet: wallet.data || { available_balance: 0, pending_balance: 0, currency: tenantCurrency(tenant.settings, overviewAllowed) },
        productCount: products.count ?? 0,
        pendingRefunds: pendingRefunds.count ?? 0,
        staff: staff.data || [],
      },
    });
  } catch (err) {
    console.error('Tenant overview error:', err.message);
    res.status(500).json({ error: 'Failed to load store overview' });
  }
});

// POST /api/tenants/:id/staff/:userId/reset-password — super admin resets a
// store user's password.
//
// Deliberately narrow: it will not touch another super_admin, so this cannot be
// used to take over a peer account. The new password is returned once, for the
// super admin to hand over — there is no email delivery here, and storing it
// anywhere would be worse than showing it once.
router.post(
  '/:id/staff/:userId/reset-password',
  authenticate,
  superAdminOnly,
  [body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { data: target } = await supabase
        .from('users')
        .select('id, name, email, role, tenant_id')
        .eq('id', req.params.userId)
        .eq('tenant_id', req.params.id)
        .maybeSingle();

      if (!target) return res.status(404).json({ error: 'User not found in this store' });
      if (target.role === 'super_admin') {
        return res.status(403).json({ error: 'Super admin passwords cannot be reset from here' });
      }

      const passwordHash = await bcrypt.hash(req.body.password, 12);
      const { error } = await supabase
        .from('users')
        .update({ password_hash: passwordHash })
        .eq('id', target.id);

      if (error) return res.status(500).json({ error: 'Failed to reset password' });

      console.log(`Super admin ${req.user.id} reset the password for user ${target.id} (${target.role})`);
      res.json({ ok: true, user: { id: target.id, name: target.name, email: target.email, role: target.role } });
    } catch (err) {
      console.error('Reset password error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;