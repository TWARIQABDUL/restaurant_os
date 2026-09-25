-- V008_complaints_and_disputes.sql
--
-- Milestone 9, third part. The complaint a customer files against an order, the
-- three things a merchant may do about it, and the decision Vendlyfy makes when
-- the two cannot agree.
--
-- Two boards describe one flow from opposite ends, and reading them together is
-- what settles the schema:
--
--   * Complaints.dc.html is the merchant's side. A complaint is filed BY THE
--     CUSTOMER FROM THEIR ORDER, so it always names an order. It has four states
--     — open, escalated, resolved, rejected — grouped into three tabs, where
--     "Closed" is resolved and rejected together. While it is open the merchant
--     picks exactly one of three actions, each needing a note: resolve, reject,
--     escalate. A resolution may also carry a refund, which is "sent to Vendlyfy
--     as a refund request" rather than paid on the spot. A closed complaint can be
--     REOPENED — "the customer, you or Vendlyfy" — which is what makes this a
--     cycle rather than a line.
--
--   * AdminDisputes.dc.html is Vendlyfy's side, and the important discovery is
--     that it is ONE queue over TWO things: refund requests (R-311) and escalated
--     complaints (D-047). The same decision panel serves both, and for a dispute
--     the decision "Refund the customer" moves money out of the store's wallet.
--     So a platform decision on a complaint IS a refund — it must travel the
--     refunds path that V005 built, not a second money path beside it.
--
-- What that forces, and it is the substance of this migration:
--
--   1. THE FIFTH REFUND STATE. "Approved · waiting for funds": the platform has
--      decided, the amount is fixed, and the store's balance does not cover it.
--      No money has moved. The board is explicit about the consequence —
--      "the refund waits and is taken as soon as the balance covers it. Payouts to
--      the store pause until then." That is a real state with real obligations,
--      and V005 deliberately left it for here (§5.3, delta 4).
--
--   2. THE PLATFORM CHOOSES THE AMOUNT. The decision panel is an editable field
--      defaulting to what was requested and bounded by the order total. So what
--      the store asked for and what was granted are two different numbers, and
--      refunds needed a second money column.
--
--   3. ONE LIVE REFUND PER COMPLAINT. A complaint can produce a refund request,
--      be rejected, be reopened and be escalated — and the platform must then
--      decide THAT request rather than raise a second one. The guard is a partial
--      unique index, so two refunds in flight against one complaint are
--      unrepresentable rather than merely avoided.
--
-- The three layers of idempotency V005 established apply here unchanged. On every
-- path that moves money: a single-shot claim (the status UPDATE, which the loser
-- of a race finds nothing to change), the ledger's idempotency key, and a
-- uniqueness constraint on the outcome.


-- =============================================================================
-- 1. The state machine, as data
-- =============================================================================
-- The same shape as order_status_transitions: every legal move is a row, and a
-- trigger refuses the rest. Unlike orders, NO complaint status is terminal —
-- every one of the four can be left, because reopening is the whole point of the
-- closed notes the board writes ("Resolved. The customer, you or Vendlyfy can
-- still reopen it.").

CREATE TABLE complaint_status_transitions (
    from_status text NOT NULL,
    to_status   text NOT NULL,
    description text NOT NULL,

    PRIMARY KEY (from_status, to_status)
);

COMMENT ON TABLE complaint_status_transitions IS
    'Every move a complaint may make. Enforced by a trigger, so an illegal jump is refused by the database rather than prevented by whichever code path remembered.';

INSERT INTO complaint_status_transitions (from_status, to_status, description) VALUES
    -- The merchant's three actions, each requiring a note.
    ('open',      'resolved',  'Merchant replied and considers it settled'),
    ('open',      'rejected',  'Merchant rejected it, with a reason the customer reads'),
    ('open',      'escalated', 'Merchant asked Vendlyfy to decide'),

    -- Vendlyfy's decision on an escalation.
    ('escalated', 'resolved',  'Vendlyfy refunded the customer'),
    ('escalated', 'rejected',  'Vendlyfy rejected the escalation'),

    -- Reopening, which is why nothing here is terminal.
    ('resolved',  'open',      'Reopened — the customer was not satisfied'),
    ('rejected',  'open',      'Reopened by the customer or the merchant, who may then escalate');


-- =============================================================================
-- 2. complaints
-- =============================================================================
-- Current state only. The narrative — who said what, when, and why — lives in
-- complaint_events, which is where the board's timeline is rendered from. The
-- handful of "who did it last" columns here exist for one reason each, and it is
-- never convenience: each carries a foreign key that makes a wrong actor
-- unrepresentable.

CREATE TABLE complaints (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The reference support quotes. The boards show C-051 to the merchant and
    -- D-047 to Vendlyfy for the same complaint, and D-047/D-045 belong to two
    -- different stores — so the sequence is platform-wide, not per store, and the
    -- letter is presentation. Gaps are acceptable here, unlike orders.order_number
    -- which a merchant counts: nobody reconciles complaint numbers.
    reference_number bigint      NOT NULL GENERATED ALWAYS AS IDENTITY,

    store_id         uuid        NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    -- Always about an order. "Customers file these from their order."
    order_id         uuid        NOT NULL,

    -- The signed-in customer who filed it. NULL for a guest order, where the
    -- order itself carries the name and phone the merchant calls.
    customer_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,

    -- The same closed vocabulary as refunds.reason_code, deliberately. A
    -- complaint that becomes a refund must not change its reason on the way, and
    -- the merchant's list ("Missing item", "Food arrived cold", "Wrong item",
    -- "Late delivery") maps onto four of these five. The neutral code is stored;
    -- the words come from the industry template, so a pharmacy does not say food.
    reason_code      text        NOT NULL,

    -- "What the customer said" — always shown, always in quotes, so never empty.
    detail           text        NOT NULL,

    status           text        NOT NULL DEFAULT 'open',

    -- Who acted last, for the three actors the boards distinguish. These are the
    -- ONLY denormalised columns, and they record the most recent occurrence
    -- rather than the current state: after a reopen a complaint is open again yet
    -- closed_at still says when the merchant last closed it. The full history is
    -- in complaint_events; these exist to carry their foreign keys.
    -- closed_* covers resolving AND rejecting, which is the board's Closed tab.
    closed_by        uuid,
    closed_at        timestamptz,
    escalated_by     uuid,
    escalated_at     timestamptz,

    -- Vendlyfy's decision. decided_by references platform_members, not users, so
    -- a store's own admin deciding a dispute about their own store is refused by
    -- the schema rather than by an endpoint's guard.
    decided_by       uuid        REFERENCES platform_members (user_id) ON DELETE SET NULL,
    decided_at       timestamptz,
    decision         text,

    reopened_count   integer     NOT NULL DEFAULT 0,

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT complaints_status_values
        CHECK (status IN ('open', 'escalated', 'resolved', 'rejected')),
    CONSTRAINT complaints_reason_values CHECK (reason_code IN (
        'item_missing', 'wrong_item', 'quality_problem', 'arrived_late', 'other')),
    CONSTRAINT complaints_detail_not_blank CHECK (btrim(detail) <> ''),
    CONSTRAINT complaints_reopened_count_sane CHECK (reopened_count >= 0),

    -- A decision is a triple that arrives together or not at all, and it can only
    -- exist on a complaint that was escalated: Vendlyfy does not decide
    -- complaints nobody asked it about.
    CONSTRAINT complaints_decision_complete
        CHECK ((decided_at IS NULL) = (decision IS NULL)),
    CONSTRAINT complaints_decision_values
        CHECK (decision IS NULL OR decision IN ('refunded', 'rejected')),
    CONSTRAINT complaints_decision_needs_escalation
        CHECK (decided_at IS NULL OR escalated_at IS NOT NULL),

    -- A timestamp without the person is a record of nothing.
    CONSTRAINT complaints_closed_at_has_who
        CHECK (closed_at IS NOT NULL OR closed_by IS NULL),
    CONSTRAINT complaints_escalated_has_who
        CHECK ((escalated_at IS NULL) = (escalated_by IS NULL)),
    CONSTRAINT complaints_decided_has_who
        CHECK (decided_at IS NOT NULL OR decided_by IS NULL),

    -- Referenced by complaint_events and complaint_evidence, so their store_id
    -- cannot drift from this one.
    CONSTRAINT complaints_id_store_key UNIQUE (id, store_id),

    FOREIGN KEY (order_id, store_id) REFERENCES orders (id, store_id) ON DELETE RESTRICT,

    -- Whoever resolved or escalated it must be STAFF OF THIS STORE. store_id is
    -- already on the row and NOT NULL, so the composite key needs no companion
    -- column: MATCH SIMPLE means a NULL actor satisfies it, and a named one must
    -- match a membership. ON DELETE SET NULL names its column (PG 15+) because
    -- the default would try to null store_id too.
    FOREIGN KEY (closed_by, store_id) REFERENCES store_members (user_id, store_id)
        ON DELETE SET NULL (closed_by),
    FOREIGN KEY (escalated_by, store_id) REFERENCES store_members (user_id, store_id)
        ON DELETE SET NULL (escalated_by)
);

