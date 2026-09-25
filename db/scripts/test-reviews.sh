#!/usr/bin/env bash
#
# Reviews acceptance tests — milestone 9, fourth part.
#
# Two properties carry this suite, and both are promises the boards print in words:
#
#   * "You can't edit or remove them." A merchant may reply and may report, and
#     that is all. Tested against the table, not against an endpoint.
#   * "Ordered here." A review names the order line it is about, so a review of
#     something nobody bought cannot be written in the first place.
#
# The third is the rule two screens share: no average below three reviews.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_reviews_test"
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

printf '\nReviews acceptance tests\n'
info "database  : ${TEST_DB}"

step "Building the schema, one store, four customers and five collected orders"
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
ALINE='aaaa0000-0000-0000-0000-000000000001'   # owner at Nyama
OTHER='aaaa0000-0000-0000-0000-000000000002'   # owner at the OTHER store
VENDLY='aaaa0000-0000-0000-0000-000000000003'  # Vendlyfy
CHICKEN='cccc0000-0000-0000-0000-000000000001'
BURGER='cccc0000-0000-0000-0000-000000000002'
JUICE='cccc0000-0000-0000-0000-000000000003'   # never ordered, never reviewed
VCHICKEN='dddd0000-0000-0000-0000-000000000001'
VBURGER='dddd0000-0000-0000-0000-000000000002'
VJUICE='dddd0000-0000-0000-0000-000000000003'
VTEE='dddd0000-0000-0000-0000-000000000004'
FOOD="$(q "SELECT id FROM industry_templates WHERE key='food'")"
FASHION="$(q "SELECT id FROM industry_templates WHERE key='fashion'")"

accepts "the fixtures" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version) VALUES
       ('${S1}','nyama','Nyama & Co.','RW','RWF','active','${FOOD}',1),
       ('${S2}','inzu','Inzu Threads','RW','RWF','active','${FASHION}',1);
     INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('${ALINE}','platform','aline@example.com','h','Aline Uwase'),
       ('${OTHER}','platform','olivier@example.com','h','Olivier Nzeyimana'),
       ('${VENDLY}','platform','team@vendlyfy.com','h','Vendlyfy Support');
     INSERT INTO store_members (user_id,store_id,role) VALUES
       ('${ALINE}','${S1}','owner'), ('${OTHER}','${S2}','owner');
     INSERT INTO platform_members (user_id,role) VALUES ('${VENDLY}','super_admin');
     INSERT INTO users (id,scope,store_id,email,password_hash,name) VALUES
       ('bbbb0000-0000-0000-0000-000000000001','store','${S1}','sandrine@example.com','h','Sandrine Keza'),
       ('bbbb0000-0000-0000-0000-000000000002','store','${S1}','kevin@example.com','h','Kevin Mugabo'),
       ('bbbb0000-0000-0000-0000-000000000003','store','${S1}','pacifique@example.com','h','Pacifique Irakoze'),
       ('bbbb0000-0000-0000-0000-000000000004','store','${S1}','grace@example.com','h','Grace Ingabire');
     INSERT INTO products (id,store_id,name,base_price,track_stock,status) VALUES
       ('${CHICKEN}','${S1}','Grilled chicken',8000,false,'active'),
       ('${BURGER}','${S1}','Chicken burger',3500,false,'active'),
       ('${JUICE}','${S1}','Mango juice',1500,false,'active'),
       ('cccc0000-0000-0000-0000-000000000004','${S2}','Linen tee',18000,false,'active');
     INSERT INTO product_variants (id,product_id,store_id,sku,is_default) VALUES
       ('${VCHICKEN}','${CHICKEN}','${S1}','CHK',true),
       ('${VBURGER}','${BURGER}','${S1}','BUR',true),
       ('${VJUICE}','${JUICE}','${S1}','JUI',true),
       ('${VTEE}','cccc0000-0000-0000-0000-000000000004','${S2}','TEE',true)"

