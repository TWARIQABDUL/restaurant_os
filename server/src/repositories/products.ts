// server/src/repositories/products.ts — milestone 22.
//
// The merchant's side of the catalogue: the Products list, and AddProduct's whole save. The shopper's
// side — `repositories/catalogue.ts` — reads the same tables for a different reader and is left alone.
//
// EVERY AMOUNT LEAVES HERE AS A STRING, for the reason catalogue.ts gives: numeric(12,2) arrives as text and
// stays text, and the client turns it into minor units through packages/core.
//
// SAVING A PRODUCT IS ONE TRANSACTION AND NO FUNCTION. V003's matrix rules — "a variant names one value from
// each pick-one group", "no two variants share a combination", "a tracked product's variants all carry a
// count" — are DEFERRED constraint triggers, so a transaction can build a product up in whatever order is
// convenient and be checked once, at COMMIT. This file's job is therefore the part the database cannot know:
// what the editor MEANT. Which of the combinations on screen already exist, which values were removed, whether
// removing one is allowed. See `save()`.
//
// WHAT CANNOT BE CHANGED ONCE SOMETHING HAS BEEN SOLD, and it is refused rather than worked around. An order
// line points at a variant (V004: ON DELETE RESTRICT, "a variant with orders against it is part of the
// record"), so a product whose option STRUCTURE changes — a pick-one group added or removed — would need its
// sold variants deleted. The alternatives are to silently re-point history at a different combination or to
// keep zombie rows nobody can see, and both are worse than a clear sentence: the merchant can still change
// every price, name, photo and count, add or rename values, and hide the product.

import { badRequest, conflict, db, notFound } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';

const PAGE = 25;

/** A decimal money string, the same shape every numeric column in this schema takes as text. */
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

export type ListTab = 'all' | 'active' | 'draft' | 'low' | 'out';
export type ListSort = 'best' | 'newest' | 'price' | 'stock';
export type StockState = 'ok' | 'low' | 'out' | 'draft';

export type ListQuery = {
  tab: ListTab;
  q: string;
  categoryId: string | null;
  sort: ListSort;
  page: number;
};

export type ProductRow = {
  id: string;
  name: string;
  /** The board's second line: "2 option groups · SKU NY-001", or "Not visible to customers". */
  sub: string;
  categories: string[];
  price: string;
  trackStock: boolean;
  /** Null when the product does not track stock. */
  stock: number | null;
  state: StockState;
  status: 'active' | 'draft';
  coverImageUrl: string | null;
};

export type ProductList = {
  rows: ProductRow[];
  /** Matches the active tab, search and category — the "of 182" in "Showing 1–8 of 182". */
  total: number;
  page: number;
  pageSize: number;
  /** The whole store's, regardless of filters: the tabs' own numbers. */
  counts: Record<ListTab, number>;
};

/**
 * One product's state, derived once and used by both the tab counts and the rows, so the number on a tab can
 * never disagree with what the tab then shows.
 *
 *   draft  hidden from the store, whatever its stock
 *   out    tracks stock and nothing that is still offered has any left
 *   low    tracks stock and at least one offered variant is at or below the merchant's threshold
 *
 * "Low" is per VARIANT, like catalogue.ts's storefront badge: a T-shirt with eleven sizes in stock and one
 * nearly gone is low, and a total would hide it.
 */
const STATE_FROM = `
  FROM products p
  CROSS JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE v.is_available AND (NOT p.track_stock OR v.stock_quantity > 0)) AS buyable,
      sum(v.stock_quantity) FILTER (WHERE p.track_stock)                                    AS stock_total,
      COALESCE(bool_or(v.is_available AND v.stock_quantity > 0
                       AND v.stock_quantity <= p.low_stock_threshold), false)               AS any_low
      FROM product_variants v
     WHERE v.product_id = p.id
  ) st`;

const STATE_EXPR = `
  CASE
    WHEN p.status = 'draft'                    THEN 'draft'
    WHEN p.track_stock AND st.buyable = 0      THEN 'out'
    WHEN p.track_stock AND st.any_low          THEN 'low'
    ELSE 'ok'
  END`;

type ListRow = {
  id: string;
  name: string;
  status: 'active' | 'draft';
  price: string;
  track_stock: boolean;
  stock_total: string | null;
  cover_image_url: string | null;
  state: StockState;
  option_groups: string;
  sku: string | null;
  categories: string[] | null;
  total: string;
};

