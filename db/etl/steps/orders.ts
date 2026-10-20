// db/etl/steps/orders.ts — orders, lines, options and the one-event history (plan §5.5).
//
// The decisions the plan said to "decide once and write down":
//
//   STATUS (7 → 12). pending, approved, preparing, ready, delivered, rejected map to themselves. `assigned` stays
//   `assigned`: it would split into assigned/out, but nothing in the old data says whether a rider had picked the
//   parcel up, and calling an order "out" on a guess tells a customer something nobody knows. There is no source
//   for returned / collected / closed_return / cancelled, so none are produced.
//
//   TOTALS. The new order's total is GENERATED (subtotal + delivery − discount) and its subtotal must equal its
//   lines exactly. The old total was whatever the code summed. So the migrated lines carry the old items and
//   add-ons, and any difference becomes a DERIVED delivery fee (if the old total was higher) or discount (if lower),
//   recorded as a decision, so that total_amount reconciles to the cent in every case.
//
//   ADD-ON QUANTITIES. An old add-on had its own quantity, independent of the line's: three burgers could carry one
//   cheese. The new model prices options per unit. To keep the money exact the line is SPLIT into runs of units
//   that carry the same options — so "3 burgers, 1 cheese" becomes one row of 1 with cheese and one row of 2 without.
//
//   GUESTS AND CUSTOMERS. The old code stored the address only for guests. A signed-in customer's order has none, and
//   a new delivery order must have one, so those carry a stated placeholder rather than an invented address.

import { randomBytes } from 'node:crypto';
import { Ctx, Unmapped, cents, fromCents, read } from '../lib.ts';
import type { Catalogue } from './catalogue.ts';

type Order = {
  id: string; tenant_id: string; tracking_code: string; customer_id: string | null; guest_name: string | null; guest_phone: string | null;
  guest_address: string | null; guest_email: string | null; status: string; total_amount: string; payment_method: string; payment_status: string;
  delivery_type: string | null; external_rider_info: unknown; delivery_person_id: string | null; delivery_notes: string | null;
  created_at: Date; updated_at: Date | null; paid_at: Date | null; settlement_status: string; refunded_amount: string;
};
type Line = { id: string; order_id: string; menu_item_id: string; quantity: number; unit_price: string };
type LineAddOn = { id: string; order_item_id: string; add_on_id: string; quantity: number; unit_price: string };
type RefundRow = { order_id: string; status: string; amount: string | null };

const STATUS: Record<string, string> = {
  pending: 'pending', approved: 'approved', preparing: 'preparing', ready: 'ready', assigned: 'assigned', delivered: 'delivered', rejected: 'rejected',
};
const METHOD: Record<string, string> = { cash_on_delivery: 'cash', mobile_money: 'mtn_momo' };
const PLACEHOLDER_ADDRESS = 'Address not recorded (order migrated from the previous system)';

export type MigratedOrder = { id: string; storeId: string; total: string; paymentStatus: string; refunded: string };

