// server/src/repositories/adminDisputes.ts — milestone 27, part B: AdminDisputes. Where the platform decides what a store and a
// customer could not settle between them.
//
// TWO KINDS OF THING ARRIVE HERE and they take different doors into the same money:
//   a REFUND REQUEST   the merchant asks Vendlyfy to return money on an order. Decided with approve_refund / reject_refund (V008).
//   a DISPUTE          the merchant ESCALATED a complaint they could not settle with the customer. Decided with
//                      decide_escalated_complaint(), which also records the platform's decision on the complaint's own thread and
//                      reaches the refund through the same refund_settle() — the only thing that keeps orders.refunded_amount, the
//                      ledger and the store's payout hold in step.
// A refund the merchant raised FROM an escalated complaint is part of that dispute, not a second item: the pile never lists both.
//
// THE DATABASE OWNS THE RULES (one decision, a reason, the amount, partial refunds, "pay now or queue until the balance covers
// it"). This file reads, shapes, and calls the functions; it does not re-implement what they refuse. What it adds is what the
// screen needs before a decision — the store's wallet, so the reviewer sees whether "approve" pays now or waits — and the same
// answer after one.

import { badRequest, conflict, db, notFound, withTransaction } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import * as complaints from './merchantComplaints.ts';

export type DisputeTab = 'refunds' | 'disputes' | 'closed';
export const DISPUTE_TABS: readonly DisputeTab[] = ['refunds', 'disputes', 'closed'];
export type Kind = 'refund' | 'dispute';

export type Item = {
  kind: Kind;
  id: string;
  title: string;
  store: string;
  storeId: string;
  order: number;
  customer: string;
  ageHours: number;
  status: 'open' | 'approved' | 'queued' | 'rejected';
};

const REASON: Record<string, string> = {
  item_missing: 'Item missing', wrong_item: 'Wrong item', quality_problem: 'Quality problem', arrived_late: 'Arrived late', other: 'Other',
  never_arrived: 'Never arrived', damaged: 'Damaged', missing_item: 'Item missing', late: 'Arrived late',
};
const reasonOf = (code: string): string => REASON[code] ?? code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const rwf = (n: string | number): string => `${String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} RWF`;

const NOT_ESCALATED = `NOT EXISTS (SELECT 1 FROM complaints c WHERE c.id = f.complaint_id AND c.status = 'escalated')`;

