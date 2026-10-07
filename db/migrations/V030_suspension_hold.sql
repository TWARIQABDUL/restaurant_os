-- V030_suspension_hold.sql
--
-- Milestone 27. AdminMerchants' suspend dialog promises "payouts are held", and nothing held them: V012's request_withdrawal()
-- gates on identity and on owed refunds and never looked at the store's own status. Suspending a store took it off the
-- storefront (middleware/storefront.ts has refused a suspended store since M16) and left its money free to leave.
--
-- THE FUNCTION IS REPLACED WHOLE, because that is the only way to change one in Postgres, and the diff against V012's is
-- exactly one block — marked below. Everything else, including the idempotency order (the replay check runs BEFORE any hold,
-- so a retry of a request made before the suspension still returns that request), is V012's.

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

    -- THE SUSPENSION HOLD (V030). AdminMerchants' own words: "payouts are held". A suspended store's balance keeps adding up
    -- and nothing leaves it until the platform lifts the suspension — a store suspended for counterfeit goods must not be able
    -- to empty its wallet in the minutes before somebody notices. The same code as the identity hold, because to the
    -- merchant's screen it is the same thing: a payout that waits, with the balance safe.
    IF EXISTS (SELECT 1 FROM stores WHERE id = p_store_id AND status = 'suspended') THEN
        RAISE EXCEPTION 'payouts are paused: this store is suspended'
            USING ERRCODE = 'VLHLD',
                  HINT = 'The balance keeps adding up. Payouts resume when the suspension is lifted.';
    END IF;

    -- The identity gate. Selling, orders, cash and MoMo all work unverified; this
    -- is the one thing that does not.
    IF NOT store_is_verified(p_store_id) THEN
        RAISE EXCEPTION 'payouts are paused: this store has not been verified yet'
            USING ERRCODE = 'VLHLD',
                  HINT = 'The balance keeps adding up. Payouts start the morning after the identity check is approved.';
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
    'Creates a payout request and reserves the funds in the same transaction. Idempotent per store key. Raises VLFND if available cannot cover it, and VLHLD while the store is unverified, suspended or owed refunds.';
