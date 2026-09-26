-- =============================================================================
-- V018 — what the storefront needs to be browsed
-- =============================================================================
-- Milestone 16 of docs/migration/04-implementation-plan.md.
--
-- `Shop` (390) and `StoreDesktop` (1440) are the same store at two widths, and between them they
-- render four things the schema could not yet answer. Each is added here with the board that asks
-- for it, because "the design draws it and no column holds it" is the only argument this file makes:
--
--   1. WHEN THE STORE IS OPEN. The mobile header reads "Open · closes 22:00" beside a green dot and
--      the desktop store-info panel reads "Daily 10:00-22:00". Nothing in `stores` knows an hour.
--
--   2. A PUBLIC PHONE NUMBER. StoreDesktop's panel makes it a `tel:` link. `users.phone` is a
--      person's; this is the shop's, and a shop's number outlives whoever is on the till.
--
--   3. WHAT COUNTS AS "FEW LEFT". Shop badges it, and the option sheet says "Only 2 left in size 43".
--      The legacy schema carried `products.low_stock_threshold` (default 5) and V003 did not, so
--      without this the ETL at milestone 29 has values and nowhere to put them — a merchant's own
--      setting would be lost quietly, which is the worst way to lose one.
--
--   4. A CART LINE THAT CANNOT BE ADDED TWICE. The board's own `addLine` merges: same product, same
--      options, quantity goes up. Doing that with a SELECT then an INSERT is a race a double-tapped
--      Add button wins often enough to be a support ticket, so it becomes ON CONFLICT DO UPDATE
--      against a real unique index — which needs the line's option set to be a value the index can
--      see. See section 4; it is the longest part of this file and the only clever one.
--
-- AND A SEARCH INDEX, which was going to be left out of this file until it was measured. See section 6:
-- the measurement changed both the index AND the meaning of a search.
--
-- ONE NEW SQLSTATE, VLCAT, joining V005's three. VLSTK/VLFND/VLHLD exist because server/src/db/errors.ts
-- passes their MESSAGE and HINT through to the customer, where a plain `RAISE EXCEPTION` lands as
-- SQLSTATE P0001 and is replaced by "That change was refused because it would leave the records
-- inconsistent." That sentence is right for a constraint a customer cannot see and wrong for the two
-- refusals below, which are ordinary and have something useful to say: the page has gone stale, and the
-- answer is to reload it. Found by calling the endpoint and reading what came back, not by review.
--
-- AND NO EXTENSION, for the reason V000 gives twice: gen_random_uuid() and lower() made uuid-ossp
-- and citext unnecessary, and every extension is a thing a managed provider may not allow. If search
-- ever needs more than btree, to_tsvector is in core and pg_trgm is not.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Opening hours
-- -----------------------------------------------------------------------------
-- A ROW PER OPEN DAY, not a pair of columns on `stores`, because the boards show both shapes: Nyama
-- is "Daily 10:00-22:00" and Inzu "closes 19:00", and a store that shuts on Sunday has to be able to
-- say so. A missing row IS closed — so a store with no rows at all is a store that never claims to be
-- open, which is the safe default for one that has not filled this in.
--
-- ISO DAY NUMBERS, 1 = Monday, matching V013's promotions.days_of_week and for the same reason it
-- gives: a weekend is contiguous in ISO and split in the 0-6-from-Sunday numbering.

CREATE TABLE store_hours (
    store_id    uuid     NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
    day_of_week smallint NOT NULL,

    opens_at    time     NOT NULL,

    -- PAST MIDNIGHT IS ALLOWED, and is what closes_at <= opens_at means: a grill open 18:00-01:00
    -- closes on Tuesday under Monday's row. The alternative — refusing it — would make every late
    -- kitchen unrepresentable, and the alternative to THAT, a separate boolean, would let the two
    -- disagree. store_open_state() below is the one reader that has to know, and it is where the rule
    -- is written down.
    closes_at   time     NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (store_id, day_of_week),

    CONSTRAINT store_hours_day_range CHECK (day_of_week BETWEEN 1 AND 7),

    -- Equal times are the one shape with no sensible reading: 10:00-10:00 is either a closed day,
    -- which is a missing row, or 24 hours, which is not what anybody typed.
    CONSTRAINT store_hours_not_instantaneous CHECK (closes_at <> opens_at)
);

