// server/src/routes/storeDashboard.ts — milestone 19.
//
// GET /api/stores/:storeId/dashboard            every figure on `Dashboard` and `DashboardMobile`
// PUT /api/stores/:storeId/dashboard/accepting   "Pause new orders" / start again
//
// ONE REQUEST FOR THE WHOLE SCREEN. The dashboard draws four cards, a comparison, a week of bars, a queue and a
// table; as separate endpoints that is six round trips before a merchant sees anything, on a connection where
// each one costs. They are one payload because they are one screen.
//
// THE MONEY IS PERMISSIONED AND THE COUNTS ARE NOT. §5.4 refused a manager at /wallet because "a component asks
// whether a role may do something; it never contains the list" — and revenue is the same question. A manager
// gets the order queue and the low-stock count they act on; `sales` is present only for a role holding
// `wallet.read`, which today is owner and admin. The screen renders what it was given rather than asking.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { authOf, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { bodyOf } from '../api/validate.ts';
import { badRequest, readConsistent } from '../db/index.ts';
import * as dashboard from '../repositories/dashboard.ts';
import * as notifications from '../repositories/notifications.ts';

const router = Router({ mergeParams: true });

router.get(
  '/',
  requireStorePermission('orders.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const maySeeMoney = context.permissions.includes('wallet.read');

    // ONE CONSISTENT READ. Without it the "orders today" card and the "needs your attention" queue can be taken
    // from either side of an order arriving, and a merchant sees 24 orders with 4 waiting listed under a card
    // that says 3.
    const view = await readConsistent(async (tx) => {
      const counts = await dashboard.counts(storeId, tx);
      const money = maySeeMoney ? await dashboard.money(storeId, tx) : null;
      const week = maySeeMoney ? await dashboard.week(storeId, tx) : null;
      const attention = await dashboard.needsAttention(storeId, 5, tx);
      const recent = await dashboard.recent(storeId, 8, tx);
      const lowest = await dashboard.lowestStock(storeId, tx);
      const unread = await notifications.unreadCount(context.userId, storeId, tx);
      return { counts, money, week, attention, recent, lowest, unread };
    }, 'GET /api/stores/:storeId/dashboard');

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      // The greeting needs a name and the sidebar needs a role; both are already on the request's auth context,
      // so the screen does not fetch them separately.
      me: { name: context.name, role: context.storeRole },
      counts: view.counts,
      sales: view.money,
      week: view.week,
      needsAttention: view.attention,
      recent: view.recent,
      lowestStock: view.lowest,
      unreadNotifications: view.unread,
    });
  }),
);

/**
 * "Pause new orders".
 *
 * `orders.update` RATHER THAN `settings.write`, which is the interesting choice: pausing is what somebody does
 * when the kitchen is overwhelmed, and the person standing in the kitchen is the manager. Settings is where a
 * store's configuration lives and a pause is not configuration — it is an operational decision that gets
 * reversed twenty minutes later.
 */
router.put(
  '/accepting',
  requireStorePermission('orders.update'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const body = bodyOf(req.body);
    const accepting = body['accepting'];
    if (typeof accepting !== 'boolean') {
      throw badRequest('Say whether the store is taking orders.', 'MISSING_FIELD');
    }

    const now = await dashboard.setAcceptingOrders(storeId, accepting);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ acceptingOrders: now });
  }),
);

export default router;
