-- ============================================
-- PRODUCT CATEGORIES
-- ============================================
-- Turns product categories into a managed list per store, and lets each
-- product option (add_on) be scoped to one category so a drink option
-- never shows up on a T-shirt.
--
--  * `categories` is the canonical list. `menu_items.category` stays a text
--    column (no destructive migration) but should now hold a name from this
--    list — the UI enforces that with a dropdown.
--  * `add_ons.product_category` NULL  = the option applies to every product
--    (the pre-existing behaviour, so nothing disappears on upgrade).
--    `add_ons.product_category` = 'X' = the option only shows on products
--    whose category is 'X'.
--
-- NOTE: an earlier iteration of this project left an (empty, unused)
-- `categories` table behind with columns id / tenant_id / name / description
-- / image_url / sort_order / is_active. This migration adopts that shape
-- rather than fighting it, so it is written as ADD COLUMN IF NOT EXISTS
-- against whatever is there.
--
-- Safe to re-run.

-- ── categories table (matches the pre-existing shape) ──────────────────
CREATE TABLE IF NOT EXISTS categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  image_url   VARCHAR(500),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE categories ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url   VARCHAR(500);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_active   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ DEFAULT NOW();

-- Tenant scoping: cascade delete with the store (adds the FK only if missing).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'categories_tenant_id_fkey' AND conrelid = 'categories'::regclass
  ) THEN
    ALTER TABLE categories
      ADD CONSTRAINT categories_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

-- One category name per store, case-insensitively ("Drinks" == "drinks").
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_tenant_name
  ON categories (tenant_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_categories_tenant_sort
  ON categories (tenant_id, sort_order);

-- ── option scoping ─────────────────────────────────────────────────────
ALTER TABLE add_ons
  ADD COLUMN IF NOT EXISTS product_category VARCHAR(100);

COMMENT ON COLUMN add_ons.product_category IS
  'Product category this option applies to. NULL = every product.';

-- ── backfill categories from whatever products already exist ────────────
INSERT INTO categories (tenant_id, name, sort_order)
SELECT tenant_id, category,
       ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY category) - 1
FROM (
  SELECT DISTINCT tenant_id, category
  FROM menu_items
  WHERE category IS NOT NULL AND category <> ''
) AS existing
ON CONFLICT (tenant_id, lower(name)) DO NOTHING;
