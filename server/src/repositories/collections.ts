// server/src/repositories/collections.ts — milestone 17; provider switched to Urubuto Pay 2026-10-25.
//
// Taking the money, and the three layers V005 already built to make sure it is taken once.
//
// THE ORDER OF OPERATIONS IS THE WHOLE DESIGN, and it is the legacy system's, kept:
//
//   1. WRITE THE ATTEMPT FIRST, with the reference id that will be sent to the provider.
//      `momo_one_pending_per_order` makes a second attempt-in-flight unrepresentable, so this is also where
//      a double-tap is stopped.
//   2. THEN send the request(s). If the process dies between the two, the row exists and the real status can
//      be re-read — which is the only reason the ordering matters. The other way round, a crash loses a
//      payment that may already have been taken.
//   3. BELIEVE ONLY THE AUTHENTICATED STATUS ENDPOINT. The callback is unsigned/unverified-by-content; it is
//      a nudge. (Urubuto Pay's callback IS authenticated via a JWT this server issues — routes/urubutoWebhook.ts
//      — but decided 2026-10-25 to treat it the same way regardless: a nudge to re-check, not a thing to trust
//      outright. The reference integration this was ported from documents payload quirks not worth trusting
//      for money.)
//   4. RESOLVE THROUGH record_momo_collection_success(), which is idempotent and posts to the ledger under
//      a key, "exactly once, however many times the webhook arrives". (The function name is historical —
//      V035's header explains why the table and its functions were not renamed.)
//
// NO PROVIDER CALL HAPPENS INSIDE A TRANSACTION. A network request holding a database transaction open is a
// transaction whose length is somebody else's timeout, and this one would be holding rows an order needs.
//
// TWO CALLS, NOT ONE, for Urubuto Pay: create an invoice, then initiate a payment against it (see
// payments/urubuto.ts's header). The invoice number is persisted on the row the MOMENT it exists — a crash
// between the two calls must resume with the SAME invoice (create has no idempotency key), never create a
// second one. `provider_status = 'initiated'` marks that the initiate call is believed to have gone out, so
// refresh() knows whether to resume sending or to ask for status.

import { randomUUID } from 'node:crypto';
import { db, withTransaction } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import * as urubuto from '../payments/urubuto.ts';

export type CollectionState = 'pending' | 'successful' | 'failed';

