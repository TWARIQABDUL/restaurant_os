#!/usr/bin/env bash
#
# An interactive psql on the local database, as the owner role, using the
# container's own client so nothing needs installing on the host.
#
#   npm run db:psql
#   npm run db:psql -- -c "SELECT version()"

. "$(dirname "$0")/_lib.sh"

require_docker
[ "$(container_state)" = "running" ] || die "the database is not running. Run: npm run db:up"

exec docker compose -f "$COMPOSE_FILE" exec -e "PGPASSWORD=${OWNER_PASSWORD}" "$SERVICE" \
    psql -h 127.0.0.1 -U "$OWNER_ROLE" -d "$DB_NAME" "$@"
