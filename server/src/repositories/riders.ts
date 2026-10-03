// server/src/repositories/riders.ts — milestone 21.
//
// Two screens, one table set: the rider's own app (`Rider`, project/Rider.dc.html) reads and writes
// what is true of ONE rider — their jobs, their availability, the cash they are carrying — and the
// merchant's own (`CashReport`, project/CashReport.dc.html) reads across ALL of a store's riders and
// writes the end-of-day settlement. Both live here because both read the same three tables V007 built
// (`rider_profiles`, `rider_cash_handovers`, `rider_cash_settlements`) and the same orders the Orders
// board already owns — a second repository per screen would be two places answering "what is
// expected_amount" and the two would drift the first time one of them changed.
//
// "A RIDER'S OWN DELIVERIES ONLY" IS ENFORCED HERE, NOT BY THE PERMISSION. V007's own comment on
// `role_permissions`: "the scoping to 'own' is enforced by the query, not by the permission — a
// permission cannot express a row filter." Every rider-facing function below takes the caller's own
// id and filters by it; `markPickedUp()`/`markDelivered()`/`confirmCash()` (orders.ts, V022) do not —
// they trust whichever permission reached them — so the route, not the repository, is what makes a
// rider's own endpoint only ever touch their own order. See `routes/riderApp.ts`'s header.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import type { Actor, OrderLine, OrderStatus } from './orders.ts';

// ---------------------------------------------------------------------------
// The rider's own app
// ---------------------------------------------------------------------------

export type RiderJob = {
  id: string;
  orderNumber: number;
  status: Extract<OrderStatus, 'assigned' | 'out' | 'delivered' | 'returned'>;
  storeName: string;
  storeAddress: string | null;
  customer: string;
  phone: string | null;
  address: string | null;
  paymentMethod: string;
  cashDue: string | null;
  total: string;
  placedAt: Date;
  lines: OrderLine[];
};

export type RiderProfile = { storeName: string; plateNumber: string; availability: 'available' | 'off_duty' };

/** The rider app's own header: whose app this is, and where. Null if this user is not a rider here. */
export async function myProfile(storeId: string, riderId: string, on: Queryable = db): Promise<RiderProfile | null> {
  const { rows } = await on.query<{ store_name: string; plate_number: string; availability: 'available' | 'off_duty' }>(
    `SELECT s.name AS store_name, rp.plate_number, rp.availability
       FROM rider_profiles rp JOIN stores s ON s.id = rp.store_id
      WHERE rp.store_id = $1 AND rp.user_id = $2`,
    [storeId, riderId],
  );
  const row = rows[0];
  return row === undefined ? null : { storeName: row.store_name, plateNumber: row.plate_number, availability: row.availability };
}

/** Whether this order belongs to this rider at this store — the check every rider route makes first. */
export async function isOwnJob(storeId: string, orderId: string, riderId: string, on: Queryable = db): Promise<boolean> {
  const { rows } = await on.query(
    `SELECT 1 FROM orders WHERE id = $1 AND store_id = $2 AND rider_user_id = $3`,
    [orderId, storeId, riderId],
  );
  return rows.length > 0;
}

/**
 * Everything on this rider's phone right now: to-deliver (assigned/out, any age) and today's done
 * (delivered/returned, filtered on when the job last changed — `updated_at` — in the store's own day,
 * the same `store_local()` boundary V021 built for "today" everywhere else it means something).
 */
