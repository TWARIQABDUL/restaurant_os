-- V007_fulfilment_and_rider_cash.sql
--
-- Milestone 9, second part. How a store delivers, how it gets paid out, and how a
-- rider's cash is reconciled at the end of a day.
--
-- The cash report is the subtle half, and CashReport.dc.html is more demanding
-- than it first looks:
--
--   * a rider hands cash in MORE THAN ONCE a day — "Handed in at 12:00 − 6,000" —
--     so a day is not one hand-over but a running account;
--   * closing a day produces a GAP, and the gap has three named outcomes: the
--     rider brings it next shift, the customer genuinely paid less and it is
--     recorded on the order, or it is written off;
--   * a carried-over gap is a debt that outlives the day — "Olivier · from Mon 21
--     Sep · #0994 · 1,000 RWF owed" — and can be marked received later;
--   * a day CANNOT be closed while the rider still has cash orders out: "The day
--     closes once they're delivered or returned."
--
-- None of this touches wallet_ledger, and that is deliberate. V005 established
-- that cash never reaches the platform: the rider handed it to the merchant. A
-- write-off is the merchant's loss, not a movement of platform money. The
-- platform's commission on a cash order is plans & fees, still unpriced.


-- =============================================================================
-- 1. Delivery zones
-- =============================================================================
-- Settings draws named zones with a fee and an ETA range, each covering named
-- areas: "Kigali city centre · Kacyiru, Kimihurura, Kiyovu · 1,000 RWF · 25–35 min".
--
-- NOTE, recorded not resolved: States.dc.html says "This store delivers within 8 km
-- of Kimihurura", which is a radius. Settings, which is the editor, has no radius —
-- it has named areas. Named areas are implemented because that is what a merchant
-- can actually fill in; the customer-facing sentence is prose and may be
-- approximate. If a radius is meant literally, it is a new column and a map.

CREATE TABLE delivery_zones (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id         uuid          NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    name             text          NOT NULL,
    fee_amount       numeric(12,2) NOT NULL DEFAULT 0,

    -- "25–35 min". A range, because a single number is a promise nobody can keep.
    eta_min_minutes  integer       NOT NULL,
    eta_max_minutes  integer       NOT NULL,

    is_active        boolean       NOT NULL DEFAULT true,
    position         integer       NOT NULL DEFAULT 0,

    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT delivery_zones_name_present CHECK (btrim(name) <> ''),
    CONSTRAINT delivery_zones_fee_not_negative CHECK (fee_amount >= 0),
    CONSTRAINT delivery_zones_eta_positive CHECK (eta_min_minutes > 0),
    CONSTRAINT delivery_zones_eta_ordered CHECK (eta_max_minutes >= eta_min_minutes),
    CONSTRAINT delivery_zones_id_store_key UNIQUE (id, store_id)
);

COMMENT ON TABLE delivery_zones IS
    'Where a store delivers, for how much, and how long it takes. A zone covers named areas — see delivery_zone_areas.';

CREATE UNIQUE INDEX delivery_zones_store_name_key ON delivery_zones (store_id, lower(btrim(name)));

-- Serves: the checkout's zone list, in the merchant's order.
CREATE INDEX delivery_zones_store_position_idx ON delivery_zones (store_id, position, id) WHERE is_active;

CREATE TRIGGER delivery_zones_set_updated_at BEFORE UPDATE ON delivery_zones
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE delivery_zone_areas (
    zone_id   uuid        NOT NULL,
    store_id  uuid        NOT NULL,
    area_name text        NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (zone_id, area_name),

    CONSTRAINT delivery_zone_areas_name_present CHECK (btrim(area_name) <> ''),
    FOREIGN KEY (zone_id, store_id) REFERENCES delivery_zones (id, store_id) ON DELETE CASCADE
);

COMMENT ON TABLE delivery_zone_areas IS
    'The areas a zone covers. An area belongs to exactly ONE zone per store, or checkout cannot say which fee applies.';

