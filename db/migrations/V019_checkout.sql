-- =============================================================================
-- V019 — placing an order
-- =============================================================================
-- Milestone 17 of docs/migration/04-implementation-plan.md.
--
-- The riskiest migration in the rewrite, because it is the one where money starts moving. Three things:
--
--   1. THE CASH-ROUNDING COLUMN the plan has owed since milestone 13, under "A gap milestone 13 found".
--   2. A CART THAT REMEMBERS ITS PROMO CODE, so an applied code lasts as long as the cart does.
--   3. place_order(), which turns a cart into an order ATOMICALLY AND IDEMPOTENTLY.
--
-- WHAT "ATOMIC" HAS TO MEAN HERE, spelled out because every clause of it is a real failure otherwise:
--
--   * A retried request produces ONE order, not two. The network drops between the request and the
--     response more often on a Kigali phone than anywhere this was designed, and the customer presses
--     the button again. `orders.idempotency_key` was put in V004 for this; this function is what finally
--     uses it, and a repeat returns the FIRST order rather than an error, because an error on a retry
--     tells somebody their order failed when it did not.
--   * Stock is decremented under a lock, in one global order, or two orders for the last unit both
--     succeed. reserve_stock() already does this and is not re-implemented here.
--   * The total the customer AGREED TO is the total that gets stored, or the order is refused. See
--     section 3: this function will not quietly charge a different number.
--   * Nothing half-happens. An order with no lines, lines that do not sum to the subtotal, a promotion
--     applied without its discount — each is a deferred constraint from V004 or V013, and they all check
--     at the one commit this function runs inside.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. What the rider actually collects
-- -----------------------------------------------------------------------------
-- `AdminCurrencies`: "Cash rounding applies only to cash-on-delivery totals, so riders don't need small
-- change", and its own preview shows the two as DIFFERENT AMOUNTS — Total 8,017 RWF, Cash due 8,000.
--
-- Until now there was nowhere to put the second figure, so the database believed a cash order was worth
-- 8,017 while the rider handed in 8,000 — and V007 requires a rider's shortfall to be "accounted for by
-- one of the board's three outcomes". Seventeen francs of unexplained shortfall on every cash order, for
-- a rule the platform itself applied. That is the gap, and this closes it.
--
-- A STORED COLUMN, DERIVED BY THE DATABASE, and the plan left the choice open — "whether the rounding is
-- decided when the order is placed or when it is paid". It is neither: it is decided by the TOTAL, and it
-- follows the total wherever the total goes.
--
-- THE FIRST VERSION OF THIS FILE HAD THE API COMPUTE IT AND SQL MERELY CHECK IT, on the V015 precedent
-- (the theme compiler derives, the database verifies). Seeding found the flaw in one run: a discount is
-- applied AFTER an order is inserted — by apply_automatic_promotions(), apply_promo_code() or
-- record_manual_discount(), all of them V013's — and every one of them changes total_amount. The stored
-- cash-due figure was then a rounding of a total that no longer existed: an order with a 1,000 discount
-- had a total of 10,000 and a cash due of 11,000, and the check caught it.
--
-- A checked column therefore puts a burden on THREE EXISTING MONEY FUNCTIONS and on every future one: each
-- would have to remember to re-round. That is exactly the kind of obligation this schema refuses to
-- distribute — the same argument V018 made for using a unique index rather than an advisory lock, because
-- "an index protects the table from writers it has never met".
--
-- So the database derives it, and no writer sets it. What that costs is a SECOND IMPLEMENTATION of the
-- rounding: packages/core's cashDue() for the checkout screen, and the plpgsql below for the stored
-- figure. That cost is paid deliberately and it is paid with a test — milestone 13 did the same thing for
-- WCAG contrast, where two implementations of luminance were pinned against each other across 145 colour
-- pairs and agree to one ulp. The two roundings are pinned the same way, and a disagreement between them
-- is a number the customer sees that the rider does not collect.
--
-- NOT A GENERATED COLUMN, which the plan also noted: the step lives in `currencies` and a generated
-- expression may not read another table. Nor may one generated column read another, which rules out
-- storing the step on the order and generating from it.

ALTER TABLE orders
    ADD COLUMN cash_due_amount numeric(12,2);

COMMENT ON COLUMN orders.cash_due_amount IS
    'What the rider collects for a cash order: total_amount rounded to the currency''s cash step. NULL for anything not paid in cash. MAINTAINED BY orders_cash_due_derive — no writer sets it. rider_cash_settlements reconciles against THIS, never against total_amount.';

ALTER TABLE orders
    ADD CONSTRAINT orders_cash_due_not_negative
        CHECK (cash_due_amount IS NULL OR cash_due_amount >= 0);


-- The rounding, in one place, reading the step from the currency.
--
-- round() on numeric is half away from zero, which is what packages/core's roundToStep() does. A step of 0
-- or 1 means the currency does not round cash, and then the cash due IS the total — one meaning for
-- "unrounded" rather than two.
CREATE FUNCTION order_cash_due_for(p_total numeric, p_currency char(3), p_method text)
    RETURNS numeric
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT CASE
             WHEN p_method <> 'cash' THEN NULL
             WHEN COALESCE(c.cash_rounding, 0) > 1
               THEN round(p_total / c.cash_rounding) * c.cash_rounding
             ELSE p_total
           END
      FROM currencies c WHERE c.code = p_currency;
