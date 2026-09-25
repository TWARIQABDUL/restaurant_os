-- V013_promotions.sql
--
-- Milestone 9, eighth and last part. Promo codes, automatic promotions, and the
-- one thing that has to be true of every discount.
--
-- Promotions appear across four boards and no board owns them, so the rules are
-- assembled from what each one shows:
--
--   * Shop's cart has a "Promo code" field, uppercased as you type, with an Apply
--     button beside it. A good code answers "WELCOME10 applied · 10% OFF YOUR
--     ITEMS", and its arithmetic is in the board's own code:
--     `round(subtotal * 0.1)` — of the SUBTOTAL, never of the delivery fee.
--   * States has two failures, and they are DIFFERENT failures: "That code doesn't
--     exist" and "FRIDAY20 ended yesterday · your total went back to 9,500 RWF".
--     A customer who mistyped and a customer who is a day late need different
--     sentences, so applying a code returns a REASON rather than raising.
--   * Shop's home banner is an AUTOMATIC promotion: "Two burgers, free fries ·
--     Weekdays 12:00–15:00. Added automatically at checkout." So a promotion can
--     have no code at all, can require buying something, can give something away,
--     and can be live only on certain days between certain hours.
--   * Customize has "Promotion banner" as a homepage section a merchant can switch
--     off — so the banner's words belong to the promotion, not to the theme.
--
-- THE POINT OF THIS MIGRATION, though, is not promotions. It is that
-- `orders.discount_amount` has been a plain column since V004, and a plain column
-- is a number somebody can choose. V004 made total_amount GENERATED and checked the
-- subtotal against the lines precisely so that neither could be invented — and left
-- this one gap, because there was nothing to fill it with yet.
--
-- `order_discounts` fills it. Every reduction of an order is a row that says where
-- it came from, and a deferred constraint requires the column to equal their sum. A
-- checkout that posts `discount_amount: 9500` with nothing behind it no longer
-- commits. It also gives §5.3's third delta a home: a cash shortfall that turns out
-- to be "the customer genuinely paid less" is recorded AS A DISCOUNT on the order,
-- and that is a manual row in the same table.


-- =============================================================================
-- 1. promotions
-- =============================================================================

