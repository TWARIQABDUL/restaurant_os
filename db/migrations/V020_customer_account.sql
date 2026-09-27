-- =============================================================================
-- V020 — the customer's own account
-- =============================================================================
-- Milestone 18 of docs/migration/04-implementation-plan.md.
--
-- `CustomerAccount` draws five screens and three of them need something the schema does not have yet:
--
--   1. SAVED ADDRESSES. "Deliver to" offers Home and Office with a radio between them, the account screen
--      says "Saved addresses 2", and checkout is meant to use them instead of asking again. There is no
--      table.
--   2. A CART THAT SURVIVES SIGNING IN. The sign-in sheet promises it in as many words: "Your cart (3 items)
--      stays exactly as it is." A signed-in customer's cart follows the account and an anonymous one follows
--      a cookie (V003), so signing in mid-checkout means MERGING one into the other. Milestone 17 left this
--      deliberately, because this is the milestone where the board draws it.
--   3. REORDERING. "Order this again", and the board is precise about the interesting case: "Added 1 of 2
--      items. Fries are sold out today." It adds what it can and says what it could not.
--
-- AND ONE MORE THE BOARD DRAWS AND NOBODY WOULD GUESS FROM THE TABLES: a guest who has just ordered is
-- offered an account — "Add a password and this order, your address and phone are saved to an account at
-- Nyama & Co." That is not an INSERT, it is a MOVE: `orders_has_a_customer` requires exactly one of a
-- customer or a guest, so the order stops being a guest order in the same statement it becomes theirs.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Saved addresses
-- -----------------------------------------------------------------------------
-- NO store_id COLUMN, which breaks this file's habit and is right here: V001 made a customer belong to
-- exactly ONE store — `scope = 'store'` with a store_id, and "This account is only for Nyama & Co." is on the
-- board itself. So an address's store is its owner's store, and carrying a copy would be a second answer to
-- a question that already has one. Every other table in this schema carries store_id because its rows can
-- belong to any store; these cannot.
--
-- FREE TEXT, NOT STRUCTURE. The board's addresses are "KG 541 St, house 12, Kacyiru" and "KN 5 Rd, Remera,
-- 3rd floor" — one line each, as somebody would say it to a rider. Kigali has no postcodes and the delivery
-- zone is chosen separately (V007's named areas), so splitting this into street/city/district would be
-- inventing fields the design does not use and the rider does not read.

CREATE TABLE customer_addresses (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- "Home", "Office". The board shows it as the bold line above the address.
    label      text        NOT NULL,
    address    text        NOT NULL,

    -- Which one checkout offers first. At most one per customer — see the partial index.
    is_default boolean     NOT NULL DEFAULT false,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT customer_addresses_label_present CHECK (btrim(label) <> ''),
    CONSTRAINT customer_addresses_address_present CHECK (btrim(address) <> ''),
    -- Long enough for a landmark and a floor, short of an essay.
    CONSTRAINT customer_addresses_address_length CHECK (char_length(address) BETWEEN 4 AND 500),
    CONSTRAINT customer_addresses_label_length CHECK (char_length(label) <= 40)
);

COMMENT ON TABLE customer_addresses IS
    'A customer''s saved delivery addresses. No store_id: V001 makes a customer belong to exactly one store, so an address''s store is its owner''s.';

-- One "Home" per customer, case-insensitively: two addresses both called Home is a list the board cannot
-- render usefully.
CREATE UNIQUE INDEX customer_addresses_user_label_key
    ON customer_addresses (user_id, lower(btrim(label)));

-- At most one default. Not "should be" — cannot.
CREATE UNIQUE INDEX customer_addresses_one_default_per_user
    ON customer_addresses (user_id) WHERE is_default;

-- Serves: the checkout's address list and the account screen's count, in a stable order.
CREATE INDEX customer_addresses_user_idx ON customer_addresses (user_id, created_at);

CREATE TRIGGER customer_addresses_set_updated_at BEFORE UPDATE ON customer_addresses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Only a CUSTOMER may own an address, and a customer is `scope = 'store'`. A platform identity — merchant
-- staff, the Vendlyfy team — has no shopfront to be delivered to, and an address on one would be a row no
-- screen could ever show.
CREATE FUNCTION customer_addresses_owner_is_customer() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_scope text;
BEGIN
    SELECT scope INTO v_scope FROM users WHERE id = NEW.user_id;
    IF v_scope IS DISTINCT FROM 'store' THEN
        RAISE EXCEPTION 'only a store customer can save an address (user % is %)', NEW.user_id, COALESCE(v_scope, 'missing')
            USING HINT = 'Staff and the Vendlyfy team have no shopfront to be delivered to.';
    END IF;
    RETURN NEW;
END;
$init$;

CREATE TRIGGER customer_addresses_owner_is_customer
    BEFORE INSERT OR UPDATE OF user_id ON customer_addresses
    FOR EACH ROW EXECUTE FUNCTION customer_addresses_owner_is_customer();


-- Making one the default un-defaults the others, in one statement, because the partial unique index above
-- would otherwise refuse the second write and the caller would have to clear-then-set — two statements with
-- a moment in between where the customer has no default at all.
CREATE FUNCTION set_default_address(p_user_id uuid, p_address_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM customer_addresses WHERE id = p_address_id AND user_id = p_user_id) THEN
        RAISE EXCEPTION 'address % does not belong to user %', p_address_id, p_user_id;
    END IF;

    -- One UPDATE over the customer's rows: the one named becomes true and every other becomes false, so the
    -- index never sees two.
    UPDATE customer_addresses
       SET is_default = (id = p_address_id)
     WHERE user_id = p_user_id
       AND is_default <> (id = p_address_id);
END;
$init$;

COMMENT ON FUNCTION set_default_address IS
    'Makes one of a customer''s addresses the default and clears the rest, in a single statement so customer_addresses_one_default_per_user never sees two.';


-- -----------------------------------------------------------------------------
-- 2. The cart survives signing in
-- -----------------------------------------------------------------------------
-- The sign-in sheet says it outright: "Your cart (3 items) stays exactly as it is." A signed-in customer's
-- cart follows the account and an anonymous one follows a cookie (V003's `carts_one_owner`), so signing in
-- halfway through checkout is a MERGE — and it is the one operation in this file that a customer can lose
-- money to if it is wrong.
--
-- THREE CASES, and only the third is interesting:
--
--   the account has no cart     the anonymous cart simply becomes theirs. One UPDATE.
--   the anonymous cart is empty nothing to do.
--   BOTH HAVE ONE                every line has to land in the account's cart, and a line that is already
--                                there has to have its quantity ADDED rather than replaced or duplicated.
--
-- THE THIRD CASE IS V018'S UNIQUE INDEX DOING THE WORK. `cart_items_one_line_per_choice` covers
-- (cart_id, variant_id, option_signature), so moving a line is an INSERT ... ON CONFLICT DO UPDATE that adds
-- the quantities — exactly what add_to_cart() does for one line, applied to all of them. Two burgers with
-- cheese in the anonymous cart and one in the account's becomes three, not two lines of a burger.
--
-- AND IT KEEPS THE ACCOUNT'S CART, not the anonymous one, which matters for the cookie: after this the
-- anonymous cart is gone and the shopper's cookie points at nothing. That is correct — they are signed in
-- now, and their cart follows the account from here.

CREATE FUNCTION merge_cart_into_account(
    p_store_id             uuid,
    p_user_id              uuid,
    p_anonymous_session_id text
) RETURNS TABLE (merged_cart_id uuid, lines_moved integer, quantity_merged integer)
    -- NOT named `cart_id`, and that is not a style choice: a plpgsql OUT parameter shadows a column of the
    -- same name, so `WHERE cart_id = v_anon` against cart_items raises "column reference is ambiguous" at run
    -- time rather than at CREATE time. Found by calling it. Every read below is qualified as well, so the
    -- next person to add an OUT parameter here cannot reintroduce it quietly.
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_anon    uuid;
    v_account uuid;
    v_moved   integer := 0;
    v_merged  integer := 0;
    r         record;
    v_created boolean;
BEGIN
    lines_moved := 0;
    quantity_merged := 0;

    -- Both carts are locked before anything moves, ALWAYS IN THE SAME ORDER — anonymous, then account — so
    -- two sign-ins racing on the same pair cannot deadlock. Same rule as reserve_stock()'s single lock order.
    SELECT c.id INTO v_anon FROM carts c
     WHERE c.store_id = p_store_id AND c.anonymous_session_id = p_anonymous_session_id AND c.expires_at > now()
       FOR UPDATE;

    SELECT c.id INTO v_account FROM carts c
     WHERE c.store_id = p_store_id AND c.user_id = p_user_id AND c.expires_at > now()
       FOR UPDATE;

    -- Nothing anonymous to merge: whatever the account has is what they keep.
    IF v_anon IS NULL THEN
        RETURN QUERY SELECT v_account, 0, 0;
        RETURN;
    END IF;

    -- The account has no cart, so the anonymous one becomes theirs whole. Cheaper than moving lines, and it
    -- keeps their created_at — which is what "stays exactly as it is" means most literally.
    IF v_account IS NULL THEN
        UPDATE carts
           SET user_id = p_user_id,
               anonymous_session_id = NULL,
               expires_at = now() + interval '7 days'
         WHERE carts.id = v_anon;
        SELECT count(*)::integer INTO v_moved FROM cart_items i WHERE i.cart_id = v_anon;
        RETURN QUERY SELECT v_anon, v_moved, 0;
        RETURN;
    END IF;

    -- Both exist. Move line by line, adding quantities where the same choice is already there.
    FOR r IN SELECT i.* FROM cart_items i WHERE i.cart_id = v_anon LOOP
        INSERT INTO cart_items (cart_id, variant_id, store_id, quantity, option_signature)
             VALUES (v_account, r.variant_id, r.store_id, r.quantity, r.option_signature)
        ON CONFLICT (cart_id, variant_id, option_signature) DO UPDATE
                SET quantity = LEAST(cart_items.quantity + excluded.quantity, 999)
          RETURNING (xmax = 0) INTO v_created;

        IF v_created THEN
            -- A new line in the account's cart needs its option rows too, or V018's signature trigger will
            -- refuse the whole transaction at commit — which is the check doing its job.
            INSERT INTO cart_item_option_values (cart_item_id, option_value_id, cart_id)
            SELECT (SELECT i.id FROM cart_items i
                     WHERE i.cart_id = v_account AND i.variant_id = r.variant_id
                       AND i.option_signature = r.option_signature),
                   v.option_value_id, v_account
              FROM cart_item_option_values v WHERE v.cart_item_id = r.id;
            v_moved := v_moved + 1;
        ELSE
            v_merged := v_merged + 1;
        END IF;
    END LOOP;

    UPDATE carts SET expires_at = now() + interval '7 days' WHERE carts.id = v_account;

    -- The anonymous cart goes, and its lines with it. Leaving it would mean signing out produced a cart from
    -- before signing in, which is a different promise from the one the board makes.
    DELETE FROM carts WHERE carts.id = v_anon;

    RETURN QUERY SELECT v_account, v_moved, v_merged;
END;
$init$;

COMMENT ON FUNCTION merge_cart_into_account IS
    'Moves an anonymous cart into a signed-in customer''s, adding quantities where the same product-and-options line is already there. What "your cart stays exactly as it is" means when both carts exist.';


-- -----------------------------------------------------------------------------
-- 3. Ordering it again
-- -----------------------------------------------------------------------------
-- "Order this again", and the board is exact about the case that matters: "Added 1 of 2 items. Fries are
-- sold out today." So this adds what it can, skips what it cannot, and RETURNS BOTH COUNTS plus the names of
-- what it skipped — because a screen that says "added" when it added half is a screen that lies.
--
-- AT TODAY'S PRICES, which the board also says: "Added 2 items from #0951 to your cart at today's prices."
-- A cart stores no price (V003), so this is automatic — but it is the reason reordering is safe at all. The
-- old order's captured prices stay on the old order, where they belong as a receipt.
--
-- IT REUSES add_to_cart() rather than inserting, so a reorder merges with what is already in the cart, is
-- refused for the same reasons an ordinary add is, and cannot produce a line shape add_to_cart() would not.

CREATE FUNCTION reorder_into_cart(p_cart_id uuid, p_order_id uuid)
    RETURNS TABLE (added integer, skipped integer, skipped_names text[])
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_cart_store  uuid;
    v_order_store uuid;
    r             record;
    v_options     uuid[];
BEGIN
    added := 0;
    skipped := 0;
    skipped_names := '{}';

    SELECT store_id INTO v_cart_store FROM carts WHERE id = p_cart_id AND expires_at > now();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That cart has expired.'
            USING ERRCODE = 'VLCAT', HINT = 'Open the shop again and it will start a new one.';
    END IF;

    SELECT store_id INTO v_order_store FROM orders WHERE id = p_order_id;
    IF NOT FOUND OR v_order_store <> v_cart_store THEN
        -- The same answer for "no such order" and "another store's order", for the reason every storefront
        -- read gives: distinguishing them is a way to enumerate what exists.
        RAISE EXCEPTION 'That order is not from this store.'
            USING ERRCODE = 'VLCAT', HINT = 'Open the order again from your account.';
    END IF;

    FOR r IN
        SELECT i.id, i.variant_id, i.quantity, i.product_name
          FROM order_items i
         WHERE i.order_id = p_order_id
         ORDER BY i.created_at, i.id
    LOOP
        -- The line's priced extras, by id. A value the merchant has since deleted cannot be re-added, and
        -- the line is skipped rather than quietly added without it — a burger without the cheese they paid
        -- for last time is not the thing they asked to order again.
        SELECT array_agg(v.option_value_id) INTO v_options
          FROM order_item_option_values v
          JOIN option_values ov ON ov.id = v.option_value_id
         WHERE v.order_item_id = r.id;

        IF EXISTS (
            SELECT 1 FROM order_item_option_values v
             WHERE v.order_item_id = r.id
               AND NOT EXISTS (SELECT 1 FROM option_values ov WHERE ov.id = v.option_value_id AND ov.is_available)
        ) THEN
            skipped := skipped + 1;
            skipped_names := skipped_names || r.product_name;
            CONTINUE;
        END IF;

        BEGIN
            PERFORM add_to_cart(p_cart_id, r.variant_id, COALESCE(v_options, '{}'::uuid[]), r.quantity);
            added := added + 1;
        EXCEPTION
            -- Sold out, withdrawn, a draft again, or an option the product no longer offers. Every one of
            -- those is "you cannot have this today", which is exactly what the board's message says — so they
            -- are counted rather than raised, and the raise is left for something unexpected.
            WHEN SQLSTATE 'VLSTK' OR SQLSTATE 'VLCAT' THEN
                skipped := skipped + 1;
                skipped_names := skipped_names || r.product_name;
        END;
    END LOOP;

    RETURN NEXT;
END;
$init$;

COMMENT ON FUNCTION reorder_into_cart IS
    'Adds an old order''s lines to a cart at today''s prices, skipping what can no longer be bought and naming it. "Added 1 of 2 items. Fries are sold out today." Goes through add_to_cart(), so a reorder merges and is refused on the same terms as any other add.';


-- -----------------------------------------------------------------------------
-- 4. A guest becomes a customer, and keeps the order they just placed
-- -----------------------------------------------------------------------------
-- "Add a password and this order, your address and phone are saved to an account at Nyama & Co."
--
-- THIS IS A MOVE, NOT AN UPDATE. `orders_has_a_customer` requires EXACTLY one of a customer or a guest —
-- customer_user_id with no guest fields, or guest fields with no customer — so the order stops being a guest
-- order in the same statement it becomes theirs. Two statements would leave a row with both, which the CHECK
-- refuses, and rightly: an order belonging to an account AND to a name typed at a keyboard is an order with
-- two customers.
--
-- WHAT IS LOST is the typed name and phone on the order, and that is the point of the offer rather than a
-- cost of it: they are on the account now, where they can be corrected. The delivery address stays on the
-- order because it is part of what was agreed, and is COPIED to the account as a saved address because that
-- is what the board promises.
--
-- THE ORDER IS NAMED BY THE CALLER, which means the endpoint must have proved the caller holds it. The
-- tracking code is that proof — 32 random characters, the only thing a guest was given. Without it this
-- function would let anybody claim any guest order by id.

CREATE FUNCTION claim_guest_order(
    p_order_id uuid,
    p_user_id  uuid,
    p_label    text DEFAULT 'Home'
) RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store   uuid;
    v_guest   text;
    v_address text;
    v_user_store uuid;
    v_scope   text;
BEGIN
    SELECT store_id, guest_name, delivery_address, customer_user_id
      INTO v_store, v_guest, v_address, v_user_store
      FROM orders WHERE id = p_order_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'order % does not exist', p_order_id;
    END IF;

    -- Already somebody's. Not an error worth showing: the button was pressed twice, or the page was
    -- reloaded, and the answer either way is that the order is on an account.
    IF v_user_store IS NOT NULL THEN
        RETURN;
    END IF;

    SELECT scope, store_id INTO v_scope, v_user_store FROM users WHERE id = p_user_id;
    IF v_scope IS DISTINCT FROM 'store' OR v_user_store IS DISTINCT FROM v_store THEN
        RAISE EXCEPTION 'user % is not a customer of the store that took order %', p_user_id, p_order_id
            USING HINT = 'A customer account belongs to one store, and so does the order.';
    END IF;

    -- One statement, so the CHECK is satisfied at every instant it is evaluated.
    UPDATE orders
       SET customer_user_id = p_user_id,
           guest_name = NULL,
           guest_phone = NULL,
           guest_email = NULL
     WHERE id = p_order_id;

    -- And the address they typed becomes a saved one, which is the rest of what the board offered. Skipped
    -- when there is none (a pickup order) or when the label is taken — the customer can rename it later, and
    -- failing the whole conversion over a duplicate label would be absurd.
    IF v_address IS NOT NULL AND btrim(v_address) <> '' THEN
        INSERT INTO customer_addresses (user_id, label, address, is_default)
             VALUES (p_user_id, p_label, v_address, true)
        ON CONFLICT (user_id, lower(btrim(label))) DO NOTHING;
    END IF;
END;
$init$;

COMMENT ON FUNCTION claim_guest_order IS
    'Moves a guest order onto a new customer account and saves its delivery address. One UPDATE, because orders_has_a_customer allows a customer or a guest and never both. Idempotent: an order already on an account is left alone.';
