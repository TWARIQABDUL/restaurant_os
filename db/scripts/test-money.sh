#!/usr/bin/env bash
#
# Money acceptance tests — milestone 8, second half.
#
# Organised around the four ways money goes wrong rather than around the tables:
# it is charged twice, it is credited twice, it goes missing, or the books stop
# adding up. Two tests are real races run across many connections.
#
# The last section is the one that matters most: after a full lifecycle — paid,
# released, withdrawn, refunded — the ledger must still sum to the balances.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_money_test"
TEST_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${TEST_DB}"
SCRATCH="/tmp/claude-1000/-home-abdalazizi-restaurant-os/9e37ab58-4cab-4b22-84d4-4d4b7273fc75/scratchpad"
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

# Runs one statement on its own connection, N times in parallel.
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

printf '\nMoney acceptance tests\n'
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

ST='11111111-0000-0000-0000-000000000001'
OWNER_USER='9999aaaa-0000-0000-0000-000000000001'
VENDLY='9999aaaa-0000-0000-0000-000000000002'
FASHION="$(q "SELECT id FROM industry_templates WHERE key='fashion'")"
V1='dddd0000-0000-0000-0000-000000000001'   # tracked, stock 1 — the last unit
V2='dddd0000-0000-0000-0000-000000000002'   # untracked
accepts "a store, a tracked product with ONE left, and an untracked one" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version)
       VALUES ('${ST}','inzu','Inzu Threads','RW','RWF','active','${FASHION}',1);
     INSERT INTO products (id,store_id,name,base_price,track_stock,status) VALUES
       ('aaaa0000-0000-0000-0000-000000000001','${ST}','Linen tee',15000,true,'active'),
       ('aaaa0000-0000-0000-0000-000000000002','${ST}','Gift card',5000,false,'active');
     INSERT INTO product_variants (id,product_id,store_id,sku,stock_quantity,is_default) VALUES
       ('${V1}','aaaa0000-0000-0000-0000-000000000001','${ST}','TEE-BLK-M',1,true),
       ('${V2}','aaaa0000-0000-0000-0000-000000000002','${ST}','GIFT',NULL,true)"
equals "the store got a wallet the moment it existed" "RWF|0.00|0.00" \
    "SELECT currency || '|' || pending_balance || '|' || available_balance FROM wallets WHERE store_id='${ST}'"
accepts "an owner and a Vendlyfy reviewer, so the store can be verified" \
    "INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('${OWNER_USER}','platform','owner@inzu.example.com','h','Kevin Nkusi'),
       ('${VENDLY}','platform','team@vendlyfy.com','h','Vendlyfy Support');
     INSERT INTO store_members (user_id,store_id,role) VALUES ('${OWNER_USER}','${ST}','owner');
     INSERT INTO platform_members (user_id,role) VALUES ('${VENDLY}','super_admin')"
verify_store "Inzu Threads" "${ST}" "${OWNER_USER}" "${VENDLY}"

# =============================================================================
step "The last unit, contested by ten connections at once"
# =============================================================================
# The milestone's own done-when. Ten independent connections try to reserve the
# same single unit. Exactly one may succeed, and stock may never go below zero.
parallel_sql 10 "SELECT reserve_stock('${ST}'::uuid, '[{\"variant_id\":\"${V1}\",\"quantity\":1}]'::jsonb)" "$SCRATCH/race.txt"
WON="$(grep -c '^$' "$SCRATCH/race.txt" 2>/dev/null || echo 0)"
LOST="$(grep -c 'left, not' "$SCRATCH/race.txt" 2>/dev/null || echo 0)"
REMAINING="$(q "SELECT stock_quantity FROM product_variants WHERE id='${V1}'")"
if [ "$WON" = "1" ] && [ "$LOST" = "9" ] && [ "$REMAINING" = "0" ]; then
    pass "exactly one won, nine were told it was gone, and stock landed on zero"
else
    LAST="won: $WON   refused: $LOST   stock left: $REMAINING"$'\n'"$(head -4 "$SCRATCH/race.txt")"
    flunk "the last unit was oversold or lost"
fi
equals "stock never went negative" "t" "SELECT stock_quantity >= 0 FROM product_variants WHERE id='${V1}'"
refuses "reserving from an empty shelf" "left, not" \
    "SELECT reserve_stock('${ST}'::uuid, '[{\"variant_id\":\"${V1}\",\"quantity\":1}]'::jsonb)"
