// server/src/routes/riderApp.ts — milestone 21, from project/Rider.dc.html.
//
//   GET  /api/stores/:storeId/rider                     the whole app's first paint: profile, jobs, cash held
//   PUT  /api/stores/:storeId/rider/availability          the "Available / Off duty" switch
//   POST /api/stores/:storeId/rider/orders/:orderId/picked-up    assigned -> out (reuses orders.ts, V022)
//   POST /api/stores/:storeId/rider/orders/:orderId/delivered     out -> delivered (reuses orders.ts)
//   POST /api/stores/:storeId/rider/orders/:orderId/confirm-cash   records what was collected (reuses orders.ts)
//   POST /api/stores/:storeId/rider/orders/:orderId/returned       the transition V022 deferred to this milestone
//
// EVERY ORDER ROUTE CHECKS OWNERSHIP, EXPLICITLY, BEFORE DOING ANYTHING ELSE. `deliveries.own_update`
// is the permission a rider holds (V001) — "the scoping to 'own' is enforced by the query, not by the
// permission, because a permission cannot express a row filter" (V007's own comment on that row). The
// SQL functions this file calls (`mark_picked_up`, `mark_delivered`, `confirm_cash_payment`) do not
// check who the actor is — milestone 20 built them to be called by a manager on a rider's behalf just
// as much as by the rider themselves — so this file is where "only YOUR OWN delivery" actually holds.
// `riders.isOwnJob()` is that check, and it returns 404 rather than 403 on a miss: a rider asking
// about an order that is not theirs should see exactly what they would see for an order that does not
// exist, the same reasoning accept() (V021) and every Orders-board route since have followed for a
// cross-store order id.

import { Router } from 'express';
import type { Request } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { authOf, isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { bodyOf, requiredString } from '../api/validate.ts';
import { badRequest, conflict, notFound, withTransaction } from '../db/index.ts';
import * as orders from '../repositories/orders.ts';
import * as riders from '../repositories/riders.ts';
import * as themes from '../repositories/themes.ts';

const router = Router({ mergeParams: true });

function orderIdOf(req: Request): string {
  const orderId = req.params['orderId'];
  if (!isUuid(orderId)) throw badRequest('That is not an order.', 'INVALID_ORDER');
  return orderId;
}

router.get(
  '/',
  requireStorePermission('deliveries.own_read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);

    const profile = await riders.myProfile(storeId, context.userId);
    if (profile === null) throw notFound('You are not a rider at this store.', 'NOT_A_RIDER');

    const [jobs, cashHeld, currency] = await Promise.all([
      riders.myJobs(storeId, context.userId),
      riders.cashHeld(storeId, context.userId),
      themes.findCurrencyByStoreId(storeId),
    ]);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      storeName: profile.storeName,
      currency,
      me: { name: context.name, phone: context.phone, plateNumber: profile.plateNumber },
      availability: profile.availability,
      cashHeld,
      jobs,
    });
  }),
);

router.put(
  '/availability',
  requireStorePermission('deliveries.own_update'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const body = bodyOf(req.body);
    const available = body['available'];
    if (typeof available !== 'boolean') throw badRequest('Say whether you are available.', 'MISSING_FIELD');

    const ok = await withTransaction((tx) => riders.setAvailability(storeId, context.userId, available, tx));
    if (!ok) throw notFound('You are not a rider at this store.', 'NOT_A_RIDER');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ availability: available ? 'available' : 'off_duty' });
  }),
);

/** The ownership check every order route below shares, before touching the order at all. */
async function requireOwnJob(storeId: string, orderId: string, riderId: string): Promise<void> {
  if (!(await riders.isOwnJob(storeId, orderId, riderId))) {
    throw notFound('That is not one of your deliveries.', 'NOT_YOUR_JOB');
  }
}

router.post(
  '/orders/:orderId/picked-up',
  requireStorePermission('deliveries.own_update'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const orderId = orderIdOf(req);
    await requireOwnJob(storeId, orderId, context.userId);

    const outcome = await withTransaction((tx) =>
      orders.markPickedUp(storeId, orderId, { userId: context.userId, role: context.storeRole }, tx),
    );
    if (outcome === null) throw notFound('That order is not here.', 'NO_SUCH_ORDER');
    if (!outcome) throw conflict('That order has not been assigned to you.', 'ORDER_ALREADY_MOVED');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, status: 'out' });
  }),
);

router.post(
  '/orders/:orderId/delivered',
  requireStorePermission('deliveries.own_update'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const orderId = orderIdOf(req);
    await requireOwnJob(storeId, orderId, context.userId);

    const outcome = await withTransaction((tx) =>
      orders.markDelivered(storeId, orderId, { userId: context.userId, role: context.storeRole }, tx),
    );
    if (outcome === null) throw notFound('That order is not here.', 'NO_SUCH_ORDER');
    if (!outcome) throw conflict('That order is not out for delivery.', 'ORDER_ALREADY_MOVED');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, status: 'delivered' });
  }),
);

router.post(
  '/orders/:orderId/confirm-cash',
  requireStorePermission('deliveries.own_update'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const orderId = orderIdOf(req);
    await requireOwnJob(storeId, orderId, context.userId);

    const body = bodyOf(req.body);
    const reportedAmount = requiredString(body, 'reportedAmount');

    const confirmed = await withTransaction((tx) =>
      orders.confirmCash(orderId, reportedAmount, { userId: context.userId, role: context.storeRole }, tx),
    );

    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: confirmed });
  }),
);

router.post(
  '/orders/:orderId/returned',
  requireStorePermission('deliveries.own_update'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const orderId = orderIdOf(req);
    await requireOwnJob(storeId, orderId, context.userId);

    const body = bodyOf(req.body);
    const reason = requiredString(body, 'reason');

    const outcome = await withTransaction((tx) =>
      riders.markReturned(storeId, orderId, { userId: context.userId, role: context.storeRole }, reason, null, tx),
    );
    if (outcome === null) throw notFound('That order is not here.', 'NO_SUCH_ORDER');
    if (!outcome) throw conflict('That order is not out for delivery.', 'ORDER_ALREADY_MOVED');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, status: 'returned' });
  }),
);

export default router;
