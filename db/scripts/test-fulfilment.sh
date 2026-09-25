#!/usr/bin/env bash
#
# Fulfilment and rider-cash acceptance tests — milestone 9, second part.
#
# The two rules worth the most here are the ones a spreadsheet would get wrong: an
# area may belong to only ONE delivery zone per store, or the delivery fee depends
# on which row was read first; and a rider's day cannot be closed while they still
# have cash orders out.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_fulfilment_test"
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

printf '\nFulfilment and rider-cash acceptance tests\n'
info "database  : ${TEST_DB}"

step "Building the schema, two stores, a manager and three riders"
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
ERIC='aaaa0000-0000-0000-0000-000000000001'
CLAUDE='aaaa0000-0000-0000-0000-000000000002'
PATRICK='aaaa0000-0000-0000-0000-000000000003'   # a manager, not a rider
OTHER='aaaa0000-0000-0000-0000-000000000004'     # a rider at the OTHER store
FOOD="$(q "SELECT id FROM industry_templates WHERE key='food'")"
accepts "the fixtures" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version) VALUES
       ('${S1}','nyama','Nyama & Co.','RW','RWF','active','${FOOD}',1),
       ('${S2}','inzu','Inzu Threads','RW','RWF','active','${FOOD}',1);
     INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('${ERIC}','platform','eric@example.com','h','Eric Mugisha'),
       ('${CLAUDE}','platform','claude@example.com','h','Claude Habineza'),
       ('${PATRICK}','platform','patrick@example.com','h','Patrick Ishimwe'),
       ('${OTHER}','platform','olivier@example.com','h','Olivier Nzeyimana');
     INSERT INTO store_members (user_id,store_id,role) VALUES
       ('${ERIC}','${S1}','rider'), ('${CLAUDE}','${S1}','rider'),
       ('${PATRICK}','${S1}','manager'), ('${OTHER}','${S2}','rider');
     INSERT INTO products (id,store_id,name,base_price,status) VALUES
       ('bbbb0000-0000-0000-0000-000000000001','${S1}','Chicken burger',3500,'active');
     INSERT INTO product_variants (id,product_id,store_id,is_default) VALUES
       ('cccc0000-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001','${S1}',true)"

# =============================================================================
step "Delivery zones"
# =============================================================================
Z1='dddd0000-0000-0000-0000-000000000001'
Z2='dddd0000-0000-0000-0000-000000000002'
accepts "the two zones Settings draws, with their fees and ETAs" \
    "INSERT INTO delivery_zones (id,store_id,name,fee_amount,eta_min_minutes,eta_max_minutes,position) VALUES
       ('${Z1}','${S1}','Kigali city centre',1000,25,35,1),
       ('${Z2}','${S1}','Greater Kigali',2000,40,60,2);
     INSERT INTO delivery_zone_areas (zone_id,store_id,area_name) VALUES
       ('${Z1}','${S1}','Kacyiru'), ('${Z1}','${S1}','Kimihurura'), ('${Z1}','${S1}','Kiyovu'),
       ('${Z2}','${S1}','Remera'), ('${Z2}','${S1}','Kicukiro'), ('${Z2}','${S1}','Nyarutarama')"
equals "the fee for Kimihurura is unambiguous" "Kigali city centre|1000.00|25|35" \
    "SELECT z.name || '|' || z.fee_amount || '|' || z.eta_min_minutes || '|' || z.eta_max_minutes
       FROM delivery_zone_areas a JOIN delivery_zones z ON z.id=a.zone_id
      WHERE a.store_id='${S1}' AND lower(a.area_name)='kimihurura'"
refuses "the same area in a second zone — the fee would depend on read order" \
    "delivery_zone_areas_one_zone_per_area" \
    "INSERT INTO delivery_zone_areas (zone_id,store_id,area_name) VALUES ('${Z2}','${S1}','Kacyiru')"
refuses "the same area in a different case" "delivery_zone_areas_one_zone_per_area" \
    "INSERT INTO delivery_zone_areas (zone_id,store_id,area_name) VALUES ('${Z2}','${S1}','  kacyiru ')"