-- THE CONSTRAINT THAT MATTERS: one area, one zone, per store. Kacyiru in both
-- "Kigali city centre" at 1,000 and "Greater Kigali" at 2,000 would make the
-- delivery fee depend on which row was read first.
CREATE UNIQUE INDEX delivery_zone_areas_one_zone_per_area
    ON delivery_zone_areas (store_id, lower(btrim(area_name)));


-- =============================================================================
-- 2. Pickup
-- =============================================================================
-- Not a zone: it has an address rather than a coverage area, and no fee. A separate
-- 1:1 table rather than columns on stores, because a store with the pickup module
-- off simply has no row.

CREATE TABLE store_pickup_settings (
    store_id       uuid        PRIMARY KEY REFERENCES stores (id) ON DELETE CASCADE,

    address        text        NOT NULL,
    ready_minutes  integer     NOT NULL,
    instructions   text,

    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT store_pickup_address_present CHECK (btrim(address) <> ''),
    CONSTRAINT store_pickup_ready_positive CHECK (ready_minutes > 0)
);

COMMENT ON TABLE store_pickup_settings IS
    'Where and how soon a customer can collect. "Free · ready in 15 min". Absent when the store does not offer pickup.';

CREATE TRIGGER store_pickup_settings_set_updated_at BEFORE UPDATE ON store_pickup_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- 3. What a store has connected, and where its payouts go
-- =============================================================================

CREATE TABLE store_payment_methods (
    store_id           uuid        NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
    payment_method_key text        NOT NULL REFERENCES payment_methods (key) ON DELETE RESTRICT,

    is_connected       boolean     NOT NULL DEFAULT false,
    connected_at       timestamptz,

    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (store_id, payment_method_key),

    CONSTRAINT store_payment_methods_connected_at_agrees
        CHECK (is_connected = (connected_at IS NOT NULL))
);

COMMENT ON TABLE store_payment_methods IS
    'Which methods a store offers. NO CREDENTIALS HERE: provider keys are secrets and do not belong in a table every repository method can read. Where they live is an open decision — see the foot of this file.';

CREATE TRIGGER store_payment_methods_set_updated_at BEFORE UPDATE ON store_payment_methods
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE store_payout_settings (
    store_id           uuid        PRIMARY KEY REFERENCES stores (id) ON DELETE CASCADE,

    -- "Payouts go to MTN MoMo 078 ••• 4412 every morning at 08:00."
    payout_method_key  text        NOT NULL REFERENCES payment_methods (key) ON DELETE RESTRICT,
    payout_phone       text        NOT NULL,

    -- The round-2 brief asks for both automatic and manual settlement.
    settlement_mode    text        NOT NULL DEFAULT 'manual',
    -- Only meaningful when automatic. Stored as a local time of day; the store's
    -- timezone is a separate open question, so this is read as the platform's UTC
    -- day boundary until that is answered.
    automatic_at       time,

    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT store_payout_mode_values CHECK (settlement_mode IN ('manual', 'automatic')),
    CONSTRAINT store_payout_automatic_has_time
        CHECK ((settlement_mode = 'automatic') = (automatic_at IS NOT NULL)),
    CONSTRAINT store_payout_phone_present CHECK (btrim(payout_phone) <> '')
);

COMMENT ON TABLE store_payout_settings IS
    'Where a merchant''s money goes and on what schedule. A payout is never converted — the merchant is paid in the store''s own currency.';

CREATE TRIGGER store_payout_settings_set_updated_at BEFORE UPDATE ON store_payout_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- 4. Riders
-- =============================================================================
-- Everything below — rider profiles, hand-overs, settlements and an order's rider —
-- keys on (user_id, store_id, role), so that the ROLE is part of the reference and
-- not merely checked once by whichever code path created the row. store_members had
-- no such key, because V001 had nothing that needed one.
ALTER TABLE store_members
    ADD CONSTRAINT store_members_user_store_role_key UNIQUE (user_id, store_id, role);

-- A rider is a store member holding the rider role. The profile carries what is
-- true of them as a rider — the plate a manager reads off the roster — and the
-- availability they set themselves in the rider app.

