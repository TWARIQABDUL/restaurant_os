#!/usr/bin/env bash
#
# Order acceptance tests — milestone 8, first half.
#
# Weighted towards the failures that cost money rather than towards coverage: an
# order placed twice, a total that does not match its lines, an order with no
# lines, a status that jumps, and a history that can be rewritten. Two of these
# are real concurrency tests, not inspections.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_orders_test"
TEST_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${TEST_DB}"
PASSED=0; FAILED=0; LAST=""

cleanup() { psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true; }
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

printf '\nOrder acceptance tests\n'
info "database  : ${TEST_DB}"

step "Building the schema and a store with something to sell"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" -c "CREATE DATABASE ${TEST_DB}" >/dev/null
if DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" >/dev/null 2>&1; then
    pass "the migrations apply to an empty database"
else
    LAST="$(DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" 2>&1)"; flunk "migrations did not apply"
    printf '\n%s\n' "$PASSED passed, $FAILED failed."; exit 1
fi

ST='11111111-0000-0000-0000-000000000001'
FOOD="$(q "SELECT id FROM industry_templates WHERE key='food'")"
accepts "a store, a burger with extras, and a default variant" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version)
       VALUES ('${ST}','nyama','Nyama & Co.','RW','RWF','active','${FOOD}',1);
     INSERT INTO products (id,store_id,name,base_price,status) VALUES
       ('aaaa0000-0000-0000-0000-000000000001','${ST}','Chicken burger',3500,'active');
     INSERT INTO option_groups (id,store_id,name,select_mode,is_required) VALUES
       ('bbbb0000-0000-0000-0000-000000000001','${ST}','Extras','several',false);
     INSERT INTO option_values (id,option_group_id,store_id,label,price_delta) VALUES
       ('cccc0000-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','${ST}','Cheese',500),
       ('cccc0000-0000-0000-0000-000000000002','bbbb0000-0000-0000-0000-000000000001','${ST}','Fries',1000);
     INSERT INTO product_option_groups (product_id,option_group_id,store_id) VALUES
       ('aaaa0000-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','${ST}');
     INSERT INTO product_variants (id,product_id,store_id,is_default) VALUES
       ('dddd0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001','${ST}',true)"

# A complete, well-formed order in one transaction. Everything below varies from it.
place() {   # place <order-uuid> <idempotency-key> [extra order columns SQL]
cat <<SQL
INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,
                    guest_name,guest_phone,delivery_address,fulfilment_type,
                    payment_method,currency,subtotal_amount,delivery_fee_amount ${3:+,$3})
  VALUES ('$1','${ST}',next_order_number('${ST}'),'trk_$(printf '%s' "$2" | tr -dc 'a-z0-9' | head -c 16)','$2',
          'Aimable Kayitare','078 330 1180','KG 11 Ave, Kimihurura','delivery',
          'momo','RWF',9000,1000 ${4:+,$4});
INSERT INTO order_items (id,order_id,store_id,variant_id,product_name,unit_price_amount,options_amount,quantity)
  VALUES ('$1'::uuid + 0,'$1','${ST}','dddd0000-0000-0000-0000-000000000001','Chicken burger',3500,1000,2);
SQL
}

# =============================================================================
step "An order placed twice is one order"
# =============================================================================
KEY='idem_checkout_9f2b7c14e8a0'
ITEM='ffff0000-0000-0000-0000-000000000001'
accepts "the first attempt — order, line and captured options in one transaction" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('eeee0000-0000-0000-0000-000000000001','${ST}',next_order_number('${ST}'),'trk_first_attempt01','${KEY}',
              'Aimable Kayitare','078 330 1180','KG 11 Ave','delivery','momo','RWF',10000);
     INSERT INTO order_items (id,order_id,store_id,variant_id,product_name,unit_price_amount,options_amount,quantity)
      VALUES ('${ITEM}','eeee0000-0000-0000-0000-000000000001','${ST}','dddd0000-0000-0000-0000-000000000001',
              'Chicken burger',3500,1500,2);
     INSERT INTO order_item_option_values (order_item_id,order_id,option_value_id,group_name,value_label,price_delta)
      VALUES ('${ITEM}','eeee0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000001','Extras','Cheese',500),
             ('${ITEM}','eeee0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','Extras','Fries',1000)"
refuses "the retry, carrying the same idempotency key" "orders_store_idempotency_key" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('eeee0000-0000-0000-0000-000000000002','${ST}',next_order_number('${ST}'),'trk_second_attempt1','${KEY}',
              'Aimable Kayitare','078 330 1180','KG 11 Ave','delivery','momo','RWF',10000);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,options_amount,quantity)
      VALUES ('eeee0000-0000-0000-0000-000000000002','${ST}','dddd0000-0000-0000-0000-000000000001','Chicken burger',3500,0,2)"
equals  "so exactly one order exists" "1" "SELECT count(*) FROM orders"
equals  "and the customer was charged for one" "10000.00" "SELECT sum(total_amount)::text FROM orders"

