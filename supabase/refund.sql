ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2);
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12, 2) DEFAULT 0;

CREATE OR REPLACE FUNCTION approve_refund_deduct_wallet(
  p_refund_request_id UUID
) RETURNS NUMERIC AS $$
DECLARE
  v_order_id UUID;
  v_tenant_id UUID;
  v_order_total NUMERIC;
  v_refund_amount NUMERIC;
  v_pending NUMERIC;
  v_available NUMERIC;
  v_from_pending NUMERIC;
  v_from_available NUMERIC;
BEGIN
  SELECT rr.order_id, o.tenant_id, o.total_amount, rr.amount
    INTO v_order_id, v_tenant_id, v_order_total, v_refund_amount
  FROM refund_requests rr
  JOIN orders o ON o.id = rr.order_id
  WHERE rr.id = p_refund_request_id
  FOR UPDATE OF rr;

  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'Refund request not found';
  END IF;
  
  -- Use the custom refund amount if specified, otherwise the full order total
  v_refund_amount := COALESCE(v_refund_amount, v_order_total);

  SELECT pending_balance, available_balance INTO v_pending, v_available
  FROM wallets WHERE tenant_id = v_tenant_id FOR UPDATE;

  IF v_pending IS NULL THEN
    RAISE EXCEPTION 'No wallet found for this tenant';
  END IF;

  v_from_pending := LEAST(v_pending, v_refund_amount);
  v_from_available := v_refund_amount - v_from_pending;

  IF v_from_available > v_available THEN
    RAISE EXCEPTION 'Insufficient tenant balance to cover refund — funds may already be withdrawn';
  END IF;

  UPDATE wallets
    SET pending_balance = pending_balance - v_from_pending,
        available_balance = available_balance - v_from_available,
        updated_at = NOW()
    WHERE tenant_id = v_tenant_id;

  -- Only mark order as fully refunded if we are refunding the full amount
  IF v_refund_amount >= v_order_total THEN
    UPDATE orders SET settlement_status = 'refunded' WHERE id = v_order_id;
  END IF;

  INSERT INTO wallet_ledger (tenant_id, order_id, entry_type, amount, balance_type, note)
    VALUES (v_tenant_id, v_order_id, 'refund_deducted', v_refund_amount, 'pending', 'Refund approved and deducted from tenant balance');

  RETURN v_refund_amount;
END;
$$ LANGUAGE plpgsql;
