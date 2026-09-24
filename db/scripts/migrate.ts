#!/usr/bin/env node
//
// Vendlyfy migration runner — milestone 2 of docs/migration/04-implementation-plan.md.
//
// Implements the seven requirements of §2.4:
//
//   1. a Postgres advisory lock for the whole run
//   2. every filename parsed and validated; duplicate versions rejected, naming both files
//   3. sorted NUMERICALLY, never lexicographically, so a padding slip cannot reorder anything
//   4. out-of-order application refused — a pending version below the highest applied one
//   5. checksums of applied migrations verified; abort on mismatch, naming the file
//   6. each migration in its own transaction, with its ledger row written INSIDE it
//   7. an opt-out of that transaction for CREATE INDEX CONCURRENTLY, recorded as such
//
//   usage: migrate [up] [--dry-run] [--yes]
//          migrate status
//          migrate new "what it does"
//
//   options: --dir <path>   migrations directory (default db/migrations)
//            --url <url>    connection string (default $DATABASE_URL)
//
// Run it through db/scripts/migrate.sh (or npm run db:migrate), which supplies
// the local connection string from docker-compose.yml so there is no second copy
// of it here.

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

// V + digits + _ + snake_case + .sql   e.g. V007_add_product_variants.sql
const FILENAME = /^V(\d{1,6})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

// Arbitrary but permanent. Every runner against this database must use the same
// number or the lock protects nothing.
const ADVISORY_LOCK_KEY = 4820250924n;

const LEDGER = 'schema_migrations';

// The opt-out from requirement 7. Must be on its own line, in the file header.
const NO_TRANSACTION = /^--[ \t]*migrate:no-transaction[ \t]*$/m;
const HEADER_LINES = 40;

// Statements that the runner must never see: it owns the transaction.
const TX_CONTROL = /^(begin|start\s+transaction|commit|end|rollback|savepoint|release\s+savepoint|set\s+transaction)\b/i;

// Statements Postgres refuses to run inside a transaction block. Deliberately
// narrow: ANALYZE and REFRESH MATERIALIZED VIEW CONCURRENTLY are both legal
// inside one, so neither belongs here.
const NEEDS_NO_TRANSACTION = /^(vacuum|create\s+database|drop\s+database|alter\s+system|create\s+tablespace|drop\s+tablespace)\b/i;
const INDEX_CONCURRENTLY = /^((create|drop)\s+(unique\s+)?index\s+concurrently|reindex\s+[^;]*\bconcurrently)\b/i;

const LOCK_TIMEOUT = process.env.MIGRATE_LOCK_TIMEOUT ?? '10s';
const LOCK_WAIT_SECONDS = Number(process.env.MIGRATE_LOCK_WAIT_SECONDS ?? '60');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Statement = { raw: string; code: string; line: number };

type Migration = {
  version: number;
  filename: string;
  filepath: string;
  checksum: string;
  transactional: boolean;
  statements: Statement[];
};

type LedgerRow = {
  version: string;
  filename: string;
  checksum: string;
  applied_at: Date;
  duration_ms: number;
  applied_by: string;
  transactional: boolean;
};

class MigrateError extends Error {}

