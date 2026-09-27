#!/usr/bin/env bash
#
# The merchant console's database functions — milestone 19, V021_merchant_shell.sql.
#
# THIS SUITE EXISTS BECAUSE OF A BUG IT WOULD HAVE CAUGHT. V018 shipped store_open_state() comparing the
# store's opening hours — local wall-clock times like '10:00' — against now() in UTC. In Kigali (UTC+2) that
# made 11:00 read as CLOSED and 23:00 read as OPEN: a shop shut when it was busiest and open when everyone
# had gone home. No database suite named store_open_state, so nothing failed. V021 fixed it by giving every
# store its own time zone, and the four assertions below are the ones that would have refused the original.
#
# THE OTHER HALF IS THE DAY BOUNDARY. Every figure on the dashboard is a question about "today", and "today"
# is a question about whose midnight. store_dashboard() derives the boundary once, in the store's own zone,
# and hands it to all six counts — so this suite fixes the clock and asserts what lands on each side of it.
#
# place_order() IS NOT TESTED HERE: it needs a cart, a product and a variant, and the API suite already drives
# it end to end. The pause refusal V021 added to it is tested in server/test/api/console.test.ts, over HTTP,
# where a paused store has to turn into a sentence a customer reads.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_console_test"
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

STORE_RW="aaaaaaaa-0000-4000-8000-000000000001"
STORE_HI="aaaaaaaa-0000-4000-8000-000000000002"
ORDER_1="bbbbbbbb-0000-4000-8000-000000000001"
ORDER_2="bbbbbbbb-0000-4000-8000-000000000002"
ORDER_3="bbbbbbbb-0000-4000-8000-000000000003"
ORDER_4="bbbbbbbb-0000-4000-8000-000000000004"
ORDER_5="bbbbbbbb-0000-4000-8000-000000000005"
PRODUCT="dddddddd-0000-4000-8000-000000000001"
VARIANT="dddddddd-0000-4000-8000-000000000002"

printf '\nMerchant console acceptance tests\n'
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

step "A store's time zone comes from its country, and is not optional"
# V021 gives stores.time_zone NO DEFAULT, deliberately: a default of 'UTC' is what made the first attempt at
# this fix useless, because the seed runs after the migration and every store quietly took the default.
accepts "a store can be created without naming a time zone" \
    "INSERT INTO stores (id, slug, name, country, selling_currency, status)
          VALUES ('$STORE_RW', 'rw-store', 'Kigali Store', 'RW', 'RWF', 'active')"
equals "and the trigger filled it from the country" "Africa/Kigali" \
    "SELECT time_zone FROM stores WHERE id = '$STORE_RW'"

refuses "a zone Postgres has never heard of is refused at the write" "not a time zone" \
    "INSERT INTO stores (id, slug, name, country, selling_currency, status, time_zone)
          VALUES ('cccccccc-0000-4000-8000-00000000000c', 'bad-tz', 'Bad', 'RW', 'RWF', 'active', 'Mars/Olympus')"

# A STORE MAY OVERRIDE ITS COUNTRY'S ZONE, which matters for the countries that span several and for a merchant
# whose own answer differs. The country here is one the platform actually sells in — V001 has five, all in East
# Africa — and the zone is deliberately the far side of the world, because a difference of two hours would pass a
# test that a difference of one day's worth of arithmetic would fail.
accepts "and a store may name its own zone rather than taking the country's" \
    "INSERT INTO stores (id, slug, name, country, selling_currency, status, time_zone)
          VALUES ('$STORE_HI', 'hi-store', 'A Store Far Away', 'RW', 'RWF', 'active', 'Pacific/Honolulu')"
equals "and the trigger left the store's own choice alone" "Pacific/Honolulu" \
    "SELECT time_zone FROM stores WHERE id = '$STORE_HI'"

equals "store_local() converts an instant into the shop's wall clock" "2026-09-27 11:00:00" \
    "SELECT to_char(store_local('$STORE_RW', '2026-09-27 09:00:00+00'::timestamptz), 'YYYY-MM-DD HH24:MI:SS')"

step "Opening hours are compared in the store's own time — the bug V018 shipped"
accepts "the shop opens 10:00 and closes 22:00, every day" \
    "INSERT INTO store_hours (store_id, day_of_week, opens_at, closes_at)
          SELECT '$STORE_RW', d, '10:00', '22:00' FROM generate_series(1, 7) d"

# Kigali is UTC+2 and never changes. Each instant below is written in UTC, and the local time it means is in
# the label — which is the whole point: the answer must follow the local time, not the UTC one.
equals "09:00 in Kigali (07:00Z) is closed" "f" \
    "SELECT is_open FROM store_open_state('$STORE_RW', '2026-09-27 07:00:00+00')"
