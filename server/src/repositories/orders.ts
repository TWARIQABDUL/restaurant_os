// server/src/repositories/orders.ts — milestone 17, extended at milestone 19 and 20.
//
// One order, as the customer who placed it sees it: the receipt and the tracking timeline.
//
// FOUND BY TRACKING CODE, NOT BY ID, and the code is 32 random hex characters because it is a bearer
// credential. A guest order has no account behind it — `Shop`'s success screen goes straight to "Track
// order" and the only thing the customer has is the link — so whoever holds the code sees the order. That is
// the design the board requires, and it is safe only because the code is unguessable. An order id in the URL
// would not be: ids leak through other surfaces.
//
// THE TIMELINE'S LABELS ARE THE CONFIG ENGINE'S, not this file's. V002 puts `order_steps` on the industry
// template — "the key is what code and history refer to while the label is per-industry wording — Services
// calls its first step 'Booked' where Food calls it 'New'" — so this returns the STATUS and the events, and
// the screen renders them through the words it already has. A label chosen here would be a second
// vocabulary.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';

/** V004's twelve. A customer only ever sees an order in one of them. */
export type OrderStatus =
  | 'pending'
  | 'approved'
  | 'preparing'
  | 'ready'
  | 'assigned'
  | 'out'
  | 'delivered'
  | 'collected'
  | 'returned'
  | 'closed_return'
  | 'rejected'
  | 'cancelled';

export type OrderLine = {
  id: string;
  productName: string;
  variantLabel: string;
  optionLabels: string[];
  quantity: number;
  unitPrice: string;
  lineTotal: string;
};

export type OrderEvent = { status: OrderStatus; at: Date; note: string | null };

export type CustomerOrder = {
  id: string;
  orderNumber: number;
  trackingCode: string;
  status: OrderStatus;
  paymentStatus: 'unpaid' | 'paid' | 'refunded';
  paymentMethod: string;
  fulfilment: 'delivery' | 'pickup';
  deliveryAddress: string | null;
  currency: string;
  subtotal: string;
  deliveryFee: string;
  discount: string;
  total: string;
  /** What the rider collects. Present only for cash — V019 derives it. */
  cashDue: string | null;
  placedAt: Date;
  paidAt: Date | null;
  deliveredAt: Date | null;
  lines: OrderLine[];
  /** Oldest first, which is the order the timeline reads in. */
  events: OrderEvent[];
  /** The store, so the tracking page can be opened cold from a link. */
  store: { slug: string; name: string; phone: string | null };
  /** Where to collect, for a pickup order. */
  pickup: { address: string; readyMinutes: number; instructions: string | null } | null;
  /** The ETA range of the zone the order was quoted, for "Arriving in about 30 minutes". */
  delivery: { etaMinMinutes: number; etaMaxMinutes: number } | null;
  /** A guest order shows the name it was placed under; an account order does not need to. */
  placedFor: string | null;
};