accepts "but another store may cover Kacyiru too" \
    "INSERT INTO delivery_zones (id,store_id,name,fee_amount,eta_min_minutes,eta_max_minutes) VALUES
       ('dddd0000-0000-0000-0000-000000000003','${S2}','City',1500,20,30);
     INSERT INTO delivery_zone_areas (zone_id,store_id,area_name) VALUES
       ('dddd0000-0000-0000-0000-000000000003','${S2}','Kacyiru')"
refuses "two zones with the same name in one store" "delivery_zones_store_name_key" \
    "INSERT INTO delivery_zones (store_id,name,fee_amount,eta_min_minutes,eta_max_minutes)
      VALUES ('${S1}','greater kigali',500,10,20)"
refuses "an ETA range that runs backwards" "delivery_zones_eta_ordered" \
    "INSERT INTO delivery_zones (store_id,name,fee_amount,eta_min_minutes,eta_max_minutes)
      VALUES ('${S1}','Backwards',500,60,30)"

step "Pickup and payouts"
accepts "pickup settings" \
    "INSERT INTO store_pickup_settings (store_id,address,ready_minutes) VALUES ('${S1}','KG 7 Ave, Kacyiru',15)"
refuses "a second pickup row for one store" "store_pickup_settings_pkey" \
    "INSERT INTO store_pickup_settings (store_id,address,ready_minutes) VALUES ('${S1}','Elsewhere',10)"
accepts "payouts to MTN MoMo every morning at 08:00" \
    "INSERT INTO store_payout_settings (store_id,payout_method_key,payout_phone,settlement_mode,automatic_at)
      VALUES ('${S1}','mtn_momo','078 000 4412','automatic','08:00')"
refuses "automatic settlement with no time" "store_payout_automatic_has_time" \
    "INSERT INTO store_payout_settings (store_id,payout_method_key,payout_phone,settlement_mode)
      VALUES ('${S2}','mtn_momo','078 000 0000','automatic')"
accepts "manual settlement, with no time" \
    "INSERT INTO store_payout_settings (store_id,payout_method_key,payout_phone) VALUES ('${S2}','mtn_momo','078 000 0000')"
accepts "connecting a method" \
    "INSERT INTO store_payment_methods (store_id,payment_method_key,is_connected,connected_at)
      VALUES ('${S1}','mtn_momo',true,now()), ('${S1}','cash',true,now())"
refuses "connected with no time it happened" "store_payment_methods_connected_at_agrees" \
    "INSERT INTO store_payment_methods (store_id,payment_method_key,is_connected) VALUES ('${S1}','airtel_money',true)"
equals "and no provider secret is stored anywhere in these tables" "0" \
    "SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('store_payment_methods','store_payout_settings','payment_methods')
        AND (column_name LIKE '%secret%' OR column_name LIKE '%key%' OR column_name LIKE '%token%'
          OR column_name LIKE '%password%' OR column_name LIKE '%credential%')
        AND column_name NOT IN ('payment_method_key','payout_method_key','key')"

# =============================================================================
step "Only a rider can be a rider"
# =============================================================================
accepts "profiles for the two riders" \
    "INSERT INTO rider_profiles (user_id,store_id,plate_number,availability) VALUES
       ('${ERIC}','${S1}','RAD 482 K','available'),
       ('${CLAUDE}','${S1}','RAE 115 C','available')"
refuses "a rider profile for the manager" "rider_profiles_user_id_store_id_member_role_fkey" \
    "INSERT INTO rider_profiles (user_id,store_id,plate_number) VALUES ('${PATRICK}','${S1}','RAC 270 B')"
refuses "a profile at a store they are not a member of" "rider_profiles_user_id_store_id_member_role_fkey" \
    "INSERT INTO rider_profiles (user_id,store_id,plate_number) VALUES ('${OTHER}','${S1}','RAB 903 F')"
refuses "the same plate, typed differently — it is one motorbike" "rider_profiles_store_plate_key" \
    "UPDATE rider_profiles SET plate_number=' rad482K ' WHERE user_id='${CLAUDE}'"
refuses "an availability the rider app cannot set" "rider_profiles_availability_values" \
    "UPDATE rider_profiles SET availability='on_a_delivery' WHERE user_id='${ERIC}'"
equals "'on a delivery' is not stored — it is derived from the orders" "0" \
    "SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='rider_profiles' AND column_name LIKE '%job%'"