$init$;

COMMENT ON FUNCTION order_cash_due_for IS
    'What a rider collects for a total in a currency: rounded to the cash step for cash, NULL otherwise. The SQL half of a pair — packages/core''s cashDue() is the other, and a test pins them together.';


-- Maintained AFTER the row is written, and AFTER is not a preference.
--
-- total_amount is a STORED GENERATED column, and Postgres computes those after before-triggers run — so
-- in a BEFORE trigger NEW.total_amount is NULL. V006 hit this exactly: its payment-method check was
-- written BEFORE and "silently passed everything" because NULL < min is NULL. The alternative, re-deriving
-- subtotal + delivery - discount here, is what V006 refused to do because it "would duplicate arithmetic
-- that must never drift from the generated column's own". So: AFTER, reading the generated value.
--
-- THE RECURSION TERMINATES. The UPDATE inside re-fires this trigger, and the second pass finds the value
-- already correct and writes nothing. One extra invocation per change, bounded by construction rather than
-- by a flag.
CREATE FUNCTION orders_cash_due_derive() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_due numeric(12,2);
BEGIN
    v_due := order_cash_due_for(NEW.total_amount, NEW.currency, NEW.payment_method);

    IF NEW.cash_due_amount IS DISTINCT FROM v_due THEN
        UPDATE orders SET cash_due_amount = v_due WHERE id = NEW.id;
    END IF;

    RETURN NULL;
END;
$init$;

CREATE TRIGGER orders_cash_due_derive
    AFTER INSERT OR UPDATE OF subtotal_amount, delivery_fee_amount, discount_amount,
                              payment_method, currency, cash_due_amount
    ON orders
    FOR EACH ROW EXECUTE FUNCTION orders_cash_due_derive();


-- And the promise, checked independently of the thing that maintains it — so it holds even if a future
-- edit to the trigger above is wrong. Deferred, because the trigger fills the column in a second
-- statement and an immediate check would see the row between them.
CREATE FUNCTION order_cash_due_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_order   record;
    v_expected numeric(12,2);
BEGIN
    SELECT o.id, o.total_amount, o.cash_due_amount, o.currency, o.payment_method
      INTO v_order FROM orders o WHERE o.id = NEW.id;

    -- Gone in the same transaction.
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_expected := order_cash_due_for(v_order.total_amount, v_order.currency, v_order.payment_method);

    -- "A cash order has one, and nothing else does" is part of this rather than a separate CHECK, because
    -- a plain CHECK is immediate and would fire before the trigger above could fill the column.
    IF v_order.cash_due_amount IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'order % has cash due % but its total of % in % rounds to %',
                        v_order.id, COALESCE(v_order.cash_due_amount::text, 'null'),
                        v_order.total_amount, v_order.currency, COALESCE(v_expected::text, 'null')
            USING HINT = 'cash_due_amount is derived by orders_cash_due_derive. Nothing should be setting it.';
    END IF;

    RETURN NULL;
END;
$init$;

COMMENT ON FUNCTION order_cash_due_check IS
    'Checks orders.cash_due_amount against order_cash_due_for(), independently of the trigger that maintains it. A cash order has one and nothing else does — enforced here rather than as a CHECK, because a CHECK is immediate and the value is filled in a second statement.';

CREATE CONSTRAINT TRIGGER orders_cash_due_agrees
    AFTER INSERT OR UPDATE OF cash_due_amount, subtotal_amount, delivery_fee_amount,
                              discount_amount, payment_method, currency
    ON orders
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION order_cash_due_check();


-- -----------------------------------------------------------------------------
-- 2. A cart that remembers its promo code
-- -----------------------------------------------------------------------------
-- Shop.dc.html applies a code on the CART screen and shows the discount in the cart's totals, then
-- carries it to checkout. The cart is a row that lasts seven days (V003), so a code typed into it should
-- last as long — otherwise "your cart is saved" is true of the items and false of the discount, and a
-- customer who reloads silently pays more than the screen last told them.
--
-- THE CODE, NOT THE DISCOUNT. What the code is worth depends on the lines, the time of day and the caps,
-- and V013's apply_promo_code() is the one thing allowed to decide it — at placement, against the order.
-- Storing an amount here would be a price quoted by a table that cannot see any of that.

ALTER TABLE carts
    ADD COLUMN promo_code text;

