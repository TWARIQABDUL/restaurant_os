// server/src/repositories/analytics.ts — milestone 24, from project/Analytics.dc.html.
//
// SIX TABS, SIX READS, ONE DEFINITION OF "A DAY". Every figure here is bucketed by the STORE's own calendar day
// (V021's `store_local()`), the same boundary the dashboard and Riders & cash use, so "today" on three screens is one
// thing. A store in Kigali and a store in Lagos see their own midnight, and a sale at 23:30 is today's.
//
// A PERIOD IS COMPARED TO THE ONE BEFORE IT, same length: "+12% vs previous 14 days" is this fortnight against the
// fortnight before it, both ending on a day boundary, so a half-finished day cannot make a good week read as a bad
// one against a complete one. (Today is partial in both views and the board says so under the chart.)
//
// WHAT "REVENUE" IS. An order counts on the day it was PAID — online at the moment MoMo confirms, cash at the moment
// the merchant confirms it ("Cash counts once it's confirmed on the order", the board's own note) — and at its
// TOTAL, refunds shown separately rather than netted. That is the one figure that agrees with Money's Activity.
//
// WHAT THIS DOES NOT INVENT. The board's "Ran out most: Fries · 5 times this period" needs a history of stock-outs
// that nothing records — a variant at 0 is a state, not an event. It is replaced by what IS known: how many tracked
// products are out of stock now. And "on time" has no per-order promise to be measured against (an order does not
// remember which delivery zone priced it), so it is measured against the store's slowest zone's ETA — said on the
// tab, because a number with an invisible definition is the one a merchant argues with.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';

export type RangeDays = 7 | 14 | 30;
export const RANGES: readonly RangeDays[] = [7, 14, 30];

export type Bounds = {
  /** The store's local dates, as 'YYYY-MM-DD'. */
  today: string;
  curStart: string;
  prevStart: string;
  /** The instants those midnights are, in the store's zone. */
  curStartAt: Date;
  prevStartAt: Date;
};

export async function bounds(storeId: string, days: RangeDays, on: Queryable = db): Promise<Bounds | null> {
  const { rows } = await on.query<{ today: string; cur: string; prev: string; cur_at: Date; prev_at: Date }>(
    `WITH z AS (SELECT time_zone, (store_local(id, now()))::date AS today FROM stores WHERE id = $1)
     SELECT today::text AS today,
            (today - ($2::int - 1))::text AS cur,
            (today - (2 * $2::int - 1))::text AS prev,
            ((today - ($2::int - 1))::timestamp AT TIME ZONE time_zone) AS cur_at,
            ((today - (2 * $2::int - 1))::timestamp AT TIME ZONE time_zone) AS prev_at
       FROM z`,
    [storeId, days],
  );
  const r = rows[0];
  return r === undefined ? null : { today: r.today, curStart: r.cur, prevStart: r.prev, curStartAt: r.cur_at, prevStartAt: r.prev_at };
}

