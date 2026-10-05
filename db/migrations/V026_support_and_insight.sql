-- =============================================================================
-- V026 — Complaints, Reviews, Customers and Analytics: who may, and who is who
-- =============================================================================
-- Milestone 24 of docs/migration/04-implementation-plan.md: `Complaints`,
-- `ReviewsMerchant`, `Customers`, `Analytics`.
--
-- MOST OF WHAT THESE SCREENS DO IS ALREADY IN THE DATABASE. V008 has every
-- complaint move (resolve, reject, escalate, reopen — each writing its event in
-- the same statement), V009 has reply_to_review() and report_review(), and the
-- orders table has everything Analytics reads. What was missing is small, and is
-- here:
--
-- 1. PERMISSIONS. V001 seeded `orders.*`, `products.write`, `wallet.read` and
--    the rest, and nothing that says "may answer a complaint" or "may see who my
--    customers are". Three new ones, given to owner, admin and manager — the nav
--    already shows Complaints, Reviews and Customers to every console role, and a
--    manager answering a customer is the job. Analytics keeps asking `wallet.read`
--    (nav.ts's own note: "revenue over time asks the same question Money does"),
--    so a manager still cannot read the store's takings.
--
-- 2. WHO A CUSTOMER IS. Customers.dc.html: "Everyone who ordered, with or without
--    an account. Guests are matched by phone number." An order carries either an
--    account or a guest's phone, and one person is often both — they ordered as a
--    guest, then made an account. `customer_key()` is the match: the LAST NINE
--    digits, because "+250 78 455 9012", "250784559012" and "078 455 9012" are one
--    Rwandan number and `digits()` alone (V017: "normalises typography only,
--    never dialling plans") calls them three. Nine is the national significant
--    number in Rwanda; a market with another length changes this function in one
--    place — which is why it is a function and not three copies of right().
--
-- 3. A PRIVATE NOTE. "Private note (staff only) — e.g. Allergic to peanuts." keyed
--    by that same customer, so it follows the person across a guest order and an
--    account. One per customer per store, editable, never shown to the customer.
-- =============================================================================

INSERT INTO role_permissions (scope, role, permission) VALUES
    ('store', 'owner',   'support.write'),
    ('store', 'admin',   'support.write'),
    ('store', 'manager', 'support.write'),
    ('store', 'owner',   'customers.read'),
    ('store', 'admin',   'customers.read'),
    ('store', 'manager', 'customers.read'),
    ('store', 'owner',   'customers.write'),
    ('store', 'admin',   'customers.write'),
    ('store', 'manager', 'customers.write');

-- NO `SET search_path`, and that is deliberate for once: a function with a SET clause cannot be inlined into the
-- query that calls it, and this is called three times per order row. Measured at 20,000 orders: 544 ms of pure call
-- overhead for the key alone, against a fraction of that inlined. It uses only pg_catalog built-ins and nothing a
-- caller's search_path could substitute, and it does not call digits() for the same reason — that one has the SET.
CREATE FUNCTION customer_key(phone text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $init$
    SELECT CASE WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 7
                THEN right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) END;
$init$;

COMMENT ON FUNCTION customer_key(text) IS
    'The identity a phone number gives a customer: its last nine digits, so +250, 250 and 0 spellings of one number match. NULL for something too short to identify anybody.';

CREATE TABLE customer_notes (
    store_id     uuid        NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
    customer_key text        NOT NULL,
    note         text        NOT NULL,
    updated_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (store_id, customer_key),
    CONSTRAINT customer_notes_note_present CHECK (btrim(note) <> ''),
    CONSTRAINT customer_notes_note_length CHECK (length(note) <= 500)
);

CREATE TRIGGER customer_notes_set_updated_at BEFORE UPDATE ON customer_notes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE customer_notes IS
    'Staff-only, one per customer per store. An empty note deletes the row rather than storing an empty string, so "has a note" is the row existing.';

-- Serves: the Customers aggregate over a store's orders, grouped by the person. Expression index on the guest
-- arm; the account arm joins through users_id.
CREATE INDEX orders_store_guest_key_idx ON orders (store_id, customer_key(guest_phone)) WHERE guest_phone IS NOT NULL;
