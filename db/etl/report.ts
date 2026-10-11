// db/etl/report.ts — the reconciliation report (plan §5.5): "the acceptance test for cutover".
//
// Run against the source snapshot and the freshly written target, compared line by line. It has THREE outcomes, not
// two, because one finding is expected and the report must say so rather than bury it:
//
//   ok        the two sides agree
//   explained a known, traced disagreement — only the old ledger vs the old wallet (plan §5.1). It must match the
//             traced pattern exactly: equal-and-opposite drift between the two pots, nothing missing overall
//   FAIL      anything else. A clean report has no FAIL.

import type { Client } from 'pg';
import { Ctx, cents, fromCents } from './lib.ts';

export type Line = { section: string; check: string; source: string; target: string; status: 'ok' | 'explained' | 'FAIL'; note?: string };

const one = async <T = string>(c: Client, sql: string, params: unknown[] = []): Promise<T> => {
  const r = await c.query<{ v: T }>(sql, params);
  return r.rows[0]!.v;
};

export async function reconcile(ctx: Ctx): Promise<Line[]> {
  const { src, tgt } = ctx;
  const lines: Line[] = [];
  const push = (section: string, check: string, source: string, target: string, note?: string): void => {
    lines.push({ section, check, source, target, status: source === target ? 'ok' : 'FAIL', ...(note === undefined ? {} : { note }) });
  };
  const pushExplained = (section: string, check: string, source: string, target: string, ok: boolean, note: string): void => {
    lines.push({ section, check, source, target, status: ok ? 'explained' : 'FAIL', note });
  };
  const n = async (c: Client, sql: string): Promise<string> => String(await one<string>(c, sql));

  // ---- row counts, where a count is meaningful: each old row is either written or archived, never lost ----------
  const archived = async (t: string): Promise<number> => Number(await one<string>(tgt, `SELECT count(*) AS v FROM legacy_rows WHERE source_table = $1`, [t]));
  push('Row counts', 'tenants → stores', await n(src, 'SELECT count(*) AS v FROM public.tenants'), await n(tgt, 'SELECT count(*) AS v FROM stores'));
  push('Row counts', 'menu_items → products', await n(src, 'SELECT count(*) AS v FROM public.menu_items'), await n(tgt, 'SELECT count(*) AS v FROM products'));
  push('Row counts', 'orders → orders', await n(src, 'SELECT count(*) AS v FROM public.orders'), await n(tgt, 'SELECT count(*) AS v FROM orders'));
  push('Row counts', 'order lines: total units sold', await n(src, 'SELECT COALESCE(sum(quantity),0) AS v FROM public.order_items'), await n(tgt, 'SELECT COALESCE(sum(quantity),0) AS v FROM order_items'),
    'A line is split when its add-ons do not spread evenly across its units, so ROWS can rise; units sold cannot.');
  push('Row counts', 'withdrawal_requests → withdrawals', await n(src, 'SELECT count(*) AS v FROM public.withdrawal_requests'), await n(tgt, 'SELECT count(*) AS v FROM withdrawals'));
  push('Row counts', 'complaints → complaints', await n(src, 'SELECT count(*) AS v FROM public.complaints'), await n(tgt, 'SELECT count(*) AS v FROM complaints'));
  push('Row counts', 'momo_transactions → momo_transactions + archived refund payouts', await n(src, 'SELECT count(*) AS v FROM public.momo_transactions'),
    String(Number(await n(tgt, 'SELECT count(*) AS v FROM momo_transactions')) + (await archived('momo_transactions'))));
  push('Row counts', 'refund_requests → refunds + archived', await n(src, 'SELECT count(*) AS v FROM public.refund_requests'),
    String(Number(await n(tgt, 'SELECT count(*) AS v FROM refunds')) + (await archived('refund_requests'))));
  push('Row counts', 'reviews → reviews + archived', await n(src, 'SELECT count(*) AS v FROM public.reviews'),
    String(Number(await n(tgt, 'SELECT count(*) AS v FROM reviews')) + (await archived('reviews'))));
  push('Row counts', 'notifications → archived', await n(src, 'SELECT count(*) AS v FROM public.notifications'), String(await archived('notifications')));
  push('Row counts', 'wallet_ledger → archived (history only)', await n(src, 'SELECT count(*) AS v FROM public.wallet_ledger'), String(await archived('wallet_ledger')));

  const staffRows = Number(await n(src, `SELECT count(*) AS v FROM public.users WHERE role <> 'customer'`));
  const customerRows = Number(await n(src, `SELECT count(*) AS v FROM public.users WHERE role = 'customer'`));
  const mergedAway = staffRows - Number(await n(src, `SELECT count(DISTINCT lower(email)) AS v FROM public.users WHERE role <> 'customer'`));
  push('Row counts', 'users → users + merged-away staff duplicates', String(staffRows + customerRows), String(Number(await n(tgt, 'SELECT count(*) AS v FROM users')) + mergedAway));
  for (const t of ['addon_groups', 'addon_items', 'menu_item_addon_groups', 'delivery_assignments', 'delivery_persons', 'posts']) {
    const exists = await one<string | null>(src, `SELECT to_regclass($1)::text AS v`, [`public.${t}`]);
    if (exists === null) continue;
    push('Row counts', `orphaned table ${t} → archived`, await n(src, `SELECT count(*) AS v FROM public."${t}"`), String(await archived(t)));
  }

  // ---- money -------------------------------------------------------------------------------------------------------
  push('Orders', 'Σ total_amount', await n(src, 'SELECT COALESCE(sum(total_amount),0)::numeric(14,2) AS v FROM public.orders'), await n(tgt, 'SELECT COALESCE(sum(total_amount),0)::numeric(14,2) AS v FROM orders'));
  push('Orders', 'orders paid', await n(src, `SELECT count(*) AS v FROM public.orders WHERE payment_status <> 'unpaid'`), await n(tgt, `SELECT count(*) AS v FROM orders WHERE payment_status <> 'unpaid'`));
  push('Orders', 'Σ total of paid orders', await n(src, `SELECT COALESCE(sum(total_amount),0)::numeric(14,2) AS v FROM public.orders WHERE payment_status <> 'unpaid'`), await n(tgt, `SELECT COALESCE(sum(total_amount),0)::numeric(14,2) AS v FROM orders WHERE payment_status <> 'unpaid'`));
  // Refunded: the only legitimate difference is a refund recorded against an UNPAID order, which the new schema refuses.
  const unpaidRefunded = await n(src, `SELECT COALESCE(sum(refunded_amount),0)::numeric(14,2) AS v FROM public.orders WHERE payment_status = 'unpaid'`);
  push('Orders', 'Σ refunded_amount (excluding refunds recorded on unpaid orders)', await n(src, `SELECT COALESCE(sum(refunded_amount),0)::numeric(14,2) AS v FROM public.orders WHERE payment_status <> 'unpaid'`), await n(tgt, 'SELECT COALESCE(sum(refunded_amount),0)::numeric(14,2) AS v FROM orders'));
  if (cents(unpaidRefunded) !== 0n) {
    lines.push({ section: 'Orders', check: 'refunds recorded on UNPAID orders', source: unpaidRefunded, target: '0.00', status: 'explained',
      note: 'The old bug in plan §5.1: the merchant was debited for money never received. The new schema refuses it, so it is not carried; the debit is already inside the wallet balance. Listed in legacy_rows; finance decides whether to credit it back.' });
  }
  const srcStatus = await src.query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM public.orders GROUP BY status ORDER BY status`);
  for (const r of srcStatus.rows) push('Orders', `status "${r.status}" (mapped 1:1)`, r.n, await n(tgt, `SELECT count(*) AS v FROM orders WHERE status = '${r.status.replace(/'/g, "''")}'`));
  push('Orders', 'orders in a status the old system could not produce', '0', await n(tgt, `SELECT count(*) AS v FROM orders WHERE status NOT IN (SELECT DISTINCT status FROM (VALUES ('pending'),('approved'),('preparing'),('ready'),('assigned'),('delivered'),('rejected')) t(status))`));

  // ---- wallets -----------------------------------------------------------------------------------------------------
  for (const pot of ['available', 'pending'] as const) {
    push('Wallets', `Σ ${pot} balance`, await n(src, `SELECT COALESCE(sum(${pot}_balance),0)::numeric(14,2) AS v FROM public.wallets`), await n(tgt, `SELECT COALESCE(sum(${pot}_balance),0)::numeric(14,2) AS v FROM wallets`));
  }
  const badTarget = await n(tgt, `SELECT count(*) AS v FROM wallets w WHERE w.available_balance <> COALESCE((SELECT sum(amount) FROM wallet_ledger l WHERE l.store_id = w.store_id AND l.pot = 'available'),0)
                                      OR w.pending_balance <> COALESCE((SELECT sum(amount) FROM wallet_ledger l WHERE l.store_id = w.store_id AND l.pot = 'pending'),0)`);
  push('Wallets', 'NEW database: wallets whose balance differs from the sum of their ledger', '0', badTarget);

  // The OLD database: interpret each entry type into a signed movement on a named pot (plan §5.1 / profile §7.3).
  const drift = await src.query<{ tenant_id: string; pot: string; implied: string; wallet: string }>(
    `WITH l AS (
       SELECT tenant_id,
         COALESCE(sum(amount) FILTER (WHERE entry_type='order_payment_held'),0) AS held,
         COALESCE(sum(amount) FILTER (WHERE entry_type='order_payment_released'),0) AS released,
         COALESCE(sum(amount) FILTER (WHERE entry_type='withdrawal_reserved'),0) AS reserved,
         COALESCE(sum(amount) FILTER (WHERE entry_type='withdrawal_reversed'),0) AS reversed,
         COALESCE(sum(abs(amount)) FILTER (WHERE entry_type='refund_deducted' AND balance_type='pending'),0) AS refund_pending,
         COALESCE(sum(abs(amount)) FILTER (WHERE entry_type='refund_deducted' AND balance_type='available'),0) AS refund_available
       FROM public.wallet_ledger GROUP BY tenant_id)
     SELECT w.tenant_id, p.pot,
            (CASE p.pot WHEN 'available' THEN COALESCE(l.released + l.reserved + l.reversed - l.refund_available, 0)
                        ELSE COALESCE(l.held - l.released - l.refund_pending, 0) END)::numeric(14,2)::text AS implied,
            (CASE p.pot WHEN 'available' THEN w.available_balance ELSE w.pending_balance END)::numeric(14,2)::text AS wallet
       FROM public.wallets w CROSS JOIN (VALUES ('available'),('pending')) p(pot) LEFT JOIN l ON l.tenant_id = w.tenant_id
      ORDER BY w.tenant_id, p.pot`);
  let driftTotal = 0n;
  let drifting = 0;
  for (const r of drift.rows) {
    const d = cents(r.wallet) - cents(r.implied);
    if (d !== 0n) drifting += 1;
    driftTotal += d;
  }
  if (drifting === 0) {
    lines.push({ section: 'Wallets', check: 'OLD database: the ledger, interpreted, equals the wallets', source: 'agrees', target: 'agrees', status: 'ok' });
  } else {
    const detail = drift.rows.filter((r) => cents(r.wallet) !== cents(r.implied)).map((r) => `${r.tenant_id.slice(0, 8)}… ${r.pot}: ledger implies ${r.implied}, wallet holds ${r.wallet}`).join('; ');
    pushExplained('Wallets', 'OLD database: the ledger, interpreted, equals the wallets', `${drifting} pot(s) drift`, 'carried as history only', driftTotal === 0n && drifting === 2,
      `${detail}. Equal and opposite (net ${fromCents(driftTotal)}): the total is intact and the ATTRIBUTION between pots is wrong, traced to one refund labelled with the wrong pot and one partial refund released in full (plan §5.1). The new ledger opens at the wallet balance instead of replaying these rows.`);
  }

  // ---- payouts and refunds ------------------------------------------------------------------------------------------
  const wd = await src.query<{ status: string; n: string; s: string }>(`SELECT status, count(*)::text AS n, sum(amount)::numeric(14,2)::text AS s FROM public.withdrawal_requests GROUP BY status ORDER BY status`);
  for (const r of wd.rows) {
    const t = await tgt.query<{ n: string; s: string }>(`SELECT count(*)::text AS n, COALESCE(sum(amount),0)::numeric(14,2)::text AS s FROM withdrawals WHERE status = $1`, [r.status]);
    push('Payouts', `withdrawals "${r.status}": count`, r.n, t.rows[0]!.n);
    push('Payouts', `withdrawals "${r.status}": amount`, r.s, t.rows[0]!.s);
  }
  const rf = await src.query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM public.refund_requests GROUP BY status ORDER BY status`);
  for (const r of rf.rows) {
    const mapped = r.status === 'completed' ? 'approved' : r.status;
    const inTarget = Number(await n(tgt, `SELECT count(*) AS v FROM refunds WHERE status = '${mapped}'`));
    const sources = rf.rows.filter((x) => (x.status === 'completed' ? 'approved' : x.status) === mapped).reduce((s, x) => s + Number(x.n), 0);
    const arch = Number(await n(tgt, `SELECT count(*) AS v FROM legacy_rows WHERE source_table = 'refund_requests'`));
    if (r.status === rf.rows.find((x) => (x.status === 'completed' ? 'approved' : x.status) === mapped)!.status) {
      lines.push({ section: 'Payouts', check: `refund requests → "${mapped}"`, source: String(sources), target: String(inTarget), status: inTarget === sources ? 'ok' : inTarget + arch >= sources && arch > 0 ? 'explained' : 'FAIL',
        ...(inTarget === sources ? {} : { note: `${arch} refund request(s) archived instead of imported (a refund on an unpaid order); see legacy_rows.` }) });
    }
  }

  // ---- spot check: the ten largest orders, field by field -------------------------------------------------------------
  const top = await src.query<Record<string, string | null>>(
    `SELECT id::text, tenant_id::text, total_amount::numeric(14,2)::text AS total, status, payment_status, settlement_status, created_at::text AS created,
            COALESCE(customer_id::text, 'guest:' || guest_name) AS who
       FROM public.orders ORDER BY total_amount DESC, id LIMIT 10`);
  let mismatched = 0;
  const wrong: string[] = [];
  for (const o of top.rows) {
    const t = await tgt.query<Record<string, string | null>>(
      `SELECT id::text, store_id::text AS tenant_id, total_amount::numeric(14,2)::text AS total, status, payment_status, settlement_status, created_at::text AS created,
              COALESCE(customer_user_id::text, 'guest:' || guest_name) AS who FROM orders WHERE id = $1`, [o['id']]);
    const row = t.rows[0];
    const keys = ['tenant_id', 'total', 'status', 'settlement_status', 'who'] as const;
    // created_at prints in each server's zone; compare instants instead
    const instants = await one<boolean>(tgt, `SELECT $1::timestamptz = $2::timestamptz AS v`, [o['created'], row?.['created'] ?? null]);
    const differs = row === undefined || !instants || keys.some((k) => row[k] !== o[k]);
    if (differs) { mismatched += 1; wrong.push(String(o['id']).slice(0, 8)); }
  }
  push('Spot check', 'ten largest orders, field by field (store, total, status, settlement, customer, placed time)', '0 differ', `${mismatched} differ`, mismatched === 0 ? undefined : `differing: ${wrong.join(', ')}`);
  return lines;
}

export function render(lines: Line[], ctx: Ctx, meta: { source: string; target: string; at: string }): string {
  const fail = lines.filter((l) => l.status === 'FAIL').length;
  const out: string[] = [];
  out.push('# ETL reconciliation report', '');
  out.push(`Source: ${meta.source}`, `Target: ${meta.target}`, `Run: ${meta.at}`, '');
  out.push(fail === 0 ? '**CLEAN** — every line is `ok` or an `explained` finding.' : `**NOT CLEAN** — ${fail} line(s) FAIL.`, '');
  let section = '';
  for (const l of lines) {
    if (l.section !== section) { section = l.section; out.push('', `## ${section}`, '', '| check | old | new | |', '|---|---|---|---|'); }
    out.push(`| ${l.check} | ${l.source} | ${l.target} | ${l.status === 'ok' ? 'ok' : l.status === 'explained' ? '**explained**' : '**FAIL**'} |`);
    if (l.note !== undefined && l.status !== 'ok') out.push(`|  | *${l.note.replace(/\|/g, '\\|')}* | | |`);
  }
  out.push('', '## Counts per source table', '', '| table | read | written | archived |', '|---|---|---|---|');
  for (const [t, c] of [...ctx.counters.entries()].sort()) out.push(`| ${t} | ${c.read} | ${c.written} | ${c.archived} |`);
  out.push('', '## Decisions taken (each one is a product call, to be reviewed by a person)', '');
  const byKind = new Map<string, number>();
  for (const d of ctx.decisions) byKind.set(`${d.step}/${d.kind}`, (byKind.get(`${d.step}/${d.kind}`) ?? 0) + 1);
  out.push('| step/kind | times |', '|---|---|');
  for (const [k, v] of [...byKind.entries()].sort()) out.push(`| ${k} | ${v} |`);
  out.push('');
  for (const d of ctx.decisions) out.push(`- **${d.step}/${d.kind}** \`${d.subject}\` — ${d.detail}`);
  out.push('');
  return out.join('\n');
}