export async function list(storeId: string, query: ListQuery, on: Queryable = db): Promise<ProductList> {
  const where: string[] = ['p.store_id = $1'];
  const params: unknown[] = [storeId];

  if (query.q !== '') {
    // Name OR SKU, as the board's own placeholder says: "Search by name or SKU". Prefix-matched on words for
    // the name, the rule V018 measured for the storefront; a SKU is matched whole-prefix.
    params.push(`%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(
      `(p.name ILIKE $${params.length}
        OR EXISTS (SELECT 1 FROM product_variants sv WHERE sv.product_id = p.id AND sv.sku ILIKE $${params.length}))`,
    );
  }
  if (query.categoryId !== null) {
    params.push(query.categoryId);
    where.push(`EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = $${params.length})`);
  }
  if (query.tab === 'active') where.push(`p.status = 'active'`);
  if (query.tab === 'draft') where.push(`p.status = 'draft'`);
  if (query.tab === 'low') where.push(`(${STATE_EXPR}) = 'low'`);
  if (query.tab === 'out') where.push(`(${STATE_EXPR}) = 'out'`);

  // ONE PASS over the store's order lines, grouped by product, then joined — not a lateral subquery per product.
  // Measured at 30,000 lines: the per-product form read the whole of order_items once PER PRODUCT (91,296
  // buffers for ten products, and it grows with the catalogue); this reads it once. "Best selling" is
  // all-time units on orders that were not turned away, which is what the board's tab is named for.
  const sold =
    query.sort === 'best'
      ? `LEFT JOIN (
           SELECT sv.product_id, sum(oi.quantity) AS n
             FROM order_items oi
             JOIN product_variants sv ON sv.id = oi.variant_id
             JOIN orders o ON o.id = oi.order_id AND o.store_id = oi.store_id
            WHERE oi.store_id = $1 AND o.status NOT IN ('rejected', 'cancelled')
            GROUP BY sv.product_id
         ) sold ON sold.product_id = p.id`
      : '';
  const order: Record<ListSort, string> = {
    best: 'sold.n DESC NULLS LAST, p.created_at DESC, p.id',
    newest: 'p.created_at DESC, p.id',
    price: 'p.base_price ASC, p.id',
    stock: 'st.stock_total ASC NULLS LAST, p.id',
  };

  const size = PAGE;
  params.push(size, (Math.max(1, query.page) - 1) * size);

  const { rows } = await on.query<ListRow>(
    `SELECT p.id, p.name, p.status, p.base_price::text AS price, p.track_stock,
            st.stock_total::text AS stock_total, p.cover_image_url,
            ${STATE_EXPR} AS state,
            (SELECT count(*) FROM product_option_groups pog WHERE pog.product_id = p.id)::text AS option_groups,
            (SELECT v.sku FROM product_variants v WHERE v.product_id = p.id ORDER BY v.is_default DESC, v.position, v.id LIMIT 1) AS sku,
            (SELECT array_agg(c.name ORDER BY c.position, c.id)
               FROM product_categories pc JOIN categories c ON c.id = pc.category_id
              WHERE pc.product_id = p.id) AS categories,
            count(*) OVER ()::text AS total
       ${STATE_FROM}
       ${sold}
      WHERE ${where.join(' AND ')}
      ORDER BY ${order[query.sort]}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const counted = await on.query<{ tab: ListTab; n: string }>(
    `SELECT t.tab, count(*)::text AS n
       FROM (
         SELECT p.id, p.status, ${STATE_EXPR} AS state ${STATE_FROM} WHERE p.store_id = $1
       ) d
       CROSS JOIN LATERAL (VALUES
         ('all', true),
         ('active', d.status = 'active'),
         ('draft', d.status = 'draft'),
         ('low', d.state = 'low'),
         ('out', d.state = 'out')
       ) AS t(tab, hit)
      WHERE t.hit
      GROUP BY t.tab`,
    [storeId],
  );
  const counts: Record<ListTab, number> = { all: 0, active: 0, draft: 0, low: 0, out: 0 };
  for (const c of counted.rows) counts[c.tab] = Number(c.n);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      sub: subline(r),
      categories: r.categories ?? [],
      price: r.price,
      trackStock: r.track_stock,
      stock: r.track_stock ? Number(r.stock_total ?? 0) : null,
      state: r.state,
      status: r.status,
      coverImageUrl: r.cover_image_url,
    })),
    total: rows[0] === undefined ? 0 : Number(rows[0].total),
    page: Math.max(1, query.page),
    pageSize: size,
    counts,
  };
}

