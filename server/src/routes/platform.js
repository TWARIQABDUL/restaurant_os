const express = require('express');
const supabase = require('../config/supabase');
const momoConfig = require('../config/momo');
const platformSettings = require('../services/platformSettings');
const { authenticate, superAdminOnly } = require('../middleware/auth');

const router = express.Router();

// Every route here is super-admin only and deliberately NOT tenant-scoped:
// these read across all stores. Mounted without resolveTenant (see app.js), so
// req.tenant is undefined and nothing can accidentally scope to a caller-chosen
// store — the queries below are explicit about which tenant they mean.
router.use(authenticate, superAdminOnly);

const CURRENCY_CODE = /^[A-Z]{3}$/;

// ── Settings ───────────────────────────────────────────────────────────────

// GET /api/platform/settings
router.get('/settings', async (req, res) => {
  try {
    const settings = await platformSettings.get();
    res.json({
      settings: {
        allowedCurrencies: settings.allowed_currencies,
        defaultSettlementMode: settings.default_settlement_mode,
        defaultHoldMinutes: settings.default_hold_minutes,
        updatedAt: settings.updated_at,
      },
      // Read-only facts about how the platform actually collects money. Shown
      // so a super admin can see why the settlement currency cannot be edited
      // here: it is whatever MTN settles this account in, and writing another
      // value would only mean charging in a currency the account rejects.
      payments: {
        settlementCurrency: platformSettings.SETTLEMENT_CURRENCY,
        momoEnvironment: momoConfig.environment,
        momoTargetEnvironment: momoConfig.targetEnvironment,
        collectionConfigured: Boolean(momoConfig.collection.apiKey),
        disbursementConfigured: Boolean(momoConfig.disbursement.apiKey),
      },
    });
  } catch (err) {
    console.error('Platform settings read error:', err.message);
    res.status(500).json({ error: 'Failed to load platform settings' });
  }
});

// PATCH /api/platform/settings
router.patch('/settings', async (req, res) => {
  try {
    const { allowedCurrencies, defaultSettlementMode, defaultHoldMinutes } = req.body;
    const patch = {};

    if (allowedCurrencies !== undefined) {
      if (!Array.isArray(allowedCurrencies) || allowedCurrencies.length === 0) {
        return res.status(400).json({ error: 'At least one currency must be allowed' });
      }
      const codes = allowedCurrencies.map((c) => String(c).toUpperCase().trim());
      const invalid = codes.filter((c) => !CURRENCY_CODE.test(c));
      if (invalid.length > 0) {
        return res.status(400).json({
          error: `Not valid ISO 4217 currency codes: ${invalid.join(', ')}. Use three letters, e.g. RWF.`,
        });
      }

      // Removing a currency a store is actively priced in would leave that
      // store unable to save its own settings and its checkout rejecting
      // orders. Name the stores rather than letting it fail later somewhere else.
      const { data: tenants } = await supabase.from('tenants').select('name, slug, settings');
      const stranded = (tenants || [])
        .map((t) => ({ name: t.name, slug: t.slug, currency: String(t.settings?.currency || '').toUpperCase() }))
        .filter((t) => t.currency && !codes.includes(t.currency));

      if (stranded.length > 0) {
        return res.status(409).json({
          error: 'Some stores are priced in a currency you are removing. Change their currency first.',
          code: 'CURRENCY_IN_USE',
          stores: stranded,
        });
      }

      patch.allowed_currencies = codes;
    }

    if (defaultSettlementMode !== undefined) {
      if (!['manual', 'auto'].includes(defaultSettlementMode)) {
        return res.status(400).json({ error: 'Settlement mode must be "manual" or "auto"' });
      }
      patch.default_settlement_mode = defaultSettlementMode;
    }

    if (defaultHoldMinutes !== undefined) {
      const n = parseInt(defaultHoldMinutes, 10);
      if (!Number.isInteger(n) || n < 0 || n > 43200) {
        return res.status(400).json({ error: 'Hold window must be between 0 and 43200 minutes (30 days)' });
      }
      patch.default_hold_minutes = n;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No settings to update' });
    }

    const updated = await platformSettings.update(patch, req.user.id);
    res.json({
      settings: {
        allowedCurrencies: updated.allowed_currencies,
        defaultSettlementMode: updated.default_settlement_mode,
        defaultHoldMinutes: updated.default_hold_minutes,
        updatedAt: updated.updated_at,
      },
    });
  } catch (err) {
    console.error('Platform settings write error:', err.message);
    res.status(500).json({ error: 'Failed to save platform settings' });
  }
});

// ── Operational health ─────────────────────────────────────────────────────

// GET /api/platform/health — where money is stuck, across every store.
router.get('/health', async (req, res) => {
  try {
    const holdMinutes = (await platformSettings.get()).default_hold_minutes;
    const overdueBefore = new Date(Date.now() - holdMinutes * 60_000).toISOString();

    const [pendingRefunds, failedMomo, stuckEscrow, failedWithdrawals, pendingWithdrawals] = await Promise.all([
      supabase.from('refund_requests')
        .select('id, order_id, reason, created_at, order:orders!inner(tracking_code, total_amount, tenant_id, tenant:tenants(name, slug))', { count: 'exact' })
        .eq('status', 'pending').order('created_at', { ascending: true }).limit(20),

      supabase.from('momo_transactions')
        .select('id, type, purpose, amount, currency, failure_reason, created_at, tenant_id', { count: 'exact' })
        .eq('status', 'failed').order('created_at', { ascending: false }).limit(20),

      // Paid, past its hold window, still not released. Normally the scheduler
      // clears these within a tick — a backlog here means settlement is wedged.
      supabase.from('orders')
        .select('id, tracking_code, total_amount, paid_at, tenant_id, tenant:tenants(name, slug)', { count: 'exact' })
        .eq('settlement_status', 'pending').not('paid_at', 'is', null)
        .lt('paid_at', overdueBefore).order('paid_at', { ascending: true }).limit(20),

      supabase.from('withdrawal_requests')
        .select('id, tenant_id, amount, phone_number, failure_reason, requested_at', { count: 'exact' })
        .eq('status', 'failed').order('requested_at', { ascending: false }).limit(20),

      supabase.from('withdrawal_requests')
        .select('id, tenant_id, amount, requested_at', { count: 'exact' })
        .in('status', ['pending', 'processing']).order('requested_at', { ascending: true }).limit(20),
    ]);

    // A pending MoMo transaction older than a few minutes means the
    // reconciliation sweep is not catching up.
    const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
    const { count: stalePending } = await supabase
      .from('momo_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending').lt('created_at', staleBefore);

    res.json({
      health: {
        holdMinutes,
        pendingRefunds: { count: pendingRefunds.count ?? 0, items: pendingRefunds.data || [] },
        failedMomo: { count: failedMomo.count ?? 0, items: failedMomo.data || [] },
        stuckEscrow: { count: stuckEscrow.count ?? 0, items: stuckEscrow.data || [] },
        failedWithdrawals: { count: failedWithdrawals.count ?? 0, items: failedWithdrawals.data || [] },
        pendingWithdrawals: { count: pendingWithdrawals.count ?? 0, items: pendingWithdrawals.data || [] },
        stalePendingTransactions: stalePending ?? 0,
      },
    });
  } catch (err) {
    console.error('Platform health error:', err.message);
    res.status(500).json({ error: 'Failed to load platform health' });
  }
});

module.exports = router;
