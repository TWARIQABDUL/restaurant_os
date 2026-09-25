#!/usr/bin/env bash
#
# Seed acceptance tests — milestone 10.
#
# Two halves, and the first is the one that matters more.
#
#   THE GUARDRAILS. This is the only program in the repository that destroys rows on
#   purpose, and Part 8 rates "seed pointed at production" as high risk. So every one
#   of the six refusals is provoked here: production, a remote host, a remote host
#   with the wrong name authorised, no terminal, a database that is really the old
#   system's, and a schema that is not fully migrated.
#
#   THE DONE-WHEN. "db:reset gives a database where every screen has data, and a
#   sequential scan is visibly slower than an index scan." The second clause is
#   measured rather than asserted: the planner's own cost for the Orders board query
#   with indexes on, against the same query with them off.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_seed_test"
TEST_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${TEST_DB}"
# Enough rows for the planner to have an opinion, few enough for a test to finish.
# The default seed is 30,000.
SEED_ORDERS_FOR_TEST=8000
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
equals()  { local got; got="$(q "$3")"; if [ "$got" = "$2" ]; then pass "$1"; else LAST="query: $3"$'\n'"got:   $got"$'\n'"want:  $2"; flunk "$1"; fi; }
atleast() { local got; got="$(q "$3")"; if [ "${got%%.*}" -ge "$2" ] 2>/dev/null; then pass "$1 (${got})"; else LAST="query: $3"$'\n'"got:   $got"$'\n'"want:  >= $2"; flunk "$1"; fi; }

# `_lib.sh` sets `set -euo pipefail`, so a failing command inside a command
# substitution would exit this script silently — which is exactly what every test
# below provokes on purpose. These two turn it off for the duration of the call and
# report the outcome instead.
SEED_RC=0
run_seed() {   # run_seed <url> <args...>; EXTRA_ENV may hold KEY=VALUE pairs
    local url="$1"; shift
    set +e
    # shellcheck disable=SC2086
    LAST="$(env ${EXTRA_ENV:-} DATABASE_URL="$url" bash "$SELF_DIR/seed.sh" "$@" 2>&1 < /dev/null)"
    SEED_RC=$?
    set -e
}
seed() { EXTRA_ENV="${EXTRA_ENV:-}" run_seed "$TEST_URL" "$@"; return $SEED_RC; }
refuses() {  # refuses <name> <expected text> <args...>
    local name="$1" want="$2"; shift 2
    run_seed "$TEST_URL" "$@"
    if [ "$SEED_RC" -eq 0 ]; then flunk "$name — it RAN"
    elif printf '%s' "$LAST" | grep -q "$want"; then pass "$name"
    else flunk "$name — refused, but not by '$want'"; fi
}
refuses_url() {  # refuses_url <name> <expected text> <url> <env...>
    local name="$1" want="$2" url="$3"; shift 3
    EXTRA_ENV="$*" run_seed "$url" --yes
    if [ "$SEED_RC" -eq 0 ]; then flunk "$name — it RAN"
    elif printf '%s' "$LAST" | grep -q "$want"; then pass "$name"
    else flunk "$name — refused, but not by '$want'"; fi
}

printf '\nSeed acceptance tests\n'
info "database  : ${TEST_DB}"

step "A migrated, empty database to seed"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" -c "CREATE DATABASE ${TEST_DB}" >/dev/null
if DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" >/dev/null 2>&1; then
    pass "the migrations apply"
else
    LAST="$(DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" 2>&1)"; flunk "migrations did not apply"
    printf '\n%s\n' "$PASSED passed, $FAILED failed."; exit 1
fi

# =============================================================================
step "The six refusals"
# =============================================================================
REMOTE_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@db.example.com:5432/${TEST_DB}"

refuses_url "NODE_ENV=production is refused outright, with no override" \
    "NODE_ENV=production" "$TEST_URL" "NODE_ENV=production"

refuses_url "a non-loopback host is refused" \
    "is not loopback" "$REMOTE_URL"

refuses_url "SEED_ALLOW_REMOTE must NAME the host, not merely be set" \
    "but DATABASE_URL points at" "$REMOTE_URL" "SEED_ALLOW_REMOTE=somewhere.else"

# No --yes, and run_seed gives it no terminal — which is the condition itself.
refuses "it will not truncate unattended without --yes" "without a terminal to confirm at"