CREATE TABLE promotions (
    id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id               uuid          NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    -- 'code' is typed in by the customer; 'automatic' is "added automatically at
    -- checkout" and has no code to type.
    kind                   text          NOT NULL,
    code                   text,

    discount_type          text          NOT NULL,

    -- Exactly one of these three carries the discount, decided by discount_type.
    percent_off            numeric(5,2),
    amount_off             numeric(12,2),
    free_product_id        uuid,

    -- "Two burgers, free fries": buy min_quantity of required_product, get
    -- free_product. The requirement is optional on the other two types.
    required_product_id    uuid,
    min_quantity           integer,
    min_subtotal_amount    numeric(12,2),

    -- The banner's own words, because Customize treats the banner as content and
    -- Shop renders these two lines verbatim.
    banner_title           text,
    banner_subtitle        text,

    -- The window. "ended yesterday" is the state States draws, so ends_at is what
    -- separates a code that is late from a code that never existed.
    starts_at              timestamptz,
    ends_at                timestamptz,

    -- "Weekdays 12:00–15:00". ISO day numbers, 1 = Monday, so weekdays are {1..5}
    -- and a weekend promotion is {6,7} — which is why ISO and not 0-6 from Sunday:
    -- a weekend is contiguous in ISO and split in the other.
    days_of_week           smallint[]     NOT NULL DEFAULT '{}',
    time_from              time,
    time_to                time,

    -- NOT DRAWN BY ANY BOARD, and added anyway with a reason: a promo code with no
    -- cap is an unbounded liability against a merchant's own money, and the first
    -- time one is shared in a WhatsApp group that becomes real. NULL means no limit,
    -- so the default behaviour is exactly what the boards show.
    max_redemptions              integer,
    max_redemptions_per_customer integer,

    is_active              boolean       NOT NULL DEFAULT true,

    created_by             uuid,
    created_at             timestamptz   NOT NULL DEFAULT now(),
    updated_at             timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT promotions_kind_values CHECK (kind IN ('code', 'automatic')),

    -- A code promotion has a code; an automatic one cannot have one, or a customer
    -- could type in something that was meant to apply by itself.
    CONSTRAINT promotions_code_matches_kind
        CHECK ((kind = 'code') = (code IS NOT NULL)),
    CONSTRAINT promotions_code_shape
        CHECK (code IS NULL OR code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),

    CONSTRAINT promotions_discount_type_values
        CHECK (discount_type IN ('percentage', 'fixed_amount', 'free_item')),

    -- Exactly one discount, and it is the one the type names.
    CONSTRAINT promotions_percentage_shape
        CHECK ((discount_type = 'percentage')
               = (percent_off IS NOT NULL)),
    CONSTRAINT promotions_fixed_amount_shape
        CHECK ((discount_type = 'fixed_amount') = (amount_off IS NOT NULL)),
    CONSTRAINT promotions_free_item_shape
        CHECK ((discount_type = 'free_item') = (free_product_id IS NOT NULL)),

    -- numeric(5,2) reaches 999.99, so this bound is reachable — unlike V006's
    -- commission column, which was numeric(5,3) and made its own CHECK unreachable.
    CONSTRAINT promotions_percent_range
        CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off <= 100)),
    CONSTRAINT promotions_amount_off_positive
        CHECK (amount_off IS NULL OR amount_off > 0),
    CONSTRAINT promotions_min_subtotal_positive
        CHECK (min_subtotal_amount IS NULL OR min_subtotal_amount > 0),

    -- Giving something away requires knowing what has to be bought to earn it.
    CONSTRAINT promotions_free_item_needs_requirement
        CHECK (discount_type <> 'free_item'
               OR (required_product_id IS NOT NULL AND min_quantity IS NOT NULL)),
    CONSTRAINT promotions_requirement_complete
        CHECK ((required_product_id IS NULL) = (min_quantity IS NULL)),
    CONSTRAINT promotions_min_quantity_positive
        CHECK (min_quantity IS NULL OR min_quantity >= 1),

    CONSTRAINT promotions_window_ordered
        CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT promotions_hours_complete
        CHECK ((time_from IS NULL) = (time_to IS NULL)),
    -- A window that ends before it starts is a window that is never open, and a
    -- merchant who typed 15:00–12:00 meant something else.
    CONSTRAINT promotions_hours_ordered
        CHECK (time_from IS NULL OR time_to > time_from),
    CONSTRAINT promotions_days_are_iso
        CHECK (days_of_week <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),

    CONSTRAINT promotions_limits_positive
        CHECK ((max_redemptions IS NULL OR max_redemptions >= 1)
               AND (max_redemptions_per_customer IS NULL OR max_redemptions_per_customer >= 1)),

    -- An automatic promotion is a banner, and a banner with no words is not one.
    CONSTRAINT promotions_automatic_has_banner
        CHECK (kind <> 'automatic' OR btrim(COALESCE(banner_title, '')) <> ''),

    CONSTRAINT promotions_id_store_key UNIQUE (id, store_id),

    FOREIGN KEY (free_product_id, store_id) REFERENCES products (id, store_id) ON DELETE RESTRICT,
    FOREIGN KEY (required_product_id, store_id) REFERENCES products (id, store_id) ON DELETE RESTRICT
);

COMMENT ON TABLE promotions IS
    'Promo codes and automatic promotions. The discount is one of three shapes, the window is a date range plus an optional day-and-hour rule, and the banner''s words live here because Customize treats the banner as content.';
COMMENT ON COLUMN promotions.days_of_week IS
    'ISO day numbers, 1 = Monday. Empty means every day. ISO rather than 0-6 because a weekend is {6,7} — contiguous — where Sunday-first splits it.';
COMMENT ON COLUMN promotions.max_redemptions IS
    'No board draws a cap. It exists because a code with no cap is an unbounded claim on the merchant''s own balance. NULL means no limit, so the default matches the boards exactly.';

