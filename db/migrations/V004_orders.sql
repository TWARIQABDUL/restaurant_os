-- V004_orders.sql
--
-- Milestone 8, first half. Orders, their lines, and the record of every state
-- change. The money tables and the plpgsql functions are V005.
--
-- This file is written against four failures, each of which has happened to real
-- commerce systems and each of which is silent:
--
--   AN ORDER IS PLACED TWICE. The customer taps Pay, the request times out, the
--   phone retries. Guarded by orders.idempotency_key, unique per store: the second
--   attempt collides instead of creating a second order and a second charge.
--
--   AN ORDER'S TOTAL DOES NOT MATCH ITS LINES. Guarded by making the arithmetic
--   unforgeable — total_amount and line_total_amount are GENERATED columns, and a
--   deferred constraint checks the subtotal against the sum of the lines at commit.
--   There is no way to write an order whose total is a number somebody chose.
--
--   AN ORDER LOSES ITS LINES, or is created without any. Guarded by a deferred
--   constraint: at commit, an order has at least one line. An empty order is a
--   customer who paid for nothing.
--
--   AN ORDER JUMPS A STATE. "delivered" back to "pending", or "rejected" after
--   "delivered", each of which corrupts what is owed to whom. Guarded by a
--   transition table and a trigger: the allowed moves are data, and anything else
--   is refused.
--
-- Every state change is also recorded in order_events, append-only, with who did
-- it and why. Money disputes are argued from that table.
--
-- THE TWELVE STATUSES are from Orders.dc.html's own STATUS map, not invented:
--   pending approved preparing ready assigned out delivered
--   returned closed_return rejected cancelled collected


-- =============================================================================
-- 1. Order numbers
-- =============================================================================
-- The human-readable number a merchant and customer say out loud — #1031. Per
-- store and allocated under a row lock, so two orders placed in the same
-- millisecond cannot take the same number. A UNIQUE constraint alone would make
-- that a retry loop in the application; this makes it a wait of microseconds.

CREATE TABLE store_order_counters (
    store_id          uuid    PRIMARY KEY REFERENCES stores (id) ON DELETE CASCADE,
    next_order_number integer NOT NULL DEFAULT 1000,

    CONSTRAINT store_order_counters_positive CHECK (next_order_number > 0)
);

COMMENT ON TABLE store_order_counters IS
    'Allocates order numbers per store. Starts at 1000 so the first order is not #1, which reads as a store with no customers.';

CREATE FUNCTION next_order_number(p_store_id uuid) RETURNS integer
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_number integer;
BEGIN
    -- One statement: the UPDATE takes a row lock, increments, and returns. Two
    -- concurrent callers serialise here and get different numbers.
    INSERT INTO store_order_counters (store_id, next_order_number)
         VALUES (p_store_id, 1001)
    ON CONFLICT (store_id) DO UPDATE
            SET next_order_number = store_order_counters.next_order_number + 1
      RETURNING next_order_number - CASE WHEN xmax = 0 THEN 1 ELSE 0 END INTO v_number;

    RETURN v_number;
END;
$init$;

COMMENT ON FUNCTION next_order_number(uuid) IS
    'The next order number for a store, allocated atomically. Gaps are possible (a rolled-back order keeps its number) and harmless.';


-- =============================================================================
-- 2. The state machine, as data
-- =============================================================================

CREATE TABLE order_status_transitions (
    from_status text NOT NULL,
    to_status   text NOT NULL,
    description text NOT NULL,

    PRIMARY KEY (from_status, to_status)
);

COMMENT ON TABLE order_status_transitions IS
    'Every move an order may make. Enforced by a trigger, so an illegal jump is refused by the database rather than prevented by whichever code path remembered.';

INSERT INTO order_status_transitions (from_status, to_status, description) VALUES
    -- The merchant accepts or declines a new order.
    ('pending',   'approved',      'Merchant accepted the order'),
    ('pending',   'rejected',      'Merchant declined it, with a reason'),
    ('pending',   'cancelled',     'Cancelled before it was accepted'),

    ('approved',  'preparing',     'Work started'),
    ('approved',  'cancelled',     'Cancelled after accepting, with a reason'),

    ('preparing', 'ready',         'Ready for collection or dispatch'),
    ('preparing', 'cancelled',     'Cancelled while preparing — an item ran out'),

    -- Ready splits by fulfilment: a rider collects it, or the customer does.
    ('ready',     'assigned',      'Assigned to a named rider, who is coming to collect'),
    ('ready',     'collected',     'Customer collected it themselves (pickup)'),
    ('ready',     'cancelled',     'Cancelled while waiting'),

    ('assigned',  'out',           'Rider has it and is on the way'),
    ('assigned',  'returned',      'Rider could not collect it, or brought it straight back'),
    ('assigned',  'cancelled',     'Cancelled before the rider left'),

    ('out',       'delivered',     'Handed to the customer'),
    ('out',       'returned',      'Could not be delivered — nobody answering, wrong address'),

    -- A return is not finished until the merchant closes it, because the stock and
    -- the customer's money both still need deciding.
    ('returned',  'closed_return', 'Merchant closed the return: stock and refund decided');

