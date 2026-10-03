// db/seeds/dev.ts
//
// Development fixtures for the local database. Run it with `npm run db:seed`.
//
// §4.5 asks for a TypeScript program rather than a .sql file, for three reasons
// that all turn out to be load-bearing: it has to hash a password with the same
// library and cost the application uses, it has to walk orders through a state
// machine that refuses illegal jumps, and it has to stay idempotent.
//
// WHAT THIS PROGRAM IS, in one sentence: it truncates an explicit list of tables
// and rebuilds the design's own demo data on top of the reference data the
// migrations own.
//
// THE RISK IS THE TRUNCATE. Part 8 rates "seed pointed at production" as high, and
// it is the only thing in this repository that destroys rows on purpose. So the
// guardrails come before anything else and there are six of them, each aimed at a
// different way of being wrong:
//
//   1. NODE_ENV=production                    — the obvious one
//   2. a non-loopback host                     — needs SEED_ALLOW_REMOTE to NAME it,
//                                                not merely to be true, so a stale
//                                                `true` in a shell cannot authorise
//                                                a different host later
//   3. the old system's tables being present   — catches a loopback URL that is
//                                                really a tunnel to Supabase
//   4. pending migrations                      — seeding a half-migrated schema
//                                                produces errors about the seed
//   5. typing the database name                — unless --yes, and it refuses
//                                                outright with no terminal to ask at
//   6. TRUNCATE without CASCADE                — so a table missing from the list is
//                                                an error from Postgres rather than
//                                                a silent half-wipe
//
// Guardrail 6 is the one worth explaining. CASCADE would make the truncate always
// succeed and quietly reach tables nobody listed. Without it, Postgres refuses the
// statement naming the table that references something in the list — which is
// exactly the review a list of 50 table names needs and cannot get from a human.

import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';

import { seedPeople } from './fixtures/people.ts';
import { seedStores } from './fixtures/stores.ts';
import { seedThemes } from './fixtures/themes.ts';
import { seedCatalogue } from './fixtures/catalogue.ts';
import { seedOrders } from './fixtures/orders.ts';
import { seedMoney } from './fixtures/money.ts';
import { seedSupport } from './fixtures/support.ts';
import { seedKyc } from './fixtures/kyc.ts';
import { seedPromotions, applyPromotions } from './fixtures/promotions.ts';
import { seedVolume } from './fixtures/volume.ts';
import type { Ctx } from './fixtures/context.ts';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(moduleDir, '..', 'migrations');

// The one password every seeded account shares. Printed at the end, because a
// fixture nobody can sign in as is a fixture nobody uses.
const DEV_PASSWORD = 'vendlyfy-dev';

// How many generated orders to add on top of the hand-written ones. The default is
// chosen so that the Orders board pages, Analytics has a shape, and a sequential
// scan is measurably worse than an index scan — which is the milestone's own
// done-when. SEED_ORDERS=0 gives just the fixtures, for a fast loop.
const DEFAULT_VOLUME = 30_000;

