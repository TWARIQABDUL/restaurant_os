-- =============================================================================
-- V022 — the Orders board: every transition after "accept", the rider picker,
-- cash confirmation, and returns
-- =============================================================================
-- Milestone 20 of docs/migration/04-implementation-plan.md. Extends V004's state
-- machine and V007's rider/cash tables with the functions that actually move an
-- order through them — neither migration wrote one, on purpose: V004 built the
-- data the trigger checks against, V007 built the tables a rider's day is kept
-- in, and left the write side to whichever milestone first had a caller.
--
-- ONE EDGE ADDED to V004's order_status_transitions: returned → ready, for
-- "Try delivery again". Everything else is new functions, following accept()'s
-- own idiom from V021/milestone 19 — lock the row, check the precursor status,
-- and return false rather than raise when somebody already decided it. A
-- merchant's console has several screens open on the same order at once, the
-- same way the new-order alert does, so a double click is the ordinary case,
-- not the exceptional one.
--
-- STOCK, RELEASED WHERE IT WAS TAKEN. place_order() reserves stock for a
-- PENDING order, before anyone at the store has looked at it (milestone 17).
-- That means every order this migration can decline or cancel is already
-- holding stock nobody will ship, and until now nothing gave it back — a gap
-- neither V004 nor V017 closed because neither owned a caller that could
-- reach it. decline_order() and cancel_order() call release_stock() for
-- exactly this reason.
--
-- MONEY ON A RETURN IS NOT ONE RULE, IT IS TWO — because the two payment
-- methods are not symmetrical here the way they are elsewhere. A cash order
-- that never reached "delivered" was never marked paid (confirm_cash_payment
-- only runs after a rider hands cash over, or at the counter for pickup), so
-- closing its return moves no money — as `Orders.dc.html` itself says, "no
-- money changed hands, so there's nothing to refund." A MoMo order paid at
-- checkout, though, has real money sitting in the store's own pending pot
-- (V017's escrow, not yet released because the order was never delivered),
-- and closing the return has to give it back. `close_return()` reuses
-- `refund_settle()` for that rather than posting to the ledger by hand — the
-- lock order (refund, then order, then wallet) and the pot-selection logic
-- are V008's, tested, and a second implementation next to it would be the
-- exact risk V017's promotion consolidation was written to avoid.
--
-- A MERCHANT-REQUESTED REFUND WITH NO COMPLAINT IS NEW GROUND. V008 built
-- exactly two ways to create a `refunds` row, and both require a complaint to
-- already be open (`resolve_complaint`, `decide_escalated_complaint`) — but
-- its own column comment anticipated a refund "raised straight from the
-- order screen" with `complaint_id IS NULL`, which is exactly what the
-- Orders board's "Request a refund" panel needs for an order nobody has
-- complained about. `request_refund()` is that third path. It stays a
-- REQUEST, reviewed by Vendlyfy through the existing `approve_refund` /
-- `reject_refund` — unlike the automatic return refund above, a merchant
-- claiming a reason after delivery is exactly the kind of claim V008's own
-- header says the platform reviews, so this does not settle it early.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. One new edge: a failed delivery can be tried again
-- -----------------------------------------------------------------------------
-- V004 gave `returned` exactly one way out — closing it. The board draws a
-- second: put it back in Ready and assign somebody else. Both are real
-- outcomes of the same failure, decided by the merchant looking at why it
-- came back, so both need to exist rather than forcing every return through
-- "closed" even when a second attempt is the obvious answer.

INSERT INTO order_status_transitions (from_status, to_status, description) VALUES
    ('returned', 'ready', 'Retrying the delivery after it could not be completed');


-- -----------------------------------------------------------------------------
-- 2. A notification order_events couldn't cover
-- -----------------------------------------------------------------------------
-- V010 seeded eight notification_types and order_declined was one of them,
-- but a cancellation after acceptance is a different event from a decline
-- before it — the board's own copy treats them as different sentences
-- ("declined" vs "cancelled") because they mean different things to whoever
-- reads the inbox. Same shape as order_declined: store_staff, not an alert.

INSERT INTO notification_types
    (code, audience, visible_to_roles, tone, subject, route, required_payload_keys, is_alert, description) VALUES
    ('order_cancelled', 'store_staff', '{owner,admin,manager}', 'bad', 'order', '/app/orders',
     '{order_number,actor_name,reason}', false,
     'A member of staff cancelled an order after it was accepted, with the reason they gave.');


-- -----------------------------------------------------------------------------
-- 3. Declining and cancelling — the two ways an order stops without shipping
-- -----------------------------------------------------------------------------
-- Split into two functions rather than one with a target status, because
-- they start from different places (only `pending` can be declined) and say
-- different things to the inbox. Both release stock and both require a
-- reason: `Orders.dc.html`'s own reason panel disables its confirm button
-- until one is chosen, and a status change with no reason is a worse record
-- than a slower button.

CREATE FUNCTION decline_order(
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
    v_status  text;
    v_number  integer;
    v_lines   jsonb;
BEGIN
    IF btrim(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'declining an order needs a reason the customer reads';
    END IF;

    SELECT status, order_number INTO v_status, v_number
      FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF v_status <> 'pending' THEN
        RETURN false;
    END IF;

    UPDATE orders SET status = 'rejected' WHERE id = p_order_id;

    SELECT jsonb_agg(jsonb_build_object('variant_id', variant_id, 'quantity', quantity))
      INTO v_lines FROM order_items WHERE order_id = p_order_id;
    PERFORM release_stock(p_store_id, COALESCE(v_lines, '[]'::jsonb));

    INSERT INTO order_events (order_id, store_id, from_status, to_status, reason, note, actor_id, actor_role)
         VALUES (p_order_id, p_store_id, 'pending', 'rejected', p_reason, p_note, p_actor_id, p_actor_role);

    PERFORM notify(
        p_store_id => p_store_id,
        p_type_code => 'order_declined',
        p_idempotency_key => 'order_declined:' || p_order_id::text,
        p_payload => jsonb_build_object(
            'order_number', v_number,
            'actor_name', COALESCE((SELECT name FROM users WHERE id = p_actor_id), 'A member of staff'),
            'reason', p_reason),
        p_order_id => p_order_id);

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION decline_order IS
    'pending -> rejected, with a reason. Releases the stock place_order() reserved, since nothing else will.';


CREATE FUNCTION cancel_order(
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
    v_number integer;
    v_lines  jsonb;
BEGIN
    IF btrim(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'cancelling an order needs a reason the customer reads';
    END IF;

    SELECT status, order_number INTO v_status, v_number
      FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- The transitions table already refuses anything past `assigned` (a rider
    -- underway is not "cancelled", it is a return), so checking membership
    -- here only saves the round trip of attempting an illegal one.
    IF v_status NOT IN ('approved', 'preparing', 'ready', 'assigned') THEN
        RETURN false;
    END IF;

    UPDATE orders SET status = 'cancelled' WHERE id = p_order_id;

    SELECT jsonb_agg(jsonb_build_object('variant_id', variant_id, 'quantity', quantity))
      INTO v_lines FROM order_items WHERE order_id = p_order_id;
    PERFORM release_stock(p_store_id, COALESCE(v_lines, '[]'::jsonb));

    INSERT INTO order_events (order_id, store_id, from_status, to_status, reason, note, actor_id, actor_role)
         VALUES (p_order_id, p_store_id, v_status, 'cancelled', p_reason, p_note, p_actor_id, p_actor_role);

    PERFORM notify(
        p_store_id => p_store_id,
        p_type_code => 'order_cancelled',
        p_idempotency_key => 'order_cancelled:' || p_order_id::text,
        p_payload => jsonb_build_object(
            'order_number', v_number,
            'actor_name', COALESCE((SELECT name FROM users WHERE id = p_actor_id), 'A member of staff'),
            'reason', p_reason),
        p_order_id => p_order_id);

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION cancel_order IS
    'approved/preparing/ready/assigned -> cancelled, with a reason. Releases the stock place_order() reserved.';


-- -----------------------------------------------------------------------------
-- 4. The kitchen's own two steps
-- -----------------------------------------------------------------------------
-- Nothing about these two moves money or stock, which is what makes them
-- safe to write as a plain locked status change with no side effects beyond
-- the event — the same shape as accept() in V021.

CREATE FUNCTION start_preparing(p_order_id uuid, p_store_id uuid, p_actor_id uuid, p_actor_role text)
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND OR v_status <> 'approved' THEN
        RETURN false;
    END IF;

    UPDATE orders SET status = 'preparing' WHERE id = p_order_id;
    INSERT INTO order_events (order_id, store_id, from_status, to_status, actor_id, actor_role)
         VALUES (p_order_id, p_store_id, 'approved', 'preparing', p_actor_id, p_actor_role);
    RETURN true;
END;
$init$;

COMMENT ON FUNCTION start_preparing IS 'approved -> preparing.';


CREATE FUNCTION mark_ready(p_order_id uuid, p_store_id uuid, p_actor_id uuid, p_actor_role text)
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND OR v_status <> 'preparing' THEN
        RETURN false;
    END IF;

    UPDATE orders SET status = 'ready' WHERE id = p_order_id;
    INSERT INTO order_events (order_id, store_id, from_status, to_status, actor_id, actor_role)
         VALUES (p_order_id, p_store_id, 'preparing', 'ready', p_actor_id, p_actor_role);
    RETURN true;
END;
$init$;

COMMENT ON FUNCTION mark_ready IS 'preparing -> ready.';


-- -----------------------------------------------------------------------------
-- 5. The rider picker
-- -----------------------------------------------------------------------------
-- ASSIGNING AND REASSIGNING ARE ONE FUNCTION, because both are "this rider,
-- now" and the only difference is whether a status change comes with it.
-- V007's own FK — orders(rider_user_id, store_id, rider_member_role) into
-- store_members(user_id, store_id, role) — is what refuses a non-rider or a
-- rider from another store; this function does not re-check it; it is the
-- schema's job and duplicating it here would be a second answer to the same
-- question.
--
-- WHO IS ON DUTY IS NOT ENFORCED HERE, deliberately, matching V007's own
-- design: `rider_profiles.availability` is what the picker reads to grey a
-- row out, not a rule the database enforces at assignment. A manager who
-- knows a rider stepped out for five minutes can still hand them an order;
-- the picker's own filtering is the ordinary path, not the only one.

CREATE FUNCTION assign_rider(
    p_order_id      uuid,
    p_store_id      uuid,
    p_actor_id      uuid,
    p_actor_role    text,
    p_rider_user_id uuid
) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_status  text;
    v_fulfil  text;
    v_was     uuid;
BEGIN
    SELECT status, fulfilment_type, rider_user_id INTO v_status, v_fulfil, v_was
      FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF v_fulfil <> 'delivery' OR v_status NOT IN ('ready', 'assigned') THEN
        RETURN false;
    END IF;

    UPDATE orders SET status = 'assigned', rider_user_id = p_rider_user_id WHERE id = p_order_id;

    INSERT INTO order_events (order_id, store_id, from_status, to_status, actor_id, actor_role, note)
         VALUES (p_order_id, p_store_id, v_status, 'assigned', p_actor_id, p_actor_role,
                 CASE WHEN v_was IS NULL THEN 'Assigned to ' || COALESCE((SELECT name FROM users WHERE id = p_rider_user_id), 'a rider')
                      ELSE 'Reassigned from ' || COALESCE((SELECT name FROM users WHERE id = v_was), 'a rider')
                           || ' to ' || COALESCE((SELECT name FROM users WHERE id = p_rider_user_id), 'a rider') END);

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION assign_rider IS
    'ready -> assigned, or a same-status reassignment. Refuses a pickup order and a non-rider at the FK, not here.';


CREATE FUNCTION mark_picked_up(p_order_id uuid, p_store_id uuid, p_actor_id uuid, p_actor_role text)
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_status text;
    v_number integer;
    v_rider  uuid;
BEGIN
    SELECT status, order_number, rider_user_id INTO v_status, v_number, v_rider
      FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND OR v_status <> 'assigned' THEN
        RETURN false;
    END IF;

    UPDATE orders SET status = 'out' WHERE id = p_order_id;
    INSERT INTO order_events (order_id, store_id, from_status, to_status, actor_id, actor_role)
         VALUES (p_order_id, p_store_id, 'assigned', 'out', p_actor_id, p_actor_role);

    PERFORM notify(
        p_store_id => p_store_id,
        p_type_code => 'order_picked_up',
        p_idempotency_key => 'order_picked_up:' || p_order_id::text,
        p_payload => jsonb_build_object(
            'order_number', v_number,
            'rider_name', COALESCE((SELECT name FROM users WHERE id = v_rider), 'The rider')),
        p_order_id => p_order_id);

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION mark_picked_up IS 'assigned -> out: the rider has it and is on the way.';


CREATE FUNCTION mark_delivered(p_order_id uuid, p_store_id uuid, p_actor_id uuid, p_actor_role text)
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_status  text;
    v_number  integer;
    v_name    text;
BEGIN
    SELECT status, order_number, COALESCE(guest_name, (SELECT name FROM users WHERE id = customer_user_id))
      INTO v_status, v_number, v_name
      FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND OR v_status <> 'out' THEN
        RETURN false;
    END IF;

    UPDATE orders SET status = 'delivered', delivered_at = COALESCE(delivered_at, now()) WHERE id = p_order_id;
    INSERT INTO order_events (order_id, store_id, from_status, to_status, actor_id, actor_role)
         VALUES (p_order_id, p_store_id, 'out', 'delivered', p_actor_id, p_actor_role);

    PERFORM notify(
        p_store_id => p_store_id,
        p_type_code => 'order_delivered',
        p_idempotency_key => 'order_delivered:' || p_order_id::text,
        p_payload => jsonb_build_object('order_number', v_number, 'customer_name', COALESCE(v_name, 'the customer')),
        p_order_id => p_order_id);

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION mark_delivered IS
    'out -> delivered. A cash order is left unpaid here on purpose: confirm_cash_payment() is a separate step, run once the rider is back or the merchant hears from them.';


-- -----------------------------------------------------------------------------
-- 6. Collected in person
-- -----------------------------------------------------------------------------
-- A pickup order needs no rider and no separate cash-confirmation screen: the
-- customer is standing at the counter, so marking it collected and marking
-- cash received are the same moment. This calls confirm_cash_payment() rather
-- than writing payment_status itself, so there is exactly one place that
-- decides what "cash confirmed" means on an order.

CREATE FUNCTION mark_collected(p_order_id uuid, p_store_id uuid, p_actor_id uuid, p_actor_role text)
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_row record;
BEGIN
    SELECT status, fulfilment_type, payment_method, cash_due_amount
      INTO v_row
      FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF v_row.fulfilment_type <> 'pickup' OR v_row.status <> 'ready' THEN
        RETURN false;
    END IF;

    UPDATE orders SET status = 'collected' WHERE id = p_order_id;
    INSERT INTO order_events (order_id, store_id, from_status, to_status, actor_id, actor_role)
         VALUES (p_order_id, p_store_id, 'ready', 'collected', p_actor_id, p_actor_role);

    IF v_row.payment_method = 'cash' THEN
        PERFORM confirm_cash_payment(p_order_id, v_row.cash_due_amount, p_actor_id);
    END IF;

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION mark_collected IS
    'ready -> collected, pickup only. Confirms cash in the same statement, since collecting in person and paying in person are the same event.';


-- -----------------------------------------------------------------------------
-- 7. Returns — closing one, and trying again
-- -----------------------------------------------------------------------------

CREATE FUNCTION close_return(
    p_order_id   uuid,
    p_store_id   uuid,
    p_actor_id   uuid,
    p_actor_role text,
    p_restock    boolean
) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_row      record;
    v_lines    jsonb;
    v_refund   uuid;
    v_amount   numeric(12,2);
BEGIN
    SELECT status, payment_method, payment_status, total_amount, refunded_amount
      INTO v_row
      FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND OR v_row.status <> 'returned' THEN
        RETURN false;
    END IF;

    UPDATE orders SET status = 'closed_return' WHERE id = p_order_id;
    INSERT INTO order_events (order_id, store_id, from_status, to_status, note, actor_id, actor_role)
         VALUES (p_order_id, p_store_id, 'returned', 'closed_return',
                 CASE WHEN p_restock THEN 'Closed · items put back in stock' ELSE 'Closed · items not restocked' END,
                 p_actor_id, p_actor_role);

    IF p_restock THEN
        SELECT jsonb_agg(jsonb_build_object('variant_id', variant_id, 'quantity', quantity))
          INTO v_lines FROM order_items WHERE order_id = p_order_id;
        PERFORM release_stock(p_store_id, COALESCE(v_lines, '[]'::jsonb));
    END IF;

    -- Cash: "no money changed hands, so there's nothing to refund" — the order
    -- never reached `delivered`, so confirm_cash_payment() never ran and
    -- payment_status is still 'unpaid'. Nothing to reverse. Anything else —
    -- 'mtn_momo', 'airtel_money', a future provider — was paid up front and
    -- needs giving back; V006's own idiom for "not cash" is `<> 'cash'`, not a
    -- name for a specific provider, because a provider-specific check here
    -- would silently stop covering the next one V006 adds.
    --
    -- SUBTRACTING refunded_amount ALONE IS NOT ENOUGH, and testing against a seeded
    -- order that already carried an unrelated pending refund found it: refunds_total_check()
    -- refuses the moment PENDING + QUEUED + APPROVED exceeds the total, not just approved,
    -- so a second refund for the "remaining" balance can still overclaim against one that
    -- has not been decided yet. v_amount is therefore what refunds_total_check() itself
    -- would allow — the total minus everything already CLAIMED, not just everything paid.
    SELECT v_row.total_amount - COALESCE(sum(COALESCE(approved_amount, amount)), 0)
      INTO v_amount
      FROM refunds WHERE order_id = p_order_id AND status IN ('pending', 'queued', 'approved');
    IF v_row.payment_method <> 'cash' AND v_row.payment_status = 'paid' AND v_amount > 0 THEN
        INSERT INTO refunds (store_id, order_id, amount, reason_code, reason_note, requested_by, initiated_by)
             VALUES (p_store_id, p_order_id, v_amount, 'other',
                     'Order returned and closed: refunded automatically', p_actor_id, 'platform')
          RETURNING id INTO v_refund;
        -- refund_settle() posts the ledger entry and updates orders.refunded_amount / payment_status /
        -- settlement_status in one call — the same primitive approve_refund() wraps, so a returned-order
        -- refund and an AdminDisputes-approved one cannot disagree about how money leaves a pot.
        PERFORM refund_settle(v_refund, NULL, p_actor_id);
    END IF;

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION close_return IS
    'returned -> closed_return. Restocks if asked, and refunds a paid MoMo order automatically — a cash order that never reached delivered was never paid, so there is nothing to reverse.';


CREATE FUNCTION retry_delivery(p_order_id uuid, p_store_id uuid, p_actor_id uuid, p_actor_role text)
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND OR v_status <> 'returned' THEN
        RETURN false;
    END IF;

    -- rider_user_id cleared, not carried over: the whole point of trying again is that this rider (or
    -- whatever went wrong) is not simply repeated. `assign_rider()` picks the next one.
    UPDATE orders SET status = 'ready', rider_user_id = NULL WHERE id = p_order_id;
    INSERT INTO order_events (order_id, store_id, from_status, to_status, actor_id, actor_role, note)
         VALUES (p_order_id, p_store_id, 'returned', 'ready', p_actor_id, p_actor_role, 'Back in Ready · assign a rider');

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION retry_delivery IS 'returned -> ready, unassigning the rider so the picker starts fresh.';


-- -----------------------------------------------------------------------------
-- 8. A refund requested straight from the order, no complaint required
-- -----------------------------------------------------------------------------
-- V008 anticipated this ("complaint_id nullable... a refund raised straight
-- from the order screen") but never wrote the insert, because nothing before
-- milestone 20 needed a refund without a complaint behind it. This is that
-- insert. It stays a REQUEST — status 'pending', reviewed later through the
-- existing approve_refund()/reject_refund() — unlike close_return()'s
-- automatic one above, because a merchant's claim about a delivered order
-- is exactly the kind of thing V008's header says the platform reviews.

CREATE FUNCTION request_refund(
    p_order_id    uuid,
    p_store_id    uuid,
    p_actor_id    uuid,
    p_amount      numeric,
    p_reason_code text,
    p_reason_note text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_status  text;
    v_paid    text;
    v_total   numeric(12,2);
    v_refunded numeric(12,2);
    v_refund  uuid;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'a refund of % is not a refund', p_amount;
    END IF;

    SELECT status, payment_status, total_amount, refunded_amount
      INTO v_status, v_paid, v_total, v_refunded
      FROM orders WHERE id = p_order_id AND store_id = p_store_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_status NOT IN ('delivered', 'collected') OR v_paid <> 'paid' THEN
        RETURN NULL;
    END IF;

    -- NOT A COLUMN this order already has and this function reads once: `v_refunded` is APPROVED refunds
    -- only, and the same lesson close_return() learned applies here — a pending or queued refund already
    -- claims part of the total even though nothing has paid out yet. A bare RAISE here would also come back
    -- as the generic "records inconsistent" P0001 sentence (db/errors.ts), which is the exact gap VLCAT was
    -- added to close at milestone 16 for a different refusal — so this is a null, like every other business
    -- reason in this file, and the route reports it as a plain conflict rather than a database message.
    IF p_amount > v_total - v_refunded - (
        SELECT COALESCE(sum(COALESCE(approved_amount, amount)), 0) FROM refunds
         WHERE order_id = p_order_id AND status IN ('pending', 'queued')
    ) THEN
        RETURN NULL;
    END IF;

    -- One direct request at a time, same rule resolve_complaint() applies to a complaint-backed one — a
    -- second ask before the first is decided is not a second request, it is the same one asked twice.
    IF EXISTS (SELECT 1 FROM refunds
                WHERE order_id = p_order_id AND complaint_id IS NULL AND status IN ('pending', 'queued')) THEN
        RETURN NULL;
    END IF;

    INSERT INTO refunds (store_id, order_id, amount, reason_code, reason_note, requested_by, initiated_by)
         VALUES (p_store_id, p_order_id, p_amount, p_reason_code, p_reason_note, p_actor_id, 'merchant')
      RETURNING id INTO v_refund;

    RETURN v_refund;
END;
$init$;

COMMENT ON FUNCTION request_refund IS
    'A merchant asks Vendlyfy to refund a delivered order with no complaint behind it. Stays pending for approve_refund()/reject_refund() to decide — nothing leaves the wallet here.';