SAND='bbbb0000-0000-0000-0000-000000000001'
KEV='bbbb0000-0000-0000-0000-000000000002'
PAC='bbbb0000-0000-0000-0000-000000000003'
GRACE='bbbb0000-0000-0000-0000-000000000004'
accepts "five pickup orders — four collected, one still being cooked" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        fulfilment_type,payment_method,currency,subtotal_amount) VALUES
       ('eeee0000-0000-0000-0000-000000000001','${S1}',next_order_number('${S1}'),'trk_review_00001','idem_review_000001','${SAND}','pickup','mtn_momo','RWF',8000),
       ('eeee0000-0000-0000-0000-000000000002','${S1}',next_order_number('${S1}'),'trk_review_00002','idem_review_000002','${KEV}','pickup','mtn_momo','RWF',8000),
       ('eeee0000-0000-0000-0000-000000000003','${S1}',next_order_number('${S1}'),'trk_review_00003','idem_review_000003','${PAC}','pickup','mtn_momo','RWF',11500),
       ('eeee0000-0000-0000-0000-000000000004','${S1}',next_order_number('${S1}'),'trk_review_00004','idem_review_000004','${GRACE}','pickup','mtn_momo','RWF',8000),
       ('eeee0000-0000-0000-0000-000000000005','${S1}',next_order_number('${S1}'),'trk_review_00005','idem_review_000005','${SAND}','pickup','mtn_momo','RWF',3500);
     INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        fulfilment_type,payment_method,currency,subtotal_amount) VALUES
       ('eeee0000-0000-0000-0000-00000000000a','${S1}',next_order_number('${S1}'),'trk_review_0000a','idem_review_00000a','A Guest','078 000 0001','pickup','mtn_momo','RWF',8000);
     INSERT INTO order_items (id,order_id,store_id,variant_id,product_name,unit_price_amount,quantity) VALUES
       ('1111aaaa-0000-0000-0000-000000000001','eeee0000-0000-0000-0000-000000000001','${S1}','${VCHICKEN}','Grilled chicken',8000,1),
       ('1111aaaa-0000-0000-0000-000000000002','eeee0000-0000-0000-0000-000000000002','${S1}','${VCHICKEN}','Grilled chicken',8000,1),
       ('1111aaaa-0000-0000-0000-000000000003','eeee0000-0000-0000-0000-000000000003','${S1}','${VCHICKEN}','Grilled chicken',8000,1),
       ('1111aaaa-0000-0000-0000-000000000013','eeee0000-0000-0000-0000-000000000003','${S1}','${VBURGER}','Chicken burger',3500,1),
       ('1111aaaa-0000-0000-0000-000000000004','eeee0000-0000-0000-0000-000000000004','${S1}','${VCHICKEN}','Grilled chicken',8000,1),
       ('1111aaaa-0000-0000-0000-000000000005','eeee0000-0000-0000-0000-000000000005','${S1}','${VBURGER}','Chicken burger',3500,1),
       ('1111aaaa-0000-0000-0000-00000000000a','eeee0000-0000-0000-0000-00000000000a','${S1}','${VCHICKEN}','Grilled chicken',8000,1)"
accepts "four of them are walked through to collected" \
    "UPDATE orders SET status='approved'  WHERE store_id='${S1}' AND status='pending' AND id <> 'eeee0000-0000-0000-0000-000000000005';
     UPDATE orders SET status='preparing' WHERE store_id='${S1}' AND status='approved';
     UPDATE orders SET status='ready'     WHERE store_id='${S1}' AND status='preparing';
     UPDATE orders SET status='collected' WHERE store_id='${S1}' AND status='ready'"
equals  "one order is still pending, five are collected" "1|5" \
    "SELECT count(*) FILTER (WHERE status='pending') || '|' || count(*) FILTER (WHERE status='collected')
       FROM orders WHERE store_id='${S1}'"

# =============================================================================
step "A review goes live straight away, and knows what it is about"
# =============================================================================
RV1="$(q "SELECT post_review('1111aaaa-0000-0000-0000-000000000001','${SAND}',5,'Juicy and the pili-pili butter is perfect.')")"
equals "it is visible the moment it exists" "" \
    "SELECT coalesce(hidden_at::text,'') FROM reviews WHERE id='${RV1}'"
equals "the product came from the line, not from the caller" "${CHICKEN}|${S1}" \
    "SELECT product_id || '|' || store_id FROM reviews WHERE id='${RV1}'"
equals "with the rating and the words as written" "5|Juicy and the pili-pili butter is perfect." \
    "SELECT rating || '|' || body FROM reviews WHERE id='${RV1}'"
equals "reviewing the same line twice hands back the first review" "${RV1}" \
    "SELECT post_review('1111aaaa-0000-0000-0000-000000000001','${SAND}',1,'Changed my mind')"