step "An order's rider is a rider of that store"
place() {   # place <suffix> <rider-sql> <status>
cat <<SQL
INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
    delivery_address,fulfilment_type,payment_method,currency,subtotal_amount,rider_user_id,status
    $( [ "$2" = NULL ] && echo "" ))
  VALUES (gen_random_uuid(),'${S1}',next_order_number('${S1}'),'trk_ful_$1','idem_ful_order_$1',
          'Aimable K.','078 330 1180','KG 11 Ave','delivery','cash','RWF',6000,$2,'$3');
INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
  SELECT id,'${S1}','cccc0000-0000-0000-0000-000000000001','Chicken burger',6000,1
    FROM orders WHERE tracking_code='trk_ful_$1';
SQL
}
accepts "assigning Eric" "$(place aaaa "'${ERIC}'" pending)"
refuses "assigning the manager as the rider" "orders_rider_is_store_rider_fkey" \
    "$(place bbbb "'${PATRICK}'" pending)"
refuses "assigning a rider from another store" "orders_rider_is_store_rider_fkey" \
    "$(place cccc "'${OTHER}'" pending)"
accepts "an order with no rider yet" "$(place dddd NULL pending)"
equals  "which carries no role either" "t" \
    "SELECT rider_member_role IS NULL FROM orders WHERE tracking_code='trk_ful_dddd'"
accepts "trying to strip the role off an assigned order" \
    "UPDATE orders SET rider_member_role=NULL WHERE tracking_code='trk_ful_aaaa'"
equals  "which is simply re-derived — no caller has to know the column exists" "rider" \
    "SELECT rider_member_role FROM orders WHERE tracking_code='trk_ful_aaaa'"

# =============================================================================
step "Closing a rider's day"
# =============================================================================
accepts "Claude delivers two cash orders, 6,000 and 12,500" \
    "$(place eeee "'${CLAUDE}'" pending)
     UPDATE orders SET subtotal_amount=12500 WHERE tracking_code='trk_ful_eeee';
     UPDATE order_items SET unit_price_amount=12500 WHERE order_id=(SELECT id FROM orders WHERE tracking_code='trk_ful_eeee');
     UPDATE orders SET status='approved' WHERE tracking_code IN ('trk_ful_aaaa','trk_ful_eeee');
     UPDATE orders SET status='preparing' WHERE tracking_code IN ('trk_ful_aaaa','trk_ful_eeee');
     UPDATE orders SET status='ready' WHERE tracking_code IN ('trk_ful_aaaa','trk_ful_eeee');
     UPDATE orders SET status='assigned' WHERE tracking_code IN ('trk_ful_aaaa','trk_ful_eeee');
     UPDATE orders SET rider_user_id='${CLAUDE}' WHERE tracking_code='trk_ful_aaaa'"
refuses "closing Claude's day while both orders are still with him" "still with this rider" \
    "INSERT INTO rider_cash_settlements (store_id,rider_user_id,business_date,expected_amount,handed_over_amount,counted_amount)
      VALUES ('${S1}','${CLAUDE}',current_date,18500,0,18500)"
accepts "both delivered" \
    "UPDATE orders SET status='out' WHERE tracking_code IN ('trk_ful_aaaa','trk_ful_eeee');
     UPDATE orders SET status='delivered', delivered_at=now() WHERE tracking_code IN ('trk_ful_aaaa','trk_ful_eeee')"
accepts "a part-way hand-in of 6,000 at midday" \
    "INSERT INTO rider_cash_handovers (store_id,rider_user_id,amount,received_by,note)
      VALUES ('${S1}','${CLAUDE}',6000,'${PATRICK}','Handed in at 12:00')"
accepts "and another later" \
    "INSERT INTO rider_cash_handovers (store_id,rider_user_id,amount,received_by)
      VALUES ('${S1}','${CLAUDE}',1000,'${PATRICK}')"
equals  "a day is a running account, not one payment" "2|7000.00" \
    "SELECT count(*) || '|' || sum(amount)::text FROM rider_cash_handovers WHERE rider_user_id='${CLAUDE}'"
refuses "closing short with no explanation of the gap" "rider_cash_settlements_shortfall_resolved" \
    "INSERT INTO rider_cash_settlements (store_id,rider_user_id,business_date,expected_amount,handed_over_amount,counted_amount)
      VALUES ('${S1}','${CLAUDE}',current_date,18500,7000,9000)"
