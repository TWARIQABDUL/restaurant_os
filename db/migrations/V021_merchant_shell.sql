-- =============================================================================
-- V021 — the merchant's own screens, and a bug they exposed
-- =============================================================================
-- Milestone 19 of docs/migration/04-implementation-plan.md.
--
-- Two of these are what `Dashboard` needs. The first is a correction, and it is first because it is wrong in
-- production today.
--
--   1. A TIME ZONE PER STORE. V018 stored opening hours as the wall-clock times a merchant typed and compared
--      them against UTC. For a Kigali shop that is two hours out in both directions, and the second direction
--      is the damaging one.
--   2. A WAY TO PAUSE NEW ORDERS, which the dashboard's own banner offers and no column held.
--   3. THE DASHBOARD'S FIGURES, as one function, because "today" is a question about a time zone and it should
--      have exactly one answer.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The time zone, and why V018 was wrong without it
-- -----------------------------------------------------------------------------
-- `store_hours` holds 10:00 and 22:00 because that is what a merchant typed, meaning their own clock. V018's
-- store_open_state() then compared `p_at::time` — which is UTC, because V000 sets the database to UTC
-- deliberately — against those numbers. MEASURED on the seeded Nyama & Co., which trades 10:00 to 22:00:
--
--     11:00 in Kigali, shop open      →  we answered CLOSED
--     23:00 in Kigali, shop shut      →  we answered OPEN
--
-- The first loses a merchant two hours of custom every morning while the storefront says "Closed · opens
-- 10:00" over a shop that is serving. The second is worse: it takes orders for an hour after closing, for a
-- kitchen with nobody in it. V018 tested the function against fixed timestamps and every case passed, because
-- every case was in UTC — the bug is not in the arithmetic, it is in what the numbers MEAN.
--
-- AN IANA NAME, NOT AN OFFSET. "Africa/Kigali", not "+02:00". Rwanda does not observe daylight saving but
-- Kenya's neighbours have and may again, and an offset stored in a column is a decision that expires. Postgres
-- carries the whole database.
--
-- THE COUNTRY IS THE DEFAULT, not the store, because a merchant signing up has already said which country they
-- trade in and asking twice is asking them to know something they should not have to. Settings' Store details
-- panel — still owed by the designer (Part 9) — is where it becomes editable.

ALTER TABLE countries
    ADD COLUMN default_time_zone text NOT NULL DEFAULT 'UTC';

COMMENT ON COLUMN countries.default_time_zone IS
    'The IANA zone a new store in this country starts with. A default, not a constraint: a country can span zones and a merchant may correct it.';

UPDATE countries SET default_time_zone = 'Africa/Kigali'        WHERE code = 'RW';
UPDATE countries SET default_time_zone = 'Africa/Nairobi'       WHERE code = 'KE';
UPDATE countries SET default_time_zone = 'Africa/Kampala'       WHERE code = 'UG';
UPDATE countries SET default_time_zone = 'Africa/Dar_es_Salaam' WHERE code = 'TZ';
UPDATE countries SET default_time_zone = 'Africa/Bujumbura'     WHERE code = 'BI';


ALTER TABLE stores
    ADD COLUMN time_zone text;

-- Every existing store takes its country's zone. Written as an UPDATE rather than a DEFAULT because the
-- default cannot read another table, and because the point of this column is that it is a FACT about the store
-- rather than a fallback applied at read time.
UPDATE stores s
   SET time_zone = c.default_time_zone
  FROM countries c
 WHERE c.code = s.country;

-- Anything whose country is not in the table — which the foreign key prevents, but a migration should not
-- depend on a constraint it did not write.
UPDATE stores SET time_zone = 'UTC' WHERE time_zone IS NULL;