export async function queue(tab: DisputeTab, on: Queryable = db): Promise<{ items: Item[]; counts: Record<DisputeTab, number> }> {
  const counts = (await on.query<{ refunds: string; disputes: string; closed: string }>(
    `SELECT (SELECT count(*) FROM refunds f WHERE f.status IN ('pending', 'queued') AND ${NOT_ESCALATED})::text AS refunds,
            (SELECT count(*) FROM complaints WHERE status = 'escalated')::text AS disputes,
            ((SELECT count(*) FROM refunds f WHERE f.status IN ('approved', 'rejected') AND f.reviewed_at >= now() - interval '30 days' AND f.complaint_id IS NULL)
           + (SELECT count(*) FROM complaints WHERE decided_at >= now() - interval '30 days'))::text AS closed`,
  )).rows[0]!;

  const refundRows = (where: string, order: string): Promise<{ rows: { id: string; amount: string; approved: string | null; reason_code: string; status: string; at: Date; store: string; store_id: string; order_number: number; cust: string | null }[] }> =>
    on.query(
      `SELECT f.id, f.amount::text, f.approved_amount::text AS approved, f.reason_code, f.status, f.created_at AS at, s.name AS store, s.id AS store_id, o.order_number,
              COALESCE(u.name, o.guest_name) AS cust
         FROM refunds f JOIN stores s ON s.id = f.store_id JOIN orders o ON o.id = f.order_id AND o.store_id = f.store_id LEFT JOIN users u ON u.id = o.customer_user_id
        WHERE ${where} ORDER BY ${order} LIMIT 100`,
    );
  const disputeRows = (where: string, order: string): Promise<{ rows: { id: string; reason_code: string; status: string; decision: string | null; at: Date; store: string; store_id: string; order_number: number; cust: string | null }[] }> =>
    on.query(
      `SELECT c.id, c.reason_code, c.status, c.decision, COALESCE(c.escalated_at, c.created_at) AS at, s.name AS store, s.id AS store_id, o.order_number, COALESCE(u.name, o.guest_name) AS cust
         FROM complaints c JOIN stores s ON s.id = c.store_id JOIN orders o ON o.id = c.order_id AND o.store_id = c.store_id LEFT JOIN users u ON u.id = c.customer_user_id
        WHERE ${where} ORDER BY ${order} LIMIT 100`,
    );

  const age = (d: Date): number => (Date.now() - d.getTime()) / 3_600_000;
  const items: Item[] = [];
  if (tab === 'refunds') {
    for (const r of (await refundRows(`f.status IN ('pending', 'queued') AND ${NOT_ESCALATED}`, 'f.created_at, f.id')).rows) {
      items.push({ kind: 'refund', id: r.id, title: `Refund request · ${rwf(r.amount)}`, store: r.store, storeId: r.store_id, order: r.order_number, customer: r.cust ?? 'A customer', ageHours: age(r.at), status: r.status === 'queued' ? 'queued' : 'open' });
    }
  } else if (tab === 'disputes') {
    for (const r of (await disputeRows(`c.status = 'escalated'`, 'c.escalated_at, c.id')).rows) {
      items.push({ kind: 'dispute', id: r.id, title: `Escalated · ${reasonOf(r.reason_code)}`, store: r.store, storeId: r.store_id, order: r.order_number, customer: r.cust ?? 'A customer', ageHours: age(r.at), status: 'open' });
    }
  } else {
    for (const r of (await refundRows(`f.status IN ('approved', 'rejected') AND f.reviewed_at >= now() - interval '30 days' AND f.complaint_id IS NULL`, 'f.reviewed_at DESC, f.id')).rows) {
      items.push({ kind: 'refund', id: r.id, title: `Refund request · ${rwf(r.amount)}`, store: r.store, storeId: r.store_id, order: r.order_number, customer: r.cust ?? 'A customer', ageHours: age(r.at), status: r.status === 'approved' ? 'approved' : 'rejected' });
    }
    for (const r of (await disputeRows(`c.decided_at >= now() - interval '30 days'`, 'c.decided_at DESC, c.id')).rows) {
      items.push({ kind: 'dispute', id: r.id, title: `Escalated · ${reasonOf(r.reason_code)}`, store: r.store, storeId: r.store_id, order: r.order_number, customer: r.cust ?? 'A customer', ageHours: age(r.at), status: r.decision === 'refunded' ? 'approved' : 'rejected' });
    }
  }
  return { items, counts: { refunds: Number(counts.refunds), disputes: Number(counts.disputes), closed: Number(counts.closed) } };
}

export type Message = { who: string; side: 'customer' | 'store' | 'platform' | 'rider' | 'system'; at: string; text: string };

export type Detail = {
  kind: Kind;
  id: string;
  title: string;
  status: 'open' | 'approved' | 'queued' | 'rejected';
  store: { id: string; name: string };
  order: { id: string; number: number; items: { label: string; amount: string }[]; total: string; refunded: string; payment: string; line: string };
  customer: string;
  /** What was asked for: the refund's amount, or the order total for a dispute that named none. */
  requested: string;
  /** The most that can still be refunded on this order. */
  maxRefund: string;
  wallet: { available: string; pending: string };
  history: string;
  thread: Message[];
  evidence: { label: string; side: string }[];
  /** For a decided item: what was decided and why, in the platform's own words. */
  closedNote: string | null;
  /** Null when a refund can be made; otherwise the sentence for why not — the database refuses a refund on an order nobody paid for. */
  refundBlocked: string | null;
};

