#!/usr/bin/env bash
#
# Wrapper around db/scripts/migrate.ts.
#
# Its only jobs: supply the LOCAL connection string from docker-compose.yml, so
# the runner holds no second copy of it, and require docker only when the local
# container is in fact the target.
#
#   npm run db:migrate                 apply everything pending, locally
#   npm run db:migrate -- --dry-run     show what would apply, touching nothing
#   npm run db:migrate:status
#   npm run db:migrate:new -- "add product variants"
#
# With DATABASE_URL already set — deployment, CI, or a test database — this gets
# out of the way entirely and never looks for docker.

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `new` only writes a file. It must work with no database and no container.
if [ "${1:-}" = "new" ]; then
    exec node "$SELF_DIR/migrate.ts" "$@"
fi

if [ -n "${DATABASE_URL:-}" ]; then
    exec node "$SELF_DIR/migrate.ts" "$@"
fi

. "$SELF_DIR/_lib.sh"
require_docker
[ "$(container_state)" = "running" ] || die "the local database is not running. Run: npm run db:up"
export DATABASE_URL="$OWNER_URL"
exec node "$SELF_DIR/migrate.ts" "$@"