# =============================================================================
step "The total cannot be a number someone chose"
# =============================================================================
equals "total is subtotal plus delivery minus discount, computed" "10000.00" \
    "SELECT total_amount::text FROM orders WHERE id='eeee0000-0000-0000-0000-000000000001'"
refuses "writing the total directly" "can only be updated to DEFAULT" \
    "UPDATE orders SET total_amount=1 WHERE id='eeee0000-0000-0000-0000-000000000001'"
accepts "adding a delivery fee moves the total with it" \
    "UPDATE orders SET delivery_fee_amount=1000 WHERE id='eeee0000-0000-0000-0000-000000000001'"
equals  "to 11,000" "11000.00" "SELECT total_amount::text FROM orders WHERE id='eeee0000-0000-0000-0000-000000000001'"
refuses "a subtotal that disagrees with the lines" "its lines sum to" \
    "UPDATE orders SET subtotal_amount=5 WHERE id='eeee0000-0000-0000-0000-000000000001'"
refuses "a discount larger than the order" "orders_discount_within_subtotal" \
    "UPDATE orders SET discount_amount=999999 WHERE id='eeee0000-0000-0000-0000-000000000001'"
equals "the line total is its own parts, computed" "10000.00" \
    "SELECT line_total_amount::text FROM order_items WHERE order_id='eeee0000-0000-0000-0000-000000000001'"
refuses "writing a line total directly" "can only be updated to DEFAULT" \
    "UPDATE order_items SET line_total_amount=1 WHERE order_id='eeee0000-0000-0000-0000-000000000001'"

step "An order with no lines cannot exist"
refuses "an order on its own" "has no lines" \
    "INSERT INTO orders (store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${ST}',next_order_number('${ST}'),'trk_no_lines_at_all','idem_no_lines_at_all_x',
              'X','078 000 0000','KG 1 Ave','delivery','momo','RWF',0)"
refuses "removing the last line from an order" "has no lines" \
    "DELETE FROM order_items WHERE order_id='eeee0000-0000-0000-0000-000000000001'"

step "Captured option deltas must add up"
equals  "the line's options were captured with it" "Cheese 500.00,Fries 1000.00" \
    "SELECT string_agg(value_label || ' ' || price_delta::text, ',' ORDER BY value_label)
       FROM order_item_option_values WHERE order_id='eeee0000-0000-0000-0000-000000000001'"
refuses "changing a captured delta so it no longer matches the line" "its options sum to" \
    "UPDATE order_item_option_values SET price_delta=999
      WHERE option_value_id='cccc0000-0000-0000-0000-000000000001'"
refuses "removing a captured option without adjusting the line" "its options sum to" \
    "DELETE FROM order_item_option_values WHERE option_value_id='cccc0000-0000-0000-0000-000000000002'"

# =============================================================================
step "No order jumps a state"
# =============================================================================
O="eeee0000-0000-0000-0000-000000000001"
refuses "pending straight to delivered" "cannot move from pending to delivered" \
    "UPDATE orders SET status='delivered' WHERE id='${O}'"
accepts "pending to approved" "UPDATE orders SET status='approved' WHERE id='${O}'"
accepts "approved to preparing" "UPDATE orders SET status='preparing' WHERE id='${O}'"
refuses "preparing back to pending" "cannot move from preparing to pending" \
    "UPDATE orders SET status='pending' WHERE id='${O}'"
accepts "preparing to ready" "UPDATE orders SET status='ready' WHERE id='${O}'"
accepts "ready to assigned" "UPDATE orders SET status='assigned' WHERE id='${O}'"
accepts "assigned to out" "UPDATE orders SET status='out' WHERE id='${O}'"
accepts "out to delivered" "UPDATE orders SET status='delivered', delivered_at=now() WHERE id='${O}'"
refuses "anything after delivered — it is terminal" "cannot move from delivered to" \
    "UPDATE orders SET status='returned' WHERE id='${O}'"
equals  "all twelve statuses are allowed by the column" "12" \
    "SELECT count(*) FROM (SELECT unnest(ARRAY['pending','approved','preparing','ready','assigned','out',
        'delivered','collected','returned','closed_return','rejected','cancelled'])) x"
equals  "five statuses are terminal — no move leaves them" "cancelled,closed_return,collected,delivered,rejected" \
    "SELECT string_agg(s, ',' ORDER BY s) FROM (
       SELECT unnest(ARRAY['pending','approved','preparing','ready','assigned','out','delivered','collected',
                           'returned','closed_return','rejected','cancelled']) AS s) x
      WHERE NOT EXISTS (SELECT 1 FROM order_status_transitions t WHERE t.from_status = x.s)"

step "History cannot be rewritten"
accepts "an event for each change" \
    "INSERT INTO order_events (order_id,store_id,from_status,to_status,reason)
      VALUES ('${O}','${ST}','out','delivered','Handed to the customer')"