/** The dates of the current period, oldest first. */
export function datesOf(b: Bounds, days: number): string[] {
  const out: string[] = [];
  const start = new Date(`${b.curStart}T00:00:00Z`);
  for (let i = 0; i < days; i += 1) out.push(new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

export type PaymentMethodInfo = { key: string; name: string; kind: 'online' | 'offline' };

async function methods(on: Queryable): Promise<PaymentMethodInfo[]> {
  const { rows } = await on.query<{ key: string; name: string; kind: 'online' | 'offline' }>(`SELECT key, name, kind FROM payment_methods ORDER BY position`);
  return rows.map((r) => ({ key: r.key, name: r.name, kind: r.kind }));
}

// ---------------------------------------------------------------------------
// Summary + Revenue
// ---------------------------------------------------------------------------

export type RevenueData = {
  dates: string[];
  methods: PaymentMethodInfo[];
  /** Per date, per method key: amount as a decimal string. */
  byDay: Record<string, Record<string, string>>;
  revenue: string;
  previousRevenue: string;
  orders: number;
  previousOrders: number;
  refunded: string;
  /** Wallet figures, as of now rather than the period. */
  pendingNow: string;
  paidOut: string;
  automaticPayouts: number;
  /** Orders in the period placed by somebody who had ordered here before. */
  repeatShare: number | null;
};

export async function revenue(storeId: string, days: RangeDays, b: Bounds, on: Queryable = db): Promise<RevenueData> {
  const paid = await on.query<{ day: string; method: string; amount: string }>(
    `SELECT store_local($1, o.paid_at)::date::text AS day, o.payment_method AS method, sum(o.total_amount)::text AS amount
       FROM orders o
      WHERE o.store_id = $1 AND o.paid_at >= $2 AND o.payment_status IN ('paid', 'refunded')
      GROUP BY 1, 2`,
    [storeId, b.prevStartAt],
  );

  const byDay: Record<string, Record<string, string>> = {};
  let rev = 0n;
  let prev = 0n;
  const toMinor = (s: string): bigint => BigInt(Math.round(Number(s) * 100));
  const dates = datesOf(b, days);
  const inRange = new Set(dates);
  for (const r of paid.rows) {
    if (inRange.has(r.day)) {
      (byDay[r.day] ??= {})[r.method] = r.amount;
      rev += toMinor(r.amount);
    } else {
      prev += toMinor(r.amount);
    }
  }

  const counts = await on.query<{ cur: string; prev: string }>(
    `SELECT (count(*) FILTER (WHERE placed_at >= $3))::text AS cur, (count(*) FILTER (WHERE placed_at < $3))::text AS prev
       FROM orders WHERE store_id = $1 AND placed_at >= $2 AND status NOT IN ('rejected', 'cancelled')`,
    [storeId, b.prevStartAt, b.curStartAt],
  );

  // REPEAT CUSTOMERS, in one pass: each customer's FIRST order, then the period's orders placed after it. The
  // first version asked "has this person ordered before" per order with a correlated EXISTS over the store's
  // whole history — quadratic, and it hit the statement timeout on a 20,000-order store.
  const repeat = await on.query<{ total: string; again: string }>(
    `WITH keyed AS (
       SELECT o.placed_at, COALESCE(customer_key(u.phone), customer_key(o.guest_phone),
                                    CASE WHEN o.customer_user_id IS NOT NULL THEN 'u:' || o.customer_user_id::text END) AS k
         FROM orders o LEFT JOIN users u ON u.id = o.customer_user_id
        WHERE o.store_id = $1 AND o.status NOT IN ('rejected', 'cancelled')
     ), firsts AS (SELECT k, min(placed_at) AS first_at FROM keyed WHERE k IS NOT NULL GROUP BY k)
     SELECT (count(*) FILTER (WHERE x.placed_at >= $2))::text AS total,
            (count(*) FILTER (WHERE x.placed_at >= $2 AND x.placed_at > f.first_at))::text AS again
       FROM keyed x JOIN firsts f ON f.k = x.k`,
    [storeId, b.curStartAt],
  );

  const refunds = await on.query<{ amount: string }>(
    `SELECT COALESCE(sum(f.approved_amount), 0)::numeric(12,2)::text AS amount FROM refunds f
      WHERE f.store_id = $1 AND f.status = 'approved' AND f.settled_at >= $2`,
    [storeId, b.curStartAt],
  );
  const wallet = await on.query<{ pending: string }>(`SELECT pending_balance::text AS pending FROM wallets WHERE store_id = $1`, [storeId]);
  const payouts = await on.query<{ amount: string; auto: string }>(
    `SELECT COALESCE(sum(amount), 0)::numeric(12,2)::text AS amount, (count(*) FILTER (WHERE initiated_by = 'automatic'))::text AS auto
       FROM withdrawals WHERE store_id = $1 AND status = 'completed' AND completed_at >= $2`,
    [storeId, b.curStartAt],
  );

  const c = counts.rows[0]!;
  return {
    dates,
    methods: await methods(on),
    byDay,
    revenue: (Number(rev) / 100).toFixed(2),
    previousRevenue: (Number(prev) / 100).toFixed(2),
    orders: Number(c.cur),
    previousOrders: Number(c.prev),
    refunded: refunds.rows[0]!.amount,
    pendingNow: wallet.rows[0]?.pending ?? '0.00',
    paidOut: payouts.rows[0]!.amount,
    automaticPayouts: Number(payouts.rows[0]!.auto),
    repeatShare: Number(repeat.rows[0]!.total) === 0 ? null : Math.round((100 * Number(repeat.rows[0]!.again)) / Number(repeat.rows[0]!.total)),
  };
}

// ---------------------------------------------------------------------------
// Orders over time
// ---------------------------------------------------------------------------

export type OrdersData = {
  dates: string[];
  perDay: Record<string, number>;
  total: number;
  previousTotal: number;
  deliveryShare: number | null;
  /** Orders the store declined or cancelled in the period, and the commonest reason given. */
  turnedAway: number;
  topReason: string | null;
  /** Median minutes from the order arriving to the merchant accepting it. */
  acceptMinutes: number | null;
  busiestHour: number | null;
};

export async function orders(storeId: string, days: RangeDays, b: Bounds, on: Queryable = db): Promise<OrdersData> {
  const perDay = await on.query<{ day: string; n: string }>(
    `SELECT store_local($1, placed_at)::date::text AS day, count(*)::text AS n
       FROM orders WHERE store_id = $1 AND placed_at >= $2 AND status NOT IN ('rejected', 'cancelled')
      GROUP BY 1`,
    [storeId, b.curStartAt],
  );
  const totals = await on.query<{ cur: string; prev: string; delivery: string | null; away: string; busiest: string | null }>(
    `SELECT (count(*) FILTER (WHERE placed_at >= $3 AND status NOT IN ('rejected', 'cancelled')))::text AS cur,
            (count(*) FILTER (WHERE placed_at <  $3 AND status NOT IN ('rejected', 'cancelled')))::text AS prev,
            CASE WHEN count(*) FILTER (WHERE placed_at >= $3 AND status NOT IN ('rejected', 'cancelled')) = 0 THEN NULL
                 ELSE round(100.0 * count(*) FILTER (WHERE placed_at >= $3 AND status NOT IN ('rejected', 'cancelled') AND fulfilment_type = 'delivery')
                       / count(*) FILTER (WHERE placed_at >= $3 AND status NOT IN ('rejected', 'cancelled')))::text END AS delivery,
            (count(*) FILTER (WHERE placed_at >= $3 AND status IN ('rejected', 'cancelled')))::text AS away,
            (SELECT extract(hour FROM store_local($1, placed_at))::int::text
               FROM orders WHERE store_id = $1 AND placed_at >= $3 AND status NOT IN ('rejected', 'cancelled')
              GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1) AS busiest
       FROM orders WHERE store_id = $1 AND placed_at >= $2`,
    [storeId, b.prevStartAt, b.curStartAt],
  );
  const reason = await on.query<{ reason: string }>(
    `SELECT e.reason FROM order_events e
      WHERE e.store_id = $1 AND e.created_at >= $2 AND e.to_status IN ('rejected', 'cancelled') AND e.reason IS NOT NULL AND btrim(e.reason) <> ''
      GROUP BY e.reason ORDER BY count(*) DESC, e.reason LIMIT 1`,
    [storeId, b.curStartAt],
  );
  const accept = await on.query<{ m: string | null }>(
    `SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (a.at - o.placed_at)) / 60))::numeric, 1)::text AS m
       FROM orders o
       JOIN LATERAL (SELECT min(e.created_at) AS at FROM order_events e WHERE e.order_id = o.id AND e.to_status = 'approved') a ON a.at IS NOT NULL
      WHERE o.store_id = $1 AND o.placed_at >= $2`,
    [storeId, b.curStartAt],
  );

  const t = totals.rows[0]!;
  const map: Record<string, number> = {};
  for (const r of perDay.rows) map[r.day] = Number(r.n);
  return {
    dates: datesOf(b, days),
    perDay: map,
    total: Number(t.cur),
    previousTotal: Number(t.prev),
    deliveryShare: t.delivery === null ? null : Number(t.delivery),
    turnedAway: Number(t.away),
    topReason: reason.rows[0]?.reason ?? null,
    acceptMinutes: accept.rows[0]?.m == null ? null : Number(accept.rows[0].m),
    busiestHour: t.busiest === null ? null : Number(t.busiest),
  };
}

// ---------------------------------------------------------------------------
// Top items
// ---------------------------------------------------------------------------

export type ItemsData = {
  items: { name: string; sold: number; revenue: string }[];
  itemsSold: number;
  bestSeller: string | null;
  topEarner: string | null;
  /** Tracked products with nothing left to sell, right now — what stands in for "ran out most". */
  outOfStockNow: number;
};

export async function items(storeId: string, b: Bounds, on: Queryable = db): Promise<ItemsData> {
  const { rows } = await on.query<{ name: string; sold: string; revenue: string }>(
    `SELECT oi.product_name AS name, sum(oi.quantity)::text AS sold, sum(oi.line_total_amount)::text AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id AND o.store_id = oi.store_id
      WHERE oi.store_id = $1 AND o.placed_at >= $2 AND o.status NOT IN ('rejected', 'cancelled')
      GROUP BY oi.product_name
      ORDER BY sum(oi.line_total_amount) DESC, oi.product_name
      LIMIT 10`,
    [storeId, b.curStartAt],
  );
  const sold = await on.query<{ n: string }>(
    `SELECT COALESCE(sum(oi.quantity), 0)::text AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.store_id = oi.store_id
      WHERE oi.store_id = $1 AND o.placed_at >= $2 AND o.status NOT IN ('rejected', 'cancelled')`,
    [storeId, b.curStartAt],
  );
  const out = await on.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM products p
      WHERE p.store_id = $1 AND p.status = 'active' AND p.track_stock
        AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_available AND v.stock_quantity > 0)`,
    [storeId],
  );
  const list = rows.map((r) => ({ name: r.name, sold: Number(r.sold), revenue: r.revenue }));
  const best = [...list].sort((a, c) => c.sold - a.sold)[0];
  return {
    items: list,
    itemsSold: Number(sold.rows[0]!.n),
    bestSeller: best?.name ?? null,
    topEarner: list[0]?.name ?? null,
    outOfStockNow: Number(out.rows[0]!.n),
  };
}

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------

export type PaymentsData = {
  methods: { key: string; name: string; kind: 'online' | 'offline'; orders: number; revenue: string; successRate: number | null }[];
  paidOnlineShare: number | null;
  failedPayments: number;
  retriedAfterFailure: number;
  cashUnconfirmed: { orders: number; amount: string };
  refunds: { count: number; amount: string };
};

export async function payments(storeId: string, b: Bounds, on: Queryable = db): Promise<PaymentsData> {
  const info = await methods(on);
  const per = await on.query<{ method: string; n: string; revenue: string; attempts: string; ok: string }>(
    `SELECT o.payment_method AS method, count(DISTINCT o.id)::text AS n,
            COALESCE(sum(o.total_amount) FILTER (WHERE o.payment_status IN ('paid', 'refunded')), 0)::numeric(12,2)::text AS revenue,
            (SELECT count(*) FROM momo_transactions m WHERE m.store_id = $1 AND m.direction = 'collection'
                AND m.created_at >= $2 AND m.order_id IN (SELECT id FROM orders x WHERE x.store_id = $1 AND x.payment_method = o.payment_method))::text AS attempts,
            (SELECT count(*) FROM momo_transactions m WHERE m.store_id = $1 AND m.direction = 'collection' AND m.status = 'successful'
                AND m.created_at >= $2 AND m.order_id IN (SELECT id FROM orders x WHERE x.store_id = $1 AND x.payment_method = o.payment_method))::text AS ok
       FROM orders o
      WHERE o.store_id = $1 AND o.placed_at >= $2 AND o.status NOT IN ('rejected', 'cancelled')
      GROUP BY o.payment_method`,
    [storeId, b.curStartAt],
  );
  const failed = await on.query<{ failed: string; retried: string }>(
    `SELECT (count(*) FILTER (WHERE m.status = 'failed'))::text AS failed,
            (count(DISTINCT m.order_id) FILTER (WHERE m.status = 'failed' AND EXISTS (
               SELECT 1 FROM momo_transactions s WHERE s.order_id = m.order_id AND s.direction = 'collection' AND s.status = 'successful')))::text AS retried
       FROM momo_transactions m WHERE m.store_id = $1 AND m.direction = 'collection' AND m.created_at >= $2`,
    [storeId, b.curStartAt],
  );
  const cash = await on.query<{ n: string; amount: string }>(
    `SELECT count(*)::text AS n, COALESCE(sum(cash_due_amount), 0)::numeric(12,2)::text AS amount FROM orders
      WHERE store_id = $1 AND payment_method = 'cash' AND status IN ('delivered', 'collected') AND cash_confirmed_at IS NULL`,
    [storeId],
  );
  const refunds = await on.query<{ n: string; amount: string }>(
    `SELECT count(*)::text AS n, COALESCE(sum(approved_amount), 0)::numeric(12,2)::text AS amount FROM refunds
      WHERE store_id = $1 AND status = 'approved' AND settled_at >= $2`,
    [storeId, b.curStartAt],
  );

  const rows = per.rows.map((r) => {
    const meta = info.find((m) => m.key === r.method);
    return {
      key: r.method,
      name: meta?.name ?? r.method,
      kind: meta?.kind ?? ('online' as const),
      orders: Number(r.n),
      revenue: r.revenue,
      successRate: meta?.kind === 'offline' || Number(r.attempts) === 0 ? null : Math.round((1000 * Number(r.ok)) / Number(r.attempts)) / 10,
    };
  });
  rows.sort((a, c) => c.orders - a.orders);
  const total = rows.reduce((n, r) => n + r.orders, 0);
  const online = rows.filter((r) => r.kind === 'online').reduce((n, r) => n + r.orders, 0);
  return {
    methods: rows,
    paidOnlineShare: total === 0 ? null : Math.round((100 * online) / total),
    failedPayments: Number(failed.rows[0]!.failed),
    retriedAfterFailure: Number(failed.rows[0]!.retried),
    cashUnconfirmed: { orders: Number(cash.rows[0]!.n), amount: cash.rows[0]!.amount },
    refunds: { count: Number(refunds.rows[0]!.n), amount: refunds.rows[0]!.amount },
  };
}

// ---------------------------------------------------------------------------
// Delivery performance
// ---------------------------------------------------------------------------

export type DeliveryData = {
  riders: { id: string; name: string; deliveries: number; avgMinutes: number | null; onTimeShare: number | null }[];
  orderToDoorMinutes: number | null;
  prepMinutes: number | null;
  waitingForRiderMinutes: number | null;
  returned: number;
  topReturnReason: string | null;
  /** What "on time" was measured against: the slowest delivery zone's ETA, or null when the store has none. */
  etaMaxMinutes: number | null;
};

export async function delivery(storeId: string, b: Bounds, on: Queryable = db): Promise<DeliveryData> {
  const eta = await on.query<{ m: number | null }>(`SELECT max(eta_max_minutes) AS m FROM delivery_zones WHERE store_id = $1`, [storeId]);
  const etaMax = eta.rows[0]?.m ?? null;

  // Per order: the moments each status was first reached. One lateral read of the order's own events.
  const per = await on.query<{ rider_id: string | null; rider: string | null; placed: Date; approved: Date | null; ready: Date | null; out: Date | null; dlv: Date | null }>(
    `SELECT o.rider_user_id AS rider_id, u.name AS rider, o.placed_at AS placed, e.approved, e.ready, e.out, o.delivered_at AS dlv
       FROM orders o
       LEFT JOIN users u ON u.id = o.rider_user_id
       JOIN LATERAL (
         SELECT min(created_at) FILTER (WHERE to_status = 'approved') AS approved,
                min(created_at) FILTER (WHERE to_status = 'ready')    AS ready,
                min(created_at) FILTER (WHERE to_status = 'out')      AS "out"
           FROM order_events WHERE order_id = o.id
       ) e ON true
      WHERE o.store_id = $1 AND o.placed_at >= $2 AND o.fulfilment_type = 'delivery' AND o.status NOT IN ('rejected', 'cancelled')`,
    [storeId, b.curStartAt],
  );

  const minutes = (a: Date | null, c: Date | null): number | null => (a === null || c === null ? null : (c.getTime() - a.getTime()) / 60_000);
  const median = (xs: (number | null)[]): number | null => {
    const v = xs.filter((x): x is number => x !== null && x >= 0).sort((p, q) => p - q);
    if (v.length === 0) return null;
    const mid = Math.floor(v.length / 2);
    return Math.round((v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2) * 10) / 10;
  };

  const byRider = new Map<string, { name: string; door: (number | null)[]; ride: (number | null)[] }>();
  for (const r of per.rows) {
    if (r.rider_id === null || r.dlv === null) continue;
    const entry = byRider.get(r.rider_id) ?? { name: r.rider ?? 'Rider', door: [], ride: [] };
    entry.door.push(minutes(r.placed, r.dlv));
    entry.ride.push(minutes(r.out, r.dlv));
    byRider.set(r.rider_id, entry);
  }

  const riders = [...byRider.entries()]
    .map(([id, v]) => {
      const done = v.door.filter((x): x is number => x !== null);
      return {
        id,
        name: v.name,
        deliveries: done.length,
        avgMinutes: v.ride.filter((x) => x !== null).length === 0 ? null : Math.round(v.ride.filter((x): x is number => x !== null).reduce((a, c) => a + c, 0) / v.ride.filter((x) => x !== null).length),
        onTimeShare: etaMax === null || done.length === 0 ? null : Math.round((100 * done.filter((m) => m <= etaMax).length) / done.length),
      };
    })
    .sort((a, c) => (c.onTimeShare ?? -1) - (a.onTimeShare ?? -1) || c.deliveries - a.deliveries);

  const returned = await on.query<{ n: string; reason: string | null }>(
    `SELECT count(*)::text AS n,
            (SELECT e.reason FROM order_events e WHERE e.store_id = $1 AND e.created_at >= $2 AND e.to_status = 'returned' AND e.reason IS NOT NULL
              GROUP BY e.reason ORDER BY count(*) DESC, e.reason LIMIT 1) AS reason
       FROM order_events x WHERE x.store_id = $1 AND x.created_at >= $2 AND x.to_status = 'returned'`,
    [storeId, b.curStartAt],
  );

  return {
    riders,
    orderToDoorMinutes: median(per.rows.map((r) => minutes(r.placed, r.dlv))),
    prepMinutes: median(per.rows.map((r) => minutes(r.approved, r.ready))),
    waitingForRiderMinutes: median(per.rows.map((r) => minutes(r.ready, r.out))),
    returned: Number(returned.rows[0]!.n),
    topReturnReason: returned.rows[0]!.reason,
    etaMaxMinutes: etaMax,
  };
}