function subline(r: ListRow): string {
  const groups = Number(r.option_groups);
  const parts: string[] = [];
  if (groups > 0) parts.push(`${groups} option group${groups === 1 ? '' : 's'}`);
  if (r.sku !== null) parts.push(`SKU ${r.sku}`);
  if (r.status === 'draft' && parts.length === 0) return 'Not visible to customers';
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// One product, as the editor reads it
// ---------------------------------------------------------------------------

export type EditorValue = {
  /** The value's id for a saved one; the editor invents one for a new value and the server replaces it. */
  key: string;
  label: string;
  priceDelta: string;
};

export type EditorGroup = {
  id: string;
  /** Attached from the store's shared groups — shown, not edited here. */
  shared: boolean;
  name: string;
  mode: 'one' | 'several';
  values: EditorValue[];
};

export type EditorVariant = {
  /** Value keys, one per pick-one group, in the order those groups appear. Empty for the default variant. */
  combo: string[];
  label: string;
  sku: string | null;
  stock: number | null;
  available: boolean;
};

export type ProductEditor = {
  id: string;
  name: string;
  description: string;
  price: string;
  compareAtPrice: string | null;
  status: 'active' | 'draft';
  categoryIds: string[];
  images: { id: string; url: string }[];
  trackStock: boolean;
  /** The no-options case's own SKU and count, which live on the product's one default variant. */
  sku: string | null;
  stock: number | null;
  groups: EditorGroup[];
  variants: EditorVariant[];
  /** Something has been ordered. Locks the option STRUCTURE (see the header), nothing else. */
  sold: boolean;
};

type ProductRowRaw = {
  id: string;
  name: string;
  description: string;
  price: string;
  compare_at_price: string | null;
  status: 'active' | 'draft';
  track_stock: boolean;
};

export async function get(storeId: string, productId: string, on: Queryable = db): Promise<ProductEditor | null> {
  const p = await on.query<ProductRowRaw>(
    `SELECT id, name, description, base_price::text AS price, compare_at_price::text AS compare_at_price, status, track_stock
       FROM products WHERE id = $1 AND store_id = $2`,
    [productId, storeId],
  );
  const product = p.rows[0];
  if (product === undefined) return null;

  const [cats, imgs, groups, variants, sold] = await Promise.all([
    on.query<{ category_id: string }>(`SELECT category_id FROM product_categories WHERE product_id = $1 ORDER BY category_id`, [productId]),
    on.query<{ id: string; url: string }>(`SELECT id, url FROM product_images WHERE product_id = $1 ORDER BY position, id`, [productId]),
    on.query<{ gid: string; shared: boolean; name: string; mode: 'one' | 'several'; vid: string | null; label: string | null; delta: string | null }>(
      `SELECT g.id AS gid, (g.product_id IS NULL) AS shared, g.name, g.select_mode AS mode,
              ov.id AS vid, ov.label, ov.price_delta::text AS delta
         FROM product_option_groups pog
         JOIN option_groups g ON g.id = pog.option_group_id
         LEFT JOIN option_values ov ON ov.option_group_id = g.id
        WHERE pog.product_id = $1
        ORDER BY pog.position, g.id, ov.position, ov.id`,
      [productId],
    ),
    on.query<{ id: string; sku: string | null; stock: number | null; available: boolean; is_default: boolean; values: string[] | null; labels: string[] | null }>(
      `SELECT v.id, v.sku, v.stock_quantity AS stock, v.is_available AS available, v.is_default,
              array_agg(pv.option_value_id ORDER BY pog.position, pv.option_group_id) FILTER (WHERE pv.option_value_id IS NOT NULL) AS values,
              array_agg(ov.label            ORDER BY pog.position, pv.option_group_id) FILTER (WHERE pv.option_value_id IS NOT NULL) AS labels
         FROM product_variants v
         LEFT JOIN product_variant_values pv ON pv.variant_id = v.id
         LEFT JOIN product_option_groups pog ON pog.product_id = v.product_id AND pog.option_group_id = pv.option_group_id
         LEFT JOIN option_values ov ON ov.id = pv.option_value_id
        WHERE v.product_id = $1
        GROUP BY v.id
        ORDER BY v.is_default DESC, v.position, v.id`,
      [productId],
    ),
    on.query(`SELECT 1 FROM order_items oi JOIN product_variants v ON v.id = oi.variant_id WHERE v.product_id = $1 LIMIT 1`, [productId]),
  ]);

  const byGroup = new Map<string, EditorGroup>();
  for (const r of groups.rows) {
    let g = byGroup.get(r.gid);
    if (g === undefined) {
      g = { id: r.gid, shared: r.shared, name: r.name, mode: r.mode, values: [] };
      byGroup.set(r.gid, g);
    }
    if (r.vid !== null && r.label !== null && r.delta !== null) g.values.push({ key: r.vid, label: r.label, priceDelta: r.delta });
  }

  const defaultVariant = variants.rows.find((v) => v.is_default);
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    compareAtPrice: product.compare_at_price,
    status: product.status,
    categoryIds: cats.rows.map((c) => c.category_id),
    images: imgs.rows,
    trackStock: product.track_stock,
    sku: defaultVariant?.sku ?? null,
    stock: defaultVariant?.stock ?? null,
    groups: [...byGroup.values()],
    variants: variants.rows
      .filter((v) => !v.is_default)
      .map((v) => ({
        combo: v.values ?? [],
        label: (v.labels ?? []).join(' / '),
        sku: v.sku,
        stock: v.stock,
        available: v.available,
      })),
    sold: sold.rows.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export type GroupInput =
  | { shared: true; id: string }
  | { shared: false; id: string | null; name: string; mode: 'one' | 'several'; values: { key: string; label: string; priceDelta: string }[] };

export type ProductInput = {
  name: string;
  description: string;
  price: string;
  compareAtPrice: string | null;
  status: 'active' | 'draft';
  categoryIds: string[];
  /** URLs the image store issued, in order. The first is the cover. */
  images: string[];
  trackStock: boolean;
  /** Used only when the product has no pick-one group. */
  sku: string | null;
  stock: number | null;
  groups: GroupInput[];
  variants: { combo: string[]; sku: string | null; stock: number | null; available: boolean }[];
};

type ExistingGroup = { id: string; shared: boolean; mode: 'one' | 'several'; position: number };
type ExistingVariant = { id: string; is_default: boolean; values: string[] | null };

/**
 * Creates (`productId` null) or replaces one product in a single transaction, and returns it as the editor
 * reads it. `tx` is a Tx rather than a Queryable on purpose: this must never run outside one.
 */
export async function save(storeId: string, productId: string | null, input: ProductInput, tx: Tx): Promise<ProductEditor> {
  validate(input);
  try {
    return await saveInside(storeId, productId, input, tx);
  } catch (cause) {
    // The two unique indexes a merchant can actually hit, named for what they mean. Everything else keeps
    // db/errors.ts' translation.
    const constraint = (cause as { constraint?: unknown } | null)?.constraint;
    if (constraint === 'product_variants_store_sku_key') {
      throw conflict('That SKU is already used by another variant in your store. SKUs have to be unique.', 'SKU_TAKEN');
    }
    if (constraint === 'option_groups_private_name_key') {
      throw badRequest('Two of this product’s options have the same name.', 'DUPLICATE_OPTION');
    }
    throw cause;
  }
}

async function saveInside(storeId: string, productId: string | null, input: ProductInput, tx: Tx): Promise<ProductEditor> {
  let id: string;
  if (productId === null) {
    const created = await tx.query<{ id: string }>(
      `INSERT INTO products (store_id, name, description, base_price, compare_at_price, track_stock, status, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               COALESCE((SELECT max(position) FROM products WHERE store_id = $1), 0) + 1)
       RETURNING id`,
      [storeId, input.name, input.description, input.price, input.compareAtPrice, input.trackStock, input.status],
    );
    id = created.rows[0]!.id;
  } else {
    const locked = await tx.query(`SELECT 1 FROM products WHERE id = $1 AND store_id = $2 FOR UPDATE`, [productId, storeId]);
    if (locked.rows.length === 0) throw notFound('That product does not exist.', 'PRODUCT_NOT_FOUND');
    id = productId;
    await tx.query(
      `UPDATE products
          SET name = $3, description = $4, base_price = $5, compare_at_price = $6, track_stock = $7, status = $8
        WHERE id = $1 AND store_id = $2`,
      [id, storeId, input.name, input.description, input.price, input.compareAtPrice, input.trackStock, input.status],
    );
  }

  await saveImages(id, storeId, input.images, tx);
  await saveCategories(id, storeId, input.categoryIds, tx);
  await saveOptionsAndVariants(id, storeId, input, tx);

  const saved = await get(storeId, id, tx);
  if (saved === null) throw new Error('a product vanished inside its own transaction');
  return saved;
}

function validate(input: ProductInput): void {
  if (!MONEY.test(input.price)) throw badRequest('Enter the price as a number, like 3500.', 'INVALID_PRICE');
  if (input.compareAtPrice !== null) {
    if (!MONEY.test(input.compareAtPrice)) throw badRequest('Enter the compare-at price as a number.', 'INVALID_PRICE');
    if (Number(input.compareAtPrice) <= Number(input.price)) {
      throw badRequest('The compare-at price has to be higher than the price, or there is no discount to show.', 'COMPARE_AT_NOT_HIGHER');
    }
  }
  if (input.images.length > 8) throw badRequest('A product can have up to 8 photos.', 'TOO_MANY_PHOTOS');

  const names = new Set<string>();
  for (const g of input.groups) {
    if (g.shared) continue;
    const key = g.name.trim().toLowerCase();
    if (key === '') throw badRequest('Give every option a name, or remove it.', 'OPTION_NAME_REQUIRED');
    if (names.has(key)) throw badRequest(`This product has two options called “${g.name.trim()}”.`, 'DUPLICATE_OPTION');
    names.add(key);
    if (g.values.length === 0) {
      throw badRequest(`Add at least one value to “${g.name.trim()}”, or remove it.`, 'OPTION_NEEDS_VALUES');
    }
    const labels = new Set<string>();
    for (const v of g.values) {
      const l = v.label.trim().toLowerCase();
      if (l === '') throw badRequest(`“${g.name.trim()}” has a value with no name.`, 'VALUE_NAME_REQUIRED');
      if (labels.has(l)) throw badRequest(`“${g.name.trim()}” lists “${v.label.trim()}” twice.`, 'DUPLICATE_VALUE');
      labels.add(l);
      if (!MONEY.test(v.priceDelta)) throw badRequest(`“${v.label.trim()}” has an extra price that is not a number.`, 'INVALID_PRICE');
    }
  }
  const skus = new Set<string>();
  for (const v of input.variants) {
    if (v.sku === null) continue;
    const k = v.sku.trim().toLowerCase();
    if (skus.has(k)) throw badRequest(`The SKU “${v.sku}” is used on two variants.`, 'DUPLICATE_SKU');
    skus.add(k);
  }
  for (const stock of [input.stock, ...input.variants.map((v) => v.stock)]) {
    if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000)) {
      throw badRequest('Stock has to be a whole number, zero or more.', 'INVALID_STOCK');
    }
  }
}