refuses "editing an event" "append-only" \
    "UPDATE order_events SET reason='something else' WHERE order_id='${O}'"
refuses "deleting an event" "append-only" "DELETE FROM order_events WHERE order_id='${O}'"

step "Money fields cannot contradict each other"
refuses "paid with no paid_at" "orders_paid_at_agrees" \
    "UPDATE orders SET payment_status='paid' WHERE id='${O}'"
accepts "paid, with the time it happened" \
    "UPDATE orders SET payment_status='paid', paid_at=now(), settlement_status='pending' WHERE id='${O}'"
# 99999 on an 11,000 order breaks two refund rules at once — within_total and
# status_agrees — and which one Postgres reports first is not a test's business.
refuses "refunding more than was charged" "orders_refund_" \
    "UPDATE orders SET refunded_amount=99999 WHERE id='${O}'"
# refunded_amount is not a figure to set by hand: V005 makes it the sum of the
# order's APPROVED refunds, maintained by approve_refund(). The cases that need a
# real refund behind them are in test-money.sh; what stays here are the column
# CHECKs, which fire immediately and leave nothing behind.
refuses "marking it fully refunded while nothing has been refunded" "orders_refund_status_agrees" \
    "UPDATE orders SET payment_status='refunded' WHERE id='${O}'"
refuses "cash reconciliation on a momo order" "orders_cash_fields_are_cash_only" \
    "UPDATE orders SET cash_reported_amount=5000 WHERE id='${O}'"
refuses "confirming cash with no figure counted" "orders_cash_confirmed_has_figure" \
    "INSERT INTO orders (store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount,cash_confirmed_at)
      VALUES ('${ST}',next_order_number('${ST}'),'trk_cash_no_figure1','idem_cash_no_figure_x',
              'X','078 000 0000','KG 1 Ave','delivery','cash','RWF',1000,now())"

step "A customer, a destination, a rider"
refuses "an order belonging to nobody" "orders_has_a_customer" \
    "INSERT INTO orders (store_id,order_number,tracking_code,idempotency_key,delivery_address,
        fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${ST}',next_order_number('${ST}'),'trk_nobody_at_all1','idem_nobody_at_all_xx',
              'KG 1 Ave','delivery','momo','RWF',1000)"
refuses "a delivery with nowhere to go" "orders_delivery_has_address" \
    "INSERT INTO orders (store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${ST}',next_order_number('${ST}'),'trk_no_address_here','idem_no_address_here_x',
              'X','078 000 0000','delivery','momo','RWF',1000)"
refuses "a pickup carrying a stale address" "orders_delivery_has_address" \
    "INSERT INTO orders (store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${ST}',next_order_number('${ST}'),'trk_pickup_address1','idem_pickup_address_xx',
              'X','078 000 0000','KG 1 Ave','pickup','momo','RWF',1000)"

step "What was charged is captured, not looked up later"
accepts "renaming the product afterwards" \
    "UPDATE products SET name='Chicken Burger Deluxe' WHERE id='aaaa0000-0000-0000-0000-000000000001'"
equals  "the order still says what the customer bought" "Chicken burger" \
    "SELECT DISTINCT product_name FROM order_items WHERE order_id='${O}'"
refuses "deleting a variant an order references" "violates foreign key constraint" \
    "DELETE FROM product_variants WHERE id='dddd0000-0000-0000-0000-000000000001'"

# =============================================================================
step "Order numbers under concurrency — 20 at once"
# =============================================================================
# A real race, not an inspection: twenty independent connections allocate a number
# for the same store at the same time. Two the same would mean two orders a
# merchant cannot tell apart.
seq 1 20 | xargs -P 20 -I{} env PGPASSWORD="$OWNER_PASSWORD" \
    docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$OWNER_PASSWORD" "$SERVICE" \
    psql -h 127.0.0.1 -U "$OWNER_ROLE" -d "$TEST_DB" -tAc "SELECT next_order_number('${ST}')" \
    > /tmp/claude-1000/-home-abdalazizi-restaurant-os/9e37ab58-4cab-4b22-84d4-4d4b7273fc75/scratchpad/nums.txt 2>/dev/null
ALLOCATED="$(grep -c '^[0-9]' /tmp/claude-1000/-home-abdalazizi-restaurant-os/9e37ab58-4cab-4b22-84d4-4d4b7273fc75/scratchpad/nums.txt || echo 0)"
DISTINCT="$(grep '^[0-9]' /tmp/claude-1000/-home-abdalazizi-restaurant-os/9e37ab58-4cab-4b22-84d4-4d4b7273fc75/scratchpad/nums.txt | sort -u | wc -l | tr -d ' ')"
if [ "$ALLOCATED" = "20" ] && [ "$DISTINCT" = "20" ]; then
    pass "twenty concurrent allocations produced twenty distinct numbers"
else
    LAST="allocated: $ALLOCATED   distinct: $DISTINCT"
    flunk "concurrent order numbers collided or were lost"
fi

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
