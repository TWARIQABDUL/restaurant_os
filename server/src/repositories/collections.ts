// server/src/repositories/collections.ts — milestone 17.
//
// Taking the money, and the three layers V005 already built to make sure it is taken once.
//
// THE ORDER OF OPERATIONS IS THE WHOLE DESIGN, and it is the legacy system's, kept:
//
//   1. WRITE THE ATTEMPT FIRST, with the reference id that will be sent to MTN. `momo_one_pending_per_order`
//      makes a second attempt-in-flight unrepresentable, so this is also where a double-tap is stopped.
//   2. THEN send the request. If the process dies between the two, the row exists and the real status can be
//      re-read from MoMo — which is the only reason the ordering matters. The other way round, a crash
//      loses a payment that may already have been taken.
//   3. BELIEVE ONLY THE AUTHENTICATED STATUS ENDPOINT. The callback is unsigned; it is a nudge.
//   4. RESOLVE THROUGH record_momo_collection_success(), which is idempotent and posts to the ledger under
//      a key, "exactly once, however many times the webhook arrives".
//
// NO PROVIDER CALL HAPPENS INSIDE A TRANSACTION. A network request holding a database transaction open is a
// transaction whose length is somebody else's timeout, and this one would be holding rows an order needs.

import { db, withTransaction } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import * as momo from '../payments/momo.ts';

export type CollectionState = 'pending' | 'successful' | 'failed';

