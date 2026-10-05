#!/usr/bin/env bash
#
# Paying a merchant out — milestone 23, V025_wallet_console.sql.
#
# What this suite is for: V005 reserves a withdrawal's funds and V012 refuses it for an unverified store, but nothing
# ever COMPLETED a withdrawal or recorded the attempt to pay it. V025's two functions do, and the properties that
# matter are the ones a double-tap, a replayed webhook and a crash would each break:
#
#   * the attempt is written ONCE per withdrawal (a unique index, so it holds against any writer),
#   * resolving is idempotent — ten simultaneous resolutions move the money ONCE,
#   * a failure returns the funds in full, and a success moves none.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_wallet_console_test"
TEST_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${TEST_DB}"
PASSED=0; FAILED=0; LAST=""
SCRATCH="$(mktemp -d)"

cleanup() {
    rm -rf "$SCRATCH"
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

parallel_sql() {   # parallel_sql <n> <sql> <outfile>
    seq 1 "$1" | xargs -P "$1" -I{} docker compose -f "$COMPOSE_FILE" exec -T \
        -e PGPASSWORD="$OWNER_PASSWORD" "$SERVICE" \
        psql -h 127.0.0.1 -U "$OWNER_ROLE" -d "$TEST_DB" -tAc "$2" > "$3" 2>&1 || true
}

printf '\nWallet console acceptance tests\n'
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

ST='11111111-0000-4000-8000-000000000025'
OWNER_USER='9999aaaa-0000-4000-8000-000000000025'
VENDLY='9999aaaa-0000-4000-8000-000000000026'
FASHION="$(q "SELECT id FROM industry_templates WHERE key='fashion'")"

accepts "a store, its owner and a Vendlyfy reviewer" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version)
       VALUES ('${ST}','wallet-test','Wallet Test','RW','RWF','active','${FASHION}',1);
     INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('${OWNER_USER}','platform','owner@wallet-test.example','h','Owner'),
       ('${VENDLY}','platform','team@wallet-test.example','h','Reviewer');
     INSERT INTO store_members (user_id,store_id,role) VALUES ('${OWNER_USER}','${ST}','owner');
     INSERT INTO platform_members (user_id,role) VALUES ('${VENDLY}','super_admin')"
accepts "verified through the real calls, which the deferred constraint insists on" \
    "SELECT submit_kyc('${ST}','${OWNER_USER}');
     SELECT attach_kyc_document((SELECT id FROM kyc_submissions WHERE store_id='${ST}' AND status='submitted'),'id_front','kyc/f.jpg','image/jpeg');
     SELECT attach_kyc_document((SELECT id FROM kyc_submissions WHERE store_id='${ST}' AND status='submitted'),'id_back','kyc/b.jpg','image/jpeg');
     SELECT attach_kyc_document((SELECT id FROM kyc_submissions WHERE store_id='${ST}' AND status='submitted'),'face_video','kyc/v.mp4','video/mp4');
     SELECT complete_kyc_checks((SELECT id FROM kyc_submissions WHERE store_id='${ST}' AND status='submitted'));
     SELECT decide_kyc((SELECT id FROM kyc_submissions WHERE store_id='${ST}' AND status='in_review'),'${VENDLY}','approve','ok')"
accepts "100,000 available, the only way it can get there: through the ledger" \
    "SELECT wallet_post(p_store_id => '${ST}', p_pot => 'available', p_entry_type => 'adjustment', p_amount => 100000,
                        p_idempotency_key => 'fund:1', p_counterparty => 'test funding')"

avail() { q "SELECT available_balance FROM wallets WHERE store_id='${ST}'"; }

step "Starting a payout"
sql "SELECT request_withdrawal('${ST}', 30000, '0781234567', 'w1', '${OWNER_USER}', 'manual')"; W1="$(q "SELECT id FROM withdrawals WHERE idempotency_key='w1'")"
equals "request_withdrawal reserved the funds at once" "70000.00" "$(printf 'SELECT available_balance FROM wallets WHERE store_id=%s' "'${ST}'")"
equals "the withdrawal starts pending" "pending" "SELECT status FROM withdrawals WHERE id='${W1}'"
equals "start_withdrawal_disbursement writes the attempt and says it created it" "t" \
    "SELECT created FROM start_withdrawal_disbursement('${W1}', 'aaaaaaaa-0000-4000-8000-000000000001')"
equals "the withdrawal is now processing" "processing" "SELECT status FROM withdrawals WHERE id='${W1}'"
equals "the attempt carries the destination and the amount, from the withdrawal and not from the caller" "0781234567|30000.00|disbursement|pending" \
    "SELECT phone || '|' || amount || '|' || direction || '|' || status FROM momo_transactions WHERE withdrawal_id='${W1}'"
equals "a repeat returns the SAME attempt and says it created nothing" "aaaaaaaa-0000-4000-8000-000000000001|false" \
    "SELECT reference_id || '|' || created FROM start_withdrawal_disbursement('${W1}', 'bbbbbbbb-0000-4000-8000-000000000002')"
equals "so there is still exactly one attempt" "1" "SELECT count(*) FROM momo_transactions WHERE withdrawal_id='${W1}'"
refuses "and the index says so against any writer, not just this function" "momo_one_disbursement_per_withdrawal" \
    "INSERT INTO momo_transactions (store_id, direction, reference_id, phone, amount, currency, withdrawal_id)
          VALUES ('${ST}', 'disbursement', 'cccccccc-0000-4000-8000-000000000003', '0781234567', 30000, 'RWF', '${W1}')"
