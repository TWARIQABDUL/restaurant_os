#!/usr/bin/env bash
#
# The admin console's schema — milestone 27, V029_identity_notifications.sql and V030_suspension_hold.sql.
#
# V029 adds two notification kinds and V030 makes a payout wait while a store is suspended. server/test/api/admin.test.ts covers both
# through the endpoints; this suite holds against a writer that is not the API, and against a request that skips the route.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_admin_console_test"
TEST_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${TEST_DB}"
PASSED=0; FAILED=0; LAST=""

cleanup() {
    psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT
require_docker
[ "$(container_state)" = "running" ] || die "the database is not running. Run: npm run db:up"

pass()  { PASSED=$((PASSED + 1)); printf '  [pass] %s\n' "$1"; }
flunk() { FAILED=$((FAILED + 1)); printf '  [FAIL] %s\n' "$1" >&2; printf '%s\n' "$LAST" | sed 's/^/         | /' >&2; }
sql()   { LAST="$(psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$TEST_DB" -q -c "$1" 2>&1)"; }
q()     { psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$TEST_DB" -tAc "$1" 2>/dev/null || echo '?'; }
accepts() { if sql "$2"; then pass "$1"; else flunk "$1 — expected it to be accepted"; fi; }
refuses() { if sql "$3"; then flunk "$1 — it was ACCEPTED"; elif printf '%s' "$LAST" | grep -q "$2"; then pass "$1"; else flunk "$1 — refused, but not by '$2'"; fi; }
equals()  { local got; got="$(q "$3")"; if [ "$got" = "$2" ]; then pass "$1"; else LAST="query: $3"$'\n'"got:   $got"$'\n'"want:  $2"; flunk "$1"; fi; }

STORE="aaaaaaaa-5000-4000-8000-000000000001"
OTHER="aaaaaaaa-5000-4000-8000-000000000002"

printf '\nAdmin console schema tests\n'
info "database  : ${TEST_DB}"

step "Building the schema"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" -c "CREATE DATABASE ${TEST_DB}" >/dev/null
if DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" >/dev/null 2>&1; then
    pass "the migrations apply to an empty database"
else
    LAST="$(DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" 2>&1)"; flunk "migrations did not apply"
    printf '\n%s\n' "$PASSED passed, $FAILED failed."; exit 1
fi

step "The two notifications for the identity decisions nobody told the merchant about"
equals "a retake is amber and for the people who can act on it" "attention|{owner,admin}|/app/verify" \
    "SELECT tone || '|' || visible_to_roles::text || '|' || route FROM notification_types WHERE code = 'identity_retake'"
equals "a rejection is red, with the same audience and destination" "bad|{owner,admin}|/app/verify" \
    "SELECT tone || '|' || visible_to_roles::text || '|' || route FROM notification_types WHERE code = 'identity_rejected'"
equals "neither is an alert that rings the kitchen" "0" \
    "SELECT count(*) FROM notification_types WHERE code IN ('identity_retake','identity_rejected') AND is_alert"

accepts "two stores" \
    "INSERT INTO stores (id, slug, name, country, selling_currency, status) VALUES
        ('$STORE', 'admin-test-a', 'Admin Test A', 'RW', 'RWF', 'active'),
        ('$OTHER', 'admin-test-b', 'Admin Test B', 'RW', 'RWF', 'active')"

step "A suspended store's payouts wait"
refuses "the identity gate says so" "not been verified" "SELECT request_withdrawal('$OTHER', 1000, '0781234567', 'admin-hold-key-0001')"
accepts "suspend the first store" "UPDATE stores SET status = 'suspended' WHERE id = '$STORE'"
refuses "a suspended store's payout waits, and says it is the suspension" "this store is suspended" \
    "SELECT request_withdrawal('$STORE', 1000, '0781234567', 'admin-hold-key-0002')"
refuses "the suspension is checked before the identity gate, so the merchant is told the truer thing" "suspended" \
    "SELECT request_withdrawal('$STORE', 1000, '0781234567', 'admin-hold-key-0003')"
equals "nothing was written by either refusal" "0" "SELECT count(*) FROM withdrawals WHERE store_id IN ('$STORE', '$OTHER')"
accepts "reinstate it" "UPDATE stores SET status = 'active' WHERE id = '$STORE'"
refuses "and it is back to being held by the identity gate alone" "not been verified" \
    "SELECT request_withdrawal('$STORE', 1000, '0781234567', 'admin-hold-key-0004')"
equals "the function still carries V012's two other holds" "t" \
    "SELECT (prosrc LIKE '%store_is_verified%' AND prosrc LIKE '%queued%') FROM pg_proc WHERE proname = 'request_withdrawal'"

step "The two platform permissions the configuration screens ask for (V031)"
equals "super_admin holds both" "currencies.manage|payment_methods.manage" \
    "SELECT string_agg(permission, '|' ORDER BY permission) FROM role_permissions WHERE scope = 'platform' AND role = 'super_admin' AND permission IN ('payment_methods.manage','currencies.manage')"
equals "and no store role holds either — a merchant, however senior, cannot switch a provider off for everyone" "0" \
    "SELECT count(*) FROM role_permissions WHERE scope = 'store' AND permission IN ('payment_methods.manage','currencies.manage')"
refuses "a store role cannot be granted a platform permission by mistake" "role_permissions" \
    "INSERT INTO role_permissions (scope, role, permission) VALUES ('platform', 'owner', 'currencies.manage')"

printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ]
