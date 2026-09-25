#!/usr/bin/env bash
#
# Complaints and disputes acceptance tests — milestone 9, third part.
#
# Three things here are worth more than the rest, and they are all places where a
# careless schema loses money or a conversation:
#
#   * the THREAD AND THE STATUS cannot disagree. Every complaint is a chain of
#     events, checked at commit: a status that moved without an event, an event
#     that starts where the last one did not end, and a complaint with no events
#     at all are all refused.
#   * a refund is 'approved' EXACTLY WHEN the money has left. The fifth state,
#     'queued', is decided-but-unpaid, it writes no ledger entry, and it holds the
#     store's payouts until it settles.
#   * one decision, once. Ten reviewers deciding one escalation must produce one
#     refund and one ledger entry.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_complaints_test"
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
parallel_sql() {   # parallel_sql <n> <sql> <outfile>
    seq 1 "$1" | xargs -P "$1" -I{} docker compose -f "$COMPOSE_FILE" exec -T \
        -e PGPASSWORD="$OWNER_PASSWORD" "$SERVICE" \
        psql -h 127.0.0.1 -U "$OWNER_ROLE" -d "$TEST_DB" -tAc "$2" > "$3" 2>&1 || true
}

# V012 made a payout require an approved identity check — "money you've earned is safe
# in your balance but can't be withdrawn until you're verified". These are the real
# calls rather than a hand-written approved row, because the deferred constraint
# refuses an approval whose documents are missing or unaccepted.
verify_store() {   # verify_store <label> <store_id> <owner_user_id> <platform_user_id>
    accepts "$1 passes its identity check, so it may be paid out" \
        "SELECT submit_kyc('$2','$3');
         SELECT attach_kyc_document((SELECT id FROM kyc_submissions WHERE store_id='$2' AND status='submitted'),'id_front','kyc/f.jpg','image/jpeg');
         SELECT attach_kyc_document((SELECT id FROM kyc_submissions WHERE store_id='$2' AND status='submitted'),'id_back','kyc/b.jpg','image/jpeg');
         SELECT attach_kyc_document((SELECT id FROM kyc_submissions WHERE store_id='$2' AND status='submitted'),'face_video','kyc/v.mp4','video/mp4');
         SELECT complete_kyc_checks((SELECT id FROM kyc_submissions WHERE store_id='$2' AND status='submitted'));
         SELECT decide_kyc((SELECT id FROM kyc_submissions WHERE store_id='$2' AND status='in_review'),'$4','approve','All checks passed')"
}

printf '\nComplaints and disputes acceptance tests\n'
info "database  : ${TEST_DB}"

step "Building the schema, two stores, their staff, Vendlyfy and two customers"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" -c "CREATE DATABASE ${TEST_DB}" >/dev/null
if DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" >/dev/null 2>&1; then
    pass "the migrations apply to an empty database"
else
    LAST="$(DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" 2>&1)"; flunk "migrations did not apply"
    printf '\n%s\n' "$PASSED passed, $FAILED failed."; exit 1
fi

S1='11111111-0000-0000-0000-000000000001'   # Nyama & Co.
S2='22222222-0000-0000-0000-000000000002'   # Inzu Threads
ALINE='aaaa0000-0000-0000-0000-000000000001'    # owner at Nyama
KEVIN='aaaa0000-0000-0000-0000-000000000002'    # manager at Nyama
OTHER='aaaa0000-0000-0000-0000-000000000003'    # owner at Inzu — staff of the WRONG store
VENDLY='aaaa0000-0000-0000-0000-000000000004'   # Vendlyfy, a platform member
NOTTEAM='aaaa0000-0000-0000-0000-000000000005'  # platform-scoped, but not on the team
SANDRINE='bbbb0000-0000-0000-0000-000000000001' # a customer of Nyama
PACIFIQUE='bbbb0000-0000-0000-0000-000000000002'
JEANPAUL='bbbb0000-0000-0000-0000-000000000003'
FOOD="$(q "SELECT id FROM industry_templates WHERE key='food'")"
FASHION="$(q "SELECT id FROM industry_templates WHERE key='fashion'")"

accepts "the fixtures" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version) VALUES
       ('${S1}','nyama','Nyama & Co.','RW','RWF','active','${FOOD}',1),
       ('${S2}','inzu','Inzu Threads','RW','RWF','active','${FASHION}',1);
     INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('${ALINE}','platform','aline@example.com','h','Aline Uwase'),
       ('${KEVIN}','platform','kevin@example.com','h','Kevin Nkusi'),
       ('${OTHER}','platform','olivier@example.com','h','Olivier Nzeyimana'),
       ('${VENDLY}','platform','team@vendlyfy.com','h','Vendlyfy Support'),
       ('${NOTTEAM}','platform','notteam@example.com','h','Not On The Team');
     INSERT INTO users (id,scope,store_id,email,password_hash,name) VALUES
       ('${SANDRINE}','store','${S1}','sandrine@example.com','h','Sandrine Keza'),
       ('${PACIFIQUE}','store','${S1}','pacifique@example.com','h','Pacifique Irakoze'),
       ('${JEANPAUL}','store','${S1}','jeanpaul@example.com','h','Jean-Paul Nshuti');
     INSERT INTO store_members (user_id,store_id,role) VALUES
       ('${ALINE}','${S1}','owner'), ('${KEVIN}','${S1}','manager'), ('${OTHER}','${S2}','owner');
     INSERT INTO platform_members (user_id,role) VALUES ('${VENDLY}','super_admin')"