// ---------------------------------------------------------------------------
// The truncate list. Every table this program writes, and nothing else.
//
// ORDER MATTERS: children before parents, because there is no CASCADE. Postgres
// truncates them in one statement so the order is not strictly required for
// correctness, but keeping it in dependency order is what makes a missing entry
// obvious to a reader as well as to Postgres.
//
// NOT IN THIS LIST, on purpose — the migrations own these rows and a seed that
// truncated them would leave a database the application cannot start against:
//   schema_migrations
//   industry_templates · industry_template_versions ·
//     industry_template_version_modules · industry_template_version_product_flags
//   modules · product_flags
//   currencies · countries
//   payment_methods · payment_method_countries · payment_method_currencies
//   plans · plan_features · plan_feature_grants
//   role_permissions · notification_types
//   order_status_transitions · complaint_status_transitions · kyc_status_transitions
// ---------------------------------------------------------------------------
const SEED_TABLES = [
  // Support and messaging, which reference almost everything else.
  'audit_log',
  'notification_reads',
  'notification_inbox_state',
  'notification_devices',
  'notifications',
  'review_reports',
  'review_replies',
  'reviews',
  'complaint_evidence',
  'complaint_events',
  'complaints',
  'kyc_extracted_fields',
  'kyc_checks',
  'kyc_documents',
  'kyc_submissions',

  // Money.
  'wallet_ledger',
  'withdrawals',
  'refunds',
  'momo_transactions',
  'wallets',

  // Orders.
  'order_discounts',
  'order_events',
  'order_item_option_values',
  'order_items',
  'orders',
  'store_order_counters',

  // Carts.
  'cart_item_option_values',
  'cart_items',
  'carts',

  // Promotions.
  'promotions',

  // Store look (V015). Cleared with the fulfilment settings because it is the same kind of
  // thing — per-store configuration hanging off `stores`.
  'store_themes',

  // Fulfilment.
  'rider_cash_settlements',
  'rider_cash_handovers',
  'rider_profiles',
  'store_payout_settings',
  'store_payment_methods',
  'store_pickup_settings',
  'delivery_zone_areas',
  'delivery_zones',

  // Catalogue.
  'product_variant_values',
  'product_variants',
  'product_option_groups',
  'option_values',
  'option_groups',
  'product_product_flags',
  'product_images',
  'product_categories',
  'products',
  'categories',

  // Identity.
  'platform_members',
  'store_members',
] as const;

// ---------------------------------------------------------------------------
// `users` and `stores` are cleared by DELETE, not TRUNCATE, and finding out why is
// what guardrail 6 is for.
//
// `industry_template_versions.created_by` references `users` — a migration-owned
// table pointing INTO seeded data, which nobody would have gone looking for.
// TRUNCATE refuses while that constraint exists, however many rows are involved, and
// truncating the templates instead would leave a database the application cannot
// start against. DELETE works: the reference is ON DELETE SET NULL, and the
// migration's own template rows have no creator anyway.
//
// `stores` follows for the same shape of reason: `users.store_id` references it, so
// TRUNCATE would demand truncating `users` at the same time — the thing that cannot
// be done.
//
// Both are safe here only because everything pointing at them has just been
// truncated, which is why they come last and why their order between themselves
// matters.
// ---------------------------------------------------------------------------
const DELETE_LAST = ['users', 'stores'] as const;

// Tables that, if present, mean this is the OLD system's database. Guardrail 3.
const OLD_SYSTEM_TABLES = ['menu_items', 'tenants', 'menu_item_addons', 'add_ons'];

function fail(message: string, hint?: string): never {
  process.stderr.write(`\nFAIL: ${message}\n`);
  if (hint) process.stderr.write(`      ${hint}\n`);
  process.exit(1);
}

const out = (s = '') => process.stdout.write(`${s}\n`);
const step = (s: string) => out(`\n${s}`);
const info = (s: string) => out(`  ${s}`);
const ok = (s: string) => out(`  [ok]   ${s}`);

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

type Target = { url: URL; host: string; port: string; database: string; user: string };

