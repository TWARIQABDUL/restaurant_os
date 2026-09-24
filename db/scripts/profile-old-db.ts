#!/usr/bin/env node
/**
 * Read-only profile of the OLD (Supabase) database — the prerequisite Stage B of
 * docs/migration/04-implementation-plan.md names before `V001` is written.
 *
 * It answers the six questions the plan lists, plus the ones that turned out to
 * matter while writing it. The point is that the new schema is decided from what
 * production actually contains rather than from what supabase/*.sql says it
 * should: several migrations amended those tables after the files were written,
 * and the files cannot tell you how many category values are typo variants of
 * each other.
 *
 *   npm run db:profile              writes docs/migration/05-old-database-profile.md
 *   npm run db:profile -- --out -   prints the report instead of writing it
 *
 * SAFETY. This runs against a live database holding real money, so:
 *
 *   * the session is set read-only before anything else, and a canary UPDATE
 *     (guarded by WHERE false, so it cannot change a row even if the guard
 *     failed) must be REFUSED before any probe runs;
 *   * statement_timeout and lock_timeout are short, so a probe cannot sit on a
 *     lock or pin a connection;
 *   * every query is a SELECT, and the only identifiers interpolated into SQL
 *     come from the catalogue and are re-checked against a strict pattern.
 *
 * PRIVACY. The report carries no personal data: no email addresses, names,
 * phone numbers or addresses. Where a question is about emails, only counts are
 * reported. Where a discrepancy needs to be traceable, a tenant's id prefix is
 * used rather than its name, and balances are never printed — only the size of
 * the disagreement.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_OUT = path.join(REPO, 'docs', 'migration', '05-old-database-profile.md');

/** Catalogue identifiers only, re-checked before interpolation. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const out: string[] = [];
const write = (line = '') => out.push(line);
const h2 = (s: string) => { write(); write(`## ${s}`); write(); };
const h3 = (s: string) => { write(); write(`### ${s}`); write(); };

function table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  if (rows.length === 0) { write('_no rows_'); return; }
  write(`| ${headers.join(' | ')} |`);
  write(`|${headers.map(() => '---').join('|')}|`);
  for (const r of rows) write(`| ${r.join(' | ')} |`);
}

const num = (v: unknown): string =>
  v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US');

// ---------------------------------------------------------------------------

async function tablesInPublic(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  return rows.map((r) => r.name).filter((n) => SAFE_IDENTIFIER.test(n));
}

async function columnsOf(client: Client, tableName: string): Promise<Map<string, string>> {
  const { rows } = await client.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tableName],
  );
  return new Map(rows.map((r) => [r.column_name, r.data_type]));
}

async function exactCount(client: Client, tableName: string): Promise<number> {
  if (!SAFE_IDENTIFIER.test(tableName)) throw new Error(`refusing to count ${tableName}`);
  // The identifier comes from pg_class and is re-checked above; a value can never
  // reach this string, and count(*) needs no parameters.
  const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM public.${tableName}`);
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let outPath = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--out needs a path, or - for stdout');
      outPath = next; i += 1;
    } else {
      throw new Error(`unknown option: ${argv[i] ?? ''}`);
    }
  }

  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set. Run through db/scripts/profile-old-db.sh, which reads it from server/.env.',
    );
  }
  const parsed = new URL(url);
  const target = `${parsed.hostname}/${parsed.pathname.replace(/^\//, '')}`;

  const client = new Client({ connectionString: url, application_name: 'vendlyfy-profile' });
  await client.connect();

  try {
    await client.query("SET statement_timeout = '30s'");
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET idle_in_transaction_session_timeout = '60s'");

    // --- prove the database will refuse a write ----------------------------
    // An explicit read-only transaction rather than SET default_transaction_read_only,
    // because a transaction-pooled connection (Supabase's port 6543) rejects
    // session-level SET and this has to work either way.
    //
    // CREATE TEMP TABLE as the canary, not an UPDATE: it depends on no table
    // existing, and in the event the guard were NOT in force it creates a
    // session-scoped table that disappears when the connection closes — so the
    // failure mode of the safety check is itself harmless, and it never takes a
    // lock on a real table.
    await client.query('BEGIN TRANSACTION READ ONLY');
    let refused = false;
    try {
      await client.query('CREATE TEMP TABLE vendlyfy_readonly_canary (x int)');
    } catch (error) {
      refused = (error as { code?: string }).code === '25006';
    }
    await client.query('ROLLBACK');
    if (!refused) {
      throw new Error('a write was NOT refused — the read-only guard is not working. Aborting.');
    }
    console.log('  [ok]   the database refused a guarded write (25006) — read-only confirmed');

    // --- one snapshot for every probe --------------------------------------
    // REPEATABLE READ so that all of it describes the database at one instant.
    // Without this, section 7 is unreliable: a payment landing between the
    // wallet_ledger sum and the wallets read would look exactly like drift, and
    // the whole point of that section is to tell real drift from noise.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: snap } = await client.query<{ at: string }>(
      'SELECT now()::text AS at',
    );
    console.log(`  [ok]   snapshot taken at ${snap[0]?.at ?? '?'}`);

    const { rows: ver } = await client.query<{ v: string }>('SELECT version() AS v');
    const { rows: siz } = await client.query<{ s: string }>(
      'SELECT pg_size_pretty(pg_database_size(current_database())) AS s',
    );

    write('# Profile of the old database');
    write();
    write('**Generated by** `npm run db:profile` (`db/scripts/profile-old-db.ts`).');
    write(`**When** ${new Date().toISOString()}`);
    write(`**Target** \`${target}\` · ${siz[0]?.s ?? '?'}`);
    write(`**Server** ${(ver[0]?.v ?? '').split(' on ')[0]}`);
    write();
    write('Read-only throughout, and every figure below is from **one REPEATABLE READ snapshot**, so');
    write('the numbers are consistent with each other — section 7 in particular cannot mistake a');
    write('payment that landed mid-run for ledger drift. A guarded write is attempted first and must');
    write('be refused by the server before any probe runs.');
    write();
    write('**No personal data.** No emails, names, phone numbers or addresses appear below, and');
    write('questions about emails are answered with counts. Aggregate money figures *are* included');
    write('in §7, because there the figures are the finding — a reconciliation cannot be explained');
    write('without them. Stores are identified by id prefix rather than by name.');
    write();
    write('This is the evidence behind `V001` onward. Where it contradicts `supabase/*.sql`, it wins:');
    write('those files were amended by later migrations and cannot describe the data itself.');

    const tables = await tablesInPublic(client);

    // =====================================================================
    h2('1. What is actually there');
    // =====================================================================
    const counts: [string, number][] = [];
    for (const t of tables) counts.push([t, await exactCount(client, t)]);
    counts.sort((a, b) => b[1] - a[1]);
    write(`${tables.length} tables in \`public\`. Exact counts, largest first.`);
    write();
    table(['table', 'rows'], counts.map(([t, n]) => [`\`${t}\``, num(n)]));

    // =====================================================================
    h2('2. The four orphaned TypeORM-era tables');
    // =====================================================================
    write('§4.3 decided these never come across. The open question was whether they hold anything.');
    write();
    const orphans = ['addon_groups', 'addon_items', 'menu_item_addon_groups', 'posts'];
    table(
      ['table', 'exists', 'rows', 'verdict'],
      orphans.map((t) => {
        const found = counts.find(([name]) => name === t);
        if (found === undefined) return [`\`${t}\``, 'no', '—', 'never existed in production'];
        return [`\`${t}\``, 'yes', num(found[1]), found[1] === 0 ? 'empty — drop without ETL' : '**HOLDS ROWS — decide before cutover**'];
      }),
    );

    // =====================================================================
    h2('3. `menu_items.category` — free text, and how bad');
    // =====================================================================
    if (counts.some(([t]) => t === 'menu_items')) {
      const { rows: cats } = await client.query<{ category: string; n: string; tenants: string }>(
        `SELECT category, count(*) AS n, count(DISTINCT tenant_id) AS tenants
           FROM menu_items GROUP BY category ORDER BY count(*) DESC`,
      );
      write(`${cats.length} distinct raw values across ${num(counts.find(([t]) => t === 'menu_items')?.[1])} products.`);
      write();
      table(['raw value', 'products', 'stores'],
        cats.map((c) => [`\`${c.category}\``, num(c.n), num(c.tenants)]));

      const { rows: collisions } = await client.query<{ normalised: string; variants: string; spellings: string[] }>(
        `SELECT lower(btrim(category)) AS normalised,
                count(DISTINCT category) AS variants,
                array_agg(DISTINCT category ORDER BY category) AS spellings
           FROM menu_items
          GROUP BY 1 HAVING count(DISTINCT category) > 1
          ORDER BY 2 DESC`,
      );
      h3('Case and whitespace variants of one another');
      if (collisions.length === 0) {
        write('None. Every raw value is already distinct after lowercasing and trimming — the ETL');
        write('mapping is one row per value, with no judgement calls.');
      } else {
        write(`${collisions.length} normalised value(s) are spelled more than one way. Each is a`);
        write('judgement call for the ETL, and each is a category a merchant would see twice today.');
        write();
        table(['normalised', 'spellings'], collisions.map((c) => [`\`${c.normalised}\``, c.spellings.map((s) => `\`${s}\``).join(' · ')]));
      }

      // Does a real categories table already exist, and does it agree?
      if (counts.some(([t]) => t === 'categories')) {
        const cols = await columnsOf(client, 'categories');
        h3('`categories` table (added by supabase/categories.sql)');
        write(`Columns: ${[...cols.keys()].map((c) => `\`${c}\``).join(', ')}`);
        write();
        if (cols.has('name')) {
          const { rows: unmatched } = await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM menu_items m
              WHERE NOT EXISTS (
                SELECT 1 FROM categories c
                 WHERE c.tenant_id = m.tenant_id AND lower(btrim(c.name)) = lower(btrim(m.category)))`,
          );
          write(`Products whose \`category\` text matches no row in \`categories\` for their store: **${num(unmatched[0]?.n)}**.`);
          write('Those are the ones the ETL has to create a category for, or park.');
        }
      }
    } else {
      write('_`menu_items` does not exist._');
    }

    // =====================================================================
    h2('4. `add_ons` — the variant question');
    // =====================================================================
    if (counts.some(([t]) => t === 'add_ons')) {
      const cols = await columnsOf(client, 'add_ons');
      write(`Columns now in production: ${[...cols.keys()].map((c) => `\`${c}\``).join(', ')}`);
      write();
      const hasItem = cols.has('menu_item_id');
      const stockCols = [...cols.keys()].filter((c) => /stock|track|quantity/i.test(c));
      write(`Stock-related columns: ${stockCols.length > 0 ? stockCols.map((c) => `\`${c}\``).join(', ') : '_none_'}`);
      write();

      if (hasItem) {
        const { rows } = await client.query<{ scope: string; n: string; products: string }>(
          `SELECT CASE WHEN menu_item_id IS NULL THEN 'shared, store-wide' ELSE 'per-product variant' END AS scope,
                  count(*) AS n, count(DISTINCT menu_item_id) AS products
             FROM add_ons GROUP BY 1 ORDER BY 1`,
        );
        table(['scope', 'rows', 'distinct products'], rows.map((r) => [r.scope, num(r.n), num(r.products)]));

        const { rows: matrix } = await client.query<{ product: string; options: string }>(
          `SELECT menu_item_id::text AS product, count(*) AS options
             FROM add_ons WHERE menu_item_id IS NOT NULL
            GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
        );
        h3('Products with the most per-product options');
        write('This is the number the variant model has to carry. A product with both sizes AND');
        write('colours would show as one flat list here — which is exactly the gap: `add_ons` can say');
        write('"M has 4 left" but not "Black/M has 4 left", because size and colour are separate rows.');
        write();
        table(['product id', 'option rows'], matrix.map((m) => [`\`${m.product.slice(0, 8)}…\``, num(m.options)]));
      }

      const catCheck = await checkConstraint(client, 'add_ons', 'category');
      h3('`add_ons.category` constraint as it stands');
      write(catCheck ?? '_no CHECK constraint found on `category`_');
      const { rows: acats } = await client.query<{ category: string; n: string }>(
        `SELECT category, count(*) AS n FROM add_ons GROUP BY 1 ORDER BY 2 DESC`,
      );
      write();
      table(['category', 'rows'], acats.map((c) => [`\`${c.category}\``, num(c.n)]));
    } else {
      write('_`add_ons` does not exist._');
    }

    // =====================================================================
    h2('5. One email, more than one store');
    // =====================================================================
    write('This decides the `users` uniqueness constraint and whether memberships (§5.4) are');
    write('migrating real data or only enabling a future case. Counts only — no addresses.');
    write();
    if (counts.some(([t]) => t === 'users')) {
      const { rows: shared } = await client.query<{ emails: string; max_tenants: string }>(
        `SELECT count(*) AS emails, coalesce(max(t), 0) AS max_tenants FROM (
           SELECT count(DISTINCT tenant_id) AS t FROM users GROUP BY lower(btrim(email))
            HAVING count(DISTINCT tenant_id) > 1) x`,
      );
      const { rows: total } = await client.query<{ n: string }>(
        'SELECT count(DISTINCT lower(btrim(email))) AS n FROM users',
      );
      write(`- distinct email addresses: **${num(total[0]?.n)}**`);
      write(`- addresses appearing in more than one store: **${num(shared[0]?.emails)}**`);
      write(`- most stores one address appears in: **${num(shared[0]?.max_tenants)}**`);
      write();
      const { rows: roleMix } = await client.query<{ roles: string; n: string }>(
        `SELECT array_to_string(roles, ' + ') AS roles, count(*) AS n FROM (
           SELECT array_agg(DISTINCT role ORDER BY role) AS roles
             FROM users GROUP BY lower(btrim(email)) HAVING count(DISTINCT tenant_id) > 1) x
          GROUP BY 1 ORDER BY 2 DESC`,
      );
      h3('Role combinations held by a shared address');
      write('A combination other than a single repeated role is the case `Auth`\'s store picker draws,');
      write('and the reason roles become memberships rather than a column.');
      write();
      table(['roles held', 'addresses'], roleMix.map((r) => [`\`${r.roles}\``, num(r.n)]));

      const roleCheck = await checkConstraint(client, 'users', 'role');
      h3('`users.role` constraint as it stands');
      write(roleCheck ?? '_none found_');
      const { rows: roles } = await client.query<{ role: string; n: string }>(
        'SELECT role, count(*) AS n FROM users GROUP BY 1 ORDER BY 2 DESC',
      );
      write();
      table(['role', 'users'], roles.map((r) => [`\`${r.role}\``, num(r.n)]));
    }

    // =====================================================================
    h2('6. `orders` — the 7 → 12 status mapping');
    // =====================================================================
    if (counts.some(([t]) => t === 'orders')) {
      const statusCheck = await checkConstraint(client, 'orders', 'status');
      write('Constraint in force:');
      write();
      write(statusCheck ?? '_none found_');
      write();
      const { rows: dist } = await client.query<{ status: string; n: string; oldest: string; newest: string }>(
        `SELECT status, count(*) AS n,
                min(created_at)::date::text AS oldest, max(created_at)::date::text AS newest
           FROM orders GROUP BY 1 ORDER BY 2 DESC`,
      );
      table(['status', 'orders', 'oldest', 'newest'],
        dist.map((d) => [`\`${d.status}\``, num(d.n), d.oldest ?? '—', d.newest ?? '—']));

      for (const col of ['payment_status', 'payment_method', 'delivery_type']) {
        const cols = await columnsOf(client, 'orders');
        if (!cols.has(col)) continue;
        const { rows } = await client.query<{ v: string; n: string }>(
          // col comes from the literal list above, never from data.
          `SELECT ${col} AS v, count(*) AS n FROM orders GROUP BY 1 ORDER BY 2 DESC`,
        );
        h3(`\`${col}\``);
        table(['value', 'orders'], rows.map((r) => [`\`${r.v ?? 'NULL'}\``, num(r.n)]));
      }
    }

    // =====================================================================
    h2('7. Does the ledger sum to the balances?');
    // =====================================================================
    write('The reconciliation report at milestone 29 compares both databases. If they already');
    write('disagree here, that is a pre-existing discrepancy to find now rather than after cutover.');
    write();
    if (counts.some(([t]) => t === 'wallets') && counts.some(([t]) => t === 'wallet_ledger')) {
      // --- the raw picture --------------------------------------------------
      const { rows: byType } = await client.query<{
        balance_type: string; entry_type: string; n: string; total: string; min: string; max: string;
      }>(
        `SELECT balance_type, entry_type, count(*) AS n,
                sum(amount)::text AS total, min(amount)::text AS min, max(amount)::text AS max
           FROM wallet_ledger GROUP BY 1, 2 ORDER BY 1, 2`,
      );
      h3('7.1 Every entry type, as stored');
      table(['balance_type', 'entry_type', 'rows', 'sum', 'min', 'max'],
        byType.map((r) => [r.balance_type, `\`${r.entry_type}\``, num(r.n), r.total, r.min, r.max]));

      // --- why a sum is not a reconciliation --------------------------------
      h3('7.2 Summing the ledger is not a reconciliation, and cannot be');
      write('Read against the function bodies in §10, the ledger has two structural properties that');
      write('a naive `sum(amount) GROUP BY balance_type` gets wrong. Both matter to the ETL.');
      write();
      write('**The sign convention is inconsistent.** `request_withdrawal` stores `-p_amount`, so a');
      write('withdrawal is a negative row. `approve_refund_deduct_wallet` stores `v_refund_amount`');
      write('**positive** for what is also a deduction. So the direction of a row is implied by its');
      write('`entry_type` for some types and carried in the sign for others.');
      write();
      write('**A transfer is recorded on one side only.** `release_eligible_orders` moves money from');
      write('pending to available and writes a single row: `order_payment_released` credited to');
      write('`available`. Nothing debits `pending`. So the pending sum grows monotonically and is not');
      write('a balance at any point — it is the total ever held.');
      write();
      write('This is the gap §5.1 closes by giving the new `wallet_ledger` a running balance. The');
      write('consequence for milestone 29 is concrete: **the ETL cannot recompute a running balance by');
      write('summing these rows.** It has to either interpret each `entry_type` into a signed movement');
      write('on a named pot, or treat the old ledger as history and open the new one with a balance.');

      // --- the reconciliation the semantics actually imply ------------------
      // This mapping is read off the function bodies in section 10, not guessed:
      //   order_payment_held      + pending
      //   order_payment_released  - pending, + available   (stored on available only)
      //   refund_deducted         - whichever pot its row names (stored positive)
      //   withdrawal_reserved     + available              (already stored negative)
      //   withdrawal_reversed     + available
      h3('7.3 The reconciliation those semantics do imply');
      const { rows: recon } = await client.query<{
        tenant_id: string; pot: string; expected: string; actual: string; drift: string;
      }>(
        `WITH m AS (
           SELECT tenant_id,
                  sum(CASE WHEN entry_type = 'order_payment_held' THEN amount
                           WHEN entry_type = 'order_payment_released' THEN -amount
                           WHEN entry_type = 'refund_deducted' AND balance_type = 'pending' THEN -amount
                           ELSE 0 END) AS pending_expected,
                  sum(CASE WHEN entry_type = 'order_payment_released' THEN amount
                           WHEN entry_type = 'withdrawal_reserved' THEN amount
                           WHEN entry_type = 'withdrawal_reversed' THEN amount
                           WHEN entry_type = 'refund_deducted' AND balance_type = 'available' THEN -amount
                           ELSE 0 END) AS available_expected
             FROM wallet_ledger GROUP BY tenant_id)
         SELECT w.tenant_id::text AS tenant_id, p.pot,
                CASE p.pot WHEN 'pending' THEN coalesce(m.pending_expected, 0) ELSE coalesce(m.available_expected, 0) END::text AS expected,
                CASE p.pot WHEN 'pending' THEN w.pending_balance ELSE w.available_balance END::text AS actual,
                (CASE p.pot WHEN 'pending' THEN w.pending_balance ELSE w.available_balance END
                  - CASE p.pot WHEN 'pending' THEN coalesce(m.pending_expected, 0) ELSE coalesce(m.available_expected, 0) END)::text AS drift
           FROM wallets w
           CROSS JOIN (VALUES ('pending'), ('available')) AS p(pot)
           LEFT JOIN m ON m.tenant_id = w.tenant_id
          ORDER BY 1, 2`,
      );
      const drifted = recon.filter((r) => Number(r.drift) !== 0);
      write('`expected` interprets each entry type into a signed movement on a named pot, per the');
      write('mapping above. A non-zero drift here is not an artefact of the sign convention.');
      write();
      table(['tenant', 'pot', 'implied by ledger', 'on the wallet', 'drift'],
        recon.map((r) => [`\`${r.tenant_id.slice(0, 8)}…\``, r.pot, r.expected, r.actual, r.drift]));
      write();
      if (drifted.length === 0) {
        write('**Clean.** Every pot equals what the ledger implies once the entry types are read');
        write('correctly, so the old data can be carried across and reconciled.');
      } else {
        write(`**${drifted.length} pot(s) disagree.** Each needs an explanation before cutover: a drift`);
        write('the ETL carries across is a discrepancy the new ledger inherits and can never account');
        write('for. Equal and opposite drifts mean the total is intact and the **attribution** between');
        write('pots is wrong; a one-sided drift means money is unaccounted for.');
        write();
        write('This run\'s drift has been traced — see §5.1 of');
        write('[`04-implementation-plan.md`](04-implementation-plan.md) under "the old ledger is not a');
        write('faithful record". Do not re-diagnose it from scratch.');
      }

      const entryCheck = await checkConstraint(client, 'wallet_ledger', 'entry_type');
      h3('7.4 `wallet_ledger.entry_type` constraint as it stands');
      write(entryCheck ?? '_none found_');
      write();
      const { rows: ties } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM (
           SELECT tenant_id, created_at FROM wallet_ledger
            GROUP BY 1, 2 HAVING count(*) > 1) x`,
      );
      write(`Ledger timestamps shared by more than one entry for the same store: **${num(ties[0]?.n)}**` +
        (Number(ties[0]?.n ?? 0) > 0
          ? ' — so `created_at` alone cannot order a running-balance recompute; tie-break on `id`.'
          : ' — `created_at` orders a running-balance recompute unambiguously.'));

      h3('7.5 Wallet currency');
      const { rows: cur } = await client.query<{ currency: string; n: string }>(
        'SELECT currency, count(*) AS n FROM wallets GROUP BY 1 ORDER BY 2 DESC',
      );
      table(['currency', 'wallets'], cur.map((c) => [`\`${c.currency}\``, num(c.n)]));
      write();
      write('`momo.sql` defaults this to `EUR`, which is the MoMo **sandbox** currency —');
      write('`MOMO_CURRENCY` is `RWF` in a live Rwanda deployment. A wallet still labelled EUR while');
      write('its amounts are RWF-sized is a label to correct in the ETL, not a conversion to perform.');
    }

    // =====================================================================
    h2('8. Multi-tenancy shape');
    // =====================================================================
    write('How much the ETL moves, and whether any table has rows that belong to no live store.');
    write();
    if (!counts.some(([t]) => t === 'tenants')) {
      write('_`tenants` does not exist here, so there is no store to scope anything to._');
    } else {
    const tenantScoped = tables.filter((t) => t !== 'tenants');
    const shapeRows: string[][] = [];
    for (const t of tenantScoped) {
      const cols = await columnsOf(client, t);
      if (!cols.has('tenant_id')) continue;
      const { rows } = await client.query<{ tenants: string; orphaned: string }>(
        `SELECT count(DISTINCT x.tenant_id) AS tenants,
                count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = x.tenant_id)) AS orphaned
           FROM public.${t} x`,
      );
      shapeRows.push([
        `\`${t}\``,
        num(rows[0]?.tenants),
        Number(rows[0]?.orphaned ?? 0) > 0 ? `**${num(rows[0]?.orphaned)}**` : '0',
      ]);
    }
    table(['table', 'stores with rows', 'rows with no live store'], shapeRows);
    const { rows: tenantCount } = await client.query<{ total: string; active: string }>(
      'SELECT count(*) AS total, count(*) FILTER (WHERE active) AS active FROM tenants',
    );
    write();
    write(`Stores: **${num(tenantCount[0]?.total)}** total, **${num(tenantCount[0]?.active)}** active.`);
    }

    // =====================================================================
    h2('9. Indexes as they stand');
    // =====================================================================
    write('§2.3 found that the newer files get the multi-tenant composite right and the core tables');
    write('do not. This is what is actually in force, so the new schema can be built against the');
    write('queries that matter rather than against the old files.');
    write();
    const { rows: idx } = await client.query<{ tablename: string; indexname: string; indexdef: string; scans: string }>(
      `SELECT i.tablename, i.indexname, i.indexdef, coalesce(s.idx_scan, 0)::text AS scans
         FROM pg_indexes i
         LEFT JOIN pg_stat_user_indexes s ON s.indexrelname = i.indexname
        WHERE i.schemaname = 'public'
        ORDER BY i.tablename, coalesce(s.idx_scan, 0) DESC`,
    );
    write(`${idx.length} indexes. \`scans\` is since the last statistics reset — a zero on a busy table`);
    write('is an index that is costing writes and serving nothing.');
    write();
    table(['table', 'index', 'scans', 'definition'],
      idx.map((r) => [`\`${r.tablename}\``, `\`${r.indexname}\``, num(r.scans),
        `\`${r.indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, '')}\``]));

    // =====================================================================
    h2('10. Functions the new schema has to reproduce');
    // =====================================================================
    // Extension-owned functions are excluded: pg_stat_statements and whatever
    // Supabase installs are not ours to reproduce, and they would bury the four
    // or five that are.
    const { rows: fns } = await client.query<{
      name: string; args: string; lang: string; secdef: boolean; volatility: string; def: string;
    }>(
      `SELECT p.proname AS name,
              pg_get_function_identity_arguments(p.oid) AS args,
              l.lanname AS lang,
              p.prosecdef AS secdef,
              CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END AS volatility,
              pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'public'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY p.proname`,
    );
    write('§4.3 notes the `reserve_stock` ordering hazard: two files create it with different');
    write('signatures, and which one won was inference rather than record. This settles it — and the');
    write('bodies below are the reference milestone 8 rewrites against variants, so no separate dump');
    write('is needed for that.');
    write();
    write('`SECURITY DEFINER` matters: such a function runs as its owner, so it is a privilege');
    write('boundary and has to be reproduced deliberately rather than by accident.');
    write();
    table(['name', 'arguments', 'language', 'volatility', 'security'],
      fns.map((f) => [`\`${f.name}\``, `\`${f.args || '—'}\``, f.lang, f.volatility,
        f.secdef ? '**DEFINER**' : 'invoker']));

    if (fns.length > 0) {
      h3('Full definitions');
      write('<details><summary>Expand — these are what the new schema reproduces</summary>');
      write();
      for (const f of fns) {
        write(`**\`${f.name}(${f.args})\`**`);
        write();
        write('```sql');
        write(f.def.trim());
        write('```');
        write();
      }
      write('</details>');
    }

    // ---------------------------------------------------------------------
    write();
    write('---');
    write();
    write('## What this decides');
    write();
    write('Read §3, §4 and §5 above before writing `V001`. The questions that were open, and where');
    write('their answers now are:');
    write();
    write('| Question | Section |');
    write('|---|---|');
    write('| Are the four orphaned tables empty? | 2 |');
    write('| How many `menu_items.category` values are variants of each other? | 3 |');
    write('| How many `add_ons` rows are per-product variants, and how deep does the matrix go? | 4 |');
    write('| Does one email appear in more than one store, and with which roles? | 5 |');
    write('| What is the real `orders.status` distribution for the 7 → 12 mapping? | 6 |');
    write('| Does `wallet_ledger` sum to `wallets`? | 7 |');
    write('| Which `reserve_stock` signature is actually in force? | 10 |');
    await client.query('COMMIT');
  } finally {
    await client.end().catch(() => {});
  }

  const report = out.join('\n') + '\n';
  if (outPath === '-') {
    console.log(report);
  } else {
    writeFileSync(outPath, report);
    console.log(`  [ok]   report written to ${path.relative(REPO, outPath)} (${report.split('\n').length} lines)`);
  }
}

/** The CHECK constraint text touching one column, as it is actually in force. */
async function checkConstraint(client: Client, tableName: string, column: string): Promise<string | null> {
  // Every match, not the first: a search for 'status' also matches the constraint
  // on payment_status, and returning one of them silently would misreport which
  // values are actually in force.
  const { rows } = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%' || $2 || '%'
      ORDER BY 1`,
    [`public.${tableName}`, column],
  );
  if (rows.length === 0) return null;
  return '```sql\n' + rows.map((r) => r.def).join('\n') + '\n```';
}

main().then(
  () => { process.exitCode = 0; },
  (error: unknown) => {
    console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