async function saveImages(productId: string, storeId: string, urls: string[], tx: Tx): Promise<void> {
  const current = await tx.query<{ url: string }>(`SELECT url FROM product_images WHERE product_id = $1 ORDER BY position, id`, [productId]);
  if (current.rows.length === urls.length && current.rows.every((r, i) => r.url === urls[i])) return;

  await tx.query(`DELETE FROM product_images WHERE product_id = $1`, [productId]);
  for (const [i, url] of urls.entries()) {
    await tx.query(`INSERT INTO product_images (product_id, store_id, url, position) VALUES ($1, $2, $3, $4)`, [productId, storeId, url, i + 1]);
  }
}

async function saveCategories(productId: string, storeId: string, ids: string[], tx: Tx): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length > 0) {
    const found = await tx.query(`SELECT 1 FROM categories WHERE store_id = $1 AND id = ANY($2::uuid[])`, [storeId, unique]);
    if (found.rows.length !== unique.length) throw badRequest('One of those sections no longer exists. Reload the page.', 'CATEGORY_NOT_FOUND');
  }
  await tx.query(`DELETE FROM product_categories WHERE product_id = $1 AND NOT (category_id = ANY($2::uuid[]))`, [productId, unique]);
  // Appended at the END of each section: Categories' "Order here is the order on your store" is the merchant's
  // to change, and a new product should not leap to the top of a section they have arranged.
  await tx.query(
    `INSERT INTO product_categories (product_id, category_id, store_id, position)
     SELECT $1, c.id, $2, COALESCE((SELECT max(pc.position) FROM product_categories pc WHERE pc.category_id = c.id), 0) + 1
       FROM categories c
      WHERE c.store_id = $2 AND c.id = ANY($3::uuid[])
     ON CONFLICT (product_id, category_id) DO NOTHING`,
    [productId, storeId, unique],
  );
}

