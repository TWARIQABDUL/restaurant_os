#!/usr/bin/env bash
#
# The Orders board's database functions — milestone 20, V022_orders_console.sql.
#
# THIS SUITE EXISTS BECAUSE OF A BUG IT WOULD HAVE CAUGHT, TWICE, WHILE WRITING IT. close_return()'s first draft
# subtracted only orders.refunded_amount (APPROVED refunds) from the total before deciding what to refund — and
# testing it against a seeded order that already carried an unrelated PENDING refund found refunds_total_check()
# refusing the insert, because pending + queued claims count too, not just paid ones. The two assertions under
# "closing a return that already has a live refund" are that exact case, kept so it cannot come back.
#
# WHY ORDERS ARE INSERTED DIRECTLY AT THE STATUS EACH TEST NEEDS, rather than walked through the machine like the
# seed does: `orders_status_transition` is a trigger on UPDATE OF status, not on INSERT — V004 lets a row be
# CREATED in any of the twelve, and only a later UPDATE is checked against the transitions table. That is what
# makes a direct insert a legitimate fixture here rather than a shortcut around the schema.
#
# STOCK AND MONEY ARE THE THING WORTH MEASURING, not just "did the status move" — accept()'s own suite
# (test-console.sh) already covers the shape of a locked transition; what V022 adds beyond that shape is stock
# release on decline/cancel and the two-sided money rule on a return, so those get the assertions here.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_orders_console_test"
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

STORE="aaaaaaaa-1000-4000-8000-000000000001"
OWNER="bbbbbbbb-1000-4000-8000-000000000001"
RIDER_A="bbbbbbbb-1000-4000-8000-000000000002"
RIDER_B="bbbbbbbb-1000-4000-8000-000000000003"
PRODUCT="cccccccc-1000-4000-8000-000000000001"
VARIANT="cccccccc-1000-4000-8000-000000000002"

# One order per test, each a fixed id so a later section can still refer to an earlier one's fixture without
# re-declaring it.
O_PENDING="dddddddd-1000-4000-8000-000000000001"
O_APPROVED="dddddddd-1000-4000-8000-000000000002"
O_PREPARING="dddddddd-1000-4000-8000-000000000003"
O_READY_DELIVERY="dddddddd-1000-4000-8000-000000000004"
O_READY_PICKUP_CASH="dddddddd-1000-4000-8000-000000000005"
O_ASSIGNED="dddddddd-1000-4000-8000-000000000006"
O_OUT="dddddddd-1000-4000-8000-000000000007"
O_RETURNED_MOMO="dddddddd-1000-4000-8000-000000000008"
O_RETURNED_CASH="dddddddd-1000-4000-8000-000000000009"
O_RETURNED_WITH_LIVE_REFUND="dddddddd-1000-4000-8000-00000000000a"
O_DELIVERED_PAID="dddddddd-1000-4000-8000-00000000000b"
O_CANCEL_TEST="dddddddd-1000-4000-8000-00000000000c"

printf '\nOrders board acceptance tests\n'
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

step "One new transition, and one new notification type"
equals "returned -> ready exists, for 'Try delivery again'" "1" \
    "SELECT count(*) FROM order_status_transitions WHERE from_status = 'returned' AND to_status = 'ready'"
equals "order_cancelled is seeded, store-staff only" "store_staff" \
    "SELECT audience FROM notification_types WHERE code = 'order_cancelled'"
equals "and it needs the same three keys order_declined does" "{order_number,actor_name,reason}" \
    "SELECT required_payload_keys::text FROM notification_types WHERE code = 'order_cancelled'"

step "The fixture: one store, one rider on duty, one off, ten variants of stock"
accepts "the store" \
    "INSERT INTO stores (id, slug, name, country, selling_currency, status)
          VALUES ('$STORE', 'orders-test', 'Orders Test', 'RW', 'RWF', 'active')"
accepts "its owner" \
    "INSERT INTO users (id, scope, email, name, password_hash) VALUES ('$OWNER', 'platform', 'owner@orders-test.example', 'Owner', 'x')"
accepts "the owner is a member" \
    "INSERT INTO store_members (user_id, store_id, role) VALUES ('$OWNER', '$STORE', 'owner')"
accepts "a rider on duty" \
    "INSERT INTO users (id, scope, email, name, password_hash) VALUES ('$RIDER_A', 'platform', 'eric@orders-test.example', 'Eric Mugisha', 'x');
     INSERT INTO store_members (user_id, store_id, role) VALUES ('$RIDER_A', '$STORE', 'rider');
     INSERT INTO rider_profiles (user_id, store_id, plate_number, availability) VALUES ('$RIDER_A', '$STORE', 'RAD 111 A', 'available')"