ALTER TABLE carts
    ADD CONSTRAINT carts_promo_code_shape
        -- Same shape as promotions.code, so a cart cannot hold something no promotion could be.
        CHECK (promo_code IS NULL OR promo_code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$');

COMMENT ON COLUMN carts.promo_code IS
    'A code the customer typed and the cart is holding. What it is WORTH is decided by apply_promo_code() at placement, against the order — never stored here.';


-- -----------------------------------------------------------------------------
-- 3. place_order() — a cart becomes an order, once
-- -----------------------------------------------------------------------------
-- The single most dangerous operation in the system, so every decision in it is written down.
--
-- IDEMPOTENT ON (store_id, idempotency_key), which V004's unique index has been waiting for. A repeat
-- returns the FIRST order with `created = false` and writes nothing — no second order, no second stock
-- decrement, no error. An error would be worse than either: it tells somebody their order failed at the
-- exact moment it succeeded, and the reasonable thing for them to do next is order again.
--
-- THE IDEMPOTENCY CHECK IS THE FIRST THING THAT HAPPENS, before the cart is even read. Anything before it
-- is work a retry repeats.
--
-- THE CART ROW IS LOCKED, which serialises two checkouts of the same cart. Without it, two requests with
-- DIFFERENT idempotency keys — a customer with the shop open in two tabs — would each copy the same lines
-- into an order of their own and reserve the stock twice. The lock is what makes "the cart was emptied"
-- true for exactly one of them; the second finds it empty and is refused.
--
-- PRICES ARE READ NOW, NOT REMEMBERED. V003 stores no price on a cart line — "any change is shown before
-- paying" — so the line's price is whatever the product and its options cost at this moment, and the
-- comparison below is what turns a change into a refusal rather than a surprise.
--
-- THE TOTAL THE CUSTOMER AGREED TO IS THE TOTAL THAT IS STORED, OR THERE IS NO ORDER. p_expected_total is
-- the figure the checkout screen last showed them. If the arithmetic now produces anything else — a price
-- edited, a promotion that expired between the screen and the button, an option withdrawn — the order is
-- refused with VLCAT and the client re-quotes. This is the one thing in the function that cannot be
-- delegated: everything else can be retried, but charging a number nobody agreed to cannot be undone by
-- retrying.
--
-- STOCK IS RESERVED LAST, after the total is settled. Reserving before would mean a refused total leaves
-- the reservation to be rolled back — which the transaction does correctly, but only by luck of ordering.
-- Doing it last means the expensive lock is held for the shortest time and is never taken for an order
-- that is about to be refused.
--
-- WHAT THIS FUNCTION DOES NOT DO: talk to a payment provider. It records an order as `pending` and
-- `unpaid`. Collecting the money is a separate step with its own idempotency (`momo_transactions`'
-- reference_id, and V005's three layers against a double charge), because a provider call is a network
-- request that must not be inside a transaction holding stock locks.

CREATE FUNCTION place_order(
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
    r           record;
BEGIN
    IF p_fulfilment NOT IN ('delivery', 'pickup') THEN
        RAISE EXCEPTION 'fulfilment must be delivery or pickup, not %', p_fulfilment;
    END IF;
    IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) < 16 THEN
        RAISE EXCEPTION 'an idempotency key of at least 16 characters is required'
            USING HINT = 'The client generates one per checkout attempt and REUSES it on retry.';
    END IF;

    -- The cart tells us the store, which the idempotency lookup needs. Read WITHOUT the lock first,
    -- because a retry must not queue behind another request's lock on a cart it is not going to touch.
    SELECT c.store_id INTO v_store FROM carts c WHERE c.id = p_cart_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That cart has expired.'
            USING ERRCODE = 'VLCAT',
                  HINT = 'Add what you want again.',
                  DETAIL = 'cart ' || p_cart_id;
    END IF;

    -- ------------------------------------------------------------------
    -- THE RETRY, CHECKED TWICE: once before the lock and once after it.
    -- ------------------------------------------------------------------
    -- The first check is the cheap one — a retry arriving after the original finished never queues behind
    -- anything.
    --
    -- THE SECOND CHECK IS THE ONE THAT MATTERS, and it is here because of a measured failure. Ten
    -- simultaneous requests carrying one key: the first places the order and empties the cart, and the
    -- other nine were already past the first check and waiting on the cart lock. When the lock released
    -- they re-read the cart, found it empty, and were told "That cart is empty" — nine customers told
    -- their cart was empty at the moment their order existed. On a connection where the button gets
    -- pressed twice, that is the normal case rather than the exotic one.
    --
    -- Check, lock, check again. Read Committed is what makes the second check see the committed order.
    SELECT o.id, o.order_number, o.tracking_code, o.total_amount, o.cash_due_amount
      INTO v_order, v_number, v_code, v_total, v_due
      FROM orders o
     WHERE o.store_id = v_store AND o.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RETURN QUERY SELECT v_order, v_number, v_code, v_total, v_due, false;
        RETURN;
    END IF;

    -- Now the lock: from here on this is the only checkout of this cart.
    SELECT c.store_id, c.user_id, c.promo_code INTO v_store, v_user, v_promo
      FROM carts c WHERE c.id = p_cart_id AND c.expires_at > now()
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That cart has expired.'
            USING ERRCODE = 'VLCAT', HINT = 'Add what you want again.';
    END IF;

    -- Whatever happened while this request waited for the lock, it happened before this line.
    SELECT o.id, o.order_number, o.tracking_code, o.total_amount, o.cash_due_amount
      INTO v_order, v_number, v_code, v_total, v_due
      FROM orders o
     WHERE o.store_id = v_store AND o.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RETURN QUERY SELECT v_order, v_number, v_code, v_total, v_due, false;
        RETURN;
    END IF;

    -- A cart's owner and the order's customer must be the same person. A signed-in customer's cart
    -- becoming a guest order — or somebody else's order — is the shape of a mistake worth refusing here.
    IF v_user IS NOT NULL AND p_customer_user_id IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'that cart belongs to a different customer'
            USING HINT = 'Sign in as the account that holds the cart, or start a new one.';
    END IF;

    SELECT s.selling_currency INTO v_currency FROM stores s WHERE s.id = v_store;

    -- ------------------------------------------------------------------
    -- Fulfilment, and what it costs.
    -- ------------------------------------------------------------------
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

    -- ------------------------------------------------------------------
    -- The lines, priced now.
    -- ------------------------------------------------------------------
    -- One CTE over the cart, so the subtotal and the lines below cannot be computed from two different
    -- reads of the same prices.
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
      -- The variant's own values, as the label a receipt has to read correctly after a rename.
      LEFT JOIN LATERAL (
        SELECT string_agg(ov.label, ' · ' ORDER BY ov.position, ov.id) AS label
          FROM product_variant_values vv
          JOIN option_values ov ON ov.id = vv.option_value_id
         WHERE vv.variant_id = i.variant_id
      ) AS vlabel ON true
      -- The line's priced extras.
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

    -- Anything that cannot be sold stops the whole order, named, because "one of your items is
    -- unavailable" sends a customer looking through all of them.
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
    -- 32 hex characters: unguessable, because a guest order has no account behind it and the tracking URL
    -- is the only thing standing between it and a stranger. gen_random_uuid() is in core — no extension.
    v_code := replace(gen_random_uuid()::text, '-', '');

    -- THE SECOND HALF OF IDEMPOTENCY, and the pre-check above is not enough on its own: two requests
    -- carrying the same key can BOTH pass it and both reach here. The unique index then refuses one of
    -- them — which would be a 500 on a request whose order exists and succeeded.
    --
    -- Postgres makes this resolvable rather than racy: the second inserter BLOCKS on the first's
    -- uncommitted row and learns the outcome. If the first committed, this handler finds its order and
    -- returns it; if the first rolled back, the insert simply succeeds. Read Committed is what makes the
    -- re-read see it, and that is why the handler asserts rather than assumes — under repeatable read the
    -- row would be invisible and returning "no order" would be worse than raising.
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
        -- Only the idempotency key means "somebody else already placed this order". A collision on the
        -- order number or the tracking code is a different problem and must not be swallowed.
        IF v_constraint <> 'orders_store_idempotency_key' THEN
            RAISE;
        END IF;

        SELECT o.id, o.order_number, o.tracking_code, o.total_amount, o.cash_due_amount
          INTO v_order, v_number, v_code, v_total, v_due
          FROM orders o
         WHERE o.store_id = v_store AND o.idempotency_key = p_idempotency_key;

        IF NOT FOUND THEN
            -- The row that caused the violation is not visible to this snapshot, which under repeatable
            -- read or serializable it would not be. Say so rather than inventing an answer.
            RAISE EXCEPTION 'this order was placed by another request that this transaction cannot see'
                USING HINT = 'place_order() needs READ COMMITTED to resolve a concurrent retry. Retry the request.',
                      ERRCODE = '40001';
        END IF;

        RETURN QUERY SELECT v_order, v_number, v_code, v_total, v_due, false;
        RETURN;
    END;

    -- A LOOP, one cart line at a time, and the reason is a bug the first version of this had. Written as
    -- two set-based INSERTs, the options had to be joined back to the line they belong to — and the only
    -- columns available to join on were (variant_id, quantity, options_amount). Two lines of the same
    -- variant with different extras that happen to cost the same (cheese +500 and avocado +500) match
    -- each other's rows, and each line ends up with both option sets. V004's options_amount check would
    -- have caught it at commit, which is the difference between a caught bug and a charged one — but only
    -- because that check exists. RETURNING cannot carry the source's cart_item_id, so the mapping is made
    -- explicit instead of inferred.
    FOR r IN SELECT * FROM placed_lines LOOP
        INSERT INTO order_items (order_id, store_id, variant_id, product_name, variant_label, sku,
                                 unit_price_amount, options_amount, quantity)
             VALUES (v_order, v_store, r.variant_id, r.product_name, r.variant_label, r.sku,
                     r.unit_price, r.options_amount, r.quantity)
          RETURNING id INTO v_item;

        -- Captured, not referenced: V004 keeps the group name, the label and the delta on the row so
        -- "Fries + extra sauce" still reads correctly after the merchant renames the option.
        INSERT INTO order_item_option_values (order_item_id, option_value_id, order_id,
                                              group_name, value_label, price_delta)
        SELECT v_item, ov.id, v_order, g.name, ov.label, ov.price_delta
          FROM cart_item_option_values civ
          JOIN option_values ov ON ov.id = civ.option_value_id
          JOIN option_groups g ON g.id = ov.option_group_id
         WHERE civ.cart_item_id = r.cart_item_id;
    END LOOP;

    -- ------------------------------------------------------------------
    -- Discounts, in the order the customer meets them.
    -- ------------------------------------------------------------------
    PERFORM apply_automatic_promotions(v_order);

    IF v_promo IS NOT NULL THEN
        -- A code that no longer applies is NOT an error here: it changes the total, and the comparison
        -- below is what tells the customer. Raising instead would refuse an order over a discount they
        -- may not even want any more.
        SELECT * INTO v_promo_res FROM apply_promo_code(v_order, v_promo);
    END IF;

    SELECT o.total_amount INTO v_total FROM orders o WHERE o.id = v_order;

    -- ------------------------------------------------------------------
    -- THE AGREED TOTAL.
    -- ------------------------------------------------------------------
    IF p_expected_total IS NULL OR v_total <> p_expected_total THEN
        RAISE EXCEPTION 'The total changed while you were checking out.'
            USING ERRCODE = 'VLCAT',
                  HINT = 'Check the new total and place the order again.',
                  DETAIL = 'expected ' || COALESCE(p_expected_total::text, 'null') || ', now ' || v_total::text;
    END IF;

    -- ------------------------------------------------------------------
    -- The stock, last.
    -- ------------------------------------------------------------------
    -- cash_due_amount is NOT set here. orders_cash_due_derive has already filled it from the total, and it
    -- refilled it when the discounts above changed that total — which is the whole reason the column is
    -- derived rather than passed in.
    SELECT o.cash_due_amount INTO v_due FROM orders o WHERE o.id = v_order;

    SELECT jsonb_agg(jsonb_build_object('variant_id', l.variant_id, 'quantity', l.quantity))
      INTO v_lines FROM placed_lines l;
    PERFORM reserve_stock(v_store, v_lines);

    -- The timeline's first entry. Orders.dc.html's tracking list starts at "Order placed", and an order
    -- whose history begins at its second status is one nobody can audit.
    INSERT INTO order_events (order_id, store_id, from_status, to_status, note, actor_id)
         VALUES (v_order, v_store, NULL, 'pending', 'Order placed by the customer', p_customer_user_id);

    -- The cart is emptied, not deleted: the cookie still points at something valid, and the next thing
    -- added starts a fresh bag rather than a fresh row.
    DELETE FROM cart_items WHERE cart_id = p_cart_id;
    UPDATE carts SET promo_code = NULL WHERE id = p_cart_id;

    RETURN QUERY SELECT v_order, v_number, v_code, v_total, v_due, true;
END;
$init$;

COMMENT ON FUNCTION place_order IS
    'Turns a cart into a pending, unpaid order — atomically, and once per idempotency key. Refuses if the total is not the one the customer agreed to. Reserves stock through reserve_stock(). Does not talk to a payment provider: collecting the money is a separate step with its own idempotency.';


-- -----------------------------------------------------------------------------
-- 4. Quoting a discount without writing an order
-- -----------------------------------------------------------------------------
-- The checkout screen shows a Discount line and a Total, and place_order() refuses any total but the one
-- the customer agreed to. So the screen has to know what a promo code and the automatic offers are worth
-- BEFORE an order exists — and V013's two application functions both work against an order, because that
-- is the only thing that existed when they were written.
--
-- THE WRONG WAY TO FIX THIS, and the way this file started, is a second function that re-states the rules
-- against a cart: active, inside its dates, on the right day, inside its hours, above the minimum, with the
-- required product, under both caps, capped at what is left. Ten rules in two places is ten chances for a
-- quoted discount and a charged discount to disagree, and the customer only notices when they differ.
--
-- SO THE RULES MOVE OUT OF BOTH FUNCTIONS INTO ONE, and the two existing ones become callers. This is a
-- change to working money code, which is not done lightly: what makes it safe is that the rules themselves
-- are transcribed unchanged, all the LOCKING AND WRITING stays exactly where it was, and the 92-assertion
-- promotions suite in db/scripts/test-promotions.sh is the check that nothing moved.
--
-- WHAT THE EVALUATOR NEEDS IS NOT AN ORDER. It needs a subtotal, the lines (to test a required product and
-- to price a free one), who is buying, what is already discounted, and when. A cart can produce all five,
-- and so can an order. That is the whole reason this works.

/** The lines a promotion has to reason about, in one shape that a cart and an order can both produce. */
CREATE FUNCTION promotion_lines_of_order(p_order_id uuid) RETURNS jsonb
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'product_id', v.product_id,
               -- The price CAPTURED on the line, not today's: "Free fries" is worth what these fries cost.
               'unit_amount', i.unit_price_amount + i.options_amount,
               'quantity', i.quantity)), '[]'::jsonb)
      FROM order_items i
      JOIN product_variants v ON v.id = i.variant_id
     WHERE i.order_id = p_order_id;