CREATE TABLE rider_profiles (
    user_id                uuid        NOT NULL,
    store_id               uuid        NOT NULL,

    -- Always 'rider'. Carries the composite foreign key below, so a manager or a
    -- customer cannot be given a rider profile.
    member_role            text        NOT NULL DEFAULT 'rider',

    plate_number           text        NOT NULL,

    -- "Riders set this themselves in the rider app": Available / Off duty, and
    -- "Managers can't assign you" while off duty. "On a delivery" is NOT stored —
    -- it is derived from having an order out, so it cannot disagree with the orders.
    availability           text        NOT NULL DEFAULT 'off_duty',
    availability_changed_at timestamptz NOT NULL DEFAULT now(),

    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, store_id),

    CONSTRAINT rider_profiles_plate_present CHECK (btrim(plate_number) <> ''),
    CONSTRAINT rider_profiles_availability_values
        CHECK (availability IN ('available', 'off_duty')),
    CONSTRAINT rider_profiles_member_is_rider CHECK (member_role = 'rider'),

    FOREIGN KEY (user_id, store_id, member_role)
        REFERENCES store_members (user_id, store_id, role) ON DELETE CASCADE,

    CONSTRAINT rider_profiles_user_store_key UNIQUE (user_id, store_id)
);

COMMENT ON TABLE rider_profiles IS
    'A rider of one store. availability is what the rider sets; "on a delivery" is derived from their orders so the two can never disagree.';

-- ALL whitespace stripped, not just the ends: a plate is one vehicle however a
-- manager types it, so "RAD 482 K", "rad482k" and " RAD  482K " must collide.
CREATE UNIQUE INDEX rider_profiles_store_plate_key
    ON rider_profiles (store_id, upper(regexp_replace(plate_number, '\s+', '', 'g')));

-- Serves: the rider picker on the orders board — who is on duty at this store.
CREATE INDEX rider_profiles_store_available_idx ON rider_profiles (store_id) WHERE availability = 'available';

CREATE TRIGGER rider_profiles_set_updated_at BEFORE UPDATE ON rider_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- An order's rider must actually be a rider OF THAT STORE. V004 could only
-- reference users, because store_members had no key to hang this on.
ALTER TABLE orders
    ADD COLUMN rider_member_role text,
    ADD CONSTRAINT orders_rider_role_is_rider
        CHECK (rider_member_role IS NULL OR rider_member_role = 'rider'),
    -- Both columns or neither: a rider id without the role guarantee is the thing
    -- this is here to prevent.
    ADD CONSTRAINT orders_rider_columns_agree
        CHECK ((rider_user_id IS NULL) = (rider_member_role IS NULL)),
    ADD CONSTRAINT orders_rider_is_store_rider_fkey
        FOREIGN KEY (rider_user_id, store_id, rider_member_role)
        REFERENCES store_members (user_id, store_id, role) ON DELETE RESTRICT;

COMMENT ON COLUMN orders.rider_member_role IS
    'Derived, never passed in: rider when there is a rider, NULL otherwise. It exists only to carry the composite FK that makes assigning a manager or a customer as the rider unrepresentable.';

-- DERIVED, not defaulted. A DEFAULT of 'rider' would make every order without a
-- rider violate orders_rider_columns_agree, so every caller would have to pass
-- rider_member_role = NULL explicitly — a column nobody should have to know about.
CREATE FUNCTION orders_derive_rider_role() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    NEW.rider_member_role := CASE WHEN NEW.rider_user_id IS NULL THEN NULL ELSE 'rider' END;
    RETURN NEW;
END;
$init$;

CREATE TRIGGER orders_rider_role
    BEFORE INSERT OR UPDATE OF rider_user_id, rider_member_role ON orders
    FOR EACH ROW EXECUTE FUNCTION orders_derive_rider_role();


-- =============================================================================
-- 5. Cash a rider is carrying, and handing in
-- =============================================================================

