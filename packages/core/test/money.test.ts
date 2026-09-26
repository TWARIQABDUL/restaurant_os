// packages/core/test/money.test.ts — milestone 13.
//
// The third clause of the done-when: "Cash rounding property-tested."
//
// Properties, not examples, for the rounding — and a frozen golden table from
// `AdminCurrencies.dc.html`'s own `fmt()` for the rendering, so what is asserted is the
// specification rather than my reading of it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cashDue,
  compareDecimal,
  formatCashDue,
  formatMoney,
  parseDecimal,
  rescale,
  roundToStep,
  toDecimalString,
} from '../src/index.ts';
import type { CurrencyFormat } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

type BoardCurrency = {
  code: string;
  symbol: string;
  pos: 'before' | 'after';
  dec: number;
  sep: string;
  round: number;
};

const golden = JSON.parse(readFileSync(path.join(HERE, 'fixtures/money-golden.json'), 'utf8')) as {
  generatedFrom: string;
  currencies: Record<string, BoardCurrency>;
  cases: { currency: string; amount: string; cash: boolean; expected: string }[];
};

/** The board's column names to ours. Same five columns, spelled out. */
function currencyOf(c: BoardCurrency): CurrencyFormat {
  return {
    code: c.code,
    symbol: c.symbol,
    symbolPosition: c.pos,
    decimals: c.dec,
    thousandsSeparator: c.sep,
    cashRounding: c.round,
  };
}

/** The six V006 ships, by code. */
const CURRENCIES: Record<string, CurrencyFormat> = Object.fromEntries(
  Object.entries(golden.currencies).map(([key, c]) => [key, currencyOf(c)]),
);

function rwf(): CurrencyFormat {
  const c = CURRENCIES['RWF'];
  assert.ok(c);
  return c;
}

// ===========================================================================
describe('the golden table — the board is the specification', () => {
  it('reproduces every case exactly', () => {
    const mismatches: string[] = [];

    for (const c of golden.cases) {
      const currency = CURRENCIES[c.currency];
      assert.ok(currency, c.currency);
      const actual = c.cash
        ? formatCashDue(c.amount, currency)
        : formatMoney(c.amount, currency);
      if (actual !== c.expected) {
        mismatches.push(
          `${c.currency} ${c.amount}${c.cash ? ' (cash)' : ''}: got ${actual}, want ${c.expected}`,
        );
      }
    }

    assert.deepEqual(mismatches.slice(0, 12), [], `${mismatches.length} of ${golden.cases.length}`);
  });

  it('covers every currency the platform ships, and a dot separator', () => {
    const codes = new Set(golden.cases.map((c) => c.currency));
    for (const expected of ['RWF', 'UGX', 'KES', 'TZS', 'BIF', 'USD', 'DOT']) {
      assert.ok(codes.has(expected), expected);
    }
  });
});

// ===========================================================================
describe('how each currency writes money', () => {
  it('writes the six the way AdminCurrencies draws them', () => {
    const cases: [string, string, string][] = [
      ['RWF', '3500', '3,500 RWF'],
      ['UGX', '9500', 'UGX 9,500'],
      ['KES', '350', 'KSh 350'],
      ['TZS', '7000', 'TSh 7,000'],
      ['BIF', '7500', '7 500 FBu'],
      ['USD', '2.40', '$2.40'],
    ];
    for (const [code, amount, expected] of cases) {
      const currency = CURRENCIES[code];
      assert.ok(currency);
      assert.equal(formatMoney(amount, currency), expected, code);
    }
  });

  it('spaces a word symbol and does not space a sign', () => {
    // The board's rule: `const sp = c.symbol.length > 1 ? ' ' : ''`.
    const usd = CURRENCIES['USD'];
    const kes = CURRENCIES['KES'];
    assert.ok(usd && kes);
    assert.equal(formatMoney('2.4', usd), '$2.40', 'one character, no space');
    assert.equal(formatMoney('350', kes), 'KSh 350', 'three characters, one space');
  });

  it('always spaces a trailing symbol', () => {
    assert.equal(formatMoney('3500', rwf()), '3,500 RWF');
  });

  it('swaps the decimal separator when thousands are dotted', () => {
    const dotted = CURRENCIES['DOT'];
    assert.ok(dotted);
    assert.equal(formatMoney('1234.56', dotted), '€1.234,56');
  });

  it('shows an amount at the currency’s scale, whatever scale it arrives at', () => {
    // Every amount comes out of Postgres as numeric(12,2) — "3500.00" — even for a currency
    // with no decimals. RWF must not render "3,500.00".
    assert.equal(formatMoney('3500.00', rwf()), '3,500 RWF');
    assert.equal(formatMoney('3500.49', rwf()), '3,500 RWF');
    assert.equal(formatMoney('3500.50', rwf()), '3,501 RWF', 'and it rounds half away from zero');
    const usd = CURRENCIES['USD'];
    assert.ok(usd);
    assert.equal(formatMoney('2', usd), '$2.00', 'padded up to two');
  });

  it('groups at every boundary', () => {
    assert.equal(formatMoney('999', rwf()), '999 RWF');
    assert.equal(formatMoney('1000', rwf()), '1,000 RWF');
    assert.equal(formatMoney('999999', rwf()), '999,999 RWF');
    assert.equal(formatMoney('1000000', rwf()), '1,000,000 RWF');
    assert.equal(formatMoney('0', rwf()), '0 RWF');
  });

  it('puts the sign before the symbol, which the board does not', () => {
    // A DELIBERATE DEVIATION, and the only one. The board's fmt concatenates symbol then number,
    // so a negative in a symbol-before currency would render "$-2.40". It never formats one — no
    // sample amount is negative — so that is incidental rather than specified, and a refund line
    // reading "$-2.40" would be a bug somebody files. The golden table is non-negative for the
    // same reason.
    const usd = CURRENCIES['USD'];
    assert.ok(usd);
    assert.equal(formatMoney('-2.40', usd), '-$2.40');
    assert.equal(formatMoney('-3500', rwf()), '-3,500 RWF');
    assert.equal(formatMoney('-1234567', rwf()), '-1,234,567 RWF');
  });
});