// A declaration, not `const fail = () => …`: TypeScript only treats a call as
// never-returning — and so only narrows the code after it — for a function
// declaration or a const with an explicit type annotation.
function fail(message: string): never {
  throw new MigrateError(message);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const step = (s: string) => console.log(`\n${s}`);
const info = (s: string) => console.log(`  ${s}`);
const ok = (s: string) => console.log(`  [ok]   ${s}`);
const warn = (s: string) => console.log(`  [warn] ${s}`);

// ---------------------------------------------------------------------------
// Reading migrations
// ---------------------------------------------------------------------------

/**
 * Strip a BOM and normalise CRLF to LF before hashing AND before executing, so
 * that a checkout with different line endings does not read as tampering — and
 * so that what was hashed is exactly what ran.
 */
function normalise(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

function checksumOf(normalised: string): string {
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/**
 * Split a migration into statements.
 *
 * This has to be a real scanner, not a split on ';'. Semicolons live inside
 * string literals, inside comments, and — the case that matters most here —
 * inside the dollar-quoted body of every plpgsql function the schema needs.
 *
 * Returns each statement twice over: `raw` is exactly what is sent to Postgres,
 * comments and all; `code` has comments replaced by a space, which is what the
 * safety checks below are matched against so that a keyword in a comment cannot
 * trigger or suppress one.
 */
function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  const n = sql.length;
  let i = 0;
  let start = 0;
  let code = '';

  const lineOf = (offset: number) => {
    let line = 1;
    for (let k = 0; k < offset; k++) if (sql[k] === '\n') line++;
    return line;
  };

  const push = (end: number) => {
    const raw = sql.slice(start, end);
    if (raw.trim() !== '' && code.trim() !== '') {
      const lead = raw.length - raw.trimStart().length;
      out.push({ raw: raw.trim(), code: code.trim(), line: lineOf(start + lead) });
    }
    code = '';
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // Line comment — dropped from `code`, kept in `raw`.
    if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? n : eol;
      code += ' ';
      continue;
    }

    // Block comment. Postgres nests these, unlike most SQL dialects.
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; }
        else i += 1;
      }
      code += ' ';
      continue;
    }

    // Dollar-quoted string: $$ … $$ or $tag$ … $tag$. A tag must start with a
    // letter or underscore, so $1 is a parameter, not an opening quote.
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i, i + 130));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        code += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    // Single-quoted literal. '' escapes a quote. A backslash escapes one only in
    // an E'…' string, since standard_conforming_strings is on.
    if (c === "'") {
      const prev = sql[i - 1];
      const prev2 = sql[i - 2];
      const escapes =
        (prev === 'E' || prev === 'e') &&
        !(prev2 !== undefined && /[A-Za-z0-9_$]/.test(prev2));
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      code += sql.slice(i, j);
      i = j;
      continue;
    }

    // Quoted identifier. "" escapes a quote; backslashes are literal.
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      code += sql.slice(i, j);
      i = j;
      continue;
    }

    if (c === ';') {
      push(i);
      i += 1;
      start = i;
      continue;
    }

    code += c;
    i += 1;
  }

  push(n); // a final statement without a trailing semicolon is legal
  return out;
}

function parseMigration(filename: string, filepath: string, text: string): Migration {
  const match = FILENAME.exec(filename);
  if (!match) {
    return fail(
      `bad migration filename: ${filename}\n` +
      `      expected V<number>_<snake_case>.sql, for example V001_identity_and_stores.sql`,
    );
  }
  const version = Number(match[1]);
  const normalised = normalise(text);
  const statements = splitStatements(normalised);

  if (statements.length === 0) {
    fail(`${filename} contains no statements. An empty migration would be recorded as applied and do nothing.`);
  }

  const header = normalised.split('\n').slice(0, HEADER_LINES).join('\n');
  const transactional = !NO_TRANSACTION.test(header);

  for (const [index, st] of statements.entries()) {
    if (TX_CONTROL.test(st.code)) {
      fail(
        `${filename}:${st.line} contains transaction control (statement ${index + 1}).\n` +
        `      The runner owns the transaction — it writes the ledger row inside it, so that a\n` +
        `      failure can leave nothing half-applied. Remove BEGIN / COMMIT / ROLLBACK.`,
      );
    }
    const needsNoTx = NEEDS_NO_TRANSACTION.test(st.code) || INDEX_CONCURRENTLY.test(st.code);
    if (needsNoTx && transactional) {
      fail(
        `${filename}:${st.line} cannot run inside a transaction block (statement ${index + 1}).\n` +
        `      Add this line to the file header, on its own line:\n` +
        `          -- migrate:no-transaction\n` +
        `      Understand the trade: a non-transactional migration that fails part-way leaves the\n` +
        `      database changed and nothing recorded in ${LEDGER}.`,
      );
    }
  }

  return {
    version,
    filename,
    filepath,
    checksum: checksumOf(normalised),
    transactional,
    statements,
  };
}

