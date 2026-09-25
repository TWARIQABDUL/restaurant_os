// db/seeds/fixtures/volume.ts
//
// The generated orders, which exist for one reason: milestone 10's done-when is
// "a sequential scan is visibly slower than an index scan", and on an empty table
// every plan is fast and every index looks pointless.
//
// Part 8 rates "indexes chosen without evidence" as high risk — a wrong index taxes
// every write forever and is invisible until it isn't. The only way to hold that
// line is to have something to run EXPLAIN against, and the only honest way to get
// it is rows that look like real ones: spread over months, skewed towards recent,
// mostly finished but some still moving, with the same status mix a real week has.
//
// TWO THINGS MAKE THIS FAST ENOUGH TO LIVE WITH.
//
// 1. Batched transactions. Every order carries deferred constraint triggers — the
//    subtotal against its lines, the discount against its rows — which fire at
//    COMMIT, one per affected row. Thirty thousand orders in a single transaction
//    means holding thirty thousand queued trigger events and then running them all
//    at once. In batches of a thousand it is steady and the memory is bounded.
//
// 2. Set-based inserts. Each batch is four statements — orders, items, events, and
//    the paid ones' status walk — built with generate_series and UNNEST rather than
//    a round trip per row. The hand-written fixtures above are one statement per row
//    because they are meant to be read; these are not.
//
// What it does NOT do is move money. Thirty thousand ledger chains would take
// minutes and prove nothing the money fixtures have not already proved on six rows.

import { STORE, CUSTOMER, PRODUCT, type Ctx } from './context.ts';

const BATCH = 1_000;

// The mix a real week has, near enough: most orders finish, a few are refused, and a
// handful are always in flight. The weights are counts out of 100.
const MIX: [string, number][] = [
  ['delivered', 58],
  ['collected', 14],
  ['rejected', 7],
  ['cancelled', 6],
  ['returned', 3],
  ['closed_return', 2],
  ['pending', 3],
  ['approved', 2],
  ['preparing', 2],
  ['ready', 1],
  ['assigned', 1],
  ['out', 1],
];

/** The walk each status needs, as a Postgres array literal of intermediate steps. */
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

const NEEDS_RIDER = new Set(['assigned', 'out', 'delivered', 'returned', 'closed_return']);

/**
 * Each step and the status it comes from. Every path above agrees on this — `ready`
 * is only ever reached from `preparing`, `collected` only from `ready` — which is
 * what lets the walk be one statement per step for the whole batch.
 */
const WALK: [string, string][] = [
  ['approved', 'pending'],
  ['preparing', 'approved'],
  ['ready', 'preparing'],
  ['assigned', 'ready'],
  ['out', 'assigned'],
  ['delivered', 'out'],
  ['collected', 'ready'],
  ['returned', 'out'],
  ['closed_return', 'returned'],
  ['rejected', 'pending'],
  ['cancelled', 'pending'],
];

