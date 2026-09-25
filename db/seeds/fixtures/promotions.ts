// db/seeds/fixtures/promotions.ts
//
// Promo codes and the two automatic offers, in every state States.dc.html draws —
// because "that code doesn't exist" and "FRIDAY20 ended yesterday" are different
// screens and a developer needs a code that produces each.

import { STORE, STAFF, PRODUCT, PROMO, ORDER, type Ctx } from './context.ts';

export async function seedPromotions(ctx: Ctx): Promise<void> {
  ctx.step('Promotions');

  await ctx.sql(
    `INSERT INTO promotions (id, store_id, kind, code, discount_type, percent_off, created_by) VALUES
       ($1, $2, 'code', 'WELCOME10', 'percentage', 10, $3)`,
    [PROMO.welcome10, STORE.nyama, STAFF.aline],
  );
  await ctx.sql(
    `INSERT INTO promotions (id, store_id, kind, code, discount_type, amount_off, created_by) VALUES
       ($1, $2, 'code', 'SOKO100', 'fixed_amount', 100, $3)`,
    [PROMO.soko100, STORE.nyama, STAFF.aline],
  );
  // Ended yesterday. The one that makes "your total went back to 9,500" reachable.
  await ctx.sql(
    `INSERT INTO promotions (id, store_id, kind, code, discount_type, percent_off, ends_at, created_by) VALUES
       ($1, $2, 'code', 'FRIDAY20', 'percentage', 20, now() - interval '1 day', $3)`,
    [PROMO.friday20, STORE.nyama, STAFF.aline],
  );
  // One use, and it gets used below — so "limit_reached" is reachable too.
  await ctx.sql(
    `INSERT INTO promotions (id, store_id, kind, code, discount_type, amount_off, max_redemptions, created_by) VALUES
       ($1, $2, 'code', 'ONLYONE', 'fixed_amount', 500, 1, $3)`,
    [PROMO.onlyone, STORE.nyama, STAFF.aline],
  );

  // The banner Shop and Customize both render: "Two burgers, free fries ·
  // Weekdays 12:00-15:00. Added automatically at checkout."
  await ctx.sql(
    `INSERT INTO promotions (id, store_id, kind, discount_type, free_product_id, required_product_id,
                             min_quantity, days_of_week, time_from, time_to,
                             banner_title, banner_subtitle, created_by)
     VALUES ($1, $2, 'automatic', 'free_item', $3, $4, 2, '{1,2,3,4,5}', '12:00', '15:00',
             'Two burgers, free fries',
             'Weekdays 12:00–15:00. Added automatically at checkout.', $5)`,
    [PROMO.lunch, STORE.nyama, PRODUCT.fries, PRODUCT.chickenBurger, STAFF.aline],
  );
  await ctx.sql(
    `INSERT INTO promotions (id, store_id, kind, discount_type, percent_off,
                             banner_title, banner_subtitle, created_by)
     VALUES ($1, $2, 'automatic', 'percentage', 15,
             'New season kitenge', 'Shirts made in Kigali. 15% off this week.', $3)`,
    [PROMO.newSeason, STORE.inzu, STAFF.kevin],
  );

  ctx.ok('4 codes (one expired, one already spent) and 2 automatic offers with banners');
}

/**
 * Applied AFTER the orders exist, because a discount is a row against an order and
 * `orders.discount_amount` has to equal the rows behind it.
 */
export async function applyPromotions(ctx: Ctx): Promise<void> {
  ctx.step('Discounts');

  const applied = await ctx.sql<{ status: string; discount_amount: string }>(
    `SELECT status, discount_amount::text FROM apply_promo_code($1, 'WELCOME10')`,
    [ORDER.discounted],
  );
  if (applied.rows[0]?.status !== 'applied') {
    throw new Error(`WELCOME10 did not apply to the demo order: ${applied.rows[0]?.status}`);
  }

  // The one-use code, spent here so a developer typing it gets `limit_reached`.
  const spent = await ctx.sql<{ status: string }>(
    `SELECT status FROM apply_promo_code($1, 'ONLYONE')`,
    [ORDER.lunchOffer],
  );
  if (spent.rows[0]?.status !== 'applied') {
    throw new Error(`ONLYONE did not apply: ${spent.rows[0]?.status}`);
  }

  // The automatic offer, at a moment inside its own window — a fixed Wednesday
  // lunchtime rather than `now()`, so a seed run at 22:00 still produces it.
  const auto = await ctx.sql<{ applied_amount: string }>(
    `SELECT applied_amount::text FROM apply_automatic_promotions($1, date_trunc('week', now()) + interval '2 days 12 hours 30 minutes')`,
    [ORDER.lunchOffer],
  );

  // A discount somebody gave by hand: CashReport's second gap outcome, where the
  // customer genuinely paid less and it is recorded on the order rather than left
  // as a hole in the day.
  await ctx.sql(
    `SELECT record_manual_discount($1, 1000, 'Cash short by 1,000 — customer paid less, agreed with the manager', $2)`,
    [ORDER.cashShort, STAFF.patrick],
  );

  ctx.ok(
    `WELCOME10 took ${applied.rows[0]!.discount_amount} off one order, ` +
      `the lunch offer ${auto.rows[0]?.applied_amount ?? '0'} off another, ` +
      'and one discount was given by hand',
  );
}
