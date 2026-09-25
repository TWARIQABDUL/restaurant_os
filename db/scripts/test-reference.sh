#!/usr/bin/env bash
#
# Reference-data acceptance tests — milestone 9, first part.
#
# Mostly asserts the SHIPPED data against the admin boards, because a fresh
# database has to be able to onboard a merchant: if the migration and
# AdminCurrencies, AdminPayments or AdminPlans disagree, that is the failure worth
# catching. The rest proves the new guards — a store cannot open in a country the
# platform has not launched, and an order cannot name a provider that will refuse it.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_reference_test"
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

printf '\nReference-data acceptance tests\n'
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

# =============================================================================
step "Currencies, as AdminCurrencies writes them"
# =============================================================================
equals "six currencies ship" "6" "SELECT count(*) FROM currencies"
equals "four are enabled — RWF, UGX, KES, USD" "KES,RWF,UGX,USD" \
    "SELECT string_agg(code, ',' ORDER BY code) FROM currencies WHERE is_enabled"
equals "Tanzania's and Burundi's are modelled but off" "BIF,TZS" \
    "SELECT string_agg(code, ',' ORDER BY code) FROM currencies WHERE NOT is_enabled"
equals "RWF: symbol after, no decimals, comma, rounds to 50" "RWF|after|0|,|50.00" \
    "SELECT concat_ws('|', symbol, symbol_position, decimals, thousands_separator, cash_rounding) FROM currencies WHERE code='RWF'"
equals "USD: symbol before, two decimals, no cash rounding" "\$|before|2|0.00" \
    "SELECT concat_ws('|', symbol, symbol_position, decimals, cash_rounding) FROM currencies WHERE code='USD'"
equals "BIF uses a space as its separator" " " \
    "SELECT thousands_separator FROM currencies WHERE code='BIF'"
equals "UGX rounds cash to 500, KES to 10" "500.00|10.00" \
    "SELECT (SELECT cash_rounding FROM currencies WHERE code='UGX') || '|' ||
            (SELECT cash_rounding FROM currencies WHERE code='KES')"
equals "exactly one default, and it is RWF" "RWF" "SELECT code FROM currencies WHERE is_default"
refuses "a second default currency" "currencies_one_default" \
    "UPDATE currencies SET is_default=true WHERE code='USD'"
refuses "disabling the default" "currencies_default_is_enabled" \
    "UPDATE currencies SET is_enabled=false WHERE code='RWF'"
refuses "three decimal places" "currencies_decimals_values" \
    "UPDATE currencies SET decimals=3 WHERE code='USD'"
refuses "cash rounding to 25" "currencies_cash_rounding_values" \
    "UPDATE currencies SET cash_rounding=25 WHERE code='RWF'"
refuses "a rate with no timestamp — it could never be aged out" "currencies_rate_has_timestamp" \
    "UPDATE currencies SET usd_rate=1300 WHERE code='RWF'"
accepts "a rate with the time it was taken" \
    "UPDATE currencies SET usd_rate=1300, rate_updated_at=now() WHERE code='RWF'"

step "Countries"
equals "five countries, three open" "5|3" \
    "SELECT count(*) || '|' || count(*) FILTER (WHERE is_enabled) FROM countries"
equals "each one's default currency" "BI:BIF,KE:KES,RW:RWF,TZ:TZS,UG:UGX" \
    "SELECT string_agg(code || ':' || default_currency_code, ',' ORDER BY code) FROM countries"

# =============================================================================
step "Payment methods"
# =============================================================================
equals "four methods, one of them offline" "4|1" \
    "SELECT count(*) || '|' || count(*) FILTER (WHERE kind='offline') FROM payment_methods"
equals "cash carries no provider and no webhook — there is nothing to integrate" "t" \
    "SELECT provider IS NULL AND webhook_url IS NULL FROM payment_methods WHERE key='cash'"