-- One code per store, however it was typed. The Shop field uppercases as you type,
-- so the index does the same and "welcome10" cannot become a second code.
CREATE UNIQUE INDEX promotions_store_code_key
    ON promotions (store_id, upper(btrim(code))) WHERE code IS NOT NULL;

-- Serves: applying a typed code, which is the only hot path here.
CREATE INDEX promotions_code_lookup_idx ON promotions (store_id, upper(btrim(code)))
    WHERE code IS NOT NULL AND is_active;

-- Serves: the storefront banner and the automatic pass at checkout.
CREATE INDEX promotions_automatic_idx ON promotions (store_id)
    WHERE kind = 'automatic' AND is_active;

CREATE TRIGGER promotions_set_updated_at BEFORE UPDATE ON promotions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- 2. order_discounts — where every reduction comes from
-- =============================================================================

CREATE TABLE order_discounts (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id      uuid          NOT NULL,
    store_id      uuid          NOT NULL,

    source        text          NOT NULL,

    -- Set for source = 'promotion'. The code is CAPTURED beside it: a receipt from
    -- last year must still say WELCOME10 after the promotion is renamed or deleted,
    -- and the same reasoning V004 gave for order_events.reason applies here.
    promotion_id  uuid,
    code          text,

    amount        numeric(12,2) NOT NULL,

    -- For source = 'manual': why a person reduced this order. "The customer
    -- genuinely paid less" is one of the three cash-gap outcomes CashReport draws.
    reason        text,
    created_by    uuid          REFERENCES users (id) ON DELETE SET NULL,

    created_at    timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT order_discounts_source_values CHECK (source IN ('promotion', 'manual')),
    CONSTRAINT order_discounts_amount_positive CHECK (amount > 0),

    -- A promotion discount names its promotion; a manual one names a person and a
    -- reason. Neither can pretend to be the other.
    CONSTRAINT order_discounts_promotion_shape
        CHECK ((source = 'promotion') = (promotion_id IS NOT NULL)),
    CONSTRAINT order_discounts_manual_has_reason
        CHECK (source <> 'manual' OR btrim(COALESCE(reason, '')) <> ''),
    CONSTRAINT order_discounts_manual_has_author
        CHECK (source <> 'manual' OR created_by IS NOT NULL),

    -- ONE APPLICATION PER PROMOTION PER ORDER.
    CONSTRAINT order_discounts_one_per_promotion UNIQUE (order_id, promotion_id),

    FOREIGN KEY (order_id, store_id) REFERENCES orders (id, store_id) ON DELETE CASCADE,
    FOREIGN KEY (promotion_id, store_id) REFERENCES promotions (id, store_id) ON DELETE RESTRICT
);

COMMENT ON TABLE order_discounts IS
    'Every reduction of an order, with where it came from. orders.discount_amount must equal their sum, which is what stops a discount being a number a client sent.';

CREATE INDEX order_discounts_order_idx ON order_discounts (order_id);
-- Serves: "what did this promotion cost us", and the redemption caps.
CREATE INDEX order_discounts_promotion_idx ON order_discounts (promotion_id)
    WHERE promotion_id IS NOT NULL;


-- The constraint this migration exists for. Deferred, because an order and its
-- discounts are written in one transaction and neither is valid before the other.
CREATE FUNCTION order_discount_total_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_order    uuid;
    v_recorded numeric(12,2);
    v_subtotal numeric(12,2);
    v_sum      numeric(12,2);
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        v_order := CASE TG_OP WHEN 'DELETE' THEN OLD.id ELSE NEW.id END;
    ELSE
        v_order := CASE TG_OP WHEN 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
    END IF;

    SELECT discount_amount, subtotal_amount INTO v_recorded, v_subtotal
      FROM orders WHERE id = v_order;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(sum(amount), 0) INTO v_sum
      FROM order_discounts WHERE order_id = v_order;

    IF v_recorded <> v_sum THEN
        RAISE EXCEPTION 'order % records a discount of % but its discounts sum to %', v_order, v_recorded, v_sum
            USING HINT = 'A discount is a row in order_discounts, not a number on the order. Apply a promotion or record a manual discount.';
    END IF;

    -- V004 already caps the discount at subtotal + delivery fee. This is tighter and
    -- is the design's own rule: "10% off your items". Nobody gets their delivery
    -- paid for by a discount on the food.
    IF v_sum > v_subtotal THEN
        RAISE EXCEPTION 'discounts on order % total % but its items came to %', v_order, v_sum, v_subtotal
            USING HINT = 'A discount comes off the items. It cannot eat into the delivery fee.';
    END IF;

    RETURN NULL;
