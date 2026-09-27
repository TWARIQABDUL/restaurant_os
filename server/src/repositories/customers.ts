// server/src/repositories/customers.ts — milestone 18.
//
// A customer's own account at one store: who they are, where they want things delivered, what they have
// ordered, and what went wrong.
//
// "THIS ACCOUNT IS ONLY FOR NYAMA & CO." is on the board and it is V001's `scope = 'store'` — one customer
// row per store per person, each with its own password. So nothing in this file takes a store id AND a user
// id as independent facts: the user's own `store_id` is the store, and a mismatch between them is a bug
// rather than a case to handle. Every function here proves that pairing once and then trusts it.
//
// REGISTERING IS THE SAME PATH AS THE INVITE, deliberately: milestone 15's `users.setPassword` and the
// bcrypt cost live in repositories/users.ts, and a second hashing site would be a second cost setting to
// keep in step.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';

export type CustomerProfile = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  /** The board's "customer since March". */
  since: Date;
};

export type SavedAddress = {
  id: string;
  label: string;
  address: string;
  isDefault: boolean;
};

/** The signed-in customer, confirmed to belong to this store. Null when they are not one. */
export async function profile(
  storeId: string,
  userId: string,
  on: Queryable = db,
): Promise<CustomerProfile | null> {
  const { rows } = await on.query<{
    id: string;
    name: string;
    email: string;
    phone: string | null;
    created_at: Date;
  }>(
    `SELECT id, name, email, phone, created_at
       FROM users
      WHERE id = $1 AND store_id = $2 AND scope = 'store'`,
    [userId, storeId],
  );
  const row = rows[0];
  return row === null || row === undefined
    ? null
    : { id: row.id, name: row.name, email: row.email, phone: row.phone, since: row.created_at };
}

export async function addresses(userId: string, on: Queryable = db): Promise<SavedAddress[]> {
  const { rows } = await on.query<{
    id: string;
    label: string;
    address: string;
    is_default: boolean;
  }>(
    // Default first, then oldest — so the one checkout should offer is the one at the top of the list, and the
    // order does not shuffle as they add more.
    `SELECT id, label, address, is_default
       FROM customer_addresses
      WHERE user_id = $1
      ORDER BY is_default DESC, created_at, id`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, label: r.label, address: r.address, isDefault: r.is_default }));
}

/**
 * Save an address.
 *
 * THE FIRST ONE IS ALWAYS THE DEFAULT, because a customer with exactly one saved address and no default is a
 * checkout screen with nothing pre-selected — and the board pre-selects.
 */