accepts "putting it back" \
    "SELECT release_stock('${ST}'::uuid, '[{\"variant_id\":\"${V1}\",\"quantity\":5}]'::jsonb)"
equals  "stock is five" "5" "SELECT stock_quantity FROM product_variants WHERE id='${V1}'"
accepts "a product that does not track stock is simply skipped" \
    "SELECT reserve_stock('${ST}'::uuid, '[{\"variant_id\":\"${V2}\",\"quantity\":99}]'::jsonb)"
equals  "and still has no count" "" "SELECT coalesce(stock_quantity::text,'') FROM product_variants WHERE id='${V2}'"
accepts "the same variant twice on one order is summed, not checked twice" \
    "SELECT reserve_stock('${ST}'::uuid, '[{\"variant_id\":\"${V1}\",\"quantity\":2},{\"variant_id\":\"${V1}\",\"quantity\":3}]'::jsonb)"
equals  "all five taken at once" "0" "SELECT stock_quantity FROM product_variants WHERE id='${V1}'"
accepts "restock for the rest of the tests" \
    "UPDATE product_variants SET stock_quantity=100 WHERE id='${V1}'"

# =============================================================================
step "A paid order, and a webhook that arrives three times"
# =============================================================================
O='eeee0000-0000-0000-0000-000000000001'
M='cccc0000-0000-0000-0000-000000000001'
accepts "an order for 15,000, and a MoMo collection in flight" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${O}','${ST}',next_order_number('${ST}'),'trk_money_order_001','idem_money_order_0001',
              'Aimable Kayitare','078 330 1180','KG 11 Ave','delivery','mtn_momo','RWF',15000);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
      VALUES ('${O}','${ST}','${V1}','Linen tee',15000,1);
     INSERT INTO momo_transactions (id,store_id,order_id,direction,reference_id,phone,amount,currency)
      VALUES ('${M}','${ST}','${O}','collection','ref_collection_0001','078 330 1180',15000,'RWF')"
equals "the first webhook does the work" "t" "SELECT record_momo_collection_success('${M}')"
equals "the second finds nothing to do" "f" "SELECT record_momo_collection_success('${M}')"
equals "the third likewise" "f" "SELECT record_momo_collection_success('${M}')"
equals "exactly one credit reached the ledger" "1" \
    "SELECT count(*) FROM wallet_ledger WHERE order_id='${O}' AND entry_type='order_payment_received'"
equals "the pending pot holds the money once" "15000.00|0.00" \
    "SELECT pending_balance || '|' || available_balance FROM wallets WHERE store_id='${ST}'"
equals "the order is paid and in escrow" "paid|pending" \
    "SELECT payment_status || '|' || settlement_status FROM orders WHERE id='${O}'"

step "An order cannot be charged twice"
refuses "a second successful collection on the same order" "momo_one_success_per_order" \
    "INSERT INTO momo_transactions (store_id,order_id,direction,reference_id,phone,amount,currency,status,resolved_at)
      VALUES ('${ST}','${O}','collection','ref_collection_dup1','078 330 1180',15000,'RWF','successful',now())"
refuses "a second attempt in flight while the first is unresolved" "momo_one_pending_per_order" \
    "INSERT INTO momo_transactions (id,store_id,order_id,direction,reference_id,phone,amount,currency)
      VALUES ('cccc0000-0000-0000-0000-00000000000b','${ST}','${O}','collection','ref_inflight_0001','078 330 1180',15000,'RWF');
     INSERT INTO momo_transactions (store_id,order_id,direction,reference_id,phone,amount,currency)
      VALUES ('${ST}','${O}','collection','ref_inflight_0002','078 330 1180',15000,'RWF')"
refuses "reusing a provider reference id" "momo_reference_key" \
    "INSERT INTO momo_transactions (store_id,order_id,direction,reference_id,phone,amount,currency)
      VALUES ('${ST}','${O}','collection','ref_collection_0001','078 330 1180',15000,'RWF')"

# =============================================================================
step "Releasing escrow writes both sides"
# =============================================================================
accepts "backdating the payment so the hold window has elapsed" \
    "UPDATE orders SET paid_at = now() - interval '2 hours' WHERE id='${O}'"
equals "the sweep releases it" "15000.00" \
    "SELECT released_amount::text FROM release_eligible_orders(60)"
equals "two ledger rows, summing to zero" "2|0.00" \
    "SELECT count(*) || '|' || sum(amount)::text FROM wallet_ledger WHERE transfer_id IS NOT NULL"