function resolveTarget(): Target {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    fail('DATABASE_URL is not set.', 'Run it through npm run db:seed, which supplies the local one.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('DATABASE_URL is not a URL.');
  }

  const host = url.hostname;
  const database = url.pathname.replace(/^\//, '');
  if (!database) fail('DATABASE_URL names no database.');

  return { url, host, port: url.port || '5432', database, user: url.username || userInfo().username };
}

function assertSafeTarget(t: Target): void {
  // 1. Never in production, whatever the URL says.
  if (process.env.NODE_ENV === 'production') {
    fail(
      'NODE_ENV=production. This program truncates tables and will not run.',
      'There is no override. Seeds are for development databases.',
    );
  }

  // 2. Loopback, or a host named explicitly. Naming it — rather than a boolean —
  //    means an authorisation cannot outlive the host it was granted for.
  if (!LOOPBACK.has(t.host)) {
    const allowed = process.env.SEED_ALLOW_REMOTE;
    if (!allowed) {
      fail(
        `${t.host} is not loopback, and this program truncates tables.`,
        `If you mean it: SEED_ALLOW_REMOTE=${t.host} npm run db:seed`,
      );
    }
    if (allowed !== t.host) {
      fail(
        `SEED_ALLOW_REMOTE names ${allowed}, but DATABASE_URL points at ${t.host}.`,
        'It has to name the host you are about to truncate. That is the point of it.',
      );
    }
  }
}

async function assertNotTheOldSystem(client: Client): Promise<void> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY ($1)
      ORDER BY table_name`,
    [OLD_SYSTEM_TABLES],
  );
  if (rows.length > 0) {
    fail(
      `this database has the old system's tables in it: ${rows.map((r) => r.table_name).join(', ')}.`,
      'A loopback address can still be a tunnel. Nothing was written.',
    );
  }
}

async function assertFullyMigrated(client: Client): Promise<number> {
  const exists = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  if (!exists.rows[0]?.present) {
    fail('this database has no schema_migrations table.', 'Run: npm run db:migrate');
  }

  const applied = await client.query<{ version: string }>(
    `SELECT version::text FROM schema_migrations ORDER BY version`,
  );
  const appliedSet = new Set(applied.rows.map((r) => r.version));

  const files = (await readdir(migrationsDir)).filter((f) => /^V\d+_.+\.sql$/.test(f));
  const pending = files.filter((f) => !appliedSet.has(String(Number(f.slice(1).split('_')[0]))));

  if (pending.length > 0) {
    fail(
      `${pending.length} migration(s) have not been applied: ${pending.sort().join(', ')}.`,
      'Seeding a half-migrated schema produces errors that look like seed bugs. Run: npm run db:migrate',
    );
  }

  return appliedSet.size;
}

