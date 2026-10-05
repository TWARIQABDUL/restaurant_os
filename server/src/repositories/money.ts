// server/src/repositories/money.ts — milestone 11.
//
// READS ONLY. Nothing in this file moves money — that is repositories/payouts.ts's, from milestone 23, where
// the idempotency story for a withdrawal lives.
//
// Milestone 11 read the balances and the payout history. Milestone 23's Wallet adds what the board draws around
// them: the summary cards, the Activity tab (a ledger a merchant can read), and the Refunds tab.
//
// Amounts are STRINGS, everywhere, exactly as Postgres sent them. packages/core's
// generated types say so and the reason is in their header: "a number here would
// invite arithmetic that loses cents." The formatter that turns one into "12,500 RWF"
// is milestone 13's, in packages/core, driven by the currencies table.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import type { WalletsRow, WithdrawalsRow } from '../db/rows.ts';

export type WalletBalances = Pick<
  WalletsRow,
  'store_id' | 'currency' | 'pending_balance' | 'available_balance' | 'updated_at'
>;

/**
 * A store's two pots.
 *
 * Every store has a wallet from the moment it exists — V005 creates one on an AFTER
 * INSERT trigger "so the money path never has to ask whether one is there" — so a
 * null return means the store does not exist, not that it has no wallet.
 */
export async function findWallet(storeId: string, on: Queryable = db): Promise<WalletBalances | null> {
  const { rows } = await on.query<WalletBalances>(
    `SELECT store_id, currency, pending_balance, available_balance, updated_at
       FROM wallets
      WHERE store_id = $1`,
    [storeId],
  );
  return rows[0] ?? null;
}

export type PayoutListItem = Pick<
  WithdrawalsRow,
  'id' | 'amount' | 'phone' | 'status' | 'failure_reason' | 'initiated_by' | 'requested_at' | 'completed_at'
>;

export type PayoutPage = {
  items: PayoutListItem[];
  /** Pass back as `before` / `beforeId` to get the next page. Null when there is none. */
  nextCursor: { requestedAt: string; id: string } | null;
};

/** Anything above this is a client asking for a report, not a page. */
const MAX_PAGE = 100;

/**
 * A store's payout history, newest first, KEYSET paginated.
 *
 * §2.3: "Keyset pagination for anything that grows — orders, ledger, audit log,
 * notifications. OFFSET degrades linearly."
 *
 * THE CURSOR IS (requested_at, id), NOT requested_at ALONE. Two payouts requested in the
 * same transaction share `now()` to the microsecond, and a cursor on the timestamp alone
 * then either skips the second or repeats the first. Milestone 10's notifications had
 * exactly this bug: six rows from one transaction, one cursor, and a page boundary that
 * lost a row.
 *
 * MEASURED, against 365,000 payouts across 200 stores (§2.3's "EXPLAIN (ANALYZE, BUFFERS)
 * before merge"), and one measurement overturned the reason this function was first
 * written the long way round:
 *
 *   page 2 by keyset     26 buffers, 0.095 ms   Index Scan, the cursor in the Index Cond
 *   page 2 by OFFSET   1,038 buffers, 1.723 ms  reads 1,027 rows to return 26
 *
 * The keyset is a seek rather than a scan only because V014 put `id` IN THE INDEX. With
 * the old two-column index and 40,000 payouts sharing one timestamp, the row comparison
 * became a filter applied after the fact: 6,231 buffers, 24 ms, 15,860 rows discarded.
 * The index is what fixes that — not the shape of the WHERE clause. An earlier version of
 * this function split into three statements to avoid `$2 IS NULL OR …`, on the theory that
 * the ORs hid the cursor from the planner; measured side by side on the same data, the two
 * forms produce identical plans and identical buffer counts. Postgres 17 extracts the
 * index condition from the ORs perfectly well. So this is one statement again.
 */
