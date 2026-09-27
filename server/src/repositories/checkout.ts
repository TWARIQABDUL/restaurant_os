// server/src/repositories/checkout.ts — milestone 17.
//
// The quote a customer is shown, and the order it becomes.
//
// THE QUOTE AND THE PLACEMENT COMPUTE THE SAME TOTAL IN DIFFERENT PLACES, and that is deliberate rather
// than careless. The quote adds up a CART; place_order() adds up an ORDER it has just written, through
// `orders.total_amount`, which is a GENERATED column, after V013's promotion functions have had their say.
// Making the quote reuse that path would mean writing an order to price one.
//
// So instead the two are RECONCILED: the quote's total is handed back to place_order() as
// `p_expected_total`, and the order is refused if the figures differ. The customer can only ever be
// charged a number the quote produced — and if the two arithmetics ever disagree, an order fails loudly
// instead of a customer being charged quietly. That is the same shape as milestone 13's theme gate, where
// publishing takes the inputs rather than the colours so "is this the compiler's own output" is true by
// construction.
//
// WHICH PAYMENT METHODS EXIST IS A QUESTION FOR THE DATABASE, not a list in this file. V006 seeds the
// registry, `payment_method_countries` and `payment_method_currencies` say where and in what a method can
// charge, and `store_payment_methods` says which ones this merchant connected. Cards are absent because
// AdminPayments has no card processor (Part 9) — so the checkout screen offers what can actually be
// charged, and `orders_payment_method_usable` refuses anything else at the column.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import {
  addDecimal,
  compareDecimal,
  multiplyDecimal,
  parseDecimal,
  sumDecimals,
  toDecimalString,
} from '../core.ts';

export type Fulfilment = 'delivery' | 'pickup';

export type PaymentOption = {
  key: string;
  label: string;
  hint: string;
  /** 'offline' is cash: no provider, no country or currency agreement, no minimum. */
  kind: 'offline' | 'online';
  minAmount: string | null;
  maxAmount: string | null;
  /** False when this total is outside the provider's range — shown, but not choosable. */
  usableForTotal: boolean;
};

export type DeliveryOption = {
  zoneId: string;
  name: string;
  fee: string;
  etaMinMinutes: number;
  etaMaxMinutes: number;
  areas: string[];
};

export type Quote = {
  itemCount: number;
  subtotal: string;
  deliveryFee: string;
  /** What the promo code and the automatic offers are worth, as a positive amount to subtract. */
  discount: string;
  total: string;
  /** What the rider collects, for cash. NULL for any other method — V019 derives it the same way. */
  cashDue: string | null;
  /** The code the cart is holding, and whether it would actually apply. */
  promo: { code: string; applies: boolean; reason: string | null; amount: string } | null;
  fulfilment: Fulfilment;
  zone: DeliveryOption | null;
  paymentMethods: PaymentOption[];
  /** A line that can no longer be bought stops checkout, and this is what the screen names. */
  unavailable: { productName: string; reason: 'sold_out' | 'withdrawn' }[];
};

/** Every delivery zone a store has, with the areas it covers. Checkout picks one and its fee is fixed. */
export async function deliveryOptions(storeId: string, on: Queryable = db): Promise<DeliveryOption[]> {
  const { rows } = await on.query<{
    id: string;
    name: string;
    fee_amount: string;
    eta_min_minutes: number;
    eta_max_minutes: number;
    areas: string[] | null;
  }>(
    `SELECT z.id, z.name, z.fee_amount::text, z.eta_min_minutes, z.eta_max_minutes,
            (SELECT array_agg(a.area_name ORDER BY a.area_name)
               FROM delivery_zone_areas a WHERE a.zone_id = z.id) AS areas
       FROM delivery_zones z
      WHERE z.store_id = $1 AND z.is_active
      ORDER BY z.fee_amount, z.position, z.id`,
    [storeId],
  );
  return rows.map((r) => ({
    zoneId: r.id,
    name: r.name,
    fee: r.fee_amount,
    etaMinMinutes: r.eta_min_minutes,
    etaMaxMinutes: r.eta_max_minutes,
    areas: r.areas ?? [],
  }));
}

/**
 * What this store can be paid with, for a total.
 *
 * `usableForTotal` rather than filtering the row out, because V006's own note says the customer should be
 * told before they try: "Tell the customer before they try, not after the provider refuses." A method that
 * cannot take 50 RWF is still a method the store offers.
 */