equals "M-Pesa is still a draft" "draft" "SELECT status FROM payment_methods WHERE key='mpesa'"
equals "MTN covers Rwanda and Uganda" "RW,UG" \
    "SELECT string_agg(country_code, ',' ORDER BY country_code) FROM payment_method_countries WHERE payment_method_key='mtn_momo'"
equals "M-Pesa is Kenya only" "KE" \
    "SELECT string_agg(country_code, ',') FROM payment_method_countries WHERE payment_method_key='mpesa'"
equals "MTN's limits in RWF" "100.00|2000000.00" \
    "SELECT min_amount || '|' || max_amount FROM payment_method_currencies WHERE payment_method_key='mtn_momo' AND currency_code='RWF'"
equals "M-Pesa's limits in KES" "10.00|250000.00" \
    "SELECT min_amount || '|' || max_amount FROM payment_method_currencies WHERE payment_method_key='mpesa' AND currency_code='KES'"
refuses "an online method with no provider" "payment_methods_online_has_provider" \
    "INSERT INTO payment_methods (key,name,short_name,kind,customer_label,customer_hint)
      VALUES ('halfwired','Half wired','HW','online','Half wired','Approve somehow')"
refuses "an offline method with a webhook" "payment_methods_online_has_provider" \
    "INSERT INTO payment_methods (key,name,short_name,kind,customer_label,customer_hint,webhook_url)
      VALUES ('vouchers','Vouchers','VCH','offline','Voucher','Hand it over','https://x.invalid/h')"
refuses "a maximum below the minimum" "pmc_max_above_min" \
    "INSERT INTO payment_method_currencies (payment_method_key,currency_code,min_amount,max_amount)
      VALUES ('mtn_momo','KES',500,100)"

# =============================================================================
step "Plans"
# =============================================================================
equals "two plans, Starter is the default" "starter" "SELECT key FROM plans WHERE is_default"
equals "Starter allows three staff accounts, Growth is unlimited" "3|" \
    "SELECT (SELECT staff_account_limit FROM plans WHERE key='starter') || '|' ||
            coalesce((SELECT staff_account_limit::text FROM plans WHERE key='growth'),'')"
equals "no price is set — finance has not confirmed them" "2" \
    "SELECT count(*) FROM plans WHERE monthly_price IS NULL AND withdrawal_fee IS NULL"
equals "Starter includes delivery and the theme studio, nothing else" "delivery_and_riders,theme_studio" \
    "SELECT string_agg(feature_key, ',' ORDER BY feature_key) FROM plan_feature_grants WHERE plan_key='starter'"
equals "Growth includes all five" "5" \
    "SELECT count(*) FROM plan_feature_grants WHERE plan_key='growth'"
refuses "a price with no currency" "plans_price_has_currency" \
    "UPDATE plans SET monthly_price=20000 WHERE key='starter'"
accepts "a price with its currency" \
    "UPDATE plans SET monthly_price=20000, currency_code='RWF' WHERE key='starter'"
refuses "a fee above 100 per cent" "plans_fee_percent_sane" \
    "UPDATE plans SET payment_fee_percent=120 WHERE key='starter'"
refuses "a second default plan" "plans_one_default" \
    "UPDATE plans SET is_default=true WHERE key='growth'"

# =============================================================================
step "A store cannot open where the platform has not"
# =============================================================================
FOOD="$(q "SELECT id FROM industry_templates WHERE key='food'")"
accepts "a store in Rwanda, selling in RWF" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version)
      VALUES ('11111111-0000-0000-0000-000000000001','nyama','Nyama & Co.','RW','RWF','active','${FOOD}',1)"
equals  "on the Starter plan, without being asked" "starter" \
    "SELECT plan_key FROM stores WHERE slug='nyama'"
equals  "and with a wallet in its own currency" "RWF" \
    "SELECT currency FROM wallets WHERE store_id='11111111-0000-0000-0000-000000000001'"
