// server/src/repositories/catalogue.ts — milestone 16.
//
// What a shopper can buy: the grid on `Shop`, the same grid re-composed on `StoreDesktop`, and one
// product's page on `ReviewsCustomer`.
//
// EVERY AMOUNT LEAVES HERE AS A STRING. `numeric(12,2)` arrives from node-postgres as a string and is
// cast explicitly so it stays one: milestone 13 established that money never becomes a float, because
// the board's own formatter uses toFixed and `(1.005).toFixed(2)` is "1.00". The client parses these
// into BigInt minor units through packages/core.
//
// TWO ORDERINGS, TWO STATEMENTS, and that is not the mistake milestones 11 and 15 both made. Those
// were one ordering written two ways for a planner theory that measurement disproved. These are
// genuinely different orders: the whole catalogue runs in the merchant's product order
// (products.position) and one section runs in that section's own order
// (product_categories.position) — V003 stores both because Categories.dc.html says "Order here is the
// order on your store", and an index can serve one ordering each. A CASE in the ORDER BY would serve
// neither.
//
// WHAT THE SEARCH MATCHES, and only this: the product NAME. Shop.dc.html's own filter is
// `p.name.toLowerCase().includes(q)` and its empty state says "Try a shorter word", which is advice
// about a name. Matching descriptions too would make "fresh" return half a menu and make that empty
// state a lie.
//
// IT MATCHES BY WORD PREFIX RATHER THAN BY SUBSTRING, which is a deliberate departure from that mock
// and the one place this layer does not do what the board's own code did. V018's section 6 has the
// measurements that forced it: substring matching cannot use an index, and a search that matched nothing
// read the whole table. "milk" and "mil" both find "Fresh Milk"; "ilk" no longer finds anything.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';

/** The cap on one page of products, so a caller cannot ask for the whole catalogue in one request. */
const MAX_PAGE = 60;

export type StockState = {
  /** No variant can be bought: every one is withdrawn or counted down to nothing. */
  soldOut: boolean;
  /** At or below the merchant's threshold on at least one variant — the board's "Few left". */
  lowStock: boolean;
  /**
   * The smallest count left across the variants that can still be bought, or null when the product
   * does not track stock. What "Only 2 left in size 43" is built from.
   */
  fewestLeft: number | null;
};

export type ProductCard = {
  id: string;
  name: string;
  /** The card's one meta line on both storefront boards. */
  description: string;
  price: string;
  compareAtPrice: string | null;
  coverImageUrl: string | null;
  /** The variant a one-tap Add puts in the cart. Null when the shopper has to choose first. */
  defaultVariantId: string | null;
  /** A "pick one" group is attached, so Add becomes Choose and the sheet opens. */
  hasChoices: boolean;
  /** A "pick several" group is attached — priced extras, gated by the `modifiers` module. */
  hasExtras: boolean;
  stock: StockState;
};

export type ProductCursor = { position: number; id: string };

export type ProductPage = { items: ProductCard[]; nextCursor: ProductCursor | null };

export type OptionValue = {
  id: string;
  label: string;
  priceDelta: string;
  isAvailable: boolean;
};

export type ProductOptionGroup = {
  id: string;
  name: string;
  /** V002's own two words, so the config engine's attribute presets and this agree. */
  selectMode: 'one' | 'several';
  isRequired: boolean;
  values: OptionValue[];
};

export type ProductVariant = {
  id: string;
  sku: string | null;
  stockQuantity: number | null;
  isAvailable: boolean;
  isDefault: boolean;
  /** One option value per "pick one" group. Empty for a product with no choices. */
  optionValueIds: string[];
};

export type ProductDetail = ProductCard & {
  trackStock: boolean;
  groups: ProductOptionGroup[];
  variants: ProductVariant[];
  categoryIds: string[];
};

type CardRow = {
  id: string;
  name: string;
  description: string;
  price: string;
  compare_at_price: string | null;
  cover_image_url: string | null;
  track_stock: boolean;
  low_stock_threshold: number;
  position: number;
  default_variant_id: string | null;
  has_choices: boolean;
  has_extras: boolean;
  buyable_variants: string;
  fewest_left: number | null;
};

/**
 * Everything the card needs about one product, as a fragment both the list and the detail read.
 *
 * `buyable` is the condition in one place: available, and either untracked or with something left.
 * V003 keeps `is_available` separate from the count on purpose — "a variant can be in stock and
 * withdrawn, or out of stock and still listed struck through" — so both halves are asked here.
 */