equals "pending is empty and available holds it" "0.00|15000.00" \
    "SELECT pending_balance || '|' || available_balance FROM wallets WHERE store_id='${ST}'"
equals "a second sweep releases nothing" "0" \
    "SELECT count(*) FROM release_eligible_orders(60)"
equals "and no extra ledger rows appeared" "2" \
    "SELECT count(*) FROM wallet_ledger WHERE transfer_id IS NOT NULL"
refuses "a one-sided transfer" "not 2 rows summing to 0" \
    "INSERT INTO wallet_ledger (store_id,pot,sequence,entry_type,amount,balance_after,transfer_id,idempotency_key)
      VALUES ('${ST}','available',(SELECT max(sequence)+1 FROM wallet_ledger WHERE store_id='${ST}' AND pot='available'),
              'escrow_released_in',1,15001,gen_random_uuid(),'hand_written_one_sided')"

# =============================================================================
step "Withdrawals"
# =============================================================================
refuses "withdrawing more than is available" "cannot cover" \
    "SELECT request_withdrawal('${ST}'::uuid, 99999, '078 330 1180', 'idem_withdraw_too_much')"
equals  "and no request was left behind" "0" "SELECT count(*) FROM withdrawals"
W="$(q "SELECT request_withdrawal('${ST}'::uuid, 10000, '078 330 1180', 'idem_withdraw_first01')")"
equals "the funds left available immediately" "5000.00" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${ST}'"
equals "a double-clicked withdraw returns the same request" "${W}" \
    "SELECT request_withdrawal('${ST}'::uuid, 10000, '078 330 1180', 'idem_withdraw_first01')::text"
equals "and reserved the money only once" "5000.00" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${ST}'"
equals "a failed transfer returns the money" "t" \
    "SELECT reverse_failed_withdrawal('${W}'::uuid, 'MoMo reported an invalid number')"
equals "available is whole again" "15000.00" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${ST}'"
equals "reversing twice does nothing" "f" \
    "SELECT reverse_failed_withdrawal('${W}'::uuid, 'MoMo reported an invalid number')"
refuses "a failure with no reason the merchant can read" "needs a reason" \
    "SELECT reverse_failed_withdrawal('${W}'::uuid, '  ')"

# =============================================================================
step "Refunds leave the pot the money is actually in"
# =============================================================================
R1='bbbb0000-0000-0000-0000-000000000001'
accepts "a partial refund request on the released order" \
    "INSERT INTO refunds (id,store_id,order_id,amount,reason_code) VALUES
       ('${R1}','${ST}','${O}',2000,'quality_problem')"
equals "approving it" "t" "SELECT approve_refund('${R1}'::uuid, NULL)"
equals "the money left AVAILABLE, because this order's escrow had already been released" "available" \
    "SELECT pot FROM wallet_ledger WHERE refund_id='${R1}'"
equals "available is down by the refund" "13000.00" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${ST}'"
equals "the order records it" "2000.00|paid" \
    "SELECT refunded_amount || '|' || payment_status FROM orders WHERE id='${O}'"
equals "approving twice moves nothing" "f" "SELECT approve_refund('${R1}'::uuid, NULL)"
equals "and there is one refund entry" "1" \
    "SELECT count(*) FROM wallet_ledger WHERE refund_id='${R1}'"
refuses "requesting more than the order was worth" "cannot exceed what the customer paid" \
    "INSERT INTO refunds (store_id,order_id,amount,reason_code) VALUES ('${ST}','${O}',99999,'wrong_item')"
refuses "'other' with no explanation" "refunds_other_needs_note" \
    "INSERT INTO refunds (store_id,order_id,amount,reason_code) VALUES ('${ST}','${O}',100,'other')"
refuses "a rejection with no reason" "refunds_rejection_has_reason" \
    "INSERT INTO refunds (store_id,order_id,amount,reason_code,status,reviewed_at)
      VALUES ('${ST}','${O}',100,'wrong_item','rejected',now())"
refuses "setting refunded_amount by hand, with no refund behind it" "approved refunds sum to" \
    "UPDATE orders SET refunded_amount = refunded_amount + 500 WHERE id='${O}'"
# 99999 on a 15,000 order breaks within_total AND status_agrees at once; which one
# Postgres reports first is not a test's business.
refuses "refunding more than the order, at the column" "orders_refund_" \
    "UPDATE orders SET refunded_amount = 99999 WHERE id='${O}'"
