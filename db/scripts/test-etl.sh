#!/usr/bin/env bash
#
# Acceptance tests for the one-off data migration — milestone 29 (plan §5.5).
#
# The plan's bar: "the report is clean TWICE IN A ROW on separate restores; ledger sums equal wallet balances in both
# databases". This suite proves that on a synthetic copy of the old database, and then proves the other half of
# "reconciled, not assumed": that when the old data is wrong in a way the migration has no rule for, it STOPS or the
# report says FAIL — it never produces a clean-looking result from data it could not account for.
#
# Everything is built from scratch (db/etl/legacy/): no real data, no production access.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETL="$SELF_DIR/../etl/run.ts"
TEMPLATE="vendlyfy_etl_template"
OLD_A="vendlyfy_etl_test_old_a"; NEW_A="vendlyfy_etl_test_new_a"
OLD_B="vendlyfy_etl_test_old_b"; NEW_B="vendlyfy_etl_test_new_b"
SCRATCH="$(mktemp -d)"
PASSED=0; FAILED=0; LAST=""

url() { printf 'postgresql://%s:%s@%s:%s/%s' "$OWNER_ROLE" "$OWNER_PASSWORD" "$HOST_ADDR" "$HOST_PORT" "$1"; }
drop() { psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q -c "DROP DATABASE IF EXISTS $1 WITH (FORCE)" >/dev/null 2>&1 || true; }
cleanup() { rm -rf "$SCRATCH"; for d in "$TEMPLATE" "$OLD_A" "$NEW_A" "$OLD_B" "$NEW_B"; do drop "$d"; done; }
trap cleanup EXIT
require_docker
[ "$(container_state)" = "running" ] || die "the database is not running. Run: npm run db:up"

pass()  { PASSED=$((PASSED + 1)); printf '  [pass] %s\n' "$1"; }
flunk() { FAILED=$((FAILED + 1)); printf '  [FAIL] %s\n' "$1" >&2; printf '%s\n' "$LAST" | sed 's/^/         | /' >&2; }
q()     { psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$1" -tAc "$2" 2>/dev/null || echo '?'; }
equals(){ local got; got="$(q "$2" "$4")"; if [ "$got" = "$3" ]; then pass "$1"; else LAST="query: $4"$'\n'"got:   $got"$'\n'"want:  $3"; flunk "$1"; fi; }
sql()   { LAST="$(psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$1" -q -c "$2" 2>&1 || true)"; }
fresh_new() { drop "$1"; psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q -c "CREATE DATABASE $1 TEMPLATE $TEMPLATE" >/dev/null; }
run_etl() {   # run_etl <old> <new> -> sets RC, OUT
    set +e
    OUT="$(SOURCE_DATABASE_URL="$(url "$1")" TARGET_DATABASE_URL="$(url "$2")" node "$ETL" --out "$SCRATCH/report.md" 2>&1)"
    RC=$?
    set -e
}
fingerprint() {   # a hash of every row of every old table, to prove the source is untouched
    q "$1" "SELECT md5(string_agg(t, '|' ORDER BY t)) FROM (
              SELECT 'o:' || row(o.*)::text AS t FROM orders o UNION ALL SELECT 'u:' || row(u.*)::text FROM users u
              UNION ALL SELECT 'w:' || row(w.*)::text FROM wallets w UNION ALL SELECT 'l:' || row(l.*)::text FROM wallet_ledger l
              UNION ALL SELECT 'm:' || row(m.*)::text FROM menu_items m UNION ALL SELECT 'a:' || row(a.*)::text FROM add_ons a
              UNION ALL SELECT 't:' || row(t.*)::text FROM tenants t UNION ALL SELECT 'x:' || row(x.*)::text FROM withdrawal_requests x) s"
}

printf '\nData migration acceptance tests\n'
step "Building the new schema once, as a template"
drop "$TEMPLATE"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q -c "CREATE DATABASE $TEMPLATE" >/dev/null
if DATABASE_URL="$(url "$TEMPLATE")" bash "$SELF_DIR/migrate.sh" >/dev/null 2>&1; then pass "the migrations apply to an empty database"; else flunk "the migrations apply to an empty database"; fi

