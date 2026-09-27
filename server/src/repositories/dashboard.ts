// server/src/repositories/dashboard.ts — milestone 19.
//
// What `Dashboard` and `DashboardMobile` show. Both boards draw the same figures at two widths, so there is one
// read behind them.
//
// "TODAY" IS A QUESTION ABOUT A TIME ZONE, and V021 answers it once. Every figure comes from
// store_dashboard(), which derives the store's own day boundary a single time and uses it for all of them —
// because six queries each computing their own would be six chances for the cards to disagree with each other
// by two hours. That the boundary needed a time zone at all is a bug this milestone found in V018: see the
// migration's first section.
//
// THE SALES FIGURES ARE PERMISSIONED, the counts are not. §5.4 refused a manager at /wallet on the grounds that
// a role's permissions are rows rather than code, and revenue is the same question: a manager running the
// kitchen needs the order count and the low-stock list they act on, and whether they see the day's takings is
// the owner's decision, expressed as `wallet.read`. So the route asks for `orders.read` and omits the money
// from anybody without `wallet.read`.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';

export type DashboardCounts = {
  ordersToday: number;
  /** Of any age: a pending order from last night is the most urgent thing on the screen. */
  ordersWaiting: number;
  productsActive: number;
  productsDraft: number;
  lowStockVariants: number;
  isOpen: boolean;
  /** 'HH:MM', present only while open. */
  closesAt: string | null;
  acceptingOrders: boolean;
  /** The store's own date, so the greeting's "Tuesday, 23 September" is the merchant's Tuesday. */
  localDate: string;
};

export type DashboardMoney = {
  salesToday: string;
  salesSameDayLastWeek: string;
  /** Whole percent, or null when last week has nothing to compare against. */
  changePercent: number | null;
};

export type DashboardDay = { day: string; dayOfWeek: number; sales: string; orders: number };

