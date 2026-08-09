-- ============================================================
-- Restaurant OS — Payments & Wallet System (MTN MoMo)
-- ============================================================
-- Additive migration: safe to run against an existing database.
-- Does NOT drop or modify existing data.
--
-- Model:
--   - Customers pay the PLATFORM's own MoMo account (Collections API),
--     not the tenant directly.
--   - A paid order's amount is credited to the tenant's wallet as
--     "pending" (escrow), for a hold window (default 60 min).
--   - If no refund request lands during the hold window, the funds
--     move from pending -> available (settlement).
--   - Tenants withdraw their available balance to their own MoMo
--     number (Disbursements API), either:
--       (a) manually, whenever an admin requests it, or
--       (b) automatically, right when funds become available, if the
--           tenant has settlementMode = 'auto' in tenants.settings.
--
-- All balance mutations happen inside the functions below, using row
-- locking (FOR UPDATE / SKIP LOCKED) so concurrent requests can't
-- double-spend or double-credit the same money.
-- ============================================================

-- ----------------------------------------------------------
-- Extend existing tables (additive only)
-- ----------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS settlement_status VARCHAR(20) NOT NULL DEFAULT 'not_applicable';

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_settlement_status_check
    CHECK (settlement_status IN ('not_applicable', 'pending', 'released', 'refunded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_settlement_status ON orders(settlement_status);
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at);

-- ----------------------------------------------------------
-- WALLETS — one row per tenant
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  available_balance NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
  pending_balance NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (pending_balance >= 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------
-- WALLET LEDGER — append-only audit trail of every balance change
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  withdrawal_request_id UUID,
  entry_type VARCHAR(30) NOT NULL CHECK (entry_type IN (
    'order_payment_held', 'order_payment_released', 'refund_deducted',
    'withdrawal_reserved', 'withdrawal_reversed'
  )),
  amount NUMERIC(12, 2) NOT NULL,
  balance_type VARCHAR(10) NOT NULL CHECK (balance_type IN ('pending', 'available')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_tenant ON wallet_ledger(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_order ON wallet_ledger(order_id);

-- ----------------------------------------------------------
-- WITHDRAWAL REQUESTS
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  initiated_by VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (initiated_by IN ('manual', 'auto')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  phone_number VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'rejected')),
  failure_reason TEXT,
  momo_transaction_id UUID,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_tenant ON withdrawal_requests(tenant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);

-- ----------------------------------------------------------
-- REFUND REQUESTS
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS refund_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  momo_transaction_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refund_requests_order ON refund_requests(order_id);
-- Only one *pending* refund request allowed per order at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_requests_one_pending_per_order
  ON refund_requests(order_id) WHERE status = 'pending';

-- ----------------------------------------------------------
-- MOMO TRANSACTIONS — every collection/disbursement API call
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS momo_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference_id UUID NOT NULL UNIQUE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('collection', 'disbursement')),
  purpose VARCHAR(20) NOT NULL DEFAULT 'order_payment'
    CHECK (purpose IN ('order_payment', 'withdrawal', 'refund')),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  withdrawal_request_id UUID REFERENCES withdrawal_requests(id) ON DELETE SET NULL,
  refund_request_id UUID REFERENCES refund_requests(id) ON DELETE SET NULL,
  phone_number VARCHAR(50) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'successful', 'failed')),
  momo_status_raw VARCHAR(50),
  financial_transaction_id VARCHAR(100),
  failure_reason TEXT,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_momo_transactions_order ON momo_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_momo_transactions_withdrawal ON momo_transactions(withdrawal_request_id);
CREATE INDEX IF NOT EXISTS idx_momo_transactions_refund ON momo_transactions(refund_request_id);
CREATE INDEX IF NOT EXISTS idx_momo_transactions_status_pending ON momo_transactions(status) WHERE status = 'pending';

-- ============================================================
-- FUNCTIONS — all balance mutations go through these so locking
-- and idempotency live in one place.
-- ============================================================

-- Credit a tenant's pending balance once a MoMo collection succeeds.
-- Idempotent: safe to call more than once for the same order (a
-- webhook and a poll can both observe "successful").
CREATE OR REPLACE FUNCTION credit_wallet_pending(
  p_tenant_id UUID,
  p_order_id UUID,
  p_amount NUMERIC
) RETURNS BOOLEAN AS $$
DECLARE
  v_claimed_id UUID;