# ---------------------------------------------------------------------------------------------------------------------
step "The plan's bar: clean twice in a row, on separate restores"
bash "$SELF_DIR/../etl/legacy/build-legacy.sh" "$OLD_A" >/dev/null && pass "the old database is rebuilt from supabase/*.sql and the synthetic rows" || flunk "the old database is rebuilt"
bash "$SELF_DIR/../etl/legacy/build-legacy.sh" "$OLD_B" >/dev/null || true
BEFORE="$(fingerprint "$OLD_A")"

fresh_new "$NEW_A"; run_etl "$OLD_A" "$NEW_A"
if [ "$RC" = "0" ]; then pass "restore 1: the migration runs and the reconciliation report is CLEAN"; else LAST="$OUT"; flunk "restore 1: the migration runs and the report is clean"; fi
cp "$SCRATCH/report.md" "$SCRATCH/report1.md" 2>/dev/null || true
fresh_new "$NEW_B"; run_etl "$OLD_B" "$NEW_B"
if [ "$RC" = "0" ]; then pass "restore 2 (a separate copy, a separate target): CLEAN again"; else LAST="$OUT"; flunk "restore 2: clean again"; fi

grep -v "^Run:\|^Source:\|^Target:" "$SCRATCH/report1.md" | sed 's/trk_[0-9a-f]*//g' > "$SCRATCH/r1.txt" 2>/dev/null || true
grep -v "^Run:\|^Source:\|^Target:" "$SCRATCH/report.md"  | sed 's/trk_[0-9a-f]*//g' > "$SCRATCH/r2.txt" 2>/dev/null || true
if diff -q "$SCRATCH/r1.txt" "$SCRATCH/r2.txt" >/dev/null; then pass "the two reports are identical line for line: the migration is repeatable"; else LAST="$(diff "$SCRATCH/r1.txt" "$SCRATCH/r2.txt" | head -10)"; flunk "the two reports are identical"; fi

[ "$(fingerprint "$OLD_A")" = "$BEFORE" ] && pass "the source database is byte-for-byte what it was: nothing was written to it" || flunk "the source database is untouched"

run_etl "$OLD_A" "$NEW_A"
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -q "already holds"; then pass "a second run into the same target is refused rather than doubling its data"; else LAST="$OUT"; flunk "a second run into a used target is refused"; fi

# ---------------------------------------------------------------------------------------------------------------------
step "What came across"
equals "every tenant is a store, in RWF, on a published template" "$NEW_A" "3|3" "SELECT count(*) || '|' || count(*) FILTER (WHERE selling_currency = 'RWF' AND industry_template_id IS NOT NULL) FROM stores"
equals "staff are one identity per email, customers stay per store" "$NEW_A" "8|5" "SELECT count(*) FILTER (WHERE scope = 'platform') || '|' || count(*) FILTER (WHERE scope = 'store') FROM users"
equals "every store is open all day, as the old system behaved, until its merchant sets hours" "$NEW_A" "21" "SELECT count(*) FROM store_hours WHERE opens_at = '00:00' AND closes_at = '23:59'"
equals "the first admin of each store is its owner" "$NEW_A" "2" "SELECT count(*) FROM store_members WHERE role = 'owner'"
equals "the old super admin is a platform member" "$NEW_A" "1" "SELECT count(*) FROM platform_members WHERE role = 'super_admin'"
equals "a rider with no plate is stored with a stated placeholder, not an invented one" "$NEW_A" "1" "SELECT count(*) FROM rider_profiles WHERE plate_number = 'NOT RECORDED'"
equals "order totals are preserved to the cent: the new Σ equals the old Σ" "$NEW_A" "106000.00" "SELECT sum(total_amount) FROM orders"
equals "a total the old system computed differently becomes a derived delivery fee" "$NEW_A" "1000.00" "SELECT delivery_fee_amount FROM orders WHERE id = '0d000000-0000-4000-8000-000000000020'"
equals "...or a manual discount, with its row" "$NEW_A" "500.00|500.00" "SELECT o.discount_amount || '|' || (SELECT sum(amount) FROM order_discounts d WHERE d.order_id = o.id) FROM orders o WHERE o.id = '0d000000-0000-4000-8000-000000000019'"
equals "three burgers with one cheese become a row of one with cheese and a row of two without" "$NEW_A" "2|1|2" "SELECT count(*) || '|' || min(quantity) || '|' || max(quantity) FROM order_items WHERE order_id = '0d000000-0000-4000-8000-000000000011'"
equals "the units sold are the same: 32 before, 32 after" "$NEW_A" "32" "SELECT sum(quantity) FROM order_items"
equals "a size becomes a variant matrix: a burger has Regular and Large, with their own stock" "$NEW_A" "2|15,20" "SELECT count(*) || '|' || string_agg(stock_quantity::text, ',' ORDER BY stock_quantity) FROM product_variants WHERE product_id = 'd0000000-0000-4000-8000-000000000009'"
equals "a product linked to only some of a shared group gets its own copy, not the whole group" "$NEW_A" "1" "SELECT count(*) FROM option_groups WHERE product_id = 'd0000000-0000-4000-8000-000000000012'"
equals "two SKUs that differ only in case/spaces: the second is dropped, not the product" "$NEW_A" "1|2" "SELECT count(*) FILTER (WHERE sku IS NOT NULL) || '|' || count(*) FROM product_variants WHERE product_id IN ('d0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002')"
equals "orders carry one history event" "$NEW_A" "29" "SELECT count(*) FROM order_events WHERE reason LIKE 'Migrated%'"
equals "the old short tracking code is kept beside the new one" "$NEW_A" "29" "SELECT count(*) FROM legacy_rows WHERE source_table = 'orders' AND row ? 'tracking_code' AND row ? 'new_tracking_code'"
equals "new tracking codes are long and unguessable" "$NEW_A" "0" "SELECT count(*) FROM orders WHERE tracking_code NOT LIKE 'trk\_%' OR length(tracking_code) < 30"
equals "the order counter continues after the migrated numbers" "$NEW_A" "21" "SELECT next_order_number FROM store_order_counters WHERE store_id = 'aaaaaaaa-0000-4000-8000-000000000001'"