-- NOT NULL, AND DELIBERATELY NO DEFAULT. A default of 'UTC' would mean every store created after this
-- migration silently gets the wrong clock — which is exactly what happened the first time this file ran: the
-- backfill above found an empty table (migrations run before the seed), the seed then inserted six Rwandan
-- stores, and every one of them took the default. The column read UTC and the bug this migration exists to fix
-- was still there.
--
-- So the country fills it instead, in a trigger, because a fact no writer has to remember is a fact no writer
-- can forget. Onboarding at milestone 26 gets it for free, and so did the seed.
ALTER TABLE stores
    ALTER COLUMN time_zone SET NOT NULL;

COMMENT ON COLUMN stores.time_zone IS
    'The store''s own clock, as an IANA name. Every "today", every opening hour and every closing time is read in it. Filled from the store''s country when a writer does not give one.';


-- Two jobs, one trigger: fill it from the country when it was not given, and refuse a zone Postgres does not
-- know. The second cannot be a CHECK — pg_timezone_names is a view — and it matters, because an unknown zone
-- is not a bad value sitting in a column, it is an error on every future READ of the row.
CREATE FUNCTION stores_time_zone_from_country() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF NEW.time_zone IS NULL THEN
        SELECT c.default_time_zone INTO NEW.time_zone FROM countries c WHERE c.code = NEW.country;
        -- A country with no zone of its own, or no row at all: UTC, and it is visible in the column rather
        -- than applied invisibly at read time.
        NEW.time_zone := COALESCE(NEW.time_zone, 'UTC');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
        RAISE EXCEPTION '% is not a time zone this database knows', NEW.time_zone
            USING HINT = 'Use an IANA name such as Africa/Kigali. SELECT name FROM pg_timezone_names lists them.';
    END IF;

    RETURN NEW;
END;
$init$;

COMMENT ON FUNCTION stores_time_zone_from_country IS
    'Fills stores.time_zone from the store''s country when a writer leaves it out, and refuses a zone this database does not know — which a CHECK cannot do, because pg_timezone_names is a view.';

CREATE TRIGGER stores_time_zone_from_country
    BEFORE INSERT OR UPDATE OF time_zone, country ON stores
    FOR EACH ROW EXECUTE FUNCTION stores_time_zone_from_country();


-- The store's own clock at an instant. One function, so nothing else has to remember the conversion.
CREATE FUNCTION store_local(p_store_id uuid, p_at timestamptz DEFAULT now())
    RETURNS timestamp
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT p_at AT TIME ZONE s.time_zone FROM stores s WHERE s.id = p_store_id;
$init$;

COMMENT ON FUNCTION store_local IS
    'An instant as the store''s own wall clock reads it. The conversion V018 was missing, in one place so no caller repeats it.';


-- store_open_state(), corrected. Everything about the rule is V018's; the only change is that the clock and
-- the day are now the STORE's rather than the database's.
CREATE OR REPLACE FUNCTION store_open_state(p_store_id uuid, p_at timestamptz DEFAULT now())
    RETURNS TABLE (is_open boolean, closes_at time, opens_at time, opens_on smallint)
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_local     timestamp;
    v_today     smallint;
    v_yesterday smallint;
    v_now       time;
    v_row       record;