accepts "a manager, so the FK has someone to refuse" \
    "INSERT INTO users (id, scope, email, name, password_hash) VALUES ('$RIDER_B', 'platform', 'patrick@orders-test.example', 'Patrick Ishimwe', 'x');
     INSERT INTO store_members (user_id, store_id, role) VALUES ('$RIDER_B', '$STORE', 'manager')"
accepts "ten of stock on one variant" \
    "INSERT INTO products (id, store_id, name, base_price, track_stock, status, position)
          VALUES ('$PRODUCT', '$STORE', 'Grilled Chicken', 8000, true, 'active', 1);
     INSERT INTO product_variants (id, product_id, store_id, stock_quantity, is_available, is_default, position)
          VALUES ('$VARIANT', '$PRODUCT', '$STORE', 10, true, true, 1)"

# One helper, because every order below is the same shape apart from status, fulfilment, method and rider.
# tracking_code and idempotency_key are DERIVED FROM THE ORDER'S OWN ID (hyphens stripped) rather than a fixed
# string, because both are unique — globally for one, per store for the other — and every fixture order here
# shares one store; a fixed literal would collide on the second insert.
neworder() {
    local id="$1" number="$2" status="$3" fulfil="$4" method="$5" pay_status="$6" rider="$7" addr rider_val paid_at_val
    if [ "$fulfil" = "delivery" ]; then addr="'KG 1 Ave'"; else addr="NULL"; fi
    if [ -n "$rider" ]; then rider_val="'$rider'"; else rider_val="NULL"; fi
    # orders_paid_at_agrees: 'paid' without a paid_at is refused at the column, correctly — a fixture
    # skipping it would not be testing a real state.
    if [ "$pay_status" = "paid" ]; then paid_at_val="now()"; else paid_at_val="NULL"; fi
    sql "INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key,
                            guest_name, guest_phone, delivery_address, fulfilment_type, status,
                            payment_method, payment_status, paid_at, currency, subtotal_amount, rider_user_id)
              VALUES ('$id', '$STORE', $number, replace('$id', '-', ''), replace('$id', '-', '') || '-key',
                      'A Customer', '0780000000', $addr, '$fulfil', '$status',
                      '$method', '$pay_status', $paid_at_val, 'RWF', 8000, $rider_val);
         INSERT INTO order_items (order_id, store_id, variant_id, product_name, unit_price_amount, quantity)
              VALUES ('$id', '$STORE', '$VARIANT', 'Grilled Chicken', 8000, 1)"
}

# STOCK IS SET BY HAND, NOT RESERVED. These orders are inserted directly rather than placed through
# place_order() (see the header on why that is a legitimate fixture here), so nothing has actually decremented
# product_variants — a fixture that wants to prove release_stock() put ten back has to take one away first,
# the same way a real reservation would have.
take_one() { sql "UPDATE product_variants SET stock_quantity = stock_quantity - 1 WHERE id = '$VARIANT'"; }

step "Declining releases the stock place_order() reserved, and only pending can be declined"
neworder "$O_PENDING" 1001 pending delivery mtn_momo unpaid ""
if printf '%s' "$LAST" | grep -qi error; then flunk "pending fixture — $LAST"; else pass "a pending order"; fi
take_one
equals "stock is 9, as if place_order() had reserved this one" "9" "SELECT stock_quantity FROM product_variants WHERE id = '$VARIANT'"
equals "declining it works" "t" \
    "SELECT decline_order('$O_PENDING', '$STORE', '$OWNER', 'owner', 'An item is out of stock', NULL)"
equals "and the stock came back" "10" "SELECT stock_quantity FROM product_variants WHERE id = '$VARIANT'"
equals "the order reads rejected" "rejected" "SELECT status FROM orders WHERE id = '$O_PENDING'"
equals "declining it again finds nothing pending to decline" "f" \
    "SELECT decline_order('$O_PENDING', '$STORE', '$OWNER', 'owner', 'An item is out of stock', NULL)"
equals "one event, with the reason on it" "An item is out of stock" \
    "SELECT reason FROM order_events WHERE order_id = '$O_PENDING'"
refuses "declining needs a reason, not blank" "a reason the customer reads" \
    "SELECT decline_order('$O_APPROVED', '$STORE', '$OWNER', 'owner', '', NULL)"

step "Cancelling reaches approved/preparing/ready/assigned, and also releases stock"
neworder "$O_APPROVED" 1002 approved delivery mtn_momo unpaid ""
take_one
equals "stock is 9 again, for the newly-approved order" "9" "SELECT stock_quantity FROM product_variants WHERE id = '$VARIANT'"
equals "cancelling an approved order works" "t" \
    "SELECT cancel_order('$O_APPROVED', '$STORE', '$OWNER', 'owner', 'Customer asked to cancel', NULL)"