refuses "calling it fully refunded while most of the money is still the merchant's" "orders_refund_status_agrees" \
    "UPDATE orders SET payment_status='refunded' WHERE id='${O}'"
R1B='bbbb0000-0000-0000-0000-000000000002'
accepts "refunding the remaining 13,000" \
    "INSERT INTO refunds (id,store_id,order_id,amount,reason_code) VALUES
       ('${R1B}','${ST}','${O}',13000,'item_missing')"
equals  "approving it" "t" "SELECT approve_refund('${R1B}'::uuid, NULL)"
equals  "now the order is fully refunded and out of settlement" "15000.00|refunded|refunded" \
    "SELECT refunded_amount || '|' || payment_status || '|' || settlement_status FROM orders WHERE id='${O}'"
equals "approved refunds sum to what the order records" "t" \
    "SELECT (SELECT coalesce(sum(amount),0) FROM refunds WHERE order_id='${O}' AND status='approved')
          = (SELECT refunded_amount FROM orders WHERE id='${O}')"

# =============================================================================
step "A refund while the money is still in escrow — the old system's exact bug"
# =============================================================================
# The profile of the old database found one store's pots out by +100 and -100:
# approve_refund labelled the ledger row with the pot the money had NOT left.
# Here the pot is chosen from where the money actually is, so a refund before
# release must come out of `pending`.
O2='eeee0000-0000-0000-0000-000000000003'
M2='cccc0000-0000-0000-0000-000000000003'
R2='bbbb0000-0000-0000-0000-000000000003'
accepts "a second order, paid and still in escrow" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${O2}','${ST}',next_order_number('${ST}'),'trk_escrow_refund01','idem_escrow_refund001',
              'Yvonne Mutesi','078 200 7781','KN 3 Rd','delivery','mtn_momo','RWF',8000);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
      VALUES ('${O2}','${ST}','${V1}','Linen tee',8000,1);
     INSERT INTO momo_transactions (id,store_id,order_id,direction,reference_id,phone,amount,currency)
      VALUES ('${M2}','${ST}','${O2}','collection','ref_collection_0003','078 200 7781',8000,'RWF')"
equals "the collection lands in pending" "t" "SELECT record_momo_collection_success('${M2}')"
PENDING_BEFORE="$(q "SELECT pending_balance FROM wallets WHERE store_id='${ST}'")"
AVAIL_BEFORE="$(q "SELECT available_balance FROM wallets WHERE store_id='${ST}'")"
accepts "a refund requested before the hold elapses" \
    "INSERT INTO refunds (id,store_id,order_id,amount,reason_code) VALUES
       ('${R2}','${ST}','${O2}',3000,'item_missing')"
equals "approving it" "t" "SELECT approve_refund('${R2}'::uuid, NULL)"
equals "it came out of PENDING, where the money actually was" "pending" \
    "SELECT pot FROM wallet_ledger WHERE refund_id='${R2}'"
equals "pending is down by the refund" "$(q "SELECT (${PENDING_BEFORE} - 3000)::numeric(12,2)::text")" \
    "SELECT pending_balance::text FROM wallets WHERE store_id='${ST}'"
equals "and available was untouched" "${AVAIL_BEFORE}" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${ST}'"
equals "releasing later moves only what is left" "5000.00" \
    "SELECT released_amount::text FROM (
       SELECT * FROM release_eligible_orders(0)) x WHERE released_order_id='${O2}'"
equals "so the order's escrow nets to zero — every held shilling left again" "0" \
    "SELECT count(*) FROM (SELECT store_id FROM wallet_ledger
       WHERE order_id='${O2}' AND pot='pending' GROUP BY store_id HAVING sum(amount) <> 0) x"

# =============================================================================
step "The same webhook, delivered ten times at once"
# =============================================================================
# Sequential replay is the easy case. This is the real one: ten connections
# resolving the same collection simultaneously. Exactly one credit may land.
O3='eeee0000-0000-0000-0000-000000000004'
M3='cccc0000-0000-0000-0000-000000000004'
accepts "a third order with a collection in flight" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${O3}','${ST}',next_order_number('${ST}'),'trk_race_webhook001','idem_race_webhook0001',
              'Kevin Mugabo','078 990 2231','KG 9 Ave','delivery','mtn_momo','RWF',4000);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
      VALUES ('${O3}','${ST}','${V1}','Linen tee',4000,1);
     INSERT INTO momo_transactions (id,store_id,order_id,direction,reference_id,phone,amount,currency)
      VALUES ('${M3}','${ST}','${O3}','collection','ref_collection_0004','078 990 2231',4000,'RWF')"