$init$;

CREATE FUNCTION promotion_lines_of_cart(p_cart_id uuid) RETURNS jsonb
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'product_id', v.product_id,
               -- A cart stores no price, so this is the price NOW — which is the price the order will
               -- capture a moment later, and the reason place_order() compares totals at all.
               'unit_amount', p.base_price + COALESCE(extras.amount, 0),
               'quantity', i.quantity)), '[]'::jsonb)
      FROM cart_items i
      JOIN product_variants v ON v.id = i.variant_id
      JOIN products p ON p.id = v.product_id
      LEFT JOIN LATERAL (
        SELECT sum(ov.price_delta) AS amount
          FROM cart_item_option_values civ
          JOIN option_values ov ON ov.id = civ.option_value_id
         WHERE civ.cart_item_id = i.id
      ) AS extras ON true
     WHERE i.cart_id = p_cart_id;
$init$;


/**
 * The arithmetic alone: what a promotion is worth against a subtotal and a set of lines.
 *
 * SEPARATE FROM THE ELIGIBILITY, and that split is not tidiness. promotion_discount_for_order() has always
 * answered "what is this worth" WITHOUT asking whether it applies — apply_automatic_promotions() checks
 * live-ness itself and then asks for the figure. Folding the two together would have made that function
 * return 0 for an expired promotion, which is a different answer to the same question and the kind of
 * change that passes every test until something reads it.
 */