END;
$init$;

CREATE CONSTRAINT TRIGGER order_discounts_total_check
    AFTER INSERT OR UPDATE OR DELETE ON order_discounts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION order_discount_total_check();

CREATE CONSTRAINT TRIGGER orders_discount_total_check
    AFTER INSERT OR UPDATE OF discount_amount, subtotal_amount ON orders
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION order_discount_total_check();


-- =============================================================================
-- 3. Is it live?
-- =============================================================================
-- One definition, used by the storefront banner, the code field and the automatic
-- pass at checkout. Three readers of one rule is three chances to disagree about
-- whether "Weekdays 12:00–15:00" includes 15:00.

CREATE FUNCTION promotion_is_live(p_promotion_id uuid, p_at timestamptz DEFAULT now())
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT p.is_active
       AND (p.starts_at IS NULL OR p.starts_at <= p_at)
       AND (p.ends_at   IS NULL OR p.ends_at   >  p_at)
       AND (cardinality(p.days_of_week) = 0
            OR extract(isodow FROM p_at)::smallint = ANY (p.days_of_week))
       -- Half-open, like the date window above: 12:00-15:00 includes 12:00 and
       -- excludes 15:00, so two promotions can abut without overlapping.
       AND (p.time_from IS NULL
            OR (p_at::time >= p.time_from AND p_at::time < p.time_to))
      FROM promotions p WHERE p.id = p_promotion_id;
$init$;

COMMENT ON FUNCTION promotion_is_live IS
    'Whether a promotion applies at a given moment: active, inside its dates, on one of its days, and within its hours. Both windows are half-open, so abutting promotions never overlap.';


-- =============================================================================
-- 4. Applying one
-- =============================================================================
-- RETURNS A REASON RATHER THAN RAISING, because every one of these is ordinary
-- customer input and the board has different words for each. A mistyped code and a
-- code that ended yesterday are not the same event and must not arrive as the same
-- error.

CREATE FUNCTION apply_promo_code(
    p_order_id uuid,
    p_code     text,
    p_at       timestamptz DEFAULT now()
) RETURNS TABLE (status text, discount_amount numeric, promotion_id uuid)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    p            record;
    v_store      uuid;
    v_customer   uuid;
    v_subtotal   numeric(12,2);
    v_discount   numeric(12,2);
    v_current    numeric(12,2);
    v_headroom   numeric(12,2);
    v_used       bigint;