BEGIN
    -- THE ONE CHANGE, AND EVERY LINE BELOW DEPENDS ON IT. Without this the comparisons are against UTC, which
    -- for a Kigali shop answered "closed" at 11:00 and "open" at 23:00.
    v_local := store_local(p_store_id, p_at);
    IF v_local IS NULL THEN
        RETURN QUERY SELECT false, NULL::time, NULL::time, NULL::smallint;
        RETURN;
    END IF;

    v_today := extract(isodow FROM v_local)::smallint;
    v_yesterday := CASE WHEN v_today = 1 THEN 7 ELSE v_today - 1 END;
    v_now := v_local::time;

    -- Yesterday first: a session that began yesterday and has not ended takes precedence over today's, which
    -- may not have begun. Only a past-midnight row can still be running.
    SELECT h.opens_at, h.closes_at INTO v_row
      FROM store_hours h
     WHERE h.store_id = p_store_id AND h.day_of_week = v_yesterday
       AND h.closes_at <= h.opens_at
       AND v_now < h.closes_at;
    IF FOUND THEN
        RETURN QUERY SELECT true, v_row.closes_at, v_row.opens_at, v_yesterday;
        RETURN;
    END IF;

    SELECT h.opens_at, h.closes_at INTO v_row
      FROM store_hours h
     WHERE h.store_id = p_store_id AND h.day_of_week = v_today;

    IF FOUND THEN
        -- Half-open, like both of V013's windows: 10:00 is open and 22:00 is shut.
        IF v_row.closes_at > v_row.opens_at THEN
            IF v_now >= v_row.opens_at AND v_now < v_row.closes_at THEN
                RETURN QUERY SELECT true, v_row.closes_at, v_row.opens_at, v_today;
                RETURN;
            END IF;
        ELSIF v_now >= v_row.opens_at THEN
            RETURN QUERY SELECT true, v_row.closes_at, v_row.opens_at, v_today;
            RETURN;
        END IF;
    END IF;

    -- Shut. Say when it opens next.
    FOR i IN 0..6 LOOP
        SELECT h.opens_at,
               ((v_today + i - 1) % 7 + 1)::smallint AS day
          INTO v_row
          FROM store_hours h
         WHERE h.store_id = p_store_id
           AND h.day_of_week = ((v_today + i - 1) % 7 + 1)::smallint
           AND (i > 0 OR h.opens_at > v_now);
        IF FOUND THEN
            RETURN QUERY SELECT false, NULL::time, v_row.opens_at, v_row.day;
            RETURN;
        END IF;
    END LOOP;

    RETURN QUERY SELECT false, NULL::time, NULL::time, NULL::smallint;
END;
$init$;

COMMENT ON FUNCTION store_open_state IS
    'Whether a store is open at a moment, IN ITS OWN TIME ZONE, when it closes, and when it next opens. Reads yesterday''s row as well as today''s, because a row closing after midnight is still running.';


-- -----------------------------------------------------------------------------
-- 2. Pausing new orders
-- -----------------------------------------------------------------------------
-- `Dashboard` draws the banner and the button: "Your store is open · Accepting delivery and pickup orders
-- until 22:00" with "Pause new orders" beside it.
--
-- NOT stores.status, WHICH IS THE PLATFORM'S. That column is pending | active | suspended and AdminMerchants
-- owns it — suspension is something Vendlyfy does TO a store. Pausing is something a merchant does when the
-- kitchen is overwhelmed, and conflating the two would let a busy Tuesday look like a compliance problem in
-- the admin console.
--
-- IT DOES NOT CLOSE THE SHOPFRONT. A paused store still shows its menu, its prices and its hours — a customer
-- can look, and the refusal comes when they try to order. Hiding the catalogue would make a ten-minute pause
-- indistinguishable from a closed business.

ALTER TABLE stores
    ADD COLUMN accepting_orders boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN stores.accepting_orders IS
    'False while a merchant has paused new orders from the dashboard. Distinct from status, which is the platform''s: pausing is a busy kitchen, suspension is a compliance decision.';