export async function seedVolume(ctx: Ctx): Promise<void> {
  if (ctx.volume === 0) {
    ctx.step('Volume');
    ctx.info('skipped — SEED_ORDERS=0, so only the hand-written fixtures exist');
    ctx.info('EXPLAIN against this database will show sequential scans, correctly');
    return;
  }

  ctx.step('Volume');
  ctx.info(`generating ${ctx.volume.toLocaleString()} orders in batches of ${BATCH.toLocaleString()}`);

  // Pull the ids the generator picks from, once.
  const variants = await ctx.sql<{ id: string; store_id: string; name: string; base_price: string }>(
    `SELECT v.id, v.store_id, p.name, p.base_price::text
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.store_id = ANY ($1) AND v.is_default AND p.status = 'active'`,
    [[STORE.nyama, STORE.inzu]],
  );
  if (variants.rows.length === 0) throw new Error('no variants to generate orders against');

  const riders = await ctx.sql<{ user_id: string }>(
    `SELECT user_id FROM rider_profiles WHERE store_id = $1`,
    [STORE.nyama],
  );

  // A status for every order, in a fixed pattern rather than at random: a seed that
  // produces different data each run is a seed that makes a bug irreproducible.
  const ladder: string[] = [];
  for (const [status, weight] of MIX) for (let i = 0; i < weight; i += 1) ladder.push(status);

  const started = Date.now();
  let written = 0;

  for (let offset = 0; offset < ctx.volume; offset += BATCH) {
    const size = Math.min(BATCH, ctx.volume - offset);
    await ctx.client.query('BEGIN');

    // One row per order, assembled here and sent as arrays.
    const ids: string[] = [];
    const stores: string[] = [];
    const customers: (string | null)[] = [];
    const statuses: string[] = [];
    const riderIds: (string | null)[] = [];
    const minutesAgo: number[] = [];
    const variantIds: string[] = [];
    const productNames: string[] = [];
    const prices: number[] = [];
    const quantities: number[] = [];
    const fulfilments: string[] = [];

    const CUSTOMERS = [CUSTOMER.sandrine, CUSTOMER.pacifique, CUSTOMER.jeanpaul, CUSTOMER.grace, CUSTOMER.aimable];

    for (let i = 0; i < size; i += 1) {
      const n = offset + i;
      const status = ladder[n % ladder.length]!;
      const variant = variants.rows[n % variants.rows.length]!;
      const qty = (n % 3) + 1;

      // Skewed towards recent: half the orders are in the last three weeks, the rest
      // spread back six months, so "this week" and "last 90 days" both have shape.
      const span = n % 2 === 0 ? 21 * 24 * 60 : 180 * 24 * 60;
      const age = ((n * 7919) % span) + 60; // 7919 is prime, so the spread is even

      ids.push(`aaaa${(n + 1).toString(16).padStart(4, '0')}-0000-4000-8000-${(n + 1).toString(16).padStart(12, '0')}`);
      stores.push(variant.store_id);
      customers.push(n % 4 === 0 ? null : CUSTOMERS[n % CUSTOMERS.length]!);
      statuses.push(status);
      riderIds.push(
        NEEDS_RIDER.has(status) && riders.rows.length > 0 && variant.store_id === STORE.nyama
          ? riders.rows[n % riders.rows.length]!.user_id
          : null,
      );
      minutesAgo.push(age);
      variantIds.push(variant.id);
      productNames.push(variant.name);
      prices.push(Number(variant.base_price));
      quantities.push(qty);
      // A rider needs a delivery; everything else alternates so pickup has volume too.
      fulfilments.push(NEEDS_RIDER.has(status) || n % 3 !== 0 ? 'delivery' : 'pickup');
    }

    await ctx.client.query(
      `INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key,
                           customer_user_id, guest_name, guest_phone,
                           delivery_address, fulfilment_type, payment_method, currency,
                           subtotal_amount, delivery_fee_amount, rider_user_id, placed_at, created_at)
       SELECT d.id, d.store_id, next_order_number(d.store_id),
              'trk_' || replace(d.id::text, '-', '') ,
              'seed_vol_' || d.id::text,
              d.customer,
              CASE WHEN d.customer IS NULL THEN 'Walk-in ' || d.n::text END,
              CASE WHEN d.customer IS NULL THEN '078 900 ' || lpad((d.n % 10000)::text, 4, '0') END,
              CASE WHEN d.fulfilment = 'delivery' THEN 'KG ' || ((d.n % 90) + 1)::text || ' Ave, Kigali' END,
              d.fulfilment,
              CASE WHEN d.n % 5 = 0 THEN 'cash' ELSE 'mtn_momo' END,
              'RWF',
              d.price * d.qty,
              CASE WHEN d.fulfilment = 'delivery' THEN 1000 ELSE 0 END,
              d.rider,
              now() - make_interval(mins => d.minutes),
              now() - make_interval(mins => d.minutes)
         FROM (
           SELECT * FROM unnest(
             $1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::int[],
             $6::numeric[], $7::int[], $8::text[], $9::int[]
           ) AS t(id, store_id, customer, rider, minutes, price, qty, fulfilment, n)
         ) d`,
      [ids, stores, customers, riderIds, minutesAgo, prices, quantities, fulfilments,
       Array.from({ length: size }, (_, i) => offset + i + 1)],
    );

    await ctx.client.query(
      `INSERT INTO order_items (order_id, store_id, variant_id, product_name, unit_price_amount, quantity)
       SELECT d.id, d.store_id, d.variant, d.name, d.price, d.qty
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::numeric[], $6::int[])
              AS d(id, store_id, variant, name, price, qty)`,
      [ids, stores, variantIds, productNames, prices, quantities],
    );

    // The walk, as one statement per STEP rather than per order: each statement
    // moves every order in the batch that is exactly one legal step away, so
    // `closed_return` costs seven statements for a thousand orders instead of seven
    // thousand. The order of these statements IS the path, and the transition
    // trigger refuses any of them that is out of turn.
    for (const [step, from] of WALK) {
      const batchIds = ids.filter((_, i) => PATHS[statuses[i]!]!.includes(step));
      if (batchIds.length === 0) continue;

      await ctx.client.query(
        `WITH moved AS (
           UPDATE orders
              SET status = $1,
                  delivered_at = CASE WHEN $1 IN ('delivered', 'collected')
                                      THEN placed_at + interval '35 minutes'
                                      ELSE delivered_at END
            WHERE id = ANY ($2) AND status = $3
            RETURNING id, store_id, placed_at
         )
         INSERT INTO order_events (order_id, store_id, from_status, to_status, created_at)
         SELECT id, store_id, $3, $1, placed_at + interval '2 minutes' FROM moved`,
        [step, batchIds, from],
      );
    }

    await ctx.client.query('COMMIT');
    written += size;

    if (written % 5_000 === 0 || written === ctx.volume) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      ctx.info(`  ${written.toLocaleString()} / ${ctx.volume.toLocaleString()} after ${elapsed}s`);
    }
  }

  const spread = await ctx.sql<{ statuses: string; oldest: string; newest: string }>(
    `SELECT count(DISTINCT status)::text AS statuses,
            to_char(min(placed_at), 'YYYY-MM-DD') AS oldest,
            to_char(max(placed_at), 'YYYY-MM-DD') AS newest
       FROM orders`,
  );
  ctx.ok(
    `${written.toLocaleString()} generated orders across ${spread.rows[0]!.statuses} statuses, ` +
      `${spread.rows[0]!.oldest} to ${spread.rows[0]!.newest}`,
  );
  void PRODUCT;
}
