-- ============================================================
-- PLATFORM SETTINGS — one row, owned by super admin
-- ============================================================
-- Until now the only platform-wide knobs were environment variables, which only
-- someone with dashboard access to the host could change. These are the ones a
-- super admin should be able to set from the product itself.
--
-- Deliberately NOT here: the MoMo settlement currency. That is whatever MTN
-- actually settles the platform's account in — writing a different value in a
-- table does not change what MTN does, it just lets someone quote and collect
-- in a currency the account will reject. It stays derived from MOMO_CURRENCY
-- and is shown read-only.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS platform_settings (
  -- Single-row table. The CHECK makes that structural rather than a convention
  -- someone has to remember.
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),

  -- Currencies a store may price in. A store picks from this list and cannot
  -- type in anything else; the same list is re-checked when an order is placed
  -- and when a withdrawal is requested, so a currency removed from the platform
  -- cannot keep taking money through a stale tenant setting.
  allowed_currencies TEXT[] NOT NULL DEFAULT ARRAY['EUR']
    CHECK (array_length(allowed_currencies, 1) >= 1),

  -- Defaults applied to newly provisioned stores.
  default_settlement_mode VARCHAR(10) NOT NULL DEFAULT 'manual'
    CHECK (default_settlement_mode IN ('manual', 'auto')),

  -- How long a paid order sits in escrow before it can be released.
  default_hold_minutes INTEGER NOT NULL DEFAULT 60
    CHECK (default_hold_minutes >= 0 AND default_hold_minutes <= 43200),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Seed the single row if it does not exist yet.
INSERT INTO platform_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- Every currency in use by an existing store must be in the allowlist, or that
-- store would be unable to save its own settings back. Fold them in rather than
-- stranding anyone.
UPDATE platform_settings ps
   SET allowed_currencies = (
     SELECT ARRAY(
       SELECT DISTINCT c FROM (
         SELECT unnest(ps.allowed_currencies) AS c
         UNION
         SELECT upper(t.settings->>'currency') FROM tenants t
          WHERE t.settings->>'currency' IS NOT NULL
            AND upper(t.settings->>'currency') ~ '^[A-Z]{3}$'
       ) x
       ORDER BY c
     )
   )
 WHERE ps.id;

-- Locked down like every other table: only the service-role backend reads it.
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_settings FROM anon, authenticated;

DO $$
DECLARE
  cur TEXT[];
BEGIN
  SELECT allowed_currencies INTO cur FROM platform_settings WHERE id;
  RAISE NOTICE 'platform_settings ready. allowed_currencies = %', cur;
END $$;
