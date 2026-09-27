// db/seeds/fixtures/orders.ts
//
// One order in each of the twelve statuses, plus the seven the money and support
// fixtures argue from.
//
// EVERY ORDER IS WALKED, never inserted in its final state. `orders_status_transition`
// refuses a jump that `order_status_transitions` does not list, so an order that
// ends up `closed_return` got there through approved → preparing → ready → assigned
// → out → returned → closed_return, one UPDATE at a time, with an `order_events` row
// for each. That costs a few more statements and buys two things: the seeded
// timeline is a real timeline, and the seed is a test of the state machine — if a
// later migration removes a transition, this program stops working, loudly.
//
// The paths are the board's own. `collected` comes off `ready` (a customer picked it
// up) and never has a rider; `delivered` comes off `out` and always does.

import { STORE, STAFF, CUSTOMER, PRODUCT, ORDER, GROUP, PHONE, type Ctx } from './context.ts';

/** Every legal route from `pending` to a target, as the transitions table allows. */
const PATHS: Record<string, string[]> = {
  pending: [],
  approved: ['approved'],
  preparing: ['approved', 'preparing'],
  ready: ['approved', 'preparing', 'ready'],
  assigned: ['approved', 'preparing', 'ready', 'assigned'],
  out: ['approved', 'preparing', 'ready', 'assigned', 'out'],
  delivered: ['approved', 'preparing', 'ready', 'assigned', 'out', 'delivered'],
  collected: ['approved', 'preparing', 'ready', 'collected'],
  returned: ['approved', 'preparing', 'ready', 'assigned', 'out', 'returned'],
  closed_return: ['approved', 'preparing', 'ready', 'assigned', 'out', 'returned', 'closed_return'],
  rejected: ['rejected'],
  cancelled: ['cancelled'],
};

/** Which statuses need a rider on the order before they are legal. */
const NEEDS_RIDER = new Set(['assigned', 'out', 'delivered', 'returned', 'closed_return']);

type Line = { product: string; variantSku?: string | null; qty: number; options?: string[] };

export type OrderSpec = {
  id: string;
  store: string;
  status: string;
  /** A signed-in customer, or a guest with a name and phone. */
  customer?: string;
  guest?: { name: string; phone: string };
  fulfilment: 'delivery' | 'pickup';
  address?: string;
  payment: 'mtn_momo' | 'airtel_money' | 'cash';
  lines: Line[];
  rider?: string;
  /** Minutes ago the order was placed, so the board has a spread of ages. */
  placedMinutesAgo: number;
  reason?: string;
  note?: string;
};