export async function myJobs(storeId: string, riderId: string, on: Queryable = db): Promise<RiderJob[]> {
  const { rows } = await on.query<{
    id: string;
    order_number: number;
    status: RiderJob['status'];
    store_name: string;
    store_address: string | null;
    customer: string;
    phone: string | null;
    delivery_address: string | null;
    payment_method: string;
    cash_due_amount: string | null;
    total_amount: string;
    placed_at: Date;
  }>(
    `SELECT o.id, o.order_number, o.status, s.name AS store_name, s.address AS store_address,
            COALESCE(o.guest_name, u.name, 'A customer') AS customer,
            COALESCE(o.guest_phone, u.phone) AS phone,
            o.delivery_address, o.payment_method, o.cash_due_amount::text, o.total_amount::text, o.placed_at
       FROM orders o
       JOIN stores s ON s.id = o.store_id
       LEFT JOIN users u ON u.id = o.customer_user_id
      WHERE o.store_id = $1 AND o.rider_user_id = $2
        AND (o.status IN ('assigned', 'out')
             OR (o.status IN ('delivered', 'returned')
                 AND store_local($1, o.updated_at)::date = store_local($1, now())::date))
      ORDER BY o.placed_at`,
    [storeId, riderId],
  );
  if (rows.length === 0) return [];

  const { rows: lineRows } = await on.query<{
    order_id: string;
    id: string;
    product_name: string;
    variant_label: string;
    quantity: number;
    unit_price_amount: string;
    line_total_amount: string;
  }>(
    `SELECT order_id, id, product_name, variant_label, quantity, unit_price_amount::text, line_total_amount::text
       FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [rows.map((r) => r.id)],
  );
  const linesByOrder = new Map<string, OrderLine[]>();
  for (const l of lineRows) {
    const line: OrderLine = {
      id: l.id,
      productName: l.product_name,
      variantLabel: l.variant_label,
      optionLabels: [],
      quantity: l.quantity,
      unitPrice: l.unit_price_amount,
      lineTotal: l.line_total_amount,
    };
    const list = linesByOrder.get(l.order_id);
    if (list === undefined) linesByOrder.set(l.order_id, [line]);
    else list.push(line);
  }

  return rows.map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    status: r.status,
    storeName: r.store_name,
    storeAddress: r.store_address,
    customer: r.customer,
    phone: r.phone,
    address: r.delivery_address,
    paymentMethod: r.payment_method,
    cashDue: r.cash_due_amount,
    total: r.total_amount,
    placedAt: r.placed_at,
    lines: linesByOrder.get(r.id) ?? [],
  }));
}

/**
 * "Cash with you" — the header figure, live: confirmed cash collected today minus what has already
 * been handed in today. The exact pair `close_rider_day()` (V023) captures at end of day; this is the
 * same arithmetic read-only, so a rider sees the number they are about to be asked to account for.
 */
export async function cashHeld(storeId: string, riderId: string, on: Queryable = db): Promise<string> {
  const { rows } = await on.query<{ held: string }>(
    `SELECT (
        COALESCE((SELECT sum(o.cash_reported_amount) FROM orders o
                   WHERE o.store_id = $1 AND o.rider_user_id = $2 AND o.payment_method = 'cash'
                     AND o.cash_confirmed_at IS NOT NULL
                     AND store_local($1, o.cash_confirmed_at)::date = store_local($1, now())::date), 0)
        -
        COALESCE((SELECT sum(h.amount) FROM rider_cash_handovers h
                   WHERE h.store_id = $1 AND h.rider_user_id = $2
                     AND store_local($1, h.handed_at)::date = store_local($1, now())::date), 0)
     )::text AS held`,
    [storeId, riderId],
  );
  return rows[0]?.held ?? '0';
}

export async function setAvailability(
  storeId: string,
  riderId: string,
  available: boolean,
  tx: Queryable,
): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT set_rider_availability($1, $2, $3) AS ok`,
    [riderId, storeId, available],
  );
  return rows[0]?.ok ?? false;
}

export async function markReturned(
  storeId: string,
  orderId: string,
  actor: Actor,
  reason: string,
  note: string | null,
  tx: Queryable,
): Promise<boolean | null> {
  const { rows } = await tx.query<{ ok: boolean | null }>(
    `SELECT mark_returned($1, $2, $3, $4, $5, $6) AS ok`,
    [orderId, storeId, actor.userId, actor.role, reason, note],
  );
  return rows[0]?.ok ?? null;
}

// ---------------------------------------------------------------------------
// CashReport — the merchant's own screen
// ---------------------------------------------------------------------------

export type RosterRow = {
  id: string;
  name: string;
  phone: string | null;
  plate: string;
  availability: 'available' | 'off_duty';
  activeJobs: number;
  cashCarried: string;
  lastUpdate: Date;
};