equals "11:00 in Kigali (09:00Z) is OPEN — V018 said closed" "t" \
    "SELECT is_open FROM store_open_state('$STORE_RW', '2026-09-27 09:00:00+00')"
equals "21:30 in Kigali (19:30Z) is open" "t" \
    "SELECT is_open FROM store_open_state('$STORE_RW', '2026-09-27 19:30:00+00')"
equals "23:00 in Kigali (21:00Z) is CLOSED — V018 said open" "f" \
    "SELECT is_open FROM store_open_state('$STORE_RW', '2026-09-27 21:00:00+00')"
equals "and it reports the closing time the dashboard prints" "22:00:00" \
    "SELECT closes_at FROM store_open_state('$STORE_RW', '2026-09-27 09:00:00+00')"

# THE SAME INSTANT, TWO SHOPS, TWO ANSWERS. This is the assertion that cannot pass without a per-store zone:
# 09:00Z is 11:00 in Kigali and 23:00 the previous evening in Honolulu.
accepts "the Honolulu shop keeps the same hours" \
    "INSERT INTO store_hours (store_id, day_of_week, opens_at, closes_at)
          SELECT '$STORE_HI', d, '10:00', '22:00' FROM generate_series(1, 7) d"
equals "one instant is trading hours in Kigali and the middle of the night in Honolulu" "true|false" \
    "SELECT (SELECT is_open FROM store_open_state('$STORE_RW', '2026-09-27 09:00:00+00')) || '|' ||
            (SELECT is_open FROM store_open_state('$STORE_HI', '2026-09-27 09:00:00+00'))"

step "Pausing new orders is a switch of its own, not the platform's suspension"
equals "a new store is taking orders" "t" \
    "SELECT accepting_orders FROM stores WHERE id = '$STORE_RW'"
accepts "and it can be paused without touching stores.status" \
    "UPDATE stores SET accepting_orders = false WHERE id = '$STORE_RW'"
equals "the shop is still active — a pause is the merchant's, a suspension is Vendlyfy's" "active|false" \
    "SELECT status || '|' || accepting_orders FROM stores WHERE id = '$STORE_RW'"
accepts "and it goes back" "UPDATE stores SET accepting_orders = true WHERE id = '$STORE_RW'"

step "store_dashboard() counts one day, on the store's own boundary"
# Four orders around midnight in Kigali: 21:59Z is 23:59 local TODAY, and 22:01Z is 00:01 local TOMORROW. An
# implementation using UTC days would put both on the same side.
# An order line names the variant that was sold — V003 makes that NOT NULL, because a line that does not say
# which size was bought cannot be restocked or refunded. So the catalogue comes first. It is also what makes the
# "products" and "low stock" cards non-zero, and this one is tracked and below its threshold on purpose.
accepts "one tracked product, low on stock" \
    "INSERT INTO products (id, store_id, name, base_price, low_stock_threshold, track_stock, status, position)
          VALUES ('$PRODUCT', '$STORE_RW', 'Passion Juice', 1000, 5, true, 'active', 1);
     INSERT INTO product_variants (id, product_id, store_id, stock_quantity, is_available, is_default, position)
          VALUES ('$VARIANT', '$PRODUCT', '$STORE_RW', 4, true, true, 1)"
equals "so the dashboard has a product to count, and a variant to warn about" "1|0|1" \
    "SELECT products_active || '|' || products_draft || '|' || low_stock_variants FROM store_dashboard('$STORE_RW', '2026-09-27 12:00:00+00')"

# THE ORDERS AND THEIR LINES IN ONE STATEMENT, and this is the schema teaching the test what it is. V004
# requires an order to have at least one line and enforces it with a DEFERRABLE INITIALLY DEFERRED constraint
# trigger, so it fires at COMMIT — orders written by themselves are refused at their own commit, however
# correct they look. psql sends one -c string as a single implicit transaction, which is what makes the two
# INSERTs below one unit. Every fixture in this repo that got this wrong learnt it the same way.
accepts "four orders straddling the local midnight, each with a line" \
    "INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key, guest_name, guest_phone,
                         fulfilment_type, status, payment_method, currency, subtotal_amount, placed_at)
          VALUES ('$ORDER_1', '$STORE_RW', 1, 'trk_console_dash_0001', 'idem_console_order_0001', 'A', '078 000 0001', 'pickup', 'pending',
                  'cash', 'RWF', 1000, '2026-09-27 08:00:00+00'),
                 ('$ORDER_2', '$STORE_RW', 2, 'trk_console_dash_0002', 'idem_console_order_0002', 'B', '078 000 0002', 'pickup', 'pending',
                  'cash', 'RWF', 2000, '2026-09-27 21:59:00+00'),
                 ('$ORDER_3', '$STORE_RW', 3, 'trk_console_dash_0003', 'idem_console_order_0003', 'C', '078 000 0003', 'pickup', 'delivered',
                  'cash', 'RWF', 4000, '2026-09-27 12:00:00+00'),
                 ('$ORDER_4', '$STORE_RW', 4, 'trk_console_dash_0004', 'idem_console_order_0004', 'D', '078 000 0004', 'pickup', 'pending',
                  'cash', 'RWF', 8000, '2026-09-27 22:01:00+00');
     INSERT INTO order_items (order_id, store_id, variant_id, product_name, unit_price_amount, quantity)
          SELECT id, store_id, '$VARIANT', 'Passion Juice', subtotal_amount, 1 FROM orders WHERE store_id = '$STORE_RW'"

