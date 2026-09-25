-- V005_money.sql
--
-- Milestone 8, second half. Wallets, the ledger, MoMo transactions, refunds,
-- withdrawals, and the functions that move money.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE MODEL, stated plainly because everything below depends on it
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A store has two POTS: `pending` (held while an order can still be refunded) and
-- `available` (withdrawable). Neither may ever go negative.
--
-- Money moving BETWEEN pots writes TWO ledger rows sharing a transfer_id, and they
-- must sum to zero. This is the exact bug the old system had: releasing escrow
-- credited `available` and never debited `pending`, so the pending sum became "the
-- total ever held" rather than a balance, and the two could not be reconciled by
-- summing. See §7.2 of docs/migration/05-old-database-profile.md.
--
-- Money crossing the platform boundary — a customer paying, a merchant
-- withdrawing, a refund going out — writes ONE row that names its counterparty.
-- This is deliberately not a full double-entry system with external accounts: the
-- two pots are the only balances worth tracking, and giving a customer account an
-- unbounded negative balance would add arithmetic nobody reads. What is kept is
-- the property that matters: sum(amount) per pot IS that pot's balance, always.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- IDEMPOTENCY, in three independent layers
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A replayed MoMo webhook, a retried sweep, a double-clicked Approve — each must
-- move money exactly once. Every path has three guards, and any one of them is
-- sufficient:
--
--   1. A SINGLE-SHOT CLAIM. `UPDATE … WHERE status = 'pending' RETURNING` — whoever
--      wins the update owns the work. The loser gets no row and returns.
--   2. A LEDGER IDEMPOTENCY KEY, unique per store. wallet_post() returns the
--      existing entry instead of writing a second one.
--   3. A UNIQUENESS CONSTRAINT on the outcome — at most one successful collection
--      per order, so a second charge is unrepresentable rather than merely avoided.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ATOMICITY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every function here does all of its work in the caller's transaction. Stock is
-- reserved under row locks taken in a DETERMINISTIC ORDER, because two orders
-- containing the same two variants in opposite orders would otherwise deadlock.
-- The wallet row is the serialisation point for a store's money: every ledger
-- write locks it first, so a store's entries have a total order and its running
-- balance cannot interleave.


-- =============================================================================
-- 1. wallets
-- =============================================================================
-- The balances are a CACHE of the ledger, and the only writer is the ledger's own
-- trigger. A direct UPDATE of a balance is refused — see wallets_balances_derived.

CREATE TABLE wallets (
    store_id          uuid          PRIMARY KEY REFERENCES stores (id) ON DELETE RESTRICT,
    currency          char(3)       NOT NULL,
    pending_balance   numeric(12,2) NOT NULL DEFAULT 0,
    available_balance numeric(12,2) NOT NULL DEFAULT 0,
    updated_at        timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT wallets_balances_not_negative
        CHECK (pending_balance >= 0 AND available_balance >= 0),
    CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
);

COMMENT ON TABLE wallets IS
    'A store''s two pots. The balances are derived from wallet_ledger and maintained only by its trigger; a direct update is refused.';

-- Every store has a wallet from the moment it exists, so the money path never has
-- to ask whether one is there.
CREATE FUNCTION stores_create_wallet() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    INSERT INTO wallets (store_id, currency) VALUES (NEW.id, NEW.selling_currency)
        ON CONFLICT (store_id) DO NOTHING;
    RETURN NULL;
END;
$init$;

CREATE TRIGGER stores_wallet AFTER INSERT ON stores
    FOR EACH ROW EXECUTE FUNCTION stores_create_wallet();

CREATE TRIGGER wallets_set_updated_at BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO wallets (store_id, currency)
SELECT id, selling_currency FROM stores ON CONFLICT (store_id) DO NOTHING;


-- =============================================================================
-- 2. wallet_ledger
-- =============================================================================

