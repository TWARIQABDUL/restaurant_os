-- ============================================================
-- Currency: make the wallet say what it actually holds
-- ============================================================
-- `wallets.currency` and `momo_transactions.currency` were both created with
-- DEFAULT 'EUR' — a sandbox-era default, since the MoMo sandbox only ever
-- settles in EUR regardless of target market.
--
-- momo_transactions is fine: walletService passes momoConfig.currency on every
-- insert. Wallets are not: credit_wallet_pending creates the row with only
-- (tenant_id, pending_balance, available_balance), so the currency column falls
-- back to 'EUR' while the balance is really in whatever the platform settles in.
-- A Rwandan seller ends up with a wallet labelled EUR holding RWF, and
-- getWallet() hands that label to the dashboard.
--
-- The fix is to pass the currency in at credit time. It is the same value for
-- every tenant (the platform has one MoMo account, so one settlement currency),
-- but recording it per wallet keeps the row self-describing rather than relying
-- on whatever the server's env happens to say when someone later reads it.
--
-- Safe to re-run.

-- Keep the old 3-argument signature working during the deploy: the new
-- parameter is defaulted, so the existing server can still call it unchanged
-- until the new build rolls out.
CREATE OR REPLACE FUNCTION credit_wallet_pending(
  p_tenant_id UUID,
  p_order_id UUID,
  p_amount NUMERIC,
  p_currency VARCHAR DEFAULT NULL
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

  INSERT INTO wallets (tenant_id, pending_balance, available_balance, currency)
    VALUES (p_tenant_id, p_amount, 0, COALESCE(p_currency, 'EUR'))
  ON CONFLICT (tenant_id) DO UPDATE
    SET pending_balance = wallets.pending_balance + EXCLUDED.pending_balance,
        -- Adopt the currency on an existing wallet only while it is still
        -- empty. Rewriting the label on a wallet that already holds money would
        -- silently reinterpret the balance rather than convert it.
        currency = CASE
          WHEN p_currency IS NOT NULL
           AND wallets.pending_balance = 0
           AND wallets.available_balance = 0
          THEN p_currency
          ELSE wallets.currency
        END,
        updated_at = NOW();

  INSERT INTO wallet_ledger (tenant_id, order_id, entry_type, amount, balance_type, note)
    VALUES (p_tenant_id, p_order_id, 'order_payment_held', p_amount, 'pending', 'MoMo collection confirmed');

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- Backfill: relabel wallets that never held anything but EUR by default.
-- ------------------------------------------------------------
-- Only touches wallets whose currency is still the untouched default AND whose
-- transactions tell us what they really are. A wallet with no transactions is
-- left alone — there is nothing to infer from.
UPDATE wallets w
   SET currency = t.currency,
       updated_at = NOW()
  FROM (
    SELECT tenant_id, currency, count(*) AS n
    FROM momo_transactions
    WHERE tenant_id IS NOT NULL AND currency IS NOT NULL
    GROUP BY tenant_id, currency
  ) t
 WHERE t.tenant_id = w.tenant_id
   AND w.currency IS DISTINCT FROM t.currency
   -- Only when that tenant's transactions are unanimous, so a project that has
   -- genuinely switched currency mid-life is left for a human.
   AND NOT EXISTS (
     SELECT 1 FROM momo_transactions m2
     WHERE m2.tenant_id = w.tenant_id
       AND m2.currency IS DISTINCT FROM t.currency
   );

DO $$
DECLARE
  mixed int;
BEGIN
  SELECT count(*) INTO mixed FROM (
    SELECT tenant_id FROM momo_transactions
    WHERE tenant_id IS NOT NULL AND currency IS NOT NULL
    GROUP BY tenant_id HAVING count(DISTINCT currency) > 1
  ) x;

  IF mixed > 0 THEN
    RAISE WARNING 'Skipped % tenant(s) whose transactions span multiple currencies — relabel those by hand.', mixed;
  END IF;

  RAISE NOTICE 'Wallet currency backfill complete.';
END $$;