equals "three of the four are today in Kigali" "3" \
    "SELECT orders_today FROM store_dashboard('$STORE_RW', '2026-09-27 12:00:00+00')"
# NOT SCOPED TO TODAY, and the function says why: "a pending order from last night is the most urgent thing on
# the screen". Three of the four are pending, including the one that is already tomorrow locally.
equals "every pending order is waiting, whatever day it was placed" "3" \
    "SELECT orders_waiting FROM store_dashboard('$STORE_RW', '2026-09-27 12:00:00+00')"
equals "and the local date it counted is the store's own" "2026-09-27" \
    "SELECT local_date::text FROM store_dashboard('$STORE_RW', '2026-09-27 12:00:00+00')"
equals "the one past local midnight counts on the next day instead" "1" \
    "SELECT orders_today FROM store_dashboard('$STORE_RW', '2026-09-28 06:00:00+00')"

# WHAT "SALES TODAY" COUNTS, stated here because it is a decision rather than an arithmetic: every order placed
# today that has not been rejected or cancelled — including ones still being prepared. Two alternatives were
# available and both are worse. Counting only delivered orders makes the figure lurch downwards every morning and
# tells a merchant at 11:00 that they have sold nothing. Counting money actually received would be the wallet's
# balance, which V005 already reports and which a cash-on-delivery order does not add to until it arrives. The
# figure on the card is revenue booked today, and the comparison beside it uses the same definition on both sides.
equals "sales today is everything placed today that was not refused" "7000.00" \
    "SELECT sales_today::text FROM store_dashboard('$STORE_RW', '2026-09-27 12:00:00+00')"

accepts "a fifth order, declined" \
    "INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key, guest_name, guest_phone,
                         fulfilment_type, status, payment_method, currency, subtotal_amount, placed_at)
          VALUES ('$ORDER_5', '$STORE_RW', 5, 'trk_console_dash_0005', 'idem_console_order_0005', 'E', '078 000 0005', 'pickup', 'rejected',
                  'cash', 'RWF', 99000, '2026-09-27 13:00:00+00');
     INSERT INTO order_items (order_id, store_id, variant_id, product_name, unit_price_amount, quantity)
          VALUES ('$ORDER_5', '$STORE_RW', '$VARIANT', 'Passion Juice', 99000, 1)"
equals "a declined order is not a sale, and not an order today either" "7000.00|3" \
    "SELECT sales_today::text || '|' || orders_today FROM store_dashboard('$STORE_RW', '2026-09-27 12:00:00+00')"
equals "with nothing to compare against, last week is zero rather than missing" "0" \
    "SELECT sales_same_day_last_week::text FROM store_dashboard('$STORE_RW', '2026-09-27 12:00:00+00')"

step "store_sales_week() is always seven rows, Monday to Sunday"
equals "seven days, in order" "7" \
    "SELECT count(*)::text FROM store_sales_week('$STORE_RW', '2026-09-27 12:00:00+00')"
equals "Monday is 1 and Sunday is 7" "1|7" \
    "SELECT (SELECT min(day_of_week)::text FROM store_sales_week('$STORE_RW', '2026-09-27 12:00:00+00')) || '|' ||
            (SELECT max(day_of_week)::text FROM store_sales_week('$STORE_RW', '2026-09-27 12:00:00+00'))"
# 2026-09-27 is a Sunday, so the week's takings sit on day 7 and the other six are zero rather than absent —
# a chart with gaps in it is a chart that lies about a quiet Tuesday.
equals "a day with no sales is zero, not missing" "0" \
    "SELECT sales::text FROM store_sales_week('$STORE_RW', '2026-09-27 12:00:00+00') WHERE day_of_week = 3"
equals "and the day with takings carries them" "7000.00" \
    "SELECT sales::text FROM store_sales_week('$STORE_RW', '2026-09-27 12:00:00+00') WHERE day_of_week = 7"

printf '\n%s passed, %s failed.\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