BEGIN
    status := 'unknown_code';
    discount_amount := 0;
    promotion_id := NULL;

    -- The order is locked for the rest of this call: the discount and the column it
    -- has to agree with move together.
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

    -- The failures, each with its own answer, in the order a customer meets them.
    IF NOT p.is_active THEN
        status := 'withdrawn';
    ELSIF p.starts_at IS NOT NULL AND p.starts_at > p_at THEN
        status := 'not_started';
    ELSIF p.ends_at IS NOT NULL AND p.ends_at <= p_at THEN
        status := 'expired';
    ELSIF NOT promotion_is_live(p.id, p_at) THEN
        -- Active and inside its dates, so what is left is the day-and-hour rule.
        status := 'outside_hours';
    ELSIF EXISTS (SELECT 1 FROM order_discounts
                   WHERE order_id = p_order_id AND order_discounts.promotion_id = p.id) THEN
        status := 'already_applied';
    ELSIF p.min_subtotal_amount IS NOT NULL AND v_subtotal < p.min_subtotal_amount THEN
        status := 'below_minimum';
    ELSIF p.required_product_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM order_items i
              JOIN product_variants v ON v.id = i.variant_id
             WHERE i.order_id = p_order_id AND v.product_id = p.required_product_id
             GROUP BY v.product_id
            HAVING sum(i.quantity) >= p.min_quantity) THEN
        status := 'requirements_not_met';
    END IF;

    IF status <> 'unknown_code' THEN
        RETURN NEXT;
        RETURN;
    END IF;

    -- THE CAPS ARE SERIALISED ON THE PROMOTION ROW. Counting redemptions is not
    -- enough on its own: two customers checking out at once each count the rows the
    -- other has not committed yet, both see room, and a code limited to one is used
    -- twice. Taking the promotion's row first gives redemptions of one promotion a
    -- total order.
    --
    -- Only when there IS a cap, so an uncapped code does not serialise a whole
    -- store's checkouts behind one row. The lock order is order, then promotion —
    -- the same way round as everywhere else, so nothing here can deadlock against
    -- apply_automatic_promotions.
    IF p.max_redemptions IS NOT NULL OR p.max_redemptions_per_customer IS NOT NULL THEN
        PERFORM 1 FROM promotions WHERE id = p.id FOR UPDATE;
    END IF;

    -- Counted from the discounts actually recorded, so a cap cannot be beaten by a
    -- promotion row that was edited afterwards.
    IF p.max_redemptions IS NOT NULL THEN
        SELECT count(*) INTO v_used FROM order_discounts WHERE order_discounts.promotion_id = p.id;
        IF v_used >= p.max_redemptions THEN
            status := 'limit_reached';
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    IF p.max_redemptions_per_customer IS NOT NULL AND v_customer IS NOT NULL THEN
        SELECT count(*) INTO v_used
          FROM order_discounts d JOIN orders o ON o.id = d.order_id
         WHERE d.promotion_id = p.id AND o.customer_user_id = v_customer;
        IF v_used >= p.max_redemptions_per_customer THEN
            status := 'limit_reached';
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    -- CAPPED AT WHAT IS LEFT, not at the subtotal. A second code on an order that
    -- is already half discounted takes the rest and no more; capping at the
    -- subtotal would mean stacking two codes overshoots and the deferred check
    -- aborts the whole call with a constraint error, where the customer should
    -- simply be told there is nothing left to take off.
    v_headroom := v_subtotal - v_current;
    v_discount := least(promotion_discount_for_order(p.id, p_order_id), v_headroom);

    IF v_discount <= 0 THEN
        status := 'nothing_to_discount';
        RETURN NEXT;
        RETURN;
    END IF;

    -- Both writes together: the row and the column the deferred check compares it
    -- against.
    INSERT INTO order_discounts (order_id, store_id, source, promotion_id, code, amount)
         VALUES (p_order_id, v_store, 'promotion', p.id, upper(btrim(p.code)), v_discount);

    UPDATE orders SET discount_amount = v_current + v_discount WHERE id = p_order_id;

    status := 'applied';
    discount_amount := v_discount;
    RETURN NEXT;
END;
$init$;

COMMENT ON FUNCTION apply_promo_code IS
    'Applies a typed code, or says why not: unknown_code, withdrawn, not_started, expired, outside_hours, already_applied, below_minimum, requirements_not_met, limit_reached, nothing_to_discount. Never raises for ordinary customer input, because the board has different words for each.';


-- What a promotion is worth on one order. Separate, because the automatic pass and
-- the typed code must compute it the same way — and because "10% off your items" is
-- an arithmetic rule the design states outright and it belongs in one place.
CREATE FUNCTION promotion_discount_for_order(p_promotion_id uuid, p_order_id uuid)
    RETURNS numeric
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    p          record;
    v_subtotal numeric(12,2);
    v_amount   numeric(12,2);