parallel_sql 10 "SELECT record_momo_collection_success('${M3}')" "$SCRATCH/webhook.txt"
DID="$(grep -c '^t$' "$SCRATCH/webhook.txt" 2>/dev/null || echo 0)"
SKIPPED="$(grep -c '^f$' "$SCRATCH/webhook.txt" 2>/dev/null || echo 0)"
if [ "$DID" = "1" ] && [ "$SKIPPED" = "9" ]; then
    pass "one call did the work, nine found nothing to do"
else
    LAST="did work: $DID   no-op: $SKIPPED"$'\n'"$(head -4 "$SCRATCH/webhook.txt")"
    flunk "a concurrent webhook was processed more than once"
fi
equals "exactly one credit for that order" "1" \
    "SELECT count(*) FROM wallet_ledger WHERE order_id='${O3}' AND entry_type='order_payment_received'"
equals "of exactly the order's amount" "4000.00" \
    "SELECT sum(amount)::text FROM wallet_ledger WHERE order_id='${O3}' AND entry_type='order_payment_received'"

step "Two reviewers approving the same refund at once"
R3='bbbb0000-0000-0000-0000-000000000004'
accepts "a refund awaiting review" \
    "INSERT INTO refunds (id,store_id,order_id,amount,reason_code) VALUES
       ('${R3}','${ST}','${O3}',1000,'arrived_late')"
parallel_sql 10 "SELECT approve_refund('${R3}'::uuid, NULL)" "$SCRATCH/refund.txt"
APPROVED="$(grep -c '^t$' "$SCRATCH/refund.txt" 2>/dev/null || echo 0)"
if [ "$APPROVED" = "1" ]; then
    pass "exactly one approval won"
else
    LAST="approvals: $APPROVED"$'\n'"$(head -4 "$SCRATCH/refund.txt")"
    flunk "a refund was approved more than once"
fi
equals "one refund debit in the ledger" "1" "SELECT count(*) FROM wallet_ledger WHERE refund_id='${R3}'"
equals "and the order records it once" "1000.00" \
    "SELECT refunded_amount::text FROM orders WHERE id='${O3}'"

# =============================================================================
step "The ledger cannot be edited, reordered or contradicted"
# =============================================================================
refuses "editing an entry" "append-only" "UPDATE wallet_ledger SET amount=1 WHERE order_id='${O}'"
refuses "deleting an entry" "append-only" "DELETE FROM wallet_ledger WHERE order_id='${O}'"
refuses "setting a wallet balance by hand" "cannot be set directly" \
    "UPDATE wallets SET available_balance=999999 WHERE store_id='${ST}'"
refuses "an entry whose balance_after does not follow" "balance for store" \
    "INSERT INTO wallet_ledger (store_id,pot,sequence,entry_type,amount,balance_after,counterparty,idempotency_key)
      VALUES ('${ST}','available',(SELECT max(sequence)+1 FROM wallet_ledger WHERE store_id='${ST}' AND pot='available'),
              'adjustment',100,999999,'hand','hand_written_bad_balance')"
refuses "an entry that skips a sequence number" "sequence for store" \
    "INSERT INTO wallet_ledger (store_id,pot,sequence,entry_type,amount,balance_after,counterparty,idempotency_key)
      VALUES ('${ST}','available',(SELECT max(sequence)+9 FROM wallet_ledger WHERE store_id='${ST}' AND pot='available'),
              'adjustment',100,
              (SELECT balance_after + 100 FROM wallet_ledger WHERE store_id='${ST}' AND pot='available'
                ORDER BY sequence DESC LIMIT 1),
              'hand','hand_written_bad_sequence')"
refuses "an entry of zero" "amount_not_zero" \
    "INSERT INTO wallet_ledger (store_id,pot,sequence,entry_type,amount,balance_after,counterparty,idempotency_key)
      VALUES ('${ST}','available',
              (SELECT max(sequence)+1 FROM wallet_ledger WHERE store_id='${ST}' AND pot='available'),
              'adjustment',0,
              (SELECT balance_after FROM wallet_ledger WHERE store_id='${ST}' AND pot='available'
                ORDER BY sequence DESC LIMIT 1),
              'hand','hand_written_zero')"
