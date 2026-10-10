// server/src/repositories/adminPayouts.ts — milestone 27, part B: AdminPayouts. Every store's payouts, in four piles.
//
//   Failed        a transfer MoMo did not complete. THE MONEY IS ALREADY BACK in the store's Available balance — V005's
//                 reverse_failed_withdrawal() did that in the same transaction that recorded the failure — so there is nothing to
//                 "reject" and the board's Reject button is not built: it would promise to return money that is not out. What an
//                 admin CAN do is Retry, which is a fresh request for the same amount to the number on file now.
//   Held          NOT a withdrawal at all: a store with money available and a reason it cannot leave (suspended, identity not
//                 verified, approved refunds owed). Nothing is attempted, so there is no row; the pile is derived from the same
//                 three conditions request_withdrawal() refuses on, so the screen and the gate cannot disagree.
//   In progress   sent, answer not in yet.
//   Completed     arrived.

import { conflict, db, notFound, withTransaction } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import * as payouts from './payouts.ts';
import * as platformSettings from './platformSettings.ts';

export type PayoutTab = 'problem' | 'held' | 'live' | 'done';
export const PAYOUT_TABS: readonly PayoutTab[] = ['problem', 'held', 'live', 'done'];

export type PayoutRow = {
  id: string;
  storeId: string;
  store: string;
  kind: 'Automatic' | 'Manual' | 'Held';
  destination: string;
  amount: number;
  at: string | null;
  status: 'failed' | 'held' | 'processing' | 'completed' | 'rejected';
  note: string;
  canRetry: boolean;
};

export type PayoutsPage = {
  tab: PayoutTab;
  rows: PayoutRow[];
  counts: Record<PayoutTab, number>;
  kpis: { runTotal: number; runStores: number; failed: number; held: number; holdMinutes: number };
};

const maskPhone = (p: string | null): string => {
  if (p === null) return 'no number';
  const d = p.replace(/\D/g, '');
  const local = d.startsWith('250') && d.length === 12 ? `0${d.slice(3)}` : d;
  return local.length < 7 ? '•••' : `${local.slice(0, 3)} ••• ${local.slice(-4)}`;
};

const HELD_WHERE = `w.available_balance > 0 AND (
      s.status = 'suspended'
      OR NOT store_is_verified(s.id)
      OR EXISTS (SELECT 1 FROM refunds f WHERE f.store_id = s.id AND f.status = 'queued'))`;

