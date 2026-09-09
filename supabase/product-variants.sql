-- ============================================
-- PER-PRODUCT VARIANTS (sizes, colours)
-- ============================================
-- `add_ons` rows are store-wide by default, so a shared "XL" option means one
-- stock number across every product that shows it. A size is really
-- per-product — a T-shirt's XL and a pair of jeans' XL are different stock.
--
-- This adds `add_ons.menu_item_id`:
--   NULL      -> shared store-wide option (gift wrap, warranty) — unchanged.
--   set       -> a variant of that one product. It carries that product's
--                stock, is always single_choice, and is managed on the
--                product form rather than the Options panel.
--
-- No new table. The order/reserve flow is untouched — a variant is still an
-- `add_ons` row with its own `stock_quantity`.
--
-- Safe to re-run.

ALTER TABLE add_ons
  ADD COLUMN IF NOT EXISTS menu_item_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'add_ons_menu_item_id_fkey' AND conrelid = 'add_ons'::regclass
  ) THEN
    ALTER TABLE add_ons
      ADD CONSTRAINT add_ons_menu_item_id_fkey
      FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_add_ons_menu_item
  ON add_ons (menu_item_id) WHERE menu_item_id IS NOT NULL;

COMMENT ON COLUMN add_ons.menu_item_id IS
  'When set, this option is a per-product variant (e.g. a size) whose stock belongs to that product. NULL = shared store-wide option.';
