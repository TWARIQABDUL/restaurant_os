// server/src/repositories/carts.ts — milestone 16.
//
// The cart, server-side, because §2.5 rules out browser storage as a source of truth and because
// States.dc.html promises two things localStorage cannot keep: a cart that survives losing the network,
// and one "kept for 7 days". V003 built the tables for it; this is the code path.
//
// WHO OWNS A CART. Exactly one of two things, which V003 enforces with a CHECK:
//
//   a signed-in customer   the cart follows the account, so it is there on their phone and their laptop
//   an anonymous shopper   the cart follows an opaque id the SERVER issued and holds in an httpOnly
//                          cookie, so the browser cannot read it and nothing is stored in the page
//
// THE ANONYMOUS ID IS A CREDENTIAL, which is why it is 32 random bytes and not a guessable counter:
// holding it is holding the cart. V003 bounds its length at the column for the same reason.
//
// ADDING A LINE IS ONE STATEMENT, and add_to_cart() in V018 is where the whole argument for that
// lives: the board's own behaviour is to merge an identical line, the obvious implementation is a
// SELECT then an INSERT, and a double-tapped Add button is two concurrent requests that both pass the
// SELECT. So the merge is ON CONFLICT DO UPDATE against a unique index the database resolves whatever
// the timing.
//
// NO PRICES ARE STORED ON A LINE. V003: "Prices are re-checked at checkout; any change is shown before
// paying. A price copied into the cart would be a second source of truth that goes stale silently." So
// a cart's totals are COMPUTED on every read, from the product and the option values the line names.

import { randomBytes } from 'node:crypto';
import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import { parseDecimal, sumDecimals, toDecimalString } from '../core.ts';

/** Who a cart belongs to. Exactly one of these reaches the database per call. */
export type CartOwner = { userId: string } | { sessionId: string };

export type CartLine = {
  id: string;
  variantId: string;
  productId: string;
  productName: string;
  /** "Medium · Cheese" on the board — the variant's own values first, then the priced extras. */
  optionLabels: string[];
  quantity: number;
  /** base price + every chosen option's delta, as a string. */
  unitPrice: string;
  lineTotal: string;
  coverImageUrl: string | null;
  /** The line can no longer be bought — sold out or withdrawn since it went in the cart. */
  unavailable: boolean;
};

export type Cart = {
  id: string;
  lines: CartLine[];
  /** Total number of items, which is what the badge and "View cart · 3 items" count. */
  itemCount: number;
  subtotal: string;
  expiresAt: Date;
};

/** 32 bytes, base64url: long enough that guessing one is not a strategy, short enough for a cookie. */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

function ownerClause(owner: CartOwner): { sql: string; value: string } {
  return 'userId' in owner
    ? { sql: 'user_id = $2 AND anonymous_session_id IS NULL', value: owner.userId }
    : { sql: 'anonymous_session_id = $2 AND user_id IS NULL', value: owner.sessionId };
}

/** The cart id, or null when this shopper has none at this store yet. Expired carts do not count. */
export async function findId(
  storeId: string,
  owner: CartOwner,
  on: Queryable = db,
): Promise<string | null> {
  const clause = ownerClause(owner);
  const { rows } = await on.query<{ id: string }>(
    `SELECT id FROM carts WHERE store_id = $1 AND ${clause.sql} AND expires_at > now()`,
    [storeId, clause.value],
  );
  return rows[0]?.id ?? null;
}

/**
 * The cart id, creating one if there is none.
 *
 * ON CONFLICT rather than "look, then insert": two requests from the same shopper arriving together —
 * a page that adds two things at once, or a retry — would otherwise both insert and one would hit the
 * unique index as a 500. The index is V003's `carts_store_user_key` / `carts_store_session_key`, and it
 * is partial, so the ON CONFLICT names the same predicate.
 *
 * AN EXPIRED CART IS REVIVED, NOT DUPLICATED. The unique index does not know about expiry, so a row
 * past its seven days is still in the way of a new one — DO UPDATE pushes it forward and empties it,
 * which is what a shopper coming back after two weeks expects to find.
 */
