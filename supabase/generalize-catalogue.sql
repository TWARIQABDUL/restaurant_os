-- ============================================
-- Generalise the catalogue for any product type
-- ============================================
-- The platform is not restaurant-specific: sellers list any kind of
-- product. `add_ons` (product options) was locked to a food-only set of
-- categories, which made option groups like "Size" or "Colour"
-- impossible. `menu_items.category` is already free text, so this brings
-- options in line with products.
--
-- Safe to re-run. No data is modified — this only drops a restriction.

ALTER TABLE add_ons
  DROP CONSTRAINT IF EXISTS add_ons_category_check;

-- Widen the column to match menu_items.category (VARCHAR(100)).
ALTER TABLE add_ons
  ALTER COLUMN category TYPE VARCHAR(100);

-- Default new option groups to a neutral bucket rather than a food one.
ALTER TABLE add_ons
  ALTER COLUMN category SET DEFAULT 'options';

COMMENT ON COLUMN add_ons.category IS
  'Free-text option group, e.g. "size", "colour", "extras", "warranty". Seller-defined.';