export async function orders(ctx: Ctx, cat: Catalogue): Promise<Map<string, MigratedOrder>> {
  const rows = await read<Order>(ctx, 'orders', [
    'id', 'tenant_id', 'tracking_code', 'customer_id', 'guest_name', 'guest_phone', 'guest_address', 'guest_email', 'status', 'total_amount', 'payment_method',
    'payment_status', 'delivery_type', 'external_rider_info', 'delivery_person_id', 'delivery_notes', 'created_at', 'updated_at', 'paid_at', 'settlement_status', 'refunded_amount',
  ], 'tenant_id, created_at, id');
  const lines = await read<Line>(ctx, 'order_items', ['id', 'order_id', 'menu_item_id', 'quantity', 'unit_price'], 'order_id, id');
  const addOns = await read<LineAddOn>(ctx, 'order_item_addons', ['id', 'order_item_id', 'add_on_id', 'quantity', 'unit_price'], 'order_item_id, id');
  // orders.refunded_amount is dead in the old app — it is 0 on every row, including orders with a completed
  // refund_request. What was actually refunded is the sum of approved/completed refund_requests, not this column.
  const refundRows = await read<RefundRow>(ctx, 'refund_requests', ['order_id', 'status', 'amount'], 'order_id');
  const approvedRefundsByOrder = new Map<string, RefundRow[]>();
  for (const r of refundRows) {
    if (r.status !== 'approved' && r.status !== 'completed') continue;
    const a = approvedRefundsByOrder.get(r.order_id) ?? [];
    a.push(r);
    approvedRefundsByOrder.set(r.order_id, a);
  }
  let refundedAmountColumnWrongCount = 0;

  const linesByOrder = new Map<string, Line[]>();
  for (const l of lines) { const a = linesByOrder.get(l.order_id) ?? []; a.push(l); linesByOrder.set(l.order_id, a); }
  const addOnsByLine = new Map<string, LineAddOn[]>();
  for (const a of addOns) { const x = addOnsByLine.get(a.order_item_id) ?? []; x.push(a); addOnsByLine.set(a.order_item_id, x); }

  const riderStore = new Map<string, Set<string>>();
  for (const r of (await ctx.tgt.query<{ user_id: string; store_id: string }>(`SELECT user_id, store_id FROM store_members WHERE role = 'rider'`)).rows) {
    const s = riderStore.get(r.user_id) ?? new Set<string>();
    s.add(r.store_id);
    riderStore.set(r.user_id, s);
  }

  const result = new Map<string, MigratedOrder>();
  const counters = new Map<string, number>();
  let placeholderAddresses = 0;

  for (const o of rows) {
    const status = STATUS[o.status];
    if (status === undefined) throw new Unmapped(`order ${o.id} has status "${o.status}"`, 'Add it to the STATUS table in db/etl/steps/orders.ts.');
    const method = METHOD[o.payment_method];
    if (method === undefined) throw new Unmapped(`order ${o.id} was paid by "${o.payment_method}"`, 'The new system has no such payment method; decide what it becomes before migrating money.');
    if (!['unpaid', 'paid', 'refunded'].includes(o.payment_status)) throw new Unmapped(`order ${o.id} has payment status "${o.payment_status}"`, 'Unknown.');

    const number = (counters.get(o.tenant_id) ?? 0) + 1;
    counters.set(o.tenant_id, number);

    // ---- lines first: they decide the subtotal ----
    type NewRow = { quantity: number; unit: string; productId: string; options: { valueId: string; group: string; label: string; delta: string }[]; variantKey: string; chosenLabels: string[] };
    const newRows: NewRow[] = [];
    let oldLinesCents = 0n;
    for (const l of linesByOrder.get(o.id) ?? []) {
      const product = cat.products.get(l.menu_item_id);
      if (product === undefined) throw new Unmapped(`order line ${l.id} sells product ${l.menu_item_id}, which was not migrated`, 'The foreign key should prevent this.');
      const mine = addOnsByLine.get(l.id) ?? [];
      const n = l.quantity;
      oldLinesCents += cents(l.unit_price) * BigInt(n);
      for (const a of mine) oldLinesCents += cents(a.unit_price) * BigInt(a.quantity);

      type Placed = { ref: NonNullable<ReturnType<typeof cat.addOnValue.get>>; unit: bigint; q: number };
      const placed: Placed[] = [];
      for (const a of mine) {
        const ref = cat.addOnValue.get(`${l.menu_item_id}:${a.add_on_id}`);
        if (ref === undefined) {
          await ctx.archive('order_item_addons', a.id, o.tenant_id, 'this add-on is no longer offered on the product it was sold with, so it has no option value to point at; its amount is carried in the order total, not as an option', a);
          ctx.decide('orders', 'addon-unmapped', a.id, `Order ${o.id}: an add-on is no longer linked to the product; archived, and its amount flows into the derived adjustment.`);
          continue;
        }
        placed.push({ ref, unit: cents(a.unit_price), q: a.quantity });
      }

      // spread each add-on's quantity over the line's n units
      const signatures = new Map<string, { units: number; per: { p: Placed; count: number }[] }>();
      for (let j = 0; j < n; j++) {
        const per = placed.map((p) => ({ p, count: Math.floor(p.q / n) + (j < p.q % n ? 1 : 0) })).filter((x) => x.count > 0);
        const sig = per.map((x) => `${x.p.ref.valueId}x${x.count}`).join(',');
        const e = signatures.get(sig);
        if (e === undefined) signatures.set(sig, { units: 1, per });
        else e.units += 1;
      }
      for (const { units, per } of signatures.values()) {
        const chosenByGroup = new Map<string, string>();
        for (const x of per) if (x.p.ref.mode === 'one' && !chosenByGroup.has(x.p.ref.groupId)) chosenByGroup.set(x.p.ref.groupId, x.p.ref.valueId);
        const chosen: string[] = [];
        for (const g of product.oneGroups) {
          let v = chosenByGroup.get(g);
          if (v === undefined) {
            const first = [...cat.addOnValue.values()].find((r) => r.groupId === g);
            if (first === undefined) throw new Unmapped(`product ${l.menu_item_id} has a pick-one group with no values`, 'Cannot place an order line on it.');
            v = first.valueId;
            ctx.decide('orders', 'variant-guessed', l.id, `Order ${o.id}: the line was sold without choosing "${first.groupName}", which the product now requires; the first value (${first.label}) is recorded.`);
          }
          chosen.push(v);
        }
        const key = [...chosen].sort().join('+');
        if (!product.variants.has(key)) throw new Unmapped(`no variant for ${l.menu_item_id} / ${key}`, 'The variant matrix and the order lines disagree.');
        newRows.push({
          quantity: units, unit: l.unit_price, productId: l.menu_item_id, variantKey: key,
          chosenLabels: [],
          options: per.map((x) => ({ valueId: x.p.ref.valueId, group: x.p.ref.groupName, label: x.count > 1 ? `${x.p.ref.label} ×${x.count}` : x.p.ref.label, delta: fromCents(x.p.unit * BigInt(x.count)) })),
        });
      }
    }

    let newLinesCents = 0n;
    for (const r of newRows) {
      const opts = r.options.reduce((s, x) => s + cents(x.delta), 0n);
      newLinesCents += (cents(r.unit) + opts) * BigInt(r.quantity);
    }
    const oldTotal = cents(o.total_amount);
    let delivery = 0n;
    let discount = 0n;
    if (oldTotal > newLinesCents) {
      delivery = oldTotal - newLinesCents;
      ctx.decide('orders', 'derived-delivery-fee', o.id, `The old total (${o.total_amount}) is ${fromCents(delivery)} more than its items and add-ons; recorded as a delivery fee so the total is unchanged.`);
    } else if (oldTotal < newLinesCents) {
      discount = newLinesCents - oldTotal;
      ctx.decide('orders', 'derived-discount', o.id, `The old total (${o.total_amount}) is ${fromCents(discount)} less than its items and add-ons; recorded as a discount so the total is unchanged.`);
    }

    // ---- who ordered ----
    let customer: string | null = null;
    let guestName: string | null = null;
    let guestPhone: string | null = null;
    if (o.customer_id !== null) {
      customer = ctx.userMap.get(o.customer_id) ?? null;
      if (customer === null) throw new Unmapped(`order ${o.id} was placed by user ${o.customer_id}, who was not migrated`, 'Should be impossible.');
    } else {
      guestName = (o.guest_name ?? '').trim() === '' ? 'Guest' : o.guest_name!.trim();
      guestPhone = (o.guest_phone ?? '').trim() === '' ? 'not recorded' : o.guest_phone!.trim();
      if ((o.guest_name ?? '').trim() === '' || (o.guest_phone ?? '').trim() === '') ctx.decide('orders', 'guest-incomplete', o.id, 'A guest order had no name or phone; stated placeholders are stored.');
    }
    let address = o.guest_address;
    if (address === null || address.trim() === '') { address = PLACEHOLDER_ADDRESS; placeholderAddresses += 1; }

    // ---- payment ----
    let paymentStatus = o.payment_status;
    let refunded = 0n;
    for (const r of approvedRefundsByOrder.get(o.id) ?? []) refunded += r.amount !== null ? cents(r.amount) : oldTotal;
    if (refunded !== cents(o.refunded_amount)) refundedAmountColumnWrongCount += 1;
    if (refunded > 0n && paymentStatus === 'unpaid') {
      ctx.decide('orders', 'refund-on-unpaid', o.id, `This order was never paid but ${fromCents(refunded)} was refunded (and debited from the merchant's wallet) — the old bug described in plan §5.1. The new schema refuses a refund on an unpaid order, so refunded_amount is 0 here; the wallet's opening balance already includes the debit. Finance should decide whether to credit it back.`);
      await ctx.archive('orders', o.id, o.tenant_id, 'refund recorded against an unpaid order (old bug)', { refunded_amount: o.refunded_amount, payment_status: o.payment_status });
      refunded = 0n;
    }
    const net = oldTotal;
    if (paymentStatus === 'refunded' && refunded < net) {
      ctx.decide('orders', 'refunded-partial', o.id, 'Marked refunded but not refunded in full; kept as paid with the amount refunded.');
      paymentStatus = 'paid';
    }
    if (refunded > 0n && refunded >= net) paymentStatus = 'refunded';
    if (refunded > net) throw new Unmapped(`order ${o.id} refunded ${fromCents(refunded)} of ${o.total_amount}`, 'More than the order.');

    let paidAt: Date | null = o.paid_at;
    if (paymentStatus !== 'unpaid' && paidAt === null) { paidAt = o.updated_at ?? o.created_at; ctx.decide('orders', 'paid-at-guessed', o.id, 'Marked paid with no paid_at; the last update time is used.'); }
    if (paymentStatus === 'unpaid') paidAt = null;

    // ---- rider ----
    let rider: string | null = null;
    if (o.delivery_person_id !== null) {
      const mapped = ctx.userMap.get(o.delivery_person_id);
      if (mapped !== undefined && riderStore.get(mapped)?.has(o.tenant_id)) rider = mapped;
      else ctx.decide('orders', 'rider-dropped', o.id, 'The assigned rider is not a rider at this store any more; the order keeps its status without one.');
    }

    const trackingCode = `trk_${randomBytes(16).toString('hex')}`;
    await ctx.tgt.query(
      `INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key, customer_user_id, guest_name, guest_phone, guest_email,
                           delivery_address, fulfilment_type, status, payment_method, payment_status, settlement_status, currency,
                           subtotal_amount, delivery_fee_amount, discount_amount, refunded_amount, rider_user_id,
                           placed_at, paid_at, delivered_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'delivery',$11,$12,$13,$14,'RWF',$15,$16,$17,$18,$19,$20,$21,$22,$20,$23)`,
      [o.id, o.tenant_id, number, trackingCode, `migrated:${o.id}`, customer, guestName, guestPhone, o.guest_email, address,
       status, method, paymentStatus, o.settlement_status, fromCents(newLinesCents), fromCents(delivery), fromCents(discount), fromCents(refunded), rider,
       o.created_at, paidAt, status === 'delivered' ? (o.updated_at ?? o.created_at) : null, o.updated_at ?? o.created_at],
    );
    ctx.counter('orders').written += 1;

    if (discount > 0n) {
      // The new schema makes an order's discount the sum of discount rows, and a manual one needs an author: the store's owner.
      const owner = (await ctx.tgt.query<{ user_id: string }>(`SELECT user_id FROM store_members WHERE store_id = $1 AND role = 'owner' LIMIT 1`, [o.tenant_id])).rows[0]?.user_id;
      if (owner === undefined) throw new Unmapped(`order ${o.id} needs a discount row but its store has no owner`, 'The new schema records who gave a manual discount.');
      await ctx.tgt.query(
        `INSERT INTO order_discounts (order_id, store_id, source, amount, reason, created_by, created_at) VALUES ($1,$2,'manual',$3,$4,$5,$6)`,
        [o.id, o.tenant_id, fromCents(discount), 'Carried over from the previous system, whose total was lower than its items and add-ons by this amount', owner, o.created_at],
      );
    }
    await ctx.tgt.query(
      `INSERT INTO order_events (order_id, store_id, from_status, to_status, reason, created_at) VALUES ($1,$2,NULL,$3,'Migrated from the previous system; earlier history was not recorded there.',$4)`,
      [o.id, o.tenant_id, status, o.updated_at ?? o.created_at],
    );

    for (const r of newRows) {
      const product = cat.products.get(r.productId)!;
      const variant = product.variants.get(r.variantKey)!;
      const opts = r.options.reduce((s, x) => s + cents(x.delta), 0n);
      const item = await ctx.tgt.query<{ id: string }>(
        `INSERT INTO order_items (order_id, store_id, variant_id, product_name, variant_label, sku, unit_price_amount, options_amount, quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [o.id, o.tenant_id, variant.id, product.name, variant.label, variant.sku, r.unit, fromCents(opts), r.quantity],
      );
      ctx.counter('order_items').written += 1;
      for (const x of r.options) {
        await ctx.tgt.query(
          `INSERT INTO order_item_option_values (order_item_id, option_value_id, order_id, group_name, value_label, price_delta) VALUES ($1,$2,$3,$4,$5,$6)`,
          [item.rows[0]!.id, x.valueId, o.id, x.group, x.label, x.delta],
        );
      }
    }

    // What the old row said that the new one cannot hold — always kept, so a dispute can be answered.
    await ctx.archive('orders', o.id, o.tenant_id, 'the old tracking code and the columns with no home (external rider, delivery notes, delivery type, original status)', {
      tracking_code: o.tracking_code, new_tracking_code: trackingCode, status: o.status, delivery_type: o.delivery_type,
      external_rider_info: o.external_rider_info, delivery_notes: o.delivery_notes, original_total: o.total_amount,
    });

    result.set(o.id, { id: o.id, storeId: o.tenant_id, total: o.total_amount, paymentStatus, refunded: fromCents(refunded) });
  }

  for (const [store, next] of counters) {
    await ctx.tgt.query(
      `INSERT INTO store_order_counters (store_id, next_order_number) VALUES ($1, $2)
       ON CONFLICT (store_id) DO UPDATE SET next_order_number = EXCLUDED.next_order_number`,
      [store, next + 1],
    );
  }
  if (refundedAmountColumnWrongCount > 0) ctx.decide('orders', 'refunded-amount-derived', 'all', `${refundedAmountColumnWrongCount} order(s) had a stale orders.refunded_amount (the old app never wrote to it — it is 0 on every row in this source, including orders with a completed refund_request). The amount actually refunded is derived from approved/completed refund_requests instead.`);
  if (placeholderAddresses > 0) ctx.decide('orders', 'placeholder-address', 'all', `${placeholderAddresses} order(s) had no delivery address (the old code stored one only for guests) and carry the stated placeholder.`);
  ctx.decide('orders', 'status-map', 'all', 'pending, approved, preparing, ready, delivered, rejected map to themselves; assigned stays assigned (nothing says a rider had picked it up, so none become "out"). Orders carry one history event, "migrated". New tracking codes replace the old short ones; the old code and the new are kept together in legacy_rows, because links customers hold will not carry over.');
  ctx.decide('orders', 'currency', 'all', 'Every order is in RWF.');
  return result;
}