verify_store "Nyama & Co." "${S1}" "${ALINE}" "${VENDLY}"
verify_store "Inzu Threads" "${S2}" "${OTHER}" "${VENDLY}"

# Four paid orders at Nyama, money in the wallet, two of them out of escrow.
O1='eeee0000-0000-0000-0000-000000000001'   # Sandrine, 15,500, released
O2='eeee0000-0000-0000-0000-000000000002'   # a guest, 12,500, released
O3='eeee0000-0000-0000-0000-000000000003'   # Jean-Paul, 6,000, released
O4='eeee0000-0000-0000-0000-000000000004'   # Pacifique, 9,000, still in escrow
O5='eeee0000-0000-0000-0000-000000000005'   # at the OTHER store
accepts "five orders, four of them paid" \
    "INSERT INTO products (id,store_id,name,base_price,track_stock,status) VALUES
       ('cccc0000-0000-0000-0000-000000000001','${S1}','Grilled chicken',6250,false,'active'),
       ('cccc0000-0000-0000-0000-000000000002','${S1}','Salad',3000,false,'active'),
       ('cccc0000-0000-0000-0000-000000000003','${S1}','Brochette platter',6000,false,'active'),
       ('cccc0000-0000-0000-0000-000000000004','${S1}','Wireless earbuds',9000,false,'active'),
       ('cccc0000-0000-0000-0000-000000000005','${S2}','Linen tee',18000,false,'active');
     INSERT INTO product_variants (id,product_id,store_id,sku,is_default) VALUES
       ('dddd0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000001','${S1}','CHK',true),
       ('dddd0000-0000-0000-0000-000000000002','cccc0000-0000-0000-0000-000000000002','${S1}','SAL',true),
       ('dddd0000-0000-0000-0000-000000000003','cccc0000-0000-0000-0000-000000000003','${S1}','BRO',true),
       ('dddd0000-0000-0000-0000-000000000004','cccc0000-0000-0000-0000-000000000004','${S1}','EAR',true),
       ('dddd0000-0000-0000-0000-000000000005','cccc0000-0000-0000-0000-000000000005','${S2}','TEE',true);
     INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount) VALUES
       ('${O1}','${S1}',next_order_number('${S1}'),'trk_complaint_0001','idem_complaint_00001','${SANDRINE}','KG 11 Ave','delivery','mtn_momo','RWF',15500),
       ('${O3}','${S1}',next_order_number('${S1}'),'trk_complaint_0003','idem_complaint_00003','${JEANPAUL}','KG 9 Ave','delivery','mtn_momo','RWF',6000),
       ('${O4}','${S1}',next_order_number('${S1}'),'trk_complaint_0004','idem_complaint_00004','${PACIFIQUE}','KG 7 Ave','delivery','mtn_momo','RWF',9000);
     INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount) VALUES
       ('${O2}','${S1}',next_order_number('${S1}'),'trk_complaint_0002','idem_complaint_00002','A Guest','078 000 0001','KG 5 Ave','delivery','mtn_momo','RWF',12500);
     INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount) VALUES
       ('${O5}','${S2}',next_order_number('${S2}'),'trk_complaint_0005','idem_complaint_00005','Another Guest','078 000 0002','KG 3 Ave','delivery','mtn_momo','RWF',18000);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity) VALUES
       ('${O1}','${S1}','dddd0000-0000-0000-0000-000000000001','Grilled chicken',6250,2),
       ('${O1}','${S1}','dddd0000-0000-0000-0000-000000000002','Salad',3000,1),
       ('${O2}','${S1}','dddd0000-0000-0000-0000-000000000001','Grilled chicken',6250,2),
       ('${O3}','${S1}','dddd0000-0000-0000-0000-000000000003','Brochette platter',6000,1),
       ('${O4}','${S1}','dddd0000-0000-0000-0000-000000000004','Wireless earbuds',9000,1),
       ('${O5}','${S2}','dddd0000-0000-0000-0000-000000000005','Linen tee',18000,1);
     INSERT INTO momo_transactions (store_id,order_id,direction,reference_id,phone,amount,currency) VALUES
       ('${S1}','${O1}','collection','ref_c_0001','078 543 6671',15500,'RWF'),
       ('${S1}','${O2}','collection','ref_c_0002','078 000 0001',12500,'RWF'),
       ('${S1}','${O3}','collection','ref_c_0003','078 118 0922',6000,'RWF'),
       ('${S1}','${O4}','collection','ref_c_0004','078 771 2290',9000,'RWF')"
accepts "the four collections succeed" \
    "SELECT record_momo_collection_success(id) FROM momo_transactions WHERE store_id='${S1}'"
equals  "all of it is in escrow" "43000.00|0.00" \
    "SELECT pending_balance || '|' || available_balance FROM wallets WHERE store_id='${S1}'"
accepts "three of them leave escrow, O4 stays in" \
    "UPDATE orders SET paid_at = now() - interval '2 hours' WHERE id IN ('${O1}','${O2}','${O3}');
     SELECT release_eligible_orders(60)"