async function saveOptionsAndVariants(productId: string, storeId: string, input: ProductInput, tx: Tx): Promise<void> {
  const attached = await tx.query<ExistingGroup>(
    `SELECT g.id, (g.product_id IS NULL) AS shared, g.select_mode AS mode, pog.position
       FROM product_option_groups pog JOIN option_groups g ON g.id = pog.option_group_id
      WHERE pog.product_id = $1`,
    [productId],
  );
  const attachedById = new Map(attached.rows.map((g) => [g.id, g]));
  const oldOnes = new Set(attached.rows.filter((g) => g.mode === 'one').map((g) => g.id));

  // 1. Resolve what the payload's groups will be, creating no rows yet: the answer to "did the shape change"
  // has to be known BEFORE anything is deleted.
  const sharedIds = input.groups.filter((g): g is Extract<GroupInput, { shared: true }> => g.shared).map((g) => g.id);
  const sharedInfo = new Map<string, { mode: 'one' | 'several' }>();
  if (sharedIds.length > 0) {
    const r = await tx.query<{ id: string; mode: 'one' | 'several' }>(
      `SELECT id, select_mode AS mode FROM option_groups WHERE store_id = $1 AND product_id IS NULL AND id = ANY($2::uuid[])`,
      [storeId, sharedIds],
    );
    for (const g of r.rows) sharedInfo.set(g.id, { mode: g.mode });
    if (sharedInfo.size !== new Set(sharedIds).size) throw badRequest('One of the shared options no longer exists. Reload the page.', 'OPTION_NOT_FOUND');
  }

  for (const g of input.groups) {
    if (g.shared || g.id === null) continue;
    const existing = attachedById.get(g.id);
    if (existing === undefined || existing.shared) throw badRequest('One of those options is not on this product. Reload the page.', 'OPTION_NOT_FOUND');
  }

  const newOnes = new Set<string>();
  for (const g of input.groups) {
    const mode = g.shared ? sharedInfo.get(g.id)!.mode : g.mode;
    // A new group has no id yet; the marker cannot equal a real uuid, so it always reads as "different".
    if (mode === 'one') newOnes.add(g.id ?? `new:${g.shared ? '' : g.name.trim().toLowerCase()}`);
  }
  const shapeChanged = oldOnes.size !== newOnes.size || [...oldOnes].some((gid) => !newOnes.has(gid));

  const soldBefore = await tx.query(
    `SELECT 1 FROM order_items oi JOIN product_variants v ON v.id = oi.variant_id WHERE v.product_id = $1 LIMIT 1`,
    [productId],
  );
  const hasSold = soldBefore.rows.length > 0;

  if (shapeChanged) {
    if (hasSold) {
      throw conflict(
        'This product has been ordered, so its options can’t be restructured. You can change prices, photos, stock and values, or hide it and add a new product.',
        'OPTIONS_LOCKED',
      );
    }
    await deleteVariants(tx, `product_id = $1`, [productId]);
  }

  // 2. Groups: remove what is gone, then upsert what is there.
  const keep = new Set(input.groups.map((g) => g.id).filter((x): x is string => x !== null));
  const goneGroups = attached.rows.filter((g) => !keep.has(g.id));
  if (goneGroups.length > 0) {
    const ids = goneGroups.map((g) => g.id);
    const ordered = await tx.query<{ name: string }>(
      `SELECT DISTINCT g.name
         FROM order_item_option_values oiv
         JOIN option_values ov ON ov.id = oiv.option_value_id
         JOIN option_groups g ON g.id = ov.option_group_id
        WHERE g.id = ANY($1::uuid[]) AND g.product_id = $2`,
      [ids, productId],
    );
    if (ordered.rows.length > 0) {
      throw conflict(`“${ordered.rows[0]!.name}” has been ordered, so it can’t be removed. Rename it, or hide the product.`, 'OPTION_IN_USE');
    }
    await tx.query(`DELETE FROM product_option_groups WHERE product_id = $1 AND option_group_id = ANY($2::uuid[])`, [productId, ids]);
    await tx.query(`DELETE FROM option_groups WHERE product_id = $1 AND id = ANY($2::uuid[])`, [productId, ids]);
  }

  const keyToId = new Map<string, string>();
  for (const [position, g] of input.groups.entries()) {
    if (g.shared) {
      await upsertAttachment(tx, productId, storeId, g.id, position + 1);
      const values = await tx.query<{ id: string }>(`SELECT id FROM option_values WHERE option_group_id = $1`, [g.id]);
      for (const v of values.rows) keyToId.set(v.id, v.id);
      continue;
    }
    let groupId = g.id;
    if (groupId === null) {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO option_groups (store_id, product_id, name, select_mode, is_required, position)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [storeId, productId, g.name.trim(), g.mode, g.mode === 'one', position + 1],
      );
      groupId = created.rows[0]!.id;
    } else {
      await tx.query(
        `UPDATE option_groups SET name = $2, select_mode = $3, is_required = $4, position = $5 WHERE id = $1`,
        [groupId, g.name.trim(), g.mode, g.mode === 'one', position + 1],
      );
    }
    await upsertAttachment(tx, productId, storeId, groupId, position + 1);
    await saveValues(tx, storeId, groupId, g.values, keyToId);
  }

  // 3. Variants.
  await saveVariants(tx, productId, storeId, input, keyToId);
}