export async function findOrCreateId(
  storeId: string,
  owner: CartOwner,
  on: Queryable = db,
): Promise<string> {
  const isUser = 'userId' in owner;
  const { rows } = await on.query<{ id: string; expires_at: Date; revived: boolean }>(
    `INSERT INTO carts (store_id, user_id, anonymous_session_id)
          VALUES ($1, $2, $3)
     ON CONFLICT (store_id, ${isUser ? 'user_id' : 'anonymous_session_id'})
            WHERE ${isUser ? 'user_id IS NOT NULL' : 'anonymous_session_id IS NOT NULL'}
     DO UPDATE SET expires_at = CASE WHEN carts.expires_at > now()
                                     THEN carts.expires_at
                                     ELSE now() + interval '7 days' END
       RETURNING id, expires_at, (carts.expires_at <= now()) AS revived`,
    [storeId, isUser ? owner.userId : null, isUser ? null : owner.sessionId],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('carts upsert returned no row');

  // The expired cart's old lines are somebody's abandoned shopping from a fortnight ago. Reviving the
  // row and keeping them would be worse than either alternative: prices have moved and products may be
  // gone, and States promises seven days, not indefinitely.
  if (row.revived) {
    await on.query(`DELETE FROM cart_items WHERE cart_id = $1`, [row.id]);
  }
  return row.id;
}

/** Add a variant, merging with an identical line. Returns the line and whether it is new. */
export async function addItem(
  cartId: string,
  variantId: string,
  optionValueIds: readonly string[],
  quantity: number,
  on: Queryable = db,
): Promise<{ cartItemId: string; quantity: number; created: boolean }> {
  const { rows } = await on.query<{ cart_item_id: string; quantity: number; created: boolean }>(
    `SELECT cart_item_id, quantity, created FROM add_to_cart($1, $2, $3::uuid[], $4)`,
    [cartId, variantId, optionValueIds, quantity],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`add_to_cart returned no row for cart ${cartId}`);
  return { cartItemId: row.cart_item_id, quantity: row.quantity, created: row.created };
}

/**
 * Read a cart with its lines priced.
 *
 * THE PRICE IS COMPUTED, in SQL, in one query: the product's base price plus the deltas of the
 * variant's own option values plus the deltas of the line's extras. Doing it here rather than per line
 * in TypeScript keeps it to one round trip; doing it in SQL rather than storing it is V003's rule.
 *
 * Amounts come back as text. Milestone 13: money never becomes a float.
 */
export async function read(cartId: string, on: Queryable = db): Promise<Cart | null> {
  const { rows: cartRows } = await on.query<{ id: string; expires_at: Date }>(
    `SELECT id, expires_at FROM carts WHERE id = $1 AND expires_at > now()`,
    [cartId],
  );
  const head = cartRows[0];
  if (head === undefined) return null;

  const { rows } = await on.query<{
    id: string;
    variant_id: string;
    product_id: string;
    product_name: string;
    quantity: number;
    unit_price: string;
    line_total: string;
    cover_image_url: string | null;
    unavailable: boolean;
    option_labels: string[] | null;
  }>(
    `SELECT i.id,
            i.variant_id,
            p.id   AS product_id,
            p.name AS product_name,
            i.quantity,
            (p.base_price + priced.delta)::text              AS unit_price,
            ((p.base_price + priced.delta) * i.quantity)::text AS line_total,
            p.cover_image_url,
            (NOT v.is_available
             OR p.status <> 'active'
             OR (p.track_stock AND COALESCE(v.stock_quantity, 0) < i.quantity)) AS unavailable,
            priced.labels AS option_labels
       FROM cart_items i
       JOIN product_variants v ON v.id = i.variant_id AND v.store_id = i.store_id
       JOIN products p ON p.id = v.product_id AND p.store_id = i.store_id
       CROSS JOIN LATERAL (
         -- The variant's own values and the line's extras, together: one is what makes it a Medium,
         -- the other is the cheese. Both are priced the same way, and the labels are wanted in the
         -- same list, so they are gathered once.
         SELECT COALESCE(sum(chosen.price_delta), 0)                                  AS delta,
                array_remove(array_agg(chosen.label ORDER BY chosen.sort, chosen.label), NULL) AS labels
           FROM (
             SELECT ov.price_delta, ov.label, 0 AS sort
               FROM product_variant_values vv
               JOIN option_values ov ON ov.id = vv.option_value_id
              WHERE vv.variant_id = i.variant_id
             UNION ALL
             SELECT ov.price_delta, ov.label, 1 AS sort
               FROM cart_item_option_values civ
               JOIN option_values ov ON ov.id = civ.option_value_id
              WHERE civ.cart_item_id = i.id
           ) AS chosen
       ) AS priced
      WHERE i.cart_id = $1
      ORDER BY i.created_at, i.id`,
    [cartId],
  );

  const lines: CartLine[] = rows.map((r) => ({
    id: r.id,
    variantId: r.variant_id,
    productId: r.product_id,
    productName: r.product_name,
    optionLabels: r.option_labels ?? [],
    quantity: r.quantity,
    unitPrice: r.unit_price,
    lineTotal: r.line_total,
    coverImageUrl: r.cover_image_url,
    unavailable: r.unavailable,
  }));

  return {
    id: head.id,
    lines,
    itemCount: lines.reduce((total, line) => total + line.quantity, 0),
    // Summed through packages/core, not with `+` on numbers: these are decimal strings and JavaScript
    // addition is binary. sumDecimals() was added for this line, in the money module, because a second
    // place that adds money is a second place that can lose a cent.
    subtotal: toDecimalString(sumDecimals(lines.map((line) => parseDecimal(line.lineTotal)))),
    expiresAt: head.expires_at,
  };
}

/**
 * Change a line's quantity. Returns false when the line is not in this cart.
 *
 * THE SIGNATURE IS UNTOUCHED, because the options did not change — which is why this is a plain UPDATE and
 * not a remove-and-re-add. Re-adding would merge with whatever else matched and lose the distinction the
 * signature exists to keep.
 *
 * The bound is V018's `cart_items_quantity_bounded`; this refuses politely before the CHECK has to.
 */
export async function setQuantity(
  cartId: string,
  cartItemId: string,
  quantity: number,
  on: Queryable = db,
): Promise<boolean> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    throw new Error(`quantity must be a whole number between 1 and 999, got ${quantity}`);
  }
  const { rowCount } = await on.query(
    `UPDATE cart_items SET quantity = $3 WHERE cart_id = $1 AND id = $2`,
    [cartId, cartItemId, quantity],
  );
  return (rowCount ?? 0) > 0;
}