BEGIN
    SELECT * INTO p FROM promotions WHERE id = p_promotion_id;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    SELECT subtotal_amount INTO v_subtotal FROM orders WHERE id = p_order_id;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    IF p.discount_type = 'percentage' THEN
        -- Shop's own arithmetic: round(subtotal * 0.1). Of the ITEMS.
        v_amount := round(v_subtotal * p.percent_off / 100, 2);

    ELSIF p.discount_type = 'fixed_amount' THEN
        v_amount := p.amount_off;

    ELSE
        -- free_item: worth what the cheapest qualifying line charges for it, which
        -- is the unit price CAPTURED on the order rather than today's price list.
        -- "Free fries" is worth what these fries cost, not what fries cost now.
        SELECT min(i.unit_price_amount + i.options_amount) INTO v_amount
          FROM order_items i
          JOIN product_variants v ON v.id = i.variant_id
         WHERE i.order_id = p_order_id AND v.product_id = p.free_product_id;

        v_amount := COALESCE(v_amount, 0);
    END IF;

    -- Never more than the items came to. A fixed 5,000 off a 3,000 order is 3,000
    -- off, not a store paying for someone's delivery.
    RETURN least(COALESCE(v_amount, 0), v_subtotal);
END;
$init$;

COMMENT ON FUNCTION promotion_discount_for_order IS
    'What a promotion is worth on one order: a percentage of the items, a fixed amount, or the captured price of the free product — capped at the subtotal in every case.';


CREATE FUNCTION apply_automatic_promotions(p_order_id uuid, p_at timestamptz DEFAULT now())
    RETURNS TABLE (applied_promotion_id uuid, applied_amount numeric)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    r          record;
    v_store    uuid;
    v_subtotal numeric(12,2);
    v_amount   numeric(12,2);
    v_total    numeric(12,2) := 0;
BEGIN
    SELECT store_id, subtotal_amount, discount_amount
      INTO v_store, v_subtotal, v_total
      FROM orders WHERE id = p_order_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'order % does not exist', p_order_id;
    END IF;

    FOR r IN
        SELECT p.* FROM promotions p
         WHERE p.store_id = v_store AND p.kind = 'automatic'
           AND promotion_is_live(p.id, p_at)
           -- Idempotent: a checkout retried does not stack the same promotion.
           AND NOT EXISTS (SELECT 1 FROM order_discounts d
                            WHERE d.order_id = p_order_id AND d.promotion_id = p.id)
         -- Deterministic order, so two identical carts get identical totals however
         -- the rows happen to be laid out on disk.
         ORDER BY p.created_at, p.id
    LOOP
        IF r.min_subtotal_amount IS NOT NULL AND v_subtotal < r.min_subtotal_amount THEN
            CONTINUE;
        END IF;

        -- The same serialisation as the typed path, for the same reason.
        IF r.max_redemptions IS NOT NULL THEN
            PERFORM 1 FROM promotions WHERE id = r.id FOR UPDATE;
            IF (SELECT count(*) FROM order_discounts d WHERE d.promotion_id = r.id)
               >= r.max_redemptions THEN
                CONTINUE;
            END IF;
        END IF;

        IF r.required_product_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM order_items i
              JOIN product_variants v ON v.id = i.variant_id
             WHERE i.order_id = p_order_id AND v.product_id = r.required_product_id
             GROUP BY v.product_id
            HAVING sum(i.quantity) >= r.min_quantity) THEN
            CONTINUE;
        END IF;

        v_amount := promotion_discount_for_order(r.id, p_order_id);

        -- Nothing left to discount. Stop rather than write a zero row, which the
        -- amount CHECK would refuse anyway.
        IF v_amount <= 0 OR v_total + v_amount > v_subtotal THEN
            v_amount := least(v_amount, v_subtotal - v_total);
            IF v_amount <= 0 THEN
                CONTINUE;
            END IF;
        END IF;

        INSERT INTO order_discounts (order_id, store_id, source, promotion_id, code, amount)
             VALUES (p_order_id, v_store, 'promotion', r.id, r.code, v_amount);

        v_total := v_total + v_amount;

        applied_promotion_id := r.id;
        applied_amount := v_amount;
        RETURN NEXT;
    END LOOP;

    UPDATE orders SET discount_amount = v_total WHERE id = p_order_id;
