// db/etl/run.ts — the one-off data migration (plan §5.5, milestone 29).
//
//   SOURCE_DATABASE_URL=postgres://… TARGET_DATABASE_URL=postgres://… node db/etl/run.ts [--out report.md]
//
// Read-only against the source (one READ ONLY repeatable-read snapshot, proven before anything runs). The target is
// written in ONE transaction, so a failure leaves it untouched; it must be freshly migrated and empty of stores.
// Exit 0 only when the reconciliation report is CLEAN — "explained" findings are listed but do not fail the run.

import { writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { Ctx, proveReadOnly } from './lib.ts';
import { reconcile, render } from './report.ts';
import { stores, people } from './steps/identity.ts';
import { catalogue } from './steps/catalogue.ts';
import { orders } from './steps/orders.ts';
import { wallets, withdrawals, momo, refunds } from './steps/money.ts';
import { complaints, reviews, leftovers } from './steps/support.ts';

function host(url: string): string {
  const u = new URL(url);
  return `${u.hostname}${u.port === '' ? '' : `:${u.port}`}${u.pathname}`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { out = argv[i + 1] ?? null; i += 1; }
    else throw new Error(`unknown option: ${argv[i] ?? ''}`);
  }
  const sourceUrl = process.env['SOURCE_DATABASE_URL'];
  const targetUrl = process.env['TARGET_DATABASE_URL'];
  if (sourceUrl === undefined || sourceUrl === '' || targetUrl === undefined || targetUrl === '') {
    throw new Error('SOURCE_DATABASE_URL and TARGET_DATABASE_URL must both be set (db/scripts/etl.sh sets them for the local rehearsal).');
  }
  if (host(sourceUrl) === host(targetUrl)) throw new Error('Source and target are the same database. Refusing.');

  const src = new Client({ connectionString: sourceUrl, application_name: 'vendlyfy-etl-source' });
  const tgt = new Client({ connectionString: targetUrl, application_name: 'vendlyfy-etl-target' });
  await src.connect();
  await tgt.connect();
  const ctx = new Ctx(src, tgt);

  try {
    await proveReadOnly(src);

    const existing = Number((await tgt.query<{ n: string }>(`SELECT (SELECT count(*) FROM stores) + (SELECT count(*) FROM legacy_rows) AS n`)).rows[0]!.n);
    if (existing > 0) {
      throw new Error('The target already holds stores or migrated rows. The migration builds into a FRESHLY MIGRATED database (npm run db:migrate on a new one); see db/scripts/etl-rehearse.sh.');
    }

    console.log('Migrating…');
    await tgt.query('BEGIN');
    try {
      // A historical order cannot be refused for a payment-method limit that came into force later; the trigger is restored before commit.
      await tgt.query('ALTER TABLE orders DISABLE TRIGGER orders_payment_method_usable');
      await stores(ctx);
      await people(ctx);
      const cat = await catalogue(ctx);
      const migrated = await orders(ctx, cat);
      await wallets(ctx);
      await withdrawals(ctx);
      await momo(ctx, migrated);
      await refunds(ctx, migrated);
      await complaints(ctx, migrated);
      await reviews(ctx);
      await leftovers(ctx);
      // Run every deferred check (totals, matrix, refunds, ledger) NOW, so a violation is named before commit, then restore the trigger.
      await tgt.query('SET CONSTRAINTS ALL IMMEDIATE');
      await tgt.query('ALTER TABLE orders ENABLE TRIGGER orders_payment_method_usable');
      await tgt.query('COMMIT');
    } catch (error) {
      await tgt.query('ROLLBACK');
      throw error;
    }

    const lines = await reconcile(ctx);
    const text = render(lines, ctx, { source: host(sourceUrl), target: host(targetUrl), at: new Date().toISOString() });
    if (out !== null) writeFileSync(out, text);
    const fails = lines.filter((l) => l.status === 'FAIL');
    const explained = lines.filter((l) => l.status === 'explained');
    console.log(`\nReconciliation: ${lines.length} lines — ${lines.length - fails.length - explained.length} ok, ${explained.length} explained, ${fails.length} FAIL${out === null ? '' : `\nReport written to ${out}`}`);
    for (const f of fails) console.log(`  FAIL  ${f.section}: ${f.check} — old ${f.source}, new ${f.target}${f.note === undefined ? '' : ` (${f.note})`}`);
    return fails.length === 0 ? 0 : 1;
  } finally {
    await src.query('ROLLBACK').catch(() => undefined);
    await src.end();
    await tgt.end();
  }
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
