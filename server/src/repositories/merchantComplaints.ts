// server/src/repositories/merchantComplaints.ts — milestone 24, from project/Complaints.dc.html.
//
// "Customers file these from their order. Reply here; escalate to Vendlyfy if you can't agree."
//
// EVERY MOVE IS V008'S, and each one writes its own event in the same statement — resolve, reject, escalate, reopen.
// What this file adds is the READ the board draws (a list in three tabs, one thread with the order beside it) and one
// check the functions do not make: that the complaint belongs to THIS STORE. The functions take a complaint id and
// were written for callers that already knew whose it was; an unchecked id here would let one store's manager
// resolve another's.
//
// A STATUS THAT MOVED UNDER THE SCREEN IS A 409, NOT A GUESS. Two managers on one complaint is ordinary: the second
// to press Resolve finds it already resolved. The row is locked, its status read, and a caller who is acting on a
// stale view is told what it actually is.
//
// THE THREAD IS THE RECORD. `complaint_events` is append-only and chained, and the timeline on the board is exactly
// that table in order — labelled by `actor_side`, with the note each side wrote. The merchant's own actions are
// worded "You resolved: “…”", the board's phrasing, from the SIDE rather than the person: a thread between a
// customer, two managers and Vendlyfy reads as you / the customer / Vendlyfy, which is what the board draws.

import { conflict, db, notFound } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';

export type ComplaintTab = 'open' | 'escalated' | 'closed';
export type ComplaintStatus = 'open' | 'escalated' | 'resolved' | 'rejected';

export type ComplaintListItem = {
  id: string;
  reference: string;
  reason: string;
  customer: string;
  orderNumber: number;
  at: Date;
  status: ComplaintStatus;
};

export type ComplaintCounts = Record<ComplaintTab, number>;

const TAB_STATUSES: Record<ComplaintTab, ComplaintStatus[]> = {
  open: ['open'],
  escalated: ['escalated'],
  closed: ['resolved', 'rejected'],
};

/** C-051: the board's own format — the platform-wide number, padded to three. */
export const referenceOf = (n: string | number): string => `C-${String(n).padStart(3, '0')}`;

export async function counts(storeId: string, on: Queryable = db): Promise<ComplaintCounts> {
  const { rows } = await on.query<{ status: ComplaintStatus; n: string }>(
    `SELECT status, count(*)::text AS n FROM complaints WHERE store_id = $1 GROUP BY status`,
    [storeId],
  );
  const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
  return { open: by.get('open') ?? 0, escalated: by.get('escalated') ?? 0, closed: (by.get('resolved') ?? 0) + (by.get('rejected') ?? 0) };
}

export async function list(storeId: string, tab: ComplaintTab, on: Queryable = db): Promise<ComplaintListItem[]> {
  const { rows } = await on.query<{
    id: string;
    reference_number: string;
    reason_code: string;
    name: string | null;
    guest_name: string | null;
    order_number: number;
    created_at: Date;
    status: ComplaintStatus;
  }>(
    `SELECT c.id, c.reference_number::text, c.reason_code, u.name, o.guest_name, o.order_number, c.created_at, c.status
       FROM complaints c
       JOIN orders o ON o.id = c.order_id AND o.store_id = c.store_id
       LEFT JOIN users u ON u.id = c.customer_user_id
      WHERE c.store_id = $1 AND c.status = ANY($2::text[])
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT 100`,
    [storeId, TAB_STATUSES[tab]],
  );
  return rows.map((r) => ({
    id: r.id,
    reference: referenceOf(r.reference_number),
    reason: r.reason_code,
    customer: r.name ?? r.guest_name ?? 'A customer',
    orderNumber: r.order_number,
    at: r.created_at,
    status: r.status,
  }));
}

export type TimelineEvent = {
  type: string;
  side: 'customer' | 'store' | 'rider' | 'platform' | 'system';
  note: string | null;
  at: Date;
  /** Set when the actor is somebody at THIS store, so "You" can be told apart from a colleague. */
  actor: string | null;
};

