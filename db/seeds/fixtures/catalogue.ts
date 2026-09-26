// db/seeds/fixtures/catalogue.ts
//
// Menus, categories, options and variants.
//
// Nyama's prices are Shop.dc.html's and Customize.dc.html's to the franc, so a
// developer building the storefront sees the artboard's own numbers rather than
// plausible ones.
//
// The part worth reading is what counts as a variant. §5.1 calls this the riskiest
// thing in the catalogue: today a size is an add-on with its own stock, so "M has 4
// left" is expressible and "Black/M has 4 left" is not. V003's third matrix rule
// settles it — every variant must name one value from EVERY single-select group its
// product offers — which means attaching a `one` group is a promise to produce the
// whole matrix. So the linen tee is 4 sizes × 3 colours = twelve rows with twelve
// shelves, and "grilled chicken, with fries or plantain" is a variant dimension too,
// however much it reads like an add-on. The `several` group beside them is priced per
// line and is not a dimension at all; confusing the two multiplies every burger's
// matrix by its toppings and splits one shelf across a dozen rows.

import { STORE, PRODUCT, CATEGORY, GROUP, id, type Ctx } from './context.ts';

type ProductRow = {
  id: string;
  store: string;
  name: string;
  price: number;
  categories: string[];
  description?: string;
  trackStock?: boolean;
  status?: 'draft' | 'active';
  /** Stock for the single default variant. Ignored when the product has a matrix. */
  stock?: number | null;
  /**
   * V018. Struck through beside the price, and the source of Shop.dc.html's "-17%" badge: the
   * storefront derives the percentage rather than storing it, so the two can never disagree.
   */
  compareAt?: number;
  /** V018. At or below this many left, the storefront badges the product "Few left". */
  lowStockThreshold?: number;
};

const CATEGORIES = [
  { id: CATEGORY.burgers, store: STORE.nyama, name: 'Burgers', position: 1 },
  { id: CATEGORY.grills, store: STORE.nyama, name: 'Grills', position: 2 },
  { id: CATEGORY.sides, store: STORE.nyama, name: 'Sides', position: 3 },
  { id: CATEGORY.drinks, store: STORE.nyama, name: 'Drinks', position: 4 },
  { id: CATEGORY.tops, store: STORE.inzu, name: 'Tops', position: 1 },
  { id: CATEGORY.outerwear, store: STORE.inzu, name: 'Outerwear', position: 2 },
  { id: CATEGORY.bags, store: STORE.inzu, name: 'Bags', position: 3 },
  { id: CATEGORY.sneakers, store: STORE.kicks, name: 'Sneakers', position: 1 },
  { id: CATEGORY.audio, store: STORE.techhub, name: 'Audio', position: 1 },
];