equals "so there is one review of that line" "1" \
    "SELECT count(*) FROM reviews WHERE order_item_id='1111aaaa-0000-0000-0000-000000000001'"
accepts "a rating with no words is a review" \
    "SELECT post_review('1111aaaa-0000-0000-0000-000000000004','${GRACE}',4)"
equals  "and it is stored as no comment, not as an empty one" "" \
    "SELECT coalesce(body,'') FROM reviews WHERE order_item_id='1111aaaa-0000-0000-0000-000000000004'"
accepts "a blank comment is the same as none" \
    "SELECT post_review('1111aaaa-0000-0000-0000-000000000013','${PAC}',3,'    ')"
equals  "stored as NULL" "t" \
    "SELECT body IS NULL FROM reviews WHERE order_item_id='1111aaaa-0000-0000-0000-000000000013'"
refuses "a blank comment written straight into the table" "body_not_blank" \
    "INSERT INTO reviews (store_id,order_id,order_item_id,customer_user_id,rating,body)
      VALUES ('${S1}','eeee0000-0000-0000-0000-000000000002','1111aaaa-0000-0000-0000-000000000002','${KEV}',4,'  ')"
refuses "six stars" "rating_range" \
    "SELECT post_review('1111aaaa-0000-0000-0000-000000000002','${KEV}',6,'Superb')"
refuses "no stars at all" "rating_range" \
    "SELECT post_review('1111aaaa-0000-0000-0000-000000000002','${KEV}',0,'Awful')"

# =============================================================================
step "\"Ordered here\" is a key, not a badge"
# =============================================================================
refuses "reviewing somebody else's purchase" "did not place order" \
    "SELECT post_review('1111aaaa-0000-0000-0000-000000000002','${SAND}',1,'Not my order')"
refuses "reviewing a line that is not on the order it names" "is not on order" \
    "INSERT INTO reviews (store_id,order_id,order_item_id,customer_user_id,rating)
      VALUES ('${S1}','eeee0000-0000-0000-0000-000000000001','1111aaaa-0000-0000-0000-000000000002','${SAND}',5)"
refuses "reviewing something still being cooked" "there is nothing to review yet" \
    "SELECT post_review('1111aaaa-0000-0000-0000-000000000005','${SAND}',5,'Cannot wait')"
refuses "a guest reviewing, with no account behind them" "did not place order" \
    "SELECT post_review('1111aaaa-0000-0000-0000-00000000000a','${SAND}',5,'I was a guest')"
refuses "a review with no customer at all" "customer_user_id" \
    "INSERT INTO reviews (store_id,order_id,order_item_id,rating)
      VALUES ('${S1}','eeee0000-0000-0000-0000-00000000000a','1111aaaa-0000-0000-0000-00000000000a',5)"

# =============================================================================
step "The merchant cannot edit or remove a review"
# =============================================================================
refuses "rewriting what the customer said" "cannot be edited" \
    "UPDATE reviews SET body='Actually it was great' WHERE id='${RV1}'"
refuses "changing the stars" "cannot be edited" \
    "UPDATE reviews SET rating=1 WHERE id='${RV1}'"
refuses "moving it to another product" "cannot be edited" \
    "UPDATE reviews SET product_id='${BURGER}' WHERE id='${RV1}'"
refuses "deleting it" "cannot be deleted" "DELETE FROM reviews WHERE id='${RV1}'"
refuses "backdating it" "cannot be edited" \
    "UPDATE reviews SET created_at=now() - interval '1 year' WHERE id='${RV1}'"

# =============================================================================
step "The reply, which is the one thing the merchant may write"
# =============================================================================
RV2="$(q "SELECT post_review('1111aaaa-0000-0000-0000-000000000003','${PAC}',2,'Tasty but arrived cold.')")"
accepts "the store replies" \
    "SELECT reply_to_review('${RV2}','${ALINE}','Sorry, a rider was delayed that evening.')"
equals  "shown under the review, by that store" "Sorry, a rider was delayed that evening.|${S1}" \
    "SELECT body || '|' || store_id FROM review_replies WHERE review_id='${RV2}'"
accepts "Edit reply is the same call again" \
    "SELECT reply_to_review('${RV2}','${ALINE}','Sorry about that — message us for a free drink next time.')"
equals  "there is still exactly one reply" "1|Sorry about that — message us for a free drink next time." \
    "SELECT count(*) || '|' || min(body) FROM review_replies WHERE review_id='${RV2}'"