/**
 * Deletes variants, and the cart lines that point at them first. A cart is a basket somebody has not paid for
 * (V003: expires in seven days) and its line RESTRICTs the variant, so without this a product sitting in one
 * shopper's cart could be neither deleted nor restructured, and the merchant would be told it was "in use" by
 * a basket they cannot see. An ORDER line is different — that is the record — and the callers check for it
 * before they get here.
 */
async function deleteVariants(tx: Tx, where: string, params: unknown[]): Promise<void> {
  await tx.query(`DELETE FROM cart_items WHERE variant_id IN (SELECT id FROM product_variants WHERE ${where})`, params);
  await tx.query(`DELETE FROM product_variants WHERE ${where}`, params);
}

async function upsertAttachment(tx: Tx, productId: string, storeId: string, groupId: string, position: number): Promise<void> {
  await tx.query(
    `INSERT INTO product_option_groups (product_id, option_group_id, store_id, position)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id, option_group_id) DO UPDATE SET position = EXCLUDED.position`,
    [productId, groupId, storeId, position],
  );
}

async function saveValues(
  tx: Tx,
  storeId: string,
  groupId: string,
  values: { key: string; label: string; priceDelta: string }[],
  keyToId: Map<string, string>,
): Promise<void> {
  const existing = await tx.query<{ id: string; label: string }>(`SELECT id, label FROM option_values WHERE option_group_id = $1`, [groupId]);
  const existingIds = new Set(existing.rows.map((v) => v.id));
  const payloadKeys = new Set(values.map((v) => v.key));
  const gone = existing.rows.filter((v) => !payloadKeys.has(v.id));

  for (const v of gone) {
    // A value that was ordered, or sits in a variant that was, stays part of the record.
    const ordered = await tx.query(
      `SELECT 1 FROM order_item_option_values WHERE option_value_id = $1
       UNION ALL
       SELECT 1 FROM order_items oi
         JOIN product_variant_values pv ON pv.variant_id = oi.variant_id
        WHERE pv.option_value_id = $1
        LIMIT 1`,
      [v.id],
    );
    if (ordered.rows.length > 0) {
      throw conflict(`“${v.label}” has been ordered, so it can’t be removed. Rename it instead.`, 'VALUE_IN_USE');
    }
    await deleteVariants(tx, `id IN (SELECT variant_id FROM product_variant_values WHERE option_value_id = $1)`, [v.id]);
    await tx.query(`DELETE FROM option_values WHERE id = $1`, [v.id]);
  }

  for (const [position, v] of values.entries()) {
    if (existingIds.has(v.key)) {
      await tx.query(`UPDATE option_values SET label = $2, price_delta = $3, position = $4 WHERE id = $1`, [v.key, v.label.trim(), v.priceDelta, position + 1]);
      keyToId.set(v.key, v.key);
    } else {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO option_values (option_group_id, store_id, label, price_delta, position) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [groupId, storeId, v.label.trim(), v.priceDelta, position + 1],
      );
      keyToId.set(v.key, created.rows[0]!.id);
    }
  }
}

