// server/src/db/tx.ts — milestone 11.
//
// The transaction helper. Every write in the new stack goes through it, because
// "atomic at every level" is only true if nobody can forget the ROLLBACK.
//
// What it guarantees:
//
//   * BEGIN … COMMIT, or BEGIN … ROLLBACK. There is no path out of withTransaction()
//     that leaves a transaction open, including a callback that throws, a ROLLBACK
//     that itself fails, and a process that loses its connection mid-statement.
//   * The client is ALWAYS released. A connection lost mid-transaction is destroyed
//     rather than returned, because its session state is unknown.
//   * A serialization failure, deadlock or lock timeout is RETRIED, up to a bound,
//     with jittered backoff. Nothing else is: every other refusal is a decision the
//     database made on purpose, and repeating it just makes the caller wait.
//   * A nested call JOINS the transaction it is inside, under a SAVEPOINT. Taking a
//     second connection from the pool instead would deadlock the pool under load —
//     ten concurrent nested calls against max=10 and every client is waiting for
//     one that is already held.
//   * BEGIN, COMMIT, ROLLBACK and SAVEPOINT from inside the callback are refused.
//     The helper owns the transaction; a caller that ends it early leaves the rest
//     of the callback running outside any transaction at all, which is exactly the
//     class of bug this file exists to make impossible.
//
// THE CALLBACK MUST DO NOTHING BUT DATABASE WORK. A retry re-runs it from the top,
// so an email sent, a MoMo call made or a counter incremented in memory happens
// twice. Side effects belong after the transaction returns, where they can read
// what was actually committed.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Queryable } from './pool.ts';
import { connect, instrument } from './pool.ts';
import { isConnectionLost, isRetryable, sqlstate } from './errors.ts';

/**
 * What a callback is handed. Deliberately not the PoolClient: no transaction control.
 *
 * A Tx IS a Queryable, which is the whole point — a repository method takes a
 * Queryable and therefore works identically on the pool and inside a transaction,
 * with no second overload and no flag saying which it got.
 */
export type Tx = Queryable & {
  /** 1 for the outermost transaction, 2+ inside a SAVEPOINT. */
  readonly depth: number;
};

export type TxOptions = {
  /**
   * 'read committed' (the default, and Postgres') is right for anything whose
   * invariants the schema enforces — which here is everything, since the money
   * paths hold row locks and the cross-row rules are deferred constraint
   * triggers. 'repeatable read' and 'serializable' are for a read-modify-write
   * the schema cannot see; both raise 40001, which this helper retries.
   */
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  /** BEGIN READ ONLY. A consistent multi-statement read, and a write becomes an error. */
  readOnly?: boolean;
  /** Retry attempts for a serialization failure or deadlock. 0 disables retrying. */
  retries?: number;
  /** A label for the log line a retry writes. */
  label?: string;
};

// Read per call, not at module load: a module-scope read happens before the entrypoint's
// .env is loaded (see api/env.ts), which would make the variable silently inert.
function defaultRetries(): number {
  return Number(process.env.PG_TX_RETRIES ?? '3');
}
function baseBackoffMs(): number {
  return Number(process.env.PG_TX_BACKOFF_MS ?? '20');
}

// Statements the helper owns. The same discipline db/scripts/migrate.ts applies to
// a migration file, for the same reason: whoever owns the transaction must be the
// only one able to end it.
const TX_CONTROL =
  /^\s*(begin|start\s+transaction|commit|end\b|rollback|savepoint|release\s+savepoint|set\s+transaction)\b/i;

/**
 * The transaction in progress on this async call stack, if any. AsyncLocalStorage
 * rather than a module variable: two concurrent requests are two independent
 * contexts, and a module variable would hand one request the other's client.
 */
const current = new AsyncLocalStorage<{ client: PoolClient; depth: number }>();

/** The transaction this call stack is inside, or null. */
export function currentTx(): Tx | null {
  const store = current.getStore();
  return store === undefined ? null : wrap(store.client, store.depth);
}

/**
 * Throws unless called inside a transaction. For a repository method whose
 * correctness depends on being one of several statements that commit together —
 * it makes the requirement a failure at the call site instead of a silent
 * half-write in production.
 */