COMMENT ON TABLE complaints IS
    'A customer''s complaint about one order. Current state only: the thread is in complaint_events, and the timeline there is the record a dispute is argued from.';
COMMENT ON COLUMN complaints.reference_number IS
    'Platform-wide, gaps allowed. Shown as C-nnn to the merchant and D-nnn to Vendlyfy once escalated — one complaint, two prefixes.';
COMMENT ON COLUMN complaints.closed_at IS
    'When the MERCHANT last closed it, by resolving or rejecting — not proof that it is closed now. A reopened complaint keeps this and returns to open.';

CREATE UNIQUE INDEX complaints_reference_key ON complaints (reference_number);

-- ONE LIVE COMPLAINT PER ORDER. A customer tapping "Report a problem" twice is
-- reporting one problem, and a merchant must not have two threads to answer about
-- the same order. Once closed, a genuinely new problem may be filed.
CREATE UNIQUE INDEX complaints_one_live_per_order
    ON complaints (order_id) WHERE status IN ('open', 'escalated');

-- Serves: the merchant's three tabs, newest first. The Closed tab is two statuses
-- and reads this with status IN ('resolved','rejected').
CREATE INDEX complaints_store_status_idx ON complaints (store_id, status, created_at DESC);

-- Serves: Vendlyfy's Disputes queue, across every store, oldest first — the age
-- column the board sorts by.
CREATE INDEX complaints_escalated_idx ON complaints (created_at) WHERE status = 'escalated';

-- Serves: the order screen's "1 complaint" and the complaint's own order panel.
CREATE INDEX complaints_order_idx ON complaints (order_id);

-- Serves: CustomerAccount's complaints list.
CREATE INDEX complaints_customer_idx ON complaints (customer_user_id, created_at DESC)
    WHERE customer_user_id IS NOT NULL;

CREATE TRIGGER complaints_set_updated_at BEFORE UPDATE ON complaints
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE FUNCTION complaint_status_transition_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM complaint_status_transitions
         WHERE from_status = OLD.status AND to_status = NEW.status
    ) THEN
        RAISE EXCEPTION 'complaint % cannot move from % to %', OLD.id, OLD.status, NEW.status
            USING HINT = 'See complaint_status_transitions for the moves a complaint may make.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER complaints_status_transition BEFORE UPDATE OF status ON complaints
    FOR EACH ROW EXECUTE FUNCTION complaint_status_transition_check();


-- =============================================================================
-- 3. complaint_events — the thread, append-only and totally ordered
-- =============================================================================
-- This is the table the money argument is settled from, so it is append-only in
-- the same way order_events and wallet_ledger are. It goes further in two ways,
-- both because the board renders it as a sequence and highlights the last entry:
--
--   * a per-complaint SEQUENCE, because several events can share one now() and
--     "the latest" must not depend on which uuid sorted higher;
--   * a CHAIN, checked at commit: the first event is the filing, each event's
--     from_status is the previous event's to_status, and the last event's
--     to_status is the complaint's status. A status changed by hand without an
--     event, or an event that skips a step, cannot commit.

CREATE TABLE complaint_events (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    complaint_id uuid        NOT NULL,
    store_id     uuid        NOT NULL,

    -- Derived, never passed in. Assigned under the complaint's row lock, so the
    -- thread has one true order.
    sequence     integer     NOT NULL,

    event_type   text        NOT NULL,
    from_status  text,
    to_status    text        NOT NULL,

    -- WHO, in the four groups the boards colour differently — the customer, the
    -- store, the rider, Vendlyfy — plus the system, which acts without a person.
    actor_side   text        NOT NULL,
    actor_id     uuid,

    -- Derived from actor_side. It exists only to carry the composite foreign key
    -- below, which is what makes "a customer posting as Vendlyfy" impossible.
    actor_scope  text,

    note         text,

    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT complaint_events_sequence_positive CHECK (sequence >= 1),

    CONSTRAINT complaint_events_type_values CHECK (event_type IN (
        'filed', 'resolved', 'rejected', 'escalated', 'reopened',
        'refund_requested', 'platform_refunded', 'platform_rejected', 'note')),

    CONSTRAINT complaint_events_status_values
        CHECK (to_status IN ('open', 'escalated', 'resolved', 'rejected')
               AND (from_status IS NULL
                    OR from_status IN ('open', 'escalated', 'resolved', 'rejected'))),

    -- Only the filing has nothing before it.
    CONSTRAINT complaint_events_first_is_filed
        CHECK ((event_type = 'filed') = (from_status IS NULL)),

    -- The state each event type lands in is not the writer's choice. The ELSE
    -- covers the two kinds that add to the thread without moving it.
    CONSTRAINT complaint_events_type_agrees_with_status
        CHECK (to_status = CASE event_type
            WHEN 'filed'             THEN 'open'
            WHEN 'reopened'          THEN 'open'
            WHEN 'resolved'          THEN 'resolved'
            WHEN 'rejected'          THEN 'rejected'
            WHEN 'escalated'         THEN 'escalated'
            WHEN 'platform_refunded' THEN 'resolved'
            WHEN 'platform_rejected' THEN 'rejected'
            ELSE to_status END),

    -- A note or a refund request records something without moving the complaint.
    -- The IS NOT NULL is spelled out: `to_status = from_status` alone is NULL
    -- when from_status is NULL, and a CHECK that evaluates to NULL is satisfied.
    CONSTRAINT complaint_events_note_does_not_move
        CHECK (event_type NOT IN ('note', 'refund_requested')
               OR (from_status IS NOT NULL AND to_status = from_status)),

    CONSTRAINT complaint_events_actor_side_values
        CHECK (actor_side IN ('customer', 'store', 'rider', 'platform', 'system')),

    -- The system acts alone; the store, a rider and Vendlyfy are always a named
    -- person; a customer may be a guest with no account.
    CONSTRAINT complaint_events_system_has_no_actor
        CHECK (actor_side <> 'system' OR actor_id IS NULL),
    CONSTRAINT complaint_events_staff_are_named
        CHECK (actor_side IN ('customer', 'system') OR actor_id IS NOT NULL),

    CONSTRAINT complaint_events_scope_follows_actor
        CHECK ((actor_id IS NULL) = (actor_scope IS NULL)),

    -- users.scope separates a customer of one store from anyone who can hold a
    -- role. Pinning actor_scope to actor_side and referencing users (id, scope)
    -- means the side a message is shown on cannot disagree with what the account
    -- actually is. The trigger below derives it, so this CHECK is unreachable
    -- through ordinary SQL — it is here for the cases a trigger does not cover:
    -- session_replication_role = replica, a restore, or a future bug in the
    -- trigger itself.
    CONSTRAINT complaint_events_scope_matches_side
        CHECK (actor_scope IS NULL
               OR actor_scope = CASE WHEN actor_side = 'customer' THEN 'store'
                                     ELSE 'platform' END),

    CONSTRAINT complaint_events_complaint_sequence_key UNIQUE (complaint_id, sequence),

    FOREIGN KEY (complaint_id, store_id) REFERENCES complaints (id, store_id) ON DELETE CASCADE,

    -- RESTRICT, not SET NULL: this table is append-only, so a SET NULL cascade is an
    -- UPDATE the trigger below refuses anyway — with a message about append-only
    -- rather than about the delete. A person who took part in a dispute cannot be
    -- deleted; anonymising their user row is a separate, deliberate act.
    FOREIGN KEY (actor_id, actor_scope) REFERENCES users (id, scope) ON DELETE RESTRICT
);