CREATE TABLE rider_cash_handovers (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id      uuid          NOT NULL,
    rider_user_id uuid          NOT NULL,
    member_role   text          NOT NULL DEFAULT 'rider',

    amount        numeric(12,2) NOT NULL,
    handed_at     timestamptz   NOT NULL DEFAULT now(),

    -- Who counted it. A hand-over nobody signed for is not a record.
    received_by   uuid          REFERENCES users (id) ON DELETE SET NULL,
    note          text,

    created_at    timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT rider_cash_handovers_amount_positive CHECK (amount > 0),
    CONSTRAINT rider_cash_handovers_role_is_rider CHECK (member_role = 'rider'),
    FOREIGN KEY (rider_user_id, store_id, member_role)
        REFERENCES store_members (user_id, store_id, role) ON DELETE RESTRICT
);

COMMENT ON TABLE rider_cash_handovers IS
    'Each time a rider hands cash over, including part-way through a day — "Handed in at 12:00 − 6,000". A day is a running account, not one payment.';

-- Serves: "how much has this rider handed in today", on every open settlement card.
CREATE INDEX rider_cash_handovers_rider_idx ON rider_cash_handovers (store_id, rider_user_id, handed_at);


CREATE TABLE rider_cash_settlements (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id            uuid          NOT NULL,
    rider_user_id       uuid          NOT NULL,
    member_role         text          NOT NULL DEFAULT 'rider',

    business_date       date          NOT NULL,

    -- Captured at closing, like an order line: what the figures WERE when the
    -- manager signed off. Recomputing them later would change a settled record
    -- every time an order was amended.
    expected_amount     numeric(12,2) NOT NULL,
    handed_over_amount  numeric(12,2) NOT NULL,
    counted_amount      numeric(12,2) NOT NULL,

    -- Positive is short, negative is over. GENERATED, so it cannot disagree with
    -- the figures it comes from.
    gap_amount          numeric(12,2) NOT NULL
        GENERATED ALWAYS AS (expected_amount - handed_over_amount - counted_amount) STORED,

    -- The three outcomes CashReport offers for a shortfall.
    gap_resolution      text,
    -- Which order the shortfall was recorded against, when the customer genuinely
    -- paid less.
    gap_order_id        uuid,
    gap_note            text,

    -- A carried-over gap outlives the day: "from Mon 21 Sep · #0994 · 1,000 RWF
    -- owed", with a Mark received button.
    carried_over_settled_at timestamptz,
    carried_over_settled_by uuid      REFERENCES users (id) ON DELETE SET NULL,

    closed_by           uuid          REFERENCES users (id) ON DELETE SET NULL,
    closed_at           timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT rider_cash_settlements_amounts_not_negative CHECK (
        expected_amount >= 0 AND handed_over_amount >= 0 AND counted_amount >= 0),
    CONSTRAINT rider_cash_settlements_role_is_rider CHECK (member_role = 'rider'),
    CONSTRAINT rider_cash_settlements_resolution_values
        CHECK (gap_resolution IS NULL OR gap_resolution IN ('carry_over', 'discount', 'write_off')),
    -- A shortfall must be accounted for; a day that balances must not pretend to be.
    CONSTRAINT rider_cash_settlements_shortfall_resolved CHECK (
        (expected_amount - handed_over_amount - counted_amount > 0) = (gap_resolution IS NOT NULL)),
    -- "Customer paid less" has to say which customer.
    --
    -- coalesce is not decoration in either of these: gap_resolution is nullable, and
    -- a CHECK that evaluates to NULL is treated as SATISFIED. Written as
    -- `gap_resolution = 'discount'` this passed any row with a NULL resolution,
    -- which is exactly the rows it was meant to constrain.
    CONSTRAINT rider_cash_settlements_discount_names_order
        CHECK ((coalesce(gap_resolution, '') = 'discount') = (gap_order_id IS NOT NULL)),
    -- Only a carried-over gap can be received later.
    CONSTRAINT rider_cash_settlements_carry_over_only
        CHECK (carried_over_settled_at IS NULL OR coalesce(gap_resolution, '') = 'carry_over'),

    -- One settlement per rider per day.
    CONSTRAINT rider_cash_settlements_one_per_day UNIQUE (store_id, rider_user_id, business_date),

    FOREIGN KEY (rider_user_id, store_id, member_role)
        REFERENCES store_members (user_id, store_id, role) ON DELETE RESTRICT,
    FOREIGN KEY (gap_order_id, store_id) REFERENCES orders (id, store_id) ON DELETE RESTRICT
);