/** Remove a line. Its option rows cascade, and the signature trigger has nothing left to check. */
export async function removeLine(
  cartId: string,
  cartItemId: string,
  on: Queryable = db,
): Promise<boolean> {
  const { rowCount } = await on.query(`DELETE FROM cart_items WHERE cart_id = $1 AND id = $2`, [
    cartId,
    cartItemId,
  ]);
  return (rowCount ?? 0) > 0;
}

/**
 * Hold a promo code on the cart, or clear it.
 *
 * THE CODE, NOT WHAT IT IS WORTH. V019's column comment says why: the value depends on the lines, the time
 * of day and the caps, and apply_promo_code() decides it at placement against the order. Storing an amount
 * here would be a price quoted by a table that cannot see any of that.
 */
export async function setPromoCode(
  cartId: string,
  code: string | null,
  on: Queryable = db,
): Promise<void> {
  await on.query(`UPDATE carts SET promo_code = $2 WHERE id = $1`, [
    cartId,
    code === null ? null : code.trim().toUpperCase(),
  ]);
}

export async function promoCodeOf(cartId: string, on: Queryable = db): Promise<string | null> {
  const { rows } = await on.query<{ promo_code: string | null }>(
    `SELECT promo_code FROM carts WHERE id = $1`,
    [cartId],
  );
  return rows[0]?.promo_code ?? null;
}
