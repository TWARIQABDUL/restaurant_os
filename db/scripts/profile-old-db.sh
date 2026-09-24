#!/usr/bin/env bash
#
# Runs the read-only profile against the OLD (Supabase) database.
#
# Its only job is to supply DATABASE_URL from server/.env when it is not already
# in the environment, and to print the target without its password so you can see
# what you are about to read before it reads it.
#
#   npm run db:profile
#   npm run db:profile -- --out -        print instead of writing the report
#   DATABASE_URL=... npm run db:profile  read something else
#
# This TALKS TO PRODUCTION. Everything it runs is a SELECT inside a read-only
# transaction, and the script aborts unless the server first refuses a write.

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"

if [ -z "${DATABASE_URL:-}" ]; then
    ENV_FILE="$REPO_ROOT/server/.env"
    if [ ! -f "$ENV_FILE" ]; then
        echo "FAIL: DATABASE_URL is not set and $ENV_FILE does not exist." >&2
        exit 1
    fi
    value="$(sed -n 's/^[[:space:]]*DATABASE_URL=//p' "$ENV_FILE" | head -1)"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    if [ -z "$value" ]; then
        echo "FAIL: no DATABASE_URL line in $ENV_FILE." >&2
        exit 1
    fi
    export DATABASE_URL="$value"
    echo "  read DATABASE_URL from server/.env"
fi

# Host and database only. Never echo the password.
safe="$(printf '%s' "$DATABASE_URL" | sed -E 's|^[a-z]+://[^@]*@||')"
printf '\n  Target: %s\n  Mode:   read-only (the server must refuse a write before any probe runs)\n\n' "$safe"

exec node "$SELF_DIR/profile-old-db.ts" "$@"