step "The money"
equals "the wallet opens at the OLD WALLET balance, 6800, in the available pot" "$NEW_A" "6800.00|0.00" "SELECT available_balance || '|' || pending_balance FROM wallets WHERE store_id = 'aaaaaaaa-0000-4000-8000-000000000001'"
equals "the new ledger is one opening entry, not a replay of fifteen old ones" "$NEW_A" "1|adjustment" "SELECT count(*) || '|' || min(entry_type) FROM wallet_ledger"
equals "all fifteen old ledger rows are kept as history" "$NEW_A" "15" "SELECT count(*) FROM legacy_rows WHERE source_table = 'wallet_ledger'"
equals "the wallet relabelled EUR→RWF with no conversion" "$NEW_A" "RWF" "SELECT currency FROM wallets WHERE store_id = 'aaaaaaaa-0000-4000-8000-000000000001'"
equals "payouts keep status and amount: 3 completed 20900, 1 failed 3000" "$NEW_A" "3|20900.00|1|3000.00" "SELECT count(*) FILTER (WHERE status='completed') || '|' || sum(amount) FILTER (WHERE status='completed') || '|' || count(*) FILTER (WHERE status='failed') || '|' || sum(amount) FILTER (WHERE status='failed') FROM withdrawals"
equals "a refund on an UNPAID order is archived, not carried (the old bug of plan §5.1)" "$NEW_A" "1|0.00" "SELECT (SELECT count(*) FROM legacy_rows WHERE source_table = 'refund_requests') || '|' || COALESCE((SELECT refunded_amount FROM orders WHERE id = '0d000000-0000-4000-8000-000000000005'),0)"
equals "the paid refund is carried in full and settled" "$NEW_A" "1|200.00|approved" "SELECT count(*) || '|' || sum(approved_amount) || '|' || min(status) FROM refunds"
equals "refund payouts through mobile money are archived (the new schema ties disbursements to withdrawals)" "$NEW_A" "2" "SELECT count(*) FROM legacy_rows WHERE source_table = 'momo_transactions'"
equals "a review is kept when the customer bought the product, and imported onto that very line" "$NEW_A" "1" "SELECT count(*) FROM reviews r JOIN order_items i ON i.id = r.order_item_id AND i.order_id = r.order_id"
equals "complaints keep their state; the escalation/resolution text is archived, not lost" "$NEW_A" "3" "SELECT count(*) FROM complaints"
equals "orphaned tables with rows are archived (posts: 2)" "$NEW_A" "2" "SELECT count(*) FROM legacy_rows WHERE source_table = 'posts'"
equals "the platform's hold time is carried across (90 minutes)" "$NEW_A" "90" "SELECT value::text FROM platform_settings WHERE key = 'hold_minutes'"
equals "the new database's own invariants hold afterwards: every wallet equals its ledger" "$NEW_A" "0" "SELECT count(*) FROM wallets w WHERE w.available_balance <> COALESCE((SELECT sum(amount) FROM wallet_ledger l WHERE l.store_id = w.store_id AND l.pot='available'),0) OR w.pending_balance <> COALESCE((SELECT sum(amount) FROM wallet_ledger l WHERE l.store_id = w.store_id AND l.pot='pending'),0)"