export async function detail(kind: Kind, id: string, on: Queryable = db): Promise<Detail | null> {
  let storeId: string;
  let orderId: string;
  let refundRow: { amount: string; approved: string | null; status: string; reason_code: string; reason_note: string | null; rejection_reason: string | null; requested_by_name: string | null; at: Date } | null = null;

  if (kind === 'refund') {
    const f = (await on.query<{ store_id: string; order_id: string; complaint_id: string | null; amount: string; approved: string | null; status: string; reason_code: string; reason_note: string | null; rejection_reason: string | null; by: string | null; at: Date }>(
      `SELECT f.store_id, f.order_id, f.complaint_id, f.amount::text, f.approved_amount::text AS approved, f.status, f.reason_code, f.reason_note, f.rejection_reason, u.name AS by, f.created_at AS at
         FROM refunds f LEFT JOIN users u ON u.id = f.requested_by WHERE f.id = $1`,
      [id],
    )).rows[0];
    if (f === undefined) return null;
    storeId = f.store_id; orderId = f.order_id;
    refundRow = { amount: f.amount, approved: f.approved, status: f.status, reason_code: f.reason_code, reason_note: f.reason_note, rejection_reason: f.rejection_reason, requested_by_name: f.by, at: f.at };
  } else {
    const c = (await on.query<{ store_id: string; order_id: string }>(`SELECT store_id, order_id FROM complaints WHERE id = $1`, [id])).rows[0];
    if (c === undefined) return null;
    storeId = c.store_id; orderId = c.order_id;
  }

  const base = (await on.query<{ store: string; number: number; total: string; refunded: string; payment: string; paid: string; delivered_at: Date | null; rider: string | null; fulfilment: string; cust: string | null; available: string; pending: string; orders: string; refunds90: string; disputes: string }>(
    `SELECT s.name AS store, o.order_number AS number, o.total_amount::text AS total, o.refunded_amount::text AS refunded, o.payment_method AS payment, o.payment_status AS paid, o.delivered_at, rd.name AS rider, o.fulfilment_type AS fulfilment,
            COALESCE(u.name, o.guest_name) AS cust, w.available_balance::text AS available, w.pending_balance::text AS pending,
            (SELECT count(*) FROM orders x WHERE x.store_id = s.id)::text AS orders,
            (SELECT count(*) FROM refunds r WHERE r.store_id = s.id AND r.status = 'approved' AND r.reviewed_at >= now() - interval '90 days')::text AS refunds90,
            (SELECT count(*) FROM complaints c WHERE c.store_id = s.id AND c.status = 'escalated')::text AS disputes
       FROM orders o JOIN stores s ON s.id = o.store_id JOIN wallets w ON w.store_id = s.id LEFT JOIN users u ON u.id = o.customer_user_id LEFT JOIN users rd ON rd.id = o.rider_user_id
      WHERE o.id = $1 AND o.store_id = $2`,
    [orderId, storeId],
  )).rows[0];
  if (base === undefined) return null;
  const items = (await on.query<{ product_name: string; variant_label: string; quantity: number; line_total: string }>(
    `SELECT product_name, variant_label, quantity, line_total_amount::text AS line_total FROM order_items WHERE order_id = $1 ORDER BY created_at, id`, [orderId],
  )).rows.map((i) => ({ label: `${i.quantity}× ${i.product_name}${i.variant_label === '' ? '' : ` (${i.variant_label})`}`, amount: i.line_total }));

  const maxRefund = Math.max(0, Number(base.total) - Number(base.refunded)).toFixed(2);
  const line = `${base.delivered_at === null ? 'Not delivered' : `Delivered ${base.delivered_at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${base.rider === null ? '' : ` by ${base.rider}`}`} · ${base.payment.replace(/_/g, ' ')}`;

  let thread: Message[] = [];
  let evidence: Detail['evidence'] = [];
  let status: Detail['status'] = 'open';
  let title: string;
  let requested = base.total;
  let closedNote: string | null = null;

  if (kind === 'dispute') {
    const c = await complaints.get(storeId, id, on);
    if (c === null) return null;
    thread = [
      { who: c.customer.name, side: 'customer', at: c.at.toISOString(), text: c.text },
      ...c.timeline.filter((e) => e.note !== null && e.note !== '').map((e) => ({ who: e.side === 'store' ? `${base.store}${e.type.includes('escalat') ? ' escalated' : ''}` : e.side === 'platform' ? 'Vendlyfy' : e.side === 'customer' ? 'Customer' : e.side, side: e.side, at: e.at.toISOString(), text: e.note! })),
    ];
    evidence = c.evidence.map((e) => ({ label: e.label, side: e.side }));
    title = `Escalated · ${reasonOf(c.reason)}`;
    status = c.status === 'escalated' ? 'open' : c.decision === 'refunded' ? 'approved' : 'rejected';
    const pr = (await on.query<{ amount: string; status: string }>(`SELECT amount::text, status FROM refunds WHERE complaint_id = $1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
    if (pr !== undefined) {
      requested = pr.amount;
      if (pr.status === 'queued') status = 'queued';
    }
    if (c.status !== 'escalated') closedNote = c.decision === 'refunded' ? 'Refunded the customer.' : 'Rejected the escalation.';
    const last = c.timeline.filter((e) => e.side === 'platform').at(-1);
    if (closedNote !== null && last?.note) closedNote += ` Note: “${last.note}”`;
  } else {
    const f = refundRow!;
    title = `Refund request · ${rwf(f.amount)}`;
    requested = f.amount;
    thread = [{ who: `${base.store}${f.requested_by_name === null ? '' : ` (${f.requested_by_name.split(' ')[0]})`}`, side: 'store', at: f.at.toISOString(), text: `${reasonOf(f.reason_code)}${f.reason_note === null ? '' : `. ${f.reason_note}`}` }];
    status = f.status === 'pending' ? 'open' : f.status === 'queued' ? 'queued' : f.status === 'approved' ? 'approved' : 'rejected';
    if (status === 'approved') closedNote = `Refunded ${rwf(f.approved ?? f.amount)} from ${base.store}’s wallet.`;
    if (status === 'queued') closedNote = `Approved ${rwf(f.approved ?? f.amount)}. Waiting for ${base.store}’s balance to cover it; payouts are paused until then.`;
    if (status === 'rejected') closedNote = `Rejected. Note: “${f.rejection_reason ?? ''}”`;
  }

  return {
    kind, id, title, status, store: { id: storeId, name: base.store },
    order: { id: orderId, number: base.number, items, total: base.total, refunded: base.refunded, payment: base.payment, line },
    customer: base.cust ?? 'A customer', requested, maxRefund, wallet: { available: base.available, pending: base.pending },
    history: `${base.orders} orders · ${base.refunds90} refunds in 90 days · ${base.disputes === '0' ? 'no open dispute' : `${base.disputes} open dispute${base.disputes === '1' ? '' : 's'}`}`,
    thread, evidence, closedNote,
    refundBlocked: base.paid === 'paid' || base.paid === 'refunded' ? null : base.payment === 'cash' ? 'This order was cash on delivery and the cash was never confirmed as collected, so there is no money in the wallet to refund.' : 'This order was never paid, so there is nothing to refund.',
  };
}

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

export type Decision = { outcome: 'approve' | 'reject'; note: string; amount: string | null };

/**
 * Decides one item, once. The database's functions refuse a second decision, an empty reason and a refund above the order; this adds
 * the screen's own check (a positive amount in a sane shape) and translates "someone else decided" into a sentence.
 */
export async function decide(kind: Kind, id: string, actorId: string, d: Decision): Promise<Detail> {
  const note = d.note.trim();
  if (note === '') throw badRequest('Give a reason — the store and the customer both read it.', 'REASON_REQUIRED');
  if (d.outcome === 'approve' && (d.amount === null || !MONEY.test(d.amount) || Number(d.amount) <= 0)) throw badRequest('Enter the amount to refund.', 'INVALID_AMOUNT');

  const current = await detail(kind, id);
  if (current === null) throw notFound('That item does not exist.', 'NO_SUCH_ITEM');
  if (current.status !== 'open') throw conflict('That has already been decided.', 'ALREADY_DECIDED');
  if (d.outcome === 'approve' && current.refundBlocked !== null) throw badRequest(current.refundBlocked, 'NOT_PAID');
  if (d.outcome === 'approve' && Number(d.amount) > Number(current.maxRefund)) throw badRequest(`That is more than can still be refunded on this order (${rwf(current.maxRefund)}).`, 'ABOVE_ORDER');

  await withTransaction(
    async (tx) => {
      if (kind === 'refund') {
        const ok = d.outcome === 'approve'
          ? (await tx.query<{ ok: boolean }>(`SELECT approve_refund($1, $2, $3::numeric) AS ok`, [id, actorId, d.amount])).rows[0]?.ok
          : (await tx.query<{ ok: boolean }>(`SELECT reject_refund($1, $2, $3) AS ok`, [id, actorId, note])).rows[0]?.ok;
        if (ok !== true) throw conflict('Someone else already decided this.', 'ALREADY_DECIDED');
      } else {
        await tx.query(`SELECT decide_escalated_complaint($1, $2, $3, $4, $5::numeric)`, [id, actorId, d.outcome === 'approve' ? 'refund' : 'reject', note, d.outcome === 'approve' ? d.amount : null]);
      }
      await tx.query(
        `SELECT audit('money', $1, $2, $3, $4, $5, $6, $7)`,
        [d.outcome === 'approve' ? 'approve_refund' : 'reject_refund', `${d.outcome === 'approve' ? `Refunded ${rwf(d.amount!)}` : 'Rejected'} · order #${current.order.number} · ${current.store.name}`, actorId, current.store.id, note, kind === 'refund' ? 'refund' : 'complaint', id],
      );
    },
    { label: 'POST /admin/disputes/decision', retries: 0 },
  );
  return (await detail(kind, id))!;
}
