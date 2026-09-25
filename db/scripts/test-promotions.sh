#!/usr/bin/env bash
#
# Promotions acceptance tests — milestone 9, eighth part.
#
# The headline is not promotions. It is that a discount can no longer be a number a
# client sent: orders.discount_amount has to equal the rows behind it, and this
# suite tries to break that from both sides — a column moved with no row, and a row
# removed with no column change.
#
# After that: the nine different answers a promo code can give, because States draws
# "doesn't exist" and "ended yesterday" as different screens; "10% off your items"
# meaning the items and not the delivery fee; and a code limited to one use being
# claimed by ten checkouts at once.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_promotions_test"
TEST_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${TEST_DB}"
SCRATCH="$(mktemp -d)"
PASSED=0; FAILED=0; LAST=""

cleanup() {
    psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
    rm -rf "$SCRATCH"
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
parallel_sql() {
    seq 1 "$1" | xargs -P "$1" -I{} docker compose -f "$COMPOSE_FILE" exec -T \
        -e PGPASSWORD="$OWNER_PASSWORD" "$SERVICE" \
        psql -h 127.0.0.1 -U "$OWNER_ROLE" -d "$TEST_DB" -tAc "$2" > "$3" 2>&1 || true
}
parallel_each() {  # parallel_each <file-of-statements> <outfile>
    # A loop rather than xargs: these statements contain quotes, and xargs -I{}
    # strips them, which turns a uuid literal into a column reference.
    local stmt
    : > "$2"
    while IFS= read -r stmt; do
        [ -n "$stmt" ] || continue
        ( docker compose -f "$COMPOSE_FILE" exec -T \
            -e PGPASSWORD="$OWNER_PASSWORD" "$SERVICE" \
            psql -h 127.0.0.1 -U "$OWNER_ROLE" -d "$TEST_DB" -tAc "$stmt" 2>&1 ) >> "$2" &
    done < "$1"
    wait
}

printf '\nPromotions acceptance tests\n'
info "database  : ${TEST_DB}"

step "Building the schema, a store, a menu and some orders"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" -c "CREATE DATABASE ${TEST_DB}" >/dev/null
if DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" >/dev/null 2>&1; then
    pass "the migrations apply to an empty database"
else
    LAST="$(DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" 2>&1)"; flunk "migrations did not apply"
    printf '\n%s\n' "$PASSED passed, $FAILED failed."; exit 1
fi

S1='11111111-0000-0000-0000-000000000001'
S2='22222222-0000-0000-0000-000000000002'
ALINE='aaaa0000-0000-0000-0000-000000000001'
SAND='bbbb0000-0000-0000-0000-000000000001'
KEV='bbbb0000-0000-0000-0000-000000000002'
BURGER='cccc0000-0000-0000-0000-000000000001'
FRIES='cccc0000-0000-0000-0000-000000000002'
JUICE='cccc0000-0000-0000-0000-000000000003'
VBURGER='dddd0000-0000-0000-0000-000000000001'
VFRIES='dddd0000-0000-0000-0000-000000000002'
VJUICE='dddd0000-0000-0000-0000-000000000003'
FOOD="$(q "SELECT id FROM industry_templates WHERE key='food'")"

accepts "the fixtures" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version) VALUES
       ('${S1}','nyama','Nyama & Co.','RW','RWF','active','${FOOD}',1),
       ('${S2}','inzu','Inzu Threads','RW','RWF','active','${FOOD}',1);
     INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('${ALINE}','platform','aline@example.com','h','Aline Uwase');
     INSERT INTO users (id,scope,store_id,email,password_hash,name) VALUES
       ('${SAND}','store','${S1}','sandrine@example.com','h','Sandrine Keza'),
       ('${KEV}','store','${S1}','kevin@example.com','h','Kevin Mugabo');
     INSERT INTO store_members (user_id,store_id,role) VALUES ('${ALINE}','${S1}','owner');
     INSERT INTO products (id,store_id,name,base_price,track_stock,status) VALUES
       ('${BURGER}','${S1}','Chicken Burger',3500,false,'active'),
       ('${FRIES}','${S1}','Fries',1500,false,'active'),
       ('${JUICE}','${S1}','Mango Juice',1200,false,'active');
     INSERT INTO product_variants (id,product_id,store_id,sku,is_default) VALUES
       ('${VBURGER}','${BURGER}','${S1}','BUR',true),
       ('${VFRIES}','${FRIES}','${S1}','FRI',true),
       ('${VJUICE}','${JUICE}','${S1}','JUI',true)"