equals  "so the pots split as expected" "9000.00|34000.00" \
    "SELECT pending_balance || '|' || available_balance FROM wallets WHERE store_id='${S1}'"

# =============================================================================
step "Filing a complaint, which only the customer on the order can do"
# =============================================================================
C1="$(q "SELECT file_complaint('${O1}','item_missing','The salad wasn''t in the bag. Everything else was fine.','${SANDRINE}')")"
equals "it is open, on that order, for that customer" "open|${O1}|${SANDRINE}|item_missing" \
    "SELECT status || '|' || order_id || '|' || customer_user_id || '|' || reason_code FROM complaints WHERE id='${C1}'"
equals "with the customer's own words as the first event" "1|filed|open|customer" \
    "SELECT sequence || '|' || event_type || '|' || to_status || '|' || actor_side
       FROM complaint_events WHERE complaint_id='${C1}'"
equals "and a reference number of its own" "t" \
    "SELECT reference_number >= 1 FROM complaints WHERE id='${C1}'"
equals "filing it again is filing it once" "${C1}" \
    "SELECT file_complaint('${O1}','arrived_late','Also it was late','${SANDRINE}')"
equals "so there is still one complaint on that order" "1" \
    "SELECT count(*) FROM complaints WHERE order_id='${O1}'"
refuses "a complaint with no words in it" "own words" \
    "SELECT file_complaint('${O1}','item_missing','   ','${SANDRINE}')"
refuses "a complaint filed by somebody else's customer" "did not place order" \
    "SELECT file_complaint('${O3}','wrong_item','Not mine to complain about','${SANDRINE}')"
refuses "a complaint about an order that does not exist" "does not exist" \
    "SELECT file_complaint('eeee0000-0000-0000-0000-0000000000ff','wrong_item','Ghost order','${SANDRINE}')"
refuses "a reason the platform does not have a word for" "complaints_reason_values" \
    "SELECT file_complaint('${O3}','it_was_ugly','Not one of the five','${JEANPAUL}')"
equals "a guest can complain, with no account behind it" "t" \
    "SELECT file_complaint('${O2}','arrived_late','Waited over an hour.') IS NOT NULL"
equals "and that complaint has no customer account" "" \
    "SELECT coalesce(customer_user_id::text,'') FROM complaints WHERE order_id='${O2}'"
equals "the complaint and refund reason lists are the SAME list" "t" \
    "WITH codes AS (
       SELECT conname, (regexp_matches(pg_get_constraintdef(oid), '''(\w+)''', 'g'))[1] AS code
         FROM pg_constraint WHERE conname IN ('complaints_reason_values','refunds_reason_values'))
     SELECT (SELECT array_agg(code ORDER BY code) FROM codes WHERE conname='complaints_reason_values')
          = (SELECT array_agg(code ORDER BY code) FROM codes WHERE conname='refunds_reason_values')"

# =============================================================================
step "The thread and the status cannot disagree"
# =============================================================================
refuses "a complaint written with no event behind it" "has no events" \
    "INSERT INTO complaints (store_id,order_id,reason_code,detail)
      VALUES ('${S1}','${O3}','wrong_item','Straight into the table')"
refuses "moving the status by hand, leaving the thread behind" "its last event ended at" \
    "UPDATE complaints SET status='resolved' WHERE id='${C1}'"
refuses "an event that starts where the last one did not end" "the event before it ended at" \
    "INSERT INTO complaint_events (complaint_id,store_id,event_type,from_status,to_status,actor_side,actor_id)
      VALUES ('${C1}','${S1}','note','resolved','resolved','store','${ALINE}')"
refuses "editing the thread" "append-only" \
    "UPDATE complaint_events SET note='something else' WHERE complaint_id='${C1}'"
refuses "deleting from the thread" "append-only" \
    "DELETE FROM complaint_events WHERE complaint_id='${C1}'"
refuses "deleting the complaint, which would take the thread with it" "append-only" \
    "DELETE FROM complaints WHERE id='${C1}'"
refuses "an event type that lands in the wrong state" "type_agrees_with_status" \
    "INSERT INTO complaint_events (complaint_id,store_id,event_type,from_status,to_status,actor_side,actor_id)
      VALUES ('${C1}','${S1}','resolved','open','open','store','${ALINE}')"
refuses "a note that moves the complaint" "note_does_not_move" \
    "INSERT INTO complaint_events (complaint_id,store_id,event_type,from_status,to_status,actor_side,actor_id)
      VALUES ('${C1}','${S1}','note','open','resolved','store','${ALINE}')"
refuses "a filing that is not the first thing that happened" "first_is_filed" \
    "INSERT INTO complaint_events (complaint_id,store_id,event_type,from_status,to_status,actor_side,actor_id)
      VALUES ('${C1}','${S1}','filed','open','open','customer','${SANDRINE}')"

# =============================================================================
step "Who a message in the thread can be from"
# =============================================================================
refuses "a customer posting as Vendlyfy" "actor" \
    "INSERT INTO complaint_events (complaint_id,store_id,event_type,from_status,to_status,actor_side,actor_id)
      VALUES ('${C1}','${S1}','note','open','open','platform','${SANDRINE}')"
