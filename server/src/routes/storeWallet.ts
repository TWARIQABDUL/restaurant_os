// server/src/routes/storeWallet.ts — milestone 11.
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
import { badRequest, notFound } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { optionalPositiveInt, optionalTimestamp } from '../api/validate.ts';
import { isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import * as money from '../repositories/money.ts';

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

    res.json({
      currency: wallet.currency,
      pending: wallet.pending_balance,
      available: wallet.available_balance,
      updatedAt: wallet.updated_at,
    });
  }),
);

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