// ===========================================================================
describe('cash rounding', () => {
  it('rounds only for cash, never for a card or MoMo total', () => {
    // V006: "A card or momo total is never rounded — that difference is exactly the kind that
    // goes unnoticed for a month."
    assert.equal(formatMoney('8017', rwf()), '8,017 RWF');
    assert.equal(formatCashDue('8017', rwf()), '8,000 RWF');
  });

  it('is off for a currency with rounding off', () => {
    const usd = CURRENCIES['USD'];
    assert.ok(usd);
    assert.equal(cashDue('8017.37', usd), '8017.37');
    assert.equal(formatCashDue('8017.37', usd), '$8,017.37');
  });

  it('rounds to the nearest step, with ties away from zero', () => {
    // 8,025 at a step of 50 is exactly between 8,000 and 8,050. Math.round's direction, and the
    // direction that does not quietly favour one side of every transaction.
    assert.equal(cashDue('8024', rwf()), '8000');
    assert.equal(cashDue('8025', rwf()), '8050');
    assert.equal(cashDue('8026', rwf()), '8050');
  });

  it('honours each currency’s own step', () => {
    const expectations: [string, string, string][] = [
      ['RWF', '8017', '8000'],
      ['UGX', '8017', '8000'],
      ['KES', '8017', '8020'],
      ['TZS', '8017', '8000'],
      ['BIF', '8017', '8000'],
    ];
    for (const [code, amount, expected] of expectations) {
      const currency = CURRENCIES[code];
      assert.ok(currency);
      assert.equal(cashDue(amount, currency), expected, code);
    }
  });

  // ---- the properties -----------------------------------------------------
  //
  // A deterministic pseudo-random sweep, seeded so a failure is reproducible.
  function* amounts(count: number, seed: number): Generator<bigint> {
    let state = seed;
    for (let i = 0; i < count; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      yield BigInt(state % 5_000_000);
    }
  }

  const STEPS = [10, 50, 100, 500];

  it('property: the result is always a multiple of the step', () => {
    for (const step of STEPS) {
      for (const amount of amounts(4000, 20260926 + step)) {
        const due = BigInt(cashDue(amount.toString(), { ...rwf(), cashRounding: step }));
        assert.equal(due % BigInt(step), 0n, `${amount} at ${step} → ${due}`);
      }
    }
  });

  it('property: it never moves an amount by more than half a step', () => {
    for (const step of STEPS) {
      const half = BigInt(step) / 2n;
      for (const amount of amounts(4000, 777 + step)) {
        const due = BigInt(cashDue(amount.toString(), { ...rwf(), cashRounding: step }));
        const drift = due > amount ? due - amount : amount - due;
        assert.ok(drift <= half, `${amount} at ${step} moved ${drift}`);
      }
    }
  });

  it('property: it is idempotent — rounding a rounded amount changes nothing', () => {
    for (const step of STEPS) {
      const currency = { ...rwf(), cashRounding: step };
      for (const amount of amounts(3000, 31337 + step)) {
        const once = cashDue(amount.toString(), currency);
        assert.equal(cashDue(once, currency), once, `${amount} at ${step}`);
      }
    }
  });

  it('property: it is monotonic — a bigger total never becomes a smaller cash due', () => {
    for (const step of STEPS) {
      const currency = { ...rwf(), cashRounding: step };
      let previous = -1n;
      for (let amount = 0n; amount <= 3000n; amount += 1n) {
        const due = BigInt(cashDue(amount.toString(), currency));
        assert.ok(due >= previous, `${amount} at ${step}: ${due} after ${previous}`);
        previous = due;
      }
    }
  });

  it('property: an exact multiple is left alone', () => {
    for (const step of STEPS) {
      const currency = { ...rwf(), cashRounding: step };
      for (let multiple = 0; multiple <= 400; multiple += 1) {
        const amount = String(multiple * step);
        assert.equal(cashDue(amount, currency), amount, `${amount} at ${step}`);
      }
    }
  });

  it('property: zero stays zero, and it never produces a negative from a positive', () => {
    for (const step of STEPS) {
      const currency = { ...rwf(), cashRounding: step };
      assert.equal(cashDue('0', currency), '0');
      for (let amount = 0n; amount < BigInt(step); amount += 1n) {
        const due = BigInt(cashDue(amount.toString(), currency));
        assert.ok(due >= 0n, `${amount} at ${step} → ${due}`);
      }
    }
  });

  it('rounds a negative by magnitude, not toward positive infinity', () => {
    // A refund line. −25 at a step of 50 goes to −50, matching how +25 goes to +50.
    assert.equal(cashDue('-25', rwf()), '-50');
    assert.equal(cashDue('-24', rwf()), '0');
    assert.equal(cashDue('-8025', rwf()), '-8050');
  });

  it('refuses a step that is not a whole number of units', () => {
    assert.throws(() => roundToStep(parseDecimal('100'), 2.5), /whole number/);
    assert.throws(() => roundToStep(parseDecimal('100'), -50), /whole number/);
  });
});

