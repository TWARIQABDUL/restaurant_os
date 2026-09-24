#!/usr/bin/env bash
#
# Proves milestone 1's done-when: "db:up gives a reachable empty database;
# db:reset rebuilds it from nothing."
#
# Prerequisites are fatal immediately — there is nothing to check on a container
# that isn't running. Everything after that is collected, so one run tells you
# every problem rather than the first one.
#
#   npm run db:verify                 report the state, assert what must be true
#   npm run db:verify -- --expect-empty   additionally assert zero tables in public
#
# --expect-empty is what milestone 1 and db:reset assert. It is deliberately NOT
# the default: from milestone 2 onward the database legitimately holds
# schema_migrations and then the schema itself.

. "$(dirname "$0")/_lib.sh"

EXPECT_EMPTY=0
for arg in "$@"; do
    case "$arg" in
        --expect-empty) EXPECT_EMPTY=1 ;;
        *) die "unknown argument: $arg (accepts --expect-empty)" ;;
    esac
done

FAILURES=0
check() { # check <description> <actual> <expected>
    if [ "$2" = "$3" ]; then ok "$1: $2"
    else bad "$1: got '$2', expected '$3'"; FAILURES=$((FAILURES + 1)); fi
}

require_docker

step "Container"
state="$(container_state)"
[ "$state" = "running" ] || die "container is '$state', not running. Run: npm run db:up"
ok "state: running"

health="$(container_health)"
[ "$health" = "healthy" ] || die "healthcheck is '$health', not healthy. Run: npm run db:logs"
ok "healthcheck: healthy"

step "Reachability from this host"
# The only check that proves the published port mapping. Docker Desktop forwards
# 127.0.0.1:$HOST_PORT from a VM; a connect from inside the container would pass
# even with the mapping broken.
host_port_open || die "nothing accepting TCP on ${HOST_ADDR}:${HOST_PORT} from this host, though the container is healthy. The port publish in docker-compose.yml is broken."
ok "TCP ${HOST_ADDR}:${HOST_PORT} accepts connections"

step "Authentication (over TCP, so passwords are actually exercised)"
owner_ok="$(scalar_as "$OWNER_ROLE" "$OWNER_PASSWORD" 'SELECT 1' 2>/dev/null || echo fail)"
check "owner role '${OWNER_ROLE}' can log in" "$owner_ok" "1"
[ "$owner_ok" = "1" ] || die "the owner role cannot authenticate; nothing further can be checked."

app_ok="$(scalar_as "$APP_ROLE" "$APP_PASSWORD" 'SELECT 1' 2>/dev/null || echo fail)"
check "app role '${APP_ROLE}' can log in" "$app_ok" "1"
if [ "$app_ok" != "1" ]; then
    note "db/bootstrap/local.sql creates ${APP_ROLE}. It runs only on an EMPTY data directory —"
    note "if you added or changed it after the volume existed, run: npm run db:reset -- -y"
fi

step "Version"
server_major="$(scalar_as "$OWNER_ROLE" "$OWNER_PASSWORD" "SELECT current_setting('server_version_num')::int / 10000" 2>/dev/null || echo '?')"
check "server major version matches the pin in docker-compose.yml (${PG_IMAGE})" "$server_major" "$PG_MAJOR"
info "full version: $(scalar_as "$OWNER_ROLE" "$OWNER_PASSWORD" 'SHOW server_version' 2>/dev/null || echo '?')"
note "this must equal the deployed instance's major version — see db/README.md"

step "Settings that must match deployment"
check "timezone" "$(scalar_as "$OWNER_ROLE" "$OWNER_PASSWORD" 'SHOW timezone' 2>/dev/null || echo '?')" "UTC"
check "data checksums" "$(scalar_as "$OWNER_ROLE" "$OWNER_PASSWORD" 'SHOW data_checksums' 2>/dev/null || echo '?')" "on"
check "pg_stat_statements preloaded" \
    "$(scalar_as "$OWNER_ROLE" "$OWNER_PASSWORD" "SELECT current_setting('shared_preload_libraries') LIKE '%pg_stat_statements%'" 2>/dev/null || echo '?')" "t"
check "pg_stat_statements extension created (bootstrap ran)" \
    "$(scalar_as "$OWNER_ROLE" "$OWNER_PASSWORD" "SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'" 2>/dev/null || echo '?')" "1"

step "Least privilege"
check "${APP_ROLE} is not a superuser" \
    "$(scalar_as "$OWNER_ROLE" "$OWNER_PASSWORD" "SELECT rolsuper FROM pg_roles WHERE rolname = '${APP_ROLE}'" 2>/dev/null || echo '?')" "f"
check "${APP_ROLE} cannot create objects in schema public" \
    "$(scalar_as "$OWNER_ROLE" "$OWNER_PASSWORD" "SELECT has_schema_privilege('${APP_ROLE}', 'public', 'CREATE')" 2>/dev/null || echo '?')" "f"
note "the app role's table privileges are granted by V000, not by the bootstrap — §4.2"

step "Schema"
tables="$(scalar_as "$OWNER_ROLE" "$OWNER_PASSWORD" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')" 2>/dev/null || echo '?')"
if [ "$EXPECT_EMPTY" = "1" ]; then
    check "tables in schema public (expecting an empty database)" "$tables" "0"
else
    info "tables in schema public: ${tables}"
fi

step "Connection strings"
info "migrations / psql : ${OWNER_URL}"
info "application       : ${APP_URL}"

if [ "$FAILURES" -gt 0 ]; then
    printf '\n%s\n' "FAIL: ${FAILURES} check(s) failed."
    exit 1
fi
printf '\n%s\n' "All checks passed. Database is reachable at ${HOST_ADDR}:${HOST_PORT}."