refuses "a staff account posting as the customer" "actor" \
    "INSERT INTO complaint_events (complaint_id,store_id,event_type,from_status,to_status,actor_side,actor_id)
      VALUES ('${C1}','${S1}','note','open','open','customer','${ALINE}')"
refuses "an unsigned message from the store" "staff_are_named" \
    "INSERT INTO complaint_events (complaint_id,store_id,event_type,from_status,to_status,actor_side)
      VALUES ('${C1}','${S1}','note','open','open','store')"
refuses "the system acting as somebody" "the system acts on its own" \
    "INSERT INTO complaint_events (complaint_id,store_id,event_type,from_status,to_status,actor_side,actor_id)
      VALUES ('${C1}','${S1}','note','open','open','system','${ALINE}')"
refuses "a side nobody draws" "actor_side_values" \
    "INSERT INTO complaint_events (complaint_id,store_id,event_type,from_status,to_status,actor_side,actor_id)
      VALUES ('${C1}','${S1}','note','open','open','regulator','${ALINE}')"
accepts "a note from the store, which is allowed and moves nothing" \
    "INSERT INTO complaint_events (complaint_id,store_id,event_type,from_status,to_status,actor_side,actor_id,note)
      VALUES ('${C1}','${S1}','note','open','open','store','${KEVIN}','Called the rider to ask.')"
equals  "and it is second in the thread" "2" \
    "SELECT sequence FROM complaint_events WHERE complaint_id='${C1}' AND event_type='note'"
equals  "the scope it was filed under was derived, not passed" "platform" \
    "SELECT actor_scope FROM complaint_events WHERE complaint_id='${C1}' AND event_type='note'"

# =============================================================================
step "Resolving it, with a refund request that pays nothing yet"
# =============================================================================
refuses "resolving with nothing to tell the customer" "note the customer reads" \
    "SELECT resolve_complaint('${C1}','${ALINE}','  ')"
refuses "resolving as staff of a DIFFERENT store" "closed_by" \
    "SELECT resolve_complaint('${C1}','${OTHER}','We will sort it out')"
LEDGER_BEFORE="$(q "SELECT count(*) FROM wallet_ledger")"
R1="$(q "SELECT resolve_complaint('${C1}','${ALINE}','Sorry, we will send the salad now.',3000)")"
equals "the complaint is resolved, by Aline" "resolved|${ALINE}" \
    "SELECT status || '|' || closed_by FROM complaints WHERE id='${C1}'"
equals "the thread records the resolution and the request, in order" "resolved|refund_requested" \
    "SELECT string_agg(event_type,'|' ORDER BY sequence) FROM complaint_events
      WHERE complaint_id='${C1}' AND sequence > 2"
equals "the refund is a REQUEST, tied to the complaint, asked for by the merchant" "pending|3000.00|${C1}|merchant" \
    "SELECT status || '|' || amount || '|' || complaint_id || '|' || initiated_by FROM refunds WHERE id='${R1}'"
equals "nothing has been granted yet" "|" \
    "SELECT coalesce(approved_amount::text,'') || '|' || coalesce(settled_at::text,'') FROM refunds WHERE id='${R1}'"
equals "and not one ledger entry was written" "${LEDGER_BEFORE}" "SELECT count(*) FROM wallet_ledger"
refuses "resolving it twice" "cannot be resolved: it is resolved" \
    "SELECT resolve_complaint('${C1}','${ALINE}','Again')"
accepts "the merchant reopens it themselves" "SELECT reopen_complaint('${C1}','store','${ALINE}')"
equals  "the reopen counted, and it is open again" "open|1" \
    "SELECT status || '|' || reopened_count FROM complaints WHERE id='${C1}'"
refuses "a second refund request against the same complaint" "already has a refund awaiting" \
    "SELECT resolve_complaint('${C1}','${ALINE}','And another one',1000)"
equals  "which left it open, because nothing was committed" "open" \
    "SELECT status FROM complaints WHERE id='${C1}'"
accepts "resolving it again without a refund" \
    "SELECT resolve_complaint('${C1}','${KEVIN}','The salad went out with the next rider.')"

# =============================================================================
step "Vendlyfy decides the request, and may grant less than was asked"
# =============================================================================
refuses "a store's own owner deciding a refund on their own store" "decided_by\|is not with Vendlyfy" \
    "SELECT decide_escalated_complaint('${C1}','${ALINE}','refund','Mine now',3000)"
equals "approving 2,500 of the 3,000 asked" "t" "SELECT approve_refund('${R1}','${VENDLY}',2500)"
equals "the request still says what was asked, the grant says what was given" "3000.00|2500.00|approved" \
    "SELECT amount || '|' || approved_amount || '|' || status FROM refunds WHERE id='${R1}'"
equals "the money left, and it is marked as having left" "true|true" \
    "SELECT (settled_at IS NOT NULL) || '|' || (reviewed_by = '${VENDLY}') FROM refunds WHERE id='${R1}'"
equals "the order records the GRANTED amount, not the asked one" "2500.00" \
    "SELECT refunded_amount::text FROM orders WHERE id='${O1}'"
equals "one debit, out of available, where that order's money was" "1|available|-2500.00" \
    "SELECT count(*) || '|' || min(pot) || '|' || sum(amount)::text FROM wallet_ledger WHERE refund_id='${R1}'"
