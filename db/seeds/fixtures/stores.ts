// db/seeds/fixtures/stores.ts
//
// The six stores §4.5 names, and the settings that make each one's screens work.
//
// The state each store is in is not decoration. AdminMerchants draws three store
// statuses and the seed has one of each; the two pending ones exist so that the
// "payouts locked until verified" path has something to lock, which is the whole
// point of §5.4's note that a store can be ACTIVE with verification outstanding
// and PENDING is a different thing again.

import { STORE, STAFF, ZONE, PHONE, type Ctx } from './context.ts';

type StoreRow = {
  id: string;
  slug: string;
  name: string;
  template: string;
  status: 'pending' | 'active' | 'suspended';
  plan: string;
  why: string;
  /** V018. The tel: link on StoreDesktop's store-info panel. */
  phone?: string;
  /** V023. Where a rider collects from — not store_pickup_settings.address, which is customer-facing only. */
  address?: string;
  /**
   * V018. Opening hours as [day, opens, closes] with ISO day numbers, 1 = Monday.
   * A day with no entry is closed, so Inzu's missing Sunday IS its Sunday.
   */
  hours?: [number, string, string][];
};

/** Monday to Sunday at the same times — how most of these stores trade, and what "Daily 10:00-22:00" means. */
const daily = (opens: string, closes: string): [number, string, string][] =>
  [1, 2, 3, 4, 5, 6, 7].map((d) => [d, opens, closes]);

/** Monday to Saturday. The seventh day is absent rather than zeroed. */
const weekdaysAndSaturday = (opens: string, closes: string): [number, string, string][] =>
  [1, 2, 3, 4, 5, 6].map((d) => [d, opens, closes]);

const STORES: StoreRow[] = [
  {
    id: STORE.nyama, slug: 'nyama', name: 'Nyama & Co.', template: 'food',
    status: 'active', plan: 'growth',
    why: 'the demo store almost every board is drawn against',
    // Shop.dc.html's header reads "Open · closes 22:00" and StoreDesktop's panel "Daily 10:00-22:00".
    phone: '+250 78 000 0000', hours: daily('10:00', '22:00'),
    address: 'KG 7 Ave, Kimihurura',
  },
  {
    id: STORE.inzu, slug: 'inzu', name: 'Inzu Threads', template: 'fashion',
    status: 'active', plan: 'starter',
    why: 'the second industry, and the one carrying a real variant matrix',
    // StoreDesktop's clothing variant: "Open · closes 19:00", and shut on Sunday.
    phone: '+250 78 111 2020', hours: weekdaysAndSaturday('10:00', '19:00'),
    address: 'KG 5 Ave, Kimihurura',
  },
  {
    id: STORE.kicks, slug: 'kigali-kicks', name: 'Kigali Kicks', template: 'fashion',
    status: 'active', plan: 'starter',
    why: "ShoeStores' first palette — milestone 13 themes this one",
    // THE PAST-MIDNIGHT CASE, seeded so it is exercised by a real store rather than only by a unit
    // test: Friday and Saturday 18:00-01:00, which store_open_state() has to read as one session
    // spanning two days.
    phone: '+250 78 222 3030',
    hours: [[5, '18:00', '01:00'], [6, '18:00', '01:00']],
    address: 'KN 4 Ave, Nyarugenge',
  },
  {
    id: STORE.ubwiza, slug: 'ubwiza-beauty', name: 'Ubwiza Beauty', template: 'beauty',
    status: 'pending', plan: 'starter',
    why: 'identity check still being read — KYCOutcomes’ inReview',
  },
  {
    id: STORE.techhub, slug: 'kigali-tech-hub', name: 'Kigali Tech Hub', template: 'electronics',
    status: 'pending', plan: 'starter',
    why: 'a retake asked for — AdminKYC’s blurry ID back',
  },
  {
    id: STORE.deals4u, slug: 'deals4u', name: 'Deals4U', template: 'grocery',
    status: 'suspended', plan: 'starter',
    why: 'suspended for counterfeit goods — the audit log’s own example',
  },
];

