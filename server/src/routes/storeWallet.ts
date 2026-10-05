// server/src/routes/storeWallet.ts — milestone 11.
//
// milestone 23 adds the Wallet screen's reads and the one write it exists for: Withdraw.
//
//   GET  /wallet                 the cards: pots, next release, cash with riders, identity, payout settings
//   GET  /wallet/activity        the ledger as a merchant reads it, keyset paginated, filtered by kind
//   GET  /wallet/refunds         the Refunds tab
//   GET  /payouts                the Withdrawals tab (milestone 11's, unchanged apart from the masked number)
//   GET  /payouts/:id            one payout, re-checked with MoMo if it is still in flight
//   POST /payouts                Withdraw — body { amount, idempotencyKey }; the DESTINATION IS NOT IN IT
//   PUT  /payouts/mode           automatic payouts on/off
//
// The two endpoints a manager must not reach. §5.4's third escalation test: "A manager
// cannot reach payout, wallet or store-settings endpoints — verified against the
// endpoint, not against whether the nav item is hidden."
//
// Both are reads. The Wallet board is milestone 23 and requesting a payout moves money
// through request_withdrawal(), which needs the idempotency story that milestone owns;
// half a money path is worse than none. What is here is complete in itself: the two
// pots as the database holds them, and the payout history, keyset paginated.
//
// Named storeWallet.ts rather than wallet.ts because routes/wallet.js is the legacy
// Supabase router and still serving production until cutover. Two modules differing
// only by extension would make `./wallet.js` ambiguous to TypeScript's resolver.

import { Router } from 'express';
import { badRequest, db, notFound } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, optionalPositiveInt, optionalTimestamp, requiredOneOf, requiredString } from '../api/validate.ts';
import { authOf, isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import * as money from '../repositories/money.ts';
import * as payouts from '../repositories/payouts.ts';
import * as riders from '../repositories/riders.ts';
import { holdMinutes } from '../payments/momo.ts';
import { withTransaction } from '../db/index.ts';

// TWO ROUTERS, not two routes on one. They are mounted at different paths —
// /wallet and /payouts — and they require DIFFERENT permissions: wallet.read and
// payouts.request. Sharing a router would mean sharing a mount point, and a single
// GET '/' cannot be two permissions.
export const walletRouter = Router({ mergeParams: true });
export const payoutsRouter = Router({ mergeParams: true });

/**
 * GET /api/stores/:storeId/wallet — the two pots.
 *
 * Amounts are strings, unrounded and unformatted, exactly as Postgres sent them.
 * Turning "12500.00" into "12,500 RWF" is the formatter's job in packages/core at
 * milestone 13, driven by the currencies table — not this route's, and certainly not
 * the client's.
 */
walletRouter.get(
  '/',
  requireStorePermission('wallet.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const wallet = await money.findWallet(storeId);

    // Every store has a wallet from the moment it exists (V005's AFTER INSERT trigger),
    // so this is "no such store" — and the caller holds wallet.read in it, which means
    // they held a membership a moment ago. Reachable if the store was deleted between
    // the guard's read and this one.
    if (wallet === null) throw notFound('That store no longer exists.');

    const summary = await money.summary(storeId, holdMinutes());
    const dest = await payouts.destination(storeId);
    const roster = await riders.roster(storeId);
    const debts = await riders.carriedOver(storeId);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      // Milestone 11's three fields, unchanged, so nothing that read them breaks.
      currency: wallet.currency,
      pending: wallet.pending_balance,
      available: wallet.available_balance,
      updatedAt: wallet.updated_at,
      // Milestone 23.
      pendingOrders: summary?.pendingOrders ?? 0,
      nextRelease: summary?.nextRelease ?? null,
      identity: summary?.identity ?? 'not_started',
      refundsOwed: summary?.refundsOwed ?? '0.00',
      holdMinutes: holdMinutes(),
      // "Cash with riders" is what riders SAY they carry — physical cash in a pocket is a fact about reports,
      // the same choice milestone 21 made for the roster.
      cashWithRiders: roster.reduce((sum, r) => sum + Number(r.cashCarried), 0).toFixed(2),
      shortfalls: debts.length,
      payout:
        dest === null
          ? null
          : { methodKey: dest.methodKey, phoneMasked: maskPhone(dest.phone), mode: dest.mode, automaticAt: dest.automaticAt },
    });
  }),
);

walletRouter.get(
  '/activity',
  requireStorePermission('wallet.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const filter = (['all', 'sale', 'refund', 'withdrawal', 'adjust'] as const).find((f) => f === req.query['filter']) ?? 'all';
    const before = optionalTimestamp(req.query['before'], 'before');
    const beforeId = req.query['beforeId'];
    if (beforeId !== undefined && beforeId !== '' && !isUuid(beforeId)) throw badRequest('beforeId must be the id from the previous page.', 'INVALID_CURSOR');
    if (isUuid(beforeId) && before === null) throw badRequest('beforeId needs the matching before timestamp.', 'INVALID_CURSOR');

    const limit = optionalPositiveInt(req.query['limit'], 'limit');
    const page = await money.activity(storeId, {
      filter,
      ...(limit === null ? {} : { limit }),
      before,
      beforeId: isUuid(beforeId) ? beforeId : null,
      holdMinutes: holdMinutes(),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ activity: page.items, nextCursor: page.nextCursor });
  }),
);

walletRouter.get(
  '/refunds',
  requireStorePermission('wallet.read'),
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ refunds: await money.refunds(storeIdOf(req)) });
  }),
);