equals "available is down by exactly that" "31500.00" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${S1}'"
equals "deciding it twice moves nothing" "f" "SELECT approve_refund('${R1}','${VENDLY}',2500)"
equals "still one debit" "1" "SELECT count(*) FROM wallet_ledger WHERE refund_id='${R1}'"
refuses "granting more than the customer ever paid" "cannot exceed what the customer paid" \
    "INSERT INTO refunds (store_id,order_id,amount,reason_code) VALUES ('${S1}','${O1}',99999,'wrong_item')"
refuses "a granted amount on a refund nobody has decided" "approved_amount_agrees" \
    "INSERT INTO refunds (store_id,order_id,amount,reason_code,approved_amount)
      VALUES ('${S1}','${O1}',500,'wrong_item',500)"
refuses "an approved refund whose money never left" "settled_means_paid" \
    "INSERT INTO refunds (store_id,order_id,amount,reason_code,status,approved_amount,reviewed_at)
      VALUES ('${S1}','${O1}',500,'wrong_item','approved',500,now())"

# =============================================================================
step "Escalation, and a decision Vendlyfy makes with no request behind it"
# =============================================================================
C2="$(q "SELECT file_complaint('${O3}','wrong_item','I ordered a brochette platter and got a veggie wrap.','${JEANPAUL}')")"
accepts "the store rejects it" \
    "SELECT reject_complaint('${C2}','${ALINE}','Our packing photo shows the platter.')"
accepts "the customer's evidence, and the store's" \
    "INSERT INTO complaint_evidence (complaint_id,store_id,side,kind,label,storage_key,uploaded_by) VALUES
       ('${C2}','${S1}','customer','photo','Customer photo · wrap in bag','ev/cust-1.jpg','${JEANPAUL}'),
       ('${C2}','${S1}','store','photo','Store packing photo','ev/store-1.jpg','${ALINE}');
     INSERT INTO complaint_evidence (complaint_id,store_id,side,kind,label) VALUES
       ('${C2}','${S1}','rider','location_log','Rider handover 19:12')"
refuses "a photo with no file behind it" "evidence_file_present" \
    "INSERT INTO complaint_evidence (complaint_id,store_id,side,kind,label)
      VALUES ('${C2}','${S1}','store','photo','A photo that is not there')"
refuses "evidence with no label" "label_not_blank" \
    "INSERT INTO complaint_evidence (complaint_id,store_id,side,kind,label,storage_key)
      VALUES ('${C2}','${S1}','store','photo','   ','ev/x.jpg')"
refuses "withdrawing evidence after the fact" "insert-only" \
    "DELETE FROM complaint_evidence WHERE complaint_id='${C2}'"
refuses "escalating something the store has already rejected" "cannot be escalated: it is rejected" \
    "SELECT escalate_complaint('${C2}','${ALINE}','Please look')"
accepts "the customer reopens it" \
    "SELECT reopen_complaint('${C2}','customer','${JEANPAUL}','The photo is not my bag.')"
accepts "and now the store escalates" \
    "SELECT escalate_complaint('${C2}','${ALINE}','We disagree on what was delivered. Please check the rider photo.')"
equals  "it is with Vendlyfy" "escalated|${ALINE}" \
    "SELECT status || '|' || escalated_by FROM complaints WHERE id='${C2}'"
refuses "the merchant deciding their own escalation" "decided_by" \
    "SELECT decide_escalated_complaint('${C2}','${ALINE}','refund','We win',6000)"
refuses "a platform account that is not on the team deciding it" "decided_by" \
    "SELECT decide_escalated_complaint('${C2}','${NOTTEAM}','refund','Not my job',6000)"
refuses "a decision with no reason both sides can read" "both read" \
    "SELECT decide_escalated_complaint('${C2}','${VENDLY}','refund','   ',6000)"
refuses "refunding without saying how much" "needs an amount" \
    "SELECT decide_escalated_complaint('${C2}','${VENDLY}','refund','Customer is right')"
refuses "a rejection carrying an amount" "does not carry an amount" \
    "SELECT decide_escalated_complaint('${C2}','${VENDLY}','reject','No',6000)"
R2="$(q "SELECT decide_escalated_complaint('${C2}','${VENDLY}','refund','The rider photo shows a wrap. Refunding in full.',6000)")"
equals "the complaint is resolved by Vendlyfy's decision" "resolved|refunded|${VENDLY}" \
    "SELECT status || '|' || decision || '|' || decided_by FROM complaints WHERE id='${C2}'"
equals "the refund it raised is its own, and paid" "platform|approved|6000.00|6000.00" \
    "SELECT initiated_by || '|' || status || '|' || amount || '|' || approved_amount FROM refunds WHERE id='${R2}'"
equals "the order is fully refunded and out of settlement" "6000.00|refunded|refunded" \
    "SELECT refunded_amount || '|' || payment_status || '|' || settlement_status FROM orders WHERE id='${O3}'"
equals "the thread ends with Vendlyfy's decision" "platform_refunded|platform" \
    "SELECT event_type || '|' || actor_side FROM complaint_events
      WHERE complaint_id='${C2}' ORDER BY sequence DESC LIMIT 1"