# An order of 9,500 in items plus a 1,000 delivery fee — States' own figures.
O1='eeee0000-0000-0000-0000-000000000001'
accepts "an order: two burgers, fries, juice — 9,500 of items and a 1,000 fee" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount,delivery_fee_amount)
      VALUES ('${O1}','${S1}',next_order_number('${S1}'),'trk_promo_000001','idem_promo_0000001','${SAND}','Kimihurura','delivery','mtn_momo','RWF',9500,1000);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity) VALUES
       ('${O1}','${S1}','${VBURGER}','Chicken Burger',3500,2),
       ('${O1}','${S1}','${VFRIES}','Fries',1500,1),
       ('${O1}','${S1}','${VJUICE}','Mango Juice',1000,1)"
equals  "the total is the items plus the fee, with nothing off" "9500.00|1000.00|0.00|10500.00" \
    "SELECT subtotal_amount || '|' || delivery_fee_amount || '|' || discount_amount || '|' || total_amount
       FROM orders WHERE id='${O1}'"

# =============================================================================
step "A DISCOUNT CANNOT BE A NUMBER SOMEBODY SENT"
# =============================================================================
refuses "moving discount_amount with nothing behind it" "its discounts sum to" \
    "UPDATE orders SET discount_amount=9500 WHERE id='${O1}'"
refuses "even by one franc" "its discounts sum to" \
    "UPDATE orders SET discount_amount=1 WHERE id='${O1}'"
refuses "an order created with a discount out of thin air" "its discounts sum to" \
    "INSERT INTO orders (store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount,discount_amount)
      VALUES ('${S1}',next_order_number('${S1}'),'trk_promo_bogus01','idem_promo_bogus001','A Guest','078 000 0001','x','delivery','mtn_momo','RWF',5000,1000)"
equals  "and the order is untouched" "0.00|10500.00" \
    "SELECT discount_amount || '|' || total_amount FROM orders WHERE id='${O1}'"

# =============================================================================
step "What a promotion may and may not be"
# =============================================================================
accepts "WELCOME10 — 10% off, no window, no cap" \
    "INSERT INTO promotions (id,store_id,kind,code,discount_type,percent_off,created_by)
      VALUES ('1111ffff-0000-0000-0000-000000000001','${S1}','code','WELCOME10','percentage',10,'${ALINE}')"
refuses "the same code again" "promotions_store_code_key\|duplicate key" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off)
      VALUES ('${S1}','code','WELCOME10','percentage',5)"
refuses "a lower-case code, because codes are stored the way the field types them" "code_shape" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off)
      VALUES ('${S1}','code','welcome11','percentage',5)"
accepts "but another store may use it" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off)
      VALUES ('${S2}','code','WELCOME10','percentage',20)"
refuses "an automatic promotion with a code to type" "code_matches_kind" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,banner_title)
      VALUES ('${S1}','automatic','SECRET','percentage',10,'x')"
refuses "a code promotion with no code" "code_matches_kind" \
    "INSERT INTO promotions (store_id,kind,discount_type,percent_off)
      VALUES ('${S1}','code','percentage',10)"
refuses "a code with spaces in it" "code_shape" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off)
      VALUES ('${S1}','code','TWO WORDS','percentage',10)"
refuses "a percentage promotion carrying a fixed amount as well" "fixed_amount_shape" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,amount_off)
      VALUES ('${S1}','code','BOTH','percentage',10,500)"
refuses "110% off" "percent_range" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off)
      VALUES ('${S1}','code','TOOMUCH','percentage',110)"
refuses "0% off" "percent_range" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off)
      VALUES ('${S1}','code','NOTHING','percentage',0)"
refuses "a free item nobody has to buy anything for" "free_item_needs_requirement" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,free_product_id)
      VALUES ('${S1}','code','FREEFRIES','free_item','${FRIES}')"
refuses "a window that ends before it starts" "window_ordered" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,starts_at,ends_at)
      VALUES ('${S1}','code','BACKWARDS','percentage',10,now(),now() - interval '1 day')"
refuses "hours that end before they start" "hours_ordered" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,time_from,time_to)
      VALUES ('${S1}','code','NIGHTSHIFT','percentage',10,'15:00','12:00')"
refuses "half a set of hours" "hours_complete" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,time_from)
      VALUES ('${S1}','code','HALFHOURS','percentage',10,'12:00')"
refuses "an eighth day of the week" "days_are_iso" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,days_of_week)
      VALUES ('${S1}','code','EIGHTHDAY','percentage',10,'{8}')"