refuses "claiming 'customer paid less' without saying which customer" \
    "rider_cash_settlements_discount_names_order" \
    "INSERT INTO rider_cash_settlements (store_id,rider_user_id,business_date,expected_amount,handed_over_amount,counted_amount,gap_resolution)
      VALUES ('${S1}','${CLAUDE}',current_date,18500,7000,9000,'discount')"
SET1='eeee0000-0000-0000-0000-000000000001'
accepts "closing with the 2,500 carried over to next shift" \
    "INSERT INTO rider_cash_settlements (id,store_id,rider_user_id,business_date,expected_amount,
        handed_over_amount,counted_amount,gap_resolution,gap_note,closed_by)
      VALUES ('${SET1}','${S1}','${CLAUDE}',current_date,18500,7000,9000,'carry_over',
              'Matches what Claude reported short on the 12,500 order','${PATRICK}')"
equals  "the gap is computed, not entered" "2500.00" \
    "SELECT gap_amount::text FROM rider_cash_settlements WHERE id='${SET1}'"
refuses "a second settlement for the same rider on the same day" "rider_cash_settlements_one_per_day" \
    "INSERT INTO rider_cash_settlements (store_id,rider_user_id,business_date,expected_amount,handed_over_amount,counted_amount)
      VALUES ('${S1}','${CLAUDE}',current_date,0,0,0)"
equals  "it shows up as outstanding" "1" \
    "SELECT count(*) FROM rider_cash_settlements
      WHERE store_id='${S1}' AND gap_resolution='carry_over' AND carried_over_settled_at IS NULL"
accepts "marking the carried-over amount received later" \
    "UPDATE rider_cash_settlements SET carried_over_settled_at=now(), carried_over_settled_by='${PATRICK}'
      WHERE id='${SET1}'"
equals  "so it is no longer outstanding" "0" \
    "SELECT count(*) FROM rider_cash_settlements
      WHERE store_id='${S1}' AND gap_resolution='carry_over' AND carried_over_settled_at IS NULL"

step "A closed day is a signed record"
refuses "changing what was counted" "figures on a closed day cannot be changed" \
    "UPDATE rider_cash_settlements SET counted_amount=18500 WHERE id='${SET1}'"
refuses "changing how the gap was resolved" "figures on a closed day cannot be changed" \
    "UPDATE rider_cash_settlements SET gap_resolution='write_off' WHERE id='${SET1}'"
refuses "deleting it" "closed day cannot be deleted" \
    "DELETE FROM rider_cash_settlements WHERE id='${SET1}'"

step "A day that balances, and a day with too much"
accepts "Eric's day, nothing owed" \
    "INSERT INTO rider_cash_settlements (store_id,rider_user_id,business_date,expected_amount,
        handed_over_amount,counted_amount,closed_by)
      VALUES ('${S1}','${ERIC}',current_date,0,0,0,'${PATRICK}')"
refuses "a balanced day claiming a resolution it does not need" "rider_cash_settlements_shortfall_resolved" \
    "INSERT INTO rider_cash_settlements (store_id,rider_user_id,business_date,expected_amount,
        handed_over_amount,counted_amount,gap_resolution)
      VALUES ('${S1}','${ERIC}',current_date - 1,0,0,0,'write_off')"
accepts "handing in MORE than expected needs no resolution — it needs a look" \
    "INSERT INTO rider_cash_settlements (store_id,rider_user_id,business_date,expected_amount,
        handed_over_amount,counted_amount,closed_by)
      VALUES ('${S1}','${ERIC}',current_date - 2,1000,0,1500,'${PATRICK}')"
equals  "recorded as an overage" "-500.00" \
    "SELECT gap_amount::text FROM rider_cash_settlements WHERE rider_user_id='${ERIC}' AND business_date=current_date - 2"
refuses "marking a non-carried-over day as received" "rider_cash_settlements_carry_over_only" \
    "UPDATE rider_cash_settlements SET carried_over_settled_at=now()
      WHERE rider_user_id='${ERIC}' AND business_date=current_date"

step "Cash still never reaches the platform wallet"
equals "no ledger entry was written by any of this" "0" "SELECT count(*) FROM wallet_ledger"
equals "and the wallets are untouched" "0.00|0.00" \
    "SELECT pending_balance || '|' || available_balance FROM wallets WHERE store_id='${S1}'"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