-- delivered, collected, rejected, cancelled and closed_return are terminal. They
-- appear as no from_status above, which is what makes them terminal — refunds are
-- a separate flow and do not move the status.


-- =============================================================================
-- 3. orders
-- =============================================================================

CREATE TABLE orders (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id             uuid          NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    order_number         integer       NOT NULL,

    -- The token in the tracking URL a guest is given. Unguessable, because holding
    -- it is seeing the order.
    tracking_code        text          NOT NULL,

    -- THE DOUBLE-SUBMIT GUARD. The client sends one key per checkout attempt; a
    -- retry sends the same key and collides here. Unique per store rather than
    -- globally, so two merchants' clients cannot interfere.
    idempotency_key      text          NOT NULL,

    -- A signed-in customer, or a guest who typed their details. Exactly one.
    customer_user_id     uuid          REFERENCES users (id) ON DELETE SET NULL,
    guest_name           text,
    guest_phone          text,
    guest_email          text,

    delivery_address     text,
    fulfilment_type      text          NOT NULL,

    status               text          NOT NULL DEFAULT 'pending',

    payment_method       text          NOT NULL,
    payment_status       text          NOT NULL DEFAULT 'unpaid',
    settlement_status    text          NOT NULL DEFAULT 'not_applicable',

    -- Money. subtotal is checked against the lines at commit; total is GENERATED
    -- from the three parts, so it cannot be set to a number of anyone's choosing.
    currency             char(3)       NOT NULL,
    subtotal_amount      numeric(12,2) NOT NULL,
    delivery_fee_amount  numeric(12,2) NOT NULL DEFAULT 0,
    discount_amount      numeric(12,2) NOT NULL DEFAULT 0,
    total_amount         numeric(12,2) NOT NULL
        GENERATED ALWAYS AS (subtotal_amount + delivery_fee_amount - discount_amount) STORED,

    refunded_amount      numeric(12,2) NOT NULL DEFAULT 0,

    -- Cash on delivery. What the rider says they collected, and when a manager
    -- confirmed it — separate from delivery, because "delivered" and "the money
    -- arrived" are different facts and the second can be short.
    cash_reported_amount numeric(12,2),
    cash_confirmed_at    timestamptz,

    rider_user_id        uuid          REFERENCES users (id) ON DELETE SET NULL,

    placed_at            timestamptz   NOT NULL DEFAULT now(),
    paid_at              timestamptz,
    delivered_at         timestamptz,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT orders_status_values CHECK (status IN (
        'pending', 'approved', 'preparing', 'ready', 'assigned', 'out',
        'delivered', 'collected', 'returned', 'closed_return', 'rejected', 'cancelled')),
    CONSTRAINT orders_fulfilment_values CHECK (fulfilment_type IN ('delivery', 'pickup')),
    CONSTRAINT orders_payment_method_values CHECK (payment_method IN ('cash', 'momo')),
    CONSTRAINT orders_payment_status_values CHECK (payment_status IN ('unpaid', 'paid', 'refunded')),
    CONSTRAINT orders_settlement_status_values
        CHECK (settlement_status IN ('not_applicable', 'pending', 'released', 'refunded')),

    CONSTRAINT orders_tracking_code_format CHECK (char_length(tracking_code) BETWEEN 12 AND 64),
    CONSTRAINT orders_idempotency_key_format CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),

    -- A customer is a signed-in account or a guest, never both and never neither:
    -- an order nobody can be contacted about cannot be delivered.
    CONSTRAINT orders_has_a_customer CHECK (
        (customer_user_id IS NOT NULL AND guest_name IS NULL AND guest_phone IS NULL)
     OR (customer_user_id IS NULL AND guest_name IS NOT NULL AND guest_phone IS NOT NULL)
    ),

    -- Delivery needs somewhere to go; pickup must not carry a stale address.
    CONSTRAINT orders_delivery_has_address CHECK (
        (fulfilment_type = 'delivery' AND delivery_address IS NOT NULL)
     OR (fulfilment_type = 'pickup' AND delivery_address IS NULL)
    ),

    CONSTRAINT orders_amounts_not_negative CHECK (
        subtotal_amount >= 0 AND delivery_fee_amount >= 0 AND discount_amount >= 0 AND refunded_amount >= 0
    ),
    -- A discount cannot exceed what is being discounted, or the total goes negative
    -- and the store owes the customer money for shopping.
    CONSTRAINT orders_discount_within_subtotal
        CHECK (discount_amount <= subtotal_amount + delivery_fee_amount),

    -- Never refund more than was charged, however many partial refunds there are.
    CONSTRAINT orders_refund_within_total
        CHECK (refunded_amount <= subtotal_amount + delivery_fee_amount - discount_amount),
    -- And the status must agree with the amount, in both directions.
    CONSTRAINT orders_refund_status_agrees CHECK (
        (payment_status = 'refunded') = (refunded_amount > 0 AND refunded_amount >= subtotal_amount + delivery_fee_amount - discount_amount)
    ),
    CONSTRAINT orders_refund_needs_payment
        CHECK (refunded_amount = 0 OR payment_status IN ('paid', 'refunded')),

    -- paid_at and payment_status cannot disagree about whether money arrived.
    CONSTRAINT orders_paid_at_agrees
        CHECK ((payment_status = 'unpaid') = (paid_at IS NULL)),

    -- Cash reconciliation belongs to cash orders only.
    CONSTRAINT orders_cash_fields_are_cash_only CHECK (
        payment_method = 'cash'
     OR (cash_reported_amount IS NULL AND cash_confirmed_at IS NULL)
    ),
    CONSTRAINT orders_cash_reported_not_negative
        CHECK (cash_reported_amount IS NULL OR cash_reported_amount >= 0),
    -- Confirmation means somebody counted it, so there has to be a figure.
    CONSTRAINT orders_cash_confirmed_has_figure
        CHECK (cash_confirmed_at IS NULL OR cash_reported_amount IS NOT NULL),

    -- Only a delivery has a rider.
    CONSTRAINT orders_rider_is_delivery
        CHECK (rider_user_id IS NULL OR fulfilment_type = 'delivery'),

    CONSTRAINT orders_id_store_key UNIQUE (id, store_id)
);

