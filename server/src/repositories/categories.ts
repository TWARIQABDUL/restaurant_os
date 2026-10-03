// server/src/repositories/categories.ts — milestone 22, from project/Categories.dc.html.
//
// "Menu sections" / "Collections" / "Aisles" — one table, named by the industry template (V003). What this file
// knows is only the table; the word is the config engine's.
//
// THREE RULES THE BOARD STATES AND THIS FILE KEEPS:
//   * "Order here is the order on your store." — `position` is the order, and reordering writes ALL of them.
//   * "Hidden sections and empty ones don't appear." — `isVisible` is the merchant's switch; "empty" is derived
//     (no products in it), never stored, for the reason inventory-design gives for `in_stock`: a flag that
//     restocking could silently un-hide is a flag nobody can trust.
//   * "Its 6 products stay in your catalog. They just won't be in this section." — deleting removes the links
//     (V003's cascade on product_categories) and nothing else.

import { badRequest, conflict, db, notFound } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';

export type CategoryRow = {
  id: string;
  name: string;
  isVisible: boolean;
  /** Products in it, of any status — the board's "6 products" / "No products yet". */
  productCount: number;
  /** Of those, how many are live. What decides whether the section appears on the store. */
  activeCount: number;
};

export async function list(storeId: string, on: Queryable = db): Promise<CategoryRow[]> {
  const { rows } = await on.query<{ id: string; name: string; is_visible: boolean; n: string; active: string }>(
    `SELECT c.id, c.name, c.is_visible,
            count(pc.product_id)::text AS n,
            count(pc.product_id) FILTER (WHERE p.status = 'active')::text AS active
       FROM categories c
       LEFT JOIN product_categories pc ON pc.category_id = c.id
       LEFT JOIN products p ON p.id = pc.product_id
      WHERE c.store_id = $1
      GROUP BY c.id
      ORDER BY c.position, c.id`,
    [storeId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, isVisible: r.is_visible, productCount: Number(r.n), activeCount: Number(r.active) }));
}

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name === '') throw badRequest('Give it a name.', 'NAME_REQUIRED');
  if (name.length > 60) throw badRequest('Keep the name under 60 characters.', 'TOO_LONG');
  return name;
}

const NAME_TAKEN = (name: string): Error => conflict(`You already have one called “${name}”.`, 'NAME_TAKEN');

export async function create(storeId: string, rawName: string, tx: Tx): Promise<string> {
  const name = cleanName(rawName);
  const clash = await tx.query(`SELECT 1 FROM categories WHERE store_id = $1 AND lower(btrim(name)) = lower($2)`, [storeId, name]);
  if (clash.rows.length > 0) throw NAME_TAKEN(name);

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO categories (store_id, name, position)
     VALUES ($1, $2, COALESCE((SELECT max(position) FROM categories WHERE store_id = $1), 0) + 1)
     RETURNING id`,
    [storeId, name],
  );
  return rows[0]!.id;
}

export async function update(
  storeId: string,
  id: string,
  patch: { name?: string; isVisible?: boolean },
  tx: Tx,
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [id, storeId];
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    const clash = await tx.query(`SELECT 1 FROM categories WHERE store_id = $1 AND id <> $2 AND lower(btrim(name)) = lower($3)`, [storeId, id, name]);
    if (clash.rows.length > 0) throw NAME_TAKEN(name);
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.isVisible !== undefined) {
    params.push(patch.isVisible);
    sets.push(`is_visible = $${params.length}`);
  }
  if (sets.length === 0) return (await tx.query(`SELECT 1 FROM categories WHERE id = $1 AND store_id = $2`, params.slice(0, 2))).rows.length > 0;

  const r = await tx.query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $1 AND store_id = $2`, params);
  return (r.rowCount ?? 0) > 0;
}

/**
 * The whole order, replaced. Sent as the complete list rather than "move this one up", so two merchants
 * rearranging at once end in one of the two orders instead of a hybrid, and a retried request is harmless.
 * The ids must be exactly the store's sections — a list missing one would silently park it at position zero.
 */
export async function reorder(storeId: string, ids: string[], tx: Tx): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(`SELECT id FROM categories WHERE store_id = $1 ORDER BY id FOR UPDATE`, [storeId]);
  const have = new Set(rows.map((r) => r.id));
  if (ids.length !== have.size || new Set(ids).size !== ids.length || ids.some((x) => !have.has(x))) {
    throw conflict('Your sections changed while you were sorting them. Reload and try again.', 'ORDER_STALE');
  }
  await tx.query(
    `UPDATE categories c SET position = o.n
       FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, n)
      WHERE c.id = o.id AND c.store_id = $1`,
    [storeId, ids],
  );
}

export async function remove(storeId: string, id: string, tx: Tx): Promise<{ detached: number }> {
  const c = await tx.query(`SELECT 1 FROM categories WHERE id = $1 AND store_id = $2 FOR UPDATE`, [id, storeId]);
  if (c.rows.length === 0) throw notFound('That section does not exist.', 'CATEGORY_NOT_FOUND');
  const n = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM product_categories WHERE category_id = $1`, [id]);
  await tx.query(`DELETE FROM categories WHERE id = $1 AND store_id = $2`, [id, storeId]);
  return { detached: Number(n.rows[0]!.n) };
}