refuses "a store in Tanzania, which has not launched" "not open in TZ" \
    "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('dar','Dar Shop','TZ','TZS')"
refuses "a store selling in a currency that is switched off" "currency TZS is not enabled" \
    "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('odd','Odd','RW','TZS')"
refuses "a country the platform has never heard of" "stores_country_fkey" \
    "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('zz','ZZ','ZZ','RWF')"
refuses "a plan that does not exist" "stores_plan_key_fkey" \
    "UPDATE stores SET plan_key='enterprise' WHERE slug='nyama'"

# =============================================================================
step "An order cannot name a provider that will refuse it"
# =============================================================================
ST='11111111-0000-0000-0000-000000000001'
accepts "something to sell" \
    "INSERT INTO products (id,store_id,name,base_price,status) VALUES
       ('aaaa0000-0000-0000-0000-000000000001','${ST}','Chicken burger',3500,'active');
     INSERT INTO product_variants (id,product_id,store_id,is_default) VALUES
       ('dddd0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001','${ST}',true)"

place() {   # place <tracking suffix> <method> <subtotal>
cat <<SQL
INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
    delivery_address,fulfilment_type,payment_method,currency,subtotal_amount)
  VALUES (gen_random_uuid(),'${ST}',next_order_number('${ST}'),'trk_ref_$1','idem_ref_order_$1',
          'Aimable K.','078 330 1180','KG 11 Ave','delivery','$2','RWF',$3);
INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
  SELECT id,'${ST}','dddd0000-0000-0000-0000-000000000001','Chicken burger',$3,1
    FROM orders WHERE tracking_code='trk_ref_$1';
SQL
}

accepts "MTN MoMo, which is live in Rwanda and charges RWF" "$(place aaaaaaaaaa mtn_momo 5000)"
accepts "cash, which needs no provider at all" "$(place bbbbbbbbbb cash 5000)"
refuses "M-Pesa, which is still a draft" "is draft, so it cannot take a new order" \
    "$(place cccccccccc mpesa 5000)"
accepts "making M-Pesa live" "UPDATE payment_methods SET status='live' WHERE key='mpesa'"
refuses "M-Pesa in Rwanda, where it is not offered" "mpesa is not available in RW" \
    "$(place dddddddddd mpesa 5000)"
refuses "below MTN's minimum" "takes between 100.00 and 2000000.00" \
    "$(place eeeeeeeeee mtn_momo 50)"
refuses "above MTN's maximum" "takes between 100.00 and 2000000.00" \
    "$(place ffffffffff mtn_momo 9000000)"
accepts "cash is exempt from provider limits — nobody is charging anything" \
    "$(place gggggggggg cash 9000000)"
accepts "pausing MTN" "UPDATE payment_methods SET status='paused' WHERE key='mtn_momo'"
refuses "a new order on a paused provider" "is paused, so it cannot take a new order" \
    "$(place hhhhhhhhhh mtn_momo 5000)"
equals  "but the order already placed with it still reads correctly" "1" \
    "SELECT count(*) FROM orders WHERE payment_method='mtn_momo'"
accepts "and they can still be advanced" \
    "UPDATE orders SET status='approved' WHERE payment_method='mtn_momo' AND status='pending'"

step "Money's references are closed"
equals "every store's currency and country are real rows" "0" \
    "SELECT count(*) FROM stores s
      WHERE NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code=s.selling_currency)
         OR NOT EXISTS (SELECT 1 FROM countries k WHERE k.code=s.country)"
equals "every order's currency and method are real rows" "0" \
    "SELECT count(*) FROM orders o
      WHERE NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code=o.currency)
         OR NOT EXISTS (SELECT 1 FROM payment_methods m WHERE m.key=o.payment_method)"
equals "every wallet's currency is a real row" "0" \
    "SELECT count(*) FROM wallets w
      WHERE NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code=w.currency)"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
