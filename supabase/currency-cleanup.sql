-- ============================================================
-- Post-deploy cleanup: drop the old credit_wallet_pending overload
-- ============================================================
-- currency.sql added a 4-argument credit_wallet_pending(p_currency) while
-- leaving the original 3-argument version in place, so the migration could run
-- before the new server rolled out without breaking the running one.
--
-- Postgres treats those as two separate functions, not a replacement. Once
-- every instance is on the new build, the 3-argument version is dead code that
-- still carries the bug — it creates wallets on the schema's 'EUR' default.
--
-- ⚠️  RUN ONLY AFTER the new server build is fully deployed. If any instance is
-- still calling the 3-argument form, this takes wallet crediting down for it.
--
-- Safe to re-run.

DROP FUNCTION IF EXISTS credit_wallet_pending(UUID, UUID, NUMERIC);

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'credit_wallet_pending';
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one credit_wallet_pending, found %', n;
  END IF;
  RAISE NOTICE 'credit_wallet_pending: single 4-argument version remains.';
END $$;
