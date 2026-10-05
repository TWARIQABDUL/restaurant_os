// server/src/routes/storeAnalytics.ts — milestone 24.
//
//   GET /api/stores/:storeId/analytics/:tab?range=7|14|30        summary | orders | revenue | items | payments | delivery
//   GET /api/stores/:storeId/analytics/:tab/export?range=…       the same figures as CSV
//
// GUARDED BY wallet.read, which is nav.ts's own note — "Analytics is revenue over time, so it asks the same question Money
// does" — and is why a manager, who can answer a customer, still cannot read the store's takings.
//
// ONE TAB PER REQUEST. The board shows one at a time and each is its own set of aggregates; a single endpoint returning
// all six would pay for five the merchant did not ask for.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { csvTable } from '../api/csv.ts';
import { badRequest, notFound } from '../db/index.ts';
import * as analytics from '../repositories/analytics.ts';
import type { Bounds, RangeDays } from '../repositories/analytics.ts';

const router = Router({ mergeParams: true });

const TABS = ['summary', 'orders', 'revenue', 'items', 'payments', 'delivery'] as const;
type Tab = (typeof TABS)[number];

function parse(req: { params: Record<string, string | undefined>; query: Record<string, unknown> }): { tab: Tab; days: RangeDays } {
  const tab = TABS.find((t) => t === req.params['tab']);
  if (tab === undefined) throw badRequest(`tab must be one of: ${TABS.join(', ')}.`, 'INVALID_TAB');
  const days = Number(req.query['range'] ?? 14) as RangeDays;
  if (!analytics.RANGES.includes(days)) throw badRequest('range must be 7, 14 or 30.', 'INVALID_RANGE');
  return { tab, days };
}

async function compute(storeId: string, tab: Tab, days: RangeDays): Promise<{ b: Bounds; data: unknown }> {
  const b = await analytics.bounds(storeId, days);
  if (b === null) throw notFound('That store does not exist.');
  switch (tab) {
    case 'summary':
    case 'revenue':
      return { b, data: await analytics.revenue(storeId, days, b) };
    case 'orders':
      return { b, data: await analytics.orders(storeId, days, b) };
    case 'items':
      return { b, data: await analytics.items(storeId, b) };
    case 'payments':
      return { b, data: await analytics.payments(storeId, b) };
    case 'delivery':
      return { b, data: await analytics.delivery(storeId, b) };
  }
}

router.get(
  '/:tab',
  requireStorePermission('wallet.read'),
  asyncHandler(async (req, res) => {
    const { tab, days } = parse(req);
    const { b, data } = await compute(storeIdOf(req), tab, days);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ tab, range: days, from: b.curStart, to: b.today, data });
  }),
);

router.get(
  '/:tab/export',
  requireStorePermission('wallet.read'),
  asyncHandler(async (req, res) => {
    const { tab, days } = parse(req);
    const { data } = await compute(storeIdOf(req), tab, days);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="analytics-${tab}-${days}d.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(toCsv(tab, data));
  }),
);

/** Each tab's table, as the board's own columns. */
function toCsv(tab: Tab, data: unknown): string {
  if (tab === 'summary' || tab === 'revenue') {
    const d = data as analytics.RevenueData;
    return csvTable(
      ['Date', ...d.methods.map((m) => m.name), 'Total'],
      d.dates.map((day) => {
        const per = d.methods.map((m) => d.byDay[day]?.[m.key] ?? '0');
        return [day, ...per, per.reduce((a, c) => a + Number(c), 0).toFixed(2)];
      }),
    );
  }
  if (tab === 'orders') {
    const d = data as analytics.OrdersData;
    return csvTable(['Date', 'Orders'], d.dates.map((day) => [day, d.perDay[day] ?? 0]));
  }
  if (tab === 'items') {
    const d = data as analytics.ItemsData;
    return csvTable(['Item', 'Sold', 'Revenue'], d.items.map((i) => [i.name, i.sold, i.revenue]));
  }
  if (tab === 'payments') {
    const d = data as analytics.PaymentsData;
    return csvTable(['Method', 'Orders', 'Revenue', 'Success rate %'], d.methods.map((m) => [m.name, m.orders, m.revenue, m.successRate]));
  }
  const d = data as analytics.DeliveryData;
  return csvTable(['Rider', 'Deliveries', 'Average minutes', 'On time %'], d.riders.map((r) => [r.name, r.deliveries, r.avgMinutes, r.onTimeShare]));
}

export default router;
