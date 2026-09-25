// server/src/repositories/money.ts — milestone 11.
//
// READS ONLY. Nothing in this file moves money.
//
// The Wallet board is milestone 23 and the money functions — wallet_post,
// request_withdrawal, refund_settle — are already in the database with their own
// locking, idempotency keys and custom SQLSTATEs. Calling them needs the idempotency
// story that milestone 23 owns end to end, so this milestone reads balances and
// payout history and stops there. §5.4's third escalation test needs a wallet
// endpoint and a payout endpoint that really exist; it does not need a payout to be
// requestable, and half a money path is worse than none.
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