CREATE FUNCTION promotion_amount_for(p_promotion_id uuid, p_subtotal numeric, p_lines jsonb)
    RETURNS numeric
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    p     record;
    v_raw numeric(12,2);
BEGIN
    SELECT * INTO p FROM promotions WHERE id = p_promotion_id;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    IF p.discount_type = 'percentage' THEN
        -- Shop's own: round(subtotal * 0.1). Of the ITEMS.
        v_raw := round(p_subtotal * p.percent_off / 100, 2);
    ELSIF p.discount_type = 'fixed_amount' THEN
        v_raw := p.amount_off;
    ELSE
        -- free_item: worth what the cheapest qualifying line charges for it.
        SELECT min((e->>'unit_amount')::numeric) INTO v_raw
          FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) AS a(e)
         WHERE (e->>'product_id')::uuid = p.free_product_id;
        v_raw := COALESCE(v_raw, 0);
    END IF;

    -- Never more than the items came to. A fixed 5,000 off a 3,000 order is 3,000 off, not a store paying
    -- for somebody's delivery.
    RETURN least(COALESCE(v_raw, 0), p_subtotal);
END;
$init$;

COMMENT ON FUNCTION promotion_amount_for IS
    'What a promotion is worth against a subtotal and a set of lines, ignoring whether it applies: a percentage of the items, a fixed amount, or the cheapest qualifying line''s captured price — capped at the subtotal.';


