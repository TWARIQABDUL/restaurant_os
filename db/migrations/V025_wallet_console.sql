-- =============================================================================
-- V025 — paying a merchant out: the disbursement's lifecycle
-- =============================================================================
-- Milestone 23 of docs/migration/04-implementation-plan.md: `Wallet`.
--
-- WHAT WAS ALREADY THERE. V005 built `withdrawals`, `request_withdrawal()` (which
-- reserves the funds from Available the moment it is called, so the same money
-- cannot leave twice) and `reverse_failed_withdrawal()` (which puts them back).
-- V012 taught `request_withdrawal()` to refuse an unverified store and one with a
-- refund owed. What nothing had was the MIDDLE and the END: the attempt to pay
-- (`momo_transactions` already allows `direction = 'disbursement'`, with a
-- withdrawal id) and the moment a payout is known to have ARRIVED — no function
-- ever set `withdrawals.status = 'completed'`.
--
-- TWO FUNCTIONS, both idempotent, both the database's rather than the
-- application's, for the reason V017/V019 gave for place_order(): the state has to
-- move together or not at all, and a caller that crashes between two UPDATEs must
-- leave something a retry can finish.
--
--   start_withdrawal_disbursement(withdrawal, reference)
--       pending -> processing, and the attempt is written BEFORE the provider is
--       called. The same ordering collections use (repositories/collections.ts):
--       if the process dies after the request is sent and before it is recorded,
--       the money has left and nothing says so; the other way round, a row exists
--       whose real status can simply be re-read.
--
--   resolve_disbursement(reference, status, reason)
--       SUCCESSFUL -> the withdrawal completes. FAILED -> the funds go back to
--       Available through the existing reverse_failed_withdrawal(), with the
--       reason a merchant reads on the Withdrawals tab. A second call for a
--       resolved attempt does nothing and says so.
--
-- ONE ATTEMPT PER WITHDRAWAL, ever. A failed payout is reversed in full and the
-- merchant makes a NEW withdrawal ("Update number and retry" on the board opens
-- the sheet again) — so a retry is a new request with its own idempotency key, and
-- never a second transfer against the same reserved money.
-- =============================================================================

CREATE UNIQUE INDEX momo_one_disbursement_per_withdrawal
    ON momo_transactions (withdrawal_id) WHERE direction = 'disbursement';

CREATE FUNCTION start_withdrawal_disbursement(p_withdrawal_id uuid, p_reference_id text)
    RETURNS TABLE (momo_transaction_id uuid, reference_id text, created boolean)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    w        withdrawals%ROWTYPE;
    v_cur    char(3);
    v_id     uuid;
    v_ref    text;
BEGIN
    SELECT * INTO w FROM withdrawals WHERE id = p_withdrawal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'withdrawal % does not exist', p_withdrawal_id;
    END IF;

    -- A repeat returns the attempt that is already there, untouched.
    SELECT m.id, m.reference_id INTO v_id, v_ref
      FROM momo_transactions m
     WHERE m.withdrawal_id = p_withdrawal_id AND m.direction = 'disbursement';
    IF FOUND THEN
        momo_transaction_id := v_id; reference_id := v_ref; created := false;
        RETURN NEXT;
        RETURN;
    END IF;

    IF w.status <> 'pending' THEN
        RAISE EXCEPTION 'withdrawal % is %, so it cannot be sent', p_withdrawal_id, w.status;
    END IF;

    SELECT currency INTO v_cur FROM wallets WHERE store_id = w.store_id;

    INSERT INTO momo_transactions (store_id, direction, reference_id, phone, amount, currency, withdrawal_id)
         VALUES (w.store_id, 'disbursement', p_reference_id, w.phone, w.amount, v_cur, p_withdrawal_id)
      RETURNING id INTO v_id;

    UPDATE withdrawals SET status = 'processing' WHERE id = p_withdrawal_id;

    momo_transaction_id := v_id; reference_id := p_reference_id; created := true;
    RETURN NEXT;
END;
$init$;

COMMENT ON FUNCTION start_withdrawal_disbursement IS
    'Writes the payout attempt and moves the withdrawal to processing, before the provider is called. Idempotent: a repeat returns the existing attempt with created = false.';

CREATE FUNCTION resolve_disbursement(p_reference_id text, p_status text, p_reason text DEFAULT NULL)
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    m record;
BEGIN
    IF p_status NOT IN ('successful', 'failed') THEN
        RAISE EXCEPTION 'a disbursement resolves to successful or failed, not %', p_status;
    END IF;

    SELECT id, withdrawal_id, status INTO m
      FROM momo_transactions
     WHERE reference_id = p_reference_id AND direction = 'disbursement'
       FOR UPDATE;
    IF NOT FOUND OR m.status <> 'pending' THEN
        RETURN false;
    END IF;

    UPDATE momo_transactions
       SET status = p_status, resolved_at = now(),
           provider_status = upper(p_status), provider_message = p_reason
     WHERE id = m.id;

    IF p_status = 'successful' THEN
        UPDATE withdrawals SET status = 'completed', completed_at = now()
         WHERE id = m.withdrawal_id AND status IN ('pending', 'processing');
    ELSE
        PERFORM reverse_failed_withdrawal(
            m.withdrawal_id,
            COALESCE(NULLIF(btrim(p_reason), ''), 'MoMo did not accept the transfer.'));
    END IF;

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION resolve_disbursement IS
    'The end of a payout. Successful completes the withdrawal; failed returns the funds to Available with the reason. Idempotent: a resolved attempt answers false and changes nothing.';

-- Serves: Activity tab's join from a ledger row to the withdrawal it reserved.
CREATE INDEX wallet_ledger_withdrawal_idx ON wallet_ledger (withdrawal_id) WHERE withdrawal_id IS NOT NULL;

-- Serves: automatic payouts finding "has this store already been paid out today".
CREATE INDEX withdrawals_store_initiated_idx ON withdrawals (store_id, initiated_by, requested_at DESC);

-- Serves: the Activity tab's keyset page — `ORDER BY created_at DESC, id DESC` with the cursor as a row
-- comparison. V014 and V018 both measured that a cursor on (timestamp, id) only SEEKS when the id is in the
-- index; with the old two-column wallet_ledger_store_created_idx the comparison becomes a filter applied after
-- the fact, and a store whose ledger rows share a transaction's now() reads them all.
CREATE INDEX wallet_ledger_store_created_id_idx ON wallet_ledger (store_id, created_at DESC, id DESC);

-- Serves: the Refunds tab, a store's refunds newest first. Only refunds_order_idx and two partial indexes
-- existed, so the tab would have read every refund on the platform and filtered.
CREATE INDEX refunds_store_created_idx ON refunds (store_id, created_at DESC, id DESC);