refuses "deciding it a second time" "is not with Vendlyfy: it is resolved" \
    "SELECT decide_escalated_complaint('${C2}','${VENDLY}','refund','Again',6000)"

# =============================================================================
step "A refund Vendlyfy approves that the wallet cannot cover"
# =============================================================================
# The fifth state. Decided, unpaid, and holding the store's payouts.
equals "drain available down to 500" "t" \
    "SELECT request_withdrawal('${S1}',(SELECT available_balance - 500 FROM wallets WHERE store_id='${S1}'),
        '078 111 2222','wd_drain_0001','${ALINE}') IS NOT NULL"
equals "available is 500" "500.00" "SELECT available_balance::text FROM wallets WHERE store_id='${S1}'"
C3="$(q "SELECT file_complaint('${O2}','quality_problem','It took over an hour and the chicken was cold.')")"
accepts "the store escalates the guest's complaint" \
    "SELECT escalate_complaint('${C3}','${KEVIN}','We cannot agree with the customer.')"
LEDGER_BEFORE="$(q "SELECT count(*) FROM wallet_ledger")"
R3="$(q "SELECT decide_escalated_complaint('${C3}','${VENDLY}','refund','Refunding 5,000 of it.',5000)")"
equals "the refund is APPROVED AND WAITING, not paid" "queued|5000.00" \
    "SELECT status || '|' || approved_amount FROM refunds WHERE id='${R3}'"
equals "nothing left the wallet" "${LEDGER_BEFORE}" "SELECT count(*) FROM wallet_ledger"
equals "and it is not marked as settled" "" \
    "SELECT coalesce(settled_at::text,'') FROM refunds WHERE id='${R3}'"
equals "the order records nothing refunded yet" "0.00" \
    "SELECT refunded_amount::text FROM orders WHERE id='${O2}'"
equals "the complaint is resolved all the same — the decision is made" "resolved|refunded" \
    "SELECT status || '|' || decision FROM complaints WHERE id='${C2}'"
equals "the thread says it is waiting" "true" \
    "SELECT (note LIKE '%waiting for the store%')::text FROM complaint_events
      WHERE complaint_id='${C3}' ORDER BY sequence DESC LIMIT 1"
refuses "PAYOUTS ARE PAUSED while a customer is owed" "payouts are paused" \
    "SELECT request_withdrawal('${S1}',100,'078 111 2222','wd_while_queued','${ALINE}')"
equals  "and no withdrawal was written by the attempt" "0" \
    "SELECT count(*) FROM withdrawals WHERE idempotency_key='wd_while_queued'"
refuses "asking for the rest of that order while the queued refund waits" "cannot exceed what the customer paid" \
    "INSERT INTO refunds (store_id,order_id,amount,reason_code) VALUES ('${S1}','${O2}',8000,'arrived_late')"
refuses "settling a queued refund at a different figure" "cannot settle at" \
    "SELECT refund_settle('${R3}',4000,'${VENDLY}')"
accepts "O4's hold window elapses" \
    "UPDATE orders SET paid_at = now() - interval '2 hours' WHERE id='${O4}'"
equals  "the release sweep will not move the queued order's money either" "0" \
    "SELECT count(*) FROM release_eligible_orders(60) WHERE released_order_id='${O2}'"

# =============================================================================
step "The queue draining itself once the money is there"
# =============================================================================
equals "O4 left escrow, so available can cover it now" "9500.00" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${S1}'"
equals "the sweep pays it, once" "1|${R3}|5000.00" \
    "SELECT count(*) || '|' || min(settled_refund_id::text) || '|' || min(settled_amount)::text
       FROM settle_queued_refunds('${S1}')"
equals "it is approved and settled now" "approved|true" \
    "SELECT status || '|' || (settled_at IS NOT NULL) FROM refunds WHERE id='${R3}'"
equals "exactly one debit reached the ledger for it" "1|-5000.00" \
    "SELECT count(*) || '|' || sum(amount)::text FROM wallet_ledger WHERE refund_id='${R3}'"
equals "the reviewer who decided it is still the one on the record" "${VENDLY}" \
    "SELECT reviewed_by FROM refunds WHERE id='${R3}'"
equals "the order records it" "5000.00" "SELECT refunded_amount::text FROM orders WHERE id='${O2}'"
equals "available is down by exactly that" "4500.00" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${S1}'"
equals "running the sweep again does nothing" "0" "SELECT count(*) FROM settle_queued_refunds('${S1}')"
equals "and payouts work again" "t" \
    "SELECT request_withdrawal('${S1}',100,'078 111 2222','wd_after_settle','${ALINE}') IS NOT NULL"

# =============================================================================
step "Taking an approval back, which is the only way a pause ends otherwise"
# =============================================================================
C4="$(q "SELECT file_complaint('${O4}','arrived_late','Rider says delivered but nothing came.','${PACIFIQUE}')")"
accepts "escalated" "SELECT escalate_complaint('${C4}','${ALINE}','Rider has a photo at the gate.')"
R4="$(q "SELECT decide_escalated_complaint('${C4}','${VENDLY}','refund','Refunding in full.',9000)")"
equals "queued again, because available is 4,400" "queued" "SELECT status FROM refunds WHERE id='${R4}'"
refuses "payouts paused again" "payouts are paused" \
    "SELECT request_withdrawal('${S1}',100,'078 111 2222','wd_paused_again','${ALINE}')"