export async function findByTrackingCode(
  storeId: string,
  trackingCode: string,
  on: Queryable = db,
): Promise<CustomerOrder | null> {
  const { rows } = await on.query<{
    id: string;
    order_number: number;
    tracking_code: string;
    status: OrderStatus;
    payment_status: 'unpaid' | 'paid' | 'refunded';
    payment_method: string;
    fulfilment_type: 'delivery' | 'pickup';
    delivery_address: string | null;
    currency: string;
    subtotal_amount: string;
    delivery_fee_amount: string;
    discount_amount: string;
    total_amount: string;
    cash_due_amount: string | null;
    placed_at: Date;
    paid_at: Date | null;
    delivered_at: Date | null;
    slug: string;
    store_name: string;
    public_phone: string | null;
    guest_name: string | null;
    customer_name: string | null;
    pickup_address: string | null;
    pickup_ready: number | null;
    pickup_instructions: string | null;
    eta_min: number | null;
    eta_max: number | null;
  }>(
    `SELECT o.id, o.order_number, o.tracking_code, o.status, o.payment_status, o.payment_method,
            o.fulfilment_type, o.delivery_address, o.currency,
            o.subtotal_amount::text, o.delivery_fee_amount::text, o.discount_amount::text,
            o.total_amount::text, o.cash_due_amount::text,
            o.placed_at, o.paid_at, o.delivered_at,
            s.slug, s.name AS store_name, s.public_phone,
            o.guest_name,
            u.name AS customer_name,
            p.address AS pickup_address, p.ready_minutes AS pickup_ready, p.instructions AS pickup_instructions,
            -- The cheapest active zone's range, which is what the storefront quoted. The order does not
            -- record its zone (V004 predates the zone list), so this is the same figure the shop advertises
            -- rather than a second source of truth invented here.
            z.eta_min_minutes AS eta_min, z.eta_max_minutes AS eta_max
       FROM orders o
       JOIN stores s ON s.id = o.store_id
       LEFT JOIN users u ON u.id = o.customer_user_id
       LEFT JOIN store_pickup_settings p ON p.store_id = o.store_id
       LEFT JOIN LATERAL (
         SELECT dz.eta_min_minutes, dz.eta_max_minutes
           FROM delivery_zones dz
          WHERE dz.store_id = o.store_id AND dz.is_active
          ORDER BY dz.fee_amount, dz.position, dz.id
          LIMIT 1
       ) AS z ON o.fulfilment_type = 'delivery'
      WHERE o.store_id = $1 AND o.tracking_code = $2`,
    [storeId, trackingCode],
  );

  const row = rows[0];
  if (row === undefined) return null;

  const { rows: lineRows } = await on.query<{
    id: string;
    product_name: string;
    variant_label: string;
    quantity: number;
    unit_price_amount: string;
    line_total_amount: string;
    options: string[] | null;
  }>(
    `SELECT i.id, i.product_name, i.variant_label, i.quantity,
            i.unit_price_amount::text, i.line_total_amount::text,
            (SELECT array_agg(v.value_label ORDER BY v.group_name, v.value_label)
               FROM order_item_option_values v WHERE v.order_item_id = i.id) AS options
       FROM order_items i
      WHERE i.order_id = $1
      ORDER BY i.created_at, i.id`,
    [row.id],
  );

  const { rows: eventRows } = await on.query<{ to_status: OrderStatus; created_at: Date; note: string | null }>(
    `SELECT to_status, created_at, note FROM order_events WHERE order_id = $1 ORDER BY created_at, id`,
    [row.id],
  );

  return {
    id: row.id,
    orderNumber: row.order_number,
    trackingCode: row.tracking_code,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    fulfilment: row.fulfilment_type,
    deliveryAddress: row.delivery_address,
    currency: row.currency,
    subtotal: row.subtotal_amount,
    deliveryFee: row.delivery_fee_amount,
    discount: row.discount_amount,
    total: row.total_amount,
    cashDue: row.cash_due_amount,
    placedAt: row.placed_at,
    paidAt: row.paid_at,
    deliveredAt: row.delivered_at,
    lines: lineRows.map((line) => ({
      id: line.id,
      productName: line.product_name,
      variantLabel: line.variant_label,
      optionLabels: line.options ?? [],
      quantity: line.quantity,
      unitPrice: line.unit_price_amount,
      lineTotal: line.line_total_amount,
    })),
    events: eventRows.map((event) => ({
      status: event.to_status,
      at: event.created_at,
      note: event.note,
    })),
    store: { slug: row.slug, name: row.store_name, phone: row.public_phone },
    pickup:
      row.pickup_address === null || row.pickup_ready === null
        ? null
        : {
            address: row.pickup_address,
            readyMinutes: row.pickup_ready,
            instructions: row.pickup_instructions,
          },
    delivery:
      row.eta_min === null || row.eta_max === null
        ? null
        : { etaMinMinutes: row.eta_min, etaMaxMinutes: row.eta_max },
    placedFor: row.guest_name ?? row.customer_name,
  };
}