export async function counts(storeId: string, on: Queryable = db): Promise<DashboardCounts> {
  const { rows } = await on.query<{
    orders_today: string;
    orders_waiting: string;
    products_active: string;
    products_draft: string;
    low_stock_variants: string;
    is_open: boolean | null;
    closes_at: string | null;
    accepting_orders: boolean;
    local_date: string;
  }>(
    `SELECT orders_today::text, orders_waiting::text, products_active::text, products_draft::text,
            low_stock_variants::text, is_open, closes_at::text, accepting_orders, local_date::text
       FROM store_dashboard($1)`,
    [storeId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`store_dashboard returned no row for ${storeId}`);
  return {
    ordersToday: Number(row.orders_today),
    ordersWaiting: Number(row.orders_waiting),
    productsActive: Number(row.products_active),
    productsDraft: Number(row.products_draft),
    lowStockVariants: Number(row.low_stock_variants),
    isOpen: row.is_open ?? false,
    // 'HH:MM:SS' from Postgres; the board writes "until 22:00".
    closesAt: row.closes_at === null ? null : row.closes_at.slice(0, 5),
    acceptingOrders: row.accepting_orders,
    localDate: row.local_date,
  };
}

/**
 * The money half, read separately so a caller without `wallet.read` simply does not call it.
 *
 * THE PERCENTAGE IS COMPUTED HERE AND NOT IN SQL, because it is the one figure that is not money: it is a ratio,
 * and a ratio of two exact decimals is a number with an opinion about rounding. The board's "+12%" is a whole
 * percent, so that is what this produces — and `null` where last week has nothing to compare against, which a
 * screen must render as silence rather than as "+100%".
 */
export async function money(storeId: string, on: Queryable = db): Promise<DashboardMoney> {
  const { rows } = await on.query<{ sales_today: string; sales_same_day_last_week: string }>(
    `SELECT sales_today::text, sales_same_day_last_week::text FROM store_dashboard($1)`,
    [storeId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`store_dashboard returned no row for ${storeId}`);

  const today = Number(row.sales_today);
  const before = Number(row.sales_same_day_last_week);
  return {
    salesToday: row.sales_today,
    salesSameDayLastWeek: row.sales_same_day_last_week,
    changePercent:
      before === 0 || !Number.isFinite(before) || !Number.isFinite(today)
        ? null
        : Math.round(((today - before) / before) * 100),
  };
}

/** Monday to Sunday of the store's current week. Days with nothing are zero, not absent. */
export async function week(storeId: string, on: Queryable = db): Promise<DashboardDay[]> {
  const { rows } = await on.query<{
    local_day: string;
    day_of_week: number;
    sales: string;
    orders: string;
  }>(
    `SELECT local_day::text, day_of_week, sales::text, orders::text FROM store_sales_week($1)`,
    [storeId],
  );
  return rows.map((r) => ({
    day: r.local_day,
    dayOfWeek: r.day_of_week,
    sales: r.sales,
    orders: Number(r.orders),
  }));
}

export type AttentionOrder = {
  id: string;
  orderNumber: number;
  trackingCode: string;
  customer: string;
  fulfilment: 'delivery' | 'pickup';
  itemCount: number;
  total: string;
  paymentMethod: string;
  paymentStatus: string;
  placedAt: Date;
};

/**
 * "Needs your attention" — orders the merchant has not accepted or refused.
 *
 * OLDEST FIRST, which is the opposite of every other list in this codebase and is the point: the order that has
 * been waiting longest is the one a customer is most annoyed about. A newest-first queue is a queue that starves
 * its oldest item.
 */
export async function needsAttention(
  storeId: string,
  limit = 5,
  on: Queryable = db,
): Promise<AttentionOrder[]> {
  const { rows } = await on.query<{
    id: string;
    order_number: number;
    tracking_code: string;
    customer: string;
    fulfilment_type: 'delivery' | 'pickup';
    item_count: string;
    total_amount: string;
    payment_method: string;
    payment_status: string;
    placed_at: Date;
  }>(
    `SELECT o.id, o.order_number, o.tracking_code,
            COALESCE(o.guest_name, u.name, 'A customer') AS customer,
            o.fulfilment_type,
            (SELECT COALESCE(sum(i.quantity), 0)::text FROM order_items i WHERE i.order_id = o.id) AS item_count,
            o.total_amount::text, o.payment_method, o.payment_status, o.placed_at
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_user_id
      WHERE o.store_id = $1 AND o.status = 'pending'
      ORDER BY o.placed_at, o.id
      LIMIT $2`,
    [storeId, Math.min(Math.max(1, limit), 20)],
  );
  return rows.map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    trackingCode: r.tracking_code,
    customer: r.customer,
    fulfilment: r.fulfilment_type,
    itemCount: Number(r.item_count),
    total: r.total_amount,
    paymentMethod: r.payment_method,
    paymentStatus: r.payment_status,
    placedAt: r.placed_at,
  }));
}

/** "Recent orders" — the table under the fold, newest first. */
export async function recent(
  storeId: string,
  limit = 8,
  on: Queryable = db,
): Promise<(AttentionOrder & { status: string })[]> {
  const { rows } = await on.query<{
    id: string;
    order_number: number;
    tracking_code: string;
    customer: string;
    fulfilment_type: 'delivery' | 'pickup';
    item_count: string;
    total_amount: string;
    payment_method: string;
    payment_status: string;
    status: string;
    placed_at: Date;
  }>(
    `SELECT o.id, o.order_number, o.tracking_code,
            COALESCE(o.guest_name, u.name, 'A customer') AS customer,
            o.fulfilment_type,
            (SELECT COALESCE(sum(i.quantity), 0)::text FROM order_items i WHERE i.order_id = o.id) AS item_count,
            o.total_amount::text, o.payment_method, o.payment_status, o.status, o.placed_at
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_user_id
      WHERE o.store_id = $1
      ORDER BY o.placed_at DESC, o.id DESC
      LIMIT $2`,
    [storeId, Math.min(Math.max(1, limit), 25)],
  );
  return rows.map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    trackingCode: r.tracking_code,
    customer: r.customer,
    fulfilment: r.fulfilment_type,
    itemCount: Number(r.item_count),
    total: r.total_amount,
    paymentMethod: r.payment_method,
    paymentStatus: r.payment_status,
    status: r.status,
    placedAt: r.placed_at,
  }));
}

