const supabase = require('../config/supabase');
const momoConfig = require('../config/momo');

/**
 * Platform-wide settings, owned by super admin.
 *
 * Read on nearly every money path (order placement, tenant settings,
 * withdrawal), so the row is cached briefly rather than fetched each time. The
 * TTL is short and any write clears it, so a super admin's change takes effect
 * immediately for the instance that made it and within seconds everywhere else.
 */

const CACHE_TTL_MS = 15000;
let cache = null;

/** The settlement currency is not a setting — see supabase/platform-settings.sql. */
const SETTLEMENT_CURRENCY = momoConfig.currency;

const DEFAULTS = {
  allowed_currencies: [SETTLEMENT_CURRENCY],
  default_settlement_mode: 'manual',
  default_hold_minutes: momoConfig.holdMinutes,
};

function invalidate() {
  cache = null;
}

async function get() {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const { data, error } = await supabase
    .from('platform_settings')
    .select('allowed_currencies, default_settlement_mode, default_hold_minutes, updated_at')
    .eq('id', true)
    .maybeSingle();

  // Falling back to defaults rather than throwing: a missing row (migration not
  // yet run) should not take checkout down. The settlement currency alone is
  // always a valid allowlist, because it is by definition collectable.
  const value = error || !data ? { ...DEFAULTS } : data;

  // The settlement currency must always be allowed — otherwise mobile money
  // could be switched off platform-wide by an edit that looks unrelated.
  if (!value.allowed_currencies?.includes(SETTLEMENT_CURRENCY)) {
    value.allowed_currencies = [SETTLEMENT_CURRENCY, ...(value.allowed_currencies || [])];
  }

  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/** Currencies a store may price in. */
async function allowedCurrencies() {
  return (await get()).allowed_currencies;
}

/** Is this a currency the platform supports at all? */
async function isAllowedCurrency(code) {
  if (!code) return false;
  return (await allowedCurrencies()).includes(String(code).toUpperCase());
}

/**
 * Can we collect mobile money in this currency?
 *
 * Only the settlement currency: momoClient charges in momoConfig.currency, so a
 * store priced in anything else would show one amount and be charged another.
 * Cash and bank transfer are unaffected — no settlement is involved, so those
 * work in any allowed currency.
 */
function isSettleable(code) {
  return String(code || '').toUpperCase() === SETTLEMENT_CURRENCY;
}

async function update(patch, userId) {
  const next = { updated_at: new Date().toISOString(), updated_by: userId || null };

  if (patch.allowed_currencies !== undefined) {
    const list = [...new Set(
      (patch.allowed_currencies || []).map((c) => String(c).toUpperCase().trim())
    )].filter(Boolean);

    // Guaranteed to stay collectable.
    if (!list.includes(SETTLEMENT_CURRENCY)) list.unshift(SETTLEMENT_CURRENCY);
    next.allowed_currencies = list.sort();
  }

  if (patch.default_settlement_mode !== undefined) {
    next.default_settlement_mode = patch.default_settlement_mode;
  }
  if (patch.default_hold_minutes !== undefined) {
    next.default_hold_minutes = patch.default_hold_minutes;
  }

  const { data, error } = await supabase
    .from('platform_settings')
    .update(next)
    .eq('id', true)
    .select('allowed_currencies, default_settlement_mode, default_hold_minutes, updated_at')
    .single();

  if (error) throw new Error(error.message);
  invalidate();
  return data;
}

module.exports = {
  get,
  update,
  invalidate,
  allowedCurrencies,
  isAllowedCurrency,
  isSettleable,
  SETTLEMENT_CURRENCY,
};