COMMENT ON TABLE complaint_events IS
    'The complaint thread: append-only, totally ordered per complaint, and chained so the status and the timeline cannot disagree. The CASCADE above is unreachable — the append-only trigger refuses the delete — which is deliberate: a complaint, once filed, stays.';
COMMENT ON COLUMN complaint_events.actor_side IS
    'The four groups the boards colour separately, plus system. Not the role: actor_id and the memberships hold that.';

-- Serves: the timeline, oldest first, which is the only way it is ever read.
CREATE INDEX complaint_events_thread_idx ON complaint_events (complaint_id, sequence);


CREATE FUNCTION complaint_events_prepare() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    -- Derive the scope from the side. Anything other than the five known sides is
    -- left alone so that complaint_events_actor_side_values reports the real
    -- problem instead of this trigger inventing a scope for it.
    -- Two constraints below both refuse "the system, acting as a person", and
    -- which one PostgreSQL reports is not something the schema decides. Say it
    -- here, where the message can be the useful one; the constraint stays as the
    -- guarantee for writers this trigger does not see.
    IF NEW.actor_side = 'system' AND NEW.actor_id IS NOT NULL THEN
        RAISE EXCEPTION 'the system acts on its own, not as %', NEW.actor_id
            USING HINT = 'actor_side = system means there is no person behind the event.';
    END IF;

    IF NEW.actor_id IS NULL THEN
        NEW.actor_scope := NULL;
    ELSIF NEW.actor_side = 'customer' THEN
        NEW.actor_scope := 'store';
    ELSIF NEW.actor_side IN ('store', 'rider', 'platform') THEN
        NEW.actor_scope := 'platform';
    END IF;

    -- The thread's order. max() over the complaint's own rows, taken while the
    -- writers hold the complaint row lock; two events racing on one complaint
    -- collide on the unique key rather than sharing a number.
    SELECT COALESCE(max(sequence), 0) + 1 INTO NEW.sequence
      FROM complaint_events WHERE complaint_id = NEW.complaint_id;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER complaint_events_prepare BEFORE INSERT ON complaint_events
    FOR EACH ROW EXECUTE FUNCTION complaint_events_prepare();


CREATE FUNCTION complaint_events_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    RAISE EXCEPTION 'complaint_events is append-only (attempted % on complaint %)', TG_OP, OLD.complaint_id
        USING HINT = 'A thread that can be rewritten settles nothing. Append a correcting event instead.';
END;
$init$;

CREATE TRIGGER complaint_events_no_update BEFORE UPDATE OR DELETE ON complaint_events
    FOR EACH ROW EXECUTE FUNCTION complaint_events_append_only();


-- The chain. Deferred, because a complaint and its filing event are written in
-- one transaction and neither can be valid before the other exists.
CREATE FUNCTION complaint_thread_chain_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_complaint uuid;
    v_status    text;
    v_last      text;
    v_count     bigint;
    v_break     record;
BEGIN
    -- Written as a branch, not as a CASE expression: plpgsql compiles an
    -- expression as one SQL statement and resolves EVERY field in it, so
    -- `CASE ... THEN NEW.id ELSE NEW.complaint_id END` fails on the table that has
    -- no complaint_id. Two tables, one function, two field names.
    IF TG_TABLE_NAME = 'complaints' THEN
        v_complaint := NEW.id;
    ELSE
        v_complaint := NEW.complaint_id;
    END IF;

    SELECT status INTO v_status FROM complaints WHERE id = v_complaint;
    IF NOT FOUND THEN
        -- The complaint went away in this transaction; nothing to say about it.
        RETURN NULL;
    END IF;

    SELECT count(*) INTO v_count FROM complaint_events WHERE complaint_id = v_complaint;
    IF v_count = 0 THEN
        RAISE EXCEPTION 'complaint % has no events', v_complaint
            USING HINT = 'Every complaint begins with a filed event. Use file_complaint().';
    END IF;

    -- The first event is the filing.
    IF NOT EXISTS (
        SELECT 1 FROM complaint_events
         WHERE complaint_id = v_complaint AND sequence = 1 AND event_type = 'filed'
    ) THEN
        RAISE EXCEPTION 'complaint % does not begin with a filed event', v_complaint;
    END IF;

    -- Every step follows the one before it.
    SELECT * INTO v_break FROM (
        SELECT sequence, from_status,
               lag(to_status) OVER (ORDER BY sequence) AS previous_to
          FROM complaint_events WHERE complaint_id = v_complaint
    ) chain
     WHERE sequence > 1 AND from_status IS DISTINCT FROM previous_to
     ORDER BY sequence LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'complaint % event % starts from % but the event before it ended at %',
            v_complaint, v_break.sequence, v_break.from_status, v_break.previous_to
            USING HINT = 'The thread is a chain. Write events through the complaint functions, which move the status and record it together.';
    END IF;

    -- And the complaint says what its last event says.
    SELECT to_status INTO v_last FROM complaint_events
     WHERE complaint_id = v_complaint ORDER BY sequence DESC LIMIT 1;

    IF v_last <> v_status THEN
        RAISE EXCEPTION 'complaint % is % but its last event ended at %', v_complaint, v_status, v_last
            USING HINT = 'A status moved without an event, or an event was written without moving the status.';
    END IF;

    RETURN NULL;
END;
$init$;

CREATE CONSTRAINT TRIGGER complaints_thread_chain_check
    AFTER INSERT OR UPDATE OF status ON complaints
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION complaint_thread_chain_check();

CREATE CONSTRAINT TRIGGER complaint_events_chain_check
    AFTER INSERT ON complaint_events
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION complaint_thread_chain_check();


-- =============================================================================
-- 4. complaint_evidence
-- =============================================================================
-- What the argument is made of. AdminDisputes lists a customer photo, the store's
-- packing photo, a rider handover and a GPS log side by side, and which side
-- produced a piece of evidence is the whole point of showing it.
--
-- The file itself is not here. Image storage is still an open decision — the
-- existing Supabase bucket behind signed URLs, or S3/R2 — so this records the key
-- and the label, and the object store holds the bytes.

CREATE TABLE complaint_evidence (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    complaint_id uuid        NOT NULL,
    store_id     uuid        NOT NULL,

    side         text        NOT NULL,
    kind         text        NOT NULL,

    -- What the queue shows: "Customer photo · wrap in bag", "Rider photo at gate".
    label        text        NOT NULL,

    storage_key  text,
    content_type text,
    byte_size    bigint,

    -- RESTRICT for the same reason as complaint_events: insert-only tables cannot
    -- carry SET NULL, because that cascade is an UPDATE.
    uploaded_by  uuid        REFERENCES users (id) ON DELETE RESTRICT,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT complaint_evidence_side_values
        CHECK (side IN ('customer', 'store', 'rider', 'platform')),
    CONSTRAINT complaint_evidence_kind_values
        CHECK (kind IN ('photo', 'document', 'location_log', 'other')),
    CONSTRAINT complaint_evidence_label_not_blank CHECK (btrim(label) <> ''),

    -- A photo with no file is not evidence. IS NOT NULL never evaluates to NULL,
    -- so this CHECK cannot be satisfied by absence.
    CONSTRAINT complaint_evidence_file_present
        CHECK (kind NOT IN ('photo', 'document') OR storage_key IS NOT NULL),
    CONSTRAINT complaint_evidence_byte_size_sane
        CHECK (byte_size IS NULL OR byte_size > 0),

    FOREIGN KEY (complaint_id, store_id) REFERENCES complaints (id, store_id) ON DELETE CASCADE
);

