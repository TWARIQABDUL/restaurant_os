
#!/usr/bin/env bash
#
# Wrapper around db/scripts/migrate.ts.
#
# Local:
#   npm run db:migrate
#   npm run db:migrate -- --dry-run
#   npm run db:migrate:status
#   npm run db:migrate:new -- "add product variants"
#
# Remote:
#   Uses MIGRATION_DATABASE_URL from server/.env.
#   Never uses APP_DATABASE_URL for migrations.
#   No Docker dependency when a migration URL is provided.

set -e

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"

# `new` only creates a migration file.
# It does not require environment variables, a database, or Docker.
if [ "${1:-}" = "new" ]; then
    exec node "$SELF_DIR/migrate.ts" "$@"
fi

# Load project environment variables.
ENV_FILE="$REPO_ROOT/server/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: Environment file not found: $ENV_FILE" >&2
    exit 1
fi

# Project .env values take precedence over inherited shell variables.
set -a
source "$ENV_FILE"
set +a

# Use the dedicated migration database connection when configured.
# Never fall back to APP_DATABASE_URL or a global DATABASE_URL.
if [ -n "${MIGRATION_DATABASE_URL:-}" ]; then
    export DATABASE_URL="$MIGRATION_DATABASE_URL"
    exec node "$SELF_DIR/migrate.ts" "$@"
fi

# No migration URL: use the local Docker database.
. "$SELF_DIR/_lib.sh"

require_docker

[ "$(container_state)" = "running" ] || \
    die "the local database is not running. Run: npm run db:up"

export DATABASE_URL="$OWNER_URL"

exec node "$SELF_DIR/migrate.ts" "$@"