// ---------------------------------------------------------------------------
// Accepting an order — milestone 19, for the new-order alert
// ---------------------------------------------------------------------------
//
// WHY THIS IS HERE AND NOT IN MILESTONE 20. `Notifications` gives the new-order alert three actions — "Accept",
// "Open in Orders", "Silence" — and an alert whose primary action does nothing is not a shipped alert. So the
// one transition the alert needs lands with the alert. Everything else the `Orders` board does — declining with
// a reason, the rider picker, cash confirmation, returns — is milestone 20's, and it extends this file.
//
// WHAT ACCEPTING IS, EXACTLY: pending → approved, plus the event that records who did it. It moves no money and
// reserves no stock, because `place_order()` already did both when the customer placed it — which is what makes
// this a safe thing to ship on its own rather than half of a larger operation.
//
// IDEMPOTENT BY THE ROW LOCK, and the reason is the one the alert creates: the same order is on every signed-in
// screen at the store, so two people pressing Accept within the same second is the expected case, not an edge
// one. The lock serialises them; the second finds the order already approved and is told it worked, because it
// did — somebody accepted the order, which is what the person asked for. What is NOT idempotent is accepting
// something already declined or cancelled: that is a different answer to the same question, and saying "done"
// would tell a merchant an order is coming that nobody is making.

export type AcceptOutcome = {
  status: OrderStatus;
  /** False when somebody else got there first. The screen says "already accepted" rather than "accepted". */
  changed: boolean;
  orderNumber: number;
};

export async function accept(
  storeId: string,
  orderId: string,
  actor: { userId: string; role: string | null },
  tx: Queryable,
): Promise<AcceptOutcome | null> {
  // The store id is in the WHERE clause, not checked afterwards: an order id from another store must look
  // exactly like an order id that does not exist.
  const { rows } = await tx.query<{ status: OrderStatus; order_number: number }>(
    `SELECT status, order_number FROM orders WHERE id = $1 AND store_id = $2 FOR UPDATE`,
    [orderId, storeId],
  );
  const found = rows[0];
  if (found === undefined) return null;

  if (found.status !== 'pending') {
    return { status: found.status, changed: false, orderNumber: found.order_number };
  }

  await tx.query(`UPDATE orders SET status = 'approved' WHERE id = $1`, [orderId]);
  // V004's order_events is append-only and IS the order's history; the trigger on orders refuses an illegal
  // move, so this row can only ever describe one that happened.
  await tx.query(
    `INSERT INTO order_events (order_id, store_id, from_status, to_status, actor_id, actor_role, note)
          VALUES ($1, $2, 'pending', 'approved', $3, $4, $5)`,
    [orderId, storeId, actor.userId, actor.role, 'Accepted from the new-order alert'],
  );
  return { status: 'approved', changed: true, orderNumber: found.order_number };
}

// ---------------------------------------------------------------------------
// The Orders board — milestone 20
// ---------------------------------------------------------------------------
//
// EVERYTHING BELOW IS ONE SCREEN'S DATA, composed the way dashboard.ts composes Dashboard's: the board and the
// list are one fetch and one in-memory grouping, because `Orders.dc.html`'s own `colOf()` and `card()` group
// and shape the SAME rows client-side rather than asking the server for six separate queries.
//
// WHAT "OPEN" MEANS HERE. A store that has been trading for a year has thousands of delivered orders, and the
// board has no use for last month's. So the list is every order that still needs somebody — every non-terminal
// status — PLUS today's terminal ones, so "Done today" has something in it. `store_local()` (V021) is what
// "today" means, not the database's UTC day.
//
// EVERY TRANSITION BELOW IS A THIN WRAPPER over the plpgsql function V022 defines, for the same reason accept()
// above is one over a locked UPDATE: the row lock, the precursor check and the event all live in one place a
// concurrent screen cannot race past. A function returning `false` means somebody already decided it — not an
// error, because "already ready" and "already declined" are both facts, not failures.

export type Actor = { userId: string; role: string | null };