# ---------------------------------------------------------------------------------------------------------------------
step "Wrong in a way the migration has no rule for: it stops, or the report says FAIL"
# 1. a payment method the new system does not have
bash "$SELF_DIR/../etl/legacy/build-legacy.sh" "$OLD_A" >/dev/null
sql "$OLD_A" "ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check; UPDATE orders SET payment_method = 'bank_transfer' WHERE id = '0d000000-0000-4000-8000-000000000019'"
fresh_new "$NEW_A"; run_etl "$OLD_A" "$NEW_A"
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -q "bank_transfer"; then pass "an order paid by a method with no equivalent stops the run and names it"; else LAST="$OUT"; flunk "an unknown payment method stops the run"; fi
equals "...and the target is untouched, because the whole migration is one transaction" "$NEW_A" "0|0" "SELECT (SELECT count(*) FROM stores) || '|' || (SELECT count(*) FROM legacy_rows)"

# 2. a wallet that cannot be explained: one-sided drift
bash "$SELF_DIR/../etl/legacy/build-legacy.sh" "$OLD_A" >/dev/null
sql "$OLD_A" "UPDATE wallets SET available_balance = available_balance + 50"
fresh_new "$NEW_A"; run_etl "$OLD_A" "$NEW_A"
if [ "$RC" = "1" ] && printf '%s' "$OUT" | grep -q "FAIL"; then pass "money that appears from nowhere (a one-sided wallet drift) is a FAIL, not an 'explained' finding"; else LAST="$OUT"; flunk "a one-sided drift fails the report"; fi

# 3. a negative wallet
bash "$SELF_DIR/../etl/legacy/build-legacy.sh" "$OLD_A" >/dev/null
sql "$OLD_A" "ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_available_balance_check; UPDATE wallets SET available_balance = -5"
fresh_new "$NEW_A"; run_etl "$OLD_A" "$NEW_A"
if [ "$RC" = "2" ] && printf '%s' "$OUT" | grep -q "negative"; then pass "a negative wallet balance stops the run: the new ledger would refuse it"; else LAST="$OUT"; flunk "a negative wallet stops the run"; fi

# 4. the same staff email at two stores with different passwords
bash "$SELF_DIR/../etl/legacy/build-legacy.sh" "$OLD_A" >/dev/null
sql "$OLD_A" "UPDATE users SET email = 'cust5-b@inzu.test' WHERE id = 'b0000000-0000-4000-8000-000000000005'; UPDATE users SET email = 'owner-a@nyama.test' WHERE id = 'b0000000-0000-4000-8000-000000000001'"
fresh_new "$NEW_A"; run_etl "$OLD_A" "$NEW_A"
equals "one person, two stores: merged into one identity with two memberships" "$NEW_A" "1|2" "SELECT count(DISTINCT user_id) || '|' || count(*) FROM store_members WHERE user_id = 'a0000000-0000-4000-8000-000000000001'"
if grep -q "password-conflict" "$SCRATCH/report.md" 2>/dev/null; then pass "...and the differing passwords are listed as a decision, the earliest account's winning"; else flunk "a password conflict is listed"; fi

# 5. the migration relies on the SERVER refusing a write inside its source transaction; prove that is true of Postgres.
LAST="$(psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$OLD_A" -q -c "BEGIN READ ONLY; CREATE TEMP TABLE x (i int);" 2>&1 || true)"
if printf '%s' "$LAST" | grep -qi "read-only"; then pass "...as a READ ONLY transaction refuses a write — the canary the migration relies on"; else flunk "a READ ONLY transaction refuses a write"; fi

echo
printf '%s passed, %s failed.\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
