// packages/core/src/money/decimal.ts — milestone 13.
//
// Exact decimal arithmetic for money, on BigInt minor units.
//
// WHY NOT A NUMBER. Every amount in this system arrives from Postgres as a STRING, because
// node-postgres returns `numeric` that way and packages/core's generated row types say so: "a
// `number` here would invite arithmetic that loses cents." The board's own formatter
// (`AdminCurrencies.dc.html`) takes a JavaScript number and calls `toFixed`, which is fine for a
// design mock and fine in practice for numeric(12,2) — but `toFixed` rounds the BINARY value, so
// (1.005).toFixed(2) is "1.00", and the class of bug that produces is exactly the one §1.2 says
// the money engine exists to avoid.
//
// So amounts are parsed into (sign, digits, scale) and never become floats. For every input the
// database can hold this agrees with the board byte for byte, which test/money.test.ts asserts
// differentially rather than by argument.

/** A decimal as an exact integer of minor units at a given scale. 12.34 is (1234, 2). */
export type Decimal = {
  /** True for a value below zero. Kept separately so `digits` is always non-negative. */
  negative: boolean;
  /** The unscaled value, always ≥ 0. */
  digits: bigint;
  /** How many of those digits are fractional. */
  scale: number;
};

const TEN = 10n;

function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

/**
 * Parses a decimal string, or a number, exactly.
 *
 * Accepts what Postgres emits for `numeric` — "0", "3500.00", "-12.5" — and what a JSON body
 * might carry. Exponent notation is accepted too, because `String(1e21)` produces it and a
 * caller passing a number has no say in that.
 *
 * Throws on anything else. This is the one place in the money path that may throw: a
 * malformed amount is not a display problem to degrade around, it is a value nobody should
 * render as if it were money.
 */
export function parseDecimal(value: string | number | bigint): Decimal {
  if (typeof value === 'bigint') {
    return { negative: value < 0n, digits: value < 0n ? -value : value, scale: 0 };
  }

  const raw = typeof value === 'number' ? numberToPlainString(value) : value.trim();

  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (match === null || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new Error(`not a decimal amount: ${JSON.stringify(value)}`);
  }

  const integer = match[2] === '' ? '0' : (match[2] as string);
  const fraction = match[3] ?? '';

  return {
    negative: match[1] === '-' && !/^0*$/.test(integer + fraction),
    digits: BigInt(integer + fraction),
    scale: fraction.length,
  };
}

/**
 * A number as a plain decimal string, with no exponent.
 *
 * `String(0.0000001)` is "1e-7" and `String(1e21)` is "1e+21"; both have to become digits before
 * they can be parsed exactly. A number was never an exact money value to begin with — this
 * preserves whatever the double actually is, rather than pretending otherwise.
 */