END;
$init$;

COMMENT ON FUNCTION apply_automatic_promotions IS
    'Applies every live automatic promotion to an order, in a deterministic order, never twice and never past the subtotal. Idempotent: a retried checkout adds nothing.';


CREATE FUNCTION record_manual_discount(
    p_order_id uuid,
    p_amount   numeric,
    p_reason   text,
    p_actor_id uuid
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store    uuid;
    v_current  numeric(12,2);
    v_subtotal numeric(12,2);
    v_id       uuid;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'a discount of % is not a discount', p_amount;
    END IF;

    IF btrim(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'a manual discount needs a reason on the order'
            USING HINT = 'This is somebody reducing what a customer owes. Why belongs on the record.';
    END IF;

    SELECT store_id, discount_amount, subtotal_amount INTO v_store, v_current, v_subtotal
      FROM orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'order % does not exist', p_order_id;
    END IF;

    -- Said in words here, because a generous manager typing a big number should read
    -- what is wrong rather than a constraint name.
    IF v_current + p_amount > v_subtotal THEN
        RAISE EXCEPTION 'a discount of % would take order % past the % of items on it',
            p_amount, p_order_id, v_subtotal
            USING HINT = 'A discount comes off the items, and some may already be off. Reduce it, or refund instead.';
    END IF;

    INSERT INTO order_discounts (order_id, store_id, source, amount, reason, created_by)
         VALUES (p_order_id, v_store, 'manual', p_amount, btrim(p_reason), p_actor_id)
      RETURNING id INTO v_id;

    UPDATE orders SET discount_amount = v_current + p_amount WHERE id = p_order_id;

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION record_manual_discount IS
    'Reduces an order by hand, with a reason and a person. This is where CashReport''s second gap outcome lands — "the customer genuinely paid less" is a discount on the order, not a hole in the ledger.';


-- =============================================================================
-- 5. The banner
-- =============================================================================
-- Customize draws "Promotion banner" as a homepage section a merchant can switch
-- off, and Shop renders two lines inside it. One live automatic promotion supplies
-- them; if there are several, the one that started most recently wins, because that
-- is the one the merchant just set up.

CREATE FUNCTION store_promotion_banner(p_store_id uuid, p_at timestamptz DEFAULT now())
    RETURNS TABLE (promotion_id uuid, banner_title text, banner_subtitle text)
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT p.id, p.banner_title, p.banner_subtitle
      FROM promotions p
     WHERE p.store_id = p_store_id
       AND p.kind = 'automatic'
       AND promotion_is_live(p.id, p_at)
     ORDER BY COALESCE(p.starts_at, p.created_at) DESC, p.id DESC
     LIMIT 1;
$init$;


-- =============================================================================
-- Recorded rather than invented
-- =============================================================================
-- 1. NO PROMOTION EDITOR EXISTS ON ANY BOARD. Shop shows a code being typed,
--    States shows two ways it can fail, and Customize shows the banner being
--    switched on — but nothing draws a merchant CREATING a promotion. Every column
--    here is something one of those screens needs in order to behave as drawn; the
--    editor, when it is designed, may want more, and adding it is an ALTER.
--
-- 2. STACKING IS ALLOWED FOR AUTOMATIC PROMOTIONS AND UNTESTED BY THE DESIGN.
--    order_discounts can hold several rows, the subtotal caps their sum, and one
--    promotion cannot apply twice. Whether two automatic promotions SHOULD both
--    apply is a commercial question no board answers. The schema permits it and the
--    total can never go wrong, which is the most that can be settled here.
--
-- 3. FREE DELIVERY IS NOT A DISCOUNT TYPE, because no board offers one and because
--    it would have to reach delivery_fee_amount rather than discount_amount —
--    "10% off your items" is explicit that a discount comes off the items. When a
--    free-delivery promotion is wanted it is a fourth discount_type and a change to
--    the constraint above, not a manual discount dressed up as one.
