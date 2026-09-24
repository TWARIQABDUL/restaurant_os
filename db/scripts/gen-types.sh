#!/usr/bin/env bash
#
# Supplies the local connection string to gen-types.ts, the same way migrate.sh
# does, so there is no second copy of it.
#
#   npm run db:types
#   npm run db:types -- --check

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${DATABASE_URL:-}" ]; then
    . "$SELF_DIR/_lib.sh"
    require_docker
    [ "$(container_state)" = "running" ] || die "the local database is not running. Run: npm run db:up"
    export DATABASE_URL="$OWNER_URL"
fi

exec node "$SELF_DIR/gen-types.ts" "$@"