CREATE TABLE wallet_ledger (
    id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id       uuid          NOT NULL REFERENCES wallets (store_id) ON DELETE RESTRICT,

    pot            text          NOT NULL,

    -- Monotonic per (store, pot). Makes the ledger an ordered chain rather than a
    -- bag of rows, so "what was the balance after this entry" has one answer.
    sequence       bigint        NOT NULL,

    entry_type     text          NOT NULL,

    -- Signed: negative is a debit. The old ledger implied direction from
    -- entry_type for some types and carried it in the sign for others, which is
    -- why summing it did not reconcile.
    amount         numeric(12,2) NOT NULL,

    -- The pot's balance after this entry. Checked against the previous entry, so
    -- the chain is self-verifying and a missing or reordered row is detectable.
    balance_after  numeric(12,2) NOT NULL,

    -- Set on both rows of an internal pot-to-pot movement; NULL for money crossing
    -- the platform boundary.
    transfer_id    uuid,

    -- Where external money came from or went to. Required exactly when there is no
    -- transfer_id, so no entry is anonymous.
    counterparty   text,

    order_id       uuid,
    momo_transaction_id uuid,
    refund_id      uuid,
    withdrawal_id  uuid,

    -- Layer 2 of the idempotency model. wallet_post() returns the existing row
    -- rather than writing a second.
    idempotency_key text         NOT NULL,

    note           text,
    created_by     uuid          REFERENCES users (id) ON DELETE SET NULL,
    created_at     timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT wallet_ledger_pot_values CHECK (pot IN ('pending', 'available')),
    CONSTRAINT wallet_ledger_amount_not_zero CHECK (amount <> 0),
    CONSTRAINT wallet_ledger_balance_not_negative CHECK (balance_after >= 0),
    CONSTRAINT wallet_ledger_sequence_positive CHECK (sequence >= 1),

    CONSTRAINT wallet_ledger_entry_type_values CHECK (entry_type IN (
        -- external, money in
        'order_payment_received',
        -- internal, two rows
        'escrow_released_out', 'escrow_released_in',
        -- external, money out and back
        'refund_paid', 'withdrawal_reserved', 'withdrawal_reversed',
        -- corrections, which must always be possible and always be visible
        'adjustment'
    )),

    -- An internal transfer has no counterparty; an external movement must name one.
    CONSTRAINT wallet_ledger_counterparty_agrees
        CHECK ((transfer_id IS NULL) = (counterparty IS NOT NULL)),

    CONSTRAINT wallet_ledger_sequence_key UNIQUE (store_id, pot, sequence),
    CONSTRAINT wallet_ledger_idempotency_key UNIQUE (store_id, idempotency_key)
);

COMMENT ON TABLE wallet_ledger IS
    'Append-only. sum(amount) per pot IS that pot''s balance, because every internal movement writes both sides. balance_after chains, so a missing row is detectable.';
COMMENT ON COLUMN wallet_ledger.idempotency_key IS
    'Unique per store. A replayed webhook or a retried sweep posts the same key and gets the existing entry back instead of moving money twice.';

-- Serves: the merchant's ledger screen — one store's entries, newest first.
CREATE INDEX wallet_ledger_store_created_idx ON wallet_ledger (store_id, created_at DESC);
-- Serves: reading the latest balance of a pot, which wallet_post does on every write.
CREATE INDEX wallet_ledger_pot_sequence_idx ON wallet_ledger (store_id, pot, sequence DESC);
-- Serves: "what happened to this order's money", on the order detail and in disputes.
CREATE INDEX wallet_ledger_order_idx ON wallet_ledger (order_id) WHERE order_id IS NOT NULL;
-- Serves: pairing the two halves of a transfer.
CREATE INDEX wallet_ledger_transfer_idx ON wallet_ledger (transfer_id) WHERE transfer_id IS NOT NULL;


CREATE FUNCTION wallet_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    RAISE EXCEPTION 'wallet_ledger is append-only (attempted % on entry %)', TG_OP, OLD.id
        USING HINT = 'Money history cannot be edited. Post an adjustment entry, which is visible, instead.';
END;
$init$;

CREATE TRIGGER wallet_ledger_no_change BEFORE UPDATE OR DELETE ON wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION wallet_ledger_append_only();


-- The chain check: this entry's balance_after must be the previous one plus this
-- amount, and its sequence must be the next. Enforced on INSERT so a hand-written
-- row cannot break the chain either.
CREATE FUNCTION wallet_ledger_chain_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_prev_sequence bigint;
    v_prev_balance  numeric(12,2);
