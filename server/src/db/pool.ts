// server/src/db/pool.ts — milestone 11 of docs/migration/04-implementation-plan.md.
//
// The application's one connection to the new Postgres. Nothing else in the new
// stack opens a client: repositories take a Queryable (this pool, or a
// transaction's client) so the same method works inside and outside a
// transaction.
//
// THIS FILE AND EVERYTHING THAT IMPORTS IT IS SUPABASE-FREE. §4.3's done-when for
// this milestone is "the server boots against the local container with no
// supabase-js in the path", and test/no-supabase.test.ts asserts it by walking
// the import graph rather than by inspection.
//
// Three decisions worth knowing:
//
//   * The pool is created LAZILY. Importing a repository must not connect and
//     must not throw on missing configuration — otherwise `tsc`, a unit test and
//     the legacy server all fail at import time for an environment they do not
//     use. assertDatabaseConfig() is called once at boot, where the message can
//     be read.
//
//   * APP_DATABASE_URL, never DATABASE_URL. DATABASE_URL is the owner/migration
//     connection and today still points at the live Supabase instance; an
//     application that silently fell back to it would run with DDL rights
//     against production. There is no fallback.
//
//   * numeric and bigint arrive as STRINGS, which is node-postgres' default and
//     what packages/core's generated row types declare. Nothing here installs a
//     type parser that would turn money into a float.

import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

// ---------------------------------------------------------------------------
// What a repository needs. Both the pool and a transaction's client satisfy it,
// which is why no repository method has to know which one it was handed.
// ---------------------------------------------------------------------------
export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
};

// §2.3: "Explicit column lists. No SELECT * — it breaks silently on a new column
// and defeats covering indexes." Enforced here rather than left to review,
// because the failure it prevents is silent. count(*) and to_jsonb(t.*) do not
// match: only the projection form does.
const SELECT_STAR = /\bselect\s+(?:distinct\s+)?\*/i;

/**
 * A query slower than this is logged with its text. Off the request path it costs nothing.
 *
 * Read on each call rather than at module load: a module-scope read happens before the
 * entrypoint's .env is loaded (see api/env.ts), so the variable would silently never
 * apply. Reading process.env is not measurable next to a database round trip.
 */
function slowQueryMs(): number {
  return Number(process.env.PG_SLOW_QUERY_MS ?? '200');
}

let pool: Pool | null = null;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Roles that own the schema. The application must never connect as one of them:
 * it owns nothing and runs no DDL (db/bootstrap/local.sql), and a connection
 * with DDL rights turns every SQL injection and every stray migration-shaped
 * statement into a schema change.
 *
 * `postgres` is the Docker image's superuser and the name a managed provider
 * usually hands out first, so it is the likeliest thing to be pasted in by
 * mistake.
 */
const OWNER_ROLE_NAMES = new Set(['postgres', 'vendlyfy_owner']);

function ownerRoleAllowed(): boolean {
  // Named explicitly, in the same spirit as MOMO_ALLOW_SANDBOX in config/env.js:
  // a variable nobody sets is off, whereas NODE_ENV is set to all sorts of things.
  return process.env.APP_DB_ALLOW_OWNER === 'true';
}

function connectionUser(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.username ? decodeURIComponent(parsed.username) : null;
  } catch {
    return null;
  }
}

/**
 * Boot-time check. Call this from the server entrypoint, before listen, so a
 * misconfiguration is one legible message instead of a stack trace on the first
 * request.
 */
