// server/src/repositories/payouts.ts — milestone 23.
//
// PAYING A MERCHANT OUT, from the request to the arrival, and the three layers that keep it from happening twice.
//
//   1. THE REQUEST IS IDEMPOTENT ON A KEY THE CLIENT MADE. The Withdraw sheet generates one when it opens, so a
//      double-tap, a retry after a lost response and a second tab all land on one withdrawal
//      (`request_withdrawal()` returns the existing one). The funds are reserved in the SAME transaction.
//   2. THE ATTEMPT IS WRITTEN BEFORE THE PROVIDER IS CALLED (`start_withdrawal_disbursement()`), with the
//      reference id MTN will see — and MTN's own X-Reference-Id makes a repeat of the call itself harmless.
//   3. NO PROVIDER CALL HAPPENS INSIDE A TRANSACTION, for the reason collections.ts gives.
//
// THE DESTINATION IS NEVER IN THE REQUEST. The number a payout goes to is `store_payout_settings.payout_phone`,
// read here. A body that could name a phone would let anyone holding `payouts.request` — or a stolen session —
// send the balance anywhere; changing the number is Settings' job (milestone 25), behind its own check.
//
// A REFUSAL AND A SILENCE ARE DIFFERENT THINGS. MoMo answering 4xx ("that number isn't registered") is
// definitive, so the money goes straight back (`resolve_disbursement(..., 'failed')`). A timeout or a 5xx is
// not: the request may have been accepted and only the reply lost, and returning the money then risks paying
// out twice. That one stays `processing` and `refresh()` — the status endpoint, the only thing believed — decides.

import { badRequest, conflict, db, withTransaction } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';
import * as momo from '../payments/momo.ts';
import * as platformSettings from './platformSettings.ts';

export type Destination = {
  methodKey: string;
  phone: string;
  mode: 'manual' | 'automatic';
  /** HH:MM, the store's own clock. Null when manual. */
  automaticAt: string | null;
};

export async function destination(storeId: string, on: Queryable = db): Promise<Destination | null> {
  const { rows } = await on.query<{ payout_method_key: string; payout_phone: string; settlement_mode: 'manual' | 'automatic'; automatic_at: string | null }>(
    `SELECT payout_method_key, payout_phone, settlement_mode, to_char(automatic_at, 'HH24:MI') AS automatic_at
       FROM store_payout_settings WHERE store_id = $1`,
    [storeId],
  );
  const r = rows[0];
  return r === undefined ? null : { methodKey: r.payout_method_key, phone: r.payout_phone, mode: r.settlement_mode, automaticAt: r.automatic_at };
}

/** The time of day automatic payouts go, until Settings (milestone 25) lets the merchant choose. The board says 08:00. */
/** The floor used if platform_settings has no row (it is seeded, so this is a bug's fallback). The live value is the setting's. */
export const DEFAULT_AUTOMATIC_AT = '08:00';

export async function setMode(storeId: string, mode: 'manual' | 'automatic', tx: Tx): Promise<boolean> {
  const at = (await platformSettings.read(tx)).automaticPayoutAt;
  // The table's own CHECK says automatic needs a time and manual must have none, so both are set together.
  const r = await tx.query(
    `UPDATE store_payout_settings
        SET settlement_mode = $2,
            automatic_at = CASE WHEN $2 = 'automatic' THEN COALESCE(automatic_at, $3::time) ELSE NULL END
      WHERE store_id = $1`,
    [storeId, mode, at],
  );
  return (r.rowCount ?? 0) > 0;
}

export type Requested = {
  withdrawalId: string;
  /** Present only when THIS call wrote the attempt — the caller that must now send it. */
  dispatch: string | null;
};

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

/**
 * Reserves the funds and writes the attempt, in one transaction. The caller sends `dispatch` AFTER it commits.
 *
 * Refuses before touching anything when payouts cannot work at all (no destination, MoMo disbursement not
 * configured) — so a merchant is never left with funds reserved for a transfer that cannot be sent.
 */