const PRODUCTS: ProductRow[] = [
  // Nyama & Co. — Customize.dc.html's ITEMS list, in its order.
  { id: PRODUCT.chickenBurger, store: STORE.nyama, name: 'Chicken Burger', price: 3500, categories: [CATEGORY.burgers], description: 'Grilled chicken, slaw' },
  { id: PRODUCT.beefBurger, store: STORE.nyama, name: 'Beef Burger', price: 4000, categories: [CATEGORY.burgers], description: 'Double patty' },
  { id: PRODUCT.brochettePlate, store: STORE.nyama, name: 'Brochette Plate', price: 5000, categories: [CATEGORY.grills], description: 'Two skewers, plantain', compareAt: 6000 },
  { id: PRODUCT.grilledChicken, store: STORE.nyama, name: 'Grilled chicken', price: 8000, categories: [CATEGORY.grills], description: 'Half chicken, flame-grilled with pili-pili butter. Comes with salad and your choice of fries or plantain.' },
  { id: PRODUCT.fries, store: STORE.nyama, name: 'Fries', price: 1500, categories: [CATEGORY.sides], description: 'Salted, hot' },
  { id: PRODUCT.salad, store: STORE.nyama, name: 'Salad', price: 3000, categories: [CATEGORY.sides] },
  { id: PRODUCT.chapati, store: STORE.nyama, name: 'Chapati', price: 500, categories: [CATEGORY.sides], description: 'Warm, flaky' },
  { id: PRODUCT.passionJuice, store: STORE.nyama, name: 'Passion Juice', price: 1200, categories: [CATEGORY.drinks], description: 'Fresh, 500 ml' },
  { id: PRODUCT.mangoJuice, store: STORE.nyama, name: 'Mango Juice', price: 1200, categories: [CATEGORY.drinks], description: 'Fresh, 500 ml' },
  // A product in TWO sections — Categories.dc.html: "Products can sit in more than
  // one section", which is why product_categories is a join and not a column.
  { id: PRODUCT.veggieWrap, store: STORE.nyama, name: 'Veggie Wrap', price: 3000, categories: [CATEGORY.grills, CATEGORY.sides], description: 'Avocado, beans' },

  // Inzu Threads — stock tracked, because fashion sells out.
  { id: PRODUCT.linenTee, store: STORE.inzu, name: 'Linen tee', price: 18000, categories: [CATEGORY.tops], trackStock: true, description: 'Breathable linen, cut in Kigali.', lowStockThreshold: 3 },
  { id: PRODUCT.kitengeShirt, store: STORE.inzu, name: 'Kitenge shirt', price: 22000, categories: [CATEGORY.tops], trackStock: true, stock: 6, lowStockThreshold: 3 },
  { id: PRODUCT.denimJacket, store: STORE.inzu, name: 'Denim jacket', price: 35000, categories: [CATEGORY.outerwear], trackStock: true, stock: 3, lowStockThreshold: 3 },
  { id: PRODUCT.canvasTote, store: STORE.inzu, name: 'Canvas tote', price: 9000, categories: [CATEGORY.bags], trackStock: true, stock: 4, lowStockThreshold: 3 },

  // Kigali Kicks — one live, one still a draft, so Products has both states.
  { id: PRODUCT.roadRunner, store: STORE.kicks, name: 'Road Runner', price: 68000, categories: [CATEGORY.sneakers], trackStock: true, lowStockThreshold: 2 },
  { id: PRODUCT.courtLow, store: STORE.kicks, name: 'Court Low', price: 54000, categories: [CATEGORY.sneakers], trackStock: true, stock: 0, status: 'draft' },

  // Kigali Tech Hub — the earbuds a customer says never arrived.
  { id: PRODUCT.earbuds, store: STORE.techhub, name: 'Wireless earbuds', price: 72000, categories: [CATEGORY.audio], trackStock: true, stock: 9 },
];

const SIZES = ['S', 'M', 'L', 'XL'] as const;
const COLOURS = ['Black', 'Sand', 'Olive'] as const;

// The stock the States board draws: "Linen tee · M — 2 left" as a low-stock row, and
// XL sold out so "Out of stock" has something to render.
const TEE_STOCK: Record<string, number> = {
  'S/Black': 7, 'S/Sand': 5, 'S/Olive': 6,
  'M/Black': 4, 'M/Sand': 2, 'M/Olive': 9,
  'L/Black': 8, 'L/Sand': 6, 'L/Olive': 3,
  'XL/Black': 0, 'XL/Sand': 0, 'XL/Olive': 1,
};

/** Products whose variants are the combinations of their single-select groups. */
const MATRIX: {
  product: string;
  store: string;
  skuPrefix: string;
  groups: { group: string; labels: readonly string[] }[];
  /** Keyed by the combination joined with '/'. null when the product is untracked. */
  stock: Record<string, number> | null;
}[] = [
  {
    product: PRODUCT.linenTee, store: STORE.inzu, skuPrefix: 'TEE',
    groups: [
      { group: GROUP.size, labels: SIZES },
      { group: GROUP.colour, labels: COLOURS },
    ],
    stock: TEE_STOCK,
  },
  {
    product: PRODUCT.roadRunner, store: STORE.kicks, skuPrefix: 'RR',
    groups: [{ group: GROUP.shoeSize, labels: ['40', '41', '42', '43', '44'] }],
    stock: { '40': 2, '41': 4, '42': 6, '43': 3, '44': 1 },
  },
  {
    product: PRODUCT.grilledChicken, store: STORE.nyama, skuPrefix: 'CHK',
    groups: [{ group: GROUP.sideChoice, labels: ['Fries', 'Plantain'] }],
    stock: null,
  },
];

