-- ============================================================
-- Refund approval: make it single-shot and take money from the
-- right pot.
-- ============================================================
-- Replaces approve_refund_deduct_wallet from refund.sql. Two fixes:
--
-- 1. DOUBLE APPROVAL.
--    The old function locked the refund request but never checked its status,
--    so the only thing stopping a second approval was a status check in the
--    Node caller — a read in one transaction, the deduction in another. Two
--    concurrent PATCH /api/refunds/:id/approve calls both saw 'pending', both
--    deducted the tenant's wallet, and both went on to disburse to the
--    customer. The partial unique index only prevents a second *pending row*;
--    it does nothing about approving one row twice.
--
--    The status transition is now the lock: the function's first statement
--    claims the row with UPDATE ... WHERE status = 'pending', and a second
--    caller finds no row to claim. The UPDATE takes a row lock, so a
--    concurrent caller blocks until the first commits and then sees
--    'approved'. This is the same claim-by-transition pattern
--    credit_wallet_pending already uses.
--
-- 2. WRONG BALANCE POT.
--    The old function always drained pending_balance first, regardless of
--    whether the order being refunded was still in escrow. Refunding an
--    already-released order therefore took another order's escrowed money.
--    When that other order's hold window elapsed, release_eligible_orders
--    subtracted its amount from a pending_balance that no longer held it,
--    tripping CHECK (pending_balance >= 0) — and because the release runs as
--    one loop in one function, that exception aborted the entire sweep, on
--    every subsequent tick, permanently.
--
--    The pot is now chosen from the refunded order's own settlement_status:
--    'pending' -> its money is still in escrow, take it from pending;
--    anything else -> it has been released (or was never escrowed), take it
--    from available. A partial refund of an escrowed order can only draw the
--    part still held for THAT order, never another order's.
--
-- Safe to re-run.

CREATE OR REPLACE FUNCTION approve_refund_deduct_wallet(
  p_refund_request_id UUID
) RETURNS NUMERIC AS $$
DECLARE
  v_order_id UUID;
  v_tenant_id UUID;
  v_order_total NUMERIC;
  v_refund_amount NUMERIC;
  v_settlement TEXT;
  v_pending NUMERIC;
  v_available NUMERIC;
  v_from_pending NUMERIC;
  v_from_available NUMERIC;
  v_escrowed NUMERIC;
BEGIN
  -- Claim the request. Whoever wins this UPDATE owns the refund; a second
  -- caller gets no row and is rejected here rather than deducting again.
  UPDATE refund_requests
     SET status = 'approved'
   WHERE id = p_refund_request_id
     AND status = 'pending'
  RETURNING order_id, amount INTO v_order_id, v_refund_amount;

  IF v_order_id IS NULL THEN
    -- Either it does not exist, or it is already approved/rejected/completed.
    IF NOT EXISTS (SELECT 1 FROM refund_requests WHERE id = p_refund_request_id) THEN
      RAISE EXCEPTION 'Refund request not found';
    END IF;
    RAISE EXCEPTION 'Refund request has already been reviewed';
  END IF;

  SELECT o.tenant_id, o.total_amount, o.settlement_status
    INTO v_tenant_id, v_order_total, v_settlement
  FROM orders o
  WHERE o.id = v_order_id
  FOR UPDATE;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Order not found for this refund request';
  END IF;

  -- No amount recorded means a full refund of the order.
  v_refund_amount := COALESCE(v_refund_amount, v_order_total);

  IF v_refund_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be positive';
  END IF;
  IF v_refund_amount > v_order_total THEN
    RAISE EXCEPTION 'Refund amount (%) exceeds the order total (%)', v_refund_amount, v_order_total;
  END IF;

  SELECT pending_balance, available_balance INTO v_pending, v_available
  FROM wallets WHERE tenant_id = v_tenant_id FOR UPDATE;

  IF v_pending IS NULL THEN
    RAISE EXCEPTION 'No wallet found for this tenant';
  END IF;

  -- How much of THIS order's money is still escrowed. Only an order in
  -- 'pending' settlement has anything held; anything else has been released
  -- into available (or was never a mobile-money order at all).
  IF v_settlement = 'pending' THEN
    v_escrowed := LEAST(v_order_total, v_pending);
  ELSE
    v_escrowed := 0;
  END IF;

  v_from_pending   := LEAST(v_escrowed, v_refund_amount);
  v_from_available := v_refund_amount - v_from_pending;

  IF v_from_available > v_available THEN
    RAISE EXCEPTION 'Insufficient tenant balance to cover refund — funds may already be withdrawn';
  END IF;

  UPDATE wallets
    SET pending_balance   = pending_balance - v_from_pending,
        available_balance = available_balance - v_from_available,
        updated_at = NOW()
    WHERE tenant_id = v_tenant_id;

  -- A full refund takes the order out of settlement entirely, so the escrow
  -- sweep never releases it. A partial refund leaves it 'pending' — but the
  -- remaining escrow for it is now total - refunded, which is what
  -- release_eligible_orders must release, not the full total. See the
  -- companion change to that function below.
  IF v_refund_amount >= v_order_total THEN
    UPDATE orders SET settlement_status = 'refunded' WHERE id = v_order_id;
  ELSE
    UPDATE orders SET refunded_amount = COALESCE(refunded_amount, 0) + v_refund_amount
     WHERE id = v_order_id;
  END IF;

  INSERT INTO wallet_ledger (tenant_id, order_id, entry_type, amount, balance_type, note)
    VALUES (
      v_tenant_id, v_order_id, 'refund_deducted', v_refund_amount,
      CASE WHEN v_from_pending >= v_refund_amount THEN 'pending' ELSE 'available' END,
      'Refund approved and deducted from tenant balance'
    );

  RETURN v_refund_amount;