refuses "an automatic promotion with no banner to show" "automatic_has_banner" \
    "INSERT INTO promotions (store_id,kind,discount_type,percent_off)
      VALUES ('${S1}','automatic','percentage',10)"
refuses "a free product from another store" "violates foreign key" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,free_product_id,required_product_id,min_quantity)
      VALUES ('${S2}','code','CROSSSTORE','free_item','${FRIES}','${BURGER}',2)"

# =============================================================================
step "\"10% off your items\" means the items"
# =============================================================================
equals "applying WELCOME10" "applied|950.00" \
    "SELECT status || '|' || discount_amount FROM apply_promo_code('${O1}','welcome10')"
equals "950 is 10% of the 9,500 of items — the 1,000 fee is untouched" "9500.00|1000.00|950.00|9550.00" \
    "SELECT subtotal_amount || '|' || delivery_fee_amount || '|' || discount_amount || '|' || total_amount
       FROM orders WHERE id='${O1}'"
equals "the discount is a row that says where it came from" "promotion|WELCOME10|950.00" \
    "SELECT source || '|' || code || '|' || amount FROM order_discounts WHERE order_id='${O1}'"
equals "applying it again says so, and changes nothing" "already_applied|0" \
    "SELECT status || '|' || discount_amount FROM apply_promo_code('${O1}','WELCOME10')"
equals "still one discount row" "1|950.00" \
    "SELECT count(*) || '|' || sum(amount) FROM order_discounts WHERE order_id='${O1}'"
refuses "deleting the row and leaving the column" "its discounts sum to" \
    "DELETE FROM order_discounts WHERE order_id='${O1}'"
refuses "editing the row's amount on its own" "its discounts sum to" \
    "UPDATE order_discounts SET amount=5000 WHERE order_id='${O1}'"
equals "and the order still says 950" "950.00" \
    "SELECT discount_amount::text FROM orders WHERE id='${O1}'"

# =============================================================================
step "The nine answers a code can give"
# =============================================================================
O2='eeee0000-0000-0000-0000-000000000002'
accepts "a second order to test against" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount,delivery_fee_amount)
      VALUES ('${O2}','${S1}',next_order_number('${S1}'),'trk_promo_000002','idem_promo_0000002','${KEV}','Kacyiru','delivery','mtn_momo','RWF',3500,1000);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
      VALUES ('${O2}','${S1}','${VBURGER}','Chicken Burger',3500,1)"
accepts "the other eight promotions" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,is_active) VALUES
       ('${S1}','code','WITHDRAWN','percentage',10,false);
     INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,starts_at) VALUES
       ('${S1}','code','SOON','percentage',10,now() + interval '1 day');
     INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,ends_at) VALUES
       ('${S1}','code','FRIDAY20','percentage',20,now() - interval '1 day');
     INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,days_of_week) VALUES
       ('${S1}','code','WRONGDAY','percentage',10,
        ARRAY[(CASE WHEN extract(isodow FROM now())::int = 7 THEN 1 ELSE extract(isodow FROM now())::int + 1 END)]::smallint[]);
     INSERT INTO promotions (store_id,kind,code,discount_type,percent_off,min_subtotal_amount) VALUES
       ('${S1}','code','SPEND20K','percentage',10,20000);
     INSERT INTO promotions (store_id,kind,code,discount_type,free_product_id,required_product_id,min_quantity) VALUES
       ('${S1}','code','TWOBURGERS','free_item','${FRIES}','${BURGER}',2);
     INSERT INTO promotions (store_id,kind,code,discount_type,amount_off) VALUES
       ('${S1}','code','SOKO100','fixed_amount',100),
       ('${S1}','code','BIGMONEY','fixed_amount',99999)"
equals "a code nobody has heard of" "unknown_code" \
    "SELECT status FROM apply_promo_code('${O2}','WELCOME100')"
equals "a code that was withdrawn" "withdrawn" \
    "SELECT status FROM apply_promo_code('${O2}','WITHDRAWN')"
equals "a code that has not started" "not_started" \
    "SELECT status FROM apply_promo_code('${O2}','SOON')"
equals "a code that ended yesterday — which is NOT the same as unknown" "expired" \
    "SELECT status FROM apply_promo_code('${O2}','FRIDAY20')"
equals "a code that is not valid today" "outside_hours" \
    "SELECT status FROM apply_promo_code('${O2}','WRONGDAY')"
