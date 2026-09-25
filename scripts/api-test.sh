#!/usr/bin/env bash
#
# The new server's test suite — milestone 11.
#
#   npm run api:test                       everything under server/test/api
#   npm run api:test -- test/api/guard.test.ts    one file
#
# Its only job, the same as migrate.sh and seed.sh, is to supply the LOCAL connection
# string out of docker-compose.yml so no test file holds a second copy of it. It exports
# the APP role's URL, not the owner's: these tests exercise what the application can do,
# and a fixture written with DDL rights would be testing something the app cannot.
#
# --test-concurrency=1 is not a performance setting. The suites share one database and
# one set of fixture ids, and each one truncates its own fixtures on the way in; run in
# parallel they would delete each other's rows mid-test.

# NOT in db/scripts/, deliberately. `npm run db:test` globs db/scripts/test-*.sh "so a new
# suite is picked up by CI the moment it exists", and this is not a database suite — it
# boots an Express app. Living there made db:test run it as well as the dedicated CI job,
# which doubled the work and blurred that workflow's rule that "one failure names one
# thing". It still sources _lib.sh, because the connection string has exactly one home.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/../db/scripts/_lib.sh"

require_docker
[ "$(container_state)" = "running" ] || die "the local database is not running. Run: npm run db:up"

export APP_DATABASE_URL="${APP_DATABASE_URL:-$APP_URL}"

# A local, worthless secret, long enough to satisfy assertSessionConfig(). A real one
# comes from the environment; this exists so `npm run api:test` needs no setup.
export JWT_SECRET="${JWT_SECRET:-local-test-secret-not-for-any-deployment-0123456789}"

# The limiters key on req.ip and one suite drives dozens of requests from one address.
# rateLimit.js reads this variable rather than sniffing NODE_ENV, "so it can never be
# true by accident in a deployment".
export RATE_LIMIT_DISABLED=true

step "API suite"
info "database  $APP_ROLE@${HOST_ADDR}:${HOST_PORT}/${DB_NAME}"

cd "$REPO_ROOT/server"

if [ "$#" -gt 0 ]; then
    exec node --test --test-concurrency=1 "$@"
fi

exec node --test --test-concurrency=1 \
    test/api/no-supabase.test.ts \
    test/api/boot.test.ts \
    test/api/transactions.test.ts \
    test/api/authorization.test.ts \
    test/api/guard.test.ts \
    test/api/members.test.ts \
    test/api/payouts.test.ts