BEGIN
    -- A zero amount is refused by wallet_ledger_amount_not_zero. Reporting it here
    -- as a balance problem would send the reader looking in the wrong place, so let
    -- the CHECK name it — the same reason the other triggers in this schema bail out
    -- on cases a constraint owns.
    IF NEW.amount = 0 THEN
        RETURN NEW;
    END IF;

    SELECT sequence, balance_after INTO v_prev_sequence, v_prev_balance
      FROM wallet_ledger
     WHERE store_id = NEW.store_id AND pot = NEW.pot AND id <> NEW.id
     ORDER BY sequence DESC LIMIT 1;

    v_prev_sequence := COALESCE(v_prev_sequence, 0);
    v_prev_balance  := COALESCE(v_prev_balance, 0);

    IF NEW.sequence <> v_prev_sequence + 1 THEN
        RAISE EXCEPTION 'ledger sequence for store % pot % must be %, not %',
            NEW.store_id, NEW.pot, v_prev_sequence + 1, NEW.sequence
            USING HINT = 'Post through wallet_post(), which allocates the sequence under the wallet lock.';
    END IF;

    IF NEW.balance_after <> v_prev_balance + NEW.amount THEN
        RAISE EXCEPTION 'ledger balance for store % pot % must be % after an amount of %, not %',
            NEW.store_id, NEW.pot, v_prev_balance + NEW.amount, NEW.amount, NEW.balance_after
            USING HINT = 'balance_after is not a figure to choose; it is the previous balance plus this amount.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER wallet_ledger_chain BEFORE INSERT ON wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION wallet_ledger_chain_check();


-- The wallet follows the ledger, in the same transaction, and this is the only
-- writer of a balance.
CREATE FUNCTION wallet_ledger_apply_to_wallet() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF NEW.pot = 'pending' THEN
        -- updated_at is maintained by wallets_set_updated_at, like every other table.
        UPDATE wallets SET pending_balance = NEW.balance_after WHERE store_id = NEW.store_id;
    ELSE
        UPDATE wallets SET available_balance = NEW.balance_after WHERE store_id = NEW.store_id;
    END IF;
    RETURN NULL;
END;
$init$;

CREATE TRIGGER wallet_ledger_apply AFTER INSERT ON wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION wallet_ledger_apply_to_wallet();


-- A balance may only change as a consequence of a ledger entry. pg_trigger_depth()
-- is 1 when somebody runs an UPDATE directly and 2 when the ledger's AFTER trigger
-- is the caller.
CREATE FUNCTION wallets_balances_derived() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF pg_trigger_depth() < 2
       AND (NEW.pending_balance IS DISTINCT FROM OLD.pending_balance
         OR NEW.available_balance IS DISTINCT FROM OLD.available_balance) THEN
        RAISE EXCEPTION 'wallet balances are derived from wallet_ledger and cannot be set directly'
            USING HINT = 'Post a ledger entry through wallet_post(). A balance nobody can explain is worse than no balance.';
    END IF;
    RETURN NEW;
END;
$init$;

CREATE TRIGGER wallets_no_direct_balance_change BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION wallets_balances_derived();


-- An internal transfer's two halves must sum to zero, checked at commit because
-- they are written one after the other.
CREATE FUNCTION wallet_transfer_balanced_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_rows integer;
    v_sum  numeric(12,2);
BEGIN
    IF NEW.transfer_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT count(*), sum(amount) INTO v_rows, v_sum
      FROM wallet_ledger WHERE transfer_id = NEW.transfer_id;

    IF v_rows <> 2 OR v_sum <> 0 THEN
        RAISE EXCEPTION 'transfer % has % row(s) summing to %, not 2 rows summing to 0', NEW.transfer_id, v_rows, v_sum
            USING HINT = 'An internal movement is recorded on both sides. One side alone is the bug the old ledger had.';
    END IF;

    RETURN NULL;
END;
$init$;

CREATE CONSTRAINT TRIGGER wallet_ledger_transfer_balanced
    AFTER INSERT ON wallet_ledger
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION wallet_transfer_balanced_check();