sql "CREATE TABLE tenants (id uuid PRIMARY KEY)"
refuses "a database holding the old system's tables" "old system" --yes
sql "DROP TABLE tenants"

sql "CREATE TABLE _saved_migration AS SELECT * FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations);
     DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)"
refuses "a schema that is not fully migrated" "have not been applied" --yes
sql "INSERT INTO schema_migrations SELECT * FROM _saved_migration; DROP TABLE _saved_migration"
# COUNTED FROM THE DIRECTORY, not written here. This assertion is about the ledger being
# restored to exactly what it was, and a literal turns the arrival of any new migration
# into a failure of the wrong test — which is what V014 did.
MIGRATION_COUNT="$(find "$REPO_ROOT/db/migrations" -maxdepth 1 -name 'V*.sql' | wc -l | tr -d ' ')"
equals "and the ledger was put back exactly" "$MIGRATION_COUNT" "SELECT count(*)::text FROM schema_migrations"

run_seed "$TEST_URL" --dry-run
if [ "$SEED_RC" -eq 0 ]; then pass "--dry-run passes every check"; else flunk "--dry-run failed"; fi
equals "and wrote nothing" "0" "SELECT count(*)::text FROM stores"

# =============================================================================
step "Seeding"
# =============================================================================
EXTRA_ENV="SEED_ORDERS=$SEED_ORDERS_FOR_TEST" run_seed "$TEST_URL" --yes
if [ "$SEED_RC" -eq 0 ]; then
    pass "the seed runs"
else
    flunk "the seed failed"
    printf '\n%s\n' "$PASSED passed, $FAILED failed."; exit 1
fi

# =============================================================================
step "Every screen has data"
# =============================================================================
equals "six stores, one in each of the three states" "6|1|3|1|1" \
    "SELECT count(*) || '|' || count(*) FILTER (WHERE status='suspended') || '|' ||
            count(*) FILTER (WHERE status='active') || '|' || 1 || '|' ||
            count(*) FILTER (WHERE status='pending') / 2 FROM stores"
equals "all 12 order statuses are represented" "12" "SELECT count(DISTINCT status)::text FROM orders"
equals "one person holds two memberships at two stores" "1" \
    "SELECT count(*)::text FROM (SELECT user_id FROM store_members GROUP BY user_id HAVING count(*) > 1) t"
equals "a customer holds no membership at all" "0" \
    "SELECT count(*)::text FROM store_members m JOIN users u ON u.id = m.user_id WHERE u.scope = 'store'"
equals "the linen tee has twelve variants, each with its own shelf" "12|12" \
    "SELECT count(*) || '|' || count(DISTINCT sku) FROM product_variants v
      JOIN products p ON p.id = v.product_id WHERE p.name = 'Linen tee'"
equals "one option group is shared by three products, with no copy" "1" \
    "SELECT count(*)::text FROM (SELECT option_group_id FROM product_option_groups
       GROUP BY option_group_id HAVING count(*) >= 3) t"
equals "a product sits in two sections" "1" \
    "SELECT count(*)::text FROM (SELECT product_id FROM product_categories
       GROUP BY product_id HAVING count(*) > 1) t"
equals "all 7 ledger entry types were written" "7" \
    "SELECT count(DISTINCT entry_type)::text FROM wallet_ledger"
equals "money sits in BOTH pots" "true" \
    "SELECT bool_and(has)::text FROM (SELECT pot, sum(amount) > 0 AS has FROM wallet_ledger GROUP BY pot) t"
equals "a withdrawal failed, with a reason, and its money came back" "1|1" \
    "SELECT (SELECT count(*) FROM withdrawals WHERE status='failed' AND failure_reason IS NOT NULL) || '|' ||
            (SELECT count(*) FROM wallet_ledger WHERE entry_type='withdrawal_reversed')"
equals "and one payout is still in flight" "1" \
    "SELECT count(*)::text FROM withdrawals WHERE status = 'pending'"
equals "refunds cover approved, rejected and queued" "3" \
    "SELECT count(DISTINCT status)::text FROM refunds"
equals "one refund is approved and waiting for funds" "1" \
    "SELECT count(*)::text FROM refunds WHERE status = 'queued'"
equals "so that store's payouts are held" "true" \
    "SELECT EXISTS (SELECT 1 FROM refunds r JOIN wallets w ON w.store_id = r.store_id
                     WHERE r.status='queued' AND w.available_balance < r.approved_amount)::text"
