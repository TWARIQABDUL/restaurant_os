// packages/core/src/money/format.ts — milestone 13.
//
// One formatter, driven entirely by the `currencies` table. §3: "one formatter driven by the
// currency table: symbol, position, decimals, separator, and cash rounding that applies only to
// cash-on-delivery totals."
//
// The rendering rules are `AdminCurrencies.dc.html`'s `fmt()`, transcribed:
//
//   symbol before, 1 character   →  $2.40          no space
//   symbol before, 2+ characters →  KSh 350        one space
//   symbol after                 →  3,500 RWF      always one space
//   thousands separator '.'      →  decimal separator becomes ','
//
// V006 comments say why it lives in one place: "The formatter in packages/core reads only these
// columns, so there is one implementation of 'what does 3500 look like'."

import type { Decimal } from './decimal.ts';
import { parseDecimal, rescale, roundToStep, toDecimalString } from './decimal.ts';

/** The five `currencies` columns that decide how an amount is written, plus its rounding step. */
export type CurrencyFormat = {
  code: string;
  symbol: string;
  symbolPosition: 'before' | 'after';
  /** V006 allows 0 or 2, and says a third is a migration because stored scales depend on it. */
  decimals: number;
  thousandsSeparator: string;
  /** 0 means off. Applied ONLY to a cash-on-delivery total. */
  cashRounding: number;
};

export type MoneyInput = string | number | bigint | Decimal;

function asDecimal(value: MoneyInput): Decimal {
  return typeof value === 'object' ? value : parseDecimal(value);
}

/**
 * Groups the integer part, in threes, from the right.
 *
 * Written as a loop rather than the board's lookahead regex because the regex operates on the
 * signed string and relies on `-` making a word boundary — correct, but by accident. This is
 * explicit about the sign instead.
 */
function groupThousands(digits: string, separator: string): string {
  if (separator === '') return digits;
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const fromRight = digits.length - i;
    if (i > 0 && fromRight % 3 === 0) out += separator;
    out += digits[i];
  }
  return out;
}

/**
 * Formats an amount in its own currency.
 *
 * NEVER ROUNDS FOR CASH. A card or MoMo total is never rounded, and V006 says why: "that
 * difference is exactly the kind that goes unnoticed for a month." Use formatCashDue for the
 * one case that is.
 */
export function formatMoney(value: MoneyInput, currency: CurrencyFormat): string {
  const scaled = rescale(asDecimal(value), currency.decimals);
  const text = toDecimalString(scaled);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;

  const [whole = '0', fraction = ''] = unsigned.split('.');
  const decimalSeparator = currency.thousandsSeparator === '.' ? ',' : '.';
  const grouped = groupThousands(whole, currency.thousandsSeparator);
  const number = fraction === '' ? grouped : `${grouped}${decimalSeparator}${fraction}`;

  // One space only when the symbol is a word rather than a sign — "$2.40", but "KSh 350".
  const gap = currency.symbol.length > 1 ? ' ' : '';
  const body =
    currency.symbolPosition === 'before'
      ? `${currency.symbol}${gap}${number}`
      : `${number} ${currency.symbol}`;

  return negative ? `-${body}` : body;
}

/**
 * The cash-rounded amount, as a decimal string — the number a rider actually collects.
 *
 * SEPARATE FROM FORMATTING ON PURPOSE. Cash rounding changes the amount, not its rendering, and
 * a caller that needs the figure to reconcile a rider's hand-in against needs it as a value.
 * `AdminCurrencies` shows the two side by side — "Total 8,017 RWF / Cash due 8,000 RWF" — and
 * they are different amounts, not two renderings of one.
 *
 * Returns the amount unchanged when the currency has rounding off.
 */
export function cashDue(value: MoneyInput, currency: CurrencyFormat): string {
  const amount = asDecimal(value);
  const rounded = currency.cashRounding > 0 ? roundToStep(amount, currency.cashRounding) : amount;
  return toDecimalString(rescale(rounded, currency.decimals));
}

/**
 * Formats what a rider collects for a cash-on-delivery order.
 *
 * The board's `fmt(total, currency, true)`. Two named functions rather than one with a boolean,
 * so a card total cannot be rounded by passing the wrong flag — the mistake would be invisible
 * in review and worth a few francs on every order.
 */
export function formatCashDue(value: MoneyInput, currency: CurrencyFormat): string {
  return formatMoney(cashDue(value, currency), currency);
}