/** The `several` groups: priced per line, and not variant dimensions. */
const ADD_ONS: { product: string; store: string; group: string }[] = [
  // One group, two products — the shared-option case milestone 7's done-when asks
  // for. Editing "Extra cheese" reaches both burgers because there is no copy.
  { product: PRODUCT.chickenBurger, store: STORE.nyama, group: GROUP.extras },
  { product: PRODUCT.beefBurger, store: STORE.nyama, group: GROUP.extras },
  { product: PRODUCT.veggieWrap, store: STORE.nyama, group: GROUP.extras },
];

/** Every combination of the given dimensions, in a fixed order. */
function combinations(groups: { group: string; labels: readonly string[] }[]): string[][] {
  return groups.reduce<string[][]>(
    (acc, g) => acc.flatMap((prefix) => g.labels.map((label) => [...prefix, label])),
    [[]],
  );
}

export async function seedCatalogue(ctx: Ctx): Promise<void> {
  ctx.step('Catalogue');

  for (const c of CATEGORIES) {
    await ctx.sql(
      `INSERT INTO categories (id, store_id, name, position) VALUES ($1, $2, $3, $4)`,
      [c.id, c.store, c.name, c.position],
    );
  }
  ctx.ok(`${CATEGORIES.length} categories across 4 stores`);

  // product_categories.position is the order WITHIN A SECTION — V003: "Where this product sits within
  // this section, which differs per section." So it counts per category, not per product: numbering it
  // by the product's own index among its categories (which it did at first) makes every product position
  // 1 in its first section, and the storefront's section order then falls back to the id tie-break.
  const withinSection = new Map<string, number>();

  for (const [i, p] of PRODUCTS.entries()) {
    await ctx.sql(
      `INSERT INTO products (id, store_id, name, description, base_price, compare_at_price,
                             low_stock_threshold, track_stock, status, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [p.id, p.store, p.name, p.description ?? '', p.price, p.compareAt ?? null,
       p.lowStockThreshold ?? 0, p.trackStock ?? false, p.status ?? 'active', i + 1],
    );
    for (const cat of p.categories) {
      const next = (withinSection.get(cat) ?? 0) + 1;
      withinSection.set(cat, next);
      await ctx.sql(
        `INSERT INTO product_categories (product_id, category_id, store_id, position) VALUES ($1, $2, $3, $4)`,
        [p.id, cat, p.store, next],
      );
    }
  }

  // ------------------------------------------------------------------
  // Option groups and their values.
  // ------------------------------------------------------------------
  await ctx.sql(
    `INSERT INTO option_groups (id, store_id, name, select_mode, is_required, position) VALUES
       ($1, $6, 'Size',        'one',     true,  1),
       ($2, $6, 'Colour',      'one',     true,  2),
       ($3, $7, 'Extras',      'several', false, 1),
       ($4, $7, 'Side choice', 'one',     true,  2),
       ($5, $8, 'Shoe size',   'one',     true,  1)`,
    [GROUP.size, GROUP.colour, GROUP.extras, GROUP.sideChoice, GROUP.shoeSize,
     STORE.inzu, STORE.nyama, STORE.kicks],
  );

  const storeOf: Record<string, string> = {
    [GROUP.size]: STORE.inzu, [GROUP.colour]: STORE.inzu,
    [GROUP.extras]: STORE.nyama, [GROUP.sideChoice]: STORE.nyama,
    [GROUP.shoeSize]: STORE.kicks,
  };

  const values: [string, string, string, number, number][] = [];
  SIZES.forEach((v, i) => values.push([id('3333aaaa', 1 + i), GROUP.size, v, 0, i + 1]));
  COLOURS.forEach((v, i) => values.push([id('3333aaaa', 11 + i), GROUP.colour, v, 0, i + 1]));
  // Priced extras — the per-line deltas V004 captures on order_item_option_values.
  ([['Extra cheese', 500], ['Extra chilli', 300], ['Avocado', 700]] as [string, number][])
    .forEach(([label, delta], i) => values.push([id('3333aaaa', 21 + i), GROUP.extras, label, delta, i + 1]));
  // A `one` group with no prices at all: choosing is not always paying.
  (['Fries', 'Plantain'] as const)
    .forEach((label, i) => values.push([id('3333aaaa', 31 + i), GROUP.sideChoice, label, 0, i + 1]));
  (['40', '41', '42', '43', '44'] as const)
    .forEach((label, i) => values.push([id('3333aaaa', 41 + i), GROUP.shoeSize, label, 0, i + 1]));

  for (const [vid, group, label, delta, position] of values) {
    await ctx.sql(
      `INSERT INTO option_values (id, option_group_id, store_id, label, price_delta, position)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [vid, group, storeOf[group], label, delta, position],
    );
  }
  ctx.ok(`5 option groups, ${values.length} values (Extras is ‘several’ and is priced per line)`);

  // ------------------------------------------------------------------
  // Attach them: add-ons, then every variant dimension.
  // ------------------------------------------------------------------
  for (const a of ADD_ONS) {
    await ctx.sql(
      `INSERT INTO product_option_groups (product_id, option_group_id, store_id, position) VALUES ($1, $2, $3, 1)`,
      [a.product, a.group, a.store],
    );
  }
  for (const m of MATRIX) {
    for (const [i, g] of m.groups.entries()) {
      await ctx.sql(
        `INSERT INTO product_option_groups (product_id, option_group_id, store_id, position) VALUES ($1, $2, $3, $4)`,
        [m.product, g.group, m.store, i + 1],
      );
    }
  }
  ctx.ok(`${ADD_ONS.length} add-on attachments (Extras is shared by two burgers and the wrap)`);

  // ------------------------------------------------------------------
  // Variants. Every product has at least one — the rule that gives reserve_stock()
  // a single code path — and the linen tee has twelve.
  // ------------------------------------------------------------------
  const withMatrix = new Set(MATRIX.map((m) => m.product));
  let seq = 1;

  for (const p of PRODUCTS) {
    if (withMatrix.has(p.id)) continue;
    await ctx.sql(
      `INSERT INTO product_variants (id, product_id, store_id, sku, stock_quantity, is_default, position)
       VALUES ($1, $2, $3, NULL, $4, true, 1)`,
      [id('44444444', seq++), p.id, p.store, p.trackStock ? (p.stock ?? 5) : null],
    );
  }

  for (const m of MATRIX) {
    for (const [i, combo] of combinations(m.groups).entries()) {
      const variantId = id('44444444', 1_000 + seq++);
      await ctx.sql(
        `INSERT INTO product_variants (id, product_id, store_id, sku, stock_quantity, is_default, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          variantId, m.product, m.store,
          `${m.skuPrefix}-${combo.map((c) => c.slice(0, 3).toUpperCase()).join('-')}`,
          m.stock ? (m.stock[combo.join('/')] ?? 0) : null,
          i === 0,
          i + 1,
        ],
      );
      for (const [j, g] of m.groups.entries()) {
        await ctx.sql(
          `INSERT INTO product_variant_values (variant_id, option_group_id, option_value_id, product_id)
           SELECT $1, ov.option_group_id, ov.id, $2
             FROM option_values ov
            WHERE ov.option_group_id = $3 AND ov.label = $4`,
          [variantId, m.product, g.group, combo[j]!],
        );
      }
    }
  }

  const counts = await ctx.sql<{ products: string; variants: string; matrix: string }>(
    `SELECT (SELECT count(*)::text FROM products) AS products,
            (SELECT count(*)::text FROM product_variants) AS variants,
            (SELECT count(*)::text FROM product_variants WHERE product_id = $1) AS matrix`,
    [PRODUCT.linenTee],
  );
  if (Number(counts.rows[0]!.matrix) !== SIZES.length * COLOURS.length) {
    throw new Error(`the linen tee has ${counts.rows[0]!.matrix} variants, not ${SIZES.length * COLOURS.length}`);
  }
  ctx.ok(
    `${counts.rows[0]!.products} products, ${counts.rows[0]!.variants} variants ` +
      `— ${counts.rows[0]!.matrix} of them the linen tee, one shelf each`,
  );
}
