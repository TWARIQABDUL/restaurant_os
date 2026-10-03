#!/usr/bin/env bash
#
# The rider's own app and CashReport's database functions — milestone 21, V023_rider_console.sql.
#
# TESTED AGAINST A FRESH FIXTURE, DELIBERATELY. `rider_cash_settlements_day_is_over` (V007) refuses to
# close a day while the rider holds ANY open cash order, store-wide — a real property found while
# building this suite: the dev seed's volume generator leaves most riders carrying dozens of open cash
# orders at any moment, which made an early hand-written smoke test against it fail for the right
# reason and the wrong fixture. A throwaway store with exactly the orders each test needs is what lets
# "closes cleanly" and "refuses while cash orders are still out" both be demonstrated on purpose.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_riders_console_test"
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

STORE="aaaaaaaa-3000-4000-8000-000000000001"
OWNER="bbbbbbbb-3000-4000-8000-000000000001"
RIDER_A="bbbbbbbb-3000-4000-8000-000000000002"
RIDER_B="bbbbbbbb-3000-4000-8000-000000000003"
RIDER_C="bbbbbbbb-3000-4000-8000-000000000004"
PRODUCT="cccccccc-3000-4000-8000-000000000001"
VARIANT="cccccccc-3000-4000-8000-000000000002"

printf '\nRiders & cash acceptance tests\n'
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

step "Two gaps V023 closes before any fixture needs them"
refuses "a store cannot take the slug 'rider' — Auth's own destination for one would be shadowed" "stores_slug_not_reserved" \
    "INSERT INTO stores (id, slug, name, country, selling_currency, status) VALUES (gen_random_uuid(), 'rider', 'x', 'RW', 'RWF', 'active')"
accepts "a store may now carry its own physical address, for a rider to collect from" \
    "INSERT INTO stores (id, slug, name, country, selling_currency, status, address)
          VALUES ('$STORE', 'riders-test', 'Riders Test', 'RW', 'RWF', 'active', 'KG 7 Ave, Kimihurura')"

step "The fixture: two riders, one manager, ten of stock"
accepts "the owner" \
    "INSERT INTO users (id, scope, email, name, password_hash) VALUES ('$OWNER', 'platform', 'owner@riders-test.example', 'Owner', 'x');
     INSERT INTO store_members (user_id, store_id, role) VALUES ('$OWNER', '$STORE', 'owner')"
accepts "three riders — the third is for the one test that needs a rider with no settlement yet today" \
    "INSERT INTO users (id, scope, email, name, password_hash) VALUES
          ('$RIDER_A', 'platform', 'eric@riders-test.example', 'Eric Mugisha', 'x'),
          ('$RIDER_B', 'platform', 'claude@riders-test.example', 'Claude Habineza', 'x'),
          ('$RIDER_C', 'platform', 'olivier@riders-test.example', 'Olivier Nzeyimana', 'x');
     INSERT INTO store_members (user_id, store_id, role) VALUES
          ('$RIDER_A', '$STORE', 'rider'), ('$RIDER_B', '$STORE', 'rider'), ('$RIDER_C', '$STORE', 'rider');
     INSERT INTO rider_profiles (user_id, store_id, plate_number, availability) VALUES
          ('$RIDER_A', '$STORE', 'RAD 111 A', 'off_duty'), ('$RIDER_B', '$STORE', 'RAE 222 B', 'off_duty'),
          ('$RIDER_C', '$STORE', 'RAB 333 C', 'off_duty')"
accepts "ten of stock on one variant" \
    "INSERT INTO products (id, store_id, name, base_price, track_stock, status, position)
          VALUES ('$PRODUCT', '$STORE', 'Grilled Chicken', 8000, true, 'active', 1);
     INSERT INTO product_variants (id, product_id, store_id, stock_quantity, is_available, is_default, position)
          VALUES ('$VARIANT', '$PRODUCT', '$STORE', 10, true, true, 1)"

neworder() {
    local id="$1" number="$2" status="$3" method="$4" pay_status="$5" rider="$6" paid_at_val
    if [ "$pay_status" = "paid" ]; then paid_at_val="now()"; else paid_at_val="NULL"; fi
    sql "INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key,
                            guest_name, guest_phone, delivery_address, fulfilment_type, status,
                            payment_method, payment_status, paid_at, currency, subtotal_amount, rider_user_id)
              VALUES ('$id', '$STORE', $number, replace('$id', '-', ''), replace('$id', '-', '') || '-key',
                      'A Customer', '0780000000', 'KG 1', 'delivery', '$status',
                      '$method', '$pay_status', $paid_at_val, 'RWF', 8000, '$rider');
         INSERT INTO order_items (order_id, store_id, variant_id, product_name, unit_price_amount, quantity)
              VALUES ('$id', '$STORE', '$VARIANT', 'Grilled Chicken', 8000, 1)"
}