async function saveVariants(tx: Tx, productId: string, storeId: string, input: ProductInput, keyToId: Map<string, string>): Promise<void> {
  // The pick-one groups, in the payload's order — the order a variant's combination is read in.
  const oneGroups: { id: string; valueIds: string[] }[] = [];
  const attached = await tx.query<{ id: string; mode: 'one' | 'several' }>(
    `SELECT g.id, g.select_mode AS mode FROM product_option_groups pog JOIN option_groups g ON g.id = pog.option_group_id
      WHERE pog.product_id = $1 ORDER BY pog.position, g.id`,
    [productId],
  );
  for (const g of attached.rows) {
    if (g.mode !== 'one') continue;
    const v = await tx.query<{ id: string }>(`SELECT id FROM option_values WHERE option_group_id = $1 ORDER BY position, id`, [g.id]);
    oneGroups.push({ id: g.id, valueIds: v.rows.map((x) => x.id) });
  }

  const stockFor = (n: number | null): number | null => (input.trackStock ? (n ?? 0) : null);
  const skuFor = (s: string | null): string | null => (s === null || s.trim() === '' ? null : s.trim());

  const existing = await tx.query<ExistingVariant>(
    `SELECT v.id, v.is_default, array_agg(pv.option_value_id ORDER BY pv.option_group_id) FILTER (WHERE pv.option_value_id IS NOT NULL) AS values
       FROM product_variants v LEFT JOIN product_variant_values pv ON pv.variant_id = v.id
      WHERE v.product_id = $1 GROUP BY v.id`,
    [productId],
  );
  const signature = (ids: string[]): string => [...ids].sort().join('|');
  const byCombo = new Map(existing.rows.map((v) => [signature(v.values ?? []), v]));

  if (oneGroups.length === 0) {
    const found = byCombo.get('');
    if (found === undefined) {
      await tx.query(
        `INSERT INTO product_variants (product_id, store_id, sku, stock_quantity, is_available, is_default, position)
         VALUES ($1, $2, $3, $4, true, true, 1)`,
        [productId, storeId, skuFor(input.sku), stockFor(input.stock)],
      );
    } else {
      await tx.query(`UPDATE product_variants SET sku = $2, stock_quantity = $3 WHERE id = $1`, [found.id, skuFor(input.sku), stockFor(input.stock)]);
    }
    return;
  }

  // The payload's rows, by the real ids their keys resolved to.
  const supplied = new Map<string, ProductInput['variants'][number]>();
  for (const row of input.variants) {
    const ids = row.combo.map((k) => keyToId.get(k));
    if (ids.some((x) => x === undefined) || ids.length !== oneGroups.length) {
      throw badRequest('A variant names an option that is not on this product. Reload the page.', 'VARIANT_MISMATCH');
    }
    supplied.set(signature(ids as string[]), row);
  }

  let combos: string[][] = [[]];
  for (const g of oneGroups) combos = combos.flatMap((c) => g.valueIds.map((v) => [...c, v]));

  const wanted = new Set<string>();
  for (const [i, combo] of combos.entries()) {
    const sig = signature(combo);
    wanted.add(sig);
    const row = supplied.get(sig);
    const sku = skuFor(row?.sku ?? null);
    const stock = stockFor(row?.stock ?? null);
    const available = row?.available ?? true;
    const found = byCombo.get(sig);
    if (found !== undefined) {
      await tx.query(`UPDATE product_variants SET sku = $2, stock_quantity = $3, is_available = $4, position = $5 WHERE id = $1`, [found.id, sku, stock, available, i + 1]);
    } else {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO product_variants (product_id, store_id, sku, stock_quantity, is_available, is_default, position)
         VALUES ($1, $2, $3, $4, $5, false, $6) RETURNING id`,
        [productId, storeId, sku, stock, available, i + 1],
      );
      const variantId = created.rows[0]!.id;
      for (const [gi, valueId] of combo.entries()) {
        await tx.query(
          `INSERT INTO product_variant_values (variant_id, option_group_id, option_value_id, product_id) VALUES ($1, $2, $3, $4)`,
          [variantId, oneGroups[gi]!.id, valueId, productId],
        );
      }
    }
  }
  // Anything left over is a combination that no longer exists. Shape changes and removed values already
  // cleared theirs, so this is the backstop for a payload that simply omitted rows.
  for (const [sig, v] of byCombo) {
    if (!wanted.has(sig)) await deleteVariants(tx, `id = $1`, [v.id]);
  }
}

// ---------------------------------------------------------------------------
// Bulk actions and deletion
// ---------------------------------------------------------------------------

export type BulkAction = { kind: 'activate' } | { kind: 'draft' } | { kind: 'category'; categoryId: string } | { kind: 'delete' };

export type BulkResult = { changed: number; kept: { id: string; name: string }[] };

/**
 * One action over a selection. Always scoped to the store, so an id from somewhere else is simply not
 * selected rather than being acted on.
 *
 * DELETE REFUSES WHAT HAS BEEN ORDERED, and says which. An order line holds its variant (RESTRICT) and a
 * review holds its product (V009): deleting either would rewrite what somebody bought or said. Those are
 * returned in `kept` for the screen to name, and the rest are deleted — a bulk delete that failed whole
 * because one product in forty had a sale would make the action useless on exactly the stores that use it.
 */
export async function bulk(storeId: string, ids: string[], action: BulkAction, tx: Tx): Promise<BulkResult> {
  const mine = await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM products WHERE store_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [storeId, ids],
  );
  const own = mine.rows;
  if (own.length === 0) return { changed: 0, kept: [] };
  const ownIds = own.map((p) => p.id);

  if (action.kind === 'activate' || action.kind === 'draft') {
    const status = action.kind === 'activate' ? 'active' : 'draft';
    const r = await tx.query(`UPDATE products SET status = $3 WHERE store_id = $1 AND id = ANY($2::uuid[]) AND status <> $3`, [storeId, ownIds, status]);
    return { changed: r.rowCount ?? 0, kept: [] };
  }

  if (action.kind === 'category') {
    const c = await tx.query(`SELECT 1 FROM categories WHERE id = $1 AND store_id = $2`, [action.categoryId, storeId]);
    if (c.rows.length === 0) throw notFound('That section does not exist.', 'CATEGORY_NOT_FOUND');
    await tx.query(`DELETE FROM product_categories WHERE product_id = ANY($1::uuid[])`, [ownIds]);
    await tx.query(
      `INSERT INTO product_categories (product_id, category_id, store_id, position)
       SELECT p, $2, $3, COALESCE((SELECT max(position) FROM product_categories WHERE category_id = $2), 0) + row_number() OVER ()
         FROM unnest($1::uuid[]) AS p`,
      [ownIds, action.categoryId, storeId],
    );
    return { changed: ownIds.length, kept: [] };
  }

  const blocked = await tx.query<{ id: string }>(
    `SELECT DISTINCT v.product_id AS id
       FROM product_variants v JOIN order_items oi ON oi.variant_id = v.id
      WHERE v.product_id = ANY($1::uuid[])
     UNION
     SELECT product_id FROM reviews WHERE product_id = ANY($1::uuid[])`,
    [ownIds],
  );
  const blockedIds = new Set(blocked.rows.map((b) => b.id));
  const doomed = ownIds.filter((id) => !blockedIds.has(id));

  if (doomed.length > 0) {
    // Explicit and in this order: product_option_groups RESTRICTs on the group, so a product's private groups
    // cannot be left to cascade alongside the attachments that name them.
    // Variants FIRST: a variant's values RESTRICT on the option value, and a private group's values go with it.
    await deleteVariants(tx, `product_id = ANY($1::uuid[])`, [doomed]);
    await tx.query(`DELETE FROM product_option_groups WHERE product_id = ANY($1::uuid[])`, [doomed]);
    await tx.query(`DELETE FROM option_groups WHERE product_id = ANY($1::uuid[])`, [doomed]);
    await tx.query(`DELETE FROM products WHERE store_id = $1 AND id = ANY($2::uuid[])`, [storeId, doomed]);
  }
  return { changed: doomed.length, kept: own.filter((p) => blockedIds.has(p.id)).map(({ id, name }) => ({ id, name })) };
}