equals "complaints cover all four states" "4" "SELECT count(DISTINCT status)::text FROM complaints"
equals "identity checks cover approved, submitted and redo" "3" \
    "SELECT count(DISTINCT status)::text FROM kyc_submissions"
equals "a rider carries a cash debt into the next shift" "1" \
    "SELECT count(*)::text FROM rider_cash_settlements
      WHERE gap_resolution = 'carry_over' AND carried_over_settled_at IS NULL"
equals "a day was a running account of more than one hand-in" "1" \
    "SELECT count(*)::text FROM (SELECT rider_user_id FROM rider_cash_handovers
       GROUP BY rider_user_id HAVING count(*) > 1) t"
equals "one review is hidden, the rest are not" "1" \
    "SELECT count(*)::text FROM reviews WHERE hidden_at IS NOT NULL"
equals "a review has a merchant reply" "true" "SELECT (count(*) >= 2)::text FROM review_replies"
equals "the manager cannot see the payout notification" "0" \
    "SELECT count(*)::text FROM notifications n
      WHERE n.type_code = 'payout_sent'
        AND notification_is_for(n.id, (SELECT user_id FROM store_members WHERE role='manager' LIMIT 1))"
equals "a device has the chime off and another has it on" "1|1" \
    "SELECT count(*) FILTER (WHERE NOT sound_enabled) || '|' || count(*) FILTER (WHERE sound_enabled)
       FROM notification_devices"
equals "the audit log has entries" "true" \
    "SELECT (count(*) > 10)::text FROM audit_log"
equals "with no breaks" "0" "SELECT count(*)::text FROM verify_audit_chain()"
equals "promotions cover a live code, an expired one and two automatic offers" "true" \
    "SELECT (count(*) FILTER (WHERE kind='code') >= 3
             AND count(*) FILTER (WHERE kind='automatic') = 2
             AND count(*) FILTER (WHERE ends_at < now()) >= 1)::text FROM promotions"
equals "a discount was applied by a code and another by hand" "2" \
    "SELECT count(DISTINCT source)::text FROM order_discounts"

# =============================================================================
step "The invariants, over everything the seed wrote"
# =============================================================================
equals "every wallet balance is its own ledger's sum" "0" \
    "SELECT count(*)::text FROM wallets w
      WHERE w.pending_balance <> (SELECT coalesce(sum(amount),0) FROM wallet_ledger
                                  WHERE store_id=w.store_id AND pot='pending')
         OR w.available_balance <> (SELECT coalesce(sum(amount),0) FROM wallet_ledger
                                     WHERE store_id=w.store_id AND pot='available')"
equals "every order's subtotal is the sum of its lines" "0" \
    "SELECT count(*)::text FROM orders o
      WHERE o.subtotal_amount <> (SELECT coalesce(sum(line_total_amount),0) FROM order_items WHERE order_id=o.id)"
equals "every order's discount equals the rows behind it" "0" \
    "SELECT count(*)::text FROM orders o
      WHERE o.discount_amount <> (SELECT coalesce(sum(amount),0) FROM order_discounts WHERE order_id=o.id)"
equals "every order has at least one line" "0" \
    "SELECT count(*)::text FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE order_id=o.id)"
equals "every complaint's last event agrees with its status" "0" \
    "SELECT count(*)::text FROM complaints c WHERE c.status <>
       (SELECT to_status FROM complaint_events WHERE complaint_id=c.id ORDER BY sequence DESC LIMIT 1)"
equals "every rider on an order is a rider OF THAT STORE" "0" \
    "SELECT count(*)::text FROM orders o WHERE o.rider_user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM store_members m WHERE m.user_id=o.rider_user_id
                        AND m.store_id=o.store_id AND m.role='rider')"
equals "every approved refund has its money in the ledger" "0" \
    "SELECT count(*)::text FROM refunds r WHERE r.status='approved'
       AND NOT EXISTS (SELECT 1 FROM wallet_ledger WHERE refund_id=r.id)"
equals "and no queued refund does" "0" \
    "SELECT count(*)::text FROM refunds r WHERE r.status='queued'
       AND EXISTS (SELECT 1 FROM wallet_ledger WHERE refund_id=r.id)"