equals "a code needing a bigger basket" "below_minimum" \
    "SELECT status FROM apply_promo_code('${O2}','SPEND20K')"
equals "a code needing two burgers when there is one" "requirements_not_met" \
    "SELECT status FROM apply_promo_code('${O2}','TWOBURGERS')"
equals "none of which wrote anything" "0|0.00" \
    "SELECT count(*) || '|' || (SELECT discount_amount FROM orders WHERE id='${O2}')
       FROM order_discounts WHERE order_id='${O2}'"
equals "a fixed amount off" "applied|100.00" \
    "SELECT status || '|' || discount_amount FROM apply_promo_code('${O2}','SOKO100')"
equals "a fixed amount bigger than the basket takes only what is left of it" "applied|3400.00" \
    "SELECT status || '|' || discount_amount FROM apply_promo_code('${O2}','BIGMONEY')"
equals "so the items are free and the fee is still owed" "3500.00|3500.00|1000.00" \
    "SELECT subtotal_amount || '|' || discount_amount || '|' || total_amount FROM orders WHERE id='${O2}'"
equals "and nothing more can come off" "nothing_to_discount" \
    "SELECT status FROM apply_promo_code('${O2}','WELCOME10')"

# =============================================================================
step "Two burgers, free fries"
# =============================================================================
O3='eeee0000-0000-0000-0000-000000000003'
accepts "an order with two burgers and fries in it" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${O3}','${S1}',next_order_number('${S1}'),'trk_promo_000003','idem_promo_0000003','${SAND}','pickup','mtn_momo','RWF',8500);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity) VALUES
       ('${O3}','${S1}','${VBURGER}','Chicken Burger',3500,2),
       ('${O3}','${S1}','${VFRIES}','Fries',1500,1)"
equals  "the fries come off, at the price they were charged" "applied|1500.00" \
    "SELECT status || '|' || discount_amount FROM apply_promo_code('${O3}','TWOBURGERS')"
accepts "the menu price of fries changes afterwards" \
    "UPDATE products SET base_price=9999 WHERE id='${FRIES}'"
equals  "the discount is still the captured price, not today's price list" "1500.00" \
    "SELECT amount::text FROM order_discounts WHERE order_id='${O3}'"
equals  "the order is 8,500 less 1,500" "7000.00" \
    "SELECT total_amount::text FROM orders WHERE id='${O3}'"

# =============================================================================
step "Automatic promotions, and the half-open window"
# =============================================================================
A1='1111ffff-0000-0000-0000-00000000000a'
accepts "\"Two burgers, free fries · Weekdays 12:00-15:00\", added automatically" \
    "INSERT INTO promotions (id,store_id,kind,discount_type,free_product_id,required_product_id,min_quantity,
        days_of_week,time_from,time_to,banner_title,banner_subtitle)
      VALUES ('${A1}','${S1}','automatic','free_item','${FRIES}','${BURGER}',2,
        '{1,2,3,4,5}','12:00','15:00','Two burgers, free fries','Weekdays 12:00–15:00. Added automatically at checkout.')"
equals  "live at noon on a Wednesday" "t" \
    "SELECT promotion_is_live('${A1}','2026-09-23 12:00:00+00'::timestamptz)"
equals  "live at 14:59" "t" \
    "SELECT promotion_is_live('${A1}','2026-09-23 14:59:59+00'::timestamptz)"
equals  "NOT live at 15:00 — the window is half-open, so two can abut" "f" \
    "SELECT promotion_is_live('${A1}','2026-09-23 15:00:00+00'::timestamptz)"
equals  "not live at 11:59" "f" \
    "SELECT promotion_is_live('${A1}','2026-09-23 11:59:59+00'::timestamptz)"
equals  "and not on a Sunday, whatever the time" "f" \
    "SELECT promotion_is_live('${A1}','2026-09-27 13:00:00+00'::timestamptz)"
O4='eeee0000-0000-0000-0000-000000000004'
accepts "a lunchtime order with two burgers" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${O4}','${S1}',next_order_number('${S1}'),'trk_promo_000004','idem_promo_0000004','${KEV}','pickup','mtn_momo','RWF',8500);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity) VALUES
       ('${O4}','${S1}','${VBURGER}','Chicken Burger',3500,2),
       ('${O4}','${S1}','${VFRIES}','Fries',1500,1)"
equals  "the automatic pass applies it, with nobody typing anything" "1|1500.00" \
    "SELECT count(*) || '|' || sum(applied_amount)
       FROM apply_automatic_promotions('${O4}','2026-09-23 12:30:00+00'::timestamptz)"
