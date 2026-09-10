/**
 * Money formatting.
 *
 * Prices used to be rendered as `${value.toFixed(2)}` — a hardcoded dollar sign
 * and a hardcoded two decimal places. Both are wrong outside the US:
 *
 *   - the symbol and its placement differ per currency and locale
 *     (€1,50 vs $1.50 vs 1 500 RWF)
 *   - the number of minor units is not always two. RWF, JPY and UGX have NONE,
 *     so "1000.00 RWF" is not a small cosmetic slip — it reads as a different
 *     amount to the person being asked to pay it.
 *
 * Intl.NumberFormat knows all of that, so let it decide rather than hardcoding.
 */

/** Used before the store's own currency has loaded, and if it is ever missing. */
export const FALLBACK_CURRENCY = 'RWF';

const formatters = new Map();

function formatterFor(currency, locale) {
  const key = `${locale}:${currency}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        // Deliberately not set: Intl picks the right number of minor units for
        // the currency. Forcing 2 here would reintroduce the RWF bug.
      });
    } catch {
      // Unknown or malformed code — fall back to a plain number with the code
      // appended, which is still honest, rather than throwing inside a render.
      f = {
        format: (n) => `${new Intl.NumberFormat(locale).format(n)} ${currency}`,
      };
    }
    formatters.set(key, f);
  }
  return f;
}

/**
 * Format an amount in a store's currency.
 *
 * @param {number|string} amount
 * @param {string} currency ISO 4217, e.g. 'RWF'
 * @param {string} [locale] defaults to the viewer's own locale
 */
export function formatMoney(amount, currency = FALLBACK_CURRENCY, locale = undefined) {
  const n = typeof amount === 'number' ? amount : parseFloat(amount);
  if (!Number.isFinite(n)) return formatterFor(currency, locale).format(0);
  return formatterFor(currency, locale).format(n);
}

/**
 * A signed delta, for option prices shown as "+RF 500".
 * Zero returns an empty string so callers can render nothing for free options.
 */
export function formatDelta(amount, currency = FALLBACK_CURRENCY, locale = undefined) {
  const n = typeof amount === 'number' ? amount : parseFloat(amount);
  if (!Number.isFinite(n) || n === 0) return '';
  const sign = n > 0 ? '+' : '−';
  return `${sign}${formatMoney(Math.abs(n), currency, locale)}`;
}

export default formatMoney;
