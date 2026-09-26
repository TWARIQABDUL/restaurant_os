// server/src/repositories/storefront.ts — milestone 16.
//
// The store itself, as a shopper sees it: its name, whether it is open, how it hands over an order,
// and this week's banner. `Shop`'s header and `StoreDesktop`'s store-info panel are the same facts at
// two widths.
//
// THE OPEN/CLOSED RULE IS NOT HERE. V018's store_open_state() owns it, because three screens ask the
// question and V013 already established what happens when a window rule is implemented per reader:
// "three readers of one rule is three chances to disagree about whether 'Weekdays 12:00-15:00'
// includes 15:00". Same for 22:00. This repository reads the answer.
//
// NEITHER IS THE BANNER'S. store_promotion_banner() picks it, including which of several live
// automatic promotions wins.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';

export type StoreStatus = 'pending' | 'active' | 'suspended';

/** What resolveStorefront() proves about a request. Deliberately small: identity and status only. */
export type PublicStore = {
  id: string;
  slug: string;
  name: string;
  status: StoreStatus;
  currency: string;
  country: string;
};

export type OpenState = {
  isOpen: boolean;
  /** 'HH:MM' — when it shuts, present only while open. */
  closesAt: string | null;
  /** 'HH:MM' — when it next opens, present only while shut. Null when it never does. */
  opensAt: string | null;
  /** ISO day number the next opening falls on, 1 = Monday. Null with opensAt. */
  opensOn: number | null;
};

export type OpeningHours = { dayOfWeek: number; opensAt: string; closesAt: string };

export type DeliverySummary = {
  /** The cheapest active zone, which is what "Delivery 25-35 min · 1,000 RWF" quotes. */
  fromFee: string;
  etaMinMinutes: number;
  etaMaxMinutes: number;
  zoneCount: number;
};

export type PickupSummary = { address: string; readyMinutes: number; instructions: string | null };

export type Banner = { promotionId: string; title: string | null; subtitle: string | null };

export type StorefrontCategory = {
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  /** How many active products are in it. The rail shows the count and hides an empty section. */
  productCount: number;
};