/** "Right now" — every rider at the store, on duty or not, with what they are carrying. */
export async function roster(storeId: string, on: Queryable = db): Promise<RosterRow[]> {
  const { rows } = await on.query<{
    id: string;
    name: string;
    phone: string | null;
    plate: string;
    availability: 'available' | 'off_duty';
    active_jobs: string;
    cash_carried: string;
    last_update: Date;
  }>(
    `SELECT rp.user_id AS id, u.name, u.phone, rp.plate_number AS plate, rp.availability,
            count(o.id) FILTER (WHERE o.status IN ('assigned', 'out'))::text AS active_jobs,
            COALESCE(sum(o.cash_reported_amount) FILTER (
              WHERE o.payment_method = 'cash' AND o.cash_confirmed_at IS NOT NULL
                AND store_local($1, o.cash_confirmed_at)::date = store_local($1, now())::date
            ), 0)::text AS cash_carried,
            rp.availability_changed_at AS last_update
       FROM rider_profiles rp
       JOIN users u ON u.id = rp.user_id
       LEFT JOIN orders o ON o.rider_user_id = rp.user_id AND o.store_id = rp.store_id
      WHERE rp.store_id = $1
      GROUP BY rp.user_id, u.name, u.phone, rp.plate_number, rp.availability, rp.availability_changed_at
      ORDER BY (rp.availability = 'available') DESC, u.name`,
    [storeId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    plate: r.plate,
    availability: r.availability,
    activeJobs: Number(r.active_jobs),
    cashCarried: r.cash_carried,
    lastUpdate: r.last_update,
  }));
}

export type CashOrderLine = { id: string; orderNumber: number; label: string; amount: string };

export type RiderCashCard = {
  riderId: string;
  name: string;
  closedToday: boolean;
  settlementId: string | null;
  deliveredToday: CashOrderLine[];
  stillOut: CashOrderLine[];
  expected: string;
  handedInToday: string;
  due: string;
  gapAmount: string | null;
  gapResolution: 'carry_over' | 'discount' | 'write_off' | null;
};

/** "Close the day" — one card per rider who has any cash activity today, open or settled. */
export async function cashReportDay(storeId: string, on: Queryable = db): Promise<RiderCashCard[]> {
  const { rows: riders } = await on.query<{ id: string; name: string }>(
    `SELECT DISTINCT rp.user_id AS id, u.name
       FROM rider_profiles rp
       JOIN users u ON u.id = rp.user_id
       LEFT JOIN orders o ON o.rider_user_id = rp.user_id AND o.store_id = rp.store_id
                          AND o.payment_method = 'cash'
      WHERE rp.store_id = $1
        AND (o.status IN ('assigned', 'out')
             OR (o.cash_confirmed_at IS NOT NULL AND store_local($1, o.cash_confirmed_at)::date = store_local($1, now())::date)
             OR EXISTS (SELECT 1 FROM rider_cash_settlements rcs
                         WHERE rcs.store_id = $1 AND rcs.rider_user_id = rp.user_id
                           AND rcs.business_date = store_local($1, now())::date))
      ORDER BY u.name`,
    [storeId],
  );
  if (riders.length === 0) return [];
  const riderIds = riders.map((r) => r.id);

  const { rows: delivered } = await on.query<{
    rider_user_id: string;
    id: string;
    order_number: number;
    amount: string;
  }>(
    // cash_due_amount, not cash_reported_amount — what was OWED, matching close_rider_day()'s own
    // expected_amount exactly, so a reported-short order's shortfall surfaces here as the gap to
    // resolve rather than having already vanished into a smaller "expected".
    `SELECT rider_user_id, id, order_number, cash_due_amount::text AS amount
       FROM orders
      WHERE store_id = $1 AND rider_user_id = ANY($2::uuid[]) AND payment_method = 'cash'
        AND cash_confirmed_at IS NOT NULL AND store_local($1, cash_confirmed_at)::date = store_local($1, now())::date
      ORDER BY cash_confirmed_at`,
    [storeId, riderIds],
  );
  const { rows: stillOut } = await on.query<{
    rider_user_id: string;
    id: string;
    order_number: number;
    status: string;
    amount: string;
  }>(
    `SELECT rider_user_id, id, order_number, status, cash_due_amount::text AS amount
       FROM orders
      WHERE store_id = $1 AND rider_user_id = ANY($2::uuid[]) AND payment_method = 'cash'
        AND status IN ('assigned', 'out')
      ORDER BY placed_at`,
    [storeId, riderIds],
  );
  const { rows: handed } = await on.query<{ rider_user_id: string; total: string }>(
    `SELECT rider_user_id, sum(amount)::text AS total
       FROM rider_cash_handovers
      WHERE store_id = $1 AND rider_user_id = ANY($2::uuid[])
        AND store_local($1, handed_at)::date = store_local($1, now())::date
      GROUP BY rider_user_id`,
    [storeId, riderIds],
  );
  const { rows: settled } = await on.query<{
    id: string;
    rider_user_id: string;
    gap_amount: string;
    gap_resolution: 'carry_over' | 'discount' | 'write_off' | null;
  }>(
    `SELECT id, rider_user_id, gap_amount::text, gap_resolution
       FROM rider_cash_settlements
      WHERE store_id = $1 AND rider_user_id = ANY($2::uuid[])
        AND business_date = store_local($1, now())::date`,
    [storeId, riderIds],
  );

  const by = <T extends { rider_user_id: string }>(list: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of list) {
      const l = m.get(r.rider_user_id);
      if (l === undefined) m.set(r.rider_user_id, [r]);
      else l.push(r);
    }
    return m;
  };
  const deliveredBy = by(delivered);
  const stillOutBy = by(stillOut);
  const handedBy = new Map(handed.map((h) => [h.rider_user_id, h.total]));
  const settledBy = new Map(settled.map((s) => [s.rider_user_id, s]));

  return riders.map((r) => {
    const d = (deliveredBy.get(r.id) ?? []).map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      label: 'delivered',
      amount: o.amount,
    }));
    const out = (stillOutBy.get(r.id) ?? []).map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      label: o.status === 'assigned' ? 'assigned, not picked up' : 'not delivered yet',
      amount: o.amount,
    }));
    const expected = d.reduce((sum, o) => sum + Number(o.amount), 0);
    const handedInToday = Number(handedBy.get(r.id) ?? '0');
    const settlement = settledBy.get(r.id) ?? null;
    return {
      riderId: r.id,
      name: r.name,
      closedToday: settlement !== null,
      settlementId: settlement?.id ?? null,
      deliveredToday: d,
      stillOut: out,
      expected: expected.toFixed(2),
      handedInToday: handedInToday.toFixed(2),
      due: (expected - handedInToday).toFixed(2),
      gapAmount: settlement?.gap_amount ?? null,
      gapResolution: settlement?.gap_resolution ?? null,
    };
  });
}