// ===========================================================================
describe('exact decimals — no amount becomes a float', () => {
  it('parses what Postgres emits', () => {
    assert.deepEqual(parseDecimal('3500.00'), { negative: false, digits: 350000n, scale: 2 });
    assert.deepEqual(parseDecimal('0'), { negative: false, digits: 0n, scale: 0 });
    assert.deepEqual(parseDecimal('-12.5'), { negative: true, digits: 125n, scale: 1 });
    assert.deepEqual(parseDecimal('.5'), { negative: false, digits: 5n, scale: 1 });
  });

  it('treats negative zero as zero', () => {
    // "-0.00" is a value Postgres can produce from a subtraction, and "-0 RWF" on a screen is
    // the kind of thing that gets a bug filed about the money engine.
    assert.equal(parseDecimal('-0.00').negative, false);
    assert.equal(formatMoney('-0.00', rwf()), '0 RWF');
  });

  it('refuses a malformed amount rather than rendering something', () => {
    // The one place in the money path that throws. A value nobody can read as money must not be
    // shown as money.
    for (const bad of ['', 'abc', '1.2.3', '1,000', '1 000', 'NaN', '--1', '1e', '$5']) {
      assert.throws(() => parseDecimal(bad), /not a decimal amount/, bad);
    }
    assert.throws(() => parseDecimal(Number.NaN), /not a finite amount/);
    assert.throws(() => parseDecimal(Number.POSITIVE_INFINITY), /not a finite amount/);
  });

  it('handles amounts past what a double holds exactly', () => {
    // Not a realistic order total, but the whole point of BigInt units is that the ceiling is
    // the database's rather than the language's.
    const huge = '99999999999999999999.99';
    assert.equal(toDecimalString(parseDecimal(huge)), huge);
    assert.equal(formatMoney(huge, { ...rwf(), decimals: 2 }), '99,999,999,999,999,999,999.99 RWF');
  });

  it('rounds half away from zero when it drops scale', () => {
    assert.equal(toDecimalString(rescale(parseDecimal('1.005'), 2)), '1.01');
    assert.equal(toDecimalString(rescale(parseDecimal('2.675'), 2)), '2.68');
    assert.equal(toDecimalString(rescale(parseDecimal('-1.005'), 2)), '-1.01');
    assert.equal(toDecimalString(rescale(parseDecimal('0.4'), 0)), '0');
    assert.equal(toDecimalString(rescale(parseDecimal('0.5'), 0)), '1');
  });

  it('is where a float would have been wrong', () => {
    // (1.005).toFixed(2) is "1.00" in JavaScript, because the double nearest 1.005 is below it.
    // Exact decimal arithmetic gives 1.01. Neither appears in a numeric(12,2) order total, which
    // is why the golden table still matches — but a formatter for money should not depend on
    // that being true forever.
    assert.equal((1.005).toFixed(2), '1.00');
    assert.equal(toDecimalString(rescale(parseDecimal('1.005'), 2)), '1.01');
  });

  it('compares across scales', () => {
    assert.equal(compareDecimal(parseDecimal('1.50'), parseDecimal('1.5')), 0);
    assert.equal(compareDecimal(parseDecimal('1.5'), parseDecimal('1.50001')), -1);
    assert.equal(compareDecimal(parseDecimal('-1'), parseDecimal('1')), -1);
  });

  it('round-trips every scale', () => {
    for (const value of ['0', '0.0', '0.00', '1', '1.1', '1.10', '123.456', '-9.99']) {
      assert.equal(toDecimalString(parseDecimal(value)), value);
    }
  });
});