/** "078 ••• 4412": the board never prints a whole number. Digits only, local format. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('250') && digits.length === 12 ? `0${digits.slice(3)}` : digits;
  return local.length < 7 ? '•••' : `${local.slice(0, 3)} ••• ${local.slice(-4)}`;
}

/**
 * GET /api/stores/:storeId/payouts — payout history, newest first.
 *
 * Keyset paginated on (requested_at, id): `?before=<iso>&beforeId=<uuid>`, both taken
 * from the previous page's `nextCursor`. §2.3 requires keyset for anything that grows,
 * and the id is in the cursor because two payouts requested in one transaction share
 * `now()` to the microsecond — milestone 10 lost a row to exactly that.
 */
payoutsRouter.get(
  '/',
  requireStorePermission('payouts.request'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const limit = optionalPositiveInt(req.query['limit'], 'limit');
    const before = optionalTimestamp(req.query['before'], 'before');
    const beforeId = req.query['beforeId'];

    // Both halves of the cursor or neither. A beforeId without a before would silently
    // page from the beginning, which looks like duplicated rows rather than a bad request.
    if (beforeId !== undefined && beforeId !== '' && !isUuid(beforeId)) {
      throw badRequest('beforeId must be the id from the previous page.', 'INVALID_CURSOR');
    }
    if (beforeId !== undefined && beforeId !== '' && before === null) {
      throw badRequest('beforeId needs the matching before timestamp.', 'INVALID_CURSOR');
    }

    const page = await money.listPayouts(storeId, {
      ...(limit === null ? {} : { limit }),
      before,
      beforeId: isUuid(beforeId) ? beforeId : null,
    });

    res.json({
      payouts: page.items.map((p) => ({
        id: p.id,
        amount: p.amount,
        phone: p.phone,
        phoneMasked: maskPhone(p.phone),
        status: p.status,
        failureReason: p.failure_reason,
        initiatedBy: p.initiated_by,
        requestedAt: p.requested_at,
        completedAt: p.completed_at,
      })),
      nextCursor: page.nextCursor,
    });
  }),
);

// Declared BEFORE '/:withdrawalId' so "mode" is not read as an id.
payoutsRouter.put(
  '/mode',
  requireStorePermission('payouts.request'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const mode = requiredOneOf(bodyOf(req.body), 'mode', ['manual', 'automatic'] as const);
    const ok = await withTransaction((tx) => payouts.setMode(storeId, mode, tx));
    if (!ok) throw badRequest('Add the MoMo number your payouts go to first.', 'NO_PAYOUT_DESTINATION');
    const dest = await payouts.destination(storeId);
    res.json({ payout: dest === null ? null : { mode: dest.mode, automaticAt: dest.automaticAt, phoneMasked: maskPhone(dest.phone) } });
  }),
);

payoutsRouter.get(
  '/:withdrawalId',
  requireStorePermission('payouts.request'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const id = req.params['withdrawalId'];
    if (!isUuid(id)) throw badRequest('That is not a payout.', 'INVALID_PAYOUT');

    // Re-checked with MoMo when it is still in flight: a merchant watching "Processing" should see it arrive
    // without waiting for the sweep. Errors from the provider are the sweep's to retry, not this page's to show.
    const { rows: inflight } = await db.query<{ reference_id: string }>(
      `SELECT m.reference_id FROM momo_transactions m
         JOIN withdrawals w ON w.id = m.withdrawal_id
        WHERE w.id = $1 AND w.store_id = $2 AND m.direction = 'disbursement' AND m.status = 'pending'`,
      [id, storeId],
    );
    if (inflight[0] !== undefined) await payouts.refresh(inflight[0].reference_id).catch(() => undefined);

    const { rows } = await db.query<{ id: string; amount: string; phone: string; status: string; failure_reason: string | null; initiated_by: string; requested_at: Date; completed_at: Date | null }>(
      `SELECT id, amount::text, phone, status, failure_reason, initiated_by, requested_at, completed_at
         FROM withdrawals WHERE id = $1 AND store_id = $2`,
      [id, storeId],
    );
    const w = rows[0];
    if (w === undefined) throw notFound('That payout does not exist.', 'PAYOUT_NOT_FOUND');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      payout: {
        id: w.id,
        amount: w.amount,
        phoneMasked: maskPhone(w.phone),
        status: w.status,
        failureReason: w.failure_reason,
        initiatedBy: w.initiated_by,
        requestedAt: w.requested_at,
        completedAt: w.completed_at,
      },
    });
  }),
);

payoutsRouter.post(
  '/',
  requireStorePermission('payouts.request'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const body = bodyOf(req.body);
    const amount = typeof body['amount'] === 'number' ? String(body['amount']) : requiredString(body, 'amount');
    const key = requiredString(body, 'idempotencyKey', { min: 8, max: 80 });

    const requested = await payouts.request(storeId, authOf(req).context.userId, amount, key);

    // AFTER the transaction has committed — see repositories/payouts.ts. Awaited, because the answer the
    // merchant sees is better for knowing whether MoMo refused it outright, and dispatch() never throws for a
    // provider failure. The sweep covers the case where this process dies right here.
    if (requested.dispatch !== null) await payouts.dispatch(requested.dispatch);

    const { rows } = await db.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason FROM withdrawals WHERE id = $1`,
      [requested.withdrawalId],
    );
    res.status(requested.dispatch === null ? 200 : 201).json({
      withdrawalId: requested.withdrawalId,
      status: rows[0]?.status ?? 'processing',
      failureReason: rows[0]?.failure_reason ?? null,
    });
  }),
);
