-- =============================================================================
-- LOCAL ONLY — db/bootstrap/local.sql
-- =============================================================================
-- Mounted at /docker-entrypoint-initdb.d/ and run by Postgres' own entrypoint
-- exactly once, on an empty data directory. `npm run db:reset` destroys the
-- volume, so that is what re-runs it.
--
-- THE DEPLOYED INSTANCE NEVER RUNS THIS FILE.
--
-- Therefore: nothing the schema depends on may live here alone. If a table, a
-- function or a grant needs it, it belongs in a migration, where every
-- environment gets it identically. This file is only allowed to contain:
--
--   1. things a managed provider does for you outside of SQL (role creation)
--   2. local diagnostics that no schema object depends on
--
-- Everything else — the extensions the schema needs, CONNECT and USAGE grants,
-- default privileges for the app role, schema_migrations — is V000, milestone 2.
-- Deliberately not here: see §4.2 and §4.3 of docs/migration/04-implementation-plan.md.
--
-- Runs as the superuser vendlyfy_owner, against database vendlyfy.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The application role
-- -----------------------------------------------------------------------------
-- Two roles, here and in deployment:
--
--   vendlyfy_owner  owns the schema, runs migrations. Superuser locally only
--                   because the Postgres image's POSTGRES_USER always is; in
--                   deployment it is the provider's ordinary owner role.
--   vendlyfy_app    what the application connects as. Never owns anything,
--                   never runs DDL. Its table privileges are granted by
--                   migrations, not here.
--
-- A managed provider creates roles through its dashboard or API, not through
-- your migrations — which is exactly why this one line is local-only and its
-- grants are not.
--
-- The password is local and worthless; it matches docker-compose.yml and the
-- commented DATABASE_URL in server/.env.example. `db:verify` logs in as this
-- role over TCP, so if those three ever drift, verification fails loudly
-- instead of the drift surfacing at milestone 11.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vendlyfy_app') THEN
        CREATE ROLE vendlyfy_app LOGIN PASSWORD 'localdev'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END
$$;

COMMENT ON ROLE vendlyfy_app IS
    'Application connection role. Owns nothing, runs no DDL. Privileges come from migrations.';


-- -----------------------------------------------------------------------------
-- 2. Local diagnostics
-- -----------------------------------------------------------------------------
-- pg_stat_statements is preloaded by docker-compose.yml's command flags. It is
-- a measuring instrument: no schema object references it, so having it here and
-- not in a migration cannot cause an environment mismatch.
--
-- It is what §2.3's "EXPLAIN (ANALYZE, BUFFERS) before merge" is checked with,
-- and how milestone 10's "a sequential scan is visibly slower than an index
-- scan" gets measured rather than asserted.

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
