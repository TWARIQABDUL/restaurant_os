-- V000_init.sql
--
-- The first migration. Nothing exists yet: this file establishes the privilege
-- model and the handful of shared objects every later migration relies on.
--
-- It is NOT a dump of the old production schema. The new system is greenfield
-- (§4.3 of docs/migration/04-implementation-plan.md) — there is no baseline, and
-- the schema is built forward from V001, one feature area per migration, with
-- correct names and correct indexes from the first line. The old schema lives on
-- in ../../supabase/ as the reference for the one-off data migration (§5.5).
--
-- Two decisions recorded here so they are not re-litigated:
--
--   * NO uuid extension. gen_random_uuid() has been in core since PG13, so
--     neither uuid-ossp nor pgcrypto is needed for primary keys. §4.2 left this
--     open "to decide once in V000" — this is that decision.
--   * NO citext. Case-insensitive email uniqueness is a unique index on
--     lower(email), declared with the users table at milestone 5. citext's
--     collation behaviour is one more thing to reason about for no gain.
--
-- Deliberately not here:
--
--   * schema_migrations — the runner creates it, because nothing could record
--     this file as applied otherwise. It is intentionally excluded from the app
--     role's privileges below: the application has no business reading it.
--   * the vendlyfy_app role itself — creating a role is not something a managed
--     provider lets a migration do, so it is a deployment step, mirrored locally
--     by db/bootstrap/local.sql. This file asserts it exists.


-- =============================================================================
-- 1. The application role must already exist
-- =============================================================================
-- Fail here, loudly, rather than let every GRANT below silently apply to nothing
-- and surface as "permission denied" from the application much later.

DO $init$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vendlyfy_app') THEN
        RAISE EXCEPTION
            'role vendlyfy_app does not exist'
            USING HINT =
                'Create it before migrating. Locally that is db/bootstrap/local.sql, applied by '
                '`npm run db:reset`. In deployment it is a one-time step: '
                'CREATE ROLE vendlyfy_app LOGIN PASSWORD ''<secret>'' '
                'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;';
    END IF;
END
$init$;


-- =============================================================================
-- 2. Database-level settings
-- =============================================================================
-- UTC at the database level, not only in the container's command flags, so that
-- a managed instance configured otherwise still behaves identically. Takes
-- effect for new sessions.
--
-- current_database() rather than a literal name: the deployed database will not
-- necessarily be called "vendlyfy", and a migration that hardcodes it would fail
-- there.

DO $init$
BEGIN
    EXECUTE format('ALTER DATABASE %I SET timezone = %L', current_database(), 'UTC');
END
$init$;


-- =============================================================================
-- 3. Privileges
-- =============================================================================
-- Two roles, here and in deployment (§4.4):
--
--   the owner (whoever runs this migration) owns every object and runs all DDL
--   vendlyfy_app                          connects, reads and writes rows, owns
--                                         nothing, and cannot create anything
--
-- NOTE for deployment: revoking CONNECT from PUBLIC means any other role needs
-- an explicit grant. If the managed provider has monitoring or backup tooling
-- that connects as an unprivileged role, grant it CONNECT explicitly.

DO $init$
BEGIN
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO vendlyfy_app', current_database());
END
$init$;

-- PG15 already withholds CREATE on schema public from PUBLIC; USAGE is still
-- granted to it. Withdraw that too and grant it to exactly one role.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vendlyfy_app;

-- Default privileges, so that no later migration has to remember a GRANT. With
-- no FOR ROLE clause these attach to the role running this migration, which is
-- the role that will create every table — and that works whatever the deployed
-- owner role happens to be called.
--
-- DELETE is granted by default. Append-only tables — the audit log, the wallet
-- ledger — must REVOKE DELETE and UPDATE for vendlyfy_app in their own
-- migration. That is a deliberate choice: the exception is rare enough to be
-- worth stating explicitly where it applies.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vendlyfy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO vendlyfy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO vendlyfy_app;

-- Postgres grants EXECUTE on new functions to PUBLIC by default. Schema USAGE is
-- already withdrawn above, so this is belt and braces — but it costs nothing and
-- it means the grant above is the only path to executing anything.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;


-- =============================================================================
-- 4. Shared objects
-- =============================================================================
-- One trigger function, used by every table that carries updated_at. Written
-- here so that no later migration re-declares it slightly differently.
--
-- SET search_path is not decoration: without it, a function resolves unqualified
-- names against the caller's search_path, which is how a function can be made to
-- call something it did not mean to.

CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$init$;

COMMENT ON FUNCTION set_updated_at() IS
    'BEFORE UPDATE trigger: stamps updated_at with now(). Unconditional — an update that changes no column still moves the timestamp.';