COMMENT ON TABLE orders IS
    'One order. total_amount is GENERATED and the subtotal is checked against the lines at commit, so an order''s total can never be a number someone chose.';
COMMENT ON COLUMN orders.idempotency_key IS
    'One per checkout attempt, from the client. A retried request carries the same key and collides here instead of placing a second order.';
COMMENT ON COLUMN orders.cash_reported_amount IS
    'What the rider says they collected. May be less than the total — Rider.dc.html: "Short by 2,000 RWF. Your manager will see the difference."';

CREATE UNIQUE INDEX orders_store_number_key ON orders (store_id, order_number);
CREATE UNIQUE INDEX orders_tracking_code_key ON orders (tracking_code);
CREATE UNIQUE INDEX orders_store_idempotency_key ON orders (store_id, idempotency_key);

-- Serves: the orders board, which is the hottest query in the product —
-- WHERE store_id = $1 AND status IN (…) ORDER BY placed_at DESC. §2.3 records that
-- the old schema served this with three separate single-column indexes.
CREATE INDEX orders_store_status_placed_idx ON orders (store_id, status, placed_at DESC);

-- Serves: the order list and the dashboard's recents, which do not filter status.
CREATE INDEX orders_store_placed_idx ON orders (store_id, placed_at DESC);

-- Serves: a customer's order history.
CREATE INDEX orders_customer_idx ON orders (customer_user_id, placed_at DESC) WHERE customer_user_id IS NOT NULL;

-- Serves: a rider's job list, and the cash a rider is carrying.
CREATE INDEX orders_rider_idx ON orders (rider_user_id, status) WHERE rider_user_id IS NOT NULL;

-- Serves: the escrow sweep, which looks for paid orders whose hold window has
-- elapsed. Partial, because that is a handful of rows out of everything.
CREATE INDEX orders_settlement_sweep_idx ON orders (paid_at)
    WHERE settlement_status = 'pending';

-- Serves: "cash not confirmed yet" on the orders board and the cash report.
CREATE INDEX orders_cash_unconfirmed_idx ON orders (store_id, delivered_at)
    WHERE payment_method = 'cash' AND cash_confirmed_at IS NULL;

CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- 4. Lines
-- =============================================================================
-- Everything a customer was charged for is CAPTURED here, not referenced. A
-- product renamed or repriced tomorrow must not rewrite what someone paid
-- yesterday — and a deleted product must not make an order unreadable.

CREATE TABLE order_items (
    id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           uuid          NOT NULL,
    store_id           uuid          NOT NULL,

    -- Kept for reporting, and deliberately RESTRICT: a variant with orders against
    -- it is part of the record and cannot be deleted out from under them.
    variant_id         uuid          NOT NULL,

    -- Captured at purchase.
    product_name       text          NOT NULL,
    variant_label      text          NOT NULL DEFAULT '',
    sku                text,

    unit_price_amount  numeric(12,2) NOT NULL,
    -- The sum of the chosen "pick several" option deltas, checked against the
    -- captured rows at commit.
    options_amount     numeric(12,2) NOT NULL DEFAULT 0,
    quantity           integer       NOT NULL,

    line_total_amount  numeric(12,2) NOT NULL
        GENERATED ALWAYS AS ((unit_price_amount + options_amount) * quantity) STORED,

    created_at         timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
    CONSTRAINT order_items_amounts_not_negative
        CHECK (unit_price_amount >= 0 AND options_amount >= 0),
    CONSTRAINT order_items_product_name_present CHECK (btrim(product_name) <> ''),

    FOREIGN KEY (order_id, store_id) REFERENCES orders (id, store_id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id, store_id) REFERENCES product_variants (id, store_id) ON DELETE RESTRICT,
    CONSTRAINT order_items_id_order_key UNIQUE (id, order_id)
);

COMMENT ON TABLE order_items IS
    'One line, with the name, price and options CAPTURED as they were. line_total_amount is GENERATED, so a line total cannot disagree with its own parts.';

CREATE INDEX order_items_order_idx ON order_items (order_id);
-- Serves: top-items analytics, which §2.3 notes is unindexed in the old schema.
CREATE INDEX order_items_variant_idx ON order_items (variant_id);


CREATE TABLE order_item_option_values (
    order_item_id   uuid          NOT NULL,
    option_value_id uuid          NOT NULL,
    order_id        uuid          NOT NULL,

    -- Captured, for the same reason as the line: "Fries + extra sauce" must still
    -- read correctly after the merchant renames the option.
    group_name      text          NOT NULL,
    value_label     text          NOT NULL,
    price_delta     numeric(12,2) NOT NULL,

    PRIMARY KEY (order_item_id, option_value_id),

    FOREIGN KEY (order_item_id, order_id) REFERENCES order_items (id, order_id) ON DELETE CASCADE,
    FOREIGN KEY (option_value_id) REFERENCES option_values (id) ON DELETE RESTRICT,

    CONSTRAINT order_item_option_values_delta_not_negative CHECK (price_delta >= 0)
);

COMMENT ON TABLE order_item_option_values IS
    'The options chosen on one line, captured. Their deltas must sum to the line''s options_amount — checked at commit.';


-- =============================================================================
-- 5. The arithmetic cannot be wrong
-- =============================================================================
-- Three invariants that span rows, so all three are DEFERRABLE INITIALLY DEFERRED
-- constraint triggers: an order is written before its lines, and a per-statement
-- check would see every order half-built.

CREATE FUNCTION order_totals_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_order       uuid;
    v_lines       integer;
    v_line_sum    numeric(12,2);
    v_subtotal    numeric(12,2);
    v_status      text;
BEGIN
    -- One function, two tables, and they name the order differently: on `orders` it
    -- is `id`, on `order_items` it is `order_id`. Reading the wrong one raises
    -- 'record "new" has no field', which is how every insert into orders failed the
    -- first time this file was written.
    IF TG_TABLE_NAME = 'orders' THEN
        v_order := CASE TG_OP WHEN 'DELETE' THEN OLD.id ELSE NEW.id END;
    ELSE
        v_order := CASE TG_OP WHEN 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
    END IF;

    SELECT o.subtotal_amount, o.status INTO v_subtotal, v_status
      FROM orders o WHERE o.id = v_order;

    -- The order went away in the same transaction.
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT count(*), COALESCE(sum(i.line_total_amount), 0)
      INTO v_lines, v_line_sum
      FROM order_items i WHERE i.order_id = v_order;

    -- 1. An order has lines. An empty order is somebody who paid for nothing.
    IF v_lines = 0 THEN
        RAISE EXCEPTION 'order % has no lines', v_order
            USING HINT = 'An order with no items cannot be fulfilled or refunded sensibly.';
    END IF;

    -- 2. The subtotal is the sum of the lines. Exactly — this is money.
    IF v_subtotal <> v_line_sum THEN
        RAISE EXCEPTION 'order % has subtotal % but its lines sum to %', v_order, v_subtotal, v_line_sum
            USING HINT = 'The subtotal is not a figure to set; it is what the lines add up to.';
    END IF;

    RETURN NULL;