const ORDERS: OrderSpec[] = [
  // ---- the twelve statuses -------------------------------------------------
  {
    id: ORDER.pending, store: STORE.nyama, status: 'pending', customer: CUSTOMER.aimable,
    fulfilment: 'delivery', address: 'KG 11 Ave, Kimihurura', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.chickenBurger, qty: 2, options: ['Extra cheese'] }, { product: PRODUCT.fries, qty: 1 }],
    placedMinutesAgo: 2,
  },
  {
    id: ORDER.approved, store: STORE.nyama, status: 'approved', customer: CUSTOMER.sandrine,
    fulfilment: 'delivery', address: 'KG 9 Ave, Kacyiru', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.grilledChicken, qty: 1, variantSku: 'CHK-FRI' }],
    placedMinutesAgo: 9,
  },
  {
    id: ORDER.preparing, store: STORE.nyama, status: 'preparing', customer: CUSTOMER.pacifique,
    fulfilment: 'delivery', address: 'KG 7 Ave, Kiyovu', payment: 'airtel_money',
    lines: [{ product: PRODUCT.brochettePlate, qty: 1 }, { product: PRODUCT.passionJuice, qty: 2 }],
    placedMinutesAgo: 18,
  },
  {
    id: ORDER.ready, store: STORE.nyama, status: 'ready', guest: { name: 'Didier N.', phone: '078 707 1188' },
    fulfilment: 'delivery', address: 'KG 200 St, Nyarutarama', payment: 'cash',
    lines: [{ product: PRODUCT.beefBurger, qty: 1 }],
    placedMinutesAgo: 26,
  },
  {
    id: ORDER.assigned, store: STORE.nyama, status: 'assigned', customer: CUSTOMER.grace,
    fulfilment: 'delivery', address: 'KG 15 Ave, Remera', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.chickenBurger, qty: 3 }], rider: STAFF.eric,
    placedMinutesAgo: 34,
  },
  {
    id: ORDER.out, store: STORE.nyama, status: 'out', customer: CUSTOMER.jeanpaul,
    fulfilment: 'delivery', address: 'KG 21 Ave, Gisozi', payment: 'cash',
    lines: [{ product: PRODUCT.grilledChicken, qty: 1, variantSku: 'CHK-PLA' }, { product: PRODUCT.chapati, qty: 2 }],
    rider: STAFF.claude, placedMinutesAgo: 41,
  },
  {
    id: ORDER.delivered, store: STORE.nyama, status: 'delivered', customer: CUSTOMER.sandrine,
    fulfilment: 'delivery', address: 'KG 9 Ave, Kacyiru', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.veggieWrap, qty: 1 }], rider: STAFF.claude,
    placedMinutesAgo: 190,
  },
  {
    // Pickup, so no rider and no address — the constraint refuses both.
    id: ORDER.collected, store: STORE.nyama, status: 'collected', customer: CUSTOMER.pacifique,
    fulfilment: 'pickup', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.mangoJuice, qty: 2 }, { product: PRODUCT.chapati, qty: 1 }],
    placedMinutesAgo: 240,
  },
  {
    id: ORDER.returned, store: STORE.inzu, status: 'returned', customer: CUSTOMER.alice,
    fulfilment: 'delivery', address: 'KG 5 Ave, Kimihurura', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.kitengeShirt, qty: 1 }], rider: STAFF.fabrice,
    placedMinutesAgo: 1_500, reason: 'nobody_home',
    note: 'Nobody answering. Brought back to the shop.',
  },
  {
    id: ORDER.closedReturn, store: STORE.inzu, status: 'closed_return', customer: CUSTOMER.alice,
    fulfilment: 'delivery', address: 'KG 5 Ave, Kimihurura', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.canvasTote, qty: 1 }], rider: STAFF.fabrice,
    placedMinutesAgo: 4_300, reason: 'wrong_address',
    note: 'Return closed: back on the shelf, customer refunded.',
  },
  {
    id: ORDER.rejected, store: STORE.nyama, status: 'rejected', customer: CUSTOMER.aimable,
    fulfilment: 'delivery', address: 'KG 11 Ave, Kimihurura', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.brochettePlate, qty: 2 }],
    placedMinutesAgo: 300, reason: 'out_of_stock',
    note: 'An item is out of stock · customer refunded',
  },
  {
    id: ORDER.cancelled, store: STORE.nyama, status: 'cancelled', guest: { name: 'Solange U.', phone: '078 404 2299' },
    fulfilment: 'pickup', payment: 'cash',
    lines: [{ product: PRODUCT.fries, qty: 2 }],
    placedMinutesAgo: 420, reason: 'customer_changed_mind',
    note: 'Customer called to cancel before it was accepted.',
  },

  // ---- the ones the money and support fixtures hang off --------------------
  {
    id: ORDER.paidEscrow, store: STORE.nyama, status: 'delivered', customer: CUSTOMER.pacifique,
    fulfilment: 'delivery', address: 'KG 7 Ave, Kiyovu', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.grilledChicken, qty: 1 }, { product: PRODUCT.fries, qty: 1 }],
    rider: STAFF.claude, placedMinutesAgo: 25,
  },
  {
    id: ORDER.paidReleased, store: STORE.nyama, status: 'delivered', customer: CUSTOMER.sandrine,
    fulfilment: 'delivery', address: 'KG 9 Ave, Kacyiru', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.grilledChicken, qty: 1 }, { product: PRODUCT.salad, qty: 1 }, { product: PRODUCT.fries, qty: 1 }],
    rider: STAFF.claude, placedMinutesAgo: 2_880,
  },
  {
    // Cash, and the rider hands in less than the total — CashReport's shortfall.
    id: ORDER.cashShort, store: STORE.nyama, status: 'delivered', guest: { name: 'Emmanuel R.', phone: '078 818 3310' },
    fulfilment: 'delivery', address: 'KG 33 Ave, Kicukiro', payment: 'cash',
    lines: [{ product: PRODUCT.brochettePlate, qty: 2 }],
    rider: STAFF.olivier, placedMinutesAgo: 1_700,
  },
  {
    id: ORDER.inzuRefunded, store: STORE.inzu, status: 'delivered', customer: CUSTOMER.alice,
    fulfilment: 'delivery', address: 'KG 5 Ave, Kimihurura', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.linenTee, variantSku: 'TEE-M-BLA', qty: 1 }],
    rider: STAFF.fabrice, placedMinutesAgo: 5_800,
  },
  {
    id: ORDER.techDisputed, store: STORE.techhub, status: 'delivered', customer: CUSTOMER.hirwa,
    fulfilment: 'delivery', address: 'KG 2 Ave, Nyarugenge', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.earbuds, qty: 1 }],
    placedMinutesAgo: 3_100,
  },
  {
    id: ORDER.discounted, store: STORE.nyama, status: 'delivered', customer: CUSTOMER.grace,
    fulfilment: 'delivery', address: 'KG 15 Ave, Remera', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.grilledChicken, qty: 1 }, { product: PRODUCT.mangoJuice, qty: 1 }],
    rider: STAFF.eric, placedMinutesAgo: 1_200,
  },
  {
    id: ORDER.lunchOffer, store: STORE.nyama, status: 'collected', customer: CUSTOMER.jeanpaul,
    fulfilment: 'pickup', payment: 'mtn_momo',
    lines: [{ product: PRODUCT.chickenBurger, qty: 2 }, { product: PRODUCT.fries, qty: 1 }],
    placedMinutesAgo: 900,
  },
];