refuses "taking it back with no reason" "reason the merchant can read" \
    "SELECT reject_refund('${R4}','${VENDLY}','  ')"
equals "taking the approval back" "t" \
    "SELECT reject_refund('${R4}','${VENDLY}','Reversed on appeal: the gate photo is conclusive.')"
equals "the grant is gone with it" "rejected|" \
    "SELECT status || '|' || coalesce(approved_amount::text,'') FROM refunds WHERE id='${R4}'"
equals "payouts resume" "t" \
    "SELECT request_withdrawal('${S1}',100,'078 111 2222','wd_after_reject','${ALINE}') IS NOT NULL"
equals "a refund whose money left cannot be taken back" "f" \
    "SELECT reject_refund('${R3}','${VENDLY}','Changed our minds')"
equals "so it is still approved and still paid" "approved|true" \
    "SELECT status || '|' || (settled_at IS NOT NULL) FROM refunds WHERE id='${R3}'"

# =============================================================================
step "Rejecting an escalation settles the money question with it"
# =============================================================================
accepts "reopen and escalate the first complaint again" \
    "SELECT reopen_complaint('${C1}','customer','${SANDRINE}');
     SELECT escalate_complaint('${C1}','${ALINE}','Customer is still unhappy.')"
R5="$(q "WITH r AS (INSERT INTO refunds (store_id,order_id,complaint_id,amount,reason_code,requested_by)
         VALUES ('${S1}','${O1}','${C1}',1000,'item_missing','${ALINE}') RETURNING id) SELECT id FROM r")"
equals "a request is outstanding on it" "pending" "SELECT status FROM refunds WHERE id='${R5}'"
accepts "Vendlyfy rejects the escalation" \
    "SELECT decide_escalated_complaint('${C1}','${VENDLY}','reject','The salad was sent the same day.')"
equals "the complaint closes as rejected, by Vendlyfy's decision" "rejected|rejected" \
    "SELECT status || '|' || decision FROM complaints WHERE id='${C1}'"
equals "and the request it was carrying is rejected too, with the same reason" "rejected|true" \
    "SELECT status || '|' || (rejection_reason LIKE '%same day%') FROM refunds WHERE id='${R5}'"
equals "no money moved on the rejection" "1" \
    "SELECT count(*) FROM wallet_ledger WHERE order_id='${O1}' AND entry_type='refund_paid'"
refuses "deciding a complaint nobody escalated" "is not with Vendlyfy" \
    "SELECT decide_escalated_complaint('${C4}','${VENDLY}','reject','Not mine')"

# =============================================================================
step "Every move a complaint may make, and no others"
# =============================================================================
equals "the state machine is the seven moves the boards draw" "7" \
    "SELECT count(*) FROM complaint_status_transitions"
equals "and no status is a dead end" "0" \
    "SELECT count(*) FROM (VALUES ('open'),('escalated'),('resolved'),('rejected')) s(v)
      WHERE NOT EXISTS (SELECT 1 FROM complaint_status_transitions WHERE from_status = s.v)"
C5="$(q "SELECT file_complaint('${O5}','wrong_item','Wrong size sent.')")"
refuses "escalating something already decided, without reopening it first" "cannot move from rejected to escalated" \
    "UPDATE complaints SET status='escalated' WHERE id='${C1}'"
accepts "escalating a fresh one properly" "SELECT escalate_complaint('${C5}','${OTHER}','Please decide.')"
refuses "un-escalating by hand, behind Vendlyfy's back" "cannot move from escalated to open" \
    "UPDATE complaints SET status='open' WHERE id='${C5}'"
refuses "resolving an escalated complaint as the merchant" "cannot be resolved: it is escalated" \
    "SELECT resolve_complaint('${C5}','${OTHER}','We will handle it')"
refuses "reopening something that is not closed" "nothing to reopen" \
    "SELECT reopen_complaint('${C5}','store','${OTHER}')"
refuses "a rider reopening a complaint" "not by rider" \
    "SELECT reopen_complaint('${C2}','rider','${OTHER}')"
refuses "a complaint escalated to a decision it did not have" "decision_needs_escalation" \
    "INSERT INTO complaints (store_id,order_id,reason_code,detail,status,decided_by,decided_at,decision)
      VALUES ('${S1}','${O4}','other','A decision with no escalation','resolved','${VENDLY}',now(),'refunded')"
refuses "a decision half recorded" "decision_complete" \
    "INSERT INTO complaints (store_id,order_id,reason_code,detail,decided_at)
      VALUES ('${S1}','${O4}','other','Half a decision',now())"

# =============================================================================
step "Ten customers filing the same complaint at once"
# =============================================================================
parallel_sql 10 "SELECT file_complaint('${O4}'::uuid,'arrived_late','Nothing came.','${PACIFIQUE}'::uuid)" "$SCRATCH/file.txt"
FILED="$(q "SELECT count(*) FROM complaints WHERE order_id='${O4}'")"
DISTINCT="$(sort -u "$SCRATCH/file.txt" | grep -c '^[0-9a-f]' || echo 0)"
if [ "$FILED" = "2" ] && [ "$DISTINCT" = "1" ]; then
    pass "one new complaint, and all ten callers were handed the same one"
