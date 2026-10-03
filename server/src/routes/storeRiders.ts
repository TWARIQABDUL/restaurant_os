// server/src/routes/storeRiders.ts — milestone 21, from project/CashReport.dc.html.
//
//   GET  /api/stores/:storeId/riders                           "Right now" — the on-duty roster
//   GET  /api/stores/:storeId/riders/cash-report                "Close the day" cards + carried-over debts
//   POST /api/stores/:storeId/riders/:riderId/handover           a hand-in, mid-shift
//   POST /api/stores/:storeId/riders/:riderId/close-day           closes one rider's day
//   POST /api/stores/:storeId/riders/settlements/:settlementId/receive   marks a carried-over debt received
//
// GATED BY `orders.assign_rider`, THE SAME PERMISSION THE ORDERS BOARD'S RIDER PICKER ASKS FOR — not a
// new one. nav.ts already drew this line at milestone 19, gating the sidebar's "Riders & cash" item on
// it: a role that can hand an order to a rider is a role that can account for what the rider is
// carrying, and a role that cannot (a manager without it, store-dependent) sees neither.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { authOf, isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { bodyOf, optionalString, requiredOneOf, requiredString } from '../api/validate.ts';
import { badRequest, conflict, notFound, withTransaction } from '../db/index.ts';
import * as riders from '../repositories/riders.ts';

const router = Router({ mergeParams: true });

const GAP_RESOLUTIONS = ['carry_over', 'discount', 'write_off'] as const;

/** A decimal money string — the same shape storeOrders.ts's own requiredMoney() validates. */
const MONEY_SHAPE = /^\d+(\.\d{1,2})?$/;

function requiredMoney(body: ReturnType<typeof bodyOf>, field: string): string {
  const raw = requiredString(body, field);
  if (!MONEY_SHAPE.test(raw) || Number(raw) <= 0) {
    throw badRequest(`${field} must be a positive amount.`, 'INVALID_AMOUNT');
  }
  return raw;
}

/**
 * The same shape, but zero is a real answer here — a rider closing with nothing left to count, because
 * everything already went in through a hand-over earlier, is a balanced day, not a missing field.
 */
function requiredMoneyOrZero(body: ReturnType<typeof bodyOf>, field: string): string {
  const raw = requiredString(body, field);
  if (!MONEY_SHAPE.test(raw) || Number(raw) < 0) {
    throw badRequest(`${field} must be a non-negative amount.`, 'INVALID_AMOUNT');
  }
  return raw;
}

router.get(
  '/',
  requireStorePermission('orders.assign_rider'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ roster: await riders.roster(storeId) });
  }),
);

router.get(
  '/cash-report',
  requireStorePermission('orders.assign_rider'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const [cards, carriedOver] = await Promise.all([riders.cashReportDay(storeId), riders.carriedOver(storeId)]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ cards, carriedOver });
  }),
);

router.post(
  '/:riderId/handover',
  requireStorePermission('orders.assign_rider'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const riderId = req.params['riderId'];
    if (!isUuid(riderId)) throw badRequest('That is not a rider.', 'INVALID_RIDER');

    const body = bodyOf(req.body);
    const amount = requiredMoney(body, 'amount');
    const note = optionalString(body, 'note');

    const id = await withTransaction((tx) =>
      riders.recordHandover(storeId, riderId, { userId: context.userId, role: context.storeRole }, amount, note, tx),
    );

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ handoverId: id });
  }),
);

router.post(
  '/:riderId/close-day',
  requireStorePermission('orders.assign_rider'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const riderId = req.params['riderId'];
    if (!isUuid(riderId)) throw badRequest('That is not a rider.', 'INVALID_RIDER');

    const body = bodyOf(req.body);
    const counted = requiredMoneyOrZero(body, 'counted');
    const resolutionRaw = optionalString(body, 'resolution');
    const resolution = resolutionRaw === null ? null : requiredOneOf({ resolution: resolutionRaw }, 'resolution', GAP_RESOLUTIONS);
    const gapOrderId = optionalString(body, 'gapOrderId');
    if (gapOrderId !== null && !isUuid(gapOrderId)) throw badRequest('That is not an order.', 'INVALID_ORDER');
    const gapNote = optionalString(body, 'gapNote');

    if (resolution === 'discount' && (gapOrderId === null || gapNote === null)) {
      throw badRequest('A discount needs the order and a note.', 'MISSING_FIELD');
    }

    const id = await withTransaction((tx) =>
      riders.closeDay(
        storeId,
        riderId,
        { userId: context.userId, role: context.storeRole },
        counted,
        resolution,
        gapOrderId,
        gapNote,
        tx,
      ),
    );
    if (id === null) {
      throw conflict(
        'That day is either already closed, or short and waiting for you to choose what happens to the gap.',
        'CANNOT_CLOSE',
      );
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ settlementId: id });
  }),
);

router.post(
  '/settlements/:settlementId/receive',
  requireStorePermission('orders.assign_rider'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const settlementId = req.params['settlementId'];
    if (!isUuid(settlementId)) throw badRequest('That is not a settlement.', 'INVALID_SETTLEMENT');

    const ok = await withTransaction((tx) =>
      riders.receiveCarriedOver(storeId, settlementId, { userId: context.userId, role: context.storeRole }, tx),
    );
    if (!ok) throw notFound('That carried-over amount is not waiting to be received.', 'NOT_OUTSTANDING');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  }),
);

export default router;
