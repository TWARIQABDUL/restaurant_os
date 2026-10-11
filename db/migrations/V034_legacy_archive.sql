-- V034 — where the old system's leftovers live (milestone 29).
--
-- The one-off migration (db/etl) maps what has a home in the new schema and puts
-- EVERYTHING ELSE here, with the reason, rather than dropping it. Three kinds of row:
--
--   * history the new model deliberately does not replay — the old wallet ledger, which is
--     single-entry and misstates two movements (plan §5.1), so the new ledger opens with a
--     balance and the old rows are kept as a record, not as something to sum;
--   * columns with no target — an order's external rider details and delivery notes;
--   * whole tables with no target — the orphaned TypeORM-era `posts`, old notifications,
--     reviews that cannot be tied to a purchased item.
--
-- It is read by people (support, finance) answering "what did the old system say", so it is
-- written once by the migration and never updated: append-only, like the audit log.

CREATE TABLE legacy_rows (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_table text        NOT NULL,
    source_id    text,
    store_id     uuid        REFERENCES stores (id) ON DELETE RESTRICT,
    reason       text        NOT NULL,
    row          jsonb       NOT NULL,
    imported_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT legacy_rows_source_present CHECK (btrim(source_table) <> ''),
    CONSTRAINT legacy_rows_reason_present CHECK (btrim(reason) <> '')
);

COMMENT ON TABLE legacy_rows IS
    'Rows and columns from the pre-rewrite database that have no home in this schema, kept with the reason. Written by db/etl, never updated. Not summable: the old ledger in particular misstates two movements.';

CREATE INDEX legacy_rows_source_idx ON legacy_rows (source_table, source_id);
CREATE INDEX legacy_rows_store_idx  ON legacy_rows (store_id) WHERE store_id IS NOT NULL;

CREATE FUNCTION legacy_rows_append_only() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    RAISE EXCEPTION 'legacy_rows is append-only: % is not allowed', TG_OP
        USING HINT = 'It records what the old system said. Correct a mistake with a new row that explains it.';
END;
$$;

CREATE TRIGGER legacy_rows_no_update BEFORE UPDATE OR DELETE ON legacy_rows
    FOR EACH ROW EXECUTE FUNCTION legacy_rows_append_only();