equals  "running checkout again adds nothing" "0" \
    "SELECT count(*) FROM apply_automatic_promotions('${O4}','2026-09-23 12:30:00+00'::timestamptz)"
equals  "and the order records it once" "1|1500.00|7000.00" \
    "SELECT (SELECT count(*) FROM order_discounts WHERE order_id='${O4}') || '|' ||
            discount_amount || '|' || total_amount FROM orders WHERE id='${O4}'"
equals  "outside the window it applies nothing" "0" \
    "SELECT count(*) FROM apply_automatic_promotions('${O3}','2026-09-27 20:00:00+00'::timestamptz)"
equals  "the banner is the live automatic promotion's own words" "Two burgers, free fries" \
    "SELECT banner_title FROM store_promotion_banner('${S1}','2026-09-23 12:30:00+00'::timestamptz)"
equals  "and there is no banner outside the window" "0" \
    "SELECT count(*) FROM store_promotion_banner('${S1}','2026-09-27 20:00:00+00'::timestamptz)"

# =============================================================================
step "A discount by hand, which is where a short cash payment lands"
# =============================================================================
O5='eeee0000-0000-0000-0000-000000000005'
accepts "a cash order of 5,000" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${O5}','${S1}',next_order_number('${S1}'),'trk_promo_000005','idem_promo_0000005','A Guest','078 000 0002','pickup','cash','RWF',5000);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
      VALUES ('${O5}','${S1}','${VBURGER}','Chicken Burger',5000,1)"
refuses "a manual discount with no reason" "needs a reason on the order" \
    "SELECT record_manual_discount('${O5}',1000,'   ','${ALINE}')"
refuses "a manual discount of nothing" "is not a discount" \
    "SELECT record_manual_discount('${O5}',0,'why not','${ALINE}')"
accepts "the customer genuinely paid 1,000 less, recorded on the order" \
    "SELECT record_manual_discount('${O5}',1000,'Cash short by 1,000 — customer paid less, agreed by the manager','${ALINE}')"
equals  "it lands in the same column as a promotion would" "1000.00|4000.00" \
    "SELECT discount_amount || '|' || total_amount FROM orders WHERE id='${O5}'"
equals  "and says who and why" "manual|${ALINE}|true" \
    "SELECT source || '|' || created_by || '|' || (reason LIKE '%Cash short%')::text
       FROM order_discounts WHERE order_id='${O5}'"
refuses "a manual row with no author" "manual_has_author" \
    "INSERT INTO order_discounts (order_id,store_id,source,amount,reason)
      VALUES ('${O5}','${S1}','manual',100,'because')"
refuses "a manual row pretending to be a promotion" "promotion_shape" \
    "INSERT INTO order_discounts (order_id,store_id,source,amount,reason,created_by)
      VALUES ('${O5}','${S1}','promotion',100,'because','${ALINE}')"
refuses "discounts totalling more than the items" "past the" \
    "SELECT record_manual_discount('${O5}',9000,'a very generous manager','${ALINE}')"
equals  "which left the order as it was" "1000.00" \
    "SELECT discount_amount::text FROM orders WHERE id='${O5}'"

# =============================================================================
step "Ten checkouts claiming one code at once"
# =============================================================================
accepts "a code good for exactly one use" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,amount_off,max_redemptions)
      VALUES ('${S1}','code','ONLYONE','fixed_amount',500,1)"
# Ten different orders, so the per-order unique key cannot be what saves us.
: > "$SCRATCH/orders.sql"
for i in $(seq 1 10); do
    printf "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,fulfilment_type,payment_method,currency,subtotal_amount) VALUES ('eeee0000-0000-0000-0000-0000000001%02d','%s',next_order_number('%s'),'trk_promo_race%03d','idem_promo_race%04d','Racer %d','078 000 %04d','pickup','mtn_momo','RWF',5000); INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity) VALUES ('eeee0000-0000-0000-0000-0000000001%02d','%s','%s','Chicken Burger',5000,1);\n" \
        "$i" "$S1" "$S1" "$i" "$i" "$i" "$i" "$i" "$S1" "$VBURGER" >> "$SCRATCH/orders.sql"
done
accepts "ten orders to race with" "$(cat "$SCRATCH/orders.sql")"
: > "$SCRATCH/race.sql"
for i in $(seq 1 10); do
    printf "SELECT status FROM apply_promo_code('eeee0000-0000-0000-0000-0000000001%02d','ONLYONE')\n" "$i" >> "$SCRATCH/race.sql"