refuses "an empty reply" "says nothing" "SELECT reply_to_review('${RV2}','${ALINE}','   ')"
refuses "a reply written by another store's staff" "author_id\|review_replies" \
    "SELECT reply_to_review('${RV2}','${OTHER}','Let me answer that for you')"
refuses "a second reply row written by hand" "duplicate key\|review_replies_pkey" \
    "INSERT INTO review_replies (review_id,store_id,body,author_id)
      VALUES ('${RV2}','${S1}','And another thing','${ALINE}')"
refuses "a reply on a review that does not exist" "review_replies_review_id" \
    "INSERT INTO review_replies (review_id,store_id,body) VALUES ('${S1}','${S1}','Ghost reply')"

# =============================================================================
step "Reporting one, which changes nothing until Vendlyfy decides"
# =============================================================================
RV3="$(q "SELECT post_review('1111aaaa-0000-0000-0000-000000000002','${KEV}',1,'Worst place ever, call 078 000 22 to complain')")"
RP1="$(q "SELECT report_review('${RV3}','${ALINE}','personal_info','Phone number in the text.')")"
equals "the report is open" "open|personal_info|${S1}" \
    "SELECT status || '|' || reason_code || '|' || store_id FROM review_reports WHERE id='${RP1}'"
equals "AND THE REVIEW IS STILL VISIBLE" "" \
    "SELECT coalesce(hidden_at::text,'') FROM reviews WHERE id='${RV3}'"
equals "reporting it again hands back the same report" "${RP1}" \
    "SELECT report_review('${RV3}','${ALINE}','spam')"
equals "so there is one open report" "1" \
    "SELECT count(*) FROM review_reports WHERE review_id='${RV3}'"
refuses "a reason the board does not offer" "reason_values" \
    "SELECT report_review('${RV2}','${ALINE}','i_disagree')"
refuses "a second open report written by hand" "one_open_per_review" \
    "INSERT INTO review_reports (review_id,store_id,reason_code) VALUES ('${RV3}','${S1}','spam')"
refuses "a decided report with no reason on the record" "decision_has_reason" \
    "INSERT INTO review_reports (review_id,store_id,reason_code,status,decided_by,decided_at)
      VALUES ('${RV2}','${S1}','spam','upheld','${VENDLY}',now())"
refuses "a decision with nobody behind it" "decision_complete\|decision_agrees" \
    "INSERT INTO review_reports (review_id,store_id,reason_code,status,decided_at,decision_note)
      VALUES ('${RV2}','${S1}','spam','dismissed',now(),'Fine')"

# =============================================================================
step "Only Vendlyfy takes a review down, and only through a decision"
# =============================================================================
refuses "the store hiding a review it does not like" "hidden_by" \
    "UPDATE reviews SET hidden_at=now(), hidden_by='${ALINE}', hidden_reason='I disagree' WHERE id='${RV3}'"
refuses "Vendlyfy hiding one with no upheld report behind it" "no upheld report behind it" \
    "UPDATE reviews SET hidden_at=now(), hidden_by='${VENDLY}', hidden_reason='Because' WHERE id='${RV1}'"
refuses "half a hiding" "hidden_complete" \
    "UPDATE reviews SET hidden_at=now() WHERE id='${RV1}'"
equals "upholding the report" "t" \
    "SELECT moderate_review('${RP1}','${VENDLY}','uphold','Contains a phone number.')"
equals "the review is hidden, by Vendlyfy, with the reason recorded" "true|${VENDLY}|true" \
    "SELECT (hidden_at IS NOT NULL) || '|' || hidden_by || '|' || (hidden_reason LIKE 'personal_info:%')
       FROM reviews WHERE id='${RV3}'"
equals "the report is upheld" "upheld" "SELECT status FROM review_reports WHERE id='${RP1}'"
equals "deciding it twice does nothing" "f" \
    "SELECT moderate_review('${RP1}','${VENDLY}','uphold','Again')"
refuses "an outcome that is neither" "upheld or dismissed" \
    "SELECT moderate_review('${RP1}','${VENDLY}','ignore','Whatever')"
refuses "putting a hidden review back by hand, leaving the report upheld" "still visible" \
    "UPDATE reviews SET hidden_at=NULL, hidden_by=NULL, hidden_reason=NULL WHERE id='${RV3}'"