/**
 * The lowest-stock variant, for `DashboardMobile`'s one-line warning: "Passion Juice has 4 left. Restock".
 *
 * ONE, not a list, because the mobile board has room for one and a merchant on a phone needs the worst thing
 * rather than all of them.
 */
export async function lowestStock(
  storeId: string,
  on: Queryable = db,
): Promise<{ productName: string; variantLabel: string | null; left: number } | null> {
  const { rows } = await on.query<{ name: string; sku: string | null; stock_quantity: number }>(
    `SELECT p.name, v.sku, v.stock_quantity
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.store_id = $1
        AND p.track_stock AND p.low_stock_threshold > 0
        AND v.is_available
        AND v.stock_quantity IS NOT NULL
        AND v.stock_quantity <= p.low_stock_threshold
      ORDER BY v.stock_quantity, p.name, v.id
      LIMIT 1`,
    [storeId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { productName: row.name, variantLabel: row.sku, left: row.stock_quantity };
}

/** "Pause new orders" / "Start taking orders again". */
export async function setAcceptingOrders(
  storeId: string,
  accepting: boolean,
  on: Queryable = db,
): Promise<boolean> {
  const { rows } = await on.query<{ accepting_orders: boolean }>(
    `UPDATE stores SET accepting_orders = $2 WHERE id = $1 RETURNING accepting_orders`,
    [storeId, accepting],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`store ${storeId} does not exist`);
  return row.accepting_orders;
}

// ---------------------------------------------------------------------------
// The sidebar's badges
// ---------------------------------------------------------------------------
//
// `Sidebar` draws a count beside Orders, Complaints and Reviews — 3, 2 and 1 on the board. They are one query
// because the sidebar is on every console screen: three requests per navigation, for three small numbers, is
// three round trips a merchant on a phone connection pays for repeatedly.
//
// EACH COUNT IS "WHAT IS WAITING FOR A PERSON", not "how many exist". That is the only reading that makes a
// badge worth having: a number that never reaches zero is decoration, and staff stop seeing it.
//
//   orders       pending — placed and not yet accepted or declined. The same figure the alert derives from.
//   complaints   open only. `escalated` is with Vendlyfy and the merchant is waiting rather than acting, and
//                resolved and rejected are finished; badging them would mean the count never cleared.
//   reviews      visible and unanswered. V009 keeps the merchant's reply in `review_replies`, one row per
//                review, so "unanswered" is the absence of that row — and a review Vendlyfy hid after an
//                upheld report is not the merchant's to answer, so hidden_at excludes it.

export type SidebarBadges = { orders: number; complaints: number; reviews: number };

export async function badges(storeId: string, on: Queryable = db): Promise<SidebarBadges> {
  const { rows } = await on.query<{ orders: string; complaints: string; reviews: string }>(
    `SELECT (SELECT count(*) FROM orders o
              WHERE o.store_id = $1 AND o.status = 'pending')::text AS orders,
            (SELECT count(*) FROM complaints c
              WHERE c.store_id = $1 AND c.status = 'open')::text AS complaints,
            (SELECT count(*) FROM reviews r
              WHERE r.store_id = $1
                AND r.hidden_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM review_replies p WHERE p.review_id = r.id))::text AS reviews`,
    [storeId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`badges returned no row for ${storeId}`);
  return { orders: Number(row.orders), complaints: Number(row.complaints), reviews: Number(row.reviews) };
}