export async function page(tab: PayoutTab, on: Queryable = db): Promise<PayoutsPage> {
  const c = (await on.query<{ failed: string; live: string; done: string; held: string }>(
    `SELECT (SELECT count(*) FROM withdrawals WHERE status = 'failed' AND requested_at >= now() - interval '30 days'
                AND NOT EXISTS (SELECT 1 FROM withdrawals r WHERE r.idempotency_key = 'admin-retry:' || withdrawals.id::text))::text AS failed,
            (SELECT count(*) FROM withdrawals WHERE status IN ('pending', 'processing'))::text AS live,
            (SELECT count(*) FROM withdrawals WHERE status = 'completed' AND completed_at >= now() - interval '7 days')::text AS done,
            (SELECT count(*) FROM stores s JOIN wallets w ON w.store_id = s.id WHERE ${HELD_WHERE})::text AS held`,
  )).rows[0]!;

  const run = (await on.query<{ total: string; stores: string }>(
    `SELECT COALESCE(sum(amount), 0)::text AS total, count(DISTINCT store_id)::text AS stores
       FROM withdrawals
      WHERE initiated_by = 'automatic' AND status <> 'rejected'
        AND requested_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Kigali') AT TIME ZONE 'Africa/Kigali'`,
  )).rows[0]!;

  let rows: PayoutRow[];
  if (tab === 'held') {
    const r = await on.query<{ id: string; name: string; available: string; status: string; verified: boolean; owed: boolean; phone: string | null; method: string | null }>(
      `SELECT s.id, s.name, w.available_balance::text AS available, s.status, store_is_verified(s.id) AS verified,
              EXISTS (SELECT 1 FROM refunds f WHERE f.store_id = s.id AND f.status = 'queued') AS owed,
              ps.payout_phone AS phone, pm.name AS method
         FROM stores s JOIN wallets w ON w.store_id = s.id
         LEFT JOIN store_payout_settings ps ON ps.store_id = s.id
         LEFT JOIN payment_methods pm ON pm.key = ps.payout_method_key
        WHERE ${HELD_WHERE}
        ORDER BY w.available_balance DESC, s.id LIMIT 100`,
    );
    rows = r.rows.map((x) => ({
      id: x.id, storeId: x.id, store: x.name, kind: 'Held', destination: `${x.method ?? 'No payout account'} ${maskPhone(x.phone)}`.trim(), amount: Number(x.available), at: null, status: 'held', canRetry: false,
      note: x.status === 'suspended' ? 'Store suspended. Held until it is reinstated.' : !x.verified ? 'Identity not verified yet.' : 'Approved refunds are waiting for funds; they are paid first.',
    }));
  } else {
    const where = tab === 'problem' ? `w.status = 'failed' AND w.requested_at >= now() - interval '30 days'` : tab === 'live' ? `w.status IN ('pending', 'processing')` : `w.status = 'completed' AND w.completed_at >= now() - interval '7 days'`;
    const r = await on.query<{ id: string; store_id: string; name: string; amount: string; status: PayoutRow['status']; initiated_by: string; requested_at: Date; completed_at: Date | null; failure_reason: string | null; phone: string; method: string | null; retried: boolean }>(
      `SELECT w.id, w.store_id, s.name, w.amount::text, w.status, w.initiated_by, w.requested_at, w.completed_at, w.failure_reason, w.phone,
              (SELECT pm.name FROM momo_transactions t JOIN payment_methods pm ON pm.key = t.payment_method_key WHERE t.withdrawal_id = w.id LIMIT 1) AS method,
              EXISTS (SELECT 1 FROM withdrawals r WHERE r.idempotency_key = 'admin-retry:' || w.id::text) AS retried
         FROM withdrawals w JOIN stores s ON s.id = w.store_id
        WHERE ${where}
        ORDER BY w.requested_at DESC, w.id LIMIT 100`,
    );
    rows = r.rows
      .filter((x) => tab !== 'problem' || !x.retried)
      .map((x) => ({
        id: x.id, storeId: x.store_id, store: x.name, kind: x.initiated_by === 'automatic' ? 'Automatic' : 'Manual', destination: `${x.method ?? 'MoMo'} ${maskPhone(x.phone)}`, amount: Number(x.amount), at: x.requested_at.toISOString(), status: x.status,
        canRetry: x.status === 'failed',
        note: x.status === 'failed' ? `${x.failure_reason ?? 'The transfer did not complete.'} The money is back in the store’s Available balance.` : x.status === 'completed' ? `Arrived${x.completed_at === null ? '' : ` ${x.completed_at.toISOString().slice(11, 16)}`}.` : 'Sent to the provider; waiting for its answer.',
      }));
  }

  return {
    tab,
    rows,
    counts: { problem: Number(c.failed), held: Number(c.held), live: Number(c.live), done: Number(c.done) },
    kpis: { runTotal: Number(run.total), runStores: Number(run.stores), failed: Number(c.failed), held: Number(c.held), holdMinutes: await platformSettings.holdMinutes(on) },
  };
}

/**
 * Sends a failed payout again: a NEW request for the same amount, to the number on file now (so a number the merchant has since
 * corrected is used), through the one path every payout takes — request_withdrawal() and its holds, then the provider. The
 * idempotency key is derived from the failed row, so two admins pressing Retry at once get one transfer, not two.
 */
export async function retry(withdrawalId: string, actorId: string, ctx: { ip: string | null; userAgent: string | null }): Promise<{ withdrawalId: string; replay: boolean }> {
  const w = (await db.query<{ store_id: string; amount: string; status: string; name: string }>(
    `SELECT w.store_id, w.amount::text, w.status, s.name FROM withdrawals w JOIN stores s ON s.id = w.store_id WHERE w.id = $1`,
    [withdrawalId],
  )).rows[0];
  if (w === undefined) throw notFound('That payout does not exist.', 'NO_SUCH_PAYOUT');
  if (w.status !== 'failed') throw conflict('Only a failed payout can be retried.', 'NOT_FAILED');

  const key = `admin-retry:${withdrawalId}`;
  const already = (await db.query<{ id: string }>(`SELECT id FROM withdrawals WHERE store_id = $1 AND idempotency_key = $2`, [w.store_id, key])).rows[0];
  if (already !== undefined) return { withdrawalId: already.id, replay: true };

  const requested = await payouts.request(w.store_id, actorId, w.amount, key);
  await withTransaction(
    (tx) => tx.query(`SELECT audit('money', 'retry_payout', $1, $2, $3, $4, 'withdrawal', $5, $6::inet, $7)`, [`Retried payout · ${w.name} · ${w.amount} RWF`, actorId, w.store_id, null, requested.withdrawalId, ctx.ip, ctx.userAgent]),
    { label: 'audit retry_payout', retries: 0 },
  );
  if (requested.dispatch !== null) await payouts.dispatch(requested.dispatch);
  return { withdrawalId: requested.withdrawalId, replay: false };
}