COMMENT ON TABLE store_hours IS
    'When a store is open, one row per open day. A day with no row is closed. closes_at <= opens_at means it closes after midnight — see store_open_state().';
COMMENT ON COLUMN store_hours.closes_at IS
    'Earlier than or equal to opens_at means the next day: 18:00-01:00 is a Monday row that closes on Tuesday.';

CREATE TRIGGER store_hours_set_updated_at BEFORE UPDATE ON store_hours
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- The header's dot and its caption, from one rule.
--
-- ONE FUNCTION RATHER THAN TWO SCREENS' WORTH OF ARITHMETIC, for the reason V013's promotion_is_live
-- gives about its own window: three readers of one rule is three chances to disagree about whether
-- 22:00 is open. Both boards, and the merchant console later, read this.
--
-- It looks at TWO rows — today's and yesterday's — because yesterday's may still be running. That is
-- the whole subtlety: at 00:30 on Tuesday a shop whose Monday row is 18:00-01:00 is open, and its own
-- Tuesday row has not started.

CREATE FUNCTION store_open_state(p_store_id uuid, p_at timestamptz DEFAULT now())
    RETURNS TABLE (is_open boolean, closes_at time, opens_at time, opens_on smallint)
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_today     smallint := extract(isodow FROM p_at)::smallint;
    v_yesterday smallint := CASE WHEN v_today = 1 THEN 7 ELSE v_today - 1 END;
    v_now       time     := p_at::time;
    v_row       record;
BEGIN
    -- Yesterday first: a session that began yesterday and has not ended takes precedence over
    -- today's, which may not have begun. Only a past-midnight row can still be running.
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
        -- Half-open, like both of V013's windows: 10:00 is open and 22:00 is shut, so a store can
        -- abut its own next day without overlapping it.
        IF v_row.closes_at > v_row.opens_at THEN
            IF v_now >= v_row.opens_at AND v_now < v_row.closes_at THEN
                RETURN QUERY SELECT true, v_row.closes_at, v_row.opens_at, v_today;
                RETURN;
            END IF;
        ELSIF v_now >= v_row.opens_at THEN
            -- Past-midnight row, and we are in the evening half of it.
            RETURN QUERY SELECT true, v_row.closes_at, v_row.opens_at, v_today;
            RETURN;
        END IF;
    END IF;

    -- Shut. Say when it opens next, which is what "Closed · opens 10:00" needs. Seven days ahead at
    -- most; a store with no rows at all gets NULLs and the storefront says only "Closed".
    FOR i IN 0..6 LOOP
        SELECT h.opens_at,
               ((v_today + i - 1) % 7 + 1)::smallint AS day
          INTO v_row
          FROM store_hours h
         WHERE h.store_id = p_store_id
           AND h.day_of_week = ((v_today + i - 1) % 7 + 1)::smallint
           -- Today only counts if it has not already started; if it had, we would not be here.
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
    'Whether a store is open at a moment, when it closes, and when it next opens. Reads yesterday''s row as well as today''s, because a row that closes after midnight is still running.';