END;
$init$;

CREATE CONSTRAINT TRIGGER orders_totals_check
    AFTER INSERT OR UPDATE ON orders
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION order_totals_check();

CREATE CONSTRAINT TRIGGER order_items_totals_check
    AFTER INSERT OR UPDATE OR DELETE ON order_items
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION order_totals_check();


CREATE FUNCTION order_item_options_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_item    uuid;
    v_stored  numeric(12,2);
    v_summed  numeric(12,2);
BEGIN
    v_item := COALESCE(NEW.order_item_id, OLD.order_item_id);

    SELECT i.options_amount INTO v_stored FROM order_items i WHERE i.id = v_item;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(sum(v.price_delta), 0) INTO v_summed
      FROM order_item_option_values v WHERE v.order_item_id = v_item;

    IF v_stored <> v_summed THEN
        RAISE EXCEPTION 'order line % records options_amount % but its options sum to %', v_item, v_stored, v_summed
            USING HINT = 'options_amount is the sum of the captured option deltas, not a separate figure.';
    END IF;

    RETURN NULL;
END;
$init$;

CREATE CONSTRAINT TRIGGER order_item_option_values_sum_check
    AFTER INSERT OR UPDATE OR DELETE ON order_item_option_values
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION order_item_options_check();

CREATE FUNCTION order_item_options_check_from_item() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_summed numeric(12,2);
BEGIN
    SELECT COALESCE(sum(v.price_delta), 0) INTO v_summed
      FROM order_item_option_values v WHERE v.order_item_id = NEW.id;

    IF NEW.options_amount <> v_summed THEN
        RAISE EXCEPTION 'order line % records options_amount % but its options sum to %', NEW.id, NEW.options_amount, v_summed
            USING HINT = 'options_amount is the sum of the captured option deltas, not a separate figure.';
    END IF;

    RETURN NULL;
END;
$init$;

-- The line's own side of it: a line claiming options_amount with no option rows.
CREATE CONSTRAINT TRIGGER order_items_options_sum_check
    AFTER INSERT OR UPDATE OF options_amount ON order_items
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION order_item_options_check_from_item();

-- =============================================================================
-- 6. No order jumps a state
-- =============================================================================

CREATE FUNCTION order_status_transition_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM order_status_transitions
         WHERE from_status = OLD.status AND to_status = NEW.status
    ) THEN
        RAISE EXCEPTION 'order % cannot move from % to %', OLD.id, OLD.status, NEW.status
            USING HINT = 'See order_status_transitions for the moves an order may make. Terminal statuses have none.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER orders_status_transition BEFORE UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION order_status_transition_check();


-- =============================================================================
-- 7. order_events — what happened, who did it, and why
-- =============================================================================
-- Append-only. A money dispute is argued from this table, so a row that can be
-- edited afterwards is worth nothing.

CREATE TABLE order_events (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id    uuid        NOT NULL,
    store_id    uuid        NOT NULL,

    from_status text,
    to_status   text        NOT NULL,

    -- One of the reason lists Orders.dc.html draws, or free text for "Something
    -- else". Kept as text rather than a foreign key because the lists are copy the
    -- designer owns, and a decline reason recorded last year must still read
    -- correctly after the list changes.
    reason      text,
    note        text,

    actor_id    uuid        REFERENCES users (id) ON DELETE SET NULL,
    actor_role  text,

    created_at  timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (order_id, store_id) REFERENCES orders (id, store_id) ON DELETE CASCADE
);

COMMENT ON TABLE order_events IS
    'Append-only record of every status change, with who and why. The audit a refund or a short cash payment is argued from.';

-- Serves: the order detail timeline, oldest first.
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

CREATE FUNCTION order_events_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    RAISE EXCEPTION 'order_events is append-only (attempted % on order %)', TG_OP, OLD.order_id
        USING HINT = 'A history that can be rewritten is not a history. Append a correcting event instead.';
END;
$init$;

CREATE TRIGGER order_events_no_update BEFORE UPDATE OR DELETE ON order_events
    FOR EACH ROW EXECUTE FUNCTION order_events_append_only();