# balance_after is computed from the chain so that THIS constraint is the one
# under test, rather than the chain check firing first on a stale figure.
refuses "an external entry with no counterparty named" "counterparty_agrees" \
    "INSERT INTO wallet_ledger (store_id,pot,sequence,entry_type,amount,balance_after,idempotency_key)
      VALUES ('${ST}','available',
              (SELECT max(sequence)+1 FROM wallet_ledger WHERE store_id='${ST}' AND pot='available'),
              'adjustment',100,
              (SELECT balance_after + 100 FROM wallet_ledger WHERE store_id='${ST}' AND pot='available'
                ORDER BY sequence DESC LIMIT 1),
              'hand_written_anonymous')"
refuses "taking a pot negative" "cannot cover" \
    "SELECT wallet_post('${ST}'::uuid,'available','adjustment',-99999,'idem_overdraft_attempt','correction')"

# =============================================================================
step "Cash never enters the wallet"
# =============================================================================
OC='eeee0000-0000-0000-0000-000000000002'
accepts "a cash order, delivered" \
    "INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,guest_name,guest_phone,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${OC}','${ST}',next_order_number('${ST}'),'trk_cash_order_0001','idem_cash_order_00001',
              'Solange Uwera','072 811 4420','KN 3 Rd','delivery','cash','RWF',12500);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
      VALUES ('${OC}','${ST}','${V1}','Linen tee',12500,1)"
BEFORE_AVAIL="$(q "SELECT available_balance FROM wallets WHERE store_id='${ST}'")"
equals "the rider hands over less than the total, and it is recorded" "t" \
    "SELECT confirm_cash_payment('${OC}'::uuid, 10000)"
equals "the shortfall is visible on the order" "12500.00|10000.00|2500.00" \
    "SELECT total_amount || '|' || cash_reported_amount || '|' || (total_amount - cash_reported_amount)::text
       FROM orders WHERE id='${OC}'"
equals "confirming twice does nothing" "f" "SELECT confirm_cash_payment('${OC}'::uuid, 10000)"
equals "and the wallet was never touched — cash never reached the platform" "${BEFORE_AVAIL}" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${ST}'"
equals "a cash order is not in escrow" "not_applicable" \
    "SELECT settlement_status FROM orders WHERE id='${OC}'"

# =============================================================================
step "After all of that, the books still add up"
# =============================================================================
equals "the pending pot equals the sum of its entries" "t" \
    "SELECT w.pending_balance = coalesce((SELECT sum(amount) FROM wallet_ledger l
        WHERE l.store_id=w.store_id AND l.pot='pending'),0) FROM wallets w WHERE w.store_id='${ST}'"
equals "the available pot equals the sum of its entries" "t" \
    "SELECT w.available_balance = coalesce((SELECT sum(amount) FROM wallet_ledger l
        WHERE l.store_id=w.store_id AND l.pot='available'),0) FROM wallets w WHERE w.store_id='${ST}'"
equals "every pot's last balance_after equals its balance" "0" \
    "SELECT count(*) FROM wallets w, (VALUES ('pending'),('available')) AS p(pot)
      WHERE coalesce((SELECT balance_after FROM wallet_ledger l
                       WHERE l.store_id=w.store_id AND l.pot=p.pot
                       ORDER BY sequence DESC LIMIT 1),0)
         <> CASE p.pot WHEN 'pending' THEN w.pending_balance ELSE w.available_balance END"
equals "every internal transfer has two sides summing to zero" "0" \
    "SELECT count(*) FROM (SELECT transfer_id FROM wallet_ledger WHERE transfer_id IS NOT NULL
       GROUP BY transfer_id HAVING count(*) <> 2 OR sum(amount) <> 0) x"
equals "every sequence is an unbroken run from 1" "0" \
    "SELECT count(*) FROM (
       SELECT store_id, pot, count(*) AS n, max(sequence) AS hi, min(sequence) AS lo
         FROM wallet_ledger GROUP BY 1,2 HAVING min(sequence) <> 1 OR max(sequence) <> count(*)) x"
equals "no balance_after in the chain disagrees with its predecessor" "0" \
    "SELECT count(*) FROM (
       SELECT balance_after - amount AS implied_prev,
              lag(balance_after) OVER (PARTITION BY store_id, pot ORDER BY sequence) AS actual_prev
         FROM wallet_ledger) x
      WHERE implied_prev <> coalesce(actual_prev, 0)"
equals "no pot is negative at any point in its history" "0" \
    "SELECT count(*) FROM wallet_ledger WHERE balance_after < 0"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