export async function paymentOptions(
  storeId: string,
  total: string,
  on: Queryable = db,
): Promise<PaymentOption[]> {
  const { rows } = await on.query<{
    key: string;
    customer_label: string;
    customer_hint: string | null;
    kind: 'offline' | 'online';
    min_amount: string | null;
    max_amount: string | null;
  }>(
    `SELECT m.key, m.customer_label, m.customer_hint, m.kind,
            pmc.min_amount::text, pmc.max_amount::text
       FROM store_payment_methods spm
       JOIN payment_methods m ON m.key = spm.payment_method_key
       JOIN stores s ON s.id = spm.store_id
       -- Offline methods need no country or currency agreement, which is why these are LEFT joins with the
       -- condition inside rather than a WHERE that would drop cash.
       LEFT JOIN payment_method_countries pmk
              ON pmk.payment_method_key = m.key AND pmk.country_code = s.country
       LEFT JOIN payment_method_currencies pmc
              ON pmc.payment_method_key = m.key AND pmc.currency_code = s.selling_currency
      WHERE spm.store_id = $1
        AND spm.is_connected
        AND m.status = 'live'
        AND (m.kind = 'offline' OR (pmk.payment_method_key IS NOT NULL AND pmc.payment_method_key IS NOT NULL))
      ORDER BY m.position, m.key`,
    [storeId],
  );

  const amount = parseDecimal(total);
  return rows.map((r) => {
    const min = r.min_amount;
    const max = r.max_amount;
    // compareDecimal, not `Number(a) >= Number(b)`: these are decimal strings, and the whole money layer
    // exists so that a comparison at the edge of a provider's range is exact.
    const withinRange =
      min === null || max === null
        ? true
        : compareDecimal(amount, parseDecimal(min)) >= 0 && compareDecimal(amount, parseDecimal(max)) <= 0;
    return {
      key: r.key,
      label: r.customer_label,
      hint: r.customer_hint ?? '',
      kind: r.kind,
      minAmount: min,
      maxAmount: max,
      usableForTotal: withinRange,
    };
  });
}

type QuoteLineRow = {
  product_name: string;
  quantity: number;
  unit_price: string;
  options_amount: string;
  is_available: boolean;
  status: string;
  track_stock: boolean;
  stock_quantity: number | null;
};

/**
 * Price a cart for checkout.
 *
 * THE DISCOUNT IS NOT COMPUTED HERE. V013 owns what a code and the automatic offers are worth, and it
 * computes them against an ORDER. Quoting a discount would be a fourth implementation of rules that
 * already have exactly one — so the quote asks the database what the code WOULD do through
 * promotion_quote(), added by V019 for this, and shows the same figure placement will produce.
 */
export async function quote(
  storeId: string,
  cartId: string,
  options: { fulfilment: Fulfilment; zoneId?: string | null },
  on: Queryable = db,
): Promise<Quote | null> {
  const { rows: lines } = await on.query<QuoteLineRow>(
    `SELECT p.name AS product_name,
            i.quantity,
            p.base_price::text AS unit_price,
            COALESCE(extras.amount, 0)::text AS options_amount,
            v.is_available,
            p.status,
            p.track_stock,
            v.stock_quantity
       FROM cart_items i
       JOIN product_variants v ON v.id = i.variant_id AND v.store_id = i.store_id
       JOIN products p ON p.id = v.product_id AND p.store_id = i.store_id
       LEFT JOIN LATERAL (
         SELECT sum(ov.price_delta) AS amount
           FROM cart_item_option_values civ
           JOIN option_values ov ON ov.id = civ.option_value_id
          WHERE civ.cart_item_id = i.id
       ) AS extras ON true
      WHERE i.cart_id = $1
      ORDER BY i.created_at, i.id`,
    [cartId],
  );

  if (lines.length === 0) return null;

  const subtotal = sumDecimals(
    lines.map((line) =>
      multiplyDecimal(addDecimal(parseDecimal(line.unit_price), parseDecimal(line.options_amount)), line.quantity),
    ),
  );

  const zone =
    options.fulfilment === 'delivery' && options.zoneId != null
      ? (await deliveryOptions(storeId, on)).find((z) => z.zoneId === options.zoneId) ?? null
      : null;
  const fee = options.fulfilment === 'delivery' && zone !== null ? parseDecimal(zone.fee) : parseDecimal('0');

  const promoCode = (
    await on.query<{ promo_code: string | null }>(`SELECT promo_code FROM carts WHERE id = $1`, [cartId])
  ).rows[0]?.promo_code ?? null;

  // promotion_quote() takes the CART, not a subtotal: it reads the lines itself so the figures it returns
  // are computed from the same rows place_order() will copy into the order.
  const { rows: promoRows } = await on.query<{
    status: string | null;
    discount_amount: string;
    automatic_amount: string;
  }>(
    `SELECT status, discount_amount::text, automatic_amount::text
       FROM promotion_quote($1, $2, $3)`,
    [storeId, promoCode, cartId],
  );
  const promoRow = promoRows[0];
  const codeAmount = parseDecimal(promoRow?.discount_amount ?? '0');
  const automatic = parseDecimal(promoRow?.automatic_amount ?? '0');
  const discount = addDecimal(codeAmount, automatic);

  // subtotal + fee - discount, exactly as orders.total_amount is generated.
  const total = addDecimal(addDecimal(subtotal, fee), negate(discount));
  const totalText = toDecimalString(total);

  const { rows: dueRows } = await on.query<{ cash_due: string | null }>(
    // The SAME function the trigger uses, so the figure the customer is shown is the figure the column will
    // hold. Two roundings of one total would be the bug this avoids.
    `SELECT order_cash_due_for($1::numeric, (SELECT selling_currency FROM stores WHERE id = $2), 'cash')::text AS cash_due`,
    [totalText, storeId],
  );

  const unavailable = lines
    .filter((line) => !line.is_available || line.status !== 'active' || (line.track_stock && (line.stock_quantity ?? 0) < line.quantity))
    .map((line) => ({
      productName: line.product_name,
      reason: (line.is_available && line.status === 'active' ? 'sold_out' : 'withdrawn') as 'sold_out' | 'withdrawn',
    }));

  return {
    itemCount: lines.reduce((total_, line) => total_ + line.quantity, 0),
    subtotal: toDecimalString(subtotal),
    deliveryFee: toDecimalString(fee),
    discount: toDecimalString(discount),
    total: totalText,
    cashDue: dueRows[0]?.cash_due ?? null,
    promo:
      promoCode === null
        ? null
        : {
            code: promoCode,
            applies: promoRow?.status === 'applied',
            reason: promoRow?.status === 'applied' ? null : (promoRow?.status ?? 'unknown_code'),
            amount: toDecimalString(codeAmount),
          },
    fulfilment: options.fulfilment,
    zone,
    paymentMethods: await paymentOptions(storeId, totalText, on),
    unavailable,
  };
}

