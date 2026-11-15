-- V037_close_return_kind_aware.sql
--
-- A real bug `momo_manual` (V036) would have walked straight into: `close_return()` (V022) decides whether
-- to auto-refund a returned order from the platform wallet with `v_row.payment_method <> 'cash'` — its own
-- comment explains the idiom as "not cash", meaning "collected automatically through an online provider,
-- so the platform is holding the money and must give it back". That was a correct enough proxy when 'cash'
-- was the only offline method, but momo_manual is ALSO offline (no provider, no webhook, no ledger entry
-- ever posted — V036's `confirm_manual_momo_payment()` is explicit about that) and `<> 'cash'` would have
-- been true for it, calling `refund_settle()` to debit a wallet balance this money never credited. Either
-- `wallet_post()` raises VLFND (the store's wallet happens to hold nothing to take), or — worse — it
-- succeeds by debiting money that belongs to an unrelated, genuinely-online order.
--
-- Fixed by reading `payment_methods.kind` instead of hardcoding a method key, which is also what the
-- original comment's own stated intent was ("a provider-specific check here would silently stop covering
-- the next one V006 adds") — it just didn't anticipate a SECOND offline method joining cash.

CREATE OR REPLACE FUNCTION close_return(
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
    v_kind     text;
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

    -- Offline (cash, momo_manual): "no money changed hands through the platform, so there's nothing to
    -- refund FROM THE WALLET" — cash because confirm_cash_payment() only ever ran if delivered, which a
    -- return never reaches; momo_manual because confirm_manual_momo_payment() posts no ledger entry
    -- either way, confirmed or not. Online: was paid up front through a provider and needs giving back —
    -- read from payment_methods.kind, not a method name, so the NEXT online provider is covered for free.
    SELECT kind INTO v_kind FROM payment_methods WHERE key = v_row.payment_method;

    SELECT v_row.total_amount - COALESCE(sum(COALESCE(approved_amount, amount)), 0)
      INTO v_amount
      FROM refunds WHERE order_id = p_order_id AND status IN ('pending', 'queued', 'approved');
    IF v_kind = 'online' AND v_row.payment_status = 'paid' AND v_amount > 0 THEN
        INSERT INTO refunds (store_id, order_id, amount, reason_code, reason_note, requested_by, initiated_by)
             VALUES (p_store_id, p_order_id, v_amount, 'other',
                     'Order returned and closed: refunded automatically', p_actor_id, 'platform')
          RETURNING id INTO v_refund;
        PERFORM refund_settle(v_refund, NULL, p_actor_id);
    END IF;

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION close_return IS
    'returned -> closed_return. Restocks if asked, and refunds an online-paid order automatically — an offline one (cash, momo_manual) never reached the platform wallet, so there is nothing to reverse.';