-- -----------------------------------------------------------------------------
-- 2. The shop's own phone number
-- -----------------------------------------------------------------------------
-- StoreDesktop makes it a tel: link. Nullable, because a store that has not given one simply shows
-- no link — and NOT validated beyond a length and a character set, deliberately: E.164, local
-- Rwandan formats and the spacing a merchant types are all things a customer can dial, and a regex
-- strict enough to be worth having would refuse a real number from the next country the platform
-- opens in (Part 9's multi-country question is open).

ALTER TABLE stores
    ADD COLUMN public_phone text;

ALTER TABLE stores
    ADD CONSTRAINT stores_public_phone_shape
        CHECK (public_phone IS NULL
               OR (btrim(public_phone) <> ''
                   AND char_length(public_phone) BETWEEN 6 AND 32
                   AND public_phone ~ '^[+0-9][0-9 ()./-]*$'));

COMMENT ON COLUMN stores.public_phone IS
    'The number shown on the storefront, as a tel: link. The shop''s, not a person''s — users.phone is that.';


-- -----------------------------------------------------------------------------
-- 3. What counts as running low
-- -----------------------------------------------------------------------------
-- Per product, as the legacy schema had it, because the number that means "nearly out" is different
-- for chapatis and for denim jackets. Zero — the default — means the badge never shows, so an
-- existing store's behaviour does not change until somebody sets one.
--
-- NO BOARD DRAWS THE EDITOR. `Products`' inline stock edit is still owed by the designer (Part 9), so
-- this is a column three screens READ and none yet writes, which is the same footing V013's
-- max_redemptions is on and is recorded here for the same reason.

ALTER TABLE products
    ADD COLUMN low_stock_threshold integer NOT NULL DEFAULT 0;

ALTER TABLE products
    ADD CONSTRAINT products_low_stock_threshold_not_negative
        CHECK (low_stock_threshold >= 0);

COMMENT ON COLUMN products.low_stock_threshold IS
    'At or below this many in stock, the storefront badges the product "Few left". Zero means never. Only meaningful when track_stock is true.';


-- -----------------------------------------------------------------------------
-- 4. A cart line that cannot be added twice
-- -----------------------------------------------------------------------------
-- Shop.dc.html's own addLine() builds a key out of the product and the chosen option labels, looks
-- for a line with that key, and either bumps its quantity or pushes a new one. That is the right
-- behaviour — two taps on Add is one customer wanting two — and the naive way to implement it is
-- SELECT then INSERT, which two concurrent requests both pass before either writes. A double-tapped
-- button on a slow connection is exactly two concurrent requests.
--
-- So the merge becomes ON CONFLICT DO UPDATE against a real unique index, which the database resolves
-- whatever the timing. The obstacle is that a line's identity includes its option set, and that lives
-- in a child table where no index can see it — so the set is ALSO stored on the line as a signature,
-- and the signature is what the index covers.
--
-- A DENORMALISED COLUMN IS A SECOND SOURCE OF TRUTH, which this project refuses everywhere else, so
-- it is held to the child rows by a deferred constraint trigger: at the end of any transaction that
-- touched either side, the signature must equal the set. It cannot drift, and the writer that would
-- have made it drift is refused rather than believed.
--
-- WHY NOT AN ADVISORY LOCK on the cart id, which is three lines instead of eighty? Because it is only
-- correct as long as every writer remembers to take it, and the next endpoint to touch cart_items —
-- milestone 17's quantity stepper, or a merchant-side edit — is written by somebody reading
-- cart_items, not this function. A unique index protects the table from writers it has never met.

ALTER TABLE cart_items
    ADD COLUMN option_signature text NOT NULL DEFAULT '';

COMMENT ON COLUMN cart_items.option_signature IS
    'The line''s "pick several" option value ids, sorted and comma-joined; empty for a line with none. Denormalised from cart_item_option_values so that "same product, same options" is a unique key the database can enforce, and held to it by cart_items_signature_agrees.';

-- THE POINT OF ALL OF THIS.
CREATE UNIQUE INDEX cart_items_one_line_per_choice
    ON cart_items (cart_id, variant_id, option_signature);

-- Adding to a line 2,000,000,000 times over would overflow the integer before any CHECK on the value
-- fired, and an overflow is a 500 where a bound is a sentence. 999 is past any real order and short of
-- arithmetic trouble; add_to_cart() refuses politely before it is reached.
ALTER TABLE cart_items
    ADD CONSTRAINT cart_items_quantity_bounded CHECK (quantity <= 999);


-- The signature and the child rows must say the same thing.
--
-- DEFERRED, because a correct writer inserts the line and then its options: between those two
-- statements the row is legitimately inconsistent, and an immediate trigger would refuse the only
-- sensible order to write them in. At COMMIT there is no such excuse.
CREATE FUNCTION cart_items_signature_matches() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_item      uuid;
    v_expected  text;
    v_stored    text;
BEGIN
    -- Fired from both tables, so find the line either way.
    --
    -- WRITTEN AS BRANCHES RATHER THAN ONE CASE EXPRESSION, and that is not a style preference:
    -- plpgsql resolves every field reference in an expression against the record it was handed, so a
    -- single CASE naming both NEW.id and NEW.cart_item_id fails at run time on whichever table fired
    -- it -- even though only one arm would have been taken. Found by a test that expected a different
    -- error entirely.
    IF TG_TABLE_NAME = 'cart_items' THEN
        -- Only INSERT and UPDATE fire for this table, so NEW is always assigned.
        v_item := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        v_item := OLD.cart_item_id;
    ELSE
        v_item := NEW.cart_item_id;
    END IF;

    SELECT option_signature INTO v_stored FROM cart_items WHERE id = v_item;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(string_agg(v.option_value_id::text, ',' ORDER BY v.option_value_id::text), '')
      INTO v_expected
      FROM cart_item_option_values v
     WHERE v.cart_item_id = v_item;

    IF v_expected IS DISTINCT FROM v_stored THEN
        RAISE EXCEPTION 'cart line % has signature % but options %', v_item, v_stored, v_expected
            USING HINT = 'option_signature is derived from cart_item_option_values. Write cart lines through add_to_cart().';
    END IF;

    RETURN NULL;
END;
$init$;

COMMENT ON FUNCTION cart_items_signature_matches IS
    'Holds cart_items.option_signature to the rows in cart_item_option_values. Deferred, so a writer may insert the line before its options.';

CREATE CONSTRAINT TRIGGER cart_items_signature_agrees
    AFTER INSERT OR UPDATE OF option_signature ON cart_items
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION cart_items_signature_matches();

CREATE CONSTRAINT TRIGGER cart_item_option_values_signature_agrees
    AFTER INSERT OR UPDATE OR DELETE ON cart_item_option_values
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION cart_items_signature_matches();


-- Add to a cart, atomically, merging with the line that is already there.
--
-- Returns the line and whether it was created, because the storefront says "Added Chicken Burger"
-- either way but milestone 17's cart screen will want to scroll to a new line and not to a bumped one.
--
-- WHAT IT REFUSES, and why each is here rather than only in the client: a customer can be handed a
-- disabled button and a script cannot. A variant from another store, a product that is a draft, a
-- withdrawn variant and a sold-out one are all refused at this boundary.
--
-- WHAT IT DOES NOT DO IS RESERVE STOCK. States.dc.html: "Prices are re-checked at checkout; any
-- change is shown before paying" — and so is availability. reserve_stock() (V005) runs when an order
-- is placed, holds the lock that makes overselling impossible, and is the only thing that may
-- decrement. A cart that reserved would let anybody empty a shop's shelves by filling carts.

CREATE FUNCTION add_to_cart(
    p_cart_id         uuid,
    p_variant_id      uuid,
    p_option_value_ids uuid[] DEFAULT '{}',
    p_quantity        integer DEFAULT 1
) RETURNS TABLE (cart_item_id uuid, quantity integer, created boolean)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store      uuid;
    v_product    uuid;
    v_name       text;
    v_tracked    boolean;
    v_stock      integer;
    v_available  boolean;
    v_status     text;
    v_ids        uuid[];
    v_signature  text;
    v_bad        text;
    v_item       uuid;
    v_qty        integer;
    v_created    boolean;
BEGIN
    IF p_quantity IS NULL OR p_quantity < 1 THEN
        RAISE EXCEPTION 'quantity must be at least 1, got %', p_quantity;
    END IF;

    SELECT c.store_id INTO v_store FROM carts c WHERE c.id = p_cart_id AND c.expires_at > now();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That cart has expired.'
            USING ERRCODE = 'VLCAT',
                  HINT = 'A cart is kept for seven days. Add what you want again.',
                  -- The id goes in DETAIL rather than the message: a customer reads the message, and a
                  -- uuid in it tells them nothing while telling anybody watching that the id was real.
                  DETAIL = 'cart ' || p_cart_id;
    END IF;

    -- The variant, its product, and everything that decides whether it can be bought. One read, and
    -- it is scoped to the cart's store — so a variant id from another shop is simply not found, which
    -- is the same answer as one that does not exist.
    SELECT v.product_id, p.name, p.track_stock, v.stock_quantity, v.is_available, p.status
      INTO v_product, v_name, v_tracked, v_stock, v_available, v_status
      FROM product_variants v
      JOIN products p ON p.id = v.product_id AND p.store_id = v.store_id
     WHERE v.id = p_variant_id AND v.store_id = v_store;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That is not on sale here any more.'
            USING ERRCODE = 'VLCAT',
                  HINT = 'The store may have changed its catalogue. Reload the page.',
                  DETAIL = 'variant ' || p_variant_id || ' is not sold by store ' || v_store;
    END IF;

    IF v_status <> 'active' THEN
        RAISE EXCEPTION '% is not on sale', v_name
            USING ERRCODE = 'VLSTK',
                  HINT = 'The store has taken this off its storefront.';
    END IF;

    IF NOT v_available THEN
        RAISE EXCEPTION '% is sold out', v_name
            USING ERRCODE = 'VLSTK',
                  HINT = 'Ask the store when it is back.';
    END IF;

    IF v_tracked AND COALESCE(v_stock, 0) < 1 THEN
        RAISE EXCEPTION '% is sold out', v_name
            USING ERRCODE = 'VLSTK',
                  HINT = 'Ask the store when it is back.';
    END IF;

    IF p_quantity > 999 THEN
        RAISE EXCEPTION 'a single line cannot hold more than 999 of %', v_name
            USING HINT = 'Place a second order, or ask the store directly.';
    END IF;

    -- The option values, deduplicated and sorted so that Cheese+Sauce and Sauce+Cheese are one line.
    SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids
      FROM unnest(COALESCE(p_option_value_ids, '{}'::uuid[])) AS x;
    v_ids := COALESCE(v_ids, '{}'::uuid[]);

    -- EVERY ID MUST BE A "PICK SEVERAL" VALUE OF A GROUP THIS PRODUCT OFFERS. V003: the single-select
    -- choices ARE the variant, so repeating one here would be storing the same choice twice and the
    -- price would count it twice. Named individually in the error, because "invalid options" sends a
    -- developer looking through all of them.
    SELECT string_agg(missing::text, ', ') INTO v_bad
      FROM unnest(v_ids) AS missing
     WHERE NOT EXISTS (
        SELECT 1
          FROM option_values ov
          JOIN option_groups g ON g.id = ov.option_group_id
          JOIN product_option_groups pog
            ON pog.option_group_id = g.id AND pog.product_id = v_product
         WHERE ov.id = missing
           AND ov.store_id = v_store
           AND g.select_mode = 'several'
           AND ov.is_available
     );
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'Those extras are not available for %.', v_name
            USING ERRCODE = 'VLCAT',
                  HINT = 'The store may have changed its options. Reload the page.',
                  -- Named individually, in DETAIL, because "invalid options" sends a developer looking
                  -- through all of them. A customer never sees this half.
                  DETAIL = 'not a pick-several value of this product: ' || v_bad;
    END IF;

    v_signature := COALESCE(array_to_string(v_ids, ','), '');

    -- THE ATOMIC PART. Two concurrent adds of the same choice: one inserts, the other takes the
    -- update branch and adds to it. Neither reads before writing, so there is no window between.
    --
    -- xmax = 0 distinguishes the branches. It is the documented way to ask ON CONFLICT which one ran,
    -- and the reason it is needed is below.
    INSERT INTO cart_items (cart_id, variant_id, store_id, quantity, option_signature)
         VALUES (p_cart_id, p_variant_id, v_store, p_quantity, v_signature)
    ON CONFLICT (cart_id, variant_id, option_signature) DO UPDATE
       SET quantity = LEAST(cart_items.quantity + excluded.quantity, 999)
      RETURNING cart_items.id, cart_items.quantity, (xmax = 0) INTO v_item, v_qty, v_created;

    -- Only the insert writes the child rows: on the update branch they are already there, and writing
    -- them again would raise on the primary key. This is why the branch has to be known.
    IF v_created THEN
        INSERT INTO cart_item_option_values (cart_item_id, option_value_id, cart_id)
        SELECT v_item, x, p_cart_id FROM unnest(v_ids) AS x;
    END IF;

    -- A touched cart has not expired. Its seven days run from the last change, which is what "kept for
    -- 7 days" means to somebody who came back on day six and added something.
    UPDATE carts SET expires_at = now() + interval '7 days' WHERE id = p_cart_id;

    RETURN QUERY SELECT v_item, v_qty, v_created;
END;
$init$;

COMMENT ON FUNCTION add_to_cart IS
    'Adds a variant to a cart, merging with an identical line atomically through cart_items_one_line_per_choice. Refuses a draft, withdrawn or sold-out variant and anything that is not one of the product''s own priced extras. Reserves no stock: that is reserve_stock() at checkout.';


-- -----------------------------------------------------------------------------
-- 5. Indexes for the three reads this milestone adds
-- -----------------------------------------------------------------------------
-- MEASURED, NOT REASONED ABOUT. Milestones 11 and 15 each produced a wrong index theory that survived
-- until somebody ran EXPLAIN: the first blamed an OR for hiding a cursor when the index was missing a
-- tie-break column, and the second split a lookup into a UNION to avoid an OR that turned out to be
-- both simpler and faster. The numbers behind each index here are in the milestone-16 row of
-- docs/migration/04-implementation-plan.md and in the repository that issues the query.
--
-- (a) THE PRODUCT PAGE'S REVIEW LIST, by keyset. reviews_product_idx was (product_id, created_at DESC),
--     and the third column is what V014 had to add to the payout cursor for the same reason: a tie group
--     under a cursor is filtered after the fact instead of being sought. Reviews tie more readily than
--     payouts, because a burst of them shares a second.
--
--     MEASURED on 40,000 reviews of one product all sharing one created_at:
--
--                                       2 columns              3 columns
--       page 1                          803 buffers, 36.9 ms   22 buffers, 0.066 ms
--       a page inside the tie group      770 buffers, 16.1 ms   23 buffers, 0.064 ms
--
--     Page ONE is the surprise, and it is the stronger argument: ORDER BY (created_at DESC, id DESC)
--     cannot be answered by a two-column index at all, so even the first page read every one of the
--     40,002 rows and sorted them. The deep page removed 14,915 rows by filter. With the id in the index
--     both are seeks — and the index becomes index-ONLY, which is where most of the 35x comes from.
DROP INDEX reviews_product_idx;

CREATE INDEX reviews_product_keyset_idx
    ON reviews (product_id, created_at DESC, id DESC) WHERE hidden_at IS NULL;

COMMENT ON INDEX reviews_product_keyset_idx IS
    'The product page, newest first, visible only, by keyset. The id is the tie-break: without it a page inside a group of reviews sharing a timestamp is a filter rather than a seek — V014''s lesson, applied before it bit.';

-- (b) ONE SECTION'S PRODUCTS, by keyset. product_categories_category_idx is (category_id, position),
--     and the cursor is (position, product_id) — so product_id is added for the same tie-break reason,
--     and because it then covers the join and the section list is an index-only scan.
DROP INDEX product_categories_category_idx;

CREATE INDEX product_categories_category_keyset_idx
    ON product_categories (category_id, position, product_id);

COMMENT ON INDEX product_categories_category_keyset_idx IS
    'One section''s products in the merchant''s order, by keyset, without touching the heap.';

-- The measurement that made this index a seek rather than a scan is not about the index at all: the
-- cursor first compared (pc.position, p.id), one column from each table, which no single index can
-- answer — so it was applied as a FILTER after joining, at 2,658 buffers / 2.78 ms for one page.
-- pc.product_id holds the same value as p.id and lives in this index, and comparing
-- (pc.position, pc.product_id) instead makes the same page 89 buffers / 0.13 ms. Thirty times fewer
-- buffers for a one-word change, and the index was already right. Recorded here because the index
-- looks unused if the query is written the first way, and somebody would eventually drop it.


-- -----------------------------------------------------------------------------
-- 6. Search, and what measuring it changed
-- -----------------------------------------------------------------------------
-- Shop.dc.html filters on the product name, as a substring, case-insensitively — `p.name.includes(q)`
-- in its own JavaScript. The obvious translation is `name ILIKE '%term%'`, and it works, and on a
-- catalogue of any size it cannot use an index: a leading wildcard has no prefix to seek to.
--
-- ON 50,000 PRODUCTS IN ONE STORE, a search matching NOTHING cost 1,632 buffers and 42 ms on a
-- sequential scan of the whole table. That is the shape that matters, because it is unauthenticated,
-- it is cheap to repeat, and a shopper mistyping one letter produces it.
--
-- THE FIRST FIX DID NOT WORK, AND MEASURING IS THE ONLY REASON THAT IS KNOWN. A GIN index on
-- to_tsvector was added and the planner IGNORED it: with ORDER BY position LIMIT 25 it still preferred
-- to walk the position index and filter, and the empty search got WORSE — 1,283 buffers and 86 ms,
-- because to_tsvector costs more per row than ILIKE. An index added on the strength of the argument
-- alone would have been dead weight that looked like diligence. (Third time in this project: milestone
-- 11's payout cursor and milestone 15's sign-in lookup were the first two.)
--
-- WHAT WORKS is forcing the text index to run before the ordering, with a MATERIALIZED CTE — see
-- listProducts() in server/src/repositories/catalogue.ts, which is written that way for this reason and
-- says so. Then:
--
--     a search matching nothing      3 buffers, 0.045 ms   (from 1,632 / 42 ms)
--     a common word, 2,500 matches   882 buffers, 3.05 ms
--     one match in 50,000            7 buffers, 0.269 ms
--
-- THE COST IS THAT SEARCH NO LONGER MEANS SUBSTRING. It means word prefix: "milk" finds "Fresh Milk"
-- and "mil" finds it too, but "ilk" now finds nothing where ILIKE found 2,500. That is a deliberate
-- change to what the board's mock did, and the argument for it is that nobody searches for the middle
-- of a word — while "Try a shorter word", which is the board's OWN empty-state copy, is advice that
-- only makes sense if shortening helps, and under prefix matching it does.
--
-- THE 'simple' CONFIGURATION, not 'english': no stemming and no stop words. A store selling "A2 Milk"
-- must not have its "A2" discarded as a stop word, and a merchant in Kigali naming things in
-- Kinyarwanda gets nothing from an English stemmer. 'simple' folds case and splits on word boundaries,
-- which is all this needs.
--
-- IMMUTABLE BECAUSE THE CONFIGURATION IS A LITERAL. to_tsvector(regconfig, text) is immutable;
-- to_tsvector(text) is not, because it reads default_text_search_config. Naming 'simple' explicitly is
-- what makes this indexable at all.

CREATE INDEX products_name_search_idx ON products USING gin (to_tsvector('simple', name));

COMMENT ON INDEX products_name_search_idx IS
    'Storefront search over product names, by word prefix. Only reachable through a query that materialises the match set before ordering — see the note above and listProducts().';


-- -----------------------------------------------------------------------------
-- Recorded rather than invented
-- -----------------------------------------------------------------------------
-- 1. NO EDITOR EXISTS FOR OPENING HOURS OR THE PUBLIC PHONE NUMBER. `Settings`' Store details panel is
--    one of the things Part 9 still owes the designer. Both boards RENDER these, which is what makes
--    the shape safe to fix now — the columns are exactly what "Open · closes 22:00" and a tel: link
--    need and nothing more. When the panel is drawn it may want a note ("Closed on public holidays"),
--    and that is an ALTER.
--
-- 2. THE "FEW LEFT" THRESHOLD IS PER PRODUCT AND NOT PER VARIANT, although the sheet's copy is
--    per-variant: "Only 2 left in size 43". One threshold compared against each variant's own count
--    produces exactly that sentence, and a threshold per variant would ask a merchant to set twelve
--    numbers for one linen tee.
--
-- 3. THE SIGNATURE IS IDS, NOT LABELS, unlike the board's own key, which joins the labels. Two groups
--    may both offer "Regular", and a merchant renaming "Extra cheese" to "Cheese" must not merge a
--    customer's two lines underneath them.
--
-- 4. A CART IS NOT A HOLD ON STOCK, and section 4 says why at length. The consequence to be aware of
--    is that a cart can contain something that sells out before checkout, which is a state
--    States.dc.html draws ("Sold out while you were choosing") and milestone 17 has to render.
