// server/src/repositories/admin.ts — milestone 27: what the platform team reads and does across every store.
//
// EVERY QUERY HERE IS CROSS-STORE ON PURPOSE, which is the opposite of every other repository in the app: a merchant's
// reads are scoped by `store_id` as their first parameter, and the tenancy is the schema's. These are the platform's, so the
// scoping is the GUARD's — routes/admin.ts mounts each endpoint behind requirePlatformPermission(), and nothing in this file
// is reachable from a store route. A function here must never be imported by a repository or route that a merchant can call.
//
// NUMBERS ARE COMPUTED FROM WHAT EXISTS, NOT FROM WHAT THE BOARD DRAWS. AdminOverview shows a "Flagged payment — amount 12×
// the store's average" and a Cards row and an SMS row; nothing in the system flags payments, takes cards or sends SMS, so
// none of those are invented. What is on the screen is a number somebody can reproduce with a query.

import { badRequest, conflict, db, notFound } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';

export type Range = 'today' | 'week' | 'month';
export const RANGES: readonly Range[] = ['today', 'week', 'month'];

const TIME_ZONE = 'Africa/Kigali';

/** Window start and the length it is compared against. `today` is since local midnight; the others are rolling. */
function window(range: Range): { start: string; span: string } {
  if (range === 'today') return { start: `date_trunc('day', now() AT TIME ZONE '${TIME_ZONE}') AT TIME ZONE '${TIME_ZONE}'`, span: `interval '1 day'` };
  const days = range === 'week' ? 7 : 30;
  return { start: `now() - interval '${days} days'`, span: `interval '${days} days'` };
}

export type Kpi = { key: 'sales' | 'orders' | 'stores' | 'signups' | 'payment'; value: number | null; previous: number | null; note: string | null };

export type Overview = {
  range: Range;
  kpis: Kpi[];
  queue: { kind: 'identity' | 'payout' | 'disputes' | 'template'; title: string; sub: string; ageHours: number | null; count: number }[];
  providers: { key: string; name: string; short: string; rate: number | null; attempts: number; status: 'operational' | 'degraded' | 'quiet' | 'paused'; note: string | null }[];
  industries: { name: string; amount: number; share: number }[];
  activity: { at: string; who: string; what: string }[];
};

