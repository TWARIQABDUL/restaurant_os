-- ============================================
-- INVENTORY
-- ============================================
-- Adds real stock tracking to products (`menu_items`).
--
-- Design notes:
--  * `track_inventory` is opt-in per product and defaults to FALSE, so
--    nothing changes for sellers who don't want stock counts (services,
--    made-to-order goods). Existing rows keep behaving exactly as before.
--  * `available` stays the seller's manual on/off switch. Whether a product
--    can actually be bought is derived: available AND (NOT track_inventory
--    OR stock_quantity > 0). We never mutate `available` from stock levels,
--    so restocking doesn't silently un-hide something the seller hid.
--  * Reserving stock happens inside a single plpgsql function so the
--    check-and-decrement is atomic. Two shoppers racing for the last unit
--    cannot both win.
--
-- Safe to re-run.

-- ── Columns ────────────────────────────────────────────────────────────
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS track_inventory     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stock_quantity      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS sku                 VARCHAR(64);

ALTER TABLE menu_items
  DROP CONSTRAINT IF EXISTS menu_items_stock_quantity_check;
ALTER TABLE menu_items
  ADD CONSTRAINT menu_items_stock_quantity_check CHECK (stock_quantity >= 0);

ALTER TABLE menu_items
  DROP CONSTRAINT IF EXISTS menu_items_low_stock_threshold_check;
ALTER TABLE menu_items
  ADD CONSTRAINT menu_items_low_stock_threshold_check CHECK (low_stock_threshold >= 0);

-- SKUs are optional, but unique within a store when present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_tenant_sku
  ON menu_items (tenant_id, sku) WHERE sku IS NOT NULL;

-- Supports the "what's running low?" query.
CREATE INDEX IF NOT EXISTS idx_menu_items_low_stock
  ON menu_items (tenant_id) WHERE track_inventory;

COMMENT ON COLUMN menu_items.track_inventory IS
  'Opt in to stock counts for this product. FALSE = always purchasable while available.';
COMMENT ON COLUMN menu_items.stock_quantity IS
  'Units on hand. Only meaningful when track_inventory is TRUE.';
COMMENT ON COLUMN menu_items.low_stock_threshold IS
  'Flag the product as low stock at or below this count.';

-- ── Atomic reserve ─────────────────────────────────────────────────────
-- p_lines: [{"menu_item_id": "<uuid>", "quantity": 2}, ...]
-- Raises INSUFFICIENT_STOCK:<product name> if any tracked line is short.
-- Untracked products are skipped. Runs as one statement from the caller's
-- perspective, so the whole reservation succeeds or none of it does.
CREATE OR REPLACE FUNCTION reserve_stock(p_tenant_id UUID, p_lines JSONB)
RETURNS VOID AS $$
DECLARE
  v_line    JSONB;
  v_id      UUID;
  v_qty     INTEGER;
  v_name    TEXT;
  v_updated INTEGER;
BEGIN
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_id  := (v_line->>'menu_item_id')::UUID;
    v_qty := (v_line->>'quantity')::INTEGER;

    IF v_qty IS NULL OR v_qty < 1 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = 'check_violation';
    END IF;

    UPDATE menu_items
       SET stock_quantity = stock_quantity - v_qty
     WHERE id = v_id
       AND tenant_id = p_tenant_id
       AND track_inventory
       AND stock_quantity >= v_qty;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
      -- Nothing was decremented. That's fine when the product doesn't track
      -- inventory; it's a genuine shortage when it does.
      SELECT name INTO v_name
        FROM menu_items
       WHERE id = v_id AND tenant_id = p_tenant_id AND track_inventory;

      IF FOUND THEN
        RAISE EXCEPTION 'INSUFFICIENT_STOCK:%', v_name
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ── Release (put stock back) ───────────────────────────────────────────
-- Used when an order fails to persist, or is rejected/cancelled after the
-- fact. Untracked products are skipped.
CREATE OR REPLACE FUNCTION release_stock(p_tenant_id UUID, p_lines JSONB)
RETURNS VOID AS $$
DECLARE
  v_line JSONB;
BEGIN
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    UPDATE menu_items
       SET stock_quantity = stock_quantity + (v_line->>'quantity')::INTEGER
     WHERE id = (v_line->>'menu_item_id')::UUID
       AND tenant_id = p_tenant_id
       AND track_inventory;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- service_role only. These were granted to anon/authenticated too, which
-- fights lockdown-anon.sql: whichever ran last won, and release_stock in
-- anon's hands lets anyone inflate any store's inventory. Only the backend
-- calls these, and the backend is service_role.
GRANT EXECUTE ON FUNCTION reserve_stock(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION release_stock(UUID, JSONB) TO service_role;
REVOKE ALL ON FUNCTION reserve_stock(UUID, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION release_stock(UUID, JSONB) FROM anon, authenticated;