export type OrderListItem = {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  customer: string;
  phone: string | null;
  fulfilment: 'delivery' | 'pickup';
  address: string | null;
  itemCount: number;
  itemSummary: string;
  total: string;
  paymentMethod: string;
  paymentStatus: 'unpaid' | 'paid' | 'refunded';
  /** Cash only: whether confirm_cash_payment() has run. Always true for an online method. */
  cashConfirmed: boolean;
  riderName: string | null;
  hasLiveRefund: boolean;
  placedAt: Date;
  ageMinutes: number;
};

/** The columns every order query below selects, shared so `list()` and `get()` cannot drift apart. */
const ORDER_ROW_COLUMNS = `
    o.id, o.order_number, o.status,
    COALESCE(o.guest_name, u.name, 'A customer') AS customer,
    COALESCE(o.guest_phone, u.phone) AS phone,
    o.fulfilment_type, o.delivery_address,
    (SELECT COALESCE(sum(i.quantity), 0)::text FROM order_items i WHERE i.order_id = o.id) AS item_count,
    o.total_amount::text, o.payment_method, o.payment_status, o.cash_confirmed_at,
    r.name AS rider_name,
    EXISTS (SELECT 1 FROM refunds f WHERE f.order_id = o.id AND f.status IN ('pending', 'queued')) AS has_live_refund,
    o.placed_at`;

const ORDER_ROW_JOINS = `
       LEFT JOIN users u ON u.id = o.customer_user_id
       LEFT JOIN users r ON r.id = o.rider_user_id`;

type OrderRow = {
  id: string;
  order_number: number;
  status: OrderStatus;
  customer: string;
  phone: string | null;
  fulfilment_type: 'delivery' | 'pickup';
  delivery_address: string | null;
  item_count: string;
  total_amount: string;
  payment_method: string;
  payment_status: 'unpaid' | 'paid' | 'refunded';
  cash_confirmed_at: Date | null;
  rider_name: string | null;
  has_live_refund: boolean;
  placed_at: Date;
};

function toListItem(r: OrderRow, now: number): OrderListItem {
  const count = Number(r.item_count);
  return {
    id: r.id,
    orderNumber: r.order_number,
    status: r.status,
    customer: r.customer,
    phone: r.phone,
    fulfilment: r.fulfilment_type,
    address: r.delivery_address,
    itemCount: count,
    itemSummary: `${count} item${count === 1 ? '' : 's'}`,
    total: r.total_amount,
    paymentMethod: r.payment_method,
    paymentStatus: r.payment_status,
    cashConfirmed: r.payment_method !== 'cash' || r.cash_confirmed_at !== null,
    riderName: r.rider_name,
    hasLiveRefund: r.has_live_refund,
    placedAt: r.placed_at,
    ageMinutes: Math.max(0, Math.floor((now - r.placed_at.getTime()) / 60_000)),
  };
}

/** Every order the board or the list draws: open, plus today's closed ones. Newest first. */
export async function list(storeId: string, on: Queryable = db): Promise<OrderListItem[]> {
  const { rows } = await on.query<OrderRow>(
    `SELECT ${ORDER_ROW_COLUMNS}
       FROM orders o${ORDER_ROW_JOINS}
      WHERE o.store_id = $1
        AND (o.status NOT IN ('delivered', 'collected', 'rejected', 'cancelled', 'closed_return')
             OR store_local($1, o.placed_at)::date = store_local($1, now())::date)
      ORDER BY o.placed_at DESC, o.id DESC
      LIMIT 500`,
    [storeId],
  );
  const now = Date.now();
  return rows.map((r) => toListItem(r, now));
}

export type OrderDetail = OrderListItem & {
  lines: OrderLine[];
  subtotal: string;
  deliveryFee: string;
  discount: string;
  cashDue: string | null;
  cashReported: string | null;
  riderId: string | null;
  events: Array<{ fromStatus: OrderStatus | null; toStatus: OrderStatus; reason: string | null; note: string | null; actorName: string | null; at: Date }>;
  refundedAmount: string;
};

type OrderDetailRow = OrderRow & {
  subtotal_amount: string;
  delivery_fee_amount: string;
  discount_amount: string;
  cash_due_amount: string | null;
  cash_reported_amount: string | null;
  rider_user_id: string | null;
  refunded_amount: string;
};