RP2="$(q "SELECT report_review('${RV2}','${ALINE}','not_a_customer','They never came in.')")"
equals "dismissing a report" "t" \
    "SELECT moderate_review('${RP2}','${VENDLY}','dismiss','They have an order for it.')"
equals "leaves the review exactly where it was" "dismissed|" \
    "SELECT (SELECT status FROM review_reports WHERE id='${RP2}') || '|' ||
            (SELECT coalesce(hidden_at::text,'') FROM reviews WHERE id='${RV2}')"
accepts "a new report with new information is allowed once the first is decided" \
    "SELECT report_review('${RV2}','${ALINE}','abusive','New information.')"

# =============================================================================
step "No average below three reviews — one rule, one place"
# =============================================================================
equals "the burger has one review, so no average is shown" "1|" \
    "SELECT review_count || '|' || coalesce(average_rating::text,'')
       FROM product_rating_summary WHERE product_id='${BURGER}'"
accepts "a second review of the burger" \
    "UPDATE orders SET status='approved' WHERE id='eeee0000-0000-0000-0000-000000000005';
     UPDATE orders SET status='preparing' WHERE id='eeee0000-0000-0000-0000-000000000005';
     UPDATE orders SET status='ready' WHERE id='eeee0000-0000-0000-0000-000000000005';
     UPDATE orders SET status='collected' WHERE id='eeee0000-0000-0000-0000-000000000005';
     SELECT post_review('1111aaaa-0000-0000-0000-000000000005','${SAND}',5,'My go-to Friday order.')"
equals  "two is still not enough for an average" "2|" \
    "SELECT review_count || '|' || coalesce(average_rating::text,'')
       FROM product_rating_summary WHERE product_id='${BURGER}'"
