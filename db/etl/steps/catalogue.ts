// db/etl/steps/catalogue.ts — categories, products, options and variants (plan §5.5).
//
// "The hardest mapping" in the plan, and this is why. The old model has ONE concept, the add-on, doing three
// jobs: a store-wide extra (Cheese +500), a "pick one" size, and a per-product size with its own stock. The new
// model separates them into option groups (shared or private to a product), values, and a variant matrix that
// carries stock. The rules, each written down because each is a judgement:
//
//   * A store-wide "pick several" add-on becomes a value in a SHARED option group named for its category, and
//     the group is attached to the products that were linked to it — but only when a product was linked to the
//     WHOLE group. A product linked to some of a group's add-ons gets a PRIVATE copy with just those, because
//     attaching the shared group would offer extras the merchant never linked.
//   * A "pick one" add-on (single_choice: a size) becomes a PRIVATE "pick one" group on each product it was
//     linked to, and the product gets one variant per value. Stock moves with it. A shared size's stock was
//     ONE number shared by every product; it is copied into each, which is recorded as a decision because it
//     means those products can now sell the same units twice.
//   * Product-level stock and size-level stock cannot both be right. Size-level wins where it is tracked.

import { Ctx, Unmapped, read } from '../lib.ts';

type Category = { id: string; tenant_id: string; name: string; description: string | null; image_url: string | null; sort_order: number; is_active: boolean; created_at: Date };
type Item = {
  id: string; tenant_id: string; name: string; description: string | null; price: string; category: string; image_url: string | null;
  available: boolean | null; created_at: Date; track_inventory: boolean; stock_quantity: number; low_stock_threshold: number; sku: string | null;
};
type AddOn = {
  id: string; tenant_id: string; name: string; price: string; category: string; image_url: string | null; available: boolean | null; created_at: Date;
  single_choice: boolean; track_inventory: boolean; stock_quantity: number; low_stock_threshold: number; menu_item_id: string | null;
};
type Link = { menu_item_id: string; add_on_id: string };

export type ValueRef = { valueId: string; groupId: string; groupName: string; label: string; priceDelta: string; mode: 'one' | 'several' };

export type Catalogue = {
  /** `${productId}:${oldAddOnId}` -> the value an order line's add-on now points at. */
  addOnValue: Map<string, ValueRef>;
  products: Map<string, ProductInfo>;
};

export type ProductInfo = {
  storeId: string;
  name: string;
  /** the groups whose values define the variant matrix, in order */
  oneGroups: string[];
  /** variant id keyed by its sorted value ids joined with "+" ; the default variant uses the key "" */
  variants: Map<string, { id: string; label: string; sku: string | null }>;
};

const title = (s: string): string => (s.length === 0 ? 'Options' : s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' '));
const norm = (s: string): string => s.trim().toLowerCase();