/**
 * What a promotion is worth, or why it is worth nothing. The ONE implementation of V013's rules.
 *
 * The statuses are V013's own list, unchanged, in the order a customer meets them, because the boards have
 * different words for each: unknown_code, withdrawn, not_started, expired, outside_hours, already_applied,
 * below_minimum, requirements_not_met, limit_reached, nothing_to_discount, applied.
 *
 * IT TAKES NO LOCKS AND WRITES NOTHING. Serialising a capped promotion is the CALLER's job, and only the
 * callers that are about to write need to do it — a quote that locked promotion rows would put every
 * checkout view behind every checkout.
 */
CREATE FUNCTION promotion_evaluate(
    p_promotion_id     uuid,
    p_subtotal         numeric,
    p_lines            jsonb,
    p_customer_user_id uuid        DEFAULT NULL,
    p_current_discount numeric     DEFAULT 0,
    p_applied          uuid[]      DEFAULT '{}',
    p_at               timestamptz DEFAULT now()
) RETURNS TABLE (status text, amount numeric)
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    p          record;
    v_raw      numeric(12,2);
    v_headroom numeric(12,2);
    v_used     bigint;
BEGIN
    amount := 0;

    SELECT * INTO p FROM promotions WHERE id = p_promotion_id;
    IF NOT FOUND THEN
        status := 'unknown_code';
        RETURN NEXT;
        RETURN;
    END IF;

    IF NOT p.is_active THEN
        status := 'withdrawn';
    ELSIF p.starts_at IS NOT NULL AND p.starts_at > p_at THEN
        status := 'not_started';
    ELSIF p.ends_at IS NOT NULL AND p.ends_at <= p_at THEN
        status := 'expired';
    ELSIF NOT promotion_is_live(p.id, p_at) THEN
        -- Active and inside its dates, so what is left is the day-and-hour rule.
        status := 'outside_hours';
    ELSIF p.id = ANY (COALESCE(p_applied, '{}')) THEN
        status := 'already_applied';
    ELSIF p.min_subtotal_amount IS NOT NULL AND p_subtotal < p.min_subtotal_amount THEN
        status := 'below_minimum';
    ELSIF p.required_product_id IS NOT NULL AND COALESCE((
            SELECT sum((e->>'quantity')::integer)
              FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) AS a(e)
             WHERE (e->>'product_id')::uuid = p.required_product_id), 0) < p.min_quantity THEN
        status := 'requirements_not_met';
    END IF;

    IF status IS NOT NULL THEN
        RETURN NEXT;
        RETURN;
    END IF;

    -- The caps, counted from the discounts actually recorded so a cap cannot be beaten by a promotion row
    -- that was edited afterwards. The caller serialises on the promotion before calling, where it writes.
    IF p.max_redemptions IS NOT NULL THEN
        SELECT count(*) INTO v_used FROM order_discounts d WHERE d.promotion_id = p.id;
        IF v_used >= p.max_redemptions THEN
            status := 'limit_reached';
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    IF p.max_redemptions_per_customer IS NOT NULL AND p_customer_user_id IS NOT NULL THEN
        SELECT count(*) INTO v_used
          FROM order_discounts d JOIN orders o ON o.id = d.order_id
         WHERE d.promotion_id = p.id AND o.customer_user_id = p_customer_user_id;
        IF v_used >= p.max_redemptions_per_customer THEN
            status := 'limit_reached';
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    v_raw := promotion_amount_for(p.id, p_subtotal, p_lines);

    -- Never more than is LEFT of the items. A second code on an order already half discounted takes the
    -- rest and no more; capping at the subtotal instead would overshoot and abort the whole call on
    -- V013's deferred check, where the customer should simply be told there is nothing left to take off.
    v_headroom := p_subtotal - COALESCE(p_current_discount, 0);
    amount := least(v_raw, v_headroom);

    IF amount <= 0 THEN
        status := 'nothing_to_discount';
        amount := 0;
        RETURN NEXT;
        RETURN;
    END IF;

    status := 'applied';
    RETURN NEXT;
END;
$init$;

COMMENT ON FUNCTION promotion_evaluate IS
    'Whether a promotion applies to a set of lines and what it is worth. The ONE implementation of V013''s rules: apply_promo_code(), apply_automatic_promotions() and promotion_quote() all call it, so a quoted discount and a charged discount cannot disagree. Takes no locks and writes nothing.';