accepts "a third, from a third customer" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('eeee0000-0000-0000-0000-000000000006','${S1}',next_order_number('${S1}'),'trk_review_00006','idem_review_000006','${KEV}','pickup','mtn_momo','RWF',3500);
     INSERT INTO order_items (id,order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
      VALUES ('1111aaaa-0000-0000-0000-000000000006','eeee0000-0000-0000-0000-000000000006','${S1}','${VBURGER}','Chicken burger',3500,1);
     UPDATE orders SET status='approved'  WHERE id='eeee0000-0000-0000-0000-000000000006';
     UPDATE orders SET status='preparing' WHERE id='eeee0000-0000-0000-0000-000000000006';
     UPDATE orders SET status='ready'     WHERE id='eeee0000-0000-0000-0000-000000000006';
     UPDATE orders SET status='collected' WHERE id='eeee0000-0000-0000-0000-000000000006';
     SELECT post_review('1111aaaa-0000-0000-0000-000000000006','${KEV}',4,'Good.')"
equals  "and NOW there is an average, of the three" "3|4.0" \
    "SELECT review_count || '|' || average_rating FROM product_rating_summary WHERE product_id='${BURGER}'"
# The chicken has four reviews — 5, 4, 2 and a hidden 1. The average of the three
# visible ones is 3.7; over all four it would be 3.0.
equals "a hidden review counts for nothing, in the count or the average" "3|3.7" \
    "SELECT review_count || '|' || coalesce(average_rating::text,'')
       FROM product_rating_summary WHERE product_id='${CHICKEN}'"
equals "which is a different number from the one the hidden review would give" "4|3.0" \
    "SELECT count(*) || '|' || round(avg(rating),1)::text FROM reviews WHERE product_id='${CHICKEN}'"
equals "the star distribution adds up to the count" "0" \
    "SELECT count(*) FROM product_rating_summary
      WHERE review_count <> five_star + four_star + three_star + two_star + one_star"
equals "a product nobody has reviewed still appears, with nothing" "0||" \
    "SELECT review_count || '|' || coalesce(average_rating::text,'') || '|' || coalesce(latest_review_at::text,'')
       FROM product_rating_summary WHERE product_id='${JUICE}'"
equals "the 1-2 star count the merchant's KPI reads" "1" \
    "SELECT sum(low_rated) FROM product_rating_summary WHERE store_id='${S1}'"

# =============================================================================
step "Ten customers posting the same review at once"
# =============================================================================
accepts "a fresh line to review" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('eeee0000-0000-0000-0000-00000000000b','${S1}',next_order_number('${S1}'),'trk_review_0000b','idem_review_00000b','${GRACE}','pickup','mtn_momo','RWF',1500);
     INSERT INTO order_items (id,order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
      VALUES ('1111aaaa-0000-0000-0000-00000000000b','eeee0000-0000-0000-0000-00000000000b','${S1}','${VJUICE}','Mango juice',1500,1);
     UPDATE orders SET status='approved'  WHERE id='eeee0000-0000-0000-0000-00000000000b';
     UPDATE orders SET status='preparing' WHERE id='eeee0000-0000-0000-0000-00000000000b';
     UPDATE orders SET status='ready'     WHERE id='eeee0000-0000-0000-0000-00000000000b';
     UPDATE orders SET status='collected' WHERE id='eeee0000-0000-0000-0000-00000000000b'"
parallel_sql 10 "SELECT post_review('1111aaaa-0000-0000-0000-00000000000b'::uuid,'${GRACE}'::uuid,4,'Cold and sweet.')" "$SCRATCH/post.txt"
WROTE="$(q "SELECT count(*) FROM reviews WHERE order_item_id='1111aaaa-0000-0000-0000-00000000000b'")"
DISTINCT="$(sort -u "$SCRATCH/post.txt" | grep -c '^[0-9a-f]' || echo 0)"
if [ "$WROTE" = "1" ] && [ "$DISTINCT" = "1" ]; then
    pass "one review, and all ten callers were handed it"
else
    LAST="reviews: $WROTE   distinct ids: $DISTINCT"$'\n'"$(head -4 "$SCRATCH/post.txt")"
    flunk "the same purchase was reviewed more than once"
fi

step "Ten moderators deciding one report at once"
RV4="$(q "SELECT id FROM reviews WHERE order_item_id='1111aaaa-0000-0000-0000-00000000000b'")"
RP3="$(q "SELECT report_review('${RV4}','${ALINE}','spam','Bot.')")"
parallel_sql 10 "SELECT moderate_review('${RP3}'::uuid,'${VENDLY}'::uuid,'uphold','Spam.')" "$SCRATCH/mod.txt"
WON="$(grep -c '^t$' "$SCRATCH/mod.txt" 2>/dev/null || echo 0)"
if [ "$WON" = "1" ]; then
    pass "exactly one decision won"
else
    LAST="decisions: $WON"$'\n'"$(head -4 "$SCRATCH/mod.txt")"
    flunk "one report was decided more than once"
fi
equals "and the review is hidden once, with one reason" "true|1" \
    "SELECT (hidden_at IS NOT NULL) || '|' ||
            (SELECT count(*) FROM review_reports WHERE review_id='${RV4}' AND status='upheld')
       FROM reviews WHERE id='${RV4}'"

# =============================================================================
step "The invariants, over everything this suite wrote"
# =============================================================================
equals "every review is of a product on the line it names" "0" \
    "SELECT count(*) FROM reviews r
       JOIN order_items i ON i.id = r.order_item_id
       JOIN product_variants v ON v.id = i.variant_id
      WHERE v.product_id <> r.product_id"
equals "every review is by the customer on its order" "0" \
    "SELECT count(*) FROM reviews r JOIN orders o ON o.id = r.order_id
      WHERE o.customer_user_id IS DISTINCT FROM r.customer_user_id"
equals "every review, reply and report belongs to one store throughout" "0" \
    "SELECT count(*) FROM reviews r
      WHERE EXISTS (SELECT 1 FROM review_replies p WHERE p.review_id=r.id AND p.store_id<>r.store_id)
         OR EXISTS (SELECT 1 FROM review_reports x WHERE x.review_id=r.id AND x.store_id<>r.store_id)"
equals "a review is hidden exactly when a report against it was upheld" "0" \
    "SELECT count(*) FROM reviews r
      WHERE (r.hidden_at IS NOT NULL) <>
            EXISTS (SELECT 1 FROM review_reports x WHERE x.review_id=r.id AND x.status='upheld')"
equals "no average is published below three visible reviews" "0" \
    "SELECT count(*) FROM product_rating_summary WHERE average_rating IS NOT NULL AND review_count < 3"
equals "every new table with updated_at has the trigger that maintains it" "" \
    "SELECT string_agg(c.table_name, ', ') FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.column_name='updated_at'
        AND NOT EXISTS (SELECT 1 FROM information_schema.triggers t
                         WHERE t.event_object_table=c.table_name AND t.action_statement LIKE '%set_updated_at%')"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
