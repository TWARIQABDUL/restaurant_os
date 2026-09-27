// server/src/routes/storeOrders.ts — milestone 19 (accept), extended at milestone 20.
//
//   GET  /api/stores/:storeId/orders                       the board + list, open orders plus today's closed ones
//   GET  /api/stores/:storeId/orders/riders                 who can be assigned, for the picker
//   GET  /api/stores/:storeId/orders/:orderId                one order, everything the drawer draws
//   POST /api/stores/:storeId/orders/:orderId/accept         pending -> approved (milestone 19)
//   POST /api/stores/:storeId/orders/:orderId/decline         pending -> rejected, with a reason
//   POST /api/stores/:storeId/orders/:orderId/cancel          approved/preparing/ready/assigned -> cancelled, with a reason
//   POST /api/stores/:storeId/orders/:orderId/start-preparing  approved -> preparing
//   POST /api/stores/:storeId/orders/:orderId/ready            preparing -> ready
//   POST /api/stores/:storeId/orders/:orderId/assign-rider     ready/assigned -> assigned
//   POST /api/stores/:storeId/orders/:orderId/picked-up        assigned -> out
//   POST /api/stores/:storeId/orders/:orderId/delivered        out -> delivered
//   POST /api/stores/:storeId/orders/:orderId/collected        ready -> collected (pickup)
//   POST /api/stores/:storeId/orders/:orderId/confirm-cash      records what a rider handed over
//   POST /api/stores/:storeId/orders/:orderId/close-return      returned -> closed_return
//   POST /api/stores/:storeId/orders/:orderId/retry-delivery    returned -> ready
//   POST /api/stores/:storeId/orders/:orderId/request-refund    a refund with no complaint behind it
//
// EVERY TRANSITION ANSWERS THE SAME SHAPE: `{ ok, status }` on success, and a 409 naming what the order
// actually is when somebody else decided it first — not a different shape per route, because the client's
// mutation handling is one function (`client/src/console/Orders.tsx`'s `act()`), not thirteen.
//
// A FUNCTION RETURNING false OR null IS NOT A THROW, deliberately, for the same reason accept() (milestone 19)
// isn't: `repositories/orders.ts`'s functions lock the row, check the precursor status, and hand back a plain
// boolean — "somebody already did this" is a fact the route reads and reports, not an exception to catch.

import { Router } from 'express';
import type { Request } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { authOf, isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { bodyOf, optionalString, requiredOneOf, requiredString } from '../api/validate.ts';
import { AppError, badRequest, conflict, notFound, withTransaction } from '../db/index.ts';
import type { Tx } from '../db/index.ts';
import * as orders from '../repositories/orders.ts';

const router = Router({ mergeParams: true });

/** The two that mean somebody decided the other way. Everything from `approved` on means it was accepted. */
const DECIDED_AGAINST = new Set(['rejected', 'cancelled']);

const REFUND_REASONS = ['item_missing', 'wrong_item', 'quality_problem', 'arrived_late', 'other'] as const;

/** A decimal money string, the same shape every numeric column in this schema takes as text. */
const MONEY_SHAPE = /^\d+(\.\d{1,2})?$/;

function requiredMoney(body: ReturnType<typeof bodyOf>, field: string): string {
  const raw = requiredString(body, field);
  if (!MONEY_SHAPE.test(raw) || Number(raw) <= 0) {
    throw badRequest(`${field} must be a positive amount.`, 'INVALID_AMOUNT');
  }
  return raw;
}

function orderIdOf(req: Request): string {
  const orderId = req.params['orderId'];
  if (!isUuid(orderId)) throw badRequest('That is not an order.', 'INVALID_ORDER');
  return orderId;
}

router.get(
  '/',
  requireStorePermission('orders.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const list = await orders.list(storeId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ orders: list });
  }),
);

router.get(
  '/riders',
  requireStorePermission('orders.assign_rider'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const riders = await orders.availableRiders(storeId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ riders });
  }),
);

router.get(
  '/:orderId',
  requireStorePermission('orders.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const orderId = orderIdOf(req);
    const order = await orders.get(storeId, orderId);
    if (order === null) throw notFound('That order is not here.', 'NO_SUCH_ORDER');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ order });
  }),
);

router.post(
  '/:orderId/accept',
  requireStorePermission('orders.update'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const orderId = orderIdOf(req);

    const outcome = await withTransaction((tx) =>
      orders.accept(storeId, orderId, { userId: context.userId, role: context.storeRole }, tx),
    );

    if (outcome === null) throw notFound('That order is not here.', 'NO_SUCH_ORDER');

    if (DECIDED_AGAINST.has(outcome.status)) {
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
      accepted: outcome.changed,
    });
  }),
);

/**
 * A transition route that shares one shape: lock, check, act. `run` is the repository call; `already` is what
 * to say when it returns false, because "already ready" and "already declined" are different sentences for the
 * same false.
 */
function transition(
  path: string,
  permission: string,
  run: (
    storeId: string,
    orderId: string,
    actor: orders.Actor,
    tx: Tx,
    req: Request,
  ) => Promise<boolean | null>,
  already: string,
): void {
  router.post(
    path,
    requireStorePermission(permission),
    asyncHandler(async (req, res) => {
      const storeId = storeIdOf(req);
      const { context } = authOf(req);
      const orderId = orderIdOf(req);
      const actor: orders.Actor = { userId: context.userId, role: context.storeRole };

      const outcome = await withTransaction((tx) => run(storeId, orderId, actor, tx, req));
      if (outcome === null) throw notFound('That order is not here.', 'NO_SUCH_ORDER');
      if (!outcome) throw conflict(already, 'ORDER_ALREADY_MOVED');

      const current = await orders.get(storeId, orderId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, status: current?.status ?? null });
    }),
  );
}