/**
 * `position` is a PARAMETER rather than a literal, and the reason is a bug this project has already
 * had once: the seed built a variant of an INSERT's column list with `COLUMNS.replace(...)`, the
 * replacement matched something it was not meant to, and the statement went out with the wrong
 * columns in the right order. A string edit over SQL is not a refactor. So the one part that differs
 * between the two orderings is passed in, and everything else is shared by construction.
 */
const cardColumns = (position: string): string => `
    p.id,
    p.name,
    p.description,
    p.base_price::text        AS price,
    p.compare_at_price::text  AS compare_at_price,
    p.cover_image_url,
    p.track_stock,
    p.low_stock_threshold,
    ${position} AS position,
    (SELECT dv.id FROM product_variants dv WHERE dv.product_id = p.id AND dv.is_default) AS default_variant_id,
    EXISTS (SELECT 1 FROM product_option_groups pog
              JOIN option_groups og ON og.id = pog.option_group_id
             WHERE pog.product_id = p.id AND og.select_mode = 'one')     AS has_choices,
    EXISTS (SELECT 1 FROM product_option_groups pog
              JOIN option_groups og ON og.id = pog.option_group_id
             WHERE pog.product_id = p.id AND og.select_mode = 'several') AS has_extras,
    stock.buyable_variants::text AS buyable_variants,
    stock.fewest_left`;

const CARD_STOCK_JOIN = `
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (
               WHERE v.is_available AND (NOT p.track_stock OR COALESCE(v.stock_quantity, 0) > 0)
             ) AS buyable_variants,
             min(v.stock_quantity) FILTER (
               WHERE v.is_available AND COALESCE(v.stock_quantity, 0) > 0
             ) AS fewest_left
        FROM product_variants v
       WHERE v.product_id = p.id
    ) AS stock`;

/**
 * The stock badge rule, in one function because the grid and the product page must agree.
 *
 * PER VARIANT, NOT PER PRODUCT TOTAL, and the board settles it: Shop badges Canvas Sneakers "Few
 * left" and its sheet explains "Only 2 left in size 43". One size running out is what a shopper needs
 * warning about; a total across twelve sizes would hide it.
 */
function stockStateOf(row: CardRow): StockState {
  const soldOut = Number(row.buyable_variants) === 0;
  const fewestLeft = row.track_stock ? row.fewest_left : null;
  return {
    soldOut,
    lowStock:
      !soldOut &&
      row.track_stock &&
      row.low_stock_threshold > 0 &&
      fewestLeft !== null &&
      fewestLeft <= row.low_stock_threshold,
    fewestLeft,
  };
}

function toCard(row: CardRow): ProductCard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    compareAtPrice: row.compare_at_price,
    coverImageUrl: row.cover_image_url,
    defaultVariantId: row.default_variant_id,
    hasChoices: row.has_choices,
    hasExtras: row.has_extras,
    stock: stockStateOf(row),
  };
}

/**
 * The words a search term becomes.
 *
 * TOKENISED HERE RATHER THAN HANDED TO to_tsquery, because to_tsquery PARSES its argument: `&`, `|`,
 * `!`, `<->` and parentheses are operators, and a shopper typing "salt & pepper" would either get a
 * syntax error or a query they did not write. So the term is split on non-word characters and each word
 * is passed as DATA, to be quoted into a lexeme by the query itself.
 *
 * SIX WORDS AT MOST. Every additional word is another AND term the index has to intersect, and nobody
 * searches a shopfront with a sentence.
 */
function searchWords(term: string): string[] {
  return term
    .toLowerCase()
    // Unicode-aware: a store selling "Café" or "Ibirayi" must not lose letters to an ASCII-only split.
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
    .slice(0, 6);
}