END;
$$ LANGUAGE plpgsql;

-- Orders need somewhere to record a partial refund so the escrow sweep can
-- release only what is genuinely left.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;

-- ------------------------------------------------------------
-- release_eligible_orders: release net of any partial refund, and
-- never drive pending_balance negative.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_eligible_orders(
  p_hold_minutes INTEGER DEFAULT 60
) RETURNS TABLE(released_order_id UUID, released_tenant_id UUID, released_amount NUMERIC) AS $$
DECLARE
  r RECORD;
  v_net NUMERIC;
  v_pending NUMERIC;
BEGIN
  FOR r IN
    SELECT o.id, o.tenant_id, o.total_amount, COALESCE(o.refunded_amount, 0) AS refunded
    FROM orders o
    WHERE o.settlement_status = 'pending'
      AND o.paid_at IS NOT NULL
      AND o.paid_at + (p_hold_minutes || ' minutes')::INTERVAL <= NOW()
      AND NOT EXISTS (
        SELECT 1 FROM refund_requests rr
        WHERE rr.order_id = o.id AND rr.status = 'pending'
      )
    FOR UPDATE OF o SKIP LOCKED
  LOOP
    -- Only the un-refunded remainder is still escrowed for this order.
    v_net := GREATEST(r.total_amount - r.refunded, 0);

    SELECT pending_balance INTO v_pending
    FROM wallets WHERE tenant_id = r.tenant_id FOR UPDATE;

    -- Belt and braces: never move more than the wallet actually holds as
    -- pending. Without this, one bad row raises CHECK (pending_balance >= 0)
    -- and aborts the whole sweep — for every order, on every later tick.
    v_net := LEAST(v_net, COALESCE(v_pending, 0));

    UPDATE orders SET settlement_status = 'released' WHERE id = r.id;

    IF v_net > 0 THEN
      UPDATE wallets
        SET pending_balance   = pending_balance - v_net,
            available_balance = available_balance + v_net,
            updated_at = NOW()
        WHERE wallets.tenant_id = r.tenant_id;

      INSERT INTO wallet_ledger (tenant_id, order_id, entry_type, amount, balance_type, note)
        VALUES (r.tenant_id, r.id, 'order_payment_released', v_net, 'available', 'Hold window elapsed, no refund request');
    END IF;

    released_order_id := r.id;
    released_tenant_id := r.tenant_id;
    released_amount := v_net;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