export async function request(
  storeId: string,
  userId: string,
  amount: string,
  idempotencyKey: string,
  initiatedBy: 'manual' | 'automatic' = 'manual',
): Promise<Requested> {
  if (!MONEY.test(amount) || Number(amount) <= 0) throw badRequest('Enter an amount above zero.', 'INVALID_AMOUNT');
  if (!momo.isDisbursementConfigured()) {
    throw conflict('Payouts are not available right now. Your balance is safe.', 'PAYOUTS_UNAVAILABLE');
  }

  return withTransaction(async (tx) => {
    const dest = await destination(storeId, tx);
    if (dest === null) {
      throw conflict('Add the MoMo number your payouts go to before you withdraw.', 'NO_PAYOUT_DESTINATION');
    }

    const { rows } = await tx.query<{ id: string }>(
      `SELECT request_withdrawal($1, $2::numeric, $3, $4, $5, $6) AS id`,
      [storeId, amount, dest.phone, idempotencyKey, initiatedBy === 'automatic' ? null : userId, initiatedBy],
    );
    const withdrawalId = rows[0]!.id;

    const started = await tx.query<{ reference_id: string; created: boolean }>(
      `SELECT reference_id, created FROM start_withdrawal_disbursement($1, $2)`,
      [withdrawalId, momo.newReferenceId()],
    );
    const s = started.rows[0]!;
    return { withdrawalId, dispatch: s.created ? s.reference_id : null };
  });
}

/**
 * Sends a payout MoMo has not yet been told about. Never throws for a provider failure — what happened is
 * recorded, and anything uncertain is left for `refresh()`.
 */
export async function dispatch(referenceId: string, on: Queryable = db): Promise<void> {
  const { rows } = await on.query<{ phone: string; amount: string }>(
    `SELECT phone, amount::text FROM momo_transactions WHERE reference_id = $1 AND direction = 'disbursement' AND status = 'pending'`,
    [referenceId],
  );
  const attempt = rows[0];
  if (attempt === undefined) return;

  try {
    await momo.transfer({ amount: attempt.amount, phone: attempt.phone, referenceId, payerMessage: 'Vendlyfy payout', payeeNote: 'Vendlyfy payout' });
  } catch (cause) {
    if (cause instanceof momo.DisbursementRefused) {
      await on.query(`SELECT resolve_disbursement($1, 'failed', $2)`, [referenceId, refusalReason(cause)]);
      return;
    }
    console.error(`[payout] transfer ${referenceId} not confirmed — left processing:`, cause instanceof Error ? cause.message : String(cause));
  }
}

/** What a merchant reads on the Withdrawals tab. MoMo's own body is for the log, not for them. */
function refusalReason(e: momo.DisbursementRefused): string {
  return e.status === 404 || e.status === 400
    ? 'MoMo didn’t accept the transfer: check that the number is a registered MTN MoMo account.'
    : 'MoMo didn’t accept the transfer.';
}

export type Refreshed = { status: 'pending' | 'successful' | 'failed'; resolved: boolean };

/**
 * Re-read a payout's real status and resolve it. The webhook, the sweep and a merchant's reload all call this;
 * none of them is believed over MoMo's authenticated endpoint.
 */
export async function refresh(referenceId: string, on: Queryable = db): Promise<Refreshed | null> {
  const { rows } = await on.query<{ status: 'pending' | 'successful' | 'failed'; phone: string; amount: string }>(
    `SELECT status, phone, amount::text FROM momo_transactions WHERE reference_id = $1 AND direction = 'disbursement'`,
    [referenceId],
  );
  const attempt = rows[0];
  if (attempt === undefined) return null;
  if (attempt.status !== 'pending') return { status: attempt.status, resolved: false };

  const real = await momo.transferStatus(referenceId);

  if (real.status === 'UNKNOWN') {
    // MoMo has never heard of it: the process died between writing the attempt and sending it. The reference id
    // is the idempotency key, so sending it now is safe — and is the only way this payout ever completes.
    await dispatch(referenceId, on);
    return { status: 'pending', resolved: false };
  }
  if (real.status === 'PENDING') return { status: 'pending', resolved: false };

  const { rows: done } = await on.query<{ ok: boolean }>(`SELECT resolve_disbursement($1, $2, $3) AS ok`, [
    referenceId,
    real.status === 'SUCCESSFUL' ? 'successful' : 'failed',
    real.status === 'FAILED' ? (real.reason ?? 'MoMo could not complete the transfer.') : null,
  ]);
  return { status: real.status === 'SUCCESSFUL' ? 'successful' : 'failed', resolved: done[0]?.ok === true };
}

/** Payouts still waiting on MoMo, oldest first — the sweep's work list. */
export async function pendingReferences(
  olderThanSeconds: number,
  limit: number,
  storeIds: readonly string[] | null = null,
  on: Queryable = db,
): Promise<string[]> {
  const { rows } = await on.query<{ reference_id: string }>(
    `SELECT reference_id FROM momo_transactions
      WHERE direction = 'disbursement' AND status = 'pending'
        AND created_at < now() - make_interval(secs => $1)
        AND ($3::uuid[] IS NULL OR store_id = ANY($3::uuid[]))
      ORDER BY created_at LIMIT $2`,
    [olderThanSeconds, limit, storeIds === null ? null : [...storeIds]],
  );
  return rows.map((r) => r.reference_id);
}