export type Attempt = {
  id: string;
  orderId: string;
  referenceId: string;
  status: CollectionState;
  amount: string;
  currency: string;
  phone: string;
  invoiceNumber: string | null;
  initiated: boolean;
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
type AttemptRow = {
  id: string;
  order_id: string;
  reference_id: string;
  status: CollectionState;
  amount: string;
  currency: string;
  phone: string;
  invoice_number: string | null;
  provider_status: string | null;
  provider_message: string | null;
  created_at: Date;
  resolved_at: Date | null;
};

function toAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    orderId: row.order_id,
    referenceId: row.reference_id,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    phone: row.phone,
    invoiceNumber: row.invoice_number,
    initiated: row.provider_status === 'initiated',
    providerMessage: row.provider_message,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

// order_id is NOT NULL for a collection row (momo_collection_has_order), so Attempt.orderId is never null here.
const ATTEMPT_COLUMNS = 'id, order_id, reference_id, status, amount::text, currency, phone, invoice_number, provider_status, provider_message, created_at, resolved_at';

/** The name and email Urubuto Pay's /v2/payment/initiate requires — read fresh each time, not persisted on
 * the attempt, because a resumed send (see sendToUrubuto) may happen long after the row was created. */
async function payerInfo(orderId: string, on: Queryable): Promise<{ name: string; email: string }> {
  const { rows } = await on.query<{ guest_name: string | null; guest_email: string | null; name: string | null; email: string | null }>(
    `SELECT o.guest_name, o.guest_email, u.name, u.email
       FROM orders o LEFT JOIN users u ON u.id = o.customer_user_id
      WHERE o.id = $1`,
    [orderId],
  );
  const row = rows[0];
  const name = row?.name ?? row?.guest_name ?? '';
  const email = row?.email ?? row?.guest_email ?? '';
  return { name: name.trim() === '' ? 'Customer' : name, email: email.trim() === '' ? 'customer@vendlyfy.com' : email };
}

/**
 * Create-invoice-if-needed, then initiate. Resumable: if the row already has an invoice number (a previous
 * attempt got that far before crashing or erroring), it is REUSED, never re-created — create-invoice has no
 * idempotency key. `provider_status = 'initiated'` marks that initiate is believed to have gone out.
 */
async function sendToUrubuto(attempt: Attempt, on: Queryable): Promise<void> {
  let invoiceNumber = attempt.invoiceNumber;
  if (invoiceNumber === null) {
    invoiceNumber = await urubuto.createInvoice({ phone: attempt.phone, amount: attempt.amount, currency: attempt.currency });
    await on.query(`UPDATE momo_transactions SET invoice_number = $1 WHERE id = $2`, [invoiceNumber, attempt.id]);
  }
  const payer = await payerInfo(attempt.orderId, on);
  await urubuto.initiatePayment({
    invoiceNumber,
    transactionId: attempt.referenceId,
    phone: attempt.phone,
    amount: attempt.amount,
    payerName: payer.name,
    payerEmail: payer.email,
  });
  await on.query(`UPDATE momo_transactions SET provider_status = 'initiated' WHERE id = $1`, [attempt.id]);
}

export async function latestForOrder(orderId: string, on: Queryable = db): Promise<Attempt | null> {
  const { rows } = await on.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS}
       FROM momo_transactions
      WHERE order_id = $1 AND direction = 'collection'
      ORDER BY (status = 'pending') DESC, created_at DESC
      LIMIT 1`,
    [orderId],
  );
  const row = rows[0];
  return row === undefined ? null : toAttempt(row);
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

    const reference = randomUUID();
    const { rows: inserted } = await tx.query<AttemptRow>(
      `INSERT INTO momo_transactions (store_id, order_id, direction, reference_id, phone, amount, currency, gateway)
            VALUES ($1, $2, 'collection', $3, $4, $5::numeric, $6, 'urubuto')
        RETURNING ${ATTEMPT_COLUMNS}`,
      [order.store_id, orderId, reference, phone, order.total_amount, order.currency],
    );
    const row = inserted[0];
    if (row === undefined) throw new Error('momo_transactions insert returned no row');
    return { kind: 'claimed' as const, attempt: toAttempt(row) };
  });

  if (claim.kind === 'no_order') throw new Error(`order ${orderId} does not exist`);
  if (claim.kind === 'already_paid') return { outcome: 'already_paid' };
  if (claim.kind === 'already_pending') return { outcome: 'already_pending', attempt: claim.attempt };

  // The row is committed. Now, and only now, the request(s) go out.
  try {
    await sendToUrubuto(claim.attempt, db);
    return { outcome: 'requested', attempt: claim.attempt };
  } catch (error) {
    // THE ATTEMPT IS NOT MARKED FAILED. This is the case the ordering above exists for: the request may have
    // reached the provider and this may only be a lost response. Marking it failed would free
    // `momo_one_pending_per_order` and allow a second charge for the same order. It stays pending, and
    // refresh() below is what eventually learns the truth (or resumes sending, if it never went out at all).
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
 * Re-read an attempt's real status from Urubuto Pay and resolve it.
 *
 * THE ONLY THING THAT IS BELIEVED. The webhook calls this; the payment screen's poll calls this. Neither
 * trusts a body it was handed.
 *
 * RESUMES AN INCOMPLETE SEND. If the row has no invoice yet, or has an invoice but was never confirmed
 * initiated (`sendToUrubuto` crashed or errored partway through — e.g. the process died between the two
 * calls), there is nothing to ask Urubuto Pay's status endpoint about yet: it has never heard of this
 * transaction_id. So this resumes sending (reusing the invoice if one already exists) before falling
 * through to a status check — which is what makes the payment screen's poll a real recovery path, not
 * just a read.
 */
export async function refresh(referenceId: string, on: Queryable = db): Promise<RefreshResult | null> {
  const { rows } = await on.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM momo_transactions WHERE reference_id = $1 AND direction = 'collection'`,
    [referenceId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  if (row.status !== 'pending') return { status: row.status, settled: false, message: null };
  const attempt = toAttempt(row);

  if (!attempt.initiated) {
    try {
      await sendToUrubuto(attempt, on);
    } catch (error) {
      return { status: 'pending', settled: false, message: error instanceof Error ? error.message : 'the payment provider could not be reached' };
    }
  }

  const real = await urubuto.paymentStatus(attempt.referenceId);

  // Urubuto Pay has never heard of this transaction_id — the initiate call we just believed went out may
  // not have reached it. Leave it pending; the next refresh() resumes again rather than guessing.
  if (real === null) return { status: 'pending', settled: false, message: null };

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