export type Attempt = {
  id: string;
  referenceId: string;
  status: CollectionState;
  amount: string;
  phone: string;
  providerMessage: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

/**
 * The attempt in flight for an order, or the last one that resolved.
 *
 * Ordered so a PENDING attempt always wins: that is the one the payment screen is waiting on, and there can
 * only be one of them (`momo_one_pending_per_order`).
 */
export async function latestForOrder(orderId: string, on: Queryable = db): Promise<Attempt | null> {
  const { rows } = await on.query<{
    id: string;
    reference_id: string;
    status: CollectionState;
    amount: string;
    phone: string;
    provider_message: string | null;
    created_at: Date;
    resolved_at: Date | null;
  }>(
    `SELECT id, reference_id, status, amount::text, phone, provider_message, created_at, resolved_at
       FROM momo_transactions
      WHERE order_id = $1 AND direction = 'collection'
      ORDER BY (status = 'pending') DESC, created_at DESC
      LIMIT 1`,
    [orderId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        referenceId: row.reference_id,
        status: row.status,
        amount: row.amount,
        phone: row.phone,
        providerMessage: row.provider_message,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
      };
}

export type StartResult =
  | { outcome: 'requested'; attempt: Attempt }
  /** An attempt was already in flight — a second tap, or a retry. Nothing new was sent. */
  | { outcome: 'already_pending'; attempt: Attempt }
  /** The order is already paid. Not an error: the client should move to the receipt. */
  | { outcome: 'already_paid' }
  /** The row exists but MoMo could not be reached or is not configured. The attempt stands and can be re-read. */
  | { outcome: 'provider_unavailable'; attempt: Attempt; message: string };

/**
 * Start a collection for an order.
 *
 * IDEMPOTENT ON THE ORDER, not on a client-supplied key, and that is the right grain here: an order may be
 * charged once, so "is there already an attempt for this order" is the whole question. `momo_one_pending_per_order`
 * is what answers it under concurrency — two simultaneous calls cannot both insert, and the loser reads the
 * winner's row rather than starting a second charge.
 */
export async function start(orderId: string, phone: string): Promise<StartResult> {
  // No `on` parameter, deliberately: this function OPENS its own transaction for the claim and then makes a
  // network request outside it. Handed somebody else's transaction it would hold that one open across the
  // provider call, which is the thing the header says must not happen.
  // One transaction for the read-and-claim, so "already paid" and "already pending" are decided against the
  // same moment. The provider call is deliberately outside it.
  const claim = await withTransaction(async (tx) => {
    const { rows } = await tx.query<{
      store_id: string;
      currency: string;
      total_amount: string;
      payment_status: string;
      payment_method: string;
    }>(
      `SELECT store_id, currency, total_amount::text, payment_status, payment_method
         FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = rows[0];
    if (order === undefined) return { kind: 'no_order' as const };
    if (order.payment_status !== 'unpaid') return { kind: 'already_paid' as const };

    const existing = await latestForOrder(orderId, tx);
    if (existing !== null && existing.status === 'pending') {
      return { kind: 'already_pending' as const, attempt: existing };
    }

    const reference = momo.newReferenceId();
    const { rows: inserted } = await tx.query<{
      id: string;
      reference_id: string;
      status: CollectionState;
      amount: string;
      phone: string;
      provider_message: string | null;
      created_at: Date;
      resolved_at: Date | null;
    }>(
      `INSERT INTO momo_transactions (store_id, order_id, direction, reference_id, phone, amount, currency)
            VALUES ($1, $2, 'collection', $3, $4, $5::numeric, $6)
        RETURNING id, reference_id, status, amount::text, phone, provider_message, created_at, resolved_at`,
      [order.store_id, orderId, reference, phone, order.total_amount, order.currency],
    );
    const row = inserted[0];
    if (row === undefined) throw new Error('momo_transactions insert returned no row');
    return {
      kind: 'claimed' as const,
      attempt: {
        id: row.id,
        referenceId: row.reference_id,
        status: row.status,
        amount: row.amount,
        phone: row.phone,
        providerMessage: row.provider_message,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
      },
    };
  });

  if (claim.kind === 'no_order') throw new Error(`order ${orderId} does not exist`);
  if (claim.kind === 'already_paid') return { outcome: 'already_paid' };
  if (claim.kind === 'already_pending') return { outcome: 'already_pending', attempt: claim.attempt };

  // The row is committed. Now, and only now, the request goes out.
  try {
    await momo.requestToPay({
      amount: claim.attempt.amount,
      phone: claim.attempt.phone,
      referenceId: claim.attempt.referenceId,
      payerMessage: 'Order payment',
      payeeNote: 'Order payment',
    });
    return { outcome: 'requested', attempt: claim.attempt };
  } catch (error) {
    // THE ATTEMPT IS NOT MARKED FAILED. This is the case the ordering above exists for: the request may have
    // reached MTN and this may only be a lost response. Marking it failed would free
    // `momo_one_pending_per_order` and allow a second charge for the same order. It stays pending, and
    // refresh() below is what eventually learns the truth.
    return {
      outcome: 'provider_unavailable',
      attempt: claim.attempt,
      message: error instanceof Error ? error.message : 'the payment provider could not be reached',
    };
  }
}

export type RefreshResult = {
  status: CollectionState;
  /** True when this call is what moved the order to paid. */
  settled: boolean;
  message: string | null;
};

/**
 * Re-read an attempt's real status from MoMo and resolve it.
 *
 * THE ONLY THING THAT IS BELIEVED. The webhook calls this; the payment screen's poll calls this. Neither
 * trusts a body it was handed.
 */
export async function refresh(referenceId: string, on: Queryable = db): Promise<RefreshResult | null> {
  const { rows } = await on.query<{ id: string; status: CollectionState }>(
    `SELECT id, status FROM momo_transactions WHERE reference_id = $1 AND direction = 'collection'`,
    [referenceId],
  );
  const attempt = rows[0];
  if (attempt === undefined) return null;
  if (attempt.status !== 'pending') return { status: attempt.status, settled: false, message: null };

  const real = await momo.collectionStatus(referenceId);

  if (real.status === 'PENDING') {
    return { status: 'pending', settled: false, message: real.reason };
  }

  if (real.status === 'SUCCESSFUL') {
    // Idempotent, and it is V005's function rather than this file's: it claims the row, marks the order
    // paid, and posts to the ledger under a key — "exactly once, however many times the webhook arrives".
    const { rows: settled } = await on.query<{ ok: boolean }>(
      `SELECT record_momo_collection_success($1) AS ok`,
      [attempt.id],
    );
    return { status: 'successful', settled: settled[0]?.ok === true, message: real.reason };
  }

  // Failed. The customer's cart was already emptied by place_order, and the board's failed screen offers
  // "Try again" — which starts a NEW attempt, which the partial unique index now permits because this one is
  // resolved.
  await on.query(
    `UPDATE momo_transactions
        SET status = 'failed', resolved_at = now(), provider_status = 'FAILED', provider_message = $2
      WHERE id = $1 AND status = 'pending'`,
    [attempt.id, real.reason],
  );
  return { status: 'failed', settled: false, message: real.reason };
}

/** Cash orders are confirmed by a person, not a provider — V005's confirm_cash_payment() owns that. */
export async function isCash(orderId: string, on: Queryable = db): Promise<boolean> {
  const { rows } = await on.query<{ payment_method: string }>(
    `SELECT payment_method FROM orders WHERE id = $1`,
    [orderId],
  );
  return rows[0]?.payment_method === 'cash';
}