export async function listPayouts(
  storeId: string,
  options: { limit?: number; before?: string | null; beforeId?: string | null } = {},
  on: Queryable = db,
): Promise<PayoutPage> {
  const limit = Math.min(Math.max(1, options.limit ?? 25), MAX_PAGE);
  const before = options.before ?? null;
  const beforeId = options.beforeId ?? null;

  // One row more than asked for: its existence is how we know there is a next page
  // without a second COUNT over a growing table.
  const { rows } = await on.query<PayoutListItem>(
    `SELECT id, amount, phone, status, failure_reason, initiated_by, requested_at, completed_at
       FROM withdrawals
      WHERE store_id = $1
        AND ($2::timestamptz IS NULL
             OR ($3::uuid IS NULL AND requested_at < $2::timestamptz)
             OR ($3::uuid IS NOT NULL AND (requested_at, id) < ($2::timestamptz, $3::uuid)))
      ORDER BY requested_at DESC, id DESC
      LIMIT $4`,
    [storeId, before, beforeId, limit + 1],
  );

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? { requestedAt: last.requested_at.toISOString(), id: last.id }
      : null;

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// The Wallet screen — milestone 23
// ---------------------------------------------------------------------------

export type IdentityState = 'verified' | 'in_review' | 'not_started';

export type WalletSummary = {
  currency: string;
  pending: string;
  available: string;
  /** Orders paid but still inside the hold window. */
  pendingOrders: number;
  /** The next release: when, and how much. Null when nothing is waiting. */
  nextRelease: { at: Date; amount: string } | null;
  identity: IdentityState;
  /** What Vendlyfy has approved to refund but the balance cannot yet cover — it is paid BEFORE the merchant. */
  refundsOwed: string;
};

export async function summary(storeId: string, holdMinutes: number, on: Queryable = db): Promise<WalletSummary | null> {
  const { rows } = await on.query<{
    currency: string;
    pending: string;
    available: string;
    pending_orders: string;
    next_at: Date | null;
    next_amount: string | null;
    identity: IdentityState;
    owed: string;
  }>(
    `SELECT w.currency, w.pending_balance::text AS pending, w.available_balance::text AS available,
            (SELECT count(*) FROM orders o
              WHERE o.store_id = w.store_id AND o.settlement_status = 'pending' AND o.paid_at IS NOT NULL)::text AS pending_orders,
            nx.at AS next_at, nx.net::text AS next_amount,
            CASE WHEN store_is_verified(w.store_id) THEN 'verified'
                 WHEN EXISTS (SELECT 1 FROM kyc_submissions k WHERE k.store_id = w.store_id AND k.status IN ('submitted', 'in_review'))
                   THEN 'in_review'
                 ELSE 'not_started' END AS identity,
            COALESCE((SELECT sum(f.approved_amount) FROM refunds f WHERE f.store_id = w.store_id AND f.status = 'queued'), 0)::numeric(12,2)::text AS owed
       FROM wallets w
       LEFT JOIN LATERAL (
         SELECT o.paid_at + make_interval(mins => $2) AS at, (o.total_amount - o.refunded_amount) AS net
           FROM orders o
          WHERE o.store_id = w.store_id AND o.settlement_status = 'pending' AND o.paid_at IS NOT NULL
          ORDER BY o.paid_at
          LIMIT 1
       ) nx ON true
      WHERE w.store_id = $1`,
    [storeId, holdMinutes],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    currency: r.currency,
    pending: r.pending,
    available: r.available,
    pendingOrders: Number(r.pending_orders),
    nextRelease: r.next_at === null || r.next_amount === null ? null : { at: r.next_at, amount: r.next_amount },
    identity: r.identity,
    refundsOwed: r.owed,
  };
}

export type ActivityFilter = 'all' | 'sale' | 'refund' | 'withdrawal' | 'adjust';

const FILTER_TYPES: Record<Exclude<ActivityFilter, 'all'>, string[]> = {
  sale: ['order_payment_received'],
  refund: ['refund_paid'],
  withdrawal: ['withdrawal_reserved'],
  adjust: ['adjustment'],
};

/**
 * The entries a MERCHANT reads, out of the ledger's eight. The two-sided `escrow_released_*` pair is the sweep
 * moving money between two pots the merchant sees as one story (a sale is Pending, then Available), and
 * `withdrawal_reversed` is the end of a failed payout, shown on the payout's own row. Listing them would put
 * the same money on screen two or three times.
 */
const SHOWN = ['order_payment_received', 'refund_paid', 'withdrawal_reserved', 'adjustment'] as const;

export type ActivityRow = {
  id: string;
  at: Date;
  kind: 'sale' | 'refund' | 'withdrawal' | 'adjust';
  /** Signed, as the ledger holds it: a sale is positive, a refund or payout negative. */
  amount: string;
  /** The store's total (Pending + Available) once everything up to this moment had happened. */
  balanceAfter: string;
  pot: 'pending' | 'available';
  note: string | null;
  orderNumber: number | null;
  /** The order's payment method key — 'mtn_momo', 'cash' — for the sale's second line. */
  method: string | null;
  /** Sale: has the hold window ended. */
  released: boolean | null;
  availableAt: Date | null;
  refund: { approvedAmount: string | null; orderTotal: string; partial: boolean } | null;
  withdrawal: { status: string; initiatedBy: 'manual' | 'automatic'; phone: string; failureReason: string | null } | null;
};

export type ActivityPage = { items: ActivityRow[]; nextCursor: { at: string; id: string } | null };

type ActivityRaw = {
  id: string;
  created_at: Date;
  entry_type: string;
  pot: 'pending' | 'available';
  amount: string;
  note: string | null;
  balance_after: string;
  order_number: number | null;
  payment_method: string | null;
  settlement_status: string | null;
  paid_at: Date | null;
  order_total: string | null;
  approved_amount: string | null;
  refund_amount: string | null;
  wd_status: string | null;
  wd_initiated_by: 'manual' | 'automatic' | null;
  wd_phone: string | null;
  wd_failure: string | null;
};

/**
 * One page of Activity, newest first, keyset on (created_at, id) — §2.3, and for the reason notifications
 * (milestone 10) found: rows written by one transaction share `now()`.
 *
 * "BALANCE AFTER" IS THE STORE'S TOTAL, and it is computed as the wallet's total NOW minus everything newer
 * than the row — one index range per displayed row, against V025's (store_id, created_at DESC, id DESC).
 * Not a window over the whole ledger (a store's history grows without bound) and not a stored column (the
 * ledger is append-only and its trigger is V005's to keep small). Rows of one transaction share it, which is
 * the honest answer: the pots moved together.
 */
export async function activity(
  storeId: string,
  options: { filter?: ActivityFilter; limit?: number; before?: string | null; beforeId?: string | null; holdMinutes: number },
  on: Queryable = db,
): Promise<ActivityPage> {
  const limit = Math.min(Math.max(1, options.limit ?? 25), MAX_PAGE);
  const filter = options.filter ?? 'all';
  const types: string[] = filter === 'all' ? [...SHOWN] : FILTER_TYPES[filter];
  const before = options.before ?? null;
  const beforeId = options.beforeId ?? null;

  const { rows } = await on.query<ActivityRaw>(
    `SELECT r.id, r.created_at, r.entry_type, r.pot, r.amount::text, r.note,
            ((w.pending_balance + w.available_balance)
              - COALESCE((SELECT sum(x.amount) FROM wallet_ledger x
                           WHERE x.store_id = $1 AND x.created_at > r.created_at), 0))::text AS balance_after,
            o.order_number, o.payment_method, o.settlement_status, o.paid_at, o.total_amount::text AS order_total,
            f.approved_amount::text AS approved_amount, f.amount::text AS refund_amount,
            wd.status AS wd_status, wd.initiated_by AS wd_initiated_by, wd.phone AS wd_phone, wd.failure_reason AS wd_failure
       FROM (
         SELECT l.id, l.created_at, l.entry_type, l.pot, l.amount, l.note, l.order_id, l.refund_id, l.withdrawal_id
           FROM wallet_ledger l
          WHERE l.store_id = $1
            AND l.entry_type = ANY($2::text[])
            AND ($3::timestamptz IS NULL
                 OR ($4::uuid IS NULL AND l.created_at < $3::timestamptz)
                 OR ($4::uuid IS NOT NULL AND (l.created_at, l.id) < ($3::timestamptz, $4::uuid)))
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT $5
       ) r
       JOIN wallets w ON w.store_id = $1
       LEFT JOIN orders o ON o.id = r.order_id
       LEFT JOIN refunds f ON f.id = r.refund_id
       LEFT JOIN withdrawals wd ON wd.id = r.withdrawal_id
      ORDER BY r.created_at DESC, r.id DESC`,
    [storeId, types, before, beforeId, limit + 1],
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const items: ActivityRow[] = page.map((r) => {
    const kind: ActivityRow['kind'] =
      r.entry_type === 'order_payment_received' ? 'sale' : r.entry_type === 'refund_paid' ? 'refund' : r.entry_type === 'withdrawal_reserved' ? 'withdrawal' : 'adjust';
    const released = r.settlement_status === null ? null : r.settlement_status !== 'pending';
    return {
      id: r.id,
      at: r.created_at,
      kind,
      amount: r.amount,
      balanceAfter: r.balance_after,
      pot: r.pot,
      note: r.note,
      orderNumber: r.order_number,
      method: r.payment_method,
      released,
      availableAt:
        kind === 'sale' && released === false && r.paid_at !== null ? new Date(r.paid_at.getTime() + options.holdMinutes * 60_000) : null,
      refund:
        kind === 'refund' && r.order_total !== null
          ? {
              approvedAmount: r.approved_amount,
              orderTotal: r.order_total,
              partial: r.approved_amount !== null && Number(r.approved_amount) < Number(r.order_total),
            }
          : null,
      withdrawal:
        r.wd_status === null || r.wd_initiated_by === null || r.wd_phone === null
          ? null
          : { status: r.wd_status, initiatedBy: r.wd_initiated_by, phone: r.wd_phone, failureReason: r.wd_failure },
    };
  });

  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? { at: last.created_at.toISOString(), id: last.id } : null,
  };
}

export type RefundRow = {
  id: string;
  orderNumber: number;
  reason: string;
  note: string | null;
  requestedAt: Date;
  /** What the merchant asked for. */
  amount: string;
  /** What Vendlyfy granted, once it has decided. */
  approvedAmount: string | null;
  orderTotal: string;
  status: 'pending' | 'approved' | 'rejected' | 'queued';
  rejectionReason: string | null;
  settledAt: Date | null;
};

export async function refunds(storeId: string, limit = 50, on: Queryable = db): Promise<RefundRow[]> {
  const { rows } = await on.query<{
    id: string;
    order_number: number;
    reason_code: string;
    reason_note: string | null;
    created_at: Date;
    amount: string;
    approved_amount: string | null;
    order_total: string;
    status: RefundRow['status'];
    rejection_reason: string | null;
    settled_at: Date | null;
  }>(
    `SELECT f.id, o.order_number, f.reason_code, f.reason_note, f.created_at, f.amount::text,
            f.approved_amount::text, o.total_amount::text AS order_total, f.status, f.rejection_reason, f.settled_at
       FROM refunds f
       JOIN orders o ON o.id = f.order_id AND o.store_id = f.store_id
      WHERE f.store_id = $1
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT $2`,
    [storeId, Math.min(limit, MAX_PAGE)],
  );
  return rows.map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    reason: r.reason_code,
    note: r.reason_note,
    requestedAt: r.created_at,
    amount: r.amount,
    approvedAmount: r.approved_amount,
    orderTotal: r.order_total,
    status: r.status,
    rejectionReason: r.rejection_reason,
    settledAt: r.settled_at,
  }));
}