step "Available / off duty — the rider's own switch"
equals "starts off duty" "off_duty" "SELECT availability FROM rider_profiles WHERE user_id = '$RIDER_A'"
equals "set_rider_availability(true) works" "t" "SELECT set_rider_availability('$RIDER_A', '$STORE', true)"
equals "and the clock moved" "t" "SELECT availability_changed_at > now() - interval '5 seconds' FROM rider_profiles WHERE user_id = '$RIDER_A'"
equals "a user with no profile here answers false, not an error" "f" "SELECT set_rider_availability('$OWNER', '$STORE', true)"

step "Couldn't deliver — the transition V022 deferred to this milestone"
neworder "dddddddd-3000-4000-8000-000000000001" 1001 out mtn_momo paid "$RIDER_A"
refuses "returning needs a reason" "a reason the store reads" \
    "SELECT mark_returned('dddddddd-3000-4000-8000-000000000001', '$STORE', '$RIDER_A', 'rider', '', NULL)"
equals "mark_returned works from out" "t" \
    "SELECT mark_returned('dddddddd-3000-4000-8000-000000000001', '$STORE', '$RIDER_A', 'rider', 'Customer not answering', NULL)"
equals "returned" "returned" "SELECT status FROM orders WHERE id = 'dddddddd-3000-4000-8000-000000000001'"
equals "a delivered order cannot be \"returned\"" "f" \
    "SELECT mark_returned('dddddddd-3000-4000-8000-000000000001', '$STORE', '$RIDER_A', 'rider', 'Something else', NULL)"
equals "it moves no money — the order was never confirmed paid in cash and this one was already paid online, untouched" "0.00" \
    "SELECT refunded_amount FROM orders WHERE id = 'dddddddd-3000-4000-8000-000000000001'"

step "Closing a rider's day: blocked while cash is still out"
neworder "dddddddd-3000-4000-8000-000000000002" 1002 out cash unpaid "$RIDER_A"
refuses "the day cannot close with an open cash order" "still with this rider" \
    "SELECT close_rider_day('$STORE', '$RIDER_A', '$OWNER', 0)"
accepts "deliver it and confirm the cash, short by 1,000" \
    "SELECT mark_delivered('dddddddd-3000-4000-8000-000000000002', '$STORE', '$RIDER_A', 'rider');
     SELECT confirm_cash_payment('dddddddd-3000-4000-8000-000000000002', 7000, '$OWNER')"

step "Closing the day: a shortfall needs a resolution, forced both ways"
# expected_amount is cash_due_amount — 8,000, what was OWED — not what confirm_cash_payment recorded as
# collected (7,000, already short at the door). Handing over the 7,000 actually collected is what makes
# THIS a 1,000 shortfall at the SETTLEMENT: the same 1,000 the customer never paid, now surfacing for
# the merchant to decide what happens to it, exactly as Orders.dc.html's own cash panel promises
# ("the gap goes on the rider's line in Riders & cash, to settle at end of day").
equals "no resolution given for a real shortfall is refused (as null, not an error)" "" \
    "SELECT close_rider_day('$STORE', '$RIDER_A', '$OWNER', 7000)"
equals "an unlisted resolution is the same refusal" "" \
    "SELECT close_rider_day('$STORE', '$RIDER_A', '$OWNER', 7000, 'blame_the_weather')"
SETTLEMENT_A="$(q "SELECT close_rider_day('$STORE', '$RIDER_A', '$OWNER', 7000, 'carry_over')")"
equals "carry_over works, for the 1,000 short" "1000.00|carry_over" \
    "SELECT gap_amount || '|' || gap_resolution FROM rider_cash_settlements WHERE id = '$SETTLEMENT_A'"
equals "closing the SAME day again finds it already closed" "" \
    "SELECT close_rider_day('$STORE', '$RIDER_A', '$OWNER', 7000, 'carry_over')"

