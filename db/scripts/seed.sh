#!/usr/bin/env bash
#
# Wrapper around db/seeds/dev.ts, the same shape as migrate.sh: its only job is to
# supply the LOCAL connection string from docker-compose.yml, so the seed holds no
# second copy of it.
#
#   npm run db:seed                    fixtures + 30,000 generated orders
#   npm run db:seed -- --yes           without the confirmation prompt
#   npm run db:seed -- --dry-run       run every check, write nothing
#   npm run db:seed -- --orders=0      fixtures only, for a fast loop
#
# With DATABASE_URL already set this gets out of the way and never looks for docker —
# and the seed's own guardrails then decide whether that target is one it will write
# to (see the header of dev.ts).

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${DATABASE_URL:-}" ]; then
    exec node "$SELF_DIR/../seeds/dev.ts" "$@"
fi

. "$SELF_DIR/_lib.sh"
require_docker
[ "$(container_state)" = "running" ] || die "the local database is not running. Run: npm run db:up"
export DATABASE_URL="$OWNER_URL"
exec node "$SELF_DIR/../seeds/dev.ts" "$@"