/**
 * One page of a store's catalogue, by keyset.
 *
 * ONE ROW MORE THAN ASKED FOR tells us there is a next page without a COUNT over a table that grows —
 * the same shape as listPayouts(), for the same reason.
 *
 * TWO QUERY SHAPES, AND THE SPLIT IS A MEASURED ONE rather than a stylistic one:
 *
 *   BROWSING (no search term) walks the ordering index and stops at the page — 4 buffers for page one
 *   and 5 for a page 40,000 products deep, because the cursor is in the Index Cond. The same page by
 *   OFFSET is 992 buffers and 11.9 ms, which is what §2.3's keyset rule is about.
 *
 *   SEARCHING materialises the match set FIRST, then orders it. Written the obvious way — the text
 *   predicate beside the others, with ORDER BY and LIMIT — the planner ignores the GIN index entirely
 *   and walks the ordering index filtering as it goes, which is 1,283 buffers and 86 ms when nothing
 *   matches. MATERIALIZED forces the index scan to complete before the sort, and the same search is 3
 *   buffers and 0.045 ms. The CTE is load-bearing; inlining it silently restores the scan.
 *
 * The cost of materialising is that a search for a common word gathers every match before taking 25 —
 * 882 buffers for 2,500 matches. That is the right trade: it is bounded by the size of the match set,
 * where the scan was bounded by the size of the catalogue.
 */