-- =============================================================================
-- 3. wallet_post and wallet_transfer — the only writers
-- =============================================================================

CREATE FUNCTION wallet_post(
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
            USING ERRCODE = 'check_violation',
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

COMMENT ON FUNCTION wallet_post IS
    'The only way to change a wallet balance. Idempotent on (store, idempotency_key), serialised on the wallet row, and refuses to take a pot negative.';


CREATE FUNCTION wallet_transfer(
    p_store_id        uuid,
    p_from_pot        text,
    p_to_pot          text,
    p_amount          numeric,
    p_idempotency_key text,
    p_order_id        uuid DEFAULT NULL,
    p_note            text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_transfer uuid;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'a transfer moves a positive amount, not %', p_amount;
    END IF;
    IF p_from_pot = p_to_pot THEN
        RAISE EXCEPTION 'a transfer between one pot and itself moves nothing';
    END IF;

    -- Derived from the caller's key so the two halves share a transfer id on a
    -- replay as well as on the first run.
    v_transfer := md5(p_store_id::text || ':' || p_idempotency_key)::uuid;

    -- Debit first: if the source cannot cover it, nothing is written at all.
    PERFORM wallet_post(p_store_id, p_from_pot, 'escrow_released_out', -p_amount,
                        p_idempotency_key || ':out', NULL, v_transfer, p_order_id,
                        NULL, NULL, NULL, p_note);
    PERFORM wallet_post(p_store_id, p_to_pot, 'escrow_released_in', p_amount,
                        p_idempotency_key || ':in', NULL, v_transfer, p_order_id,
                        NULL, NULL, NULL, p_note);

    RETURN v_transfer;
END;
$init$;

COMMENT ON FUNCTION wallet_transfer IS
    'Moves money between a store''s pots, writing BOTH sides. The debit is posted first, so an underfunded transfer writes nothing.';


-- =============================================================================
-- 4. momo_transactions
-- =============================================================================

CREATE TABLE momo_transactions (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id        uuid          NOT NULL,
    order_id        uuid,

    direction       text          NOT NULL,

    -- What is sent to MTN, and what a retry must REUSE rather than regenerate.
    -- Unique globally, because MTN's namespace is.
    reference_id    text          NOT NULL,

    phone           text          NOT NULL,
    amount          numeric(12,2) NOT NULL,
    currency        char(3)       NOT NULL,

    status          text          NOT NULL DEFAULT 'pending',
    provider_status text,
    provider_message text,

    created_at      timestamptz   NOT NULL DEFAULT now(),
    resolved_at     timestamptz,

    CONSTRAINT momo_direction_values CHECK (direction IN ('collection', 'disbursement')),
    CONSTRAINT momo_status_values CHECK (status IN ('pending', 'successful', 'failed')),
    CONSTRAINT momo_amount_positive CHECK (amount > 0),
    CONSTRAINT momo_resolved_at_agrees CHECK ((status = 'pending') = (resolved_at IS NULL)),
    CONSTRAINT momo_collection_has_order
        CHECK (direction = 'disbursement' OR order_id IS NOT NULL),

    FOREIGN KEY (order_id, store_id) REFERENCES orders (id, store_id) ON DELETE RESTRICT
);

COMMENT ON TABLE momo_transactions IS
    'One attempt at moving money through MTN MoMo. reference_id is the provider idempotency key and is reused on retry, never regenerated.';

CREATE UNIQUE INDEX momo_reference_key ON momo_transactions (reference_id);

-- LAYER 3 AGAINST DOUBLE CHARGE: an order can have at most one successful
-- collection. Not "should not" — cannot.
CREATE UNIQUE INDEX momo_one_success_per_order
    ON momo_transactions (order_id) WHERE direction = 'collection' AND status = 'successful';

-- And at most one attempt in flight, so a second charge is not started while the
-- first is unresolved. A failed attempt frees this for a retry.
CREATE UNIQUE INDEX momo_one_pending_per_order
    ON momo_transactions (order_id) WHERE direction = 'collection' AND status = 'pending';

-- Serves: the reconciliation sweep over unresolved attempts.
CREATE INDEX momo_pending_idx ON momo_transactions (created_at) WHERE status = 'pending';


-- =============================================================================
-- 5. refunds
-- =============================================================================

CREATE TABLE refunds (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id     uuid          NOT NULL,
    order_id     uuid          NOT NULL,

    amount       numeric(12,2) NOT NULL,

    -- Orders.dc.html's own list.
    reason_code  text          NOT NULL,
    reason_note  text,

    status       text          NOT NULL DEFAULT 'pending',

    requested_by uuid          REFERENCES users (id) ON DELETE SET NULL,
    reviewed_by  uuid          REFERENCES users (id) ON DELETE SET NULL,
    reviewed_at  timestamptz,
    rejection_reason text,

    created_at   timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT refunds_amount_positive CHECK (amount > 0),
    CONSTRAINT refunds_status_values CHECK (status IN ('pending', 'approved', 'rejected')),
    CONSTRAINT refunds_reason_values CHECK (reason_code IN (
        'item_missing', 'wrong_item', 'quality_problem', 'arrived_late', 'other')),
    -- "Other" without a note is not a reason.
    CONSTRAINT refunds_other_needs_note
        CHECK (reason_code <> 'other' OR btrim(COALESCE(reason_note, '')) <> ''),
    CONSTRAINT refunds_reviewed_agrees CHECK ((status = 'pending') = (reviewed_at IS NULL)),
    CONSTRAINT refunds_rejection_has_reason
        CHECK ((status = 'rejected') = (btrim(COALESCE(rejection_reason, '')) <> '')),

    FOREIGN KEY (order_id, store_id) REFERENCES orders (id, store_id) ON DELETE RESTRICT
);

COMMENT ON TABLE refunds IS
    'A merchant''s request, reviewed by the platform. Partial refunds are supported; the approved ones must sum to orders.refunded_amount.';

CREATE INDEX refunds_order_idx ON refunds (order_id);
-- Serves: the platform's review queue.
CREATE INDEX refunds_pending_idx ON refunds (created_at) WHERE status = 'pending';

-- The link between a refund and the order it reduces: approved refunds must sum to
-- what the order says was refunded, and requests may not exceed what was charged.
CREATE FUNCTION refunds_total_check() RETURNS trigger
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

    SELECT COALESCE(sum(amount) FILTER (WHERE status = 'approved'), 0),
           COALESCE(sum(amount) FILTER (WHERE status IN ('pending', 'approved')), 0)
      INTO v_approved, v_claimed
      FROM refunds WHERE order_id = v_order;

    IF v_approved <> v_recorded THEN
        RAISE EXCEPTION 'order % records % refunded but its approved refunds sum to %', v_order, v_recorded, v_approved
            USING HINT = 'orders.refunded_amount is the sum of approved refunds, maintained by approve_refund().';
    END IF;

    IF v_claimed > v_total THEN
        RAISE EXCEPTION 'refunds claimed on order % total % but the order was %', v_order, v_claimed, v_total
            USING HINT = 'Pending and approved refunds together cannot exceed what the customer paid.';
    END IF;

    RETURN NULL;
END;
$init$;

CREATE CONSTRAINT TRIGGER refunds_total_check
    AFTER INSERT OR UPDATE OR DELETE ON refunds
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION refunds_total_check();

CREATE CONSTRAINT TRIGGER orders_refund_total_check
    AFTER UPDATE OF refunded_amount ON orders
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION refunds_total_check();


-- =============================================================================
-- 6. withdrawals
-- =============================================================================

CREATE TABLE withdrawals (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id        uuid          NOT NULL REFERENCES wallets (store_id) ON DELETE RESTRICT,

    amount          numeric(12,2) NOT NULL,
    phone           text          NOT NULL,

    -- The five states the round-2 brief asks for.
    status          text          NOT NULL DEFAULT 'pending',
    failure_reason  text,

    -- Manual or automatic settlement, per Settings.
    initiated_by    text          NOT NULL DEFAULT 'manual',

    idempotency_key text          NOT NULL,

    requested_by    uuid          REFERENCES users (id) ON DELETE SET NULL,
    reviewed_by     uuid          REFERENCES users (id) ON DELETE SET NULL,
    requested_at    timestamptz   NOT NULL DEFAULT now(),
    completed_at    timestamptz,

    CONSTRAINT withdrawals_amount_positive CHECK (amount > 0),
    CONSTRAINT withdrawals_status_values
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'rejected')),
    CONSTRAINT withdrawals_initiated_by_values CHECK (initiated_by IN ('manual', 'automatic')),
    -- A failure the merchant cannot read is not an explanation.
    CONSTRAINT withdrawals_failure_has_reason
        CHECK ((status = 'failed') = (btrim(COALESCE(failure_reason, '')) <> '')),
    CONSTRAINT withdrawals_completed_at_agrees
        CHECK ((status = 'completed') = (completed_at IS NOT NULL)),

    CONSTRAINT withdrawals_idempotency_key UNIQUE (store_id, idempotency_key)
);