else
    LAST="complaints on that order: $FILED (1 closed + 1 new expected)   distinct ids returned: $DISTINCT"$'\n'"$(head -4 "$SCRATCH/file.txt")"
    flunk "a second complaint was opened on one order"
fi

# =============================================================================
step "Ten reviewers deciding one escalation at once"
# =============================================================================
C6="$(q "SELECT id FROM complaints WHERE order_id='${O4}' AND status='open'")"
accepts "escalate it" "SELECT escalate_complaint('${C6}','${ALINE}','Second time this week.')"
accepts "and make sure the wallet can cover it" \
    "SELECT wallet_post('${S1}','available','adjustment',20000,'top_up_for_race','platform')"
parallel_sql 10 "SELECT decide_escalated_complaint('${C6}'::uuid,'${VENDLY}'::uuid,'refund','Refunding.',2000)" "$SCRATCH/decide.txt"
DECIDED="$(grep -c '^[0-9a-f]' "$SCRATCH/decide.txt" 2>/dev/null || echo 0)"
REFUNDS="$(q "SELECT count(*) FROM refunds WHERE complaint_id='${C6}'")"
ENTRIES="$(q "SELECT count(*) FROM wallet_ledger WHERE refund_id IN (SELECT id FROM refunds WHERE complaint_id='${C6}')")"
if [ "$DECIDED" = "1" ] && [ "$REFUNDS" = "1" ] && [ "$ENTRIES" = "1" ]; then
    pass "one decision won, one refund exists, and the customer was paid once"
else
    LAST="decisions: $DECIDED   refunds: $REFUNDS   ledger entries: $ENTRIES"$'\n'"$(head -4 "$SCRATCH/decide.txt")"
    flunk "an escalation was decided more than once"
fi
equals "the order records exactly that one refund" "2000.00" \
    "SELECT refunded_amount::text FROM orders WHERE id='${O4}'"

# =============================================================================
step "After all of it, the ledger still sums to the balances"
# =============================================================================
equals "pending" "t" \
    "SELECT (SELECT coalesce(sum(amount),0) FROM wallet_ledger WHERE store_id='${S1}' AND pot='pending')
          = (SELECT pending_balance FROM wallets WHERE store_id='${S1}')"
equals "available" "t" \
    "SELECT (SELECT coalesce(sum(amount),0) FROM wallet_ledger WHERE store_id='${S1}' AND pot='available')
          = (SELECT available_balance FROM wallets WHERE store_id='${S1}')"
equals "every approved refund sums to what its order records" "0" \
    "SELECT count(*) FROM orders o WHERE o.refunded_amount <>
       (SELECT coalesce(sum(approved_amount),0) FROM refunds WHERE order_id=o.id AND status='approved')"
equals "no refund is approved without its money having left" "0" \
    "SELECT count(*) FROM refunds f WHERE f.status='approved'
       AND NOT EXISTS (SELECT 1 FROM wallet_ledger WHERE refund_id=f.id)"
equals "no queued refund has a ledger entry" "0" \
    "SELECT count(*) FROM refunds f WHERE f.status='queued'
       AND EXISTS (SELECT 1 FROM wallet_ledger WHERE refund_id=f.id)"
equals "every complaint's last event agrees with its status" "0" \
    "SELECT count(*) FROM complaints c WHERE c.status <>
       (SELECT to_status FROM complaint_events WHERE complaint_id=c.id ORDER BY sequence DESC LIMIT 1)"
equals "every complaint thread is an unbroken chain from its filing" "0" \
    "SELECT count(*) FROM (
       SELECT from_status, lag(to_status) OVER (PARTITION BY complaint_id ORDER BY sequence) AS prev, sequence
         FROM complaint_events) t
      WHERE (sequence = 1 AND from_status IS NOT NULL)
         OR (sequence > 1 AND from_status IS DISTINCT FROM prev)"
equals "every new table with updated_at has the trigger that maintains it" "" \
    "SELECT string_agg(c.table_name, ', ') FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.column_name='updated_at'
        AND NOT EXISTS (SELECT 1 FROM information_schema.triggers t
                         WHERE t.event_object_table=c.table_name AND t.action_statement LIKE '%set_updated_at%')"
refuses "a short pot raises the SQLSTATE V005 documented, not a generic one" "caught VLFND" \
    "DO \$\$ BEGIN
       PERFORM wallet_post('${S1}','available','adjustment',-99999999,'short_pot_probe','probe');
     EXCEPTION WHEN SQLSTATE 'VLFND' THEN RAISE EXCEPTION 'caught VLFND'; END \$\$"
refuses "a held payout raises its own SQLSTATE, so a merchant is told the right thing" "caught VLHLD" \
    "INSERT INTO refunds (store_id,order_id,amount,reason_code,status,approved_amount,reviewed_at)
       VALUES ('${S2}','${O5}',1000,'wrong_item','queued',1000,now());
     DO \$\$ BEGIN
       PERFORM request_withdrawal('${S2}',1,'078 000 0000','wd_probe_hold');
     EXCEPTION WHEN SQLSTATE 'VLHLD' THEN RAISE EXCEPTION 'caught VLHLD'; END \$\$"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