-- place_order() refuses a paused store.
--
-- ONLY THE PAUSE, NOT "CLOSED", and the split is deliberate. A pause is an unconditional fact about the store
-- — the merchant pressed a button — so SQL can enforce it with no other knowledge. Whether a CLOSED store may
-- take an order depends on the `scheduled` module ("the customer chooses a future slot rather than ordering for
-- now"), which lives in the config engine; §1.3 is explicit that a component gets `has(module)` and nothing
-- else, and that applies to a function too. So the API decides that one, against the same config it renders
-- from, and this decides the one that needs no config.
CREATE OR REPLACE FUNCTION place_order(
    p_cart_id          uuid,
    p_idempotency_key  text,
    p_fulfilment       text,
    p_payment_method   text,
    p_expected_total   numeric,
    p_customer_user_id uuid    DEFAULT NULL,
    p_guest_name       text    DEFAULT NULL,
    p_guest_phone      text    DEFAULT NULL,
    p_guest_email      text    DEFAULT NULL,
    p_delivery_address text    DEFAULT NULL,
    p_delivery_zone_id uuid    DEFAULT NULL
) RETURNS TABLE (
    order_id      uuid,
    order_number  integer,
    tracking_code text,
    total_amount  numeric,
    cash_due      numeric,
    created       boolean
)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store     uuid;
    v_user      uuid;
    v_promo     text;
    v_order     uuid;
    v_number    integer;
    v_code      text;
    v_currency  char(3);
    v_fee       numeric(12,2) := 0;
    v_subtotal  numeric(12,2);
    v_total     numeric(12,2);
    v_lines     jsonb;
    v_promo_res record;
    v_item      uuid;
    v_due       numeric(12,2);
    v_constraint text;
    v_paused    boolean;
    v_name      text;
    r           record;
BEGIN
    IF p_fulfilment NOT IN ('delivery', 'pickup') THEN
        RAISE EXCEPTION 'fulfilment must be delivery or pickup, not %', p_fulfilment;
    END IF;
    IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) < 16 THEN
        RAISE EXCEPTION 'an idempotency key of at least 16 characters is required'
            USING HINT = 'The client generates one per checkout attempt and REUSES it on retry.';
    END IF;

    SELECT c.store_id INTO v_store FROM carts c WHERE c.id = p_cart_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That cart has expired.'
            USING ERRCODE = 'VLCAT',
                  HINT = 'Add what you want again.',
                  DETAIL = 'cart ' || p_cart_id;
    END IF;

    -- ------------------------------------------------------------------
    -- THE RETRY, CHECKED TWICE: once before the lock and once after it. See the note below the second one.
    -- ------------------------------------------------------------------
    SELECT o.id, o.order_number, o.tracking_code, o.total_amount, o.cash_due_amount
      INTO v_order, v_number, v_code, v_total, v_due
      FROM orders o
     WHERE o.store_id = v_store AND o.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RETURN QUERY SELECT v_order, v_number, v_code, v_total, v_due, false;
        RETURN;
    END IF;

    -- A PAUSE IS CHECKED AFTER THE RETRY, so a customer whose order already exists is never told the store has
    -- stopped taking orders. Their order was accepted; the pause came later, and it is not their problem.
    SELECT NOT s.accepting_orders, s.name INTO v_paused, v_name FROM stores s WHERE s.id = v_store;
    IF v_paused THEN
        RAISE EXCEPTION '% has paused new orders for a moment.', v_name
            USING ERRCODE = 'VLCAT',
                  HINT = 'Try again shortly, or call the store.';
    END IF;

    -- Now the lock: from here on this is the only checkout of this cart.
    SELECT c.store_id, c.user_id, c.promo_code INTO v_store, v_user, v_promo
      FROM carts c WHERE c.id = p_cart_id AND c.expires_at > now()
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That cart has expired.'
            USING ERRCODE = 'VLCAT', HINT = 'Add what you want again.';
    END IF;

    -- THE SECOND CHECK IS THE ONE THAT MATTERS, and it is here because of a measured failure at milestone 17:
    -- ten simultaneous requests carrying one key, the first placing the order and emptying the cart, and the
    -- other nine already past the first check and waiting on this lock. When it released they re-read the cart,
    -- found it empty, and were told "That cart is empty" at the moment their order existed.
    SELECT o.id, o.order_number, o.tracking_code, o.total_amount, o.cash_due_amount
      INTO v_order, v_number, v_code, v_total, v_due
      FROM orders o
     WHERE o.store_id = v_store AND o.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RETURN QUERY SELECT v_order, v_number, v_code, v_total, v_due, false;
        RETURN;
    END IF;

    IF v_user IS NOT NULL AND p_customer_user_id IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'that cart belongs to a different customer'
            USING HINT = 'Sign in as the account that holds the cart, or start a new one.';
    END IF;

    SELECT s.selling_currency INTO v_currency FROM stores s WHERE s.id = v_store;

    IF p_fulfilment = 'delivery' THEN
        IF p_delivery_address IS NULL OR btrim(p_delivery_address) = '' THEN
            RAISE EXCEPTION 'a delivery needs an address'
                USING HINT = 'Add a street, building or landmark the rider can find.';
        END IF;
        IF p_delivery_zone_id IS NULL THEN
            RAISE EXCEPTION 'a delivery needs a zone, so the fee is the one that was quoted';
        END IF;
        SELECT z.fee_amount INTO v_fee FROM delivery_zones z
         WHERE z.id = p_delivery_zone_id AND z.store_id = v_store AND z.is_active;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'That delivery area is no longer available.'
                USING ERRCODE = 'VLCAT', HINT = 'Reload the page and choose again.';
        END IF;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM store_pickup_settings WHERE store_id = v_store) THEN
            RAISE EXCEPTION 'This store does not offer pickup.'
                USING ERRCODE = 'VLCAT', HINT = 'Choose delivery instead.';
        END IF;
        v_fee := 0;
    END IF;

    CREATE TEMPORARY TABLE placed_lines ON COMMIT DROP AS
    SELECT i.id                          AS cart_item_id,
           i.variant_id,
           i.quantity,
           p.name                        AS product_name,
           COALESCE(NULLIF(btrim(v.sku), ''), NULL) AS sku,
           p.base_price                  AS unit_price,
           COALESCE(vlabel.label, '')    AS variant_label,
           COALESCE(extras.amount, 0)    AS options_amount
      FROM cart_items i
      JOIN product_variants v ON v.id = i.variant_id AND v.store_id = i.store_id
      JOIN products p ON p.id = v.product_id AND p.store_id = i.store_id
      LEFT JOIN LATERAL (
        SELECT string_agg(ov.label, ' · ' ORDER BY ov.position, ov.id) AS label
          FROM product_variant_values vv
          JOIN option_values ov ON ov.id = vv.option_value_id
         WHERE vv.variant_id = i.variant_id
      ) AS vlabel ON true
      LEFT JOIN LATERAL (
        SELECT sum(ov.price_delta) AS amount
          FROM cart_item_option_values civ
          JOIN option_values ov ON ov.id = civ.option_value_id
         WHERE civ.cart_item_id = i.id
      ) AS extras ON true
     WHERE i.cart_id = p_cart_id;

    IF NOT EXISTS (SELECT 1 FROM placed_lines) THEN
        RAISE EXCEPTION 'That cart is empty.'
            USING ERRCODE = 'VLCAT', HINT = 'Add something before checking out.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM placed_lines l
          JOIN product_variants v ON v.id = l.variant_id
          JOIN products p ON p.id = v.product_id
         WHERE NOT v.is_available OR p.status <> 'active'
    ) THEN
        RAISE EXCEPTION '% is no longer on sale.',
            (SELECT l.product_name FROM placed_lines l
               JOIN product_variants v ON v.id = l.variant_id
               JOIN products p ON p.id = v.product_id
              WHERE NOT v.is_available OR p.status <> 'active' LIMIT 1)
            USING ERRCODE = 'VLCAT', HINT = 'Remove it from your cart and try again.';
    END IF;

    SELECT sum((unit_price + options_amount) * quantity) INTO v_subtotal FROM placed_lines;

    v_number := next_order_number(v_store);
    v_code := replace(gen_random_uuid()::text, '-', '');

    BEGIN
        INSERT INTO orders (
            store_id, order_number, tracking_code, idempotency_key,
            customer_user_id, guest_name, guest_phone, guest_email,
            delivery_address, fulfilment_type, status, payment_method, payment_status,
            currency, subtotal_amount, delivery_fee_amount, discount_amount
        ) VALUES (
            v_store, v_number, v_code, p_idempotency_key,
            p_customer_user_id, p_guest_name, p_guest_phone, p_guest_email,
            CASE WHEN p_fulfilment = 'delivery' THEN p_delivery_address END,
            p_fulfilment, 'pending', p_payment_method, 'unpaid',
            v_currency, v_subtotal, v_fee, 0
        ) RETURNING id INTO v_order;
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint <> 'orders_store_idempotency_key' THEN
            RAISE;
        END IF;

        SELECT o.id, o.order_number, o.tracking_code, o.total_amount, o.cash_due_amount
          INTO v_order, v_number, v_code, v_total, v_due
          FROM orders o
         WHERE o.store_id = v_store AND o.idempotency_key = p_idempotency_key;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'this order was placed by another request that this transaction cannot see'
                USING HINT = 'place_order() needs READ COMMITTED to resolve a concurrent retry. Retry the request.',
                      ERRCODE = '40001';
        END IF;

        RETURN QUERY SELECT v_order, v_number, v_code, v_total, v_due, false;
        RETURN;
    END;

    FOR r IN SELECT * FROM placed_lines LOOP
        INSERT INTO order_items (order_id, store_id, variant_id, product_name, variant_label, sku,
                                 unit_price_amount, options_amount, quantity)
             VALUES (v_order, v_store, r.variant_id, r.product_name, r.variant_label, r.sku,
                     r.unit_price, r.options_amount, r.quantity)
          RETURNING id INTO v_item;

        INSERT INTO order_item_option_values (order_item_id, option_value_id, order_id,
                                              group_name, value_label, price_delta)
        SELECT v_item, ov.id, v_order, g.name, ov.label, ov.price_delta
          FROM cart_item_option_values civ
          JOIN option_values ov ON ov.id = civ.option_value_id
          JOIN option_groups g ON g.id = ov.option_group_id
         WHERE civ.cart_item_id = r.cart_item_id;
    END LOOP;

    PERFORM apply_automatic_promotions(v_order);

    IF v_promo IS NOT NULL THEN
        SELECT * INTO v_promo_res FROM apply_promo_code(v_order, v_promo);
    END IF;

    SELECT o.total_amount INTO v_total FROM orders o WHERE o.id = v_order;

    IF p_expected_total IS NULL OR v_total <> p_expected_total THEN
        RAISE EXCEPTION 'The total changed while you were checking out.'
            USING ERRCODE = 'VLCAT',
                  HINT = 'Check the new total and place the order again.',
                  DETAIL = 'expected ' || COALESCE(p_expected_total::text, 'null') || ', now ' || v_total::text;
    END IF;

    SELECT o.cash_due_amount INTO v_due FROM orders o WHERE o.id = v_order;

    SELECT jsonb_agg(jsonb_build_object('variant_id', l.variant_id, 'quantity', l.quantity))
      INTO v_lines FROM placed_lines l;
    PERFORM reserve_stock(v_store, v_lines);

    INSERT INTO order_events (order_id, store_id, from_status, to_status, note, actor_id)
         VALUES (v_order, v_store, NULL, 'pending', 'Order placed by the customer', p_customer_user_id);

    -- The merchant's own alert. V010's notify() decides who at the store sees it and what it links to; the
    -- dashboard's bell and Notifications' panel both read the same inbox.
    --
    -- THE KEYS ARE order_placed's OWN, from notification_types.required_payload_keys — order_number,
    -- total_amount, customer_name — not names chosen here. V010 checks a write against that list, so writing
    -- 'total' and 'customer' instead is refused at the insert rather than silently stored: "the client needs
    -- the values the sentence needs", and those are the three the type declares it needs.
    PERFORM notify(
        p_store_id => v_store,
        p_type_code => 'order_placed',
        p_idempotency_key => 'order_placed:' || v_order::text,
        p_payload => jsonb_build_object(
            'order_number', v_number,
            'total_amount', v_total,
            'customer_name', COALESCE(p_guest_name, (SELECT u.name FROM users u WHERE u.id = p_customer_user_id), 'A customer'),
            'fulfilment', p_fulfilment,
            'payment_method', p_payment_method),
        p_order_id => v_order);

    DELETE FROM cart_items WHERE cart_id = p_cart_id;
    UPDATE carts SET promo_code = NULL WHERE id = p_cart_id;

    RETURN QUERY SELECT v_order, v_number, v_code, v_total, v_due, true;
