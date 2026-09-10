-- ============================================
-- SINGLE-CHOICE OPTIONS + PER-OPTION STOCK
-- ============================================
-- Lets an option group behave as "pick one" (Size: S / M / L) instead of
-- "add extras", and gives each option its own stock count so a single size
-- can sell out without touching the others.
--
--  * add_ons.single_choice  — TRUE  => the shopper picks exactly one option
--                             from this group (rendered as pills, required).
--                             FALSE => the existing checkbox + quantity add-on.
--  * add_ons.track_inventory / stock_quantity / low_stock_threshold —
--    same three columns and semantics as menu_items. Opt-in, default off.
--
-- The reserve/release stock functions are generalised to take a table name
-- ('menu_items' or 'add_ons') so both product-level and size-level stock use
-- the same atomic path. This REPLACES the two-arg versions from inventory.sql.
--
-- Safe to re-run.

ALTER TABLE add_ons
  ADD COLUMN IF NOT EXISTS single_choice        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS track_inventory      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stock_quantity       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS low_stock_threshold  INTEGER NOT NULL DEFAULT 5;

ALTER TABLE add_ons DROP CONSTRAINT IF EXISTS add_ons_stock_quantity_check;
ALTER TABLE add_ons ADD CONSTRAINT add_ons_stock_quantity_check CHECK (stock_quantity >= 0);

-- ── generalised reserve / release ──────────────────────────────────────
DROP FUNCTION IF EXISTS reserve_stock(UUID, JSONB);
DROP FUNCTION IF EXISTS release_stock(UUID, JSONB);

-- p_lines: [{"id": "<uuid>", "quantity": 2}, ...]
CREATE OR REPLACE FUNCTION reserve_stock(p_tenant_id UUID, p_table TEXT, p_lines JSONB)
RETURNS VOID AS $$
DECLARE
  v_line JSONB; v_id UUID; v_qty INTEGER; v_name TEXT; v_updated INTEGER;
BEGIN
  IF p_table NOT IN ('menu_items', 'add_ons') THEN
    RAISE EXCEPTION 'INVALID_TABLE:%', p_table;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_id  := (v_line->>'id')::UUID;
    v_qty := (v_line->>'quantity')::INTEGER;

    IF v_qty IS NULL OR v_qty < 1 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = 'check_violation';
    END IF;

    EXECUTE format(
      'UPDATE %I SET stock_quantity = stock_quantity - $1
         WHERE id = $2 AND tenant_id = $3 AND track_inventory AND stock_quantity >= $1',
      p_table
    ) USING v_qty, v_id, p_tenant_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
      EXECUTE format(
        'SELECT name FROM %I WHERE id = $1 AND tenant_id = $2 AND track_inventory',
        p_table
      ) INTO v_name USING v_id, p_tenant_id;

      IF v_name IS NOT NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_STOCK:%', v_name USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_stock(p_tenant_id UUID, p_table TEXT, p_lines JSONB)
RETURNS VOID AS $$
DECLARE
  v_line JSONB;
BEGIN
  IF p_table NOT IN ('menu_items', 'add_ons') THEN
    RAISE EXCEPTION 'INVALID_TABLE:%', p_table;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    EXECUTE format(
      'UPDATE %I SET stock_quantity = stock_quantity + $1
         WHERE id = $2 AND tenant_id = $3 AND track_inventory',
      p_table
    ) USING (v_line->>'quantity')::INTEGER, (v_line->>'id')::UUID, p_tenant_id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- service_role only — see the note in inventory.sql.
GRANT EXECUTE ON FUNCTION reserve_stock(UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION release_stock(UUID, TEXT, JSONB) TO service_role;
REVOKE ALL ON FUNCTION reserve_stock(UUID, TEXT, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION release_stock(UUID, TEXT, JSONB) FROM anon, authenticated;
