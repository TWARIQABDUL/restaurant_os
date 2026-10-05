#!/usr/bin/env bash
#
# Who is who, and who may — milestone 24, V026_support_and_insight.sql.
#
# V026 adds no business rule that needs a narrative; it adds three permissions, the identity function Customers matches
# people with, and the table a private note lives in. What matters, and what this suite pins, is that the identity function
# does what the board's one sentence asks — "Guests are matched by phone number" — across the spellings people actually
# type, and that the permissions land on the roles the nav already shows these screens to and no others.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_support_console_test"
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

printf '\nSupport console acceptance tests\n'
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

step "Who is who: one number, however it was typed"
equals "+250 with spaces" "784559012" "SELECT customer_key('+250 78 455 9012')"
equals "250 with no plus" "784559012" "SELECT customer_key('250784559012')"
equals "the local spelling" "784559012" "SELECT customer_key('078 455 9012')"
equals "with punctuation" "784559012" "SELECT customer_key('(078) 455-9012')"
equals "a 00 international prefix" "784559012" "SELECT customer_key('00250784559012')"
equals "so all five are one person" "1" "SELECT count(DISTINCT customer_key(p)) FROM unnest(ARRAY['+250 78 455 9012','250784559012','078 455 9012','(078) 455-9012','00250784559012']) p"
equals "a different number is a different person" "f" "SELECT customer_key('078 455 9012') = customer_key('078 455 9013')"
equals "something too short to identify anybody is nobody" "" "SELECT COALESCE(customer_key('12345'), '')"
equals "and so is a blank" "" "SELECT COALESCE(customer_key(''), '')"
equals "NULL stays NULL, so an account with no number falls through to its user id" "" "SELECT COALESCE(customer_key(NULL), '')"
equals "the function can be used in an index (it is IMMUTABLE)" "i" "SELECT provolatile FROM pg_proc WHERE proname = 'customer_key'"

step "The private note"
FASHION="$(q "SELECT id FROM industry_templates WHERE key='fashion'")"
ST='11111111-0000-4000-8000-000000000026'
accepts "a store" "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version)
    VALUES ('${ST}','support-test','Support Test','RW','RWF','active','${FASHION}',1)"
accepts "a note" "INSERT INTO customer_notes (store_id, customer_key, note) VALUES ('${ST}', '784559012', 'Allergic to peanuts')"
refuses "one note per customer per store" "customer_notes_pkey" "INSERT INTO customer_notes (store_id, customer_key, note) VALUES ('${ST}', '784559012', 'again')"
refuses "an empty note is not a note — the app deletes the row instead" "customer_notes_note_present" "INSERT INTO customer_notes (store_id, customer_key, note) VALUES ('${ST}', '780000001', '   ')"
refuses "a note has a length, so a customer's page cannot be turned into storage" "customer_notes_note_length" \
    "INSERT INTO customer_notes (store_id, customer_key, note) VALUES ('${ST}', '780000002', repeat('x', 501))"
accepts "five hundred is fine" "INSERT INTO customer_notes (store_id, customer_key, note) VALUES ('${ST}', '780000003', repeat('x', 500))"
accepts "deleting a store takes its notes (its wallet goes first: V005 restricts it)" "DELETE FROM wallets WHERE store_id = '${ST}'; DELETE FROM stores WHERE id = '${ST}'"
equals "none left" "0" "SELECT count(*) FROM customer_notes"

step "Who may"
for role in owner admin manager; do
    equals "$role may answer complaints and reviews" "t" "SELECT EXISTS (SELECT 1 FROM role_permissions WHERE scope='store' AND role='${role}' AND permission='support.write')"
    equals "$role may see customers" "t" "SELECT EXISTS (SELECT 1 FROM role_permissions WHERE scope='store' AND role='${role}' AND permission='customers.read')"
    equals "$role may write a customer's note" "t" "SELECT EXISTS (SELECT 1 FROM role_permissions WHERE scope='store' AND role='${role}' AND permission='customers.write')"
done
equals "a rider holds none of the three" "0" "SELECT count(*) FROM role_permissions WHERE role='rider' AND permission IN ('support.write','customers.read','customers.write')"
equals "and neither does a super admin by wildcard (permissions are listed, never implied)" "0" "SELECT count(*) FROM role_permissions WHERE scope='platform' AND permission IN ('support.write','customers.read','customers.write')"
equals "a manager still cannot read the takings: wallet.read is not theirs" "f" "SELECT EXISTS (SELECT 1 FROM role_permissions WHERE role='manager' AND permission='wallet.read')"

step "Indexes"
equals "the guest arm of the Customers aggregate" "t" "SELECT indexdef LIKE '%customer_key(guest_phone)%' FROM pg_indexes WHERE indexname='orders_store_guest_key_idx'"

printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ]