END;
$init$;

COMMENT ON FUNCTION place_order IS
    'Turns a cart into a pending, unpaid order — atomically, and once per idempotency key. Refuses a paused store, and any total but the one the customer agreed to. Reserves stock through reserve_stock() and raises the merchant''s order_placed notification. Does not talk to a payment provider.';


-- -----------------------------------------------------------------------------
-- 3. The dashboard's figures
-- -----------------------------------------------------------------------------
-- `Dashboard` draws four cards, a comparison and a week of bars. They are one function rather than six
-- queries for two reasons: it is the most-loaded merchant screen and one round trip beats six, and — the
-- important one — "today" is a question about a TIME ZONE and it should have exactly one answer. Six queries
-- each deriving their own day boundary is six chances for the cards to disagree with each other.
--
-- WHAT COUNTS AS A SALE: an order placed today that the store did not refuse. Not "paid", because a cash order
-- is money the merchant will have and the dashboard is what they plan the day from; and not "all", because an
-- order they rejected or a customer cancelled was never business. Rejected and cancelled are the two, and both
-- are terminal (V004's transition table has nothing leaving them).
--
-- "+12% VS LAST TUESDAY" is the board's own comparison, and it is the same WEEKDAY a week ago rather than
-- yesterday — a Tuesday compared with a Monday tells a restaurant nothing.

CREATE FUNCTION store_dashboard(p_store_id uuid, p_at timestamptz DEFAULT now())
    RETURNS TABLE (
        sales_today          numeric,
        sales_same_day_last_week numeric,
        orders_today         bigint,
        orders_waiting       bigint,
        products_active      bigint,
        products_draft       bigint,
        low_stock_variants   bigint,
        is_open              boolean,
        closes_at            time,
        accepting_orders     boolean,
        local_date           date
    )
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    WITH bounds AS (
        -- The store's own day, as an instant range. Computed once and reused, so every figure below shares one
        -- definition of "today" — and `AT TIME ZONE` twice is what turns a local midnight back into an instant.
        -- EVERY `AT TIME ZONE` IS PARENTHESISED, and it has to be: the operator binds tighter than `+`, so
        -- `date_trunc(...) + interval '1 day' AT TIME ZONE z` parses as `date_trunc(...) + (interval AT TIME
        -- ZONE z)` and fails with "function timezone(text, interval) does not exist". Which is a good error to
        -- get, because the alternative is an expression that parses and means something else.
        SELECT (date_trunc('day', store_local(p_store_id, p_at))) AT TIME ZONE s.time_zone                      AS day_start,
               (date_trunc('day', store_local(p_store_id, p_at)) + interval '1 day') AT TIME ZONE s.time_zone   AS day_end,
               (date_trunc('day', store_local(p_store_id, p_at)) - interval '7 days') AT TIME ZONE s.time_zone  AS last_week_start,
               (date_trunc('day', store_local(p_store_id, p_at)) - interval '6 days') AT TIME ZONE s.time_zone  AS last_week_end,
               store_local(p_store_id, p_at)::date AS local_date,
               s.accepting_orders
          FROM stores s WHERE s.id = p_store_id
    )
    SELECT
      COALESCE((SELECT sum(o.total_amount) FROM orders o, bounds b
                 WHERE o.store_id = p_store_id
                   AND o.placed_at >= b.day_start AND o.placed_at < b.day_end
                   AND o.status NOT IN ('rejected', 'cancelled')), 0)::numeric,
      COALESCE((SELECT sum(o.total_amount) FROM orders o, bounds b
                 WHERE o.store_id = p_store_id
                   AND o.placed_at >= b.last_week_start AND o.placed_at < b.last_week_end
                   AND o.status NOT IN ('rejected', 'cancelled')), 0)::numeric,
      (SELECT count(*) FROM orders o, bounds b
        WHERE o.store_id = p_store_id
          AND o.placed_at >= b.day_start AND o.placed_at < b.day_end
          AND o.status NOT IN ('rejected', 'cancelled')),
      -- "3 waiting for you" — orders the merchant has not accepted or refused yet, of ANY age. A pending order
      -- from last night is the most urgent thing on the screen, so this one is not scoped to today.
      (SELECT count(*) FROM orders o WHERE o.store_id = p_store_id AND o.status = 'pending'),
      (SELECT count(*) FROM products p WHERE p.store_id = p_store_id AND p.status = 'active'),
      (SELECT count(*) FROM products p WHERE p.store_id = p_store_id AND p.status = 'draft'),
      -- "Low stock 7". Counted per VARIANT, not per product, because that is what a merchant restocks — and
      -- V018's threshold is per product, compared against each of its variants.
      (SELECT count(*) FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE v.store_id = p_store_id
          AND p.track_stock AND p.low_stock_threshold > 0
          AND v.is_available
          AND v.stock_quantity IS NOT NULL
          AND v.stock_quantity <= p.low_stock_threshold),
      (SELECT o.is_open FROM store_open_state(p_store_id, p_at) o),
      (SELECT o.closes_at FROM store_open_state(p_store_id, p_at) o),
      (SELECT b.accepting_orders FROM bounds b),
      (SELECT b.local_date FROM bounds b);
$init$;

COMMENT ON FUNCTION store_dashboard IS
    'Every figure on the merchant dashboard, in the store''s own time zone, in one round trip. A sale is an order placed today that the store did not reject and the customer did not cancel.';


-- The week of bars. Seven rows, oldest first, with days that had no orders present as zero — a gap in a bar
-- chart reads as missing data rather than as a quiet Sunday.
CREATE FUNCTION store_sales_week(p_store_id uuid, p_at timestamptz DEFAULT now())
    RETURNS TABLE (local_day date, day_of_week smallint, sales numeric, orders bigint)
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    WITH days AS (
        -- Monday to Sunday of the store's current week, which is what the board labels Mon…Sun.
        SELECT (date_trunc('week', store_local(p_store_id, p_at))::date + n) AS local_day
          FROM generate_series(0, 6) AS n
    )
    SELECT d.local_day,
           extract(isodow FROM d.local_day)::smallint,
           COALESCE(sum(o.total_amount), 0)::numeric,
           count(o.id)
      FROM days d
      CROSS JOIN stores s
      LEFT JOIN orders o
             ON o.store_id = p_store_id
            AND o.status NOT IN ('rejected', 'cancelled')
            AND o.placed_at >= (d.local_day::timestamp AT TIME ZONE s.time_zone)
            AND o.placed_at <  ((d.local_day + 1)::timestamp AT TIME ZONE s.time_zone)
     WHERE s.id = p_store_id
     GROUP BY d.local_day
     ORDER BY d.local_day;
$init$;

COMMENT ON FUNCTION store_sales_week IS
    'Sales per day for the store''s current week, Monday first, in its own time zone. Days with no orders are zero rather than absent, because a gap in a bar chart reads as broken rather than quiet.';