const num = (v: string | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

export async function overview(range: Range, on: Queryable = db): Promise<Overview> {
  const { start, span } = window(range);
  const prevStart = `(${start}) - ${span}`;
  const prevEnd = `now() - ${span}`;

  const money = (from: string, to: string): string =>
    `SELECT COALESCE(sum(total_amount) FILTER (WHERE payment_status IN ('paid', 'refunded')), 0)::text AS sales, count(*)::text AS orders
       FROM orders WHERE placed_at >= ${from} AND placed_at < ${to}`;
  const cur = (await on.query<{ sales: string; orders: string }>(money(`(${start})`, 'now()'))).rows[0]!;
  const prev = (await on.query<{ sales: string; orders: string }>(money(prevStart, prevEnd))).rows[0]!;

  const stores = (await on.query<{ active: string; signups: string; prev_signups: string; in_review: string }>(
    `SELECT (SELECT count(*) FROM stores WHERE status = 'active')::text AS active,
            (SELECT count(*) FROM stores WHERE created_at >= (${start}))::text AS signups,
            (SELECT count(*) FROM stores WHERE created_at >= ${prevStart} AND created_at < ${prevEnd})::text AS prev_signups,
            (SELECT count(*) FROM kyc_submissions WHERE status = 'in_review')::text AS in_review`,
  )).rows[0]!;

  // Payment success = collections that finished one way or the other. A pending one has not failed yet.
  const pay = async (from: string, to: string): Promise<number | null> => {
    const r = (await on.query<{ ok: string; total: string }>(
      `SELECT (count(*) FILTER (WHERE status = 'successful'))::text AS ok, (count(*) FILTER (WHERE status IN ('successful', 'failed')))::text AS total
         FROM momo_transactions WHERE direction = 'collection' AND created_at >= ${from} AND created_at < ${to}`,
    )).rows[0]!;
    return Number(r.total) === 0 ? null : (Number(r.ok) / Number(r.total)) * 100;
  };
  const paymentNow = await pay(`(${start})`, 'now()');
  const paymentPrev = await pay(prevStart, prevEnd);

  const kpis: Kpi[] = [
    { key: 'sales', value: num(cur.sales), previous: num(prev.sales), note: null },
    { key: 'orders', value: num(cur.orders), previous: num(prev.orders), note: null },
    { key: 'stores', value: num(stores.active), previous: null, note: `${stores.signups} new in this period` },
    { key: 'signups', value: num(stores.signups), previous: num(stores.prev_signups), note: `${stores.in_review} awaiting review` },
    { key: 'payment', value: paymentNow, previous: paymentPrev, note: null },
  ];

  const queue: Overview['queue'] = [];

  const kyc = await on.query<{ name: string; age_h: string }>(
    `SELECT st.name, (extract(epoch FROM now() - s.submitted_at) / 3600)::text AS age_h
       FROM kyc_submissions s JOIN stores st ON st.id = s.store_id
      WHERE s.status = 'in_review' ORDER BY s.submitted_at LIMIT 3`,
  );
  const kycTotal = num(stores.in_review);
  if (kycTotal > 0) {
    queue.push({
      kind: 'identity',
      title: `${kycTotal} ${kycTotal === 1 ? 'store' : 'stores'} waiting for verification`,
      sub: `${kyc.rows.map((r) => r.name).join(', ')}${kycTotal > kyc.rows.length ? ` and ${kycTotal - kyc.rows.length} more` : ''} · ID and face video uploaded`,
      ageHours: kyc.rows[0] === undefined ? null : Number(kyc.rows[0].age_h),
      count: kycTotal,
    });
  }

  const failed = await on.query<{ n: string; name: string; reason: string | null; age_h: string }>(
    `SELECT (SELECT count(*) FROM withdrawals WHERE status = 'failed')::text AS n, st.name, w.failure_reason AS reason,
            (extract(epoch FROM now() - w.requested_at) / 3600)::text AS age_h
       FROM withdrawals w JOIN stores st ON st.id = w.store_id
      WHERE w.status = 'failed' ORDER BY w.requested_at LIMIT 1`,
  );
  if (failed.rows[0] !== undefined) {
    const f = failed.rows[0];
    const n = Number(f.n);
    queue.push({ kind: 'payout', title: n === 1 ? `Payout failed · ${f.name}` : `${n} payouts failed`, sub: f.reason ?? 'The provider did not complete it.', ageHours: Number(f.age_h), count: n });
  }

  const disputes = await on.query<{ n: string; age_h: string; ref: string; name: string }>(
    `SELECT (SELECT count(*) FROM complaints WHERE status IN ('open', 'escalated'))::text AS n,
            (extract(epoch FROM now() - c.created_at) / 3600)::text AS age_h, c.reference_number::text AS ref, st.name
       FROM complaints c JOIN stores st ON st.id = c.store_id
      WHERE c.status IN ('open', 'escalated') ORDER BY c.created_at LIMIT 1`,
  );
  if (disputes.rows[0] !== undefined) {
    const d = disputes.rows[0];
    queue.push({ kind: 'disputes', title: `${d.n} open ${Number(d.n) === 1 ? 'dispute' : 'disputes'}`, sub: `Oldest: complaint #${d.ref} · ${d.name}`, ageHours: Number(d.age_h), count: Number(d.n) });
  }

  const drafts = await on.query<{ name: string; age_h: string }>(
    `SELECT t.name, (extract(epoch FROM now() - v.created_at) / 3600)::text AS age_h
       FROM industry_template_versions v JOIN industry_templates t ON t.id = v.template_id
      WHERE v.status = 'draft' ORDER BY v.created_at LIMIT 1`,
  );
  if (drafts.rows[0] !== undefined) {
    queue.push({ kind: 'template', title: `${drafts.rows[0].name} template in draft`, sub: 'Ready for review before it’s offered at sign-up', ageHours: Number(drafts.rows[0].age_h), count: 1 });
  }

  const providers = await providerHealth(on);

  const ind = await on.query<{ name: string; amount: string }>(
    `SELECT COALESCE(t.name, 'Other') AS name, COALESCE(sum(o.total_amount), 0)::text AS amount
       FROM orders o JOIN stores s ON s.id = o.store_id LEFT JOIN industry_templates t ON t.id = s.industry_template_id
      WHERE o.payment_status IN ('paid', 'refunded') AND o.placed_at >= (${start})
      GROUP BY 1 ORDER BY sum(o.total_amount) DESC`,
  );
  const total = ind.rows.reduce((a, r) => a + num(r.amount), 0);
  const industries = ind.rows.slice(0, 6).map((r) => ({ name: r.name, amount: num(r.amount), share: total === 0 ? 0 : num(r.amount) / total }));

  const log = await on.query<{ created_at: Date; actor_label: string; summary: string }>(
    `SELECT created_at, actor_label, summary FROM audit_log ORDER BY sequence DESC LIMIT 5`,
  );

  return { range, kpis, queue, providers, industries, activity: log.rows.map((r) => ({ at: r.created_at.toISOString(), who: r.actor_label, what: r.summary })) };
}


export type ProviderHealth = Overview['providers'][number];

/** Collections that finished (one way or the other) in the last hour, per online payment method. Shared with Platform settings' Health panel. */
export async function providerHealth(on: Queryable = db): Promise<ProviderHealth[]> {
  const hour = await on.query<{ key: string; name: string; short_name: string; status: string; incident_note: string | null; ok: string; total: string }>(
    `SELECT pm.key, pm.name, pm.short_name, pm.status, pm.incident_note,
            (count(t.id) FILTER (WHERE t.status = 'successful'))::text AS ok,
            (count(t.id) FILTER (WHERE t.status IN ('successful', 'failed')))::text AS total
       FROM payment_methods pm
       LEFT JOIN momo_transactions t ON t.payment_method_key = pm.key AND t.direction = 'collection' AND t.created_at >= now() - interval '1 hour'
      WHERE pm.kind = 'online'
      GROUP BY pm.key, pm.name, pm.short_name, pm.status, pm.incident_note, pm.position
      ORDER BY pm.position`,
  );
  return hour.rows.map((r) => {
    const total = Number(r.total);
    const rate = total === 0 ? null : (Number(r.ok) / total) * 100;
    return {
      key: r.key,
      name: r.name,
      short: r.short_name,
      rate,
      attempts: total,
      status: r.status !== 'live' ? 'paused' : rate === null ? 'quiet' : rate < 95 ? 'degraded' : 'operational',
      note: r.incident_note,
    };
  });
}

// ---------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------

export type MerchantTab = 'pending' | 'active' | 'suspended';
export const MERCHANT_TABS: readonly MerchantTab[] = ['pending', 'active', 'suspended'];

export type MerchantRow = {
  id: string;
  slug: string;
  name: string;
  status: 'pending' | 'active' | 'suspended';
  /** The live identity case, if any: what puts a store in "Needs review". */
  identity: 'none' | 'building' | 'in_review' | 'redo_requested' | 'rejected' | 'approved';
  /** The case a reviewer would open for this store, if there is one waiting. */
  identityCaseId: string | null;
  owner: { name: string; phone: string | null } | null;
  industry: string | null;
  plan: string | null;
  sales30: number;
  createdAt: string;
};

/**
 * "NEEDS REVIEW" IS A STORE WITH AN IDENTITY CHECK WAITING FOR A DECISION, not a store that has not gone live. The board
 * draws a store as `pending` until an admin approves it ("Approve and go live"); Onboarding, drawn by the same designer,
 * says "Your store is ready … is live" the moment it is created. Both cannot be true, and a merchant waiting a day for
 * permission to sell is the worse product — so a store is live at sign-up (M26) and the platform's review is of WHO owns it,
 * which gates payouts and nothing else (V012). The tab keeps the board's name and the board's buttons: Approve identity
 * is "Approve and go live" in the one sense that matters, money going live.
 */
const IDENTITY = `COALESCE(
    (SELECT CASE WHEN k.status = 'submitted' AND k.checks_completed_at IS NULL THEN 'building' ELSE k.status END
       FROM kyc_submissions k WHERE k.store_id = s.id
      ORDER BY (k.status IN ('submitted', 'in_review', 'redo_requested')) DESC, k.created_at DESC LIMIT 1), 'none')`;

export async function counts(on: Queryable = db): Promise<Record<MerchantTab, number>> {
  const r = (await on.query<{ pending: string; active: string; suspended: string }>(
    `SELECT (SELECT count(*) FROM stores s WHERE s.status = 'pending' OR (s.status = 'active' AND EXISTS (SELECT 1 FROM kyc_submissions k WHERE k.store_id = s.id AND k.status = 'in_review')))::text AS pending,
            (SELECT count(*) FROM stores WHERE status = 'active')::text AS active,
            (SELECT count(*) FROM stores WHERE status = 'suspended')::text AS suspended`,
  )).rows[0]!;
  return { pending: Number(r.pending), active: Number(r.active), suspended: Number(r.suspended) };
}

const CASE_ID = `(SELECT k.id FROM kyc_submissions k WHERE k.store_id = s.id AND k.status = 'in_review' ORDER BY k.submitted_at DESC LIMIT 1)`;

export async function listMerchants(
  q: { tab: MerchantTab; search: string; industry: string | null; plan: string | null; limit: number },
  on: Queryable = db,
): Promise<{ rows: MerchantRow[]; hasMore: boolean; counts: Record<MerchantTab, number>; filters: { industries: { key: string; name: string }[]; plans: { key: string; name: string }[] } }> {
  const where: string[] = [];
  const args: unknown[] = [];
  const arg = (v: unknown): string => {
    args.push(v);
    return `$${args.length}`;
  };

  if (q.tab === 'pending') where.push(`(s.status = 'pending' OR (s.status = 'active' AND EXISTS (SELECT 1 FROM kyc_submissions k WHERE k.store_id = s.id AND k.status = 'in_review')))`);
  else where.push(`s.status = ${arg(q.tab)}`);
  if (q.search !== '') {
    const p = arg(`%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`(s.name ILIKE ${p} OR s.slug ILIKE ${p} OR EXISTS (SELECT 1 FROM store_members m JOIN users u ON u.id = m.user_id WHERE m.store_id = s.id AND m.role = 'owner' AND (u.name ILIKE ${p} OR u.phone ILIKE ${p})))`);
  }
  if (q.industry !== null) where.push(`t.key = ${arg(q.industry)}`);
  if (q.plan !== null) where.push(`s.plan_key = ${arg(q.plan)}`);

  const page = await on.query<{ id: string; slug: string; name: string; status: MerchantRow['status']; created_at: Date; industry: string | null; plan_key: string | null; owner_name: string | null; owner_phone: string | null; identity: MerchantRow['identity']; case_id: string | null }>(
    `SELECT s.id, s.slug, s.name, s.status, s.created_at, t.name AS industry, s.plan_key,
            ow.name AS owner_name, ow.phone AS owner_phone, ${IDENTITY} AS identity, ${CASE_ID} AS case_id
       FROM stores s
       LEFT JOIN industry_templates t ON t.id = s.industry_template_id
       LEFT JOIN LATERAL (SELECT u.name, u.phone FROM store_members m JOIN users u ON u.id = m.user_id WHERE m.store_id = s.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) ow ON true
      WHERE ${where.join(' AND ')}
      ORDER BY s.created_at DESC, s.id
      LIMIT ${arg(q.limit + 1)}`,
    args,
  );

  const ids = page.rows.slice(0, q.limit).map((r) => r.id);
  const gmv = ids.length === 0 ? { rows: [] as { store_id: string; amount: string }[] } : await on.query<{ store_id: string; amount: string }>(
    `SELECT store_id, sum(total_amount)::text AS amount FROM orders
      WHERE store_id = ANY($1::uuid[]) AND payment_status IN ('paid', 'refunded') AND placed_at >= now() - interval '30 days'
      GROUP BY store_id`,
    [ids],
  );
  const byStore = new Map(gmv.rows.map((r) => [r.store_id, Number(r.amount)]));

  return {
    rows: page.rows.slice(0, q.limit).map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      identity: r.identity,
      identityCaseId: r.case_id,
      owner: r.owner_name === null ? null : { name: r.owner_name, phone: r.owner_phone },
      industry: r.industry,
      plan: r.plan_key,
      sales30: byStore.get(r.id) ?? 0,
      createdAt: r.created_at.toISOString(),
    })),
    hasMore: page.rows.length > q.limit,
    counts: await counts(on),
    filters: {
      industries: (await on.query<{ key: string; name: string }>(`SELECT key, name FROM industry_templates ORDER BY name`)).rows,
      plans: (await on.query<{ key: string; name: string }>(`SELECT key, name FROM plans ORDER BY position`)).rows,
    },
  };
}

export type MerchantDetail = MerchantRow & {
  orders: number;
  openDisputes: number;
  suspension: { reason: string; note: string | null; at: string; by: string } | null;
  checks: { key: string; label: string; state: 'ok' | 'warn' | 'wait'; note: string }[];
  payout: string;
};

const IDENTITY_NOTE: Record<MerchantRow['identity'], [MerchantDetail['checks'][number]['state'], string]> = {
  none: ['wait', 'Not started'],
  building: ['wait', 'Documents being added'],
  in_review: ['warn', 'Waiting for your decision'],
  redo_requested: ['warn', 'A retake was asked for'],
  rejected: ['warn', 'Rejected'],
  approved: ['ok', 'Verified'],
};

export async function merchantDetail(storeId: string, on: Queryable = db): Promise<MerchantDetail | null> {
  const list = await on.query<{ id: string }>(`SELECT id FROM stores WHERE id = $1`, [storeId]);
  if (list.rows[0] === undefined) return null;
  const one = await listMerchantsById(storeId, on);
  if (one === null) return null;

  const stats = (await on.query<{ orders: string; disputes: string }>(
    `SELECT (SELECT count(*) FROM orders WHERE store_id = $1)::text AS orders,
            (SELECT count(*) FROM complaints WHERE store_id = $1 AND status IN ('open', 'escalated'))::text AS disputes`,
    [storeId],
  )).rows[0]!;

  const sus = await on.query<{ created_at: Date; actor_label: string; detail: string | null; reason: string | null }>(
    `SELECT created_at, actor_label, detail, context->>'reason' AS reason FROM audit_log
      WHERE store_id = $1 AND action = 'suspend_store' ORDER BY sequence DESC LIMIT 1`,
    [storeId],
  );

  const payout = (await on.query<{ method: string | null; phone: string | null; mode: string | null; connected: string }>(
    `SELECT pm.name AS method, ps.payout_phone AS phone, ps.settlement_mode AS mode,
            (SELECT count(*) FROM store_payment_methods x WHERE x.store_id = $1 AND x.is_connected)::text AS connected
       FROM stores s
       LEFT JOIN store_payout_settings ps ON ps.store_id = s.id
       LEFT JOIN payment_methods pm ON pm.key = ps.payout_method_key
      WHERE s.id = $1`,
    [storeId],
  )).rows[0]!;

  const [idState, idNote] = IDENTITY_NOTE[one.identity];
  const checks: MerchantDetail['checks'] = [
    { key: 'identity', label: 'Owner’s identity', state: idState, note: idNote },
    { key: 'payout', label: 'Payout account', state: payout.method === null ? 'wait' : 'ok', note: payout.method === null ? 'Not added yet' : `${payout.method} · ${payout.mode === 'automatic' ? 'automatic' : 'manual'}` },
    { key: 'methods', label: 'Payment methods', state: Number(payout.connected) > 0 ? 'ok' : 'warn', note: `${payout.connected} connected` },
  ];

  return {
    ...one,
    orders: Number(stats.orders),
    openDisputes: Number(stats.disputes),
    suspension: sus.rows[0] === undefined ? null : { reason: sus.rows[0].reason ?? 'policy review', note: sus.rows[0].detail, at: sus.rows[0].created_at.toISOString(), by: sus.rows[0].actor_label },
    checks,
    payout: payout.method === null ? 'No payout account' : `${payout.method}${payout.phone === null ? '' : ` ${maskPhone(payout.phone)}`}`,
  };
}

async function listMerchantsById(storeId: string, on: Queryable): Promise<MerchantRow | null> {
  const r = await on.query<{ id: string; slug: string; name: string; status: MerchantRow['status']; created_at: Date; industry: string | null; plan_key: string | null; owner_name: string | null; owner_phone: string | null; identity: MerchantRow['identity']; case_id: string | null; sales30: string }>(
    `SELECT s.id, s.slug, s.name, s.status, s.created_at, t.name AS industry, s.plan_key,
            ow.name AS owner_name, ow.phone AS owner_phone, ${IDENTITY} AS identity, ${CASE_ID} AS case_id,
            COALESCE((SELECT sum(o.total_amount) FROM orders o WHERE o.store_id = s.id AND o.payment_status IN ('paid', 'refunded') AND o.placed_at >= now() - interval '30 days'), 0)::text AS sales30
       FROM stores s
       LEFT JOIN industry_templates t ON t.id = s.industry_template_id
       LEFT JOIN LATERAL (SELECT u.name, u.phone FROM store_members m JOIN users u ON u.id = m.user_id WHERE m.store_id = s.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) ow ON true
      WHERE s.id = $1`,
    [storeId],
  );
  const x = r.rows[0];
  if (x === undefined) return null;
  return { id: x.id, slug: x.slug, name: x.name, status: x.status, identity: x.identity, identityCaseId: x.case_id, owner: x.owner_name === null ? null : { name: x.owner_name, phone: x.owner_phone }, industry: x.industry, plan: x.plan_key, sales30: Number(x.sales30), createdAt: x.created_at.toISOString() };
}

const maskPhone = (p: string): string => {
  const d = p.replace(/\D/g, '');
  return d.length < 7 ? '•••' : `${d.slice(0, 3)} ••• ${d.slice(-4)}`;
};

export const SUSPEND_REASONS: Record<string, string> = {
  docs: 'documents unclear or don’t match',
  fraud: 'suspected fraud',
  goods: 'prohibited or counterfeit goods',
  complaints: 'repeated customer complaints',
};

export async function suspend(storeId: string, actorId: string, reasonKey: string, note: string | null, ctx: { ip: string | null; userAgent: string | null }, tx: Tx): Promise<void> {
  const reason = SUSPEND_REASONS[reasonKey];
  if (reason === undefined) throw badRequest('Choose a reason.', 'REASON_REQUIRED');
  const row = (await tx.query<{ status: string; name: string }>(`SELECT status, name FROM stores WHERE id = $1 FOR UPDATE`, [storeId])).rows[0];
  if (row === undefined) throw notFound('That store does not exist.', 'NO_SUCH_STORE');
  if (row.status === 'suspended') throw conflict('That store is already suspended.', 'ALREADY_SUSPENDED');
  await tx.query(`UPDATE stores SET status = 'suspended' WHERE id = $1`, [storeId]);
  await tx.query(
    `SELECT audit('store', 'suspend_store', $2, $3, $1, $4, 'store', $1, $5::inet, $6, NULL, jsonb_build_object('reason', $7::text))`,
    [storeId, `Suspended ${row.name} · ${reason}`, actorId, note, ctx.ip, ctx.userAgent, reason],
  );
}

export async function reinstate(storeId: string, actorId: string, ctx: { ip: string | null; userAgent: string | null }, tx: Tx): Promise<void> {
  const row = (await tx.query<{ status: string; name: string }>(`SELECT status, name FROM stores WHERE id = $1 FOR UPDATE`, [storeId])).rows[0];
  if (row === undefined) throw notFound('That store does not exist.', 'NO_SUCH_STORE');
  if (row.status !== 'suspended') throw conflict('That store is not suspended.', 'NOT_SUSPENDED');
  await tx.query(`UPDATE stores SET status = 'active' WHERE id = $1`, [storeId]);
  await tx.query(`SELECT audit('store', 'reinstate_store', $2, $3, $1, NULL, 'store', $1, $4::inet, $5)`, [storeId, `Reinstated ${row.name}`, actorId, ctx.ip, ctx.userAgent]);
}
