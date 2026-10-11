// db/etl/lib.ts — the shared kit for the one-off data migration (milestone 29, plan §5.5).
//
// The three properties §5.5 demands, and where each is enforced:
//
//   READ-ONLY AGAINST THE SOURCE. The source connection opens ONE `REPEATABLE READ READ ONLY`
//   transaction and never leaves it, so the server itself refuses a write, and every read sees
//   the same snapshot — the counts and the money cannot disagree because a payment landed
//   mid-run. A canary write is attempted first and must be refused (`proveReadOnly`).
//
//   REPEATABLE. The target is written inside ONE transaction: a failure leaves it exactly as
//   it was, so "a partial run" is never a state anybody has to reason about. And the run
//   refuses a target that already holds migrated data — rehearsals build a fresh database
//   (db/scripts/etl-rehearse.sh) instead of truncating one, because `legacy_rows`, the audit
//   log and the ledger are append-only by design and a rebuild-in-place would have to defeat
//   the very triggers that make the new system trustworthy.
//
//   RECONCILED, NOT ASSUMED. Every mapping that involves a judgement writes a `Decision`; every
//   row that has no home is archived with its reason; and report.ts compares the two databases
//   afterwards. Nothing is dropped silently.

import type { Client } from 'pg';

export type Decision = {
  step: string;
  kind: string;
  subject: string;
  detail: string;
};

export type Counter = { read: number; written: number; archived: number };

export class Ctx {
  readonly decisions: Decision[] = [];
  readonly counters = new Map<string, Counter>();

  /** old id -> new id, per entity. Most ids are preserved; users are the exception (one person per email). */
  readonly userMap = new Map<string, string>();

  readonly src: Client;
  readonly tgt: Client;

  constructor(src: Client, tgt: Client) {
    this.src = src;
    this.tgt = tgt;
  }

  decide(step: string, kind: string, subject: string, detail: string): void {
    this.decisions.push({ step, kind, subject, detail });
  }

  counter(table: string): Counter {
    let c = this.counters.get(table);
    if (c === undefined) {
      c = { read: 0, written: 0, archived: 0 };
      this.counters.set(table, c);
    }
    return c;
  }

  async archive(sourceTable: string, sourceId: string | null, storeId: string | null, reason: string, row: unknown): Promise<void> {
    await this.tgt.query(
      `INSERT INTO legacy_rows (source_table, source_id, store_id, reason, row) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [sourceTable, sourceId, storeId, reason, JSON.stringify(row)],
    );
    this.counter(sourceTable).archived += 1;
  }
}

/** Something in the source this program has no rule for. It stops the run: guessing with money is how a migration loses some. */
export class Unmapped extends Error {
  constructor(what: string, hint: string) {
    super(`${what}\n  ${hint}`);
    this.name = 'Unmapped';
  }
}

export async function proveReadOnly(src: Client): Promise<void> {
  await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let refused = false;
  try {
    await src.query('CREATE TEMP TABLE etl_canary (x int)');
  } catch {
    refused = true;
    // A failed statement poisons the transaction; start the snapshot again, still read-only.
    await src.query('ROLLBACK');
    await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }
  if (!refused) {
    await src.query('ROLLBACK');
    throw new Error('The source database accepted a write. Refusing to run: the migration must never be able to change the old system.');
  }
}

/** Reads one table, honouring the pool rule the new server has too: no SELECT *. Columns are named, so a column added to the old schema is noticed rather than dragged along. */
export async function read<T extends Record<string, unknown>>(ctx: Ctx, table: string, columns: readonly string[], orderBy: string): Promise<T[]> {
  const sql = `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM public."${table}" ORDER BY ${orderBy}`;
  const result = await ctx.src.query<T>(sql);
  ctx.counter(table).read += result.rows.length;
  return result.rows;
}

export const money = (v: unknown): string => {
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Unmapped(`not a number: ${s}`, 'Money columns must be plain decimals.');
  return s;
};

/** Exact two-decimal arithmetic on strings via integer cents: money never passes through a float. */
export const cents = (v: unknown): bigint => {
  const s = money(v);
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = s.replace('-', '').split('.');
  const padded = (frac + '00').slice(0, 2);
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) throw new Unmapped(`more than two decimals: ${s}`, 'The new schema stores money to the cent.');
  const n = BigInt(whole) * 100n + BigInt(padded);
  return neg ? -n : n;
};

export const fromCents = (n: bigint): string => {
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};

export const uuidArray = (ids: readonly string[]): string => `{${ids.join(',')}}`;