export async function catalogue(ctx: Ctx): Promise<Catalogue> {
  const out: Catalogue = { addOnValue: new Map(), products: new Map() };

  const categories = await read<Category>(ctx, 'categories', ['id', 'tenant_id', 'name', 'description', 'image_url', 'sort_order', 'is_active', 'created_at'], 'tenant_id, sort_order, created_at, id');
  const items = await read<Item>(ctx, 'menu_items', ['id', 'tenant_id', 'name', 'description', 'price', 'category', 'image_url', 'available', 'created_at', 'track_inventory', 'stock_quantity', 'low_stock_threshold', 'sku'], 'tenant_id, created_at, id');
  const addOns = await read<AddOn>(ctx, 'add_ons', ['id', 'tenant_id', 'name', 'price', 'category', 'image_url', 'available', 'created_at', 'single_choice', 'track_inventory', 'stock_quantity', 'low_stock_threshold', 'menu_item_id'], 'tenant_id, created_at, id');
  const links = await read<Link>(ctx, 'menu_item_addons', ['menu_item_id', 'add_on_id'], 'menu_item_id, add_on_id');

  // ---- categories ----------------------------------------------------------------------------------------------
  const categoryId = new Map<string, string>(); // `${tenant}:${normalised name}` -> id
  for (const c of categories) {
    const key = `${c.tenant_id}:${norm(c.name)}`;
    if (categoryId.has(key)) {
      ctx.decide('catalogue', 'category-merged', c.id, `"${c.name}" duplicates another category at the store once case and spaces are ignored; its products move to the first.`);
      continue;
    }
    await ctx.tgt.query(
      `INSERT INTO categories (id, store_id, name, description, image_url, is_visible, position, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [c.id, c.tenant_id, c.name.trim(), c.description ?? '', c.image_url, c.is_active, c.sort_order, c.created_at],
    );
    categoryId.set(key, c.id);
    ctx.counter('categories').written += 1;
  }
  // Free-text categories on products with no row of their own get one, named by the commonest spelling.
  const spellings = new Map<string, Map<string, number>>();
  for (const it of items) {
    const key = `${it.tenant_id}:${norm(it.category)}`;
    if (categoryId.has(key)) continue;
    const m = spellings.get(key) ?? new Map<string, number>();
    m.set(it.category.trim(), (m.get(it.category.trim()) ?? 0) + 1);
    spellings.set(key, m);
  }
  for (const [key, m] of spellings) {
    const name = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    const tenant = key.slice(0, key.indexOf(':'));
    const made = await ctx.tgt.query<{ id: string }>(
      `INSERT INTO categories (store_id, name, position) VALUES ($1, $2, (SELECT COALESCE(max(position), 0) + 1 FROM categories WHERE store_id = $1)) RETURNING id`,
      [tenant, name],
    );
    categoryId.set(key, made.rows[0]!.id);
    ctx.counter('categories').written += 1;
    ctx.decide('catalogue', 'category-created', tenant, `Products carried the free-text category "${name}"${m.size > 1 ? ` (spellings: ${[...m.keys()].join(', ')})` : ''} with no category row, so one was created.`);
  }

  // ---- products ------------------------------------------------------------------------------------------------
  const itemById = new Map(items.map((i) => [i.id, i]));
  const addOnById = new Map(addOns.map((a) => [a.id, a]));
  const linksByItem = new Map<string, string[]>();
  for (const l of links) {
    if (!itemById.has(l.menu_item_id) || !addOnById.has(l.add_on_id)) throw new Unmapped(`menu_item_addons points at a missing row (${l.menu_item_id} / ${l.add_on_id})`, 'The foreign keys should prevent this.');
    const list = linksByItem.get(l.menu_item_id) ?? [];
    list.push(l.add_on_id);
    linksByItem.set(l.menu_item_id, list);
  }

  let position = 0;
  let lastTenant = '';
  const skuSeen = new Set<string>();
  for (const it of items) {
    if (it.tenant_id !== lastTenant) { position = 0; lastTenant = it.tenant_id; }
    position += 1;
    await ctx.tgt.query(
      `INSERT INTO products (id, store_id, name, description, base_price, cover_image_url, track_stock, status, position, created_at, low_stock_threshold)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10)`,
      [it.id, it.tenant_id, it.name.trim(), it.description ?? '', it.price, it.image_url, false, position, it.created_at, it.low_stock_threshold],
    );
    ctx.counter('menu_items').written += 1;
    await ctx.tgt.query(
      `INSERT INTO product_categories (product_id, category_id, store_id) VALUES ($1,$2,$3)`,
      [it.id, categoryId.get(`${it.tenant_id}:${norm(it.category)}`)!, it.tenant_id],
    );
  }

  // ---- option groups -------------------------------------------------------------------------------------------
  // Shared "pick several" groups, one per (store, category), made lazily so a category with no such add-on makes none.
  const sharedGroupOf = new Map<string, { id: string; name: string; valueIds: Map<string, string> }>(); // `${tenant}:${category}`
  const sharedMembers = new Map<string, string[]>(); // group key -> old add-on ids
  for (const a of addOns) {
    if (a.menu_item_id !== null || a.single_choice) continue;
    const key = `${a.tenant_id}:${norm(a.category)}`;
    const list = sharedMembers.get(key) ?? [];
    list.push(a.id);
    sharedMembers.set(key, list);
  }
  let groupPos = 0;
  for (const [key, members] of sharedMembers) {
    const first = addOnById.get(members[0]!)!;
    const group = await ctx.tgt.query<{ id: string }>(
      `INSERT INTO option_groups (store_id, name, select_mode, is_required, position) VALUES ($1,$2,'several',false,$3) RETURNING id`,
      [first.tenant_id, title(first.category), (groupPos += 1)],
    );
    const entry = { id: group.rows[0]!.id, name: title(first.category), valueIds: new Map<string, string>() };
    sharedGroupOf.set(key, entry);
    let vp = 0;
    for (const m of members) {
      const a = addOnById.get(m)!;
      const v = await ctx.tgt.query<{ id: string }>(
        `INSERT INTO option_values (option_group_id, store_id, label, price_delta, is_available, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [entry.id, a.tenant_id, a.name.trim(), a.price, a.available !== false, (vp += 1)],
      );
      entry.valueIds.set(m, v.rows[0]!.id);
      ctx.counter('add_ons').written += 1;
    }
  }

  // Per product: attach shared groups, build private groups, then the variants.
  for (const it of items) {
    const linked = (linksByItem.get(it.id) ?? []).map((id) => addOnById.get(id)!);
    const own = addOns.filter((a) => a.menu_item_id === it.id);
    const wanted = [...linked.filter((a) => a.menu_item_id === null || a.menu_item_id === it.id), ...own.filter((a) => !linked.includes(a))];

    // group the wanted add-ons by (category, mode)
    const buckets = new Map<string, AddOn[]>();
    for (const a of wanted) {
      const k = `${norm(a.category)}|${a.single_choice ? 'one' : 'several'}`;
      const list = buckets.get(k) ?? [];
      list.push(a);
      buckets.set(k, list);
    }

    const oneGroups: { groupId: string; values: { addOn: AddOn; valueId: string }[] }[] = [];
    let attachPos = 0;
    for (const [bucket, members] of buckets) {
      const mode = bucket.endsWith('|one') ? 'one' : 'several';
      const first = members[0]!;
      const name = title(first.category);
      const sharedKey = `${it.tenant_id}:${norm(first.category)}`;
      const shared = mode === 'several' ? sharedGroupOf.get(sharedKey) : undefined;
      const allShared = shared !== undefined && members.every((m) => m.menu_item_id === null) && shared.valueIds.size === members.length;

      if (allShared) {
        await ctx.tgt.query(`INSERT INTO product_option_groups (product_id, option_group_id, store_id, position) VALUES ($1,$2,$3,$4)`, [it.id, shared.id, it.tenant_id, (attachPos += 1)]);
        for (const m of members) {
          out.addOnValue.set(`${it.id}:${m.id}`, { valueId: shared.valueIds.get(m.id)!, groupId: shared.id, groupName: shared.name, label: m.name.trim(), priceDelta: m.price, mode: 'several' });
        }
        continue;
      }

      // private group on this product
      if (shared !== undefined && members.some((m) => m.menu_item_id === null)) {
        ctx.decide('catalogue', 'partial-group-link', it.id, `"${it.name}" was linked to ${members.length} of the ${shared.valueIds.size} "${name}" add-ons, so it gets its own "${name}" group with just those rather than the shared one.`);
      }
      const g = await ctx.tgt.query<{ id: string }>(
        `INSERT INTO option_groups (store_id, name, select_mode, is_required, position, product_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [it.tenant_id, name, mode, mode === 'one', (attachPos += 1), it.id],
      );
      const groupId = g.rows[0]!.id;
      // A product offers its private groups the same way it offers shared ones; the variant matrix is checked against this list.
      await ctx.tgt.query(`INSERT INTO product_option_groups (product_id, option_group_id, store_id, position) VALUES ($1,$2,$3,$4)`, [it.id, groupId, it.tenant_id, attachPos]);
      const values: { addOn: AddOn; valueId: string }[] = [];
      let vp = 0;
      for (const m of members) {
        const v = await ctx.tgt.query<{ id: string }>(
          `INSERT INTO option_values (option_group_id, store_id, label, price_delta, is_available, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [groupId, it.tenant_id, m.name.trim(), m.price, m.available !== false, (vp += 1)],
        );
        values.push({ addOn: m, valueId: v.rows[0]!.id });
        out.addOnValue.set(`${it.id}:${m.id}`, { valueId: v.rows[0]!.id, groupId, groupName: name, label: m.name.trim(), priceDelta: m.price, mode });
      }
      if (mode === 'one') oneGroups.push({ groupId, values });
      if (mode === 'one' && members.some((m) => m.menu_item_id === null && m.track_inventory)) {
        ctx.decide('catalogue', 'shared-stock-copied', it.id, `A store-wide size on "${it.name}" carried ONE stock count shared by every product. It is now copied into each product's variants, so products that shared units can now sell the same units twice. Review sizes' stock before cutover.`);
      }
    }

    // ---- variants ----
    const matrix: { valueIds: string[]; addOns: AddOn[]; label: string }[] = [{ valueIds: [], addOns: [], label: '' }];
    let combos = matrix;
    for (const grp of oneGroups) {
      const next: typeof combos = [];
      for (const c of combos) {
        for (const v of grp.values) next.push({ valueIds: [...c.valueIds, v.valueId], addOns: [...c.addOns, v.addOn], label: c.label === '' ? v.addOn.name.trim() : `${c.label} · ${v.addOn.name.trim()}` });
      }
      combos = next;
    }

    const trackedByAddOn = combos.some((c) => c.addOns.some((a) => a.track_inventory));
    const trackStock = it.track_inventory || trackedByAddOn;
    if (it.track_inventory && trackedByAddOn) {
      ctx.decide('catalogue', 'stock-level', it.id, `"${it.name}" tracked stock on the product (${it.stock_quantity}) AND on its sizes. Size-level counts win; the product-level count is dropped.`);
    }
    if (trackStock !== false) await ctx.tgt.query(`UPDATE products SET track_stock = true WHERE id = $1`, [it.id]);

    const info: ProductInfo = { storeId: it.tenant_id, name: it.name.trim(), oneGroups: oneGroups.map((g) => g.groupId), variants: new Map() };
    let vpos = 0;
    for (const c of combos) {
      let stock: number | null = null;
      if (trackStock) {
        const counts = c.addOns.filter((a) => a.track_inventory).map((a) => a.stock_quantity);
        stock = counts.length > 0 ? Math.min(...counts) : it.track_inventory ? it.stock_quantity : 0;
      }
      const isDefault = c.valueIds.length === 0;
      let sku = isDefault ? (it.sku?.trim() ?? null) : null;
      if (sku === '') sku = null;
      if (sku !== null) {
        const key = `${it.tenant_id}:${sku.toLowerCase()}`;
        if (skuSeen.has(key)) {
          ctx.decide('catalogue', 'sku-duplicate', it.id, `SKU "${sku}" is already used by another product at the store; it is dropped from "${it.name}".`);
          sku = null;
        } else skuSeen.add(key);
      }
      const available = it.available !== false && c.addOns.every((a) => a.available !== false);
      const variant = await ctx.tgt.query<{ id: string }>(
        `INSERT INTO product_variants (product_id, store_id, sku, stock_quantity, is_available, is_default, position) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [it.id, it.tenant_id, sku, stock, available, isDefault, (vpos += 1)],
      );
      const variantId = variant.rows[0]!.id;
      for (let i = 0; i < c.valueIds.length; i++) {
        await ctx.tgt.query(
          `INSERT INTO product_variant_values (variant_id, option_group_id, option_value_id, product_id) VALUES ($1,$2,$3,$4)`,
          [variantId, oneGroups[i]!.groupId, c.valueIds[i], it.id],
        );
      }
      info.variants.set([...c.valueIds].sort().join('+'), { id: variantId, label: c.label, sku });
    }
    out.products.set(it.id, info);
  }

  // Every add-on is accounted for: shared ones that no product links still exist as shared values (multi) — single-choice
  // shared sizes that no product links have nowhere to live, and are archived rather than dropped.
  for (const a of addOns) {
    if (a.menu_item_id !== null || !a.single_choice) continue;
    const linkedAnywhere = links.some((l) => l.add_on_id === a.id);
    if (!linkedAnywhere) {
      await ctx.archive('add_ons', a.id, a.tenant_id, 'a store-wide "pick one" option no product was linked to: sizes live on products in the new model, so there is nothing to attach it to', a);
    }
  }
  return out;
}