COMMENT ON TABLE rider_cash_settlements IS
    'Closing one rider''s day. Figures are captured, not recomputed, so a settled record does not change when an order is later amended.';
COMMENT ON COLUMN rider_cash_settlements.gap_amount IS
    'Positive is short, negative is over. GENERATED from the three captured figures so it cannot be set independently of them.';

-- Serves: the cash report for a day, and the "Carried over" list.
CREATE INDEX rider_cash_settlements_store_date_idx ON rider_cash_settlements (store_id, business_date DESC);
CREATE INDEX rider_cash_settlements_outstanding_idx
    ON rider_cash_settlements (store_id, business_date)
    WHERE gap_resolution = 'carry_over' AND carried_over_settled_at IS NULL;


-- A day cannot be closed while the rider still has cash orders out.
-- CashReport: "Can't close yet: 2 cash orders are still with Eric. The day closes
-- once they're delivered or returned."
CREATE FUNCTION rider_cash_settlement_day_is_over() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_open integer;
BEGIN
    SELECT count(*) INTO v_open
      FROM orders o
     WHERE o.store_id = NEW.store_id
       AND o.rider_user_id = NEW.rider_user_id
       AND o.payment_method = 'cash'
       AND o.status IN ('assigned', 'out');

    IF v_open > 0 THEN
        RAISE EXCEPTION 'cannot close the day: % cash order(s) are still with this rider', v_open
            USING HINT = 'The day closes once they are delivered or returned.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER rider_cash_settlements_day_is_over
    BEFORE INSERT ON rider_cash_settlements
    FOR EACH ROW EXECUTE FUNCTION rider_cash_settlement_day_is_over();


-- A settled day is a signed record. Only the carried-over debt may be marked
-- received afterwards; the figures themselves are fixed.
CREATE FUNCTION rider_cash_settlement_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a closed day cannot be deleted'
            USING HINT = 'Correct it with a later settlement or an adjustment, so the correction is visible.';
    END IF;

    IF NEW.expected_amount    IS DISTINCT FROM OLD.expected_amount
    OR NEW.handed_over_amount IS DISTINCT FROM OLD.handed_over_amount
    OR NEW.counted_amount     IS DISTINCT FROM OLD.counted_amount
    OR NEW.gap_resolution     IS DISTINCT FROM OLD.gap_resolution
    OR NEW.gap_order_id       IS DISTINCT FROM OLD.gap_order_id
    OR NEW.business_date      IS DISTINCT FROM OLD.business_date
    OR NEW.rider_user_id      IS DISTINCT FROM OLD.rider_user_id THEN
        RAISE EXCEPTION 'the figures on a closed day cannot be changed'
            USING HINT = 'Only the carried-over amount may be marked received later.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER rider_cash_settlements_freeze
    BEFORE UPDATE OR DELETE ON rider_cash_settlements
    FOR EACH ROW EXECUTE FUNCTION rider_cash_settlement_freeze();


-- =============================================================================
-- Two things recorded rather than invented
-- =============================================================================
-- 1. CARD PAYMENTS. Settings offers "Cards · Visa and Mastercard" as something a
--    merchant can connect, and AdminPayments — which is the list of providers the
--    platform integrates with — has no card processor at all. No row is seeded for
--    it, because a payment_methods row with a placeholder provider would assert an
--    integration that does not exist and `orders_payment_method_usable` would then
--    let an order through that nothing can charge. Choosing a processor is an open
--    decision; adding it afterwards is one INSERT plus its country and currency rows.
--
-- 2. PROVIDER CREDENTIALS. store_payment_methods records THAT a store connected a
--    method, never the keys. Provider secrets in an ordinary table are readable by
--    every repository method, every backup and every support query. Where they live
--    — a secrets manager, or encrypted columns with a key outside the database — is
--    an open decision that belongs with the payments work, not with this schema.
