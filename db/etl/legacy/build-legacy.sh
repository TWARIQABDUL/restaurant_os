#!/usr/bin/env bash
#
# Builds a throwaway copy of the OLD database shape for rehearsing the one-off data migration.
#
#   bash db/etl/legacy/build-legacy.sh [database-name]     (default: vendlyfy_legacy)
#
# The schema is rebuilt from supabase/*.sql in the order they were applied in production, on top of stubs for the
# Supabase-only things they mention (the storage schema and its roles); then fixture.sql adds synthetic rows shaped
# like the production profile. NO real data is read or needed. The real rehearsal restores a dump of the live
# database into a scratch database and points the ETL at that instead.

. "$(dirname "${BASH_SOURCE[0]}")/../../scripts/_lib.sh"

DB="${1:-vendlyfy_legacy}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
require_docker
[ "$(container_state)" = "running" ] || die "the local database is not running. Run: npm run db:up"

P() { docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$OWNER_PASSWORD" "$SERVICE" psql -h 127.0.0.1 -U "$OWNER_ROLE" -v ON_ERROR_STOP=1 -q "$@"; }

P -d "$DB_NAME" -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" -c "CREATE DATABASE ${DB}" >/dev/null
P -d "$DB" >/dev/null <<'SQL'
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
CREATE TABLE storage.objects (id uuid, bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL

# lockdown-*.sql are deliberately skipped: they only alter Supabase policies and roles.
for f in schema categories inventory generalize-catalogue option-sizes product-variants momo refund complaints escalate reviews currency currency-cleanup refund-hardening platform-settings; do
    P -d "$DB" < "$REPO_ROOT/supabase/$f.sql" >/dev/null 2>"$SELF_DIR/.err" || { cat "$SELF_DIR/.err" >&2; die "supabase/$f.sql did not apply"; }
done
rm -f "$SELF_DIR/.err"

P -d "$DB" < "$SELF_DIR/fixture.sql" >/dev/null || die "fixture.sql did not apply"
ok "built ${DB}: the old schema plus the synthetic rows"