/** One order, everything the drawer draws. Null if it is not at this store. */
export async function get(storeId: string, orderId: string, on: Queryable = db): Promise<OrderDetail | null> {
  const { rows } = await on.query<OrderDetailRow>(
    `SELECT ${ORDER_ROW_COLUMNS},
            o.subtotal_amount::text, o.delivery_fee_amount::text, o.discount_amount::text,
            o.cash_due_amount::text, o.cash_reported_amount::text, o.rider_user_id, o.refunded_amount::text
       FROM orders o${ORDER_ROW_JOINS}
      WHERE o.id = $1 AND o.store_id = $2`,
    [orderId, storeId],
  );
  const row = rows[0];
  if (row === undefined) return null;

  const item = toListItem(row, Date.now());

  const { rows: lineRows } = await on.query<{
    id: string;
    product_name: string;
    variant_label: string;
    quantity: number;
    unit_price_amount: string;
    line_total_amount: string;
    options: string[] | null;
  }>(
    `SELECT i.id, i.product_name, i.variant_label, i.quantity,
            i.unit_price_amount::text, i.line_total_amount::text,
            (SELECT array_agg(v.value_label ORDER BY v.group_name, v.value_label)
               FROM order_item_option_values v WHERE v.order_item_id = i.id) AS options
       FROM order_items i
      WHERE i.order_id = $1
      ORDER BY i.created_at, i.id`,
    [orderId],
  );

  const { rows: eventRows } = await on.query<{
    from_status: OrderStatus | null;
    to_status: OrderStatus;
    reason: string | null;
    note: string | null;
    actor_name: string | null;
    created_at: Date;
  }>(
    `SELECT e.from_status, e.to_status, e.reason, e.note, u.name AS actor_name, e.created_at
       FROM order_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.order_id = $1
      ORDER BY e.created_at, e.id`,
    [orderId],
  );

  return {
    ...item,
    lines: lineRows.map((line) => ({
      id: line.id,
      productName: line.product_name,
      variantLabel: line.variant_label,
      optionLabels: line.options ?? [],
      quantity: line.quantity,
      unitPrice: line.unit_price_amount,
      lineTotal: line.line_total_amount,
    })),
    subtotal: row.subtotal_amount,
    deliveryFee: row.delivery_fee_amount,
    discount: row.discount_amount,
    cashDue: row.cash_due_amount,
    cashReported: row.cash_reported_amount,
    riderId: row.rider_user_id,
    refundedAmount: row.refunded_amount,
    events: eventRows.map((e) => ({
      fromStatus: e.from_status,
      toStatus: e.to_status,
      reason: e.reason,
      note: e.note,
      actorName: e.actor_name,
      at: e.created_at,
    })),
  };
}

/** Riders this store has, for the picker — available ones first, each with what they are carrying right now. */
export type RiderOption = {
  id: string;
  name: string;
  availability: 'available' | 'off_duty';
  /** Orders with this rider right now: assigned to collect, or out for delivery. */
  activeJobs: number;
  /** Unconfirmed cash sitting with this rider on those jobs — what the picker calls "carrying". */
  cashCarried: string;
};

export async function availableRiders(storeId: string, on: Queryable = db): Promise<RiderOption[]> {
  const { rows } = await on.query<{
    id: string;
    name: string;
    availability: 'available' | 'off_duty';
    active_jobs: string;
    cash_carried: string;
  }>(
    `SELECT rp.user_id AS id, u.name, rp.availability,
            count(o.id)::text AS active_jobs,
            COALESCE(sum(o.cash_due_amount) FILTER (
              WHERE o.payment_method = 'cash' AND o.cash_confirmed_at IS NULL
            ), 0)::text AS cash_carried
       FROM rider_profiles rp
       JOIN users u ON u.id = rp.user_id
       LEFT JOIN orders o ON o.rider_user_id = rp.user_id AND o.store_id = rp.store_id
                          AND o.status IN ('assigned', 'out')
      WHERE rp.store_id = $1
      GROUP BY rp.user_id, u.name, rp.availability
      ORDER BY (rp.availability = 'available') DESC, u.name`,
    [storeId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    availability: r.availability,
    activeJobs: Number(r.active_jobs),
    cashCarried: r.cash_carried,
  }));
}

