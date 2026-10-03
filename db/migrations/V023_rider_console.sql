-- =============================================================================
-- V023 — the rider's own app, and closing a rider's cash day
-- =============================================================================
-- Milestone 21 of docs/migration/04-implementation-plan.md: `Rider` and
-- `CashReport`, which the plan says "must land together" — a rider's app with
-- no merchant screen reading what it reports would be unaccountable, and a
-- cash report with no rider app writing to it would have nothing to read.
--
-- WHAT WAS ALREADY THERE. V007 built `rider_profiles`, `rider_cash_handovers`
-- and `rider_cash_settlements` — the tables — and left the write side to
-- whichever milestone first had a caller, same as V004's state machine before
-- V022. `mark_picked_up()`, `mark_delivered()` and `confirm_cash_payment()`
-- already exist (V022, V005) and this migration's routes reuse them exactly —
-- a rider marking their own delivery is the same transition a merchant marking
-- it on their behalf is, with a different actor and a different permission
-- gate, not a second implementation.
--
-- WHAT THIS MIGRATION ADDS: the rider's own availability switch, the one
-- transition V022 deliberately deferred (`mark_returned` — "that is the
-- RIDER's job, milestone 21 territory"), and the three functions a rider's
-- cash day needs that V007 left as plain INSERTs for whichever caller arrived
-- first: recording a hand-over, closing the day, and marking a carried-over
-- debt received.
--
-- A RESERVED SLUG V001 MISSED. `/app/:store` collided with nothing because
-- 'app' is reserved; `/rider/:store` — Auth's own destination for a rider,
-- written at milestone 15 before this screen existed — was not, so a store
-- that chose the slug "rider" would have shadowed every rider's own app. Fixed
-- here, the same way V006 extended the same CHECK for its own reasons.
--
-- A SECOND GAP: NOWHERE DOES A STORE HAVE AN ADDRESS. `store_pickup_settings.
-- address` is the closest thing, and it is the wrong column for this —
-- it exists only for stores that offer customer pickup, "absent when the
-- store does not offer pickup" by that table's own comment, but `Rider.dc.html`
-- needs somewhere to send a rider to collect from REGARDLESS of whether the
-- store also lets a customer collect in person. Kigali Kicks delivers and has
-- no pickup settings row, so this is not a hypothetical. `stores.address` is
-- the store's own physical location; nullable, because a store that has not
-- gone live yet (`AdminMerchants`' pending/suspended cases) has nothing to
-- send a rider to either.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The gap in V001's reserved slugs
-- -----------------------------------------------------------------------------

ALTER TABLE stores
    DROP CONSTRAINT stores_slug_not_reserved,
    ADD CONSTRAINT stores_slug_not_reserved CHECK (slug NOT IN (
        'api', 'app', 'admin', 'www', 'mail', 'ftp', 'assets', 'static', 'public',
        'auth', 'login', 'logout', 'signup', 'signin', 'register', 'password',
        'account', 'accounts', 'dashboard', 'settings', 'checkout', 'cart',
        'orders', 'order', 'products', 'health', 'status', 'support', 'help',
        'about', 'terms', 'privacy', 'blog', 'docs', 'vendlyfy', 'store', 'stores',
        'rider', 'riders'
    ));


-- -----------------------------------------------------------------------------
-- 2. A store's own physical location
-- -----------------------------------------------------------------------------

ALTER TABLE stores ADD COLUMN address text;

COMMENT ON COLUMN stores.address IS
    'Where the store itself is — what a rider collects from. Not store_pickup_settings.address, which exists only for stores that let a CUSTOMER collect and is absent otherwise.';


-- -----------------------------------------------------------------------------
-- 3. Available / off duty — the rider's own switch
-- -----------------------------------------------------------------------------
-- "Riders set this themselves in the rider app" (V007's own comment on the
-- column). "On a delivery" is deliberately not a value here — it is derived
-- from having an order out, so a rider cannot be shown available and on a
-- delivery at once by two different writers disagreeing.

CREATE FUNCTION set_rider_availability(p_user_id uuid, p_store_id uuid, p_available boolean)
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    UPDATE rider_profiles
       SET availability = CASE WHEN p_available THEN 'available' ELSE 'off_duty' END,
           availability_changed_at = now()
     WHERE user_id = p_user_id AND store_id = p_store_id;

    RETURN FOUND;
END;
$init$;

COMMENT ON FUNCTION set_rider_availability IS
    'The rider app''s own switch. False means this user has no rider profile at this store, not that anything went wrong.';


-- -----------------------------------------------------------------------------
-- 4. Couldn't deliver — the transition V022 deferred
-- -----------------------------------------------------------------------------
-- assigned/out -> returned, with a reason: "Customer not answering", "Wrong or
-- unclear address", and so on — `Rider.dc.html`'s own list. No stock and no
-- money move here, the same reasoning V022's close_return() comment gives for
-- cash: the order never reached `delivered`, so nothing has been collected and
-- nothing is owed back. close_return() is what the merchant calls once it is
-- back at the store.

CREATE FUNCTION mark_returned(
    p_order_id   uuid,
    p_store_id   uuid,
    p_actor_id   uuid,
    p_actor_role text,
    p_reason     text,
    p_note       text DEFAULT NULL
) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_status text;
BEGIN
    IF btrim(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'returning an order needs a reason the store reads';
    END IF;

    SELECT status INTO v_status FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND OR v_status NOT IN ('assigned', 'out') THEN
        RETURN false;
    END IF;

    UPDATE orders SET status = 'returned' WHERE id = p_order_id;
    INSERT INTO order_events (order_id, store_id, from_status, to_status, reason, note, actor_id, actor_role)
         VALUES (p_order_id, p_store_id, v_status, 'returned', p_reason, p_note, p_actor_id, p_actor_role);

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION mark_returned IS
    'assigned/out -> returned, with a reason. Moves no stock and no money — close_return() (V022) decides both once the merchant has it back.';


-- -----------------------------------------------------------------------------
-- 5. A hand-over, mid-shift
-- -----------------------------------------------------------------------------
-- "Handed in at 12:00 − 6,000" — CashReport's own line. A day is a running
-- account of several hand-ins, not one payment at the end (V007's header), so
-- this can be called any number of times before the day is closed.

CREATE FUNCTION record_rider_handover(
    p_store_id      uuid,
    p_rider_user_id uuid,
    p_actor_id      uuid,
    p_amount        numeric,
    p_note          text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_id uuid;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'a hand-over of % is not one', p_amount;
    END IF;

    INSERT INTO rider_cash_handovers (store_id, rider_user_id, amount, received_by, note)
         VALUES (p_store_id, p_rider_user_id, p_amount, p_actor_id, p_note)
      RETURNING id INTO v_id;

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION record_rider_handover IS
    'A rider hands cash over, any number of times in a day. The FK to store_members(..., ''rider'') is what refuses a hand-over credited to somebody who is not a rider here.';


-- -----------------------------------------------------------------------------
-- 6. Closing a rider's day
-- -----------------------------------------------------------------------------
-- THE THREE FIGURES ARE COMPUTED, NOT TAKEN ON FAITH. "Cash orders delivered"
-- is the sum of CONFIRMED cash deliveries this rider made today — confirmed,
-- because an order still waiting on confirm_cash_payment() has no trustworthy
-- figure yet, and the Orders board's own "Needs closing" column is where that
-- gets resolved first. "Handed in today" is the sum of this rider's own
-- hand-overs today. Both are read fresh and CAPTURED into the settlement row,
-- per V007's own comment — a settled record must not change when a later
-- order edit would otherwise recompute it.
--
-- "TODAY" IS THE STORE'S OWN BUSINESS DATE, from store_local() (V021) — not
-- passed by the caller, so a settlement cannot be mis-dated by a client clock.
--
-- THE SHORTFALL RULE IS ENFORCED HERE, NOT LEFT TO THE RAW CHECK, for the
-- same reason V022's request_refund() validates business state before
-- inserting: `rider_cash_settlements_shortfall_resolved` would otherwise
-- answer with its own constraint name. A caller passing a resolution when
-- there is nothing to resolve is just as wrong, so BOTH directions are forced
-- here — only a real shortfall carries a resolution through to the row.
--
-- 'discount' CALLS `record_manual_discount()` (V013) — "the customer
-- genuinely paid less" is a discount on the order, not a hole in the ledger,
-- and V013's own comment already names this as where its second gap outcome
-- lands. Reusing it rather than writing a second discount path is what keeps
-- `orders.discount_amount`'s one rule — order_discounts sums to it — true
-- regardless of which screen asked.

CREATE FUNCTION close_rider_day(
    p_store_id       uuid,
    p_rider_user_id  uuid,
    p_actor_id       uuid,
    p_counted_amount numeric,
    p_gap_resolution text DEFAULT NULL,
    p_gap_order_id   uuid DEFAULT NULL,
    p_gap_note       text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_date       date;
    v_expected   numeric(12,2);
    v_handed     numeric(12,2);
    v_gap        numeric(12,2);
    v_resolution text;
    v_order_id   uuid;
    v_note       text;
    v_order_rider uuid;
    v_id         uuid;
BEGIN
    IF p_counted_amount IS NULL OR p_counted_amount < 0 THEN
        RAISE EXCEPTION 'the counted amount must be given, even if it is zero';
    END IF;

    v_date := store_local(p_store_id, now())::date;

    IF EXISTS (SELECT 1 FROM rider_cash_settlements
                WHERE store_id = p_store_id AND rider_user_id = p_rider_user_id AND business_date = v_date) THEN
        RETURN NULL;
    END IF;

    -- cash_due_amount — WHAT WAS OWED — not cash_reported_amount, what was actually collected. A rider
    -- who under-collects at the door (Orders.dc.html's own "reported short") must not have that
    -- shortfall vanish into "expected" before the merchant ever sees it: the board's own copy says the
    -- gap "goes on the rider's line in Riders & cash, to settle at end of day", and a settlement built
    -- from what was reported rather than what was owed would already have absorbed it silently.
    SELECT COALESCE(sum(o.cash_due_amount), 0)
      INTO v_expected
      FROM orders o
     WHERE o.store_id = p_store_id AND o.rider_user_id = p_rider_user_id
       AND o.payment_method = 'cash' AND o.cash_confirmed_at IS NOT NULL
       AND store_local(p_store_id, o.cash_confirmed_at)::date = v_date;

    SELECT COALESCE(sum(h.amount), 0)
      INTO v_handed
      FROM rider_cash_handovers h
     WHERE h.store_id = p_store_id AND h.rider_user_id = p_rider_user_id
       AND store_local(p_store_id, h.handed_at)::date = v_date;

    v_gap := v_expected - v_handed - p_counted_amount;

    -- Forced both ways: a real shortfall must carry a resolution, and nothing
    -- that balances or runs over may carry one through — rider_cash_settlements_
    -- shortfall_resolved and _discount_names_order read the ROW, not the intent.
    IF v_gap > 0 THEN
        IF p_gap_resolution IS NULL OR p_gap_resolution NOT IN ('carry_over', 'discount', 'write_off') THEN
            RETURN NULL;
        END IF;
        IF p_gap_resolution = 'discount' THEN
            IF p_gap_order_id IS NULL OR btrim(COALESCE(p_gap_note, '')) = '' THEN
                RETURN NULL;
            END IF;
            SELECT rider_user_id INTO v_order_rider FROM orders WHERE id = p_gap_order_id AND store_id = p_store_id;
            IF v_order_rider IS DISTINCT FROM p_rider_user_id THEN
                RAISE EXCEPTION 'order % was not this rider''s delivery', p_gap_order_id;
            END IF;
        END IF;
        v_resolution := p_gap_resolution;
        v_order_id := CASE WHEN p_gap_resolution = 'discount' THEN p_gap_order_id ELSE NULL END;
        v_note := p_gap_note;
    ELSE
        v_resolution := NULL;
        v_order_id := NULL;
        v_note := NULL;
    END IF;

    IF v_resolution = 'discount' THEN
        PERFORM record_manual_discount(v_order_id, v_gap, v_note, p_actor_id);
    END IF;

    INSERT INTO rider_cash_settlements
        (store_id, rider_user_id, business_date, expected_amount, handed_over_amount, counted_amount,
         gap_resolution, gap_order_id, gap_note, closed_by)
         VALUES (p_store_id, p_rider_user_id, v_date, v_expected, v_handed, p_counted_amount,
                 v_resolution, v_order_id, v_note, p_actor_id)
      RETURNING id INTO v_id;

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION close_rider_day IS
    'Closes one rider''s business day: captures what was expected and handed in, and resolves any shortfall — carried over, discounted on the named order (via record_manual_discount()), or written off. Null means already closed today, or a real shortfall with no resolution given.';


-- -----------------------------------------------------------------------------
-- 7. A carried-over debt, received later
-- -----------------------------------------------------------------------------
-- The ONLY update `rider_cash_settlements_freeze` (V007) allows: the figures
-- a closed day recorded stay fixed, but a debt that followed the rider to a
-- later shift can still be marked received.

CREATE FUNCTION receive_carried_over_cash(p_settlement_id uuid, p_store_id uuid, p_actor_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    UPDATE rider_cash_settlements
       SET carried_over_settled_at = now(), carried_over_settled_by = p_actor_id
     WHERE id = p_settlement_id AND store_id = p_store_id
       AND gap_resolution = 'carry_over' AND carried_over_settled_at IS NULL;

    RETURN FOUND;
END;
$init$;

COMMENT ON FUNCTION receive_carried_over_cash IS
    'Marks a carried-over shortfall received. False means it was not there, not carried over, or already marked.';