export async function findBySlug(slug: string, on: Queryable = db): Promise<PublicStore | null> {
  const { rows } = await on.query<PublicStore>(
    `SELECT id, slug, name, status, selling_currency AS currency, country
       FROM stores
      WHERE slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

type OpenRow = { is_open: boolean; closes_at: string | null; opens_at: string | null; opens_on: number | null };

/**
 * Whether the store is open now.
 *
 * `time` comes back from node-postgres as 'HH:MM:SS'; the storefront writes 'closes 22:00', so the
 * seconds are dropped here rather than in a component — a screen that sliced a time string would be
 * the beginning of a second date formatter.
 */
export async function openState(storeId: string, on: Queryable = db): Promise<OpenState> {
  const { rows } = await on.query<OpenRow>(
    `SELECT is_open, closes_at::text, opens_at::text, opens_on FROM store_open_state($1)`,
    [storeId],
  );
  const row = rows[0];
  if (row === undefined) return { isOpen: false, closesAt: null, opensAt: null, opensOn: null };
  const hm = (value: string | null): string | null => (value === null ? null : value.slice(0, 5));
  return {
    isOpen: row.is_open,
    closesAt: hm(row.closes_at),
    opensAt: hm(row.opens_at),
    opensOn: row.opens_on,
  };
}

/** Every open day, for the store-info panel. Ordered Monday first, which is what ISO numbering gives. */
export async function openingHours(storeId: string, on: Queryable = db): Promise<OpeningHours[]> {
  const { rows } = await on.query<{ day_of_week: number; opens_at: string; closes_at: string }>(
    `SELECT day_of_week, opens_at::text, closes_at::text
       FROM store_hours
      WHERE store_id = $1
      ORDER BY day_of_week`,
    [storeId],
  );
  return rows.map((r) => ({
    dayOfWeek: r.day_of_week,
    opensAt: r.opens_at.slice(0, 5),
    closesAt: r.closes_at.slice(0, 5),
  }));
}

/** The public phone number, and the pickup address when the store offers pickup. */
export async function contact(
  storeId: string,
  on: Queryable = db,
): Promise<{ phone: string | null; pickup: PickupSummary | null }> {
  const { rows } = await on.query<{
    public_phone: string | null;
    address: string | null;
    ready_minutes: number | null;
    instructions: string | null;
  }>(
    `SELECT s.public_phone, p.address, p.ready_minutes, p.instructions
       FROM stores s
       LEFT JOIN store_pickup_settings p ON p.store_id = s.id
      WHERE s.id = $1`,
    [storeId],
  );
  const row = rows[0];
  if (row === undefined) return { phone: null, pickup: null };
  return {
    phone: row.public_phone,
    pickup:
      row.address === null || row.ready_minutes === null
        ? null
        : { address: row.address, readyMinutes: row.ready_minutes, instructions: row.instructions },
  };
}

/**
 * The delivery line: the cheapest zone's fee and its ETA range.
 *
 * THE CHEAPEST, NOT THE FIRST. Both boards write one line before a shopper has given an address, and
 * "from 1,000 RWF" is the only honest thing to say when the real fee depends on where they live.
 * Checkout (milestone 17) quotes the actual zone.
 */
export async function deliverySummary(
  storeId: string,
  on: Queryable = db,
): Promise<DeliverySummary | null> {
  const { rows } = await on.query<{
    fee_amount: string;
    eta_min_minutes: number;
    eta_max_minutes: number;
    zone_count: string;
  }>(
    `SELECT z.fee_amount::text,
            z.eta_min_minutes,
            z.eta_max_minutes,
            count(*) OVER ()::text AS zone_count
       FROM delivery_zones z
      WHERE z.store_id = $1 AND z.is_active
      ORDER BY z.fee_amount, z.position, z.id
      LIMIT 1`,
    [storeId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        fromFee: row.fee_amount,
        etaMinMinutes: row.eta_min_minutes,
        etaMaxMinutes: row.eta_max_minutes,
        zoneCount: Number(row.zone_count),
      };
}

/** This week's automatic offer, if one is live at this moment. */
export async function banner(storeId: string, on: Queryable = db): Promise<Banner | null> {
  const { rows } = await on.query<{
    promotion_id: string;
    banner_title: string | null;
    banner_subtitle: string | null;
  }>(`SELECT promotion_id, banner_title, banner_subtitle FROM store_promotion_banner($1)`, [storeId]);
  const row = rows[0];
  return row === undefined
    ? null
    : { promotionId: row.promotion_id, title: row.banner_title, subtitle: row.banner_subtitle };
}

/**
 * The category rail.
 *
 * VISIBLE AND NON-EMPTY, which V003 said would be derived rather than stored: "a section is shown on
 * the storefront when it is visible AND has products; the emptiness half is derived, not stored,
 * because storing it would be a second source of truth for a COUNT". This is that COUNT, and it
 * counts only what a shopper can buy — a section holding nothing but drafts is empty to them.
 */
export async function categories(storeId: string, on: Queryable = db): Promise<StorefrontCategory[]> {
  const { rows } = await on.query<{
    id: string;
    name: string;
    description: string;
    image_url: string | null;
    product_count: string;
  }>(
    `SELECT c.id, c.name, c.description, c.image_url, count(p.id)::text AS product_count
       FROM categories c
       JOIN product_categories pc ON pc.category_id = c.id
       JOIN products p ON p.id = pc.product_id AND p.status = 'active'
      WHERE c.store_id = $1 AND c.is_visible
      GROUP BY c.id, c.name, c.description, c.image_url, c.position
      ORDER BY c.position, c.id`,
    [storeId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    imageUrl: r.image_url,
    productCount: Number(r.product_count),
  }));
}