export function assertDatabaseConfig(): void {
  const problems: string[] = [];
  const url = process.env.APP_DATABASE_URL;

  if (!url || url.trim() === '') {
    problems.push(
      '  APP_DATABASE_URL is not set. The application connects as the least-privilege\n' +
        '  role — see server/.env.example. For the local container:\n' +
        '    APP_DATABASE_URL=postgresql://vendlyfy_app:localdev@127.0.0.1:55432/vendlyfy',
    );
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      problems.push(`  APP_DATABASE_URL is not a URL: ${JSON.stringify(url.slice(0, 24))}…`);
    }

    if (parsed && !/^postgres(ql)?:$/.test(parsed.protocol)) {
      problems.push(`  APP_DATABASE_URL must be a postgres:// URL, not ${parsed.protocol}//`);
    }

    const user = connectionUser(url);
    if (user && OWNER_ROLE_NAMES.has(user) && !ownerRoleAllowed()) {
      problems.push(
        `  APP_DATABASE_URL connects as "${user}", which owns the schema and can run DDL.\n` +
          '  The application role owns nothing and runs no DDL. Use vendlyfy_app:\n' +
          '    APP_DATABASE_URL=postgresql://vendlyfy_app:…@host:port/vendlyfy\n' +
          '\n' +
          '  If this really is meant to run as the owner (a one-off local experiment),\n' +
          '  set APP_DB_ALLOW_OWNER=true to say so explicitly.',
      );
    }
  }

  if (problems.length > 0) {
    console.error(`\nRefusing to start — the database connection is not safe to use:\n\n${problems.join('\n\n')}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

function createPool(): Pool {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    // Only reachable when something queries before assertDatabaseConfig() has
    // run — a programming error, so it throws rather than exits.
    throw new Error('APP_DATABASE_URL is not set; call assertDatabaseConfig() at boot.');
  }

  const created = new Pool({
    connectionString,

    // Sized against the server, not the database: one web process holding 10
    // connections is the shape §4.2 said would become ours to choose once
    // Supabase's shared pooler was out of the path. Raise it with evidence from
    // pg_stat_activity, not by guessing.
    max: Number(process.env.PGPOOL_MAX ?? '10'),
    min: 0,

    // A connection idle for 30s is released; a new one costs ~2ms locally.
    idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_MS ?? '30000'),

    // Fail fast when the database is unreachable. Without this the request hangs
    // for the OS' TCP timeout and the client sees nothing at all.
    connectionTimeoutMillis: Number(process.env.PGPOOL_CONNECT_MS ?? '5000'),

    // Server-side ceiling: Postgres itself cancels the query. This is the one
    // that protects the database, and it is why 57014 is mapped in db/errors.ts.
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? '15000'),

    // Client-side ceiling, slightly higher, so a cancelled statement reports as
    // a Postgres error (with its SQLSTATE) rather than as a client timeout.
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS ?? '20000'),

    // A transaction left open by a lost client holds its locks forever. This is
    // the backstop for the one bug the transaction helper cannot catch: a caller
    // that never returns.
    idle_in_transaction_session_timeout: Number(process.env.PG_IDLE_IN_TX_TIMEOUT_MS ?? '30000'),

    // Names this process in pg_stat_activity, so a stuck query is attributable.
    application_name: process.env.PG_APPLICATION_NAME ?? 'vendlyfy-api',

    // lock_timeout has no dedicated option in node-postgres, so it goes through
    // the startup packet. A request-path statement should never queue behind a
    // lock for long: better a clean 409 than a pile-up.
    options: `-c lock_timeout=${process.env.PG_LOCK_TIMEOUT ?? '5s'}`,
  });

  // An idle client can fail on its own — the database restarted, a proxy dropped
  // it. Without a listener this is an unhandled 'error' event, which takes the
  // process down. The pool has already discarded the client by the time this
  // runs; there is nothing to do but say so.
  created.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return created;
}

/** The process-wide pool, created on first use. */
export function getPool(): Pool {
  pool ??= createPool();
  return pool;
}

/**
 * Run one statement on the pool. Every repository read that is not inside a
 * transaction goes through here.
 */
export async function sql<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<R>> {
  return instrument(getPool(), text, values);
}

/**
 * The shared query path: the SELECT * refusal and the slow-query log, applied
 * identically whether the caller holds the pool or a transaction's client.
 */
export async function instrument<R extends QueryResultRow = QueryResultRow>(
  on: Queryable,
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<R>> {
  if (SELECT_STAR.test(text)) {
    throw new Error(
      `SELECT * is not allowed (§2.3) — name the columns.\n  ${text.trim().slice(0, 200)}`,
    );
  }

  const started = process.hrtime.bigint();
  try {
    return await on.query<R>(text, values);
  } finally {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms >= slowQueryMs()) {
      console.warn(`[db] slow query ${ms.toFixed(1)}ms: ${text.trim().replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }
}

/**
 * The pool as a Queryable — the default executor for a repository method called
 * outside a transaction. `repo.find(storeId, id)` and `repo.find(storeId, id, tx)`
 * are then the same method, which is why no repository has two code paths.
 */
export const db: Queryable = { query: sql };

/** Checks out a client. Callers should prefer withTransaction(); this is for it. */
export async function connect(): Promise<PoolClient> {
  return getPool().connect();
}

/** Is the database answering? Used by GET /api/health and by boot. */
export async function ping(): Promise<void> {
  await sql('SELECT 1 AS ok');
}

/**
 * Closes the pool. Called by the entrypoint's shutdown handler and by tests, so
 * that a finished process exits instead of waiting on idle sockets.
 */
export async function closePool(): Promise<void> {
  const open = pool;
  pool = null;
  if (open) await open.end();
}