export async function listProducts(
  storeId: string,
  options: {
    categoryId?: string | null;
    q?: string | null;
    limit?: number;
    after?: ProductCursor | null;
  } = {},
  on: Queryable = db,
): Promise<ProductPage> {
  const limit = Math.min(Math.max(1, options.limit ?? 24), MAX_PAGE);
  const categoryId = options.categoryId ?? null;
  const after = options.after ?? null;
  const afterPosition = after?.position ?? null;
  const afterId = after?.id ?? null;
  const words = searchWords(options.q ?? '');
  const searching = words.length > 0;

  // THE CURSOR'S SECOND COLUMN COMES FROM THE SAME TABLE AS ITS FIRST, and that is the whole reason
  // this is two strings rather than one. A section's page orders by product_categories.position, so its
  // tie-break must be product_categories.product_id — not products.id, which holds the same value but
  // lives in a different table, and a row comparison spanning two tables cannot enter either index's
  // condition. Written the other way the same page cost 2,658 buffers instead of 89.
  const position = categoryId === null ? 'p.position' : 'pc.position';
  const tie = categoryId === null ? 'p.id' : 'pc.product_id';

  const categoryJoin =
    categoryId === null
      ? ''
      : `JOIN product_categories pc
             ON pc.product_id = p.id AND pc.store_id = p.store_id AND pc.category_id = $2`;

  // $1 store, $2 category (when filtering), then the rest in order.
  let next = categoryId === null ? 2 : 3;
  const pWords = searching ? `$${next++}` : null;
  const pAfterPos = `$${next++}`;
  const pAfterId = `$${next++}`;
  const pLimit = `$${next++}`;

  const values: unknown[] = [storeId];
  if (categoryId !== null) values.push(categoryId);
  if (searching) values.push(words);
  values.push(afterPosition, afterId, limit + 1);

  // Each word becomes a QUOTED LEXEME with a prefix marker: quote_literal is what makes an arbitrary
  // word safe inside a tsquery, and ':*' is what makes "mil" find "Milk". Lower-cased above, because a
  // literal lexeme is not normalised by the configuration the way to_tsquery's input would be.
  const tsquery = `(SELECT string_agg(quote_literal(w) || ':*', ' & ')
                      FROM unnest(${pWords ?? "'{}'::text[]"}::text[]) AS w)::tsquery`;

  const where = `p.store_id = $1
              AND p.status = 'active'
              ${searching ? `AND to_tsvector('simple', p.name) @@ ${tsquery}` : ''}
              AND (${pAfterPos}::integer IS NULL
                   OR (${position}, ${tie}) > (${pAfterPos}::integer, ${pAfterId}::uuid))`;

  const text = searching
    ? // MATERIALIZED is not a hint, it is the plan. See the note above.
      `WITH hits AS MATERIALIZED (
         SELECT p.id, ${position} AS position
           FROM products p
           ${categoryJoin}
          WHERE ${where}
       )
       SELECT ${cardColumns('h.position')}
         FROM hits h
         JOIN products p ON p.id = h.id
         ${CARD_STOCK_JOIN}
        ORDER BY h.position, p.id
        LIMIT ${pLimit}`
    : `SELECT ${cardColumns(position)}
         FROM products p
         ${categoryJoin}
         ${CARD_STOCK_JOIN}
        WHERE ${where}
        ORDER BY ${position}, ${tie}
        LIMIT ${pLimit}`;

  const { rows } = await on.query<CardRow>(text, values);

  const items = rows.slice(0, limit).map(toCard);
  const last = rows[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined ? { position: last.position, id: last.id } : null;

  return { items, nextCursor };
}

/** One product, with its choices and its variant matrix. Null when it is not on this store's shopfront. */
export async function findProduct(
  storeId: string,
  productId: string,
  on: Queryable = db,
): Promise<ProductDetail | null> {
  const { rows } = await on.query<CardRow>(
    `SELECT ${cardColumns('p.position')}
       FROM products p
       ${CARD_STOCK_JOIN}
      WHERE p.store_id = $1 AND p.id = $2 AND p.status = 'active'`,
    [storeId, productId],
  );
  const row = rows[0];
  if (row === undefined) return null;

  // Sequential, not Promise.all: these may run inside a transaction, and milestone 11 found that
  // concurrent queries on one client produce unhandled rejections the moment the transaction aborts.
  const groups = await optionGroups(productId, on);
  const variants = await productVariants(productId, on);
  const { rows: catRows } = await on.query<{ category_id: string }>(
    `SELECT pc.category_id
       FROM product_categories pc
       JOIN categories c ON c.id = pc.category_id AND c.is_visible
      WHERE pc.product_id = $1
      ORDER BY c.position, c.id`,
    [productId],
  );

  return {
    ...toCard(row),
    trackStock: row.track_stock,
    groups,
    variants,
    categoryIds: catRows.map((r) => r.category_id),
  };
}

/**
 * A product's option groups and their values, in the merchant's order.
 *
 * ONE QUERY, NOT ONE PER GROUP. A product with four groups would otherwise be five round trips, and
 * the sheet cannot render until the last of them lands.
 */
export async function optionGroups(
  productId: string,
  on: Queryable = db,
): Promise<ProductOptionGroup[]> {
  const { rows } = await on.query<{
    id: string;
    name: string;
    select_mode: 'one' | 'several';
    is_required: boolean;
    value_id: string | null;
    label: string | null;
    price_delta: string | null;
    is_available: boolean | null;
  }>(
    `SELECT g.id, g.name, g.select_mode, g.is_required,
            ov.id AS value_id, ov.label, ov.price_delta::text AS price_delta, ov.is_available
       FROM product_option_groups pog
       JOIN option_groups g ON g.id = pog.option_group_id
       LEFT JOIN option_values ov ON ov.option_group_id = g.id
      WHERE pog.product_id = $1
      ORDER BY pog.position, g.id, ov.position, ov.id`,
    [productId],
  );

  const groups: ProductOptionGroup[] = [];
  for (const row of rows) {
    let group = groups[groups.length - 1];
    if (group === undefined || group.id !== row.id) {
      group = {
        id: row.id,
        name: row.name,
        selectMode: row.select_mode,
        isRequired: row.is_required,
        values: [],
      };
      groups.push(group);
    }
    // LEFT JOIN, so a group a merchant has emptied arrives as one row with no value.
    if (row.value_id !== null && row.label !== null && row.price_delta !== null) {
      group.values.push({
        id: row.value_id,
        label: row.label,
        priceDelta: row.price_delta,
        isAvailable: row.is_available ?? false,
      });
    }
  }
  return groups;
}

/**
 * The variant matrix: every purchasable combination with its own count.
 *
 * This is the table the old schema could not express — V003's own note. A twelve-row linen tee arrives
 * as twelve rows each naming its size and its colour, which is what lets the sheet strike through
 * XL/Black while leaving XL/Olive pickable.
 */
export async function productVariants(
  productId: string,
  on: Queryable = db,
): Promise<ProductVariant[]> {
  const { rows } = await on.query<{
    id: string;
    sku: string | null;
    stock_quantity: number | null;
    is_available: boolean;
    is_default: boolean;
    option_value_ids: string[] | null;
  }>(
    `SELECT v.id, v.sku, v.stock_quantity, v.is_available, v.is_default,
            (SELECT array_agg(vv.option_value_id ORDER BY vv.option_group_id)
               FROM product_variant_values vv
              WHERE vv.variant_id = v.id) AS option_value_ids
       FROM product_variants v
      WHERE v.product_id = $1
      ORDER BY v.position, v.id`,
    [productId],
  );
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku,
    stockQuantity: r.stock_quantity,
    isAvailable: r.is_available,
    isDefault: r.is_default,
    optionValueIds: r.option_value_ids ?? [],
  }));
}