-- What a promotion is worth on one order — kept, with its signature and meaning, now delegating.
CREATE OR REPLACE FUNCTION promotion_discount_for_order(p_promotion_id uuid, p_order_id uuid)
    RETURNS numeric
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_subtotal numeric(12,2);
    v_amount   numeric(12,2);
BEGIN
    SELECT subtotal_amount INTO v_subtotal FROM orders WHERE id = p_order_id;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- The arithmetic only, with no eligibility test and no headroom — which is exactly what this function
    -- has always answered, and what apply_automatic_promotions() relies on.
    v_amount := promotion_amount_for(p_promotion_id, v_subtotal, promotion_lines_of_order(p_order_id));

    RETURN COALESCE(v_amount, 0);
END;
$init$;

COMMENT ON FUNCTION promotion_discount_for_order IS
    'What a promotion is worth on one order: a percentage of the items, a fixed amount, or the captured price of the free product — capped at the subtotal in every case. Delegates to promotion_amount_for().';


-- The typed code, now a caller. EVERY LOCK AND EVERY WRITE IS WHERE V013 PUT IT — only the ten rules have
-- moved out, so the quote can ask them too.
CREATE OR REPLACE FUNCTION apply_promo_code(
    p_order_id uuid,
    p_code     text,
    p_at       timestamptz DEFAULT now()
) RETURNS TABLE (status text, discount_amount numeric, promotion_id uuid)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    p          record;
    v_store    uuid;
    v_customer uuid;
    v_subtotal numeric(12,2);
    v_current  numeric(12,2);
    v_applied  uuid[];
    v_eval     record;
BEGIN
    status := 'unknown_code';
    discount_amount := 0;
    promotion_id := NULL;

    -- The order is locked for the rest of this call: the discount and the column it has to agree with move
    -- together.
    SELECT store_id, customer_user_id, subtotal_amount, orders.discount_amount
      INTO v_store, v_customer, v_subtotal, v_current
      FROM orders WHERE id = p_order_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'order % does not exist', p_order_id;
    END IF;

    SELECT * INTO p FROM promotions
     WHERE store_id = v_store AND upper(btrim(code)) = upper(btrim(p_code));

    IF NOT FOUND THEN
        RETURN NEXT;   -- unknown_code
        RETURN;
    END IF;

    promotion_id := p.id;

    -- THE CAPS ARE SERIALISED ON THE PROMOTION ROW, and this is still the writer's job. Counting
    -- redemptions is not enough on its own: two customers checking out at once each count the rows the
    -- other has not committed yet, both see room, and a code limited to one is used twice. Taking the
    -- promotion's row first gives redemptions of one promotion a total order.
    --
    -- Only when there IS a cap, so an uncapped code does not serialise a whole store's checkouts behind one
    -- row. The lock order is order, then promotion — the same way round as everywhere else, so nothing here
    -- can deadlock against apply_automatic_promotions.
    IF p.max_redemptions IS NOT NULL OR p.max_redemptions_per_customer IS NOT NULL THEN
        PERFORM 1 FROM promotions WHERE id = p.id FOR UPDATE;
    END IF;

    SELECT array_agg(d.promotion_id) INTO v_applied
      FROM order_discounts d WHERE d.order_id = p_order_id AND d.promotion_id IS NOT NULL;

    SELECT e.status, e.amount INTO v_eval
      FROM promotion_evaluate(p.id, v_subtotal, promotion_lines_of_order(p_order_id),
                              v_customer, v_current, COALESCE(v_applied, '{}'), p_at) AS e;

    status := v_eval.status;
    IF status <> 'applied' THEN
        RETURN NEXT;
        RETURN;
    END IF;

    -- Both writes together: the row and the column the deferred check compares it against.
    INSERT INTO order_discounts (order_id, store_id, source, promotion_id, code, amount)
         VALUES (p_order_id, v_store, 'promotion', p.id, upper(btrim(p.code)), v_eval.amount);

    UPDATE orders SET discount_amount = v_current + v_eval.amount WHERE id = p_order_id;

    discount_amount := v_eval.amount;
    RETURN NEXT;
END;
$init$;

COMMENT ON FUNCTION apply_promo_code IS
    'Applies a typed code, or says why not: unknown_code, withdrawn, not_started, expired, outside_hours, already_applied, below_minimum, requirements_not_met, limit_reached, nothing_to_discount. Never raises for ordinary customer input, because the board has different words for each. The rules themselves are promotion_evaluate()''s, shared with the quote.';


-- The automatic pass, likewise. Its selection, its ordering, its locking and its writing are V013's.
CREATE OR REPLACE FUNCTION apply_automatic_promotions(p_order_id uuid, p_at timestamptz DEFAULT now())
    RETURNS TABLE (applied_promotion_id uuid, applied_amount numeric)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    r          record;
    v_store    uuid;
    v_subtotal numeric(12,2);
    v_total    numeric(12,2) := 0;
    v_customer uuid;
    v_lines    jsonb;
    v_applied  uuid[];
    v_eval     record;