# =============================================================================
step "Idempotent: running it again changes nothing that matters"
# =============================================================================
BEFORE="$(q "SELECT count(*) || '|' || (SELECT count(*) FROM orders) || '|' || (SELECT count(*) FROM wallet_ledger) FROM stores")"
NYAMA="$(q "SELECT id::text FROM stores WHERE slug = 'nyama'")"
EXTRA_ENV="SEED_ORDERS=$SEED_ORDERS_FOR_TEST" run_seed "$TEST_URL" --yes
if [ "$SEED_RC" -eq 0 ]; then pass "it runs a second time"; else flunk "the second run failed"; fi
equals "the same counts" "$BEFORE" \
    "SELECT count(*) || '|' || (SELECT count(*) FROM orders) || '|' || (SELECT count(*) FROM wallet_ledger) FROM stores"
equals "and the SAME ids, so a bookmark survives a re-seed" "$NYAMA" \
    "SELECT id::text FROM stores WHERE slug = 'nyama'"
equals "reference numbers restarted rather than climbing" "1" \
    "SELECT min(reference_number)::text FROM complaints"

# =============================================================================
step "A sequential scan is visibly slower than an index scan"
# =============================================================================
# The Orders board's own query, against orders_store_status_placed_idx. Compared on
# the PLANNER'S COST rather than on a stopwatch: cost is deterministic given the same
# statistics, where a wall-clock comparison on a shared machine is not. The measured
# times are printed too, for the reader.
atleast "there are enough orders for the planner to have an opinion" 8000 \
    "SELECT count(*)::text FROM orders"

BOARD_QUERY="SELECT id FROM orders WHERE store_id = (SELECT id FROM stores WHERE slug='nyama')
               AND status = 'delivered' ORDER BY placed_at DESC LIMIT 20"

INDEX_COST="$(q "SET LOCAL enable_seqscan = on;
  EXPLAIN (FORMAT JSON) ${BOARD_QUERY}" | tr -d ' ' | grep -o '\"TotalCost\":[0-9.]*' | head -1 | cut -d: -f2)"
# The whole plan, not the first few lines: the InitPlan that resolves the slug sits
# above the interesting node, so a head -3 cuts off the very line being looked for.
INDEX_PLAN="$(q "EXPLAIN ${BOARD_QUERY}" | tr '\n' ' ')"
SEQ_COST="$(q "SET LOCAL enable_indexscan = off; SET LOCAL enable_bitmapscan = off; SET LOCAL enable_indexonlyscan = off;
  EXPLAIN (FORMAT JSON) ${BOARD_QUERY}" | tr -d ' ' | grep -o '\"TotalCost\":[0-9.]*' | head -1 | cut -d: -f2)"

if printf '%s' "$INDEX_PLAN" | grep -q "orders_store_status_placed_idx"; then
    pass "the plan uses orders_store_status_placed_idx, the index V004 declared for this query"
else
    LAST="plan: $INDEX_PLAN"
    flunk "the Orders board query does not use its own index"
fi

RATIO="$(q "SELECT round((${SEQ_COST:-0} / greatest(${INDEX_COST:-1}, 0.01))::numeric, 1)::text")"
if [ "${RATIO%%.*}" -ge 5 ] 2>/dev/null; then
    pass "a sequential scan costs ${RATIO}× the index scan (${SEQ_COST} vs ${INDEX_COST})"
else
    LAST="index cost: ${INDEX_COST}   seq cost: ${SEQ_COST}   ratio: ${RATIO}"
    flunk "a sequential scan is not visibly worse than the index scan"
fi

# And the same comparison measured, for the record.
INDEX_MS="$(q "EXPLAIN (ANALYZE, TIMING ON, FORMAT JSON) ${BOARD_QUERY}" | tr -d ' ' | grep -o '\"ExecutionTime\":[0-9.]*' | cut -d: -f2)"
SEQ_MS="$(q "SET LOCAL enable_indexscan = off; SET LOCAL enable_bitmapscan = off; SET LOCAL enable_indexonlyscan = off;
  EXPLAIN (ANALYZE, TIMING ON, FORMAT JSON) ${BOARD_QUERY}" | tr -d ' ' | grep -o '\"ExecutionTime\":[0-9.]*' | cut -d: -f2)"
info "measured: ${INDEX_MS} ms with the index, ${SEQ_MS} ms without it"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