transition(
  '/:orderId/decline',
  'orders.update',
  (storeId, orderId, actor, tx, req) => {
    const body = bodyOf(req.body);
    const reason = requiredString(body, 'reason');
    const note = optionalString(body, 'note');
    return orders.decline(storeId, orderId, actor, reason, note, tx);
  },
  'That order was already decided.',
);

transition(
  '/:orderId/cancel',
  'orders.update',
  (storeId, orderId, actor, tx, req) => {
    const body = bodyOf(req.body);
    const reason = requiredString(body, 'reason');
    const note = optionalString(body, 'note');
    return orders.cancel(storeId, orderId, actor, reason, note, tx);
  },
  'That order can no longer be cancelled.',
);

transition(
  '/:orderId/start-preparing',
  'orders.update',
  (storeId, orderId, actor, tx) => orders.startPreparing(storeId, orderId, actor, tx),
  'That order is not waiting to be started.',
);

transition(
  '/:orderId/ready',
  'orders.update',
  (storeId, orderId, actor, tx) => orders.markReady(storeId, orderId, actor, tx),
  'That order is not being prepared.',
);

transition(
  '/:orderId/picked-up',
  'orders.update',
  (storeId, orderId, actor, tx) => orders.markPickedUp(storeId, orderId, actor, tx),
  'That order has not been assigned to a rider.',
);

transition(
  '/:orderId/delivered',
  'orders.update',
  (storeId, orderId, actor, tx) => orders.markDelivered(storeId, orderId, actor, tx),
  'That order is not out for delivery.',
);

transition(
  '/:orderId/collected',
  'orders.update',
  (storeId, orderId, actor, tx) => orders.markCollected(storeId, orderId, actor, tx),
  'That order is not ready for collection.',
);

transition(
  '/:orderId/retry-delivery',
  'orders.assign_rider',
  (storeId, orderId, actor, tx) => orders.retryDelivery(storeId, orderId, actor, tx),
  'That order is not a return waiting to be retried.',
);

transition(
  '/:orderId/close-return',
  'orders.update',
  (storeId, orderId, actor, tx, req) => {
    const body = bodyOf(req.body);
    const restock = body['restock'];
    if (typeof restock !== 'boolean') throw badRequest('Say whether the items go back into stock.', 'MISSING_FIELD');
    return orders.closeReturn(storeId, orderId, actor, restock, tx);
  },
  'That order is not a return waiting to be closed.',
);

/** Rider assignment names WHO, so it is its own route rather than `transition()`'s fixed message. */
router.post(
  '/:orderId/assign-rider',
  requireStorePermission('orders.assign_rider'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const orderId = orderIdOf(req);
    const body = bodyOf(req.body);
    const riderUserId = requiredString(body, 'riderUserId');
    if (!isUuid(riderUserId)) throw badRequest('That is not a rider.', 'INVALID_RIDER');

    const outcome = await withTransaction((tx) =>
      orders.assignRider(storeId, orderId, { userId: context.userId, role: context.storeRole }, riderUserId, tx),
    );
    if (outcome === null) throw notFound('That order is not here.', 'NO_SUCH_ORDER');
    if (!outcome) throw conflict('That order cannot take a rider right now.', 'ORDER_ALREADY_MOVED');

    const current = await orders.get(storeId, orderId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, status: current?.status ?? null, riderName: current?.riderName ?? null });
  }),
);

/**
 * Confirming cash is not a status change — `confirm_cash_payment()` (V005) answers false when there is
 * nothing unconfirmed to confirm, which is not this order's fault, so it is reported rather than 409'd.
 */
router.post(
  '/:orderId/confirm-cash',
  requireStorePermission('orders.update'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const orderId = orderIdOf(req);
    const body = bodyOf(req.body);
    const reportedAmount = requiredMoney(body, 'reportedAmount');

    const confirmed = await withTransaction((tx) =>
      orders.confirmCash(orderId, reportedAmount, { userId: context.userId, role: context.storeRole }, tx),
    );

    const current = await orders.get(storeId, orderId);
    if (current === null) throw notFound('That order is not here.', 'NO_SUCH_ORDER');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: confirmed, status: current.status });
  }),
);

/** A refund straight from the order, with no complaint behind it. Stays pending for Vendlyfy to decide. */
router.post(
  '/:orderId/request-refund',
  requireStorePermission('orders.update'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const orderId = orderIdOf(req);
    const body = bodyOf(req.body);
    const amount = requiredMoney(body, 'amount');
    const reasonCode = requiredOneOf(body, 'reasonCode', REFUND_REASONS);
    const reasonNote = optionalString(body, 'reasonNote');
    if (reasonCode === 'other' && (reasonNote === null || reasonNote === '')) {
      throw badRequest('Say what happened.', 'MISSING_REASON_NOTE');
    }

    const refundId = await withTransaction((tx) =>
      orders.requestRefund(
        storeId,
        orderId,
        { userId: context.userId, role: context.storeRole },
        amount,
        reasonCode,
        reasonNote,
        tx,
      ),
    );
    if (refundId === null) {
      throw conflict('That order cannot be refunded right now.', 'REFUND_NOT_ALLOWED');
    }

    res.setHeader('Cache-Control', 'no-store');
    // The order's own status does not move here — a refund request is reviewed, not settled — so what the
    // client gets back is the REFUND's state, not the order's.
    res.status(201).json({ refundId, refundStatus: 'pending' });
  }),
);

export default router;
