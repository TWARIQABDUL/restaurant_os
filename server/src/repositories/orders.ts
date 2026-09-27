// server/src/repositories/orders.ts — milestone 17.
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
