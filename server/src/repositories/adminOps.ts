// server/src/repositories/adminOps.ts — milestone 27, part C: the platform team's three READ screens and the one settings page.
//
//   Audit log       every admin action and every sensitive view, newest first, and a button that proves the chain is unbroken
//   All orders      every store's orders, read-only: "Act through refunds, disputes or the store itself" (the board's own words)
//   Platform settings   the defaults (platformSettings.ts) and a Health panel
//
// THE HEALTH PANEL SHOWS ONLY WHAT IS MEASURED. The board lists seven services; four of them (the payment providers, the payout
// scheduler's last run) can be read off data the system already writes, and three cannot — there is no SMS gateway, no email service
// and no card processor in the new server, so each is said to be "not connected" rather than given a green dot nobody earned.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import { providerHealth } from './admin.ts';
import { queueState, templateLabel } from './messaging.ts';

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const AUDIT_CATEGORIES = ['sensitive', 'money', 'store', 'config', 'access'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export type AuditRow = { sequence: number; at: string; who: string; role: string | null; category: AuditCategory; what: string; store: string | null; detail: string[] };

export async function auditPage(q: { category: AuditCategory | null; before: number | null; limit: number }, on: Queryable = db): Promise<{ rows: AuditRow[]; hasMore: boolean }> {
  const args: unknown[] = [];
  const where: string[] = [];
  if (q.category !== null) { args.push(q.category); where.push(`category = $${args.length}`); }
  if (q.before !== null) { args.push(q.before); where.push(`sequence < $${args.length}`); }
  args.push(q.limit + 1);
  const r = await on.query<{ sequence: string; created_at: Date; actor_label: string; actor_role: string | null; category: AuditCategory; summary: string; store_label: string | null; detail: string | null; ip_address: string | null; session_verified_at: Date | null; context: Record<string, unknown> }>(
    `SELECT sequence::text, created_at, actor_label, actor_role, category, summary, store_label, detail, host(ip_address) AS ip_address, session_verified_at, context
       FROM audit_log ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
      ORDER BY audit_log.sequence DESC LIMIT $${args.length}`,
    args,
  );
  const rows = r.rows.slice(0, q.limit).map((x): AuditRow => {
    const lines: string[] = [];
    if (x.detail !== null && x.detail !== '') lines.push(x.detail);
    const reason = x.context['reason'];
    if (typeof reason === 'string' && !(x.detail ?? '').includes(reason)) lines.push(`Reason: “${reason}”`);
    if (x.ip_address !== null) lines.push(`IP ${x.ip_address}`);
    if (x.session_verified_at !== null) lines.push(`Session 2-step verified ${x.session_verified_at.toISOString().slice(11, 16)}`);
    return { sequence: Number(x.sequence), at: x.created_at.toISOString(), who: x.actor_label, role: x.actor_role, category: x.category, what: x.summary, store: x.store_label, detail: lines };
  });
  return { rows, hasMore: r.rows.length > q.limit };
}

/** The one expensive question, asked on request: do the entries still hash into each other? Returns the first break, if any. */
export async function verifyChain(on: Queryable = db): Promise<{ ok: boolean; entries: number; breaks: number }> {
  const n = (await on.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log`)).rows[0]!.n;
  const b = (await on.query<{ n: string }>(`SELECT count(*)::text AS n FROM verify_audit_chain()`)).rows[0]!.n;
  return { ok: Number(b) === 0, entries: Number(n), breaks: Number(b) };
}

// ---------------------------------------------------------------------------
// All orders
// ---------------------------------------------------------------------------

export type OrderFilter = 'today' | 'open' | 'attention' | 'cash';
export const ORDER_FILTERS: readonly OrderFilter[] = ['today', 'open', 'attention', 'cash'];

export type OrderRow = {
  id: string;
  number: number;
  store: string;
  storeId: string;
  customer: string;
  total: number;
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  flag: string | null;
  ageMinutes: number;
  /** The cursor for the page after this row: opaque to the client. */
  cursor: string;
};

const TERMINAL = `('delivered', 'collected', 'cancelled', 'rejected', 'returned', 'closed_return')`;

/** WHY AN ORDER NEEDS ATTENTION, as a sentence — computed from the order, never stored, so it clears the moment the cause does. */
const FLAG = `CASE
    WHEN EXISTS (SELECT 1 FROM complaints c WHERE c.order_id = o.id AND c.store_id = o.store_id AND c.status = 'escalated') THEN 'In dispute'
    WHEN o.status = 'pending' AND o.placed_at < now() - interval '20 minutes' THEN 'No reply in ' || (extract(epoch FROM now() - o.placed_at) / 60)::int || ' min'
    WHEN o.payment_method = 'cash' AND o.status IN ('delivered', 'collected') AND o.cash_confirmed_at IS NULL AND o.placed_at < now() - interval '24 hours' THEN 'Cash not confirmed'
    WHEN o.payment_method <> 'cash' AND o.payment_status = 'unpaid' AND o.status NOT IN ${TERMINAL} AND o.placed_at < now() - interval '15 minutes' THEN 'Payment pending'
    WHEN o.status = 'returned' THEN 'Returned to store'
  END`;

export async function orders(q: { filter: OrderFilter; search: string; before: { at: string; id: string } | null; limit: number }, on: Queryable = db): Promise<{ rows: OrderRow[]; hasMore: boolean; counts: { today: number; attention: number } }> {
  const args: unknown[] = [];
  const arg = (v: unknown): string => { args.push(v); return `$${args.length}`; };
  const where: string[] = [];

  const search = q.search.trim().replace(/^#/, '');
  if (search !== '') {
    const like = arg(`%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const digits = search.replace(/\D/g, '');
    where.push(`(o.order_number::text = ${arg(search)} OR s.name ILIKE ${like} OR COALESCE(u.name, o.guest_name) ILIKE ${like} OR ${digits.length >= 4 ? `regexp_replace(COALESCE(u.phone, o.guest_phone, ''), '\\D', '', 'g') LIKE ${arg(`%${digits}%`)}` : 'false'})`);
  } else if (q.filter === 'today') {
    where.push(`o.placed_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Kigali') AT TIME ZONE 'Africa/Kigali'`);
  }
  if (q.filter === 'open') where.push(`o.status NOT IN ${TERMINAL}`);
  if (q.filter === 'attention') where.push(`(${FLAG}) IS NOT NULL`);
  if (q.filter === 'cash') where.push(`o.payment_method = 'cash' AND o.payment_status = 'unpaid' AND o.status NOT IN ('cancelled', 'rejected')`);
  if (q.before !== null) where.push(`(o.placed_at, o.id) < (${arg(q.before.at)}::timestamptz, ${arg(q.before.id)}::uuid)`);

  const r = await on.query<{ id: string; order_number: number; store: string; store_id: string; cust: string | null; total: string; payment_method: string; payment_status: string; status: string; flag: string | null; placed_at: Date }>(
    `SELECT o.id, o.order_number, s.name AS store, s.id AS store_id, COALESCE(u.name, o.guest_name) AS cust, o.total_amount::text AS total, o.payment_method, o.payment_status, o.status,
            ${FLAG} AS flag, o.placed_at
       FROM orders o JOIN stores s ON s.id = o.store_id LEFT JOIN users u ON u.id = o.customer_user_id
      ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
      ORDER BY o.placed_at DESC, o.id DESC LIMIT ${arg(q.limit + 1)}`,
    args,
  );

  const c = (await on.query<{ today: string; attention: string }>(
    `SELECT (SELECT count(*) FROM orders WHERE placed_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Kigali') AT TIME ZONE 'Africa/Kigali')::text AS today,
            (SELECT count(*) FROM orders o WHERE o.placed_at >= now() - interval '30 days' AND (${FLAG}) IS NOT NULL)::text AS attention`,
  )).rows[0]!;

  return {
    rows: r.rows.slice(0, q.limit).map((x) => ({
      id: x.id, number: x.order_number, store: x.store, storeId: x.store_id, customer: x.cust ?? 'A customer', total: Number(x.total), paymentMethod: x.payment_method, paymentStatus: x.payment_status, status: x.status, flag: x.flag,
      ageMinutes: Math.max(0, Math.round((Date.now() - x.placed_at.getTime()) / 60_000)),
      cursor: `${x.placed_at.toISOString()}|${x.id}`,
    })),
    hasMore: r.rows.length > q.limit,
    counts: { today: Number(c.today), attention: Number(c.attention) },
  };
}

// ---------------------------------------------------------------------------
// Platform settings: Health
// ---------------------------------------------------------------------------

export type Health = { name: string; detail: string; state: 'ok' | 'warn' | 'off' };

export async function health(on: Queryable = db): Promise<Health[]> {
  const out: Health[] = [{ name: 'API', detail: 'Responding', state: 'ok' }];
  for (const p of await providerHealth(on)) {
    out.push({
      name: p.name,
      detail: p.rate === null ? (p.status === 'paused' ? 'Paused' : 'No payments in the last hour') : `${p.rate.toFixed(1)}% success · ${p.attempts} payments`,
      state: p.status === 'degraded' ? 'warn' : p.status === 'operational' ? 'ok' : 'off',
    });
  }
  // The outbox is the truth about messaging: a configured transport means messages are leaving; none means they are WAITING, and how many.
  const q = await queueState(on);
  const line = (c: 'sms' | 'email', name: string): Health => {
    const s = q[c];
    if (s.configured) return { name, detail: s.queued === 0 ? 'Development transport · nothing waiting' : `Development transport · ${s.queued} waiting`, state: s.queued > 20 ? 'warn' : 'ok' };
    return { name, detail: s.queued === 0 ? 'No provider connected · nothing waiting' : `No provider connected · ${s.queued} ${s.queued === 1 ? 'message' : 'messages'} waiting${s.oldestMinutes === null ? '' : `, oldest ${s.oldestMinutes} min`}`, state: 'off' };
  };
  out.push(line('sms', 'SMS gateway'), line('email', 'Email'));

  const run = (await on.query<{ last: Date | null; failed: string; today: string }>(
    `SELECT max(requested_at) AS last,
            (count(*) FILTER (WHERE status = 'failed' AND requested_at >= now() - interval '1 day'))::text AS failed,
            (count(*) FILTER (WHERE requested_at >= now() - interval '1 day'))::text AS today
       FROM withdrawals WHERE initiated_by = 'automatic'`,
  )).rows[0]!;
  const off = process.env['SETTLEMENT_SCHEDULER'] === 'off';
  out.push({
    name: 'Payout scheduler',
    detail: off ? 'Switched off on this server' : run.last === null ? 'No automatic payout has run yet' : `Last run ${run.last.toISOString().slice(11, 16)} · ${run.failed} ${Number(run.failed) === 1 ? 'failure' : 'failures'} in 24 h`,
    state: off ? 'off' : Number(run.failed) > 0 ? 'warn' : 'ok',
  });
  return out;
}

// ---------------------------------------------------------------------------
// Messages: what is waiting, and what went (or did not)
// ---------------------------------------------------------------------------

export type MessageRow = { id: string; at: string; channel: 'sms' | 'email'; template: string; label: string; audience: string; recipient: string; store: string | null; status: string; error: string | null; provider: string | null };

/** "250781110001" → "250 ••• 0001", "aline@nyama.rw" → "a•••@nyama.rw": enough to recognise your own, not enough to read a stranger's. */
const mask = (r: string): string => (r.includes('@') ? `${r.slice(0, 1)}•••${r.slice(r.indexOf('@'))}` : r.length < 7 ? '•••' : `${r.slice(0, 3)} ••• ${r.slice(-4)}`);

export async function messages(on: Queryable = db): Promise<{ queue: Awaited<ReturnType<typeof queueState>>; recent: MessageRow[] }> {
  const r = await on.query<{ id: string; queued_at: Date; channel: 'sms' | 'email'; template: string; audience: string; recipient: string; store: string | null; status: string; last_error: string | null; provider: string | null }>(
    `SELECT m.id, m.queued_at, m.channel, m.template, m.audience, m.recipient, s.name AS store, m.status, m.last_error, m.provider
       FROM message_outbox m LEFT JOIN stores s ON s.id = m.store_id ORDER BY m.queued_at DESC, m.id LIMIT 30`,
  );
  return { queue: await queueState(on), recent: r.rows.map((x) => ({ id: x.id, at: x.queued_at.toISOString(), channel: x.channel, template: x.template, label: templateLabel(x.template), audience: x.audience, recipient: mask(x.recipient), store: x.store, status: x.status, error: x.last_error, provider: x.provider })) };
}