refuses "a withdrawal that does not exist cannot be started" "does not exist" \
    "SELECT * FROM start_withdrawal_disbursement('dddddddd-0000-4000-8000-0000000000ff', 'eeeeeeee-0000-4000-8000-000000000004')"

step "It arrives"
equals "resolving as successful completes the withdrawal" "t" "SELECT resolve_disbursement('aaaaaaaa-0000-4000-8000-000000000001', 'successful')"
equals "the withdrawal is completed, with a completion time" "completed|true" \
    "SELECT status || '|' || (completed_at IS NOT NULL) FROM withdrawals WHERE id='${W1}'"
equals "the attempt is closed" "successful|true" "SELECT status || '|' || (resolved_at IS NOT NULL) FROM momo_transactions WHERE withdrawal_id='${W1}'"
equals "it moved no more money" "70000.00" "SELECT available_balance FROM wallets WHERE store_id='${ST}'"
equals "resolving it again changes nothing and says so" "f" "SELECT resolve_disbursement('aaaaaaaa-0000-4000-8000-000000000001', 'successful')"
equals "even with the opposite answer: a payout that arrived cannot then be failed" "f" "SELECT resolve_disbursement('aaaaaaaa-0000-4000-8000-000000000001', 'failed', 'too late')"
equals "and the money did not come back" "70000.00" "SELECT available_balance FROM wallets WHERE store_id='${ST}'"
refuses "a resolution is successful or failed, nothing else" "successful or failed" "SELECT resolve_disbursement('aaaaaaaa-0000-4000-8000-000000000001', 'maybe')"

step "It fails"
sql "SELECT request_withdrawal('${ST}', 20000, '0781234567', 'w2', '${OWNER_USER}', 'manual')"; W2="$(q "SELECT id FROM withdrawals WHERE idempotency_key='w2'")"
accepts "start it" "SELECT * FROM start_withdrawal_disbursement('${W2}', 'ffffffff-0000-4000-8000-000000000005')"
equals "50,000 left while it is in flight" "50000.00" "SELECT available_balance FROM wallets WHERE store_id='${ST}'"
equals "resolving as failed" "t" "SELECT resolve_disbursement('ffffffff-0000-4000-8000-000000000005', 'failed', 'MoMo number is not registered')"
equals "the funds are back in full" "70000.00" "SELECT available_balance FROM wallets WHERE store_id='${ST}'"
equals "the withdrawal failed, with the reason a merchant reads" "failed|MoMo number is not registered" "SELECT status || '|' || failure_reason FROM withdrawals WHERE id='${W2}'"
equals "the reversal is a ledger entry, so the books show what happened" "1" "SELECT count(*) FROM wallet_ledger WHERE withdrawal_id='${W2}' AND entry_type='withdrawal_reversed'"
sql "SELECT request_withdrawal('${ST}', 1000, '0781234567', 'w3', '${OWNER_USER}', 'manual')"; W3="$(q "SELECT id FROM withdrawals WHERE idempotency_key='w3'")"
accepts "a failure with no reason still gets one a person can read" "SELECT * FROM start_withdrawal_disbursement('${W3}', '11111111-aaaa-4000-8000-000000000006'); SELECT resolve_disbursement('11111111-aaaa-4000-8000-000000000006', 'failed', '')"
equals "the default sentence" "MoMo did not accept the transfer." "SELECT failure_reason FROM withdrawals WHERE id='${W3}'"
equals "and every failed payout was returned: nothing is missing" "70000.00" "SELECT available_balance FROM wallets WHERE store_id='${ST}'"

step "Ten at once"
sql "SELECT request_withdrawal('${ST}', 10000, '0781234567', 'w4', '${OWNER_USER}', 'manual')"; W4="$(q "SELECT id FROM withdrawals WHERE idempotency_key='w4'")"
accepts "start it" "SELECT * FROM start_withdrawal_disbursement('${W4}', '22222222-aaaa-4000-8000-000000000007')"
parallel_sql 10 "SELECT resolve_disbursement('22222222-aaaa-4000-8000-000000000007', 'failed', 'raced')" "$SCRATCH/race.txt"
LAST="$(cat "$SCRATCH/race.txt")"
if [ "$(grep -c '^t' "$SCRATCH/race.txt")" = "1" ] && [ "$(grep -c '^f' "$SCRATCH/race.txt")" = "9" ]; then pass "the other nine answered false, and none errored"; else flunk "the race produced something other than 1 true and 9 false"; fi
equals "so the money came back exactly once" "70000.00" "SELECT available_balance FROM wallets WHERE store_id='${ST}'"
equals "with one reversal entry, not ten" "1" "SELECT count(*) FROM wallet_ledger WHERE withdrawal_id='${W4}' AND entry_type='withdrawal_reversed'"

step "Indexes"
equals "the Activity keyset has the id in it" "t" \
    "SELECT indexdef LIKE '%(store_id, created_at DESC, id DESC)%' FROM pg_indexes WHERE indexname='wallet_ledger_store_created_id_idx'"
equals "and so does the Refunds tab" "t" \
    "SELECT indexdef LIKE '%(store_id, created_at DESC, id DESC)%' FROM pg_indexes WHERE indexname='refunds_store_created_idx'"

printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ]