/** Resolve a line to its variant, its captured price and its captured labels. */
async function resolveLine(ctx: Ctx, store: string, line: Line) {
  const variant = await ctx.sql<{ id: string; label: string; sku: string | null }>(
    line.variantSku
      ? `SELECT v.id, COALESCE(string_agg(ov.label, ' / ' ORDER BY og.position), '') AS label, v.sku
           FROM product_variants v
           LEFT JOIN product_variant_values pvv ON pvv.variant_id = v.id
           LEFT JOIN option_values ov ON ov.id = pvv.option_value_id
           LEFT JOIN option_groups og ON og.id = pvv.option_group_id
          WHERE v.product_id = $1 AND v.sku = $2
          GROUP BY v.id, v.sku`
      : `SELECT v.id, '' AS label, v.sku FROM product_variants v
          WHERE v.product_id = $1 AND v.is_default LIMIT 1`,
    line.variantSku ? [line.product, line.variantSku] : [line.product],
  );
  if (variant.rows.length === 0) throw new Error(`no variant for product ${line.product} (${line.variantSku ?? 'default'})`);

  const product = await ctx.sql<{ name: string; base_price: string }>(
    `SELECT name, base_price::text FROM products WHERE id = $1`,
    [line.product],
  );

  // The chosen `several` options, with the deltas AS THEY ARE NOW — captured,
  // because V004 stores what was charged rather than what the price list says today.
  const chosen: { id: string; label: string; groupName: string; delta: number }[] = [];
  for (const label of line.options ?? []) {
    const value = await ctx.sql<{ id: string; label: string; price_delta: string; select_mode: string; group_name: string }>(
      `SELECT ov.id, ov.label, ov.price_delta::text, og.select_mode, og.name AS group_name
         FROM option_values ov JOIN option_groups og ON og.id = ov.option_group_id
        WHERE ov.store_id = $1 AND ov.label = $2`,
      [store, label],
    );
    const row = value.rows[0];
    if (!row) throw new Error(`no option value named ${label} at store ${store}`);
    // Only `several` deltas reach options_amount — a `one` group is a variant
    // dimension and its price is already in the variant's own line.
    chosen.push({
      id: row.id, label: row.label, groupName: row.group_name,
      delta: row.select_mode === 'several' ? Number(row.price_delta) : 0,
    });
  }

  const optionsAmount = chosen.reduce((n, c) => n + c.delta, 0);
  return {
    variantId: variant.rows[0]!.id,
    variantLabel: variant.rows[0]!.label,
    sku: variant.rows[0]!.sku,
    productName: product.rows[0]!.name,
    unitPrice: Number(product.rows[0]!.base_price),
    optionsAmount,
    chosen,
  };
}

