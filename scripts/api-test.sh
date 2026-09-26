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

# AND THE OWNER'S, FOR TEARDOWN ONLY — added at milestone 16, and the reason is a property of the schema
# rather than a convenience. V009 makes a review undeletable BY ANYBODY: `reviews_immutable` raises on
# DELETE for every role, including the table's owner, because "Reviews go live straight away and stay."
# That is exactly right in production and it means a test that posts a review cannot remove it, and
# therefore cannot remove the store it belongs to either. Teardown disables that one trigger for the
# length of one transaction, which needs table ownership.
#
# NOTHING BUT cleanup() MAY USE THIS. Every fixture and every request still goes through the app role, so
# no test can reach a state the application could not: see the header of test/api/support.ts.
export OWNER_DATABASE_URL="${OWNER_DATABASE_URL:-$OWNER_URL}"

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

# GLOBBED, NOT LISTED. This was an explicit list of ten files until milestone 16 added an eleventh and
# the suite went green without running it — 168 tests before and 168 after, which looks like a pass. The
# rule db:test already follows applies here for the same reason: "a new suite is picked up by CI the
# moment it exists". Order is the shell's, which is alphabetical and therefore stable; it does not matter
# because every suite calls cleanup() before seeding its own fixtures, and --test-concurrency=1 means no
# two of them are ever in the database at once.
shopt -s nullglob
suites=(test/api/*.test.ts)
[ "${#suites[@]}" -gt 0 ] || die "no test files matched test/api/*.test.ts"
info "suites    ${#suites[@]} files"

exec node --test --test-concurrency=1 "${suites[@]}"