COMMENT ON TABLE complaint_evidence IS
    'Photos, documents and logs attached to a complaint, labelled by the side that produced them. Insert-only: evidence that can be withdrawn after the fact is not evidence.';

CREATE INDEX complaint_evidence_complaint_idx ON complaint_evidence (complaint_id, created_at);

CREATE FUNCTION complaint_evidence_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    RAISE EXCEPTION 'complaint_evidence is insert-only (attempted % on complaint %)', TG_OP, OLD.complaint_id
        USING HINT = 'Evidence that can be removed after a decision is not evidence.';
END;
$init$;

CREATE TRIGGER complaint_evidence_no_update BEFORE UPDATE OR DELETE ON complaint_evidence
    FOR EACH ROW EXECUTE FUNCTION complaint_evidence_append_only();


-- =============================================================================
-- 5. refunds — the fifth state, and an amount the platform chooses
-- =============================================================================
-- V005 shipped refunds with three states and one amount, and said so: §5.3's
-- fourth delta is "a fifth refund state — approved, waiting for funds". This is
-- that state, plus the two columns AdminDisputes makes necessary.
--
-- WHY TWO AMOUNTS. The decision panel is an editable field, defaulting to what
-- the store asked for and bounded by the order total. So "requested" and "granted"
-- are different facts, and collapsing them would lose the one a merchant argues
-- from. amount stays what was asked; approved_amount is what Vendlyfy granted.
--
-- WHY settled_at. It makes the sharpest available statement about this table
-- true by construction: a refund is 'approved' EXACTLY WHEN the money has left the
-- wallet. Before V008 'approved' meant both "decided" and "paid", which is fine
-- until the two can happen at different times — and 'queued' is precisely the
-- state where they do.

ALTER TABLE refunds
    ADD COLUMN reference_number bigint NOT NULL GENERATED ALWAYS AS IDENTITY,

    -- What Vendlyfy granted. NULL until decided.
    ADD COLUMN approved_amount  numeric(12,2),

    -- When the money actually left. NULL while queued.
    ADD COLUMN settled_at       timestamptz,

    -- The complaint this refund came out of, when it came out of one. NULL for a
    -- refund raised straight from the order screen.
    ADD COLUMN complaint_id     uuid,

    ADD COLUMN initiated_by     text NOT NULL DEFAULT 'merchant';

-- Existing rows, before the new constraints can speak about them. A refund that
-- was approved under V005 was paid at the moment it was approved.
UPDATE refunds SET approved_amount = amount, settled_at = reviewed_at
 WHERE status = 'approved';

ALTER TABLE refunds
    DROP CONSTRAINT refunds_status_values,
    ADD  CONSTRAINT refunds_status_values
         CHECK (status IN ('pending', 'queued', 'approved', 'rejected')),

    ADD  CONSTRAINT refunds_initiated_by_values
         CHECK (initiated_by IN ('merchant', 'platform')),

    -- Decided means there is a granted amount; undecided means there is not.
    ADD  CONSTRAINT refunds_approved_amount_agrees
         CHECK ((status IN ('queued', 'approved')) = (approved_amount IS NOT NULL)),
    ADD  CONSTRAINT refunds_approved_amount_positive
         CHECK (approved_amount IS NULL OR approved_amount > 0),

    -- The invariant the queue exists for.
    ADD  CONSTRAINT refunds_settled_means_paid
         CHECK ((status = 'approved') = (settled_at IS NOT NULL)),

    ADD  CONSTRAINT refunds_complaint_same_store
         FOREIGN KEY (complaint_id, store_id) REFERENCES complaints (id, store_id)
         ON DELETE RESTRICT;

COMMENT ON COLUMN refunds.amount IS
    'What the merchant asked for. Never changed afterwards, because it is what they argue from.';
COMMENT ON COLUMN refunds.approved_amount IS
    'What Vendlyfy granted, which the decision panel lets them lower or raise up to the order total. NULL until decided.';
COMMENT ON COLUMN refunds.settled_at IS
    'When the money left the wallet. A refund is approved exactly when this is set; queued is decided but unpaid.';

CREATE UNIQUE INDEX refunds_reference_key ON refunds (reference_number);

-- ONE REFUND IN FLIGHT PER COMPLAINT. A complaint can be resolved with a refund
-- request, reopened, and escalated — and Vendlyfy must then decide THAT request
-- rather than raise a second one beside it. 'approved' is deliberately NOT in the
-- predicate: a reopened complaint may earn a further partial refund, and the cap
-- on the total is the order, enforced by refunds_total_check.
CREATE UNIQUE INDEX refunds_one_live_per_complaint
    ON refunds (complaint_id)
    WHERE complaint_id IS NOT NULL AND status IN ('pending', 'queued');

-- Serves: the payout pause. "Payouts to the store pause until then."
CREATE INDEX refunds_queued_idx ON refunds (store_id) WHERE status = 'queued';

-- Serves: the complaint detail's refund panel.
CREATE INDEX refunds_complaint_idx ON refunds (complaint_id) WHERE complaint_id IS NOT NULL;


-- Replaced because both sums move: what an order records as refunded is now the
-- sum of GRANTED amounts, and what is claimed against an order must count the
-- queued ones too — otherwise a store could ask for the rest of an order while a
-- refund for it waits for funds.
CREATE OR REPLACE FUNCTION refunds_total_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_order    uuid;
    v_total    numeric(12,2);
    v_recorded numeric(12,2);
    v_approved numeric(12,2);
    v_claimed  numeric(12,2);
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        v_order := CASE TG_OP WHEN 'DELETE' THEN OLD.id ELSE NEW.id END;
    ELSE
        v_order := CASE TG_OP WHEN 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
    END IF;

    SELECT total_amount, refunded_amount INTO v_total, v_recorded
      FROM orders WHERE id = v_order;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(sum(approved_amount) FILTER (WHERE status = 'approved'), 0),
           COALESCE(sum(COALESCE(approved_amount, amount))
                    FILTER (WHERE status IN ('pending', 'queued', 'approved')), 0)
      INTO v_approved, v_claimed
      FROM refunds WHERE order_id = v_order;

    IF v_approved <> v_recorded THEN
        RAISE EXCEPTION 'order % records % refunded but its approved refunds sum to %', v_order, v_recorded, v_approved
            USING HINT = 'orders.refunded_amount is the sum of approved refunds, maintained by approve_refund().';
    END IF;

    IF v_claimed > v_total THEN
        RAISE EXCEPTION 'refunds claimed on order % total % but the order was %', v_order, v_claimed, v_total
            USING HINT = 'Refunds awaiting a decision, awaiting funds, and already paid cannot exceed what the customer paid.';
    END IF;

    RETURN NULL;
END;
$init$;


-- =============================================================================
-- 6. wallet_post — the documented SQLSTATE, made true
-- =============================================================================
-- V005 declared two custom SQLSTATEs so the application could tell a 409 from a
-- 500, and named VLFND for insufficient funds — but the raise it described was
-- left as a generic check_violation, which nothing can safely distinguish from
-- any other failing CHECK.
--
-- It is needed now. settle_queued_refunds sweeps many stores in one call, and if
-- another writer takes a balance between the check and the post, that one refund
-- must be skipped and left queued — not allowed to abort the sweep. Catching
-- check_violation to do that would swallow every other constraint in the schema.
--
-- The body is otherwise unchanged from V005.