function negate(value: ReturnType<typeof parseDecimal>): ReturnType<typeof parseDecimal> {
  return value.digits === 0n ? value : { ...value, negative: !value.negative };
}

/**
 * What one code would be worth on this cart, and why not if it would not.
 *
 * The status list is V013's own — unknown_code, withdrawn, not_started, expired, outside_hours,
 * already_applied, below_minimum, requirements_not_met, limit_reached, nothing_to_discount, applied — and it
 * comes from promotion_quote(), which shares promotion_evaluate() with the function that will apply the code
 * at placement. That sharing is the point: a quoted discount and a charged discount cannot disagree.
 */
export async function quotePromo(
  storeId: string,
  cartId: string,
  code: string,
  on: Queryable = db,
): Promise<{ status: string; amount: string }> {
  const { rows } = await on.query<{ status: string | null; discount_amount: string }>(
    `SELECT status, discount_amount::text FROM promotion_quote($1, $2, $3)`,
    [storeId, code, cartId],
  );
  const row = rows[0];
  return { status: row?.status ?? 'unknown_code', amount: row?.discount_amount ?? '0' };
}

export type PlacedOrder = {
  orderId: string;
  orderNumber: number;
  trackingCode: string;
  total: string;
  cashDue: string | null;
  /** False when this was a retry and the order already existed. */
  created: boolean;
};

/** place_order(), which is where every guarantee about not double-charging lives. See V019. */
export async function place(
  input: {
    cartId: string;
    idempotencyKey: string;
    fulfilment: Fulfilment;
    paymentMethod: string;
    expectedTotal: string;
    customerUserId?: string | null;
    guestName?: string | null;
    guestPhone?: string | null;
    guestEmail?: string | null;
    deliveryAddress?: string | null;
    deliveryZoneId?: string | null;
  },
  on: Queryable = db,
): Promise<PlacedOrder> {
  const { rows } = await on.query<{
    order_id: string;
    order_number: number;
    tracking_code: string;
    total_amount: string;
    cash_due: string | null;
    created: boolean;
  }>(
    `SELECT order_id, order_number, tracking_code, total_amount::text, cash_due::text, created
       FROM place_order($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10, $11)`,
    [
      input.cartId,
      input.idempotencyKey,
      input.fulfilment,
      input.paymentMethod,
      input.expectedTotal,
      input.customerUserId ?? null,
      input.guestName ?? null,
      input.guestPhone ?? null,
      input.guestEmail ?? null,
      input.deliveryAddress ?? null,
      input.deliveryZoneId ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('place_order returned no row');
  return {
    orderId: row.order_id,
    orderNumber: row.order_number,
    trackingCode: row.tracking_code,
    total: row.total_amount,
    cashDue: row.cash_due,
    created: row.created,
  };
}