BEGIN
    SELECT store_id, subtotal_amount, discount_amount, customer_user_id
      INTO v_store, v_subtotal, v_total, v_customer
      FROM orders WHERE id = p_order_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'order % does not exist', p_order_id;
    END IF;

    v_lines := promotion_lines_of_order(p_order_id);

    FOR r IN
        SELECT p.id, p.code, p.max_redemptions, p.max_redemptions_per_customer
          FROM promotions p
         WHERE p.store_id = v_store AND p.kind = 'automatic'
           AND promotion_is_live(p.id, p_at)
         -- Deterministic order, so two identical carts get identical totals however the rows happen to be
         -- laid out on disk.
         ORDER BY p.created_at, p.id
    LOOP
        -- The same serialisation as the typed path, for the same reason.
        IF r.max_redemptions IS NOT NULL OR r.max_redemptions_per_customer IS NOT NULL THEN
            PERFORM 1 FROM promotions WHERE id = r.id FOR UPDATE;
        END IF;

        -- Re-read each time: a promotion applied on the previous iteration is in here, which is what makes
        -- this idempotent — a retried checkout adds nothing.
        SELECT array_agg(d.promotion_id) INTO v_applied
          FROM order_discounts d WHERE d.order_id = p_order_id AND d.promotion_id IS NOT NULL;

        SELECT e.status, e.amount INTO v_eval
          FROM promotion_evaluate(r.id, v_subtotal, v_lines, v_customer, v_total,
                                  COALESCE(v_applied, '{}'), p_at) AS e;

        IF v_eval.status <> 'applied' THEN
            CONTINUE;
        END IF;

        INSERT INTO order_discounts (order_id, store_id, source, promotion_id, code, amount)
             VALUES (p_order_id, v_store, 'promotion', r.id, r.code, v_eval.amount);

        v_total := v_total + v_eval.amount;

        applied_promotion_id := r.id;
        applied_amount := v_eval.amount;
        RETURN NEXT;
    END LOOP;

    UPDATE orders SET discount_amount = v_total WHERE id = p_order_id;
END;
$init$;

COMMENT ON FUNCTION apply_automatic_promotions IS
    'Applies every live automatic promotion to an order, in a deterministic order, never twice and never past the subtotal. Idempotent: a retried checkout adds nothing. The rules are promotion_evaluate()''s, shared with the quote.';


/**
 * What the checkout screen shows: the automatic offers, and the typed code, against a CART.
 *
 * The same rules and the same arithmetic the placement will use, so the Discount line a customer reads is
 * the discount they are charged. `status` is the CODE's outcome — the boards have a sentence for each — and
 * `automatic_amount` is what the store's own offers come to regardless of any code.
 *
 * NO LOCKS AND NO WRITES. A quote runs on every checkout view; serialising them behind a capped promotion
 * would be paying the write path's cost for a read. The consequence is that a cap can be filled between the
 * quote and the placement, which place_order()'s total comparison turns into "the total changed" rather than
 * into a wrong charge.
 */
CREATE FUNCTION promotion_quote(
    p_store_id uuid,
    p_code     text,
    p_cart_id  uuid,
    p_at       timestamptz DEFAULT now()
) RETURNS TABLE (status text, discount_amount numeric, automatic_amount numeric)
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    r          record;
    v_subtotal numeric(12,2);
    v_lines    jsonb;
    v_customer uuid;
    v_applied  uuid[] := '{}';
    v_running  numeric(12,2) := 0;
    v_eval     record;
    v_promo    uuid;
BEGIN
    status := NULL;
    discount_amount := 0;
    automatic_amount := 0;

    SELECT c.user_id INTO v_customer FROM carts c WHERE c.id = p_cart_id;

    v_lines := promotion_lines_of_cart(p_cart_id);
    SELECT COALESCE(sum((e->>'unit_amount')::numeric * (e->>'quantity')::integer), 0) INTO v_subtotal
      FROM jsonb_array_elements(v_lines) AS a(e);

    -- The automatic pass, in the same deterministic order as the writer.
    FOR r IN
        SELECT p.id FROM promotions p
         WHERE p.store_id = p_store_id AND p.kind = 'automatic' AND promotion_is_live(p.id, p_at)
         ORDER BY p.created_at, p.id
    LOOP
        SELECT e.status, e.amount INTO v_eval
          FROM promotion_evaluate(r.id, v_subtotal, v_lines, v_customer, v_running, v_applied, p_at) AS e;
        IF v_eval.status = 'applied' THEN
            v_running := v_running + v_eval.amount;
            automatic_amount := automatic_amount + v_eval.amount;
            v_applied := v_applied || r.id;
        END IF;
    END LOOP;

    -- Then the code, against what is left — which is the order the customer meets them in and the order
    -- place_order() applies them in.
    IF p_code IS NOT NULL AND btrim(p_code) <> '' THEN
        SELECT p.id INTO v_promo FROM promotions p
         WHERE p.store_id = p_store_id AND upper(btrim(p.code)) = upper(btrim(p_code));

        IF v_promo IS NULL THEN
            status := 'unknown_code';
        ELSE
            SELECT e.status, e.amount INTO v_eval
              FROM promotion_evaluate(v_promo, v_subtotal, v_lines, v_customer, v_running, v_applied, p_at) AS e;
            status := v_eval.status;
            IF v_eval.status = 'applied' THEN
                discount_amount := v_eval.amount;
            END IF;
        END IF;
    END IF;

    RETURN NEXT;
END;
$init$;

COMMENT ON FUNCTION promotion_quote IS
    'What a cart''s automatic offers and typed code are worth, using the same rules and arithmetic the placement will. Read-only: no locks, no writes.';