equals "stock released" "10" "SELECT stock_quantity FROM product_variants WHERE id = '$VARIANT'"

neworder "$O_CANCEL_TEST" 1010 collected pickup cash paid ""
equals "a COLLECTED order cannot be cancelled — it already happened" "f" \
    "SELECT cancel_order('$O_CANCEL_TEST', '$STORE', '$OWNER', 'owner', 'Something else', NULL)"

step "The kitchen's two steps"
neworder "$O_PREPARING" 1003 approved delivery mtn_momo unpaid ""
equals "start_preparing moves it on" "t" "SELECT start_preparing('$O_PREPARING', '$STORE', '$OWNER', 'owner')"
equals "mark_ready needs preparing, and finds it" "t" "SELECT mark_ready('$O_PREPARING', '$STORE', '$OWNER', 'owner')"
equals "now ready" "ready" "SELECT status FROM orders WHERE id = '$O_PREPARING'"
equals "mark_ready again finds nothing preparing" "f" "SELECT mark_ready('$O_PREPARING', '$STORE', '$OWNER', 'owner')"

step "The rider picker: assign, reassign, refuse a non-rider and a pickup order"
neworder "$O_READY_DELIVERY" 1004 ready delivery mtn_momo unpaid ""
equals "assigning a rider to a delivery order works" "t" \
    "SELECT assign_rider('$O_READY_DELIVERY', '$STORE', '$OWNER', 'owner', '$RIDER_A')"
equals "the order carries the rider" "$RIDER_A" "SELECT rider_user_id FROM orders WHERE id = '$O_READY_DELIVERY'"
equals "and the FK derived rider_member_role itself" "rider" "SELECT rider_member_role FROM orders WHERE id = '$O_READY_DELIVERY'"
refuses "assigning a MANAGER as a rider is refused — V007's own FK, not app code" "foreign key" \
    "SELECT assign_rider('$O_READY_DELIVERY', '$STORE', '$OWNER', 'owner', '$RIDER_B')"

neworder "$O_READY_PICKUP_CASH" 1005 ready pickup cash unpaid ""
equals "a pickup order refuses a rider" "f" \
    "SELECT assign_rider('$O_READY_PICKUP_CASH', '$STORE', '$OWNER', 'owner', '$RIDER_A')"

step "Picked up, delivered, and collected in person"
neworder "$O_ASSIGNED" 1006 assigned delivery mtn_momo unpaid "$RIDER_A"
equals "mark_picked_up moves assigned -> out" "t" "SELECT mark_picked_up('$O_ASSIGNED', '$STORE', '$OWNER', 'owner')"
equals "now out" "out" "SELECT status FROM orders WHERE id = '$O_ASSIGNED'"

neworder "$O_OUT" 1007 out delivery cash unpaid "$RIDER_A"
equals "mark_delivered moves out -> delivered" "t" "SELECT mark_delivered('$O_OUT', '$STORE', '$OWNER', 'owner')"
equals "a cash order is left UNPAID on delivery — confirming cash is a separate step" "unpaid" \
    "SELECT payment_status FROM orders WHERE id = '$O_OUT'"

equals "mark_collected confirms cash in the same call, for a cash pickup" "t" \
    "SELECT mark_collected('$O_READY_PICKUP_CASH', '$STORE', '$OWNER', 'owner')"
equals "collected, and paid, in one statement" "collected|paid" \
    "SELECT status || '|' || payment_status FROM orders WHERE id = '$O_READY_PICKUP_CASH'"

step "Closing a return: restocks if asked, and a MoMo order refunds automatically"
neworder "$O_RETURNED_MOMO" 1008 returned delivery mtn_momo paid "$RIDER_A"
accepts "released, as a delivered-then-returned order's escrow really would be by the time it comes back" \
    "UPDATE orders SET settlement_status = 'released' WHERE id = '$O_RETURNED_MOMO'"
take_one
equals "stock is 9 before the restock decision" "9" "SELECT stock_quantity FROM product_variants WHERE id = '$VARIANT'"
# wallets.available_balance is trigger-maintained (wallets_no_direct_balance_change) — the only way to fund it
# is a real ledger entry, the same primitive refund_settle() itself posts through.
accepts "give the store's wallet something to refund from, through the ledger, not a direct UPDATE" \
    "SELECT wallet_post('$STORE', 'available', 'adjustment', 50000, 'test-fund-available', 'platform')"
equals "close_return with restock=true works" "t" \
    "SELECT close_return('$O_RETURNED_MOMO', '$STORE', '$OWNER', 'owner', true)"