done
parallel_each "$SCRATCH/race.sql" "$SCRATCH/race.txt"
WON="$(grep -c '^applied$' "$SCRATCH/race.txt" 2>/dev/null || echo 0)"
CAPPED="$(grep -c '^limit_reached$' "$SCRATCH/race.txt" 2>/dev/null || echo 0)"
ROWS="$(q "SELECT count(*) FROM order_discounts WHERE promotion_id=(SELECT id FROM promotions WHERE code='ONLYONE')")"
if [ "$WON" = "1" ] && [ "$CAPPED" = "9" ] && [ "$ROWS" = "1" ]; then
    pass "exactly one use, nine told the code was spent, one row in the table"
else
    LAST="applied: $WON   limit_reached: $CAPPED   rows: $ROWS"$'\n'"$(sort "$SCRATCH/race.txt" | uniq -c)"
    flunk "a code limited to one use was used more than once"
fi
equals "and the eleventh attempt is told too" "limit_reached" \
    "SELECT status FROM apply_promo_code('${O5}','ONLYONE')"

step "A per-customer cap, which is a different question"
accepts "a code one per customer" \
    "INSERT INTO promotions (store_id,kind,code,discount_type,amount_off,max_redemptions_per_customer)
      VALUES ('${S1}','code','ONEEACH','fixed_amount',200,1)"
O6='eeee0000-0000-0000-0000-000000000006'
O7='eeee0000-0000-0000-0000-000000000007'
accepts "two more orders from the same customer" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        fulfilment_type,payment_method,currency,subtotal_amount) VALUES
       ('${O6}','${S1}',next_order_number('${S1}'),'trk_promo_000006','idem_promo_0000006','${SAND}','pickup','mtn_momo','RWF',5000),
       ('${O7}','${S1}',next_order_number('${S1}'),'trk_promo_000007','idem_promo_0000007','${SAND}','pickup','mtn_momo','RWF',5000);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity) VALUES
       ('${O6}','${S1}','${VBURGER}','Chicken Burger',5000,1),
       ('${O7}','${S1}','${VBURGER}','Chicken Burger',5000,1)"
equals "the first order gets it" "applied" "SELECT status FROM apply_promo_code('${O6}','ONEEACH')"
equals "the same customer's second order does not" "limit_reached" \
    "SELECT status FROM apply_promo_code('${O7}','ONEEACH')"
O8='eeee0000-0000-0000-0000-000000000008'
accepts "an order from a different customer" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${O8}','${S1}',next_order_number('${S1}'),'trk_promo_000008','idem_promo_0000008','${KEV}','pickup','mtn_momo','RWF',5000);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
      VALUES ('${O8}','${S1}','${VBURGER}','Chicken Burger',5000,1)"
equals "but a different customer still can" "applied" \
    "SELECT status FROM apply_promo_code('${O8}','ONEEACH')"

# =============================================================================
step "The invariants, over every order this suite touched"
# =============================================================================
equals "every order's discount equals the rows behind it" "0" \
    "SELECT count(*) FROM orders o WHERE o.discount_amount <>
       (SELECT coalesce(sum(amount),0) FROM order_discounts WHERE order_id=o.id)"
equals "no order is discounted by more than its items" "0" \
    "SELECT count(*) FROM orders o WHERE o.discount_amount > o.subtotal_amount"
equals "every total is still its own parts" "0" \
    "SELECT count(*) FROM orders
      WHERE total_amount <> subtotal_amount + delivery_fee_amount - discount_amount"
equals "no promotion is applied twice to one order" "0" \
    "SELECT count(*) FROM (SELECT order_id, promotion_id FROM order_discounts
       WHERE promotion_id IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1) t"
equals "no capped promotion went over its cap" "0" \
    "SELECT count(*) FROM promotions p WHERE p.max_redemptions IS NOT NULL
       AND (SELECT count(*) FROM order_discounts d WHERE d.promotion_id=p.id) > p.max_redemptions"
equals "every promotion discount belongs to the store that issued it" "0" \
    "SELECT count(*) FROM order_discounts d JOIN promotions p ON p.id=d.promotion_id
      WHERE d.store_id <> p.store_id"
equals "every new table with updated_at has the trigger that maintains it" "" \
    "SELECT string_agg(c.table_name, ', ') FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.column_name='updated_at'
        AND NOT EXISTS (SELECT 1 FROM information_schema.triggers t
                         WHERE t.event_object_table=c.table_name AND t.action_statement LIKE '%set_updated_at%')"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
