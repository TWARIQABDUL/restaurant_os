// server/src/jobs/settlement.ts — milestone 23.
//
// THE THREE THINGS NOBODY CLICKS, which the Wallet screen quietly depends on. The legacy server ran them from
// `services/settlementScheduler.js` against the old database; the new one has its own database and, until now,
// nothing doing this work — so Pending would never become Available and an automatic payout would never go.
//
//   1. RELEASE ESCROW   a paid order leaves Pending once its hold window has elapsed (V005's
//                       release_eligible_orders(): SKIP LOCKED, ledger-keyed, "no clamp" — it raises rather than
//                       silently correcting an inconsistency).
//   2. PAY QUEUED REFUNDS  V008: "run after any credit". A release is a credit.
//   3. AUTOMATIC PAYOUTS   a store in automatic mode, past its time of day, verified, with money available and
//                          not already paid today.
//   4. RECONCILE        every payout still waiting on MoMo is re-read — the safety net behind the webhook and
//                       the merchant's own reload.
//
// EVERY STEP IS IDEMPOTENT AND SAFE TO RUN TWICE AT ONCE, which is what lets this run from more than one
// process: the release is SKIP LOCKED and keyed, the payout's idempotency key is the store's local DATE
// (`auto:2026-10-05`), so two sweeps race for one withdrawal and the loser gets the winner's back.
//
// ONE FAILURE NEVER STOPS THE REST. A store whose payout is refused (VLHLD: unverified, or a refund owed) is
// logged and skipped — the sweep is the platform's, and one merchant's hold must not stall every other's money.

import { db, sqlstate, withTransaction } from '../db/index.ts';
import { holdMinutes } from '../payments/momo.ts';
import * as payouts from '../repositories/payouts.ts';

export type SweepResult = {
  released: number;
  refundsPaid: number;
  automaticPayouts: number;
  reconciled: number;
};

export async function releaseEscrow(): Promise<{ released: number; refundsPaid: number }> {
  return withTransaction(async (tx) => {
    const released = await tx.query(`SELECT released_order_id FROM release_eligible_orders($1)`, [holdMinutes()]);
    const settled = await tx.query(`SELECT settled_refund_id FROM settle_queued_refunds()`);
    return { released: released.rows.length, refundsPaid: settled.rows.length };
  });
}

/**
 * Stores due an automatic payout right now. See the header for the four conditions.
 *
 * `storeIds` NARROWS THE SWEEP and exists for one reason: the suite runs against a database that also holds the
 * dev seed, and an unscoped sweep there pays out the seed's real stores. (It did, once — a 7,780 RWF payout for
 * Nyama, found and reversed by hand. Production passes nothing.)
 */
export async function dueAutomaticPayouts(storeIds: readonly string[] | null = null): Promise<{ storeId: string; available: string; day: string }[]> {
  const { rows } = await db.query<{ store_id: string; available: string; day: string }>(
    `SELECT ps.store_id, w.available_balance::text AS available, store_local(ps.store_id, now())::date::text AS day
       FROM store_payout_settings ps
       JOIN wallets w ON w.store_id = ps.store_id
      WHERE ps.settlement_mode = 'automatic'
        AND w.available_balance > 0
        AND store_local(ps.store_id, now())::time >= ps.automatic_at
        AND store_is_verified(ps.store_id)
        AND (SELECT status FROM stores WHERE id = ps.store_id) = 'active'
        AND ($1::uuid[] IS NULL OR ps.store_id = ANY($1::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM withdrawals wd
           WHERE wd.store_id = ps.store_id AND wd.initiated_by = 'automatic'
             AND store_local(ps.store_id, wd.requested_at)::date = store_local(ps.store_id, now())::date)`,
    [storeIds === null ? null : [...storeIds]],
  );
  return rows.map((r) => ({ storeId: r.store_id, available: r.available, day: r.day }));
}

export async function runAutomaticPayouts(storeIds: readonly string[] | null = null): Promise<number> {
  let sent = 0;
  for (const due of await dueAutomaticPayouts(storeIds)) {
    try {
      const requested = await payouts.request(due.storeId, '', due.available, `auto:${due.day}`, 'automatic');
      if (requested.dispatch !== null) await payouts.dispatch(requested.dispatch);
      sent += 1;
    } catch (cause) {
      // VLHLD and VLFND are expected: a hold, or the balance moved between the read and the reserve. The store
      // is tried again on the next tick, because the key is only written when the request succeeds.
      const code = sqlstate(cause);
      if (code !== 'VLHLD' && code !== 'VLFND') {
        console.error(`[settlement] automatic payout for ${due.storeId} failed:`, cause instanceof Error ? cause.message : String(cause));
      }
    }
  }
  return sent;
}

export async function reconcilePayouts(storeIds: readonly string[] | null = null): Promise<number> {
  let n = 0;
  for (const reference of await payouts.pendingReferences(15, 50, storeIds)) {
    try {
      await payouts.refresh(reference);
      n += 1;
    } catch (cause) {
      console.error(`[settlement] reconcile ${reference} failed:`, cause instanceof Error ? cause.message : String(cause));
    }
  }
  return n;
}

/** One pass over everything. Exported whole so a test, or an operator, can run it on demand. */
export async function sweep(): Promise<SweepResult> {
  const { released, refundsPaid } = await releaseEscrow();
  const automaticPayouts = await runAutomaticPayouts();
  const reconciled = await reconcilePayouts();
  return { released, refundsPaid, automaticPayouts, reconciled };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Starts the loop. Off when SETTLEMENT_SCHEDULER=off, so a second process (a worker, a test server) can opt out
 * of a job another process already runs — though two running it is harmless by design.
 */
export function startSettlementLoop(everyMs = Number(process.env['MOMO_SCHEDULER_INTERVAL_MS']) || 60_000): void {
  if (timer !== null || process.env['SETTLEMENT_SCHEDULER'] === 'off') return;
  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    sweep()
      .then((r) => {
        if (r.released + r.refundsPaid + r.automaticPayouts > 0) console.log('[settlement]', r);
      })
      .catch((cause: unknown) => console.error('[settlement] sweep failed:', cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref();
}

export function stopSettlementLoop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}