async function loadMigrations(dir: string): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return fail(`no migrations directory at ${dir}`);
  }

  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  const byVersion = new Map<number, Migration>();

  for (const filename of files) {
    const filepath = path.join(dir, filename);
    const m = parseMigration(filename, filepath, await readFile(filepath, 'utf8'));

    // Requirement 2: duplicate versions are the way two merged branches corrupt
    // a schema. Name both files — the fix is a rename, and you need to know which.
    const clash = byVersion.get(m.version);
    if (clash) {
      fail(
        `two migrations claim version ${m.version}:\n` +
        `        ${clash.filename}\n` +
        `        ${m.filename}\n` +
        `      Version numbers are claimed at merge, not when the work starts. Renumber the later one.`,
      );
    }
    byVersion.set(m.version, m);
    migrations.push(m);
  }

  // Requirement 3: numeric order. Gaps are fine — an abandoned branch leaves one.
  migrations.sort((a, b) => a.version - b.version);
  return migrations;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

// Created by the runner, not by V000: nothing can record V000 as applied until
// the table exists. Deliberately left out of the app role's default privileges —
// the application has no business reading it (V000 grants, and runs after this).
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS ${LEDGER} (
    version       bigint      PRIMARY KEY,
    filename      text        NOT NULL,
    checksum      text        NOT NULL,
    applied_at    timestamptz NOT NULL DEFAULT now(),
    duration_ms   integer     NOT NULL,
    applied_by    text        NOT NULL,
    transactional boolean     NOT NULL
);
COMMENT ON TABLE ${LEDGER} IS
    'Applied migrations. The PRIMARY KEY on version — not on filename — is what enforces run-once.';
COMMENT ON COLUMN ${LEDGER}.checksum IS
    'sha256 of the migration file, CRLF-normalised. A mismatch means the file changed after it was applied.';
COMMENT ON COLUMN ${LEDGER}.transactional IS
    'false when the migration opted out of its transaction (migrate:no-transaction), e.g. CREATE INDEX CONCURRENTLY.';
`;

/**
 * `create: false` keeps `status` and `--dry-run` strictly read-only — neither
 * should leave a table behind on a database it was only asked to inspect.
 */
async function readLedger(client: Client, { create }: { create: boolean }): Promise<LedgerRow[]> {
  if (create) {
    await client.query(LEDGER_DDL);
  } else {
    const { rows } = await client.query<{ exists: string | null }>(
      'SELECT to_regclass($1)::text AS exists', [LEDGER],
    );
    if ((rows[0]?.exists ?? null) === null) return [];
  }
  const { rows } = await client.query<LedgerRow>(
    `SELECT version, filename, checksum, applied_at, duration_ms, applied_by, transactional
       FROM ${LEDGER} ORDER BY version`,
  );
  return rows;
}

/** Requirement 5, plus the rename case, which is a warning rather than a stop. */
function verifyApplied(migrations: Migration[], rows: LedgerRow[]): string[] {
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const warnings: string[] = [];

  for (const row of rows) {
    const version = Number(row.version);
    const file = byVersion.get(version);
    if (!file) {
      fail(
        `migration ${row.filename} (version ${version}) is recorded as applied but its file is gone.\n` +
        `      The ledger and the repository disagree. Restore the file, or reconcile deliberately.`,
      );
    }
    if (file.checksum !== row.checksum) {
      fail(
        `${file.filename} changed after it was applied.\n` +
        `        recorded: ${row.checksum.slice(0, 16)}…\n` +
        `        on disk:  ${file.checksum.slice(0, 16)}…\n` +
        `      Migrations are forward-only. Write a new migration for the correction instead of\n` +
        `      editing this one — the database no longer matches what this file says.`,
      );
    }
    if (file.filename !== row.filename) {
      warnings.push(
        `version ${version} was applied as ${row.filename} and is now ${file.filename}. ` +
        `Content is unchanged. Reconcile with: UPDATE ${LEDGER} SET filename = '${file.filename}' WHERE version = ${version};`,
      );
    }
  }
  return warnings;
}

/** Requirement 4. */
function checkOrder(pending: Migration[], rows: LedgerRow[]): void {
  if (rows.length === 0 || pending.length === 0) return;
  const highest = Math.max(...rows.map((r) => Number(r.version)));
  const late = pending.filter((m) => m.version < highest);
  if (late.length > 0) {
    fail(
      `these migrations are pending but their versions are below the highest applied (${highest}):\n` +
      late.map((m) => `        ${m.filename}`).join('\n') + '\n' +
      `      Applying them now would build a schema in an order no other environment will ever\n` +
      `      reproduce. This is how a branch merge corrupts a database. Renumber them above ${highest}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