export type CarriedOverDebt = {
  settlementId: string;
  riderName: string;
  businessDate: string;
  gapAmount: string;
  orderNumber: number | null;
};

/** The "Carried over" list — every unsettled carry-over, any day, store-wide. */
export async function carriedOver(storeId: string, on: Queryable = db): Promise<CarriedOverDebt[]> {
  const { rows } = await on.query<{
    id: string;
    rider_name: string;
    business_date: string;
    gap_amount: string;
    order_number: number | null;
  }>(
    `SELECT s.id, u.name AS rider_name, s.business_date::text, s.gap_amount::text, o.order_number
       FROM rider_cash_settlements s
       JOIN users u ON u.id = s.rider_user_id
       LEFT JOIN orders o ON o.id = s.gap_order_id
      WHERE s.store_id = $1 AND s.gap_resolution = 'carry_over' AND s.carried_over_settled_at IS NULL
      ORDER BY s.business_date`,
    [storeId],
  );
  return rows.map((r) => ({
    settlementId: r.id,
    riderName: r.rider_name,
    businessDate: r.business_date,
    gapAmount: r.gap_amount,
    orderNumber: r.order_number,
  }));
}

export async function recordHandover(
  storeId: string,
  riderId: string,
  actor: Actor,
  amount: string,
  note: string | null,
  tx: Queryable,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT record_rider_handover($1, $2, $3, $4, $5) AS id`,
    [storeId, riderId, actor.userId, amount, note],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('record_rider_handover returned no id');
  return id;
}

export async function closeDay(
  storeId: string,
  riderId: string,
  actor: Actor,
  countedAmount: string,
  resolution: 'carry_over' | 'discount' | 'write_off' | null,
  gapOrderId: string | null,
  gapNote: string | null,
  tx: Queryable,
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string | null }>(
    `SELECT close_rider_day($1, $2, $3, $4, $5, $6, $7) AS id`,
    [storeId, riderId, actor.userId, countedAmount, resolution, gapOrderId, gapNote],
  );
  return rows[0]?.id ?? null;
}

export async function receiveCarriedOver(
  storeId: string,
  settlementId: string,
  actor: Actor,
  tx: Queryable,
): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT receive_carried_over_cash($1, $2, $3) AS ok`,
    [settlementId, storeId, actor.userId],
  );
  return rows[0]?.ok ?? false;
}
