// server/src/routes/storeOrders.ts — milestone 19.
//
//   POST /api/stores/:storeId/orders/:orderId/accept
//
// ONE ENDPOINT, DELIBERATELY. `Orders` is milestone 20 and it owns this path: the board, the list, declining
// with a reason, the rider picker, cash confirmation, returns. What lands here early is the single transition
// the new-order alert needs, because `Notifications` gives that alert an "Accept" button and an alert whose
// primary action does nothing is not a shipped alert.
//
// WHY ACCEPTING CAN SHIP ALONE: it moves no money and reserves no stock. `place_order()` already did both when
// the customer placed the order, so pending → approved is one status change and the event that records who made
// it. Declining is not symmetrical — it releases stock and may refund — which is exactly why it waits for the
// milestone that designs it.
//
// IDEMPOTENT, and here that is a requirement rather than a courtesy: the alert "shows on every signed-in screen
// at this store", so two people pressing Accept at once is the normal case. repositories/orders.ts explains how
// the row lock settles it and why "already declined" is the one answer that is not success.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { authOf, isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { AppError, badRequest, notFound, withTransaction } from '../db/index.ts';
import * as orders from '../repositories/orders.ts';

const router = Router({ mergeParams: true });

/** The two that mean somebody decided the other way. Everything from `approved` on means it was accepted. */
const DECIDED_AGAINST = new Set(['rejected', 'cancelled']);

router.post(
  '/:orderId/accept',
  requireStorePermission('orders.update'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const orderId = req.params['orderId'];
    if (!isUuid(orderId)) throw badRequest('That is not an order.', 'INVALID_ORDER');

    const outcome = await withTransaction((tx) =>
      orders.accept(storeId, orderId, { userId: context.userId, role: context.storeRole }, tx),
    );

    if (outcome === null) throw notFound('That order is not here.', 'NO_SUCH_ORDER');

    if (DECIDED_AGAINST.has(outcome.status)) {
      // AppError directly rather than conflict(), which takes no hint — and the hint is the half a merchant
      // acts on, so it is not optional here.
      throw new AppError({
        status: 409,
        code: 'ORDER_ALREADY_DECIDED',
        message:
          outcome.status === 'rejected'
            ? `Order #${outcome.orderNumber} was already declined.`
            : `Order #${outcome.orderNumber} was cancelled.`,
        hint: 'Open it in Orders to see who did it and why.',
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      orderNumber: outcome.orderNumber,
      status: outcome.status,
      // The client's toast is "#1034 accepted · customer notified" on a change and "already accepted" when
      // somebody else got there first. Which one it says is this flag, not a guess from the status.
      accepted: outcome.changed,
    });
  }),
);

export default router;