function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not a finite amount: ${value}`);
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return value.toFixed(0);

  const text = String(value);
  if (!text.includes('e') && !text.includes('E')) return text;

  // Expand the exponent by hand: toFixed(20) would round and cap at 100 digits.
  const [mantissa = '0', exponentText = '0'] = text.split(/[eE]/);
  const exponent = Number.parseInt(exponentText, 10);
  const negative = mantissa.startsWith('-');
  const unsigned = mantissa.replace(/^[+-]/, '');
  const [whole = '0', frac = ''] = unsigned.split('.');
  const digits = whole + frac;
  const pointAt = whole.length + exponent;

  let out: string;
  if (pointAt <= 0) out = '0.' + '0'.repeat(-pointAt) + digits;
  else if (pointAt >= digits.length) out = digits + '0'.repeat(pointAt - digits.length);
  else out = digits.slice(0, pointAt) + '.' + digits.slice(pointAt);

  return (negative ? '-' : '') + out;
}

/**
 * Rescales to `targetScale`, rounding HALF AWAY FROM ZERO.
 *
 * That is `toFixed`'s intent and `Math.round`'s behaviour for positive values, and it is what
 * the board's formatter does. Half away from zero rather than half up so a negative amount —
 * a refund line — rounds by magnitude rather than toward positive infinity, which would make
 * −2.5 round to −2 while 2.5 rounds to 3.
 */
export function rescale(value: Decimal, targetScale: number): Decimal {
  if (targetScale === value.scale) return value;

  if (targetScale > value.scale) {
    return {
      negative: value.negative,
      digits: value.digits * pow10(targetScale - value.scale),
      scale: targetScale,
    };
  }

  const drop = pow10(value.scale - targetScale);
  const quotient = value.digits / drop;
  const remainder = value.digits % drop;
  // remainder * 2 >= drop is "the dropped part is at least a half".
  const rounded = remainder * 2n >= drop ? quotient + 1n : quotient;

  return {
    negative: value.negative && rounded !== 0n,
    digits: rounded,
    scale: targetScale,
  };
}

/**
 * Rounds to the nearest multiple of `step`, which is a whole number of major units.
 *
 * This is the cash-rounding arithmetic: `Math.round(v / step) * step`, done exactly. Ties go
 * away from zero, so 8,025 with a step of 50 becomes 8,050 rather than 8,000 — the same
 * direction `Math.round` takes, and the direction that does not quietly favour one side of
 * every transaction.
 */
export function roundToStep(value: Decimal, step: number): Decimal {
  if (!Number.isInteger(step) || step < 0) {
    throw new Error(`cash rounding step must be a whole number of units: ${step}`);
  }
  if (step === 0) return value;

  const stepUnits = BigInt(step) * pow10(value.scale);
  const quotient = value.digits / stepUnits;
  const remainder = value.digits % stepUnits;
  const multiples = remainder * 2n >= stepUnits ? quotient + 1n : quotient;
  const digits = multiples * stepUnits;

  return { negative: value.negative && digits !== 0n, digits, scale: value.scale };
}

/** Back to a plain decimal string, at the scale it holds. Never exponent notation. */
export function toDecimalString(value: Decimal): string {
  const digits = value.digits.toString().padStart(value.scale + 1, '0');
  const cut = digits.length - value.scale;
  const body = value.scale === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return (value.negative ? '-' : '') + body;
}

/**
 * Exact addition, at the wider of the two scales.
 *
 * ADDED AT MILESTONE 16, for the cart subtotal. Until then nothing in the money path added two
 * amounts together: a price was formatted, a cash total was rounded, and the arithmetic was the
 * database's. A cart is the first screen that sums lines the server has already priced.
 *
 * It is here rather than in the repository that needed it because a second place that adds money is a
 * second place that can lose a cent — the whole argument of this file. A signed BigInt of minor units
 * makes the sign handling fall out rather than being cased.
 */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  const total = (left.negative ? -left.digits : left.digits) + (right.negative ? -right.digits : right.digits);
  return { negative: total < 0n, digits: total < 0n ? -total : total, scale };
}

/**
 * Add up a list, exactly. Empty sums to zero at scale 0, which `toDecimalString` renders as "0".
 *
 * A fold over addDecimal rather than its own loop: one implementation of carrying, one place for a
 * rounding bug to fail to be.
 */
export function sumDecimals(values: readonly Decimal[]): Decimal {
  return values.reduce(addDecimal, { negative: false, digits: 0n, scale: 0 });
}

/**
 * Multiply by a whole number of units. A line total is unit price × quantity, and nothing else.
 *
 * WHOLE NUMBERS ONLY — a quantity, not a rate. Multiplying two decimals would double the scale and the
 * result would need a rounding rule, which is a decision no caller here has to make: the database
 * computes line_total_amount the same way, as `(unit + options) * quantity`, with quantity an integer
 * column. Anything fractional is a percentage, and a percentage of money is a discount, which V013
 * computes in SQL where the rounding rule is written down once.
 */
export function multiplyDecimal(value: Decimal, times: number): Decimal {
  if (!Number.isInteger(times) || times < 0) {
    throw new Error(`a quantity must be a whole number of units, got ${times}`);
  }
  const digits = value.digits * BigInt(times);
  return { negative: value.negative && digits !== 0n, digits, scale: value.scale };
}

/** -1, 0 or 1. For tests and for ordering; no money path needs subtraction yet. */
export function compareDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  const x = left.negative ? -left.digits : left.digits;
  const y = right.negative ? -right.digits : right.digits;
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isZero(value: Decimal): boolean {
  return value.digits === 0n;
}
