#!/usr/bin/env bash
#
# Rehearses the one-off data migration locally (milestone 29):
#
#   npm run etl:rehearse                    build the synthetic old database, migrate it into a fresh new one, print the report
#   npm run etl:rehearse -- --out r.md      also write the report
#   npm run etl:rehearse -- --keep          leave both databases behind to look at
#
# For the REAL rehearsal, restore a dump of the live database into a scratch database and run
#   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… node db/etl/run.ts --out report.md
# against a freshly migrated empty target. See docs/migration/06-etl-runbook.md.

. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLD="vendlyfy_etl_old"; NEW="vendlyfy_etl_new"
KEEP=0; ARGS=()
for a in "$@"; do if [ "$a" = "--keep" ]; then KEEP=1; else ARGS+=("$a"); fi; done

require_docker
[ "$(container_state)" = "running" ] || die "the local database is not running. Run: npm run db:up"
cleanup() { [ "$KEEP" = "1" ] || for d in "$OLD" "$NEW"; do psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q -c "DROP DATABASE IF EXISTS ${d} WITH (FORCE)" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

step "Building the old database (synthetic, shaped like the production profile)"
bash "$SELF_DIR/../etl/legacy/build-legacy.sh" "$OLD"

step "Building a fresh new database"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q -c "DROP DATABASE IF EXISTS ${NEW} WITH (FORCE)" -c "CREATE DATABASE ${NEW}" >/dev/null
DATABASE_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${NEW}" node "$SELF_DIR/migrate.ts" >/dev/null || die "migrations did not apply"
ok "migrated ${NEW}"

step "Running the migration"
SOURCE_DATABASE_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${OLD}" \
TARGET_DATABASE_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${NEW}" \
    node "$SELF_DIR/../etl/run.ts" "${ARGS[@]}"
