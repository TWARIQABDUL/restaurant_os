// server/src/repositories/designs.ts — milestone 25, over V027's store_designs.
//
// Layout, homepage sections and logo, in the same two states as the theme (draft / published) and published by the same
// request. See V027 for why this is not widened onto store_themes.
//
// A STORE WITH NO DESIGN ROW HAS THE DEFAULT, not an error: the storefront shipped with a grid and every section, and a
// store that never opened Customize must look exactly as it did the day before this existed. Reads therefore fall back
// to DEFAULT_DESIGN, and a write is always an upsert.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import { DEFAULT_DESIGN } from '../core.ts';
import type { Design } from '../core.ts';

type Row = {
  status: 'draft' | 'published';
  product_layout: Design['productLayout'];
  show_promo: boolean;
  show_categories: boolean;
  show_featured: boolean;
  show_info: boolean;
  logo_url: string | null;
  updated_at: Date;
  published_at: Date | null;
};

export type StoredDesign = Design & { updatedAt: Date; publishedAt: Date | null };

const fromRow = (r: Row): StoredDesign => ({
  productLayout: r.product_layout,
  sections: { promo: r.show_promo, categories: r.show_categories, featured: r.show_featured, info: r.show_info },
  logoUrl: r.logo_url,
  updatedAt: r.updated_at,
  publishedAt: r.published_at,
});

export async function findBoth(storeId: string, on: Queryable = db): Promise<{ draft: StoredDesign | null; published: StoredDesign | null }> {
  const { rows } = await on.query<Row>(
    `SELECT status, product_layout, show_promo, show_categories, show_featured, show_info, logo_url, updated_at, published_at
       FROM store_designs WHERE store_id = $1`,
    [storeId],
  );
  return {
    draft: rows.filter((r) => r.status === 'draft').map(fromRow)[0] ?? null,
    published: rows.filter((r) => r.status === 'published').map(fromRow)[0] ?? null,
  };
}

/** What the storefront renders: the published design, or the default when there is none. */
export async function findPublishedForStore(storeId: string, on: Queryable = db): Promise<Design> {
  const { rows } = await on.query<Row>(
    `SELECT status, product_layout, show_promo, show_categories, show_featured, show_info, logo_url, updated_at, published_at
       FROM store_designs WHERE store_id = $1 AND status = 'published'`,
    [storeId],
  );
  const row = rows[0];
  if (row === undefined) return DEFAULT_DESIGN;
  const { productLayout, sections, logoUrl } = fromRow(row);
  return { productLayout, sections, logoUrl };
}

async function write(storeId: string, status: 'draft' | 'published', d: Design, tx: Queryable): Promise<void> {
  await tx.query(
    `INSERT INTO store_designs (store_id, status, product_layout, show_promo, show_categories, show_featured, show_info, logo_url, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $2 = 'published' THEN now() END)
     ON CONFLICT (store_id, status) DO UPDATE SET
         product_layout = EXCLUDED.product_layout, show_promo = EXCLUDED.show_promo, show_categories = EXCLUDED.show_categories,
         show_featured = EXCLUDED.show_featured, show_info = EXCLUDED.show_info, logo_url = EXCLUDED.logo_url,
         published_at = CASE WHEN EXCLUDED.status = 'published' THEN now() ELSE store_designs.published_at END`,
    [storeId, status, d.productLayout, d.sections.promo, d.sections.categories, d.sections.featured, d.sections.info, d.logoUrl],
  );
}

export const saveDraft = (storeId: string, d: Design, tx: Queryable): Promise<void> => write(storeId, 'draft', d, tx);
export const publish = (storeId: string, d: Design, tx: Queryable): Promise<void> => write(storeId, 'published', d, tx);

export async function revertPublished(storeId: string, tx: Queryable): Promise<void> {
  await tx.query(`DELETE FROM store_designs WHERE store_id = $1 AND status = 'published'`, [storeId]);
}