export type EvidenceItem = { id: string; side: string; kind: string; label: string; url: string | null };

export type ComplaintDetail = {
  id: string;
  reference: string;
  reason: string;
  status: ComplaintStatus;
  text: string;
  at: Date;
  reopenedCount: number;
  customer: { name: string; phone: string | null };
  order: {
    id: string;
    number: number;
    items: { label: string; amount: string }[];
    total: string;
    refunded: string;
    /** "Delivered by Claude H. at 14:02 · paid by MoMo", assembled by the screen from these. */
    deliveredAt: Date | null;
    riderName: string | null;
    paymentMethod: string;
    fulfilment: 'delivery' | 'pickup';
  };
  evidence: EvidenceItem[];
  timeline: TimelineEvent[];
  decision: 'refunded' | 'rejected' | null;
  /** A refund the merchant already asked Vendlyfy for on this complaint, still waiting. */
  pendingRefund: string | null;
};

export async function get(storeId: string, complaintId: string, on: Queryable = db): Promise<ComplaintDetail | null> {
  const { rows } = await on.query<{
    id: string;
    reference_number: string;
    reason_code: string;
    status: ComplaintStatus;
    detail: string;
    created_at: Date;
    reopened_count: number;
    decision: 'refunded' | 'rejected' | null;
    cust_name: string | null;
    guest_name: string | null;
    cust_phone: string | null;
    guest_phone: string | null;
    order_id: string;
    order_number: number;
    total: string;
    refunded: string;
    delivered_at: Date | null;
    rider_name: string | null;
    payment_method: string;
    fulfilment_type: 'delivery' | 'pickup';
  }>(
    `SELECT c.id, c.reference_number::text, c.reason_code, c.status, c.detail, c.created_at, c.reopened_count, c.decision,
            u.name AS cust_name, o.guest_name, u.phone AS cust_phone, o.guest_phone,
            o.id AS order_id, o.order_number, o.total_amount::text AS total, o.refunded_amount::text AS refunded,
            o.delivered_at, rd.name AS rider_name, o.payment_method, o.fulfilment_type
       FROM complaints c
       JOIN orders o ON o.id = c.order_id AND o.store_id = c.store_id
       LEFT JOIN users u ON u.id = c.customer_user_id
       LEFT JOIN users rd ON rd.id = o.rider_user_id
      WHERE c.id = $1 AND c.store_id = $2`,
    [complaintId, storeId],
  );
  const c = rows[0];
  if (c === undefined) return null;

  const items = await on.query<{ product_name: string; variant_label: string; quantity: number; line_total: string }>(
    `SELECT product_name, variant_label, quantity, line_total_amount::text AS line_total
       FROM order_items WHERE order_id = $1 ORDER BY created_at, id`,
    [c.order_id],
  );
  const events = await on.query<{ event_type: string; actor_side: TimelineEvent['side']; note: string | null; created_at: Date; actor_name: string | null }>(
    `SELECT e.event_type, e.actor_side, e.note, e.created_at, a.name AS actor_name
       FROM complaint_events e
       LEFT JOIN users a ON a.id = e.actor_id
      WHERE e.complaint_id = $1 ORDER BY e.sequence`,
    [complaintId],
  );
  const evidence = await on.query<{ id: string; side: string; kind: string; label: string; storage_key: string | null }>(
    `SELECT id, side, kind, label, storage_key FROM complaint_evidence WHERE complaint_id = $1 ORDER BY created_at, id`,
    [complaintId],
  );
  const refund = await on.query<{ amount: string }>(
    `SELECT amount::text FROM refunds WHERE complaint_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [complaintId],
  );

  return {
    id: c.id,
    reference: referenceOf(c.reference_number),
    reason: c.reason_code,
    status: c.status,
    text: c.detail,
    at: c.created_at,
    reopenedCount: c.reopened_count,
    customer: { name: c.cust_name ?? c.guest_name ?? 'A customer', phone: c.cust_phone ?? c.guest_phone },
    order: {
      id: c.order_id,
      number: c.order_number,
      items: items.rows.map((i) => ({
        label: `${i.quantity}× ${i.product_name}${i.variant_label === '' ? '' : ` (${i.variant_label})`}`,
        amount: i.line_total,
      })),
      total: c.total,
      refunded: c.refunded,
      deliveredAt: c.delivered_at,
      riderName: c.rider_name,
      paymentMethod: c.payment_method,
      fulfilment: c.fulfilment_type,
    },
    evidence: evidence.rows.map((e) => ({
      id: e.id,
      side: e.side,
      kind: e.kind,
      label: e.label,
      // Only a path this server issued is shown as an image. Evidence lives in the KYC/complaint store that is
      // still an open decision (Part 9), so anything else is a label and nothing to fetch.
      url: e.storage_key !== null && e.storage_key.startsWith('/api/media/') ? e.storage_key : null,
    })),
    timeline: events.rows.map((e) => ({ type: e.event_type, side: e.actor_side, note: e.note, at: e.created_at, actor: e.actor_name })),
    decision: c.decision,
    pendingRefund: refund.rows[0]?.amount ?? null,
  };
}

/** Locks the complaint and returns its status, or throws 404 for a stranger's. */
async function lockOwn(storeId: string, complaintId: string, tx: Tx): Promise<ComplaintStatus> {
  const { rows } = await tx.query<{ status: ComplaintStatus }>(`SELECT status FROM complaints WHERE id = $1 AND store_id = $2 FOR UPDATE`, [complaintId, storeId]);
  const row = rows[0];
  if (row === undefined) throw notFound('That complaint does not exist.', 'COMPLAINT_NOT_FOUND');
  return row.status;
}

function movedOn(status: ComplaintStatus): Error {
  return conflict(`Somebody already dealt with this one — it is now ${status === 'escalated' ? 'with Vendlyfy' : status}. Reload to see how.`, 'COMPLAINT_CHANGED');
}

export async function resolve(
  storeId: string,
  complaintId: string,
  actorId: string,
  note: string,
  refund: { amount: string; reason: string } | null,
  tx: Tx,
): Promise<void> {
  if ((await lockOwn(storeId, complaintId, tx)) !== 'open') throw movedOn(await statusOf(complaintId, tx));
  await tx.query(`SELECT resolve_complaint($1, $2, $3, $4::numeric, $5)`, [complaintId, actorId, note, refund?.amount ?? null, refund?.reason === '' ? null : (refund?.reason ?? null)]);
}

export async function reject(storeId: string, complaintId: string, actorId: string, note: string, tx: Tx): Promise<void> {
  if ((await lockOwn(storeId, complaintId, tx)) !== 'open') throw movedOn(await statusOf(complaintId, tx));
  await tx.query(`SELECT reject_complaint($1, $2, $3)`, [complaintId, actorId, note]);
}

export async function escalate(storeId: string, complaintId: string, actorId: string, note: string, tx: Tx): Promise<void> {
  if ((await lockOwn(storeId, complaintId, tx)) !== 'open') throw movedOn(await statusOf(complaintId, tx));
  await tx.query(`SELECT escalate_complaint($1, $2, $3)`, [complaintId, actorId, note]);
}

/**
 * Reopen — the merchant's side. Only a resolved or rejected complaint can be, and V008's own transition table
 * says so; an open or escalated one answers with the 409 rather than the function's exception.
 */
export async function reopen(storeId: string, complaintId: string, actorId: string, tx: Tx): Promise<void> {
  const status = await lockOwn(storeId, complaintId, tx);
  if (status !== 'resolved' && status !== 'rejected') throw movedOn(status);
  await tx.query(`SELECT reopen_complaint($1, 'store', $2, NULL)`, [complaintId, actorId]);
}

async function statusOf(complaintId: string, tx: Queryable): Promise<ComplaintStatus> {
  const { rows } = await tx.query<{ status: ComplaintStatus }>(`SELECT status FROM complaints WHERE id = $1`, [complaintId]);
  return rows[0]!.status;
}