BEGIN
  UPDATE orders
    SET settlement_status = 'pending'
    WHERE id = p_order_id
      AND settlement_status = 'not_applicable'
    RETURNING id INTO v_claimed_id;

  IF v_claimed_id IS NULL THEN
    RETURN FALSE; -- already credited, or order not found — no-op
  END IF;

  INSERT INTO wallets (tenant_id, pending_balance, available_balance)
    VALUES (p_tenant_id, p_amount, 0)
  ON CONFLICT (tenant_id) DO UPDATE
    SET pending_balance = wallets.pending_balance + EXCLUDED.pending_balance,
        updated_at = NOW();

  INSERT INTO wallet_ledger (tenant_id, order_id, entry_type, amount, balance_type, note)
    VALUES (p_tenant_id, p_order_id, 'order_payment_held', p_amount, 'pending', 'MoMo collection confirmed');

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Release every order whose hold window has elapsed with no pending
-- refund request. Returns the rows it released so the caller (Node)
-- knows which tenants may need an auto-payout triggered.
CREATE OR REPLACE FUNCTION release_eligible_orders(
  p_hold_minutes INTEGER DEFAULT 60
) RETURNS TABLE(released_order_id UUID, released_tenant_id UUID, released_amount NUMERIC) AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT o.id, o.tenant_id, o.total_amount
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
    UPDATE orders SET settlement_status = 'released' WHERE id = r.id;

    UPDATE wallets
      SET pending_balance = pending_balance - r.total_amount,
          available_balance = available_balance + r.total_amount,
          updated_at = NOW()
      WHERE wallets.tenant_id = r.tenant_id;

    INSERT INTO wallet_ledger (tenant_id, order_id, entry_type, amount, balance_type, note)
      VALUES (r.tenant_id, r.id, 'order_payment_released', r.total_amount, 'available', 'Hold window elapsed, no refund request');

    released_order_id := r.id;
    released_tenant_id := r.tenant_id;
    released_amount := r.total_amount;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Reserve funds for a withdrawal (debits available_balance immediately
-- so a second concurrent request can't also withdraw the same money).
-- Raises an exception on insufficient balance — callers should catch it.
CREATE OR REPLACE FUNCTION request_withdrawal(
  p_tenant_id UUID,
  p_user_id UUID,
  p_amount NUMERIC,
  p_phone VARCHAR,
  p_initiated_by VARCHAR DEFAULT 'manual'
) RETURNS UUID AS $$
DECLARE
  v_available NUMERIC;
  v_withdrawal_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Withdrawal amount must be positive';
  END IF;

  SELECT available_balance INTO v_available
  FROM wallets WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  IF v_available IS NULL OR v_available < p_amount THEN
    RAISE EXCEPTION 'Insufficient available balance';
  END IF;

  UPDATE wallets
    SET available_balance = available_balance - p_amount,
        updated_at = NOW()
    WHERE tenant_id = p_tenant_id;

  INSERT INTO withdrawal_requests (tenant_id, requested_by, amount, phone_number, status, initiated_by)
    VALUES (p_tenant_id, p_user_id, p_amount, p_phone, 'processing', p_initiated_by)
    RETURNING id INTO v_withdrawal_id;

  INSERT INTO wallet_ledger (tenant_id, withdrawal_request_id, entry_type, amount, balance_type, note)
    VALUES (p_tenant_id, v_withdrawal_id, 'withdrawal_reserved', -p_amount, 'available', 'Withdrawal requested, funds reserved pending MoMo transfer');

  RETURN v_withdrawal_id;
END;
$$ LANGUAGE plpgsql;

-- Undo a reservation if the MoMo transfer ultimately failed.
CREATE OR REPLACE FUNCTION reverse_failed_withdrawal(
  p_withdrawal_id UUID
) RETURNS VOID AS $$
DECLARE
  v_tenant_id UUID;
  v_amount NUMERIC;
BEGIN
  SELECT tenant_id, amount INTO v_tenant_id, v_amount
  FROM withdrawal_requests WHERE id = p_withdrawal_id FOR UPDATE;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Withdrawal request not found';
  END IF;

  UPDATE wallets
    SET available_balance = available_balance + v_amount,
        updated_at = NOW()
    WHERE tenant_id = v_tenant_id;

  INSERT INTO wallet_ledger (tenant_id, withdrawal_request_id, entry_type, amount, balance_type, note)
    VALUES (v_tenant_id, p_withdrawal_id, 'withdrawal_reversed', v_amount, 'available', 'MoMo transfer failed, funds returned');
END;
$$ LANGUAGE plpgsql;

-- Deduct an approved refund from the tenant's wallet — pulls from
-- pending_balance first (order still in its hold window), then spills
-- into available_balance if the order had already been released.
-- Raises an exception if the tenant no longer has enough of either
-- (e.g. they already withdrew it) — that case needs manual handling.
CREATE OR REPLACE FUNCTION approve_refund_deduct_wallet(
  p_refund_request_id UUID
) RETURNS NUMERIC AS $$
DECLARE
  v_order_id UUID;
  v_tenant_id UUID;
  v_amount NUMERIC;
  v_pending NUMERIC;
  v_available NUMERIC;
  v_from_pending NUMERIC;
  v_from_available NUMERIC;
BEGIN
  SELECT rr.order_id, o.tenant_id, o.total_amount
    INTO v_order_id, v_tenant_id, v_amount
  FROM refund_requests rr
  JOIN orders o ON o.id = rr.order_id
  WHERE rr.id = p_refund_request_id
  FOR UPDATE OF rr;

  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'Refund request not found';
  END IF;

  SELECT pending_balance, available_balance INTO v_pending, v_available
  FROM wallets WHERE tenant_id = v_tenant_id FOR UPDATE;

  IF v_pending IS NULL THEN
    RAISE EXCEPTION 'No wallet found for this tenant';
  END IF;

  v_from_pending := LEAST(v_pending, v_amount);
  v_from_available := v_amount - v_from_pending;

  IF v_from_available > v_available THEN
    RAISE EXCEPTION 'Insufficient tenant balance to cover refund — funds may already be withdrawn';
  END IF;

  UPDATE wallets
    SET pending_balance = pending_balance - v_from_pending,
        available_balance = available_balance - v_from_available,
        updated_at = NOW()
    WHERE tenant_id = v_tenant_id;

  UPDATE orders SET settlement_status = 'refunded' WHERE id = v_order_id;

  INSERT INTO wallet_ledger (tenant_id, order_id, entry_type, amount, balance_type, note)
    VALUES (v_tenant_id, v_order_id, 'refund_deducted', v_amount, 'pending', 'Refund approved and deducted from tenant balance');

  RETURN v_amount;
END;
$$ LANGUAGE plpgsql;