async function confirm(t: Target, assumeYes: boolean, rowsAtRisk: number): Promise<void> {
  if (assumeYes) return;

  if (!process.stdin.isTTY) {
    fail(
      'refusing to truncate without a terminal to confirm at.',
      'Pass --yes, or set SEED_YES=1, if this is a script that means it.',
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n  This DELETES ${rowsAtRisk.toLocaleString()} existing row(s) in ${t.database}.` +
        `\n  Type the database name (${t.database}) to continue: `,
    );
    if (answer.trim() !== t.database) fail('aborted — nothing was written.');
  } finally {
    rl.close();
  }
}

async function countSeedRows(client: Client): Promise<number> {
  // Counted rather than estimated: pg_class.reltuples is a planner estimate and
  // reads as an authoritative number when printed next to the word DELETES.
  const unions = [...SEED_TABLES, ...DELETE_LAST]
    .map((t) => `SELECT count(*) AS n FROM ${t}`)
    .join(' UNION ALL ');
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(sum(n), 0)::text AS total FROM (${unions}) counts`,
  );
  return Number(rows[0]?.total ?? 0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let assumeYes = process.env.SEED_YES === '1';
  let dryRun = false;
  let volume = Number(process.env.SEED_ORDERS ?? DEFAULT_VOLUME);

  for (const arg of args) {
    if (arg === '-y' || arg === '--yes') assumeYes = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--orders=')) volume = Number(arg.slice('--orders='.length));
    else fail(`unknown argument: ${arg}`, 'Accepts --yes, --dry-run, --orders=N.');
  }

  if (!Number.isInteger(volume) || volume < 0) {
    fail(`--orders must be a whole number of orders, not ${volume}.`);
  }

  const target = resolveTarget();
  assertSafeTarget(target);

  step('Target');
  info(`database   : ${target.host}:${target.port}/${target.database}`);
  info(`as         : ${target.user}`);
  info(`from       : ${userInfo().username}@${hostname()}`);
  info(`generated  : ${volume.toLocaleString()} order(s) on top of the fixtures`);

  const client = new Client({ connectionString: target.url.toString() });
  await client.connect();

  try {
    step('Checks');
    await assertNotTheOldSystem(client);
    ok("this is not the old system's database");

    const migrations = await assertFullyMigrated(client);
    ok(`${migrations} migrations applied, none pending`);

    const rowsAtRisk = await countSeedRows(client);
    ok(
      `${SEED_TABLES.length + DELETE_LAST.length} tables in the clear list, ` +
        `holding ${rowsAtRisk.toLocaleString()} row(s)`,
    );

    if (dryRun) {
      step('Dry run — nothing was written');
      info('Every check passed. Re-run without --dry-run to seed.');
      return;
    }

    await confirm(target, assumeYes, rowsAtRisk);

    step('Clearing');
    // No CASCADE: see the header. RESTART IDENTITY so reference numbers — complaint
    // C-1, refund R-1 — start where a fresh install would start them.
    await client.query(`TRUNCATE TABLE ${SEED_TABLES.join(', ')} RESTART IDENTITY`);
    ok(`${SEED_TABLES.length} tables truncated`);
    for (const table of DELETE_LAST) {
      await client.query(`DELETE FROM ${table}`);
    }
    ok(`${DELETE_LAST.join(' and ')} deleted \u2014 see the note above on why not truncated`);

    step('Hashing the shared development password');
    const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);
    ok('bcrypt cost 12, the same as server/src/routes/auth.js');

    const ctx: Ctx = {
      client,
      sql: (text, values) => client.query(text, values),
      passwordHash,
      volume,
      step,
      info,
      ok,
    };

    // THE PHASE ORDER IS THE SCHEMA'S, not a preference. Three of these were moved
    // because the database refused them the other way round, and each refusal was
    // the right one:
    //
    //   * KYC before MONEY, because request_withdrawal() refuses an unverified store
    //     (V012). A seed that paid out before verifying would have been seeding a
    //     state the application cannot reach.
    //   * PROMOTIONS before ORDERS, so a code exists to apply — but the APPLYING
    //     comes after, because a discount is a row against an order and
    //     orders.discount_amount has to equal the rows behind it (V013).
    //   * SUPPORT last, because a complaint names an order and a review names an
    //     order LINE.
    await client.query('BEGIN');
    await seedStores(ctx);
    await seedPeople(ctx);
    await seedCatalogue(ctx);
    // Themes need only the stores, and they are compiled rather than written, so they sit with
    // the stores rather than in a phase of their own.
    await seedThemes(ctx);
    await client.query('COMMIT');

    await client.query('BEGIN');
    await seedKyc(ctx);
    await client.query('COMMIT');

    await client.query('BEGIN');
    await seedPromotions(ctx);
    await seedOrders(ctx);
    await applyPromotions(ctx);
    await client.query('COMMIT');

    await client.query('BEGIN');
    await seedMoney(ctx);
    await client.query('COMMIT');

    await client.query('BEGIN');
    await seedSupport(ctx);
    await client.query('COMMIT');

    // The bulk rows commit in batches of their own, because 30,000 orders' worth of
    // deferred constraint triggers in one transaction is a lot of memory to hold
    // for no reason.
    await seedVolume(ctx);

    step('Analysing');
    await client.query('ANALYZE');
    ok('planner statistics refreshed, so EXPLAIN reflects the seeded volumes');

    step('Done');
    info(`Every account's password is: ${DEV_PASSWORD}`);
    info('Sign in as owner@nyama.example (owner) or manager@nyama.example (manager).');
    info('Vendlyfy team: grace@vendlyfy.example.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nFAIL: ${message}\n`);
  if (error instanceof Error && 'detail' in error && error.detail) {
    process.stderr.write(`      ${String(error.detail)}\n`);
  }
  if (error instanceof Error && 'hint' in error && error.hint) {
    process.stderr.write(`      ${String(error.hint)}\n`);
  }
  process.exitCode = 1;
});