export async function addAddress(
  userId: string,
  label: string,
  address: string,
  on: Queryable = db,
): Promise<SavedAddress> {
  const { rows } = await on.query<{
    id: string;
    label: string;
    address: string;
    is_default: boolean;
  }>(
    `INSERT INTO customer_addresses (user_id, label, address, is_default)
          VALUES ($1, $2, $3, NOT EXISTS (SELECT 1 FROM customer_addresses WHERE user_id = $1))
       RETURNING id, label, address, is_default`,
    [userId, label.trim(), address.trim()],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('customer_addresses insert returned no row');
  return { id: row.id, label: row.label, address: row.address, isDefault: row.is_default };
}

/** Make one the default and clear the rest. One statement, in SQL — see V020. */
export async function makeDefaultAddress(
  userId: string,
  addressId: string,
  on: Queryable = db,
): Promise<void> {
  await on.query(`SELECT set_default_address($1, $2)`, [userId, addressId]);
}

export async function removeAddress(
  userId: string,
  addressId: string,
  on: Queryable = db,
): Promise<boolean> {
  const { rowCount } = await on.query(
    `DELETE FROM customer_addresses WHERE id = $1 AND user_id = $2`,
    [addressId, userId],
  );
  return (rowCount ?? 0) > 0;
}

export type OrderSummary = {
  trackingCode: string;
  orderNumber: number;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  total: string;
  placedAt: Date;
  /** "2× Chicken burger, 1× Fries" — the board's one-line summary of the order. */
  summary: string;
  itemCount: number;
};

export type OrderCursor = { placedAt: string; id: string };

/**
 * A customer's orders, newest first, by keyset.
 *
 * `orders_customer_idx` is (customer_user_id, placed_at DESC) WHERE customer_user_id IS NOT NULL — so the id
 * is NOT in the index, and the cursor's tie-break therefore costs a filter on a tie group. Two orders sharing
 * a `placed_at` to the microsecond means two placed in the same transaction, which for one customer cannot
 * happen: place_order() writes one order per call. Measured rather than assumed — see the milestone-18 row.
 */
export async function orders(
  userId: string,
  options: { limit?: number; after?: OrderCursor | null } = {},
  on: Queryable = db,
): Promise<{ items: OrderSummary[]; nextCursor: OrderCursor | null }> {
  const limit = Math.min(Math.max(1, options.limit ?? 20), 50);
  const after = options.after ?? null;

  const { rows } = await on.query<{
    id: string;
    tracking_code: string;
    order_number: number;
    status: string;
    payment_status: string;
    payment_method: string;
    total_amount: string;
    placed_at: Date;
    summary: string | null;
    item_count: string;
  }>(
    `SELECT o.id, o.tracking_code, o.order_number, o.status, o.payment_status, o.payment_method,
            o.total_amount::text, o.placed_at,
            -- Composed in SQL so the list is one query rather than one per order. The board's own shape:
            -- "2× Chicken burger, 1× Fries + extra sauce".
            (SELECT string_agg(i.quantity || '× ' || i.product_name, ', ' ORDER BY i.created_at, i.id)
               FROM order_items i WHERE i.order_id = o.id) AS summary,
            (SELECT COALESCE(sum(i.quantity), 0)::text FROM order_items i WHERE i.order_id = o.id) AS item_count
       FROM orders o
      WHERE o.customer_user_id = $1
        AND ($2::timestamptz IS NULL
             OR ($3::uuid IS NULL AND o.placed_at < $2::timestamptz)
             OR ($3::uuid IS NOT NULL AND (o.placed_at, o.id) < ($2::timestamptz, $3::uuid)))
      ORDER BY o.placed_at DESC, o.id DESC
      LIMIT $4`,
    [userId, after?.placedAt ?? null, after?.id ?? null, limit + 1],
  );

  const items: OrderSummary[] = rows.slice(0, limit).map((r) => ({
    trackingCode: r.tracking_code,
    orderNumber: r.order_number,
    status: r.status,
    paymentStatus: r.payment_status,
    paymentMethod: r.payment_method,
    total: r.total_amount,
    placedAt: r.placed_at,
    summary: r.summary ?? '',
    itemCount: Number(r.item_count),
  }));

  const last = rows[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? { placedAt: last.placed_at.toISOString(), id: last.id }
      : null;

  return { items, nextCursor };
}

export type CustomerComplaint = {
  id: string;
  /** The board's "C-044". V008 generates it as an identity column, so it is stable and short enough to read out. */
  reference: number;
  orderNumber: number;
  trackingCode: string;
  reasonCode: string;
  detail: string;
  status: 'open' | 'escalated' | 'resolved' | 'rejected';
  /**
   * The store's last word on it, which the board quotes back: 'Nyama & Co.: "Sorry, a rider fell ill."'
   *
   * FROM THE EVENT THREAD, NOT FROM A COLUMN — there is no `resolution_note` on `complaints`, and looking for
   * one is how this query failed the first time it ran. V008 keeps the conversation in `complaint_events` with
   * an `actor_side`, which is the right shape: a complaint is a thread, and the reply a customer should see is
   * the most recent thing the STORE said rather than a single field that the next reply would overwrite.
   */
  storeReply: string | null;
  reopenedCount: number;
  createdAt: Date;
  /** "Not sorted? Reopen" — only a resolved or rejected complaint can be. */
  canReopen: boolean;
};

/**
 * The problems this customer has reported, newest first.
 *
 * `canReopen` IS COMPUTED FROM THE STATUS MACHINE rather than guessed: V008's complaint_status_transitions
 * table says which moves exist, and reopen_complaint() refuses anything else. Asking the table means this
 * cannot drift from what the endpoint will accept.
 */
export async function complaints(
  storeId: string,
  userId: string,
  on: Queryable = db,
): Promise<CustomerComplaint[]> {
  const { rows } = await on.query<{
    id: string;
    reference_number: string;
    order_number: number;
    tracking_code: string;
    reason_code: string;
    detail: string;
    status: CustomerComplaint['status'];
    store_reply: string | null;
    reopened_count: number;
    created_at: Date;
    can_reopen: boolean;
  }>(
    `SELECT c.id, c.reference_number::text, o.order_number, o.tracking_code, c.reason_code, c.detail, c.status,
            (SELECT e.note FROM complaint_events e
              WHERE e.complaint_id = c.id AND e.actor_side = 'store' AND e.note IS NOT NULL
              ORDER BY e.sequence DESC LIMIT 1) AS store_reply,
            c.reopened_count, c.created_at,
            EXISTS (SELECT 1 FROM complaint_status_transitions t
                     WHERE t.from_status = c.status AND t.to_status = 'open') AS can_reopen
       FROM complaints c
       JOIN orders o ON o.id = c.order_id
      WHERE c.store_id = $1 AND c.customer_user_id = $2
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT 50`,
    [storeId, userId],
  );

  return rows.map((r) => ({
    id: r.id,
    reference: Number(r.reference_number),
    orderNumber: r.order_number,
    trackingCode: r.tracking_code,
    reasonCode: r.reason_code,
    detail: r.detail,
    status: r.status,
    storeReply: r.store_reply,
    reopenedCount: r.reopened_count,
    createdAt: r.created_at,
    canReopen: r.can_reopen,
  }));
}

/** V008's own five, which are the board's five issues. */
export const COMPLAINT_REASONS = [
  'item_missing',
  'wrong_item',
  'quality_problem',
  'arrived_late',
  'other',
] as const;

export type ComplaintReason = (typeof COMPLAINT_REASONS)[number];

/** File one. V008 owns what a complaint may be filed against — it refuses an order with nothing wrong yet. */
export async function fileComplaint(
  orderId: string,
  reasonCode: ComplaintReason,
  detail: string,
  filedBy: string,
  on: Queryable = db,
): Promise<string> {
  const { rows } = await on.query<{ id: string }>(`SELECT file_complaint($1, $2, $3, $4) AS id`, [
    orderId,
    reasonCode,
    detail,
    filedBy,
  ]);
  const id = rows[0]?.id;
  if (id === undefined || id === null) throw new Error('file_complaint returned no id');
  return id;
}

/**
 * "Not sorted? Reopen".
 *
 * THE SIDE IS 'customer', AND IT IS THE FIRST ARGUMENT AFTER THE ID — reopen_complaint(id, side, actor, note).
 * V008 accepts 'customer', 'store' or 'platform' because all three can reopen ("The customer, you or Vendlyfy
 * can still reopen it. A rider does not"), and the side is what the event records. Passing the user id into
 * that slot would have been refused by the function's own check, which is why it has one.
 */
export async function reopenComplaint(
  complaintId: string,
  userId: string,
  note: string,
  on: Queryable = db,
): Promise<void> {
  await on.query(`SELECT reopen_complaint($1, 'customer', $2, $3)`, [complaintId, userId, note]);
}

/** Reorder. V020 owns what happens to a line that can no longer be bought. */
export async function reorder(
  cartId: string,
  orderId: string,
  on: Queryable = db,
): Promise<{ added: number; skipped: number; skippedNames: string[] }> {
  const { rows } = await on.query<{ added: number; skipped: number; skipped_names: string[] | null }>(
    `SELECT added, skipped, skipped_names FROM reorder_into_cart($1, $2)`,
    [cartId, orderId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('reorder_into_cart returned no row');
  return { added: row.added, skipped: row.skipped, skippedNames: row.skipped_names ?? [] };
}

/** Sign-in mid-checkout. V020 owns the merge; this is the one line that calls it. */
export async function claimCart(
  storeId: string,
  userId: string,
  sessionId: string,
  on: Queryable = db,
): Promise<{ cartId: string | null; linesMoved: number; quantityMerged: number }> {
  const { rows } = await on.query<{
    merged_cart_id: string | null;
    lines_moved: number;
    quantity_merged: number;
  }>(`SELECT merged_cart_id, lines_moved, quantity_merged FROM merge_cart_into_account($1, $2, $3)`, [
    storeId,
    userId,
    sessionId,
  ]);
  const row = rows[0];
  return {
    cartId: row?.merged_cart_id ?? null,
    linesMoved: row?.lines_moved ?? 0,
    quantityMerged: row?.quantity_merged ?? 0,
  };
}

/** A guest keeps the order they just placed. V020 owns the move; the route owns proving they hold the code. */
export async function claimGuestOrder(
  orderId: string,
  userId: string,
  label = 'Home',
  on: Queryable = db,
): Promise<void> {
  await on.query(`SELECT claim_guest_order($1, $2, $3)`, [orderId, userId, label]);
}