step "Receiving a carried-over debt later"
equals "it is not received yet" "" "SELECT carried_over_settled_at FROM rider_cash_settlements WHERE id = '$SETTLEMENT_A'"
equals "receive_carried_over_cash works" "t" "SELECT receive_carried_over_cash('$SETTLEMENT_A', '$STORE', '$OWNER')"
equals "and again finds nothing outstanding" "f" "SELECT receive_carried_over_cash('$SETTLEMENT_A', '$STORE', '$OWNER')"
refuses "the figures on a closed day cannot be changed by any other route" "cannot be changed" \
    "UPDATE rider_cash_settlements SET counted_amount = 999 WHERE id = '$SETTLEMENT_A'"

step "Closing the day: a shortfall recorded as a discount, via record_manual_discount() (V013)"
neworder "dddddddd-3000-4000-8000-000000000003" 1003 out cash unpaid "$RIDER_B"
accepts "deliver it and confirm the cash, short by 2,000" \
    "SELECT mark_delivered('dddddddd-3000-4000-8000-000000000003', '$STORE', '$RIDER_B', 'rider');
     SELECT confirm_cash_payment('dddddddd-3000-4000-8000-000000000003', 6000, '$OWNER')"
# expected_amount is 8,000 (cash_due_amount — what was owed), and the rider hands over the 6,000 they
# actually collected: an 8,000 − 6,000 = 2,000 gap, the exact shortfall the customer caused at the door.
equals "discount without naming the order is refused" "" \
    "SELECT close_rider_day('$STORE', '$RIDER_B', '$OWNER', 6000, 'discount')"
refuses "discount against an order that was not this rider's delivery is refused" "was not this rider" \
    "SELECT close_rider_day('$STORE', '$RIDER_B', '$OWNER', 6000, 'discount', 'dddddddd-3000-4000-8000-000000000002', 'wrong order')"
SETTLEMENT_B="$(q "SELECT close_rider_day('$STORE', '$RIDER_B', '$OWNER', 6000, 'discount',
                                           'dddddddd-3000-4000-8000-000000000003', 'Paid less at the door')")"
equals "discount, against the right order, works" "2000.00|discount" \
    "SELECT gap_amount || '|' || gap_resolution FROM rider_cash_settlements WHERE id = '$SETTLEMENT_B'"
equals "the order itself now carries the discount" "2000.00|6000.00" \
    "SELECT discount_amount || '|' || total_amount FROM orders WHERE id = 'dddddddd-3000-4000-8000-000000000003'"
equals "a discounted settlement does not show up in the carried-over list's own index condition" "0" \
    "SELECT count(*) FROM rider_cash_settlements WHERE rider_user_id = '$RIDER_B' AND gap_resolution = 'carry_over'"

step "A hand-over, mid-shift, and a day that balances exactly needs no resolution at all"
# RIDER_C, not A or B — both of those already closed today, and one settlement per rider per day is
# exactly what rider_cash_settlements_one_per_day enforces, so this needs a rider who has not yet.
accepts "the third rider comes on duty" \
    "UPDATE rider_profiles SET availability = 'available' WHERE user_id = '$RIDER_C'"
neworder "dddddddd-3000-4000-8000-000000000004" 1004 out cash unpaid "$RIDER_C"
accepts "deliver and confirm cash in full" \
    "SELECT mark_delivered('dddddddd-3000-4000-8000-000000000004', '$STORE', '$RIDER_C', 'rider');
     SELECT confirm_cash_payment('dddddddd-3000-4000-8000-000000000004', 8000, '$OWNER')"
refuses "a hand-over of zero is not one" "is not one" "SELECT record_rider_handover('$STORE', '$RIDER_C', '$OWNER', 0, NULL)"
accepts "hand over the whole thing" "SELECT record_rider_handover('$STORE', '$RIDER_C', '$OWNER', 8000, 'all of it')"
equals "closing at exactly zero needs no resolution — the day balances" "t" \
    "SELECT close_rider_day('$STORE', '$RIDER_C', '$OWNER', 0) IS NOT NULL"
equals "and the settlement records no gap" "0.00|" \
    "SELECT gap_amount || '|' || COALESCE(gap_resolution, '') FROM rider_cash_settlements
      WHERE rider_user_id = '$RIDER_C' ORDER BY closed_at DESC LIMIT 1"
equals "closing it again, same day, finds nothing to close" "" \
    "SELECT close_rider_day('$STORE', '$RIDER_C', '$OWNER', 0)"

printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ]