function pgErrorDetail(error: unknown): string {
  const e = error as { message?: string; detail?: string; hint?: string; position?: string; where?: string };
  const parts = [e.message ?? String(error)];
  if (e.detail) parts.push(`detail: ${e.detail}`);
  if (e.hint) parts.push(`hint: ${e.hint}`);
  if (e.where) parts.push(`context: ${e.where}`);
  return parts.join('\n        ');
}

async function runStatements(client: Client, m: Migration): Promise<void> {
  for (const [index, st] of m.statements.entries()) {
    try {
      await client.query(st.raw);
    } catch (error) {
      throw new MigrateError(
        `${m.filename}:${st.line} failed (statement ${index + 1} of ${m.statements.length})\n` +
        `        ${pgErrorDetail(error)}\n` +
        `      ${(st.raw.split('\n')[0] ?? st.raw).slice(0, 100)}`,
      );
    }
  }
}

async function applyOne(client: Client, m: Migration, appliedBy: string): Promise<number> {
  const insert = {
    text: `INSERT INTO ${LEDGER} (version, filename, checksum, duration_ms, applied_by, transactional)
           VALUES ($1, $2, $3, $4, $5, $6)`,
    values: [] as unknown[],
  };
  const started = performance.now();

  if (m.transactional) {
    // Requirement 6: the ledger row is written inside the same transaction as
    // the migration, so a failure leaves nothing half-applied and nothing
    // falsely recorded.
    await client.query('BEGIN');
    try {
      await runStatements(client, m);
      const ms = Math.round(performance.now() - started);
      insert.values = [m.version, m.filename, m.checksum, ms, appliedBy, true];
      await client.query(insert.text, insert.values);
      await client.query('COMMIT');
      return ms;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  // Requirement 7. There is no transaction to roll back, so say what that means
  // if it fails rather than leaving someone to work it out.
  try {
    await runStatements(client, m);
  } catch (error) {
    const message = error instanceof MigrateError ? error.message : pgErrorDetail(error);
    throw new MigrateError(
      `${message}\n\n` +
      `      ${m.filename} runs WITHOUT a transaction (migrate:no-transaction). Nothing was rolled\n` +
      `      back and nothing was recorded in ${LEDGER}: the database may be partly changed.\n` +
      `      Inspect it before re-running.`,
    );
  }
  const ms = Math.round(performance.now() - started);
  insert.values = [m.version, m.filename, m.checksum, ms, appliedBy, false];
  await client.query(insert.text, insert.values);
  return ms;
}

// ---------------------------------------------------------------------------
// Connection and lock
// ---------------------------------------------------------------------------

type Target = { client: Client; label: string; user: string; loopback: boolean };

async function connect(url: string): Promise<Target> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail(`DATABASE_URL is not a valid connection string`);
  }
  const host = parsed.hostname;
  const database = parsed.pathname.replace(/^\//, '');
  const client = new Client({ connectionString: url, application_name: 'vendlyfy-migrate' });
  try {
    await client.connect();
  } catch (error) {
    return fail(`cannot connect to ${host}:${parsed.port || 5432}/${database}\n        ${pgErrorDetail(error)}`);
  }
  const { rows } = await client.query<{ user: string }>('SELECT current_user AS user');
  const user = rows[0]?.user;
  if (user === undefined) fail('SELECT current_user returned no rows — the connection is not usable');
  return {
    client,
    label: `${host}:${parsed.port || 5432}/${database}`,
    user,
    loopback: host === '127.0.0.1' || host === 'localhost' || host === '::1',
  };
}

/**
 * Requirement 1. A try-loop rather than pg_advisory_lock() + lock_timeout,
 * because lock_timeout's effect on advisory locks is not something to bet a
 * deploy on. Session-scoped: held until released or the connection closes.
 */
async function takeLock(client: Client): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_SECONDS * 1000;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [ADVISORY_LOCK_KEY.toString()],
    );
    if (rows[0]?.locked === true) return;
    if (Date.now() >= deadline) {
      fail(
        `another migration run holds the advisory lock (waited ${LOCK_WAIT_SECONDS}s).\n` +
        `      Two runs against one database is exactly what this prevents. If you are certain no\n` +
        `      other run is alive, find the session: SELECT * FROM pg_locks WHERE locktype = 'advisory';`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdUp(dir: string, url: string, dryRun: boolean, assumeYes: boolean): Promise<void> {
  const migrations = await loadMigrations(dir);
  const target = await connect(url);
  const { client } = target;

  try {
    step(`Target`);
    info(`database   : ${target.label}`);
    info(`as         : ${target.user}`);
    info(`migrations : ${dir} (${migrations.length} file${migrations.length === 1 ? '' : 's'})`);

    if (!target.loopback && !assumeYes && process.stdin.isTTY) {
      fail(
        `${target.label} is not local, and this is an interactive terminal.\n` +
        `      Re-run with --yes if you meant to migrate it. (A deploy runs without a TTY and is\n` +
        `      not asked.)`,
      );
    }

    await takeLock(client);
    // set_config, not `SET lock_timeout = '…'`: SET takes no parameters, and §2.3
    // forbids interpolating anything into SQL — including an env var.
    await client.query('SELECT set_config($1, $2, false)', ['lock_timeout', LOCK_TIMEOUT]);

    const rows = await readLedger(client, { create: !dryRun });
    for (const w of verifyApplied(migrations, rows)) warn(w);

    const applied = new Set(rows.map((r) => Number(r.version)));
    const pending = migrations.filter((m) => !applied.has(m.version));
    checkOrder(pending, rows);

    if (pending.length === 0) {
      step(`Up to date — ${rows.length} migration${rows.length === 1 ? '' : 's'} applied, none pending.`);
      return;
    }

    step(dryRun ? `Would apply ${pending.length}` : `Applying ${pending.length}`);
    if (dryRun) {
      for (const m of pending) {
        info(`${m.filename}  ${m.statements.length} statement${m.statements.length === 1 ? '' : 's'}` +
             `${m.transactional ? '' : '  [no transaction]'}`);
      }
      step('Dry run — nothing was applied.');
      return;
    }

    const appliedBy = `${target.user} (${userInfo().username}@${hostname()})`;
    for (const m of pending) {
      const ms = await applyOne(client, m, appliedBy);
      ok(`${m.filename}  ${ms}ms  ${m.statements.length} statement${m.statements.length === 1 ? '' : 's'}` +
         `${m.transactional ? '' : '  [no transaction]'}`);
    }
    step(`Applied ${pending.length} migration${pending.length === 1 ? '' : 's'}.`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function cmdStatus(dir: string, url: string): Promise<void> {
  const migrations = await loadMigrations(dir);
  const target = await connect(url);
  const { client } = target;

  try {
    step(`Target`);
    info(`database   : ${target.label}`);
    info(`as         : ${target.user}`);
    info(`migrations : ${dir}`);

    const rows = await readLedger(client, { create: false });
    const byVersion = new Map(rows.map((r) => [Number(r.version), r]));

    step(`Migrations`);
    if (migrations.length === 0) {
      info('none');
    } else {
      info('version  filename'.padEnd(52) + 'applied'.padEnd(22) + 'ms'.padEnd(8) + 'state');
      for (const m of migrations) {
        const row = byVersion.get(m.version);
        const state = !row ? 'pending'
          : row.checksum !== m.checksum ? 'CHANGED SINCE APPLIED'
          : row.transactional ? 'applied'
          : 'applied [no transaction]';
        const when = row ? row.applied_at.toISOString().replace('T', ' ').slice(0, 19) : '—';
        info(
          String(m.version).padStart(7) + '  ' +
          m.filename.padEnd(43) + when.padEnd(22) +
          String(row?.duration_ms ?? '—').padEnd(8) + state,
        );
      }
    }

    const orphans = rows.filter((r) => !migrations.some((m) => m.version === Number(r.version)));
    if (orphans.length > 0) {
      step(`Recorded as applied, but no file exists`);
      for (const r of orphans) info(`${r.filename} (version ${r.version}) — applied ${r.applied_at.toISOString()}`);
    }

    const pending = migrations.filter((m) => !byVersion.has(m.version));
    const drifted = migrations.filter((m) => byVersion.get(m.version)?.checksum && byVersion.get(m.version)!.checksum !== m.checksum);
    step(`${rows.length} applied · ${pending.length} pending · ${drifted.length} changed since applied`);
    if (drifted.length > 0 || orphans.length > 0) {
      warn('db:migrate will refuse to run until this is reconciled.');
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function cmdNew(dir: string, description: string): Promise<void> {
  const slug = description.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (slug === '') fail('a description is required: db:migrate:new "add product variants"');

  const existing = await loadMigrations(dir);
  const next = existing.length === 0 ? 1 : Math.max(...existing.map((m) => m.version)) + 1;
  const filename = `V${String(next).padStart(3, '0')}_${slug}.sql`;
  const filepath = path.join(dir, filename);

  const template = `-- ${filename}
--
-- <one concern, described in a sentence>
--
-- Conventions — docs/migration/04-implementation-plan.md §2.3 and §2.4:
--
--   * One concern per file. A rename and its backfill are two migrations.
--   * Claim this version number at MERGE, not now. Two branches otherwise both
--     take V${String(next).padStart(3, '0')}, and the runner will reject them — by design.
--   * Every table declares its indexes in this same file, and every index names
--     the query it serves in a comment. An unjustified index taxes every write.
--   * Composite indexes lead with tenant_id.
--   * Destructive statements get their own migration, with a header comment
--     naming what was checked before writing it.
--   * The runner owns the transaction. Do not write BEGIN, COMMIT or ROLLBACK.
--   * For CREATE INDEX CONCURRENTLY, add this line to the header — and know that
--     a failure then leaves the database changed with nothing recorded:
--         -- migrate:no-transaction

`;

  await writeFile(filepath, template, { flag: 'wx' });
  step(`Created`);
  info(path.relative(process.cwd(), filepath));
  info(`Renumber it at merge time if another branch has taken V${String(next).padStart(3, '0')} by then.`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let command = 'up';
  let dir = path.join(import.meta.dirname, '..', 'migrations');
  let url = process.env.DATABASE_URL ?? '';
  let dryRun = false;
  let assumeYes = process.env.MIGRATE_ASSUME_YES === '1';
  const positional: string[] = [];

  const rest = [...argv];
  for (;;) {
    const arg = rest.shift();
    if (arg === undefined) break;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--yes' || arg === '-y') assumeYes = true;
    else if (arg === '--dir') dir = path.resolve(rest.shift() ?? fail('--dir needs a path'));
    else if (arg === '--url') url = rest.shift() ?? fail('--url needs a connection string');
    else if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
    else positional.push(arg);
  }

  const first = positional[0];
  if (first !== undefined && ['up', 'status', 'new'].includes(first)) {
    command = first;
    positional.shift();
  }

  if (command === 'new') {
    await cmdNew(dir, positional.join(' '));
    return;
  }

  if (url === '') {
    fail('no connection string. Set DATABASE_URL or pass --url. (npm run db:migrate supplies the local one.)');
  }

  if (command === 'status') await cmdStatus(dir, url);
  else await cmdUp(dir, url, dryRun, assumeYes);
}

// process.exitCode rather than process.exit(): exit() can discard output that is
// still buffered when stdout is a pipe, which is precisely how this runs in CI.
main().then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    if (error instanceof MigrateError) {
      console.error(`\nFAIL: ${error.message}`);
    } else {
      console.error(`\nFAIL: unexpected error`);
      console.error(error);
    }
    process.exitCode = 1;
  },
);