equals "closed" "closed_return" "SELECT status FROM orders WHERE id = '$O_RETURNED_MOMO'"
equals "restocked" "10" "SELECT stock_quantity FROM product_variants WHERE id = '$VARIANT'"
equals "refunded in full, automatically — no Vendlyfy review for a return" "8000.00|refunded" \
    "SELECT refunded_amount || '|' || payment_status FROM orders WHERE id = '$O_RETURNED_MOMO'"
equals "and the refund itself is already approved, not sitting pending" "approved" \
    "SELECT status FROM refunds WHERE order_id = '$O_RETURNED_MOMO'"

neworder "$O_RETURNED_CASH" 1009 returned delivery cash unpaid "$RIDER_A"
equals "a cash return moves no money — it was never paid" "t" \
    "SELECT close_return('$O_RETURNED_CASH', '$STORE', '$OWNER', 'owner', false)"
equals "still 0.00 refunded and still unpaid" "0.00|unpaid" \
    "SELECT refunded_amount || '|' || payment_status FROM orders WHERE id = '$O_RETURNED_CASH'"
equals "not restocked, because false was asked" "10" "SELECT stock_quantity FROM product_variants WHERE id = '$VARIANT'"

# THE BUG THIS SUITE WAS WRITTEN AROUND: a returned order that already carries a PENDING refund (from a
# complaint, say) must not let close_return() double-claim against refunds_total_check().
step "Closing a return that already has a live refund does not double-claim it"
neworder "$O_RETURNED_WITH_LIVE_REFUND" 1011 returned delivery mtn_momo paid "$RIDER_A"
accepts "released, so it would otherwise refund from available" \
    "UPDATE orders SET settlement_status = 'released' WHERE id = '$O_RETURNED_WITH_LIVE_REFUND'"
accepts "a pending refund for the FULL amount already exists on this order" \
    "INSERT INTO refunds (store_id, order_id, amount, reason_code, reason_note, requested_by, initiated_by)
          VALUES ('$STORE', '$O_RETURNED_WITH_LIVE_REFUND', 8000, 'other', 'A customer complaint, unrelated to the return', '$OWNER', 'merchant')"
equals "close_return still succeeds — the status moves either way" "t" \
    "SELECT close_return('$O_RETURNED_WITH_LIVE_REFUND', '$STORE', '$OWNER', 'owner', false)"
equals "but it did NOT insert a second refund" "1" \
    "SELECT count(*) FROM refunds WHERE order_id = '$O_RETURNED_WITH_LIVE_REFUND'"
equals "refunded_amount is still 0 — the pending one has not been decided yet" "0.00" \
    "SELECT refunded_amount FROM orders WHERE id = '$O_RETURNED_WITH_LIVE_REFUND'"

step "Trying delivery again, instead of closing it"
neworder "dddddddd-1000-4000-8000-00000000000d" 1012 returned delivery mtn_momo unpaid "$RIDER_A"
equals "retry_delivery puts it back in Ready" "t" \
    "SELECT retry_delivery('dddddddd-1000-4000-8000-00000000000d', '$STORE', '$OWNER', 'owner')"
equals "ready, and the rider cleared" "ready|" \
    "SELECT status || '|' || COALESCE(rider_user_id::text, '') FROM orders WHERE id = 'dddddddd-1000-4000-8000-00000000000d'"

step "A refund requested straight from an order, no complaint behind it"
neworder "$O_DELIVERED_PAID" 1013 delivered delivery mtn_momo paid ""
equals "no refund exists on it yet" "" \
    "SELECT status FROM refunds WHERE order_id = '$O_DELIVERED_PAID'"
REFUND_ID="$(q "SELECT request_refund('$O_DELIVERED_PAID', '$STORE', '$OWNER', 2000, 'quality_problem', NULL)")"
equals "it exists, pending" "pending" "SELECT status FROM refunds WHERE id = '$REFUND_ID'"
equals "for the amount asked, not the order total" "2000.00" "SELECT amount FROM refunds WHERE id = '$REFUND_ID'"
equals "asking a second time before the first is decided is refused" "" \
    "SELECT request_refund('$O_DELIVERED_PAID', '$STORE', '$OWNER', 1000, 'other', 'a second thing')"

neworder "dddddddd-1000-4000-8000-00000000000e" 1014 delivered delivery mtn_momo paid ""
equals "asking for more than a (fresh, unclaimed) order is worth is refused" "" \
    "SELECT request_refund('dddddddd-1000-4000-8000-00000000000e', '$STORE', '$OWNER', 999999, 'other', 'too much')"
equals "and nothing was inserted for it" "0" \
    "SELECT count(*) FROM refunds WHERE order_id = 'dddddddd-1000-4000-8000-00000000000e'"

printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ]