/** True when the primitive ran, false when the order was not in the state it needs. Null: no such order here. */
async function callTransition(
  fn: string,
  args: unknown[],
  tx: Queryable,
): Promise<boolean | null> {
  const { rows } = await tx.query<{ ok: boolean | null }>(
    `SELECT ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS ok`,
    args,
  );
  return rows[0]?.ok ?? null;
}

export async function decline(
  storeId: string,
  orderId: string,
  actor: Actor,
  reason: string,
  note: string | null,
  tx: Queryable,
): Promise<boolean | null> {
  return callTransition('decline_order', [orderId, storeId, actor.userId, actor.role, reason, note], tx);
}

export async function cancel(
  storeId: string,
  orderId: string,
  actor: Actor,
  reason: string,
  note: string | null,
  tx: Queryable,
): Promise<boolean | null> {
  return callTransition('cancel_order', [orderId, storeId, actor.userId, actor.role, reason, note], tx);
}

export async function startPreparing(storeId: string, orderId: string, actor: Actor, tx: Queryable): Promise<boolean | null> {
  return callTransition('start_preparing', [orderId, storeId, actor.userId, actor.role], tx);
}

export async function markReady(storeId: string, orderId: string, actor: Actor, tx: Queryable): Promise<boolean | null> {
  return callTransition('mark_ready', [orderId, storeId, actor.userId, actor.role], tx);
}

export async function assignRider(
  storeId: string,
  orderId: string,
  actor: Actor,
  riderUserId: string,
  tx: Queryable,
): Promise<boolean | null> {
  return callTransition('assign_rider', [orderId, storeId, actor.userId, actor.role, riderUserId], tx);
}

export async function markPickedUp(storeId: string, orderId: string, actor: Actor, tx: Queryable): Promise<boolean | null> {
  return callTransition('mark_picked_up', [orderId, storeId, actor.userId, actor.role], tx);
}

export async function markDelivered(storeId: string, orderId: string, actor: Actor, tx: Queryable): Promise<boolean | null> {
  return callTransition('mark_delivered', [orderId, storeId, actor.userId, actor.role], tx);
}

export async function markCollected(storeId: string, orderId: string, actor: Actor, tx: Queryable): Promise<boolean | null> {
  return callTransition('mark_collected', [orderId, storeId, actor.userId, actor.role], tx);
}

/** Confirming cash for a DELIVERED order — the rider is back, or the merchant heard from them. */
export async function confirmCash(
  orderId: string,
  reportedAmount: string,
  actor: Actor,
  tx: Queryable,
): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT confirm_cash_payment($1, $2, $3) AS ok`,
    [orderId, reportedAmount, actor.userId],
  );
  return rows[0]?.ok ?? false;
}

export async function closeReturn(
  storeId: string,
  orderId: string,
  actor: Actor,
  restock: boolean,
  tx: Queryable,
): Promise<boolean | null> {
  return callTransition('close_return', [orderId, storeId, actor.userId, actor.role, restock], tx);
}

export async function retryDelivery(storeId: string, orderId: string, actor: Actor, tx: Queryable): Promise<boolean | null> {
  return callTransition('retry_delivery', [orderId, storeId, actor.userId, actor.role], tx);
}

/** A refund asked straight from the order, no complaint needed. Returns the new refund's id, or null. */
export async function requestRefund(
  storeId: string,
  orderId: string,
  actor: Actor,
  amount: string,
  reasonCode: string,
  reasonNote: string | null,
  tx: Queryable,
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string | null }>(
    `SELECT request_refund($1, $2, $3, $4, $5, $6) AS id`,
    [orderId, storeId, actor.userId, amount, reasonCode, reasonNote],
  );
  return rows[0]?.id ?? null;
}
