-- ============================================
-- LOCK DOWN THE PUBLIC (anon) KEY
-- ============================================
-- The Supabase anon key is public by design — it ships inside the client
-- bundle. What is supposed to make that safe is RLS + minimal grants. This
-- database had neither: `anon` and `authenticated` held full
-- SELECT/INSERT/UPDATE/DELETE on all 23 public tables, with RLS off on 22 of
-- them. That made every table readable and writable by anyone on the internet,
-- straight through PostgREST, bypassing Express entirely.
--
-- This file removes that access. Two independent layers, so neither one being
-- undone re-opens the hole:
--
--   1. GRANTS  — anon/authenticated lose every privilege in schema public.
--   2. RLS     — enabled on every public table. With no policies defined, RLS
--                denies everything by default. `service_role` bypasses RLS, so
--                the backend is unaffected.
--
-- ⚠️  PREREQUISITE — DEPLOY FIRST, THEN RUN THIS.
-- The backend must already be running on SUPABASE_SERVICE_ROLE_KEY. While it
-- still uses the anon key, running this file takes the whole app down.
-- server/scripts/run-lockdown.js refuses to run unless that key is configured.
--
-- Storage is unaffected: storage.objects lives in its own schema with its own
-- RLS policies, so client-side image upload keeps working.
--
-- Safe to re-run.

-- ── Layer 1: revoke every privilege in schema public ───────────────────────

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Without USAGE on the schema, PostgREST cannot even resolve a table name for
-- these roles. This is the definitive lock; the grants above are belt to its
-- braces.
REVOKE USAGE ON SCHEMA public FROM anon, authenticated;

-- Stop future tables from being born with the same grants. Note this only
-- covers objects created by the role running this file — verify-lockdown.js
-- re-checks the live state, so run it after any migration that adds a table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- ── Layer 2: RLS on every public table (deny-by-default, no policies) ──────

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── Report ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  leftover_grants int;
  rls_off int;
BEGIN
  SELECT count(*) INTO leftover_grants
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated');

  SELECT count(*) INTO rls_off
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;

  RAISE NOTICE 'anon/authenticated grants remaining in public: %', leftover_grants;
  RAISE NOTICE 'public tables with RLS still disabled: %', rls_off;

  IF leftover_grants > 0 OR rls_off > 0 THEN
    RAISE EXCEPTION 'Lockdown incomplete — % grants, % tables without RLS', leftover_grants, rls_off;
  END IF;
END $$;