COMMENT ON TABLE withdrawals IS
    'A payout request. Funds leave available the moment it is requested, so the same money cannot be withdrawn twice while the first transfer is in flight.';

CREATE INDEX withdrawals_store_requested_idx ON withdrawals (store_id, requested_at DESC);
CREATE INDEX withdrawals_pending_idx ON withdrawals (requested_at) WHERE status IN ('pending', 'processing');

ALTER TABLE momo_transactions
    ADD COLUMN withdrawal_id uuid REFERENCES withdrawals (id) ON DELETE RESTRICT,
    ADD CONSTRAINT momo_disbursement_has_withdrawal
        CHECK (direction = 'collection' OR withdrawal_id IS NOT NULL);


-- =============================================================================
-- 7. Stock, reserved atomically
-- =============================================================================
-- Custom SQLSTATEs so the application can tell "you asked for more than exists"
-- (a 409 the customer should see) from a bug (a 500 nobody should):
--   VLSTK  insufficient stock
--   VLFND  insufficient funds

CREATE FUNCTION reserve_stock(p_store_id uuid, p_lines jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    r        record;
    v_stock  integer;
    v_track  boolean;
    v_label  text;
BEGIN
    -- GROUP BY collapses a variant appearing on two lines, so the whole quantity is
    -- checked at once rather than twice against the same starting figure.
    --
    -- ORDER BY variant_id is not cosmetic: two orders containing the same two
    -- variants in opposite orders would deadlock, each holding what the other
    -- needs. A single lock order across all callers makes that impossible.
    FOR r IN
        SELECT (e->>'variant_id')::uuid AS variant_id,
               sum((e->>'quantity')::integer) AS quantity
          FROM jsonb_array_elements(p_lines) AS a(e)
         GROUP BY 1
         ORDER BY 1
    LOOP
        IF r.quantity IS NULL OR r.quantity <= 0 THEN
            RAISE EXCEPTION 'reserve_stock: quantity for variant % must be positive', r.variant_id;
        END IF;

        SELECT v.stock_quantity, p.track_stock, p.name || COALESCE(' · ' || NULLIF(v.sku, ''), '')
          INTO v_stock, v_track, v_label
          FROM product_variants v
          JOIN products p ON p.id = v.product_id
         WHERE v.id = r.variant_id AND v.store_id = p_store_id
           FOR UPDATE OF v;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'reserve_stock: variant % is not in store %', r.variant_id, p_store_id;
        END IF;

        -- Opt-in stock tracking: a restaurant switches items off instead of counting.
        IF NOT v_track THEN
            CONTINUE;
        END IF;

        IF v_stock < r.quantity THEN
            RAISE EXCEPTION '% has % left, not %', v_label, v_stock, r.quantity
                USING ERRCODE = 'VLSTK',
                      HINT = 'Someone else took the last of it while this order was being placed.';
        END IF;

        -- The row is locked, so this read-modify-write cannot interleave. The CHECK
        -- on stock_quantity >= 0 is a second line of defence if the test above were
        -- ever wrong.
        UPDATE product_variants
           SET stock_quantity = stock_quantity - r.quantity
         WHERE id = r.variant_id;
    END LOOP;
END;
$init$;

COMMENT ON FUNCTION reserve_stock IS
    'Decrements stock for a set of lines, atomically. Locks variants in a single global order so concurrent orders cannot deadlock. Raises VLSTK when there is not enough.';


CREATE FUNCTION release_stock(p_store_id uuid, p_lines jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT (e->>'variant_id')::uuid AS variant_id,
               sum((e->>'quantity')::integer) AS quantity
          FROM jsonb_array_elements(p_lines) AS a(e)
         GROUP BY 1
         ORDER BY 1
    LOOP
        UPDATE product_variants v
           SET stock_quantity = v.stock_quantity + r.quantity
         WHERE v.id = r.variant_id
           AND v.store_id = p_store_id
           AND v.stock_quantity IS NOT NULL;
    END LOOP;
END;
$init$;

COMMENT ON FUNCTION release_stock IS
    'Puts stock back — a cancelled order, or a return the merchant chose to restock. Orders.dc.html defaults restocking off for food, since cooked food cannot be resold.';


-- =============================================================================
-- 8. A collection succeeding
-- =============================================================================

CREATE FUNCTION record_momo_collection_success(p_momo_transaction_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store    uuid;
    v_order    uuid;
    v_amount   numeric(12,2);
    v_paid     text;
BEGIN
    -- LAYER 1: the single-shot claim. A replayed webhook finds no pending row and
    -- returns false, having moved nothing.
    UPDATE momo_transactions
       SET status = 'successful', resolved_at = now()
     WHERE id = p_momo_transaction_id
       AND direction = 'collection'
       AND status = 'pending'
     RETURNING store_id, order_id, amount INTO v_store, v_order, v_amount;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- An order paid twice is the failure this whole file exists to prevent. The
    -- unique index momo_one_success_per_order makes a second SUCCESSFUL collection
    -- unrepresentable; this catches the other route in — an order already paid by
    -- some other means.
    SELECT payment_status INTO v_paid FROM orders WHERE id = v_order FOR UPDATE;
    IF v_paid <> 'unpaid' THEN
        RAISE EXCEPTION 'order % is already %, so this collection would charge it twice', v_order, v_paid
            USING HINT = 'Refund the duplicate collection rather than crediting it.';
    END IF;

    UPDATE orders
       SET payment_status = 'paid', paid_at = now(), settlement_status = 'pending'
     WHERE id = v_order;

    -- LAYER 2: the ledger key. Even if layer 1 were bypassed, this posts once.
    PERFORM wallet_post(
        p_store_id => v_store, p_pot => 'pending', p_entry_type => 'order_payment_received',
        p_amount => v_amount, p_idempotency_key => 'collection:' || p_momo_transaction_id::text,
        p_counterparty => 'customer', p_order_id => v_order,
        p_momo_transaction_id => p_momo_transaction_id,
        p_note => 'MoMo collection confirmed');

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION record_momo_collection_success IS
    'Marks a collection successful, the order paid, and credits the pending pot — exactly once, however many times the webhook arrives. Returns false when there was nothing to do.';


-- =============================================================================
-- 9. Releasing escrow — both sides, every time
-- =============================================================================

CREATE FUNCTION release_eligible_orders(p_hold_minutes integer DEFAULT 60)
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
           -- A refund still being reviewed keeps the money where it is.
           AND NOT EXISTS (
               SELECT 1 FROM refunds f WHERE f.order_id = o.id AND f.status = 'pending')
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

COMMENT ON FUNCTION release_eligible_orders IS
    'Moves elapsed escrow from pending to available, writing BOTH sides. SKIP LOCKED so two sweeps can run without fighting; the ledger key so neither releases an order twice.';


-- =============================================================================
-- 10. Withdrawals
-- =============================================================================

CREATE FUNCTION request_withdrawal(
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
    v_id uuid;
BEGIN
    -- Idempotent on the caller's key: a double-clicked Withdraw returns the first
    -- request instead of reserving the money twice.
    SELECT id INTO v_id FROM withdrawals
     WHERE store_id = p_store_id AND idempotency_key = p_idempotency_key;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
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
    'Creates a payout request and reserves the funds in the same transaction. Idempotent per store key. Raises VLFND if available cannot cover it, leaving no request behind.';


CREATE FUNCTION reverse_failed_withdrawal(p_withdrawal_id uuid, p_reason text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store  uuid;
    v_amount numeric(12,2);
BEGIN
    IF btrim(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'a failed withdrawal needs a reason the merchant can read';
    END IF;

    UPDATE withdrawals
       SET status = 'failed', failure_reason = p_reason
     WHERE id = p_withdrawal_id
       AND status IN ('pending', 'processing')
     RETURNING store_id, amount INTO v_store, v_amount;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    PERFORM wallet_post(
        p_store_id => v_store, p_pot => 'available', p_entry_type => 'withdrawal_reversed',
        p_amount => v_amount, p_idempotency_key => 'withdrawal_reversed:' || p_withdrawal_id::text,
        p_counterparty => 'merchant payout failed', p_withdrawal_id => p_withdrawal_id,
        p_note => p_reason);

    RETURN true;
END;
$init$;


-- =============================================================================
-- 11. Refunds
-- =============================================================================

CREATE FUNCTION approve_refund(p_refund_id uuid, p_reviewed_by uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store      uuid;
    v_order      uuid;
    v_amount     numeric(12,2);
    v_settlement text;
    v_total      numeric(12,2);
    v_refunded   numeric(12,2);
    v_pot        text;
BEGIN
    -- The single-shot claim. Two reviewers clicking Approve: one wins, the other
    -- gets false and no money moves twice.
    UPDATE refunds
       SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
     WHERE id = p_refund_id AND status = 'pending'
     RETURNING store_id, order_id, amount INTO v_store, v_order, v_amount;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    SELECT settlement_status, total_amount, refunded_amount
      INTO v_settlement, v_total, v_refunded
      FROM orders WHERE id = v_order FOR UPDATE;

    -- WHICH POT the money leaves is decided by where it actually is, not by a
    -- guess. While an order is in escrow its money sits in `pending`; once
    -- released it is in `available`. Getting this wrong is what left the old
    -- database's two pots out by 100 in opposite directions.
    v_pot := CASE WHEN v_settlement = 'pending' THEN 'pending' ELSE 'available' END;

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

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION approve_refund IS
    'Approves a refund once, debits the pot the money is actually in, and updates the order. Returns false if it was already reviewed.';


CREATE FUNCTION reject_refund(p_refund_id uuid, p_reviewed_by uuid, p_reason text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF btrim(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'a rejected refund needs a reason the merchant can read';
    END IF;

    UPDATE refunds
       SET status = 'rejected', reviewed_by = p_reviewed_by, reviewed_at = now(),
           rejection_reason = p_reason
     WHERE id = p_refund_id AND status = 'pending';

    RETURN FOUND;
END;
$init$;


-- =============================================================================
-- 12. Cash on delivery
-- =============================================================================

CREATE FUNCTION confirm_cash_payment(
    p_order_id        uuid,
    p_reported_amount numeric,
    p_confirmed_by    uuid DEFAULT NULL
) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store uuid;
BEGIN
    IF p_reported_amount IS NULL OR p_reported_amount < 0 THEN
        RAISE EXCEPTION 'the amount received must be counted, even if it is zero';
    END IF;

    -- Idempotent: confirming twice finds nothing unconfirmed and returns false.
    UPDATE orders
       SET cash_reported_amount = p_reported_amount,
           cash_confirmed_at = now(),
           payment_status = 'paid',
           paid_at = COALESCE(paid_at, now())
     WHERE id = p_order_id
       AND payment_method = 'cash'
       AND cash_confirmed_at IS NULL
     RETURNING store_id INTO v_store;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- NO LEDGER ENTRY, deliberately. Cash never reaches the platform: the rider
    -- handed it over and the merchant has it. The wallet tracks money the platform
    -- holds, so crediting it here would invent a balance that cannot be withdrawn.
    -- A shortfall is a fact about the rider, recorded on the order and reported in
    -- the cash report; the platform's commission on a cash order is plans & fees,
    -- at milestone 9.
    RETURN true;
END;
$init$;

COMMENT ON FUNCTION confirm_cash_payment IS
    'Records what the rider actually handed over and marks the order paid. Writes no ledger entry, because cash never reaches the platform''s wallet.';