export function requireTx(what: string): Tx {
  const tx = currentTx();
  if (tx === null) {
    throw new Error(`${what} must run inside withTransaction(); it writes more than one row.`);
  }
  return tx;
}

function wrap(client: PoolClient, depth: number): Tx {
  return {
    depth,
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      if (TX_CONTROL.test(text)) {
        throw new Error(
          `withTransaction() owns the transaction — remove the ${text.trim().split(/\s+/)[0]} from this statement.`,
        );
      }
      return instrument<R>(client, text, values);
    },
  };
}

function beginStatement(opts: TxOptions): string {
  const parts = ['BEGIN'];
  if (opts.isolation !== undefined) parts.push(`ISOLATION LEVEL ${opts.isolation.toUpperCase()}`);
  if (opts.readOnly === true) parts.push('READ ONLY');
  return parts.join(' ');
}

function backoff(attempt: number): Promise<void> {
  // Jittered, so two transactions that deadlocked against each other do not
  // retry in step and deadlock again.
  const ceiling = baseBackoffMs() * 2 ** (attempt - 1);
  const delay = Math.random() * ceiling;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** A savepoint name per depth. Fixed, because depth is what makes it unique. */
function savepointName(depth: number): string {
  return `vl_sp_${depth}`;
}

/**
 * Runs `fn` in a transaction and returns its result.
 *
 * A nested call joins the transaction it is inside, under a SAVEPOINT: if the
 * inner callback throws, only its own work is rolled back, and the caller may
 * handle the error and carry on with the outer transaction intact. The inner
 * call's isolation, readOnly and retries options do not apply — the outer BEGIN
 * already happened — and passing them is a no-op rather than an error, so a
 * method written for either position behaves the same.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const outer = current.getStore();
  if (outer !== undefined) return runNested(outer.client, outer.depth, fn);

  const retries = Math.max(0, opts.retries ?? defaultRetries());

  for (let attempt = 1; ; attempt += 1) {
    const client = await connect();
    let opened = false;

    try {
      await client.query(beginStatement(opts));
      opened = true;

      const result = await current.run({ client, depth: 1 }, () => fn(wrap(client, 1)));

      await client.query('COMMIT');
      opened = false;
      client.release();
      return result;
    } catch (err) {
      // Order matters: roll back before deciding anything, so the transaction is
      // never left open while this branch thinks about what happened.
      let lost = isConnectionLost(err);

      if (opened && !lost) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          // The rollback failed, so this client's state is unknown. Postgres has
          // already aborted the transaction — no work is committed — but the
          // connection must not go back into the pool.
          lost = true;
          console.error('[db] ROLLBACK failed, destroying the connection:', (rollbackErr as Error).message);
        }
      }

      // `release(true)` destroys the client instead of returning it.
      client.release(lost ? true : undefined);

      if (attempt <= retries && isRetryable(err)) {
        console.warn(
          `[db] retrying ${opts.label ?? 'transaction'} after ${sqlstate(err)} (attempt ${attempt} of ${retries + 1})`,
        );
        await backoff(attempt);
        continue;
      }

      throw err;
    }
  }
}

/**
 * The nested case. No retry: the outer transaction holds locks and has already
 * written rows, so re-running only the inner part would not repair a
 * serialization failure — that has to fail outward to whoever owns the BEGIN.
 */
async function runNested<T>(
  client: PoolClient,
  outerDepth: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const depth = outerDepth + 1;
  const name = savepointName(depth);

  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await current.run({ client, depth }, () => fn(wrap(client, depth)));
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    if (!isConnectionLost(err)) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      } catch {
        // The outer transaction is unrecoverable. Let the original error out; the
        // outer withTransaction() will roll the whole thing back.
      }
    }
    throw err;
  }
}

/**
 * A consistent multi-statement read. Two queries outside a transaction can see two
 * different states of the database — which is how a balance and the ledger behind
 * it come to disagree on screen.
 */
export async function readConsistent<T>(fn: (tx: Tx) => Promise<T>, label?: string): Promise<T> {
  return withTransaction(fn, {
    readOnly: true,
    isolation: 'repeatable read',
    ...(label === undefined ? {} : { label }),
  });
}