/** Move an order one legal step, and record it. */
export async function advance(
  ctx: Ctx,
  order: { id: string; store: string },
  to: string,
  opts: { actor?: string | null; actorRole?: string | null; reason?: string | null; note?: string | null } = {},
): Promise<void> {
  const from = await ctx.sql<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [order.id]);
  const previous = from.rows[0]!.status;

  await ctx.sql(
    `UPDATE orders
        SET status = $2,
            delivered_at = CASE WHEN $2 IN ('delivered', 'collected') THEN COALESCE(delivered_at, now()) ELSE delivered_at END
      WHERE id = $1`,
    [order.id, to],
  );

  await ctx.sql(
    `INSERT INTO order_events (order_id, store_id, from_status, to_status, reason, note, actor_id, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [order.id, order.store, previous, to, opts.reason ?? null, opts.note ?? null, opts.actor ?? null, opts.actorRole ?? null],
  );
}

export async function seedOrders(ctx: Ctx): Promise<void> {
  ctx.step('Orders');

  for (const spec of ORDERS) {
    // Sequentially: one pg Client cannot have two queries in flight, and Promise.all
    // over a single connection is the deprecation warning that says so.
    const resolved: Awaited<ReturnType<typeof resolveLine>>[] = [];
    for (const line of spec.lines) resolved.push(await resolveLine(ctx, spec.store, line));
    const subtotal = resolved.reduce((n, r, i) => n + (r.unitPrice + r.optionsAmount) * spec.lines[i]!.qty, 0);

    // The delivery fee is the zone's, so the totals a developer sees on screen add
    // up the way the storefront would have added them up.
    const fee = spec.fulfilment === 'delivery'
      ? Number(
          (
            await ctx.sql<{ fee: string }>(
              `SELECT COALESCE(min(fee_amount), 0)::text AS fee FROM delivery_zones WHERE store_id = $1 AND is_active`,
              [spec.store],
            )
          ).rows[0]!.fee,
        )
      : 0;

    // cash_due_amount is NOT set here, and that is the point of V019: the database derives it from the
    // total, and re-derives it when the discounts applied later change that total. The seed setting it
    // would be the seed asserting a figure it computed before the discount existed — which is exactly the
    // bug that turned the column from checked into derived.
    await ctx.sql(
      `INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key,
                           customer_user_id, guest_name, guest_phone,
                           delivery_address, fulfilment_type, payment_method, currency,
                           subtotal_amount, delivery_fee_amount, placed_at, created_at)
       VALUES ($1, $2, next_order_number($2), $3, $4, $5, $6, $7, $8, $9, $10, 'RWF', $11, $12,
               now() - make_interval(mins => $13), now() - make_interval(mins => $13))`,
      [
        spec.id, spec.store,
        `trk_${spec.id.slice(0, 8)}${spec.id.slice(-4)}`,
        `seed_${spec.id}`,
        spec.customer ?? null, spec.guest?.name ?? null, spec.guest?.phone ?? null,
        spec.fulfilment === 'delivery' ? (spec.address ?? 'KG 1 Ave, Kigali') : null,
        spec.fulfilment, spec.payment, subtotal, fee, spec.placedMinutesAgo,
      ],
    );

    for (const [i, r] of resolved.entries()) {
      const line = spec.lines[i]!;
      const item = await ctx.sql<{ id: string }>(
        `INSERT INTO order_items (order_id, store_id, variant_id, product_name, variant_label, sku,
                                  unit_price_amount, options_amount, quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [spec.id, spec.store, r.variantId, r.productName, r.variantLabel, r.sku,
         r.unitPrice, r.optionsAmount, line.qty],
      );
      for (const c of r.chosen) {
        await ctx.sql(
          `INSERT INTO order_item_option_values (order_item_id, option_value_id, order_id,
                                                group_name, value_label, price_delta)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [item.rows[0]!.id, c.id, spec.id, c.groupName, c.label, c.delta],
        );
      }
    }

    // A rider has to be on the order before `assigned` is legal.
    if (spec.rider && NEEDS_RIDER.has(spec.status)) {
      await ctx.sql(`UPDATE orders SET rider_user_id = $2 WHERE id = $1`, [spec.id, spec.rider]);
    }

    const path = PATHS[spec.status];
    if (!path) throw new Error(`no path to status ${spec.status}`);
    for (const [i, to] of path.entries()) {
      const last = i === path.length - 1;
      await advance(ctx, { id: spec.id, store: spec.store }, to, {
        actor: to === 'out' || to === 'delivered' || to === 'returned' ? spec.rider ?? null : STAFF.patrick,
        actorRole: to === 'out' || to === 'delivered' || to === 'returned' ? 'rider' : 'manager',
        reason: last ? spec.reason ?? null : null,
        note: last ? spec.note ?? null : null,
      });
    }
  }

  const byStatus = await ctx.sql<{ covered: string; total: string }>(
    `SELECT count(DISTINCT status)::text AS covered, count(*)::text AS total FROM orders`,
  );
  const covered = Number(byStatus.rows[0]!.covered);
  if (covered !== 12) {
    const missing = await ctx.sql<{ status: string }>(
      `SELECT t.status FROM (SELECT DISTINCT to_status AS status FROM order_status_transitions
                              UNION SELECT 'pending') t
        WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.status = t.status)`,
    );
    throw new Error(`orders cover ${covered} of 12 statuses; missing: ${missing.rows.map((r) => r.status).join(', ')}`);
  }

  ctx.ok(`${byStatus.rows[0]!.total} orders covering all 12 statuses, each walked through the machine`);
  void { GROUP, PHONE };
}