export async function seedStores(ctx: Ctx): Promise<void> {
  ctx.step('Stores');

  for (const s of STORES) {
    await ctx.sql(
      `INSERT INTO stores (id, slug, name, country, selling_currency, status, plan_key,
                           public_phone, address, industry_template_id, industry_template_version)
       SELECT $1, $2, $3, 'RW', 'RWF', $4, $5, $7, $8, t.id, v.version
         FROM industry_templates t
         JOIN industry_template_versions v
           ON v.template_id = t.id AND v.status = 'published'
        WHERE t.key = $6
        ORDER BY v.version DESC
        LIMIT 1`,
      [s.id, s.slug, s.name, s.status, s.plan, s.template, s.phone ?? null, s.address ?? null],
    );
    for (const [day, opens, closes] of s.hours ?? []) {
      await ctx.sql(
        `INSERT INTO store_hours (store_id, day_of_week, opens_at, closes_at) VALUES ($1, $2, $3, $4)`,
        [s.id, day, opens, closes],
      );
    }
    ctx.info(`${s.name.padEnd(17)} ${s.status.padEnd(10)} ${s.template.padEnd(12)} ${s.why}`);
  }

  // A store's wallet is created by the trigger on stores, so there is nothing to
  // insert. Assert it rather than assume it: if that trigger ever stops firing,
  // every money fixture below would fail with something less obvious.
  const wallets = await ctx.sql<{ n: string }>(`SELECT count(*)::text AS n FROM wallets`);
  if (Number(wallets.rows[0]!.n) !== STORES.length) {
    throw new Error(`expected ${STORES.length} wallets from the stores trigger, found ${wallets.rows[0]!.n}`);
  }
  ctx.ok(`${STORES.length} stores, each with the wallet its trigger created`);

  const hours = await ctx.sql<{ n: string }>(`SELECT count(*)::text AS n FROM store_hours`);
  ctx.ok(
    `${hours.rows[0]!.n} opening-hour rows across 3 trading stores — Nyama daily, Inzu closed Sunday, ` +
      'Kicks 18:00–01:00 on Friday and Saturday (the past-midnight case)',
  );

  // ------------------------------------------------------------------
  // Delivery zones — Settings' own example, down to the areas and the ETA.
  // ------------------------------------------------------------------
  await ctx.sql(
    `INSERT INTO delivery_zones (id, store_id, name, fee_amount, eta_min_minutes, eta_max_minutes, position) VALUES
       ($1, $4, 'Kigali city centre', 1000, 25, 35, 1),
       ($2, $4, 'Outer Kigali',       2000, 40, 60, 2),
       ($3, $5, 'Kigali',             2000, 60, 120, 1)`,
    [ZONE.centre, ZONE.suburbs, ZONE.inzuCity, STORE.nyama, STORE.inzu],
  );
  await ctx.sql(
    `INSERT INTO delivery_zone_areas (zone_id, store_id, area_name) VALUES
       ($1, $4, 'Kacyiru'), ($1, $4, 'Kimihurura'), ($1, $4, 'Kiyovu'), ($1, $4, 'Nyarutarama'),
       ($2, $4, 'Kicukiro'), ($2, $4, 'Remera'), ($2, $4, 'Gisozi'),
       ($3, $5, 'Kimihurura'), ($3, $5, 'Kacyiru'), ($3, $5, 'Nyamirambo')`,
    [ZONE.centre, ZONE.suburbs, ZONE.inzuCity, STORE.nyama, STORE.inzu],
  );
  ctx.ok('3 delivery zones over 10 named areas');

  // ------------------------------------------------------------------
  // Pickup, payments and payouts.
  // ------------------------------------------------------------------
  await ctx.sql(
    `INSERT INTO store_pickup_settings (store_id, address, ready_minutes, instructions) VALUES
       ($1, 'KG 7 Ave, Kacyiru', 15, 'Ask at the counter for your order number.'),
       ($2, 'KG 5 Ave, Kimihurura', 1440, 'Ready tomorrow from 10:00.')`,
    [STORE.nyama, STORE.inzu],
  );

  // Only the live providers, and only for stores that have connected them. Cards
  // are deliberately absent: AdminPayments has no card processor, so there is no
  // payment_methods row to connect (Part 9).
  await ctx.sql(
    `INSERT INTO store_payment_methods (store_id, payment_method_key, is_connected, connected_at) VALUES
       ($1, 'mtn_momo',    true,  now() - interval '120 days'),
       ($1, 'airtel_money',true,  now() - interval '90 days'),
       ($1, 'cash',        true,  now() - interval '120 days'),
       ($2, 'mtn_momo',    true,  now() - interval '80 days'),
       ($2, 'cash',        true,  now() - interval '80 days'),
       ($3, 'mtn_momo',    true,  now() - interval '30 days'),
       ($4, 'mtn_momo',    false, NULL),
       ($5, 'mtn_momo',    false, NULL)`,
    [STORE.nyama, STORE.inzu, STORE.kicks, STORE.ubwiza, STORE.techhub],
  );

  await ctx.sql(
    `INSERT INTO store_payout_settings (store_id, payout_method_key, payout_phone, settlement_mode, automatic_at) VALUES
       ($1, 'mtn_momo', $4, 'automatic', '08:00'),
       ($2, 'mtn_momo', $5, 'manual',    NULL),
       ($3, 'mtn_momo', '078 555 9001', 'manual', NULL)`,
    [STORE.nyama, STORE.inzu, STORE.kicks, PHONE.aline, PHONE.kevin],
  );
  ctx.ok('pickup for 2 stores, 8 connected payment methods, payouts for 3');

  // A store that has not connected anything and is suspended still needs to appear
  // on AdminMerchants, which is why Deals4U has a row and no settings at all.
  void STAFF;
}
