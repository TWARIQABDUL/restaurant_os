// server/src/repositories/stores.ts — milestone 11.
//
// §2.3's query rules, applied literally: parameterized always, explicit column
// lists, and storeId first on every method that touches a store-scoped table.
//
// `findBySlug` is the one method here with no storeId parameter, because resolving
// a storefront from its URL is how a request FINDS the store — the rule cannot
// apply to the lookup that produces its own subject.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import type {
  StorePaymentMethodsRow,
  StorePayoutSettingsRow,
  StorePickupSettingsRow,
  StoresRow,
} from '../db/rows.ts';

/** What every screen needs to render a store's identity. */
export type StoreSummary = Pick<
  StoresRow,
  'id' | 'slug' | 'name' | 'status' | 'country' | 'selling_currency' | 'plan_key' | 'time_zone'
>;

// time_zone joined the summary at milestone 19. Every console screen that prints a time needs it: V021 made
// the store's own zone the answer to "what does today mean", and a screen formatting a timestamp in the
// BROWSER's zone would put a merchant's evening orders on tomorrow's date the moment they travelled.
const SUMMARY_COLUMNS = 'id, slug, name, status, country, selling_currency, plan_key, time_zone';

export async function findById(storeId: string, on: Queryable = db): Promise<StoreSummary | null> {
  const { rows } = await on.query<StoreSummary>(
    `SELECT ${SUMMARY_COLUMNS} FROM stores WHERE id = $1`,
    [storeId],
  );
  return rows[0] ?? null;
}

/**
 * Resolves a storefront from its URL. Case is normalised because a slug is a path
 * segment and a hostname label, and neither is reliably lower-cased by the client;
 * the unique index is on the plain column, so `lower($1)` on the parameter side
 * keeps the index usable.
 */
export async function findBySlug(slug: string, on: Queryable = db): Promise<StoreSummary | null> {
  const { rows } = await on.query<StoreSummary>(
    `SELECT ${SUMMARY_COLUMNS} FROM stores WHERE slug = lower($1)`,
    [slug],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The Settings → Store details panel
// ---------------------------------------------------------------------------
//
// Four tables, read together. `Settings` shows them on one screen, and a payout
// destination that disagrees with the payment methods it is paid through is the
// kind of inconsistency a caller reads as a bug — so the route wraps this in
// readConsistent().
//
// GUARDED BY settings.write, NOT BY A READ PERMISSION. There is no settings.read in
// role_permissions, and that is the board's doing rather than an omission: Auth's
// invite screen says a manager "can't see payouts, the wallet or store settings".
// Seeing the panel and editing it are one capability because the board makes them
// one screen.

export type StoreSettings = {
  store: StoreSummary & Pick<StoresRow, 'custom_domain' | 'industry_template_id' | 'industry_template_version'>;
  pickup: Pick<StorePickupSettingsRow, 'address' | 'ready_minutes' | 'instructions'> | null;
  payout: Pick<
    StorePayoutSettingsRow,
    'payout_method_key' | 'payout_phone' | 'settlement_mode' | 'automatic_at'
  > | null;
  paymentMethods: Pick<StorePaymentMethodsRow, 'payment_method_key' | 'is_connected' | 'connected_at'>[];
};

export async function findSettings(storeId: string, on: Queryable = db): Promise<StoreSettings | null> {
  const store = await on.query<StoreSettings['store']>(
    `SELECT ${SUMMARY_COLUMNS}, custom_domain, industry_template_id, industry_template_version
       FROM stores
      WHERE id = $1`,
    [storeId],
  );
  const found = store.rows[0];
  if (found === undefined) return null;

  // Sequential, not Promise.all. On a transaction's client node-postgres queues
  // queries on one connection anyway, so there is no parallelism to win — and if
  // the first failed, the other two would reject with "current transaction is
  // aborted" as unhandled rejections while Promise.all reported only the first.
  const pickup = await on.query<NonNullable<StoreSettings['pickup']>>(
    `SELECT address, ready_minutes, instructions FROM store_pickup_settings WHERE store_id = $1`,
    [storeId],
  );
  const payout = await on.query<NonNullable<StoreSettings['payout']>>(
    `SELECT payout_method_key, payout_phone, settlement_mode, automatic_at
       FROM store_payout_settings
      WHERE store_id = $1`,
    [storeId],
  );
  const methods = await on.query<StoreSettings['paymentMethods'][number]>(
    `SELECT payment_method_key, is_connected, connected_at
       FROM store_payment_methods
      WHERE store_id = $1
      ORDER BY payment_method_key`,
    [storeId],
  );

  return {
    store: found,
    pickup: pickup.rows[0] ?? null,
    payout: payout.rows[0] ?? null,
    paymentMethods: methods.rows,
  };
}