CREATE OR REPLACE FUNCTION wallet_post(
    p_store_id        uuid,
    p_pot             text,
    p_entry_type      text,
    p_amount          numeric,
    p_idempotency_key text,
    p_counterparty    text    DEFAULT NULL,
    p_transfer_id     uuid    DEFAULT NULL,
    p_order_id        uuid    DEFAULT NULL,
    p_momo_transaction_id uuid DEFAULT NULL,
    p_refund_id       uuid    DEFAULT NULL,
    p_withdrawal_id   uuid    DEFAULT NULL,
    p_note            text    DEFAULT NULL,
    p_created_by      uuid    DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_existing uuid;
    v_sequence bigint;
    v_balance  numeric(12,2);
    v_id       uuid;
BEGIN
    IF p_amount = 0 THEN
        RAISE EXCEPTION 'a ledger entry of zero moves nothing';
    END IF;

    -- The store's money is serialised here. Every post takes this lock first, so a
    -- store's entries have a total order and two concurrent posts cannot both read
    -- the same "previous balance".
    PERFORM 1 FROM wallets WHERE store_id = p_store_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'store % has no wallet', p_store_id;
    END IF;

    -- Layer 2: already posted. Return the same entry rather than a second one.
    SELECT id INTO v_existing FROM wallet_ledger
     WHERE store_id = p_store_id AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
        RETURN v_existing;
    END IF;

    SELECT COALESCE(max(sequence), 0) + 1 INTO v_sequence
      FROM wallet_ledger WHERE store_id = p_store_id AND pot = p_pot;

    SELECT COALESCE(balance_after, 0) INTO v_balance
      FROM wallet_ledger WHERE store_id = p_store_id AND pot = p_pot
     ORDER BY sequence DESC LIMIT 1;
    v_balance := COALESCE(v_balance, 0) + p_amount;

    IF v_balance < 0 THEN
        RAISE EXCEPTION 'store % has % in its % pot, which cannot cover %',
            p_store_id, v_balance - p_amount, p_pot, -p_amount
            USING ERRCODE = 'VLFND',
                  HINT = 'A pot may not go negative. Nothing is spent that was not there.';
    END IF;

    INSERT INTO wallet_ledger (store_id, pot, sequence, entry_type, amount, balance_after,
                               transfer_id, counterparty, order_id, momo_transaction_id,
                               refund_id, withdrawal_id, idempotency_key, note, created_by)
         VALUES (p_store_id, p_pot, v_sequence, p_entry_type, p_amount, v_balance,
                 p_transfer_id, p_counterparty, p_order_id, p_momo_transaction_id,
                 p_refund_id, p_withdrawal_id, p_idempotency_key, p_note, p_created_by)
      RETURNING id INTO v_id;

    RETURN v_id;
END;
$init$;


-- =============================================================================
-- 7. Paying a refund out, or queueing it
-- =============================================================================
-- The one place a refund becomes money. Every caller goes through it: the
-- platform approving a request, the platform deciding an escalation, and the
-- sweep that settles a queue once funds arrive.
--
-- LOCK ORDER, which is not negotiable: refund, then order, then wallet. Every
-- other money path in the schema takes the order before the wallet
-- (release_eligible_orders does), and taking them the other way round here would
-- deadlock against it under load. This is also why the sweep below is a separate
-- call rather than something release_eligible_orders does at the end of its loop:
-- inside that transaction the order locks are already held.

CREATE FUNCTION refund_settle(
    p_refund_id   uuid,
    p_amount      numeric DEFAULT NULL,
    p_reviewed_by uuid    DEFAULT NULL
) RETURNS text
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store      uuid;
    v_order      uuid;
    v_requested  numeric(12,2);
    v_approved   numeric(12,2);
    v_status     text;
    v_amount     numeric(12,2);
    v_settlement text;
    v_total      numeric(12,2);
    v_refunded   numeric(12,2);
    v_pot        text;
    v_balance    numeric(12,2);
BEGIN
    -- LAYER 1, the single-shot claim. The status is part of the lock's predicate,
    -- so the loser of a race re-evaluates it after the winner commits and finds
    -- nothing to take.
    SELECT store_id, order_id, amount, approved_amount, status
      INTO v_store, v_order, v_requested, v_approved, v_status
      FROM refunds
     WHERE id = p_refund_id AND status IN ('pending', 'queued')
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'lost';
    END IF;

    v_amount := COALESCE(p_amount, v_approved, v_requested);

    -- A queued refund has already been decided. Settling it may not quietly
    -- change the figure: that would be a second decision wearing the first one's
    -- clothes.
    IF v_status = 'queued' AND p_amount IS NOT NULL AND p_amount <> v_approved THEN
        RAISE EXCEPTION 'refund % was approved at % and cannot settle at %', p_refund_id, v_approved, p_amount
            USING HINT = 'Reject the queued refund and decide again, so both decisions are on the record.';
    END IF;

    IF v_amount <= 0 THEN
        RAISE EXCEPTION 'a refund of % moves nothing', v_amount;
    END IF;

    SELECT settlement_status, total_amount, refunded_amount
      INTO v_settlement, v_total, v_refunded
      FROM orders WHERE id = v_order FOR UPDATE;

    -- WHICH POT the money leaves is decided by where it actually is, not by a
    -- guess — V005's rule, unchanged. While an order is in escrow its money sits
    -- in `pending`; once released it is in `available`. It matters twice here,
    -- because the shortfall is judged against the same pot.
    v_pot := CASE WHEN v_settlement = 'pending' THEN 'pending' ELSE 'available' END;

    SELECT CASE v_pot WHEN 'pending' THEN pending_balance ELSE available_balance END
      INTO v_balance
      FROM wallets WHERE store_id = v_store FOR UPDATE;

    IF v_balance < v_amount THEN
        -- Decided, unpaid, and now holding the store's payouts. No ledger entry:
        -- nothing has moved.
        IF v_status = 'pending' THEN
            UPDATE refunds
               SET status = 'queued', approved_amount = v_amount,
                   reviewed_by = p_reviewed_by, reviewed_at = now()
             WHERE id = p_refund_id;
        END IF;
        RETURN 'queued';
    END IF;

    UPDATE refunds
       SET status = 'approved', approved_amount = v_amount, settled_at = now(),
           reviewed_by = COALESCE(reviewed_by, p_reviewed_by),
           reviewed_at = COALESCE(reviewed_at, now())
     WHERE id = p_refund_id;

    -- LAYER 2, the ledger's own key. Unique per store, so even a caller that got
    -- past the claim cannot post the same refund twice.
    PERFORM wallet_post(
        p_store_id => v_store, p_pot => v_pot, p_entry_type => 'refund_paid',
        p_amount => -v_amount, p_idempotency_key => 'refund:' || p_refund_id::text,
        p_counterparty => 'customer', p_order_id => v_order, p_refund_id => p_refund_id,
        p_created_by => p_reviewed_by, p_note => 'Refund approved');

    -- Both columns in one statement, so the CHECK that ties payment_status to
    -- refunded_amount cannot see them disagree.
    UPDATE orders
       SET refunded_amount = v_refunded + v_amount,
           payment_status = CASE WHEN v_refunded + v_amount >= v_total THEN 'refunded'
                                 ELSE payment_status END,
           settlement_status = CASE WHEN v_refunded + v_amount >= v_total THEN 'refunded'
                                    ELSE settlement_status END
     WHERE id = v_order;

    RETURN 'paid';
END;
$init$;

COMMENT ON FUNCTION refund_settle IS
    'Pays a refund, or queues it when the pot it must leave cannot cover it. Returns paid, queued, or lost when another caller got there first. Locks refund, then order, then wallet.';


-- approve_refund keeps its name and its two-argument call, and gains the amount
-- the decision panel lets Vendlyfy choose. Dropped rather than replaced because
-- CREATE OR REPLACE cannot change a signature, and an overload would make every
-- existing two-argument call ambiguous.
--
-- ONE BEHAVIOUR CHANGE, deliberate: it no longer raises when the balance is
-- short. It queues, which is what the board asks for.
DROP FUNCTION approve_refund(uuid, uuid);

CREATE FUNCTION approve_refund(
    p_refund_id   uuid,
    p_reviewed_by uuid,
    p_amount      numeric DEFAULT NULL
) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    RETURN refund_settle(p_refund_id, p_amount, p_reviewed_by) <> 'lost';
END;
$init$;

COMMENT ON FUNCTION approve_refund IS
    'Approves a refund once, for the amount Vendlyfy chose or the amount asked. Pays it if the pot covers it and queues it if not. Returns false if it was already decided.';


-- reject_refund now reaches a QUEUED refund as well as a pending one. A refund
-- approved but never paid is the only way a store's payouts stay paused, so there
-- has to be a way to take the approval back — and the existing CHECK forces a
-- reason the merchant can read, which is what makes it a record rather than a
-- reversal. approved_amount goes back to NULL because the grant is withdrawn.
CREATE OR REPLACE FUNCTION reject_refund(p_refund_id uuid, p_reviewed_by uuid, p_reason text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF btrim(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'a rejected refund needs a reason the merchant can read';
    END IF;

    UPDATE refunds
       SET status = 'rejected', approved_amount = NULL,
           reviewed_by = p_reviewed_by, reviewed_at = now(),
           rejection_reason = p_reason
     WHERE id = p_refund_id AND status IN ('pending', 'queued');

    RETURN FOUND;
END;
$init$;

COMMENT ON FUNCTION reject_refund IS
    'Rejects a refund that has not been paid — undecided or queued. Returns false if it was already decided and settled.';


-- =============================================================================
-- 8. The queue draining itself
-- =============================================================================
-- "Taken as soon as the balance covers it." Run after anything that credits a
-- store — the escrow release sweep, a reversed withdrawal — and safe to run idly.
--
-- Two things it must not do. It must not pay a refund PARTLY: the board's promise
-- is one payment when the balance covers it, so a refund it cannot cover in full
-- stays where it is. And it must not let one store's race end the sweep, which is
-- what the VLFND handler is for: the balance is read under the wallet's lock, but
-- a different transaction can still commit between the sweep's own statements.

CREATE FUNCTION settle_queued_refunds(p_store_id uuid DEFAULT NULL)
    RETURNS TABLE (settled_refund_id uuid, settled_store_id uuid, settled_amount numeric)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    r        record;
    v_result text;
BEGIN
    FOR r IN
        SELECT f.id, f.store_id, f.approved_amount
          FROM refunds f
         WHERE f.status = 'queued'
           AND (p_store_id IS NULL OR f.store_id = p_store_id)
         -- Oldest first: a queue that reorders itself is not a queue.
         ORDER BY f.created_at, f.id
           FOR UPDATE OF f SKIP LOCKED
    LOOP
        BEGIN
            v_result := refund_settle(r.id, NULL, NULL);

            IF v_result = 'paid' THEN
                settled_refund_id := r.id;
                settled_store_id  := r.store_id;
                settled_amount    := r.approved_amount;
                RETURN NEXT;
            END IF;
        EXCEPTION WHEN SQLSTATE 'VLFND' THEN
            -- Someone took the balance in between. This refund stays queued and
            -- the sweep carries on; the subtransaction rolls back its own claim.
            NULL;
        END;
    END LOOP;
END;
$init$;

COMMENT ON FUNCTION settle_queued_refunds IS
    'Pays every queued refund a store can now cover, oldest first, all-or-nothing each. Run after any credit; idempotent and safe to run when there is nothing to do.';


-- =============================================================================
-- 9. What a queued refund holds up
-- =============================================================================
-- "Payouts to the store pause until then." A queued refund is money the store
-- owes a customer, decided and unpaid, so it has first claim on whatever arrives.
-- Reserving a payout ahead of it would be paying the merchant with the customer's
-- refund.
--
-- A third custom SQLSTATE, for the same reason as the first two: "you have no
-- balance" and "your payouts are held while a refund waits" are different things
-- to tell a merchant, with different remedies.
--
--   VLSTK  insufficient stock
--   VLFND  insufficient funds
--   VLHLD  payouts held
--
-- Otherwise unchanged from V005.

CREATE OR REPLACE FUNCTION request_withdrawal(
    p_store_id        uuid,
    p_amount          numeric,
    p_phone           text,
    p_idempotency_key text,
    p_requested_by    uuid DEFAULT NULL,
    p_initiated_by    text DEFAULT 'manual'
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_id     uuid;
    v_queued numeric(12,2);
BEGIN
    -- Idempotent on the caller's key: a double-clicked Withdraw returns the first
    -- request instead of reserving the money twice.
    SELECT id INTO v_id FROM withdrawals
     WHERE store_id = p_store_id AND idempotency_key = p_idempotency_key;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    -- The pause. Checked before anything is written, so a held payout leaves no
    -- half-made request behind.
    SELECT COALESCE(sum(approved_amount), 0) INTO v_queued
      FROM refunds WHERE store_id = p_store_id AND status = 'queued';

    IF v_queued > 0 THEN
        RAISE EXCEPTION 'payouts are paused: % is owed on refunds already approved', v_queued
            USING ERRCODE = 'VLHLD',
                  HINT = 'An approved refund waiting for funds is paid before the merchant is. It settles as soon as the balance covers it.';
    END IF;

    INSERT INTO withdrawals (store_id, amount, phone, idempotency_key, requested_by, initiated_by)
         VALUES (p_store_id, p_amount, p_phone, p_idempotency_key, p_requested_by, p_initiated_by)
      RETURNING id INTO v_id;

    -- The funds leave `available` now, not when the transfer completes. Otherwise
    -- the same balance could be withdrawn again while the first payout is in
    -- flight. If it cannot be covered, this raises and the withdrawal row goes with
    -- it — there is no state where a request exists without its money reserved.
    PERFORM wallet_post(
        p_store_id => p_store_id, p_pot => 'available', p_entry_type => 'withdrawal_reserved',
        p_amount => -p_amount, p_idempotency_key => 'withdrawal:' || v_id::text,
        p_counterparty => 'merchant payout', p_withdrawal_id => v_id,
        p_created_by => p_requested_by, p_note => 'Withdrawal requested, funds reserved');

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION request_withdrawal IS
    'Creates a payout request and reserves the funds in the same transaction. Idempotent per store key. Raises VLFND if available cannot cover it and VLHLD while an approved refund is waiting for funds, leaving no request behind either way.';


-- Escrow release now also waits on a QUEUED refund, for the same reason it waits
-- on an undecided one: money a customer is owed against an order should not be
-- moved about while that is unsettled. Otherwise unchanged from V005.
CREATE OR REPLACE FUNCTION release_eligible_orders(p_hold_minutes integer DEFAULT 60)
    RETURNS TABLE (released_order_id uuid, released_amount numeric)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    r    record;
    v_net numeric(12,2);
BEGIN
    FOR r IN
        SELECT o.id, o.store_id, o.total_amount, o.refunded_amount
          FROM orders o
         WHERE o.settlement_status = 'pending'
           AND o.paid_at IS NOT NULL
           AND o.paid_at + make_interval(mins => p_hold_minutes) <= now()
           -- A refund still being reviewed, or approved and waiting for funds,
           -- keeps the money where it is.
           AND NOT EXISTS (
               SELECT 1 FROM refunds f
                WHERE f.order_id = o.id AND f.status IN ('pending', 'queued'))
         ORDER BY o.id
           FOR UPDATE OF o SKIP LOCKED
    LOOP
        v_net := r.total_amount - r.refunded_amount;

        IF v_net > 0 THEN
            -- Deliberately NOT clamped to the pending balance. The old function used
            -- LEAST(net, pending_balance) as "belt and braces", which turned an
            -- inconsistency into a silent correction: one order released 200 more
            -- than it held and the next order absorbed the difference. If pending
            -- cannot cover this, wallet_post raises and the sweep fails loudly,
            -- which is the only useful behaviour.
            PERFORM wallet_transfer(
                p_store_id => r.store_id, p_from_pot => 'pending', p_to_pot => 'available',
                p_amount => v_net, p_idempotency_key => 'release:' || r.id::text,
                p_order_id => r.id, p_note => 'Hold window elapsed');
        END IF;

        UPDATE orders SET settlement_status = 'released' WHERE id = r.id;

        released_order_id := r.id;
        released_amount := v_net;
        RETURN NEXT;
    END LOOP;
END;
$init$;


-- =============================================================================
-- 10. The complaint itself — one function per action on the boards
-- =============================================================================
-- Every one of these moves the status AND writes the event, in one statement pair
-- under the complaint's own row lock. That is not tidiness: the chain check at the
-- end of the transaction refuses a status that moved without an event, so there is
-- no way to do half of it.
--
-- Each also carries the single-shot claim in the same place — the status in the
-- UPDATE's WHERE. A merchant whose second tap arrives after the first has
-- committed changes nothing and is told so, rather than filing a second refund
-- request against the same complaint.

CREATE FUNCTION file_complaint(
    p_order_id    uuid,
    p_reason_code text,
    p_detail      text,
    p_filed_by    uuid DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store    uuid;
    v_customer uuid;
    v_id       uuid;
BEGIN
    IF btrim(COALESCE(p_detail, '')) = '' THEN
        RAISE EXCEPTION 'a complaint needs the customer''s own words';
    END IF;

    SELECT store_id, customer_user_id INTO v_store, v_customer
      FROM orders WHERE id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'order % does not exist', p_order_id;
    END IF;

    -- The complaint belongs to whoever the ORDER says the customer is, and a
    -- signed-in filer must be that person. Otherwise one customer could file
    -- against another's order and read the merchant's reply.
    IF p_filed_by IS NOT NULL AND p_filed_by IS DISTINCT FROM v_customer THEN
        RAISE EXCEPTION 'user % did not place order %', p_filed_by, p_order_id
            USING HINT = 'A complaint is filed from the order, by the customer on it.';
    END IF;

    -- Filing twice is filing once. The partial unique index is what makes this
    -- safe against two concurrent taps: the second blocks, then finds the first.
    INSERT INTO complaints (store_id, order_id, customer_user_id, reason_code, detail)
         VALUES (v_store, p_order_id, v_customer, p_reason_code, btrim(p_detail))
    ON CONFLICT (order_id) WHERE status IN ('open', 'escalated') DO NOTHING
      RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT id INTO v_id FROM complaints
         WHERE order_id = p_order_id AND status IN ('open', 'escalated');
        RETURN v_id;
    END IF;

    INSERT INTO complaint_events
        (complaint_id, store_id, event_type, to_status, actor_side, actor_id, note)
         VALUES (v_id, v_store, 'filed', 'open', 'customer', v_customer, btrim(p_detail));

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION file_complaint IS
    'Files a complaint against an order, or returns the one already open for it. The customer comes from the order, not from the caller.';


CREATE FUNCTION resolve_complaint(
    p_complaint_id  uuid,
    p_actor_id      uuid,
    p_note          text,
    p_refund_amount numeric DEFAULT NULL,
    p_refund_reason text    DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store  uuid;
    v_order  uuid;
    v_reason text;
    v_status text;
    v_refund uuid;
BEGIN
    -- "Tell the customer what you did." The button is disabled without it, and so
    -- is this.
    IF btrim(COALESCE(p_note, '')) = '' THEN
        RAISE EXCEPTION 'resolving a complaint needs a note the customer reads';
    END IF;

    UPDATE complaints
       SET status = 'resolved', closed_by = p_actor_id, closed_at = now()
     WHERE id = p_complaint_id AND status = 'open'
     RETURNING store_id, order_id, reason_code INTO v_store, v_order, v_reason;

    IF NOT FOUND THEN
        SELECT status INTO v_status FROM complaints WHERE id = p_complaint_id;
        RAISE EXCEPTION 'complaint % cannot be resolved: it is %', p_complaint_id,
            COALESCE(v_status, 'not there')
            USING HINT = 'Only an open complaint can be resolved. Somebody else may have answered it.';
    END IF;

    INSERT INTO complaint_events
        (complaint_id, store_id, event_type, from_status, to_status, actor_side, actor_id, note)
         VALUES (p_complaint_id, v_store, 'resolved', 'open', 'resolved', 'store',
                 p_actor_id, btrim(p_note));

    IF p_refund_amount IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_refund_amount <= 0 THEN
        RAISE EXCEPTION 'a refund of % is not a refund', p_refund_amount;
    END IF;

    -- "Sent to Vendlyfy as a refund request" — a request, not a payment. Nothing
    -- leaves the wallet here; the platform decides it.
    IF EXISTS (SELECT 1 FROM refunds
                WHERE complaint_id = p_complaint_id AND status IN ('pending', 'queued')) THEN
        RAISE EXCEPTION 'complaint % already has a refund awaiting Vendlyfy', p_complaint_id
            USING HINT = 'One refund at a time per complaint. Wait for the decision on the first.';
    END IF;

    INSERT INTO refunds (store_id, order_id, complaint_id, amount, reason_code,
                         reason_note, requested_by, initiated_by)
         VALUES (v_store, v_order, p_complaint_id, p_refund_amount,
                 COALESCE(p_refund_reason, v_reason), btrim(p_note), p_actor_id, 'merchant')
      RETURNING id INTO v_refund;

    INSERT INTO complaint_events
        (complaint_id, store_id, event_type, from_status, to_status, actor_side, actor_id, note)
         VALUES (p_complaint_id, v_store, 'refund_requested', 'resolved', 'resolved', 'store',
                 p_actor_id, 'Refund of ' || p_refund_amount::text || ' requested');

    RETURN v_refund;
END;
$init$;

COMMENT ON FUNCTION resolve_complaint IS
    'The merchant resolves a complaint, optionally asking Vendlyfy to refund part of the order. Returns the refund request id, or NULL.';


CREATE FUNCTION reject_complaint(
    p_complaint_id uuid,
    p_actor_id     uuid,
    p_note         text
) RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store  uuid;
    v_status text;
BEGIN
    -- "Explain why. The customer sees your reason and can reopen it."
    IF btrim(COALESCE(p_note, '')) = '' THEN
        RAISE EXCEPTION 'rejecting a complaint needs a reason the customer reads';
    END IF;

    UPDATE complaints
       SET status = 'rejected', closed_by = p_actor_id, closed_at = now()
     WHERE id = p_complaint_id AND status = 'open'
     RETURNING store_id INTO v_store;

    IF NOT FOUND THEN
        SELECT status INTO v_status FROM complaints WHERE id = p_complaint_id;
        RAISE EXCEPTION 'complaint % cannot be rejected: it is %', p_complaint_id,
            COALESCE(v_status, 'not there');
    END IF;

    INSERT INTO complaint_events
        (complaint_id, store_id, event_type, from_status, to_status, actor_side, actor_id, note)
         VALUES (p_complaint_id, v_store, 'rejected', 'open', 'rejected', 'store',
                 p_actor_id, btrim(p_note));
END;
$init$;


CREATE FUNCTION escalate_complaint(
    p_complaint_id uuid,
    p_actor_id     uuid,
    p_note         text
) RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store  uuid;
    v_status text;
BEGIN
    -- "What should Vendlyfy look at?"
    IF btrim(COALESCE(p_note, '')) = '' THEN
        RAISE EXCEPTION 'an escalation needs to say what Vendlyfy should look at';
    END IF;

    UPDATE complaints
       SET status = 'escalated', escalated_by = p_actor_id, escalated_at = now()
     WHERE id = p_complaint_id AND status = 'open'
     RETURNING store_id INTO v_store;

    IF NOT FOUND THEN
        SELECT status INTO v_status FROM complaints WHERE id = p_complaint_id;
        RAISE EXCEPTION 'complaint % cannot be escalated: it is %', p_complaint_id,
            COALESCE(v_status, 'not there')
            USING HINT = 'Only an open complaint goes to Vendlyfy. A rejected one is reopened first.';
    END IF;

    INSERT INTO complaint_events
        (complaint_id, store_id, event_type, from_status, to_status, actor_side, actor_id, note)
         VALUES (p_complaint_id, v_store, 'escalated', 'open', 'escalated', 'store',
                 p_actor_id, btrim(p_note));
END;
$init$;


CREATE FUNCTION reopen_complaint(
    p_complaint_id uuid,
    p_side         text,
    p_actor_id     uuid DEFAULT NULL,
    p_note         text DEFAULT NULL
) RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store uuid;
    v_from  text;
BEGIN
    -- "The customer, you or Vendlyfy can still reopen it." A rider does not.
    IF p_side NOT IN ('customer', 'store', 'platform') THEN
        RAISE EXCEPTION 'a complaint is reopened by the customer, the store or Vendlyfy, not by %', p_side;
    END IF;

    -- The claim, taken as a lock rather than as an UPDATE, because the event needs
    -- the status this is LEAVING and RETURNING would hand back the new one.
    SELECT store_id, status INTO v_store, v_from
      FROM complaints
     WHERE id = p_complaint_id AND status IN ('resolved', 'rejected')
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'complaint % is not closed, so there is nothing to reopen', p_complaint_id;
    END IF;

    UPDATE complaints
       SET status = 'open', reopened_count = reopened_count + 1
     WHERE id = p_complaint_id;

    INSERT INTO complaint_events
        (complaint_id, store_id, event_type, from_status, to_status, actor_side, actor_id, note)
         VALUES (p_complaint_id, v_store, 'reopened', v_from, 'open', p_side, p_actor_id,
                 NULLIF(btrim(COALESCE(p_note, '')), ''));
END;
$init$;

COMMENT ON FUNCTION reopen_complaint IS
    'Reopens a resolved or rejected complaint. Any refund already requested against it is left alone: reopening restarts the conversation, not the money.';


CREATE FUNCTION decide_escalated_complaint(
    p_complaint_id uuid,
    p_decided_by   uuid,
    p_outcome      text,
    p_note         text,
    p_amount       numeric DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store   uuid;
    v_order   uuid;
    v_reason  text;
    v_status  text;
    v_refund  uuid;
    v_queued  boolean;
    v_result  text;
BEGIN
    IF p_outcome NOT IN ('refund', 'reject') THEN
        RAISE EXCEPTION 'a decision is refund or reject, not %', p_outcome;
    END IF;

    -- "Reason, shared with the store and the customer." Both sides read this, so
    -- there is no unexplained decision.
    IF btrim(COALESCE(p_note, '')) = '' THEN
        RAISE EXCEPTION 'a decision needs a reason the store and the customer both read';
    END IF;

    IF p_outcome = 'refund' AND (p_amount IS NULL OR p_amount <= 0) THEN
        RAISE EXCEPTION 'refunding the customer needs an amount';
    END IF;

    IF p_outcome = 'reject' AND p_amount IS NOT NULL THEN
        RAISE EXCEPTION 'a rejected escalation does not carry an amount';
    END IF;

    -- The claim. Two reviewers deciding the same dispute: one wins, and the other
    -- is told, rather than a second refund being paid.
    UPDATE complaints
       SET status     = CASE p_outcome WHEN 'refund' THEN 'resolved' ELSE 'rejected' END,
           decided_by = p_decided_by,
           decided_at = now(),
           decision   = CASE p_outcome WHEN 'refund' THEN 'refunded' ELSE 'rejected' END
     WHERE id = p_complaint_id AND status = 'escalated'
     RETURNING store_id, order_id, reason_code INTO v_store, v_order, v_reason;

    IF NOT FOUND THEN
        SELECT status INTO v_status FROM complaints WHERE id = p_complaint_id;
        RAISE EXCEPTION 'complaint % is not with Vendlyfy: it is %', p_complaint_id,
            COALESCE(v_status, 'not there')
            USING HINT = 'Only an escalated complaint is Vendlyfy''s to decide.';
    END IF;

    -- A refund the store already asked for, if there is one. It must be DECIDED,
    -- not joined by a second row — which is what the partial unique index on
    -- refunds.complaint_id enforces even if this were forgotten.
    SELECT id, status = 'queued' INTO v_refund, v_queued
      FROM refunds
     WHERE complaint_id = p_complaint_id AND status IN ('pending', 'queued')
       FOR UPDATE;

    IF p_outcome = 'reject' THEN
        IF v_refund IS NOT NULL THEN
            -- Rejecting the escalation settles the money question with it, and
            -- takes back an approval that was still waiting for funds. That is the
            -- only way a store's payouts stop being held.
            PERFORM reject_refund(v_refund, p_decided_by, btrim(p_note));
        END IF;

        INSERT INTO complaint_events
            (complaint_id, store_id, event_type, from_status, to_status, actor_side, actor_id, note)
             VALUES (p_complaint_id, v_store, 'platform_rejected', 'escalated', 'rejected',
                     'platform', p_decided_by, btrim(p_note));

        RETURN NULL;
    END IF;

    IF v_refund IS NULL THEN
        -- An escalation Vendlyfy upholds with no request behind it — D-047 on the
        -- board. It still travels the refunds path, because that is the only thing
        -- that maintains orders.refunded_amount and writes the ledger entry.
        INSERT INTO refunds (store_id, order_id, complaint_id, amount, reason_code,
                             reason_note, initiated_by)
             VALUES (v_store, v_order, p_complaint_id, p_amount, v_reason,
                     btrim(p_note), 'platform')
          RETURNING id INTO v_refund;
    END IF;

    v_result := refund_settle(v_refund, p_amount, p_decided_by);

    IF v_result = 'lost' THEN
        RAISE EXCEPTION 'refund % on complaint % was already settled', v_refund, p_complaint_id;
    END IF;

    INSERT INTO complaint_events
        (complaint_id, store_id, event_type, from_status, to_status, actor_side, actor_id, note)
         VALUES (p_complaint_id, v_store, 'platform_refunded', 'escalated', 'resolved',
                 'platform', p_decided_by,
                 btrim(p_note) || CASE WHEN v_result = 'queued'
                     THEN ' (waiting for the store''s balance to cover it)' ELSE '' END);

    RETURN v_refund;
END;
$init$;

COMMENT ON FUNCTION decide_escalated_complaint IS
    'Vendlyfy''s decision on an escalated complaint. A refund goes through the refunds path — deciding the store''s own request if there is one, raising it if not — and queues if the wallet cannot cover it. Returns the refund id, or NULL when rejected.';


-- =============================================================================
-- Recorded rather than invented
-- =============================================================================
-- 1. AdminDisputes lets Vendlyfy REOPEN anything it has closed, refunds included
--    ("reopenable: status !== 'open'"). Reopening a complaint is implemented,
--    because that is a conversation. Reopening a refund whose money has already
--    left is NOT, because it cannot undo the ledger entry and would read as a
--    second refund of the same order. The path that exists instead is the honest
--    one: a further refund request against the same order, capped by what the
--    customer actually paid. A refund that has NOT been paid — queued — can be
--    taken back, which is what reject_refund now reaches.
--
-- 2. Nothing here sends anything. "Both get an SMS" and "customer notified" are
--    real obligations on every path above, and notifications are the next part of
--    this milestone. There is no SMS provider yet either (§5.3, delta 10).
--
-- 3. The refund panel's "Store history" — "612 orders · 3 refunds in 90 days · 1
--    open dispute" — is derived at read time from orders, refunds and complaints.
--    It is not a column, because a stored counter is a second truth that drifts.
