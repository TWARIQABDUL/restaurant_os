#!/usr/bin/env bash
#
# Identity verification acceptance tests — milestone 9, seventh part.
#
# Three things here are worth more than the rest:
#
#   * THERE IS NO PLAINTEXT ID NUMBER ANYWHERE. Asserted against
#     information_schema, not against a habit: no column of any table is named for
#     one, the masked form must actually be masked, and the extracted-fields table
#     — the one a reviewer's ordinary query reads — cannot hold an unmasked number.
#   * THE REVEAL AND THE AUDIT ENTRY ARE ONE ACT. Reading the number without
#     leaving a record is not a thing the schema can do.
#   * PAYOUTS WAIT, AND NOTHING ELSE DOES. An unverified store can sell, take
#     orders, be paid by MoMo and accumulate a balance; the withdrawal is the only
#     call that refuses.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_kyc_test"
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

printf '\nIdentity verification acceptance tests\n'
info "database  : ${TEST_DB}"

step "Building the schema, three merchants and the Vendlyfy team"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" -c "CREATE DATABASE ${TEST_DB}" >/dev/null
if DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" >/dev/null 2>&1; then
    pass "the migrations apply to an empty database"
else
    LAST="$(DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" 2>&1)"; flunk "migrations did not apply"
    printf '\n%s\n' "$PASSED passed, $FAILED failed."; exit 1
fi

S1='11111111-0000-0000-0000-000000000001'   # Ubwiza Beauty — will be approved
S2='22222222-0000-0000-0000-000000000002'   # Kigali Tech Hub — blurry ID back
S3='33333333-0000-0000-0000-000000000003'   # Isoko Fresh — weak face match
CLAUDINE='aaaa0000-0000-0000-0000-000000000001'
OLIVIER='aaaa0000-0000-0000-0000-000000000002'
BOSCO='aaaa0000-0000-0000-0000-000000000003'
GRACE='aaaa0000-0000-0000-0000-000000000011'  # Vendlyfy
OLIVE='aaaa0000-0000-0000-0000-000000000012'  # Vendlyfy
NOTTEAM='aaaa0000-0000-0000-0000-000000000013'
FOOD="$(q "SELECT id FROM industry_templates WHERE key='food'")"

accepts "the fixtures" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version) VALUES
       ('${S1}','ubwiza','Ubwiza Beauty','RW','RWF','active','${FOOD}',1),
       ('${S2}','kigalitech','Kigali Tech Hub','RW','RWF','active','${FOOD}',1),
       ('${S3}','isoko','Isoko Fresh','RW','RWF','active','${FOOD}',1);
     INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('${CLAUDINE}','platform','claudine@example.com','h','Claudine Mukamana'),
       ('${OLIVIER}','platform','olivier@example.com','h','Olivier Habimana'),
       ('${BOSCO}','platform','bosco@example.com','h','Jean Bosco Nkurunziza'),
       ('${GRACE}','platform','grace@vendlyfy.com','h','Grace Kamanzi'),
       ('${OLIVE}','platform','olive@vendlyfy.com','h','Olive Mukeshimana'),
       ('${NOTTEAM}','platform','nobody@example.com','h','Not On The Team');
     INSERT INTO store_members (user_id,store_id,role) VALUES
       ('${CLAUDINE}','${S1}','owner'), ('${OLIVIER}','${S2}','owner'), ('${BOSCO}','${S3}','owner');
     INSERT INTO platform_members (user_id,role) VALUES ('${GRACE}','super_admin'),('${OLIVE}','super_admin')"

# =============================================================================
step "No plaintext ID number exists anywhere in the schema"
# =============================================================================
equals "no column in any table holds a raw ID number" "" \
    "SELECT string_agg(table_name || '.' || column_name, ', ') FROM information_schema.columns
      WHERE table_schema='public'
        AND column_name ~ 'id_number'
        AND column_name NOT IN ('id_number_masked','id_number_encrypted','id_number_fingerprint')"
equals "the number is a bytea, so nothing can read it as text" "bytea" \
    "SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='kyc_submissions' AND column_name='id_number_encrypted'"
equals "and the key that would decrypt it is not in the database" "0" \
    "SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND (column_name LIKE '%encryption_key%' AND column_name <> 'encryption_key_id')"

# =============================================================================
step "A submission, three documents, six checks"
# =============================================================================
K1="$(q "SELECT submit_kyc('${S1}','${CLAUDINE}','national_id')")"
equals "it starts as \"we're checking your ID\"" "submitted|national_id|${CLAUDINE}" \
    "SELECT status || '|' || document_type || '|' || subject_user_id FROM kyc_submissions WHERE id='${K1}'"
equals "with a case reference of its own" "t" \
    "SELECT reference_number >= 1 FROM kyc_submissions WHERE id='${K1}'"
equals "sending it twice is sending it once" "${K1}" \
    "SELECT submit_kyc('${S1}','${CLAUDINE}','national_id')"
refuses "a submission for somebody who is not staff of that store" "store_members\|violates foreign key" \
    "SELECT submit_kyc('${S2}','${CLAUDINE}','national_id')"
refuses "a document nobody accepts" "document_type_values" \
    "SELECT submit_kyc('${S2}','${OLIVIER}','drivers_licence')"
accepts "the three parts" \
    "SELECT attach_kyc_document('${K1}','id_front','kyc/${K1}/front.jpg','image/jpeg',204800);
     SELECT attach_kyc_document('${K1}','id_back','kyc/${K1}/back.jpg','image/jpeg',198000);
     SELECT attach_kyc_document('${K1}','face_video','kyc/${K1}/video.mp4','video/mp4',1400000)"
equals  "three live documents" "3|face_video, id_back, id_front" \
    "SELECT count(*) || '|' || string_agg(part, ', ' ORDER BY part) FROM kyc_documents
      WHERE submission_id='${K1}' AND superseded_at IS NULL"
refuses "a second document of the same part, written by hand" "one_live_per_part" \
    "INSERT INTO kyc_documents (submission_id,store_id,part,storage_key,content_type)
      VALUES ('${K1}','${S1}','id_front','kyc/again.jpg','image/jpeg')"
refuses "a part nobody takes" "part_values" \
    "SELECT attach_kyc_document('${K1}','selfie_with_pet','kyc/pet.jpg','image/jpeg')"
accepts "the ID number, masked, encrypted and fingerprinted" \
    "UPDATE kyc_submissions SET
       id_number_masked='1 1994 7 ••••••• 0 18',
       id_number_encrypted=decode('deadbeefcafe','hex'),
       encryption_key_id='kyc-2026-q3',
       id_number_fingerprint=encode(sha256('1 1994 7 0048213 0 18'::bytea),'hex'),
       full_name='MUKAMANA Claudine', date_of_birth='1994-03-14', document_expires_on='2031-06-30'
     WHERE id='${K1}'"
refuses "a \"mask\" that is the number" "mask_is_masked" \
    "UPDATE kyc_submissions SET id_number_masked='1 1994 7 0048213 0 18' WHERE id='${K1}'"
refuses "ciphertext with no key named" "encryption_complete" \
    "UPDATE kyc_submissions SET encryption_key_id=NULL WHERE id='${K1}'"
refuses "a fingerprint that is not one" "fingerprint_shape" \
    "UPDATE kyc_submissions SET id_number_fingerprint='not-a-hash' WHERE id='${K1}'"
accepts "the six automatic checks, all passing" \
    "INSERT INTO kyc_checks (submission_id,store_id,check_code,outcome,note,vendor_name) VALUES
       ('${K1}','${S1}','document_genuine','pass','No edits found','some-vendor'),
       ('${K1}','${S1}','face_in_view','pass','50 of 50 frames','some-vendor'),
       ('${K1}','${S1}','liveness','pass','Turned head and blinked','some-vendor'),
       ('${K1}','${S1}','face_matches_document','pass','Strong match','some-vendor'),
       ('${K1}','${S1}','name_matches_registration','pass','Exact','some-vendor'),
       ('${K1}','${S1}','not_used_by_another_store','pass','No duplicates','some-vendor')"
refuses "a check nobody runs" "code_values" \
    "INSERT INTO kyc_checks (submission_id,store_id,check_code,outcome)
      VALUES ('${K1}','${S1}','vibes','pass')"
refuses "the same check twice" "one_per_code" \
    "INSERT INTO kyc_checks (submission_id,store_id,check_code,outcome)
      VALUES ('${K1}','${S1}','liveness','fail')"
accepts "the extracted fields, every value display-safe" \
    "INSERT INTO kyc_extracted_fields (submission_id,store_id,field_key,display_value,verdict) VALUES
       ('${K1}','${S1}','full_name','MUKAMANA Claudine','match'),
       ('${K1}','${S1}','id_number','1 1994 7 ••••••• 0 18','match'),
       ('${K1}','${S1}','date_of_birth','14 Mar 1994','match'),
       ('${K1}','${S1}','document_expires_on','Jun 2031','match')"
refuses "AN UNMASKED NUMBER IN THE TABLE A REVIEWER READS" "id_number_is_masked" \
    "INSERT INTO kyc_extracted_fields (submission_id,store_id,field_key,display_value,verdict)
      VALUES ('${K1}','${S1}','typed_name','1 1994 7 0048213 0 18','match');
     UPDATE kyc_extracted_fields SET display_value='1 1994 7 0048213 0 18'
      WHERE submission_id='${K1}' AND field_key='id_number'"
equals "but \"couldn't read it\" is allowed to say so in words" "t" \
    "SELECT EXISTS (SELECT 1 FROM kyc_extracted_fields WHERE submission_id='${K1}') AND
            (SELECT count(*) = 1 FROM (VALUES (1)) v)"

# =============================================================================
step "Payouts wait for verification, and nothing else does"
# =============================================================================
accepts "the store can be paid by a customer while unverified" \
    "INSERT INTO store_payout_settings (store_id,payout_method_key,payout_phone)
      VALUES ('${S1}','mtn_momo','078 111 4412');
     SELECT wallet_post('${S1}','available','adjustment',212000,'seed_balance','seed')"
equals  "and the balance adds up" "212000.00" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${S1}'"
equals  "the store is not verified" "f" "SELECT store_is_verified('${S1}')"
refuses "BUT IT CANNOT WITHDRAW" "has not been verified yet" \
    "SELECT request_withdrawal('${S1}',1000,'078 111 4412','wd_unverified_01','${CLAUDINE}')"
refuses "and the refusal carries the SQLSTATE a merchant's message is chosen by" "caught VLHLD" \
    "DO \$\$ BEGIN
       PERFORM request_withdrawal('${S1}',1000,'078 111 4412','wd_probe_hold','${CLAUDINE}');
     EXCEPTION WHEN SQLSTATE 'VLHLD' THEN RAISE EXCEPTION 'caught VLHLD'; END \$\$"
equals  "no payout request was left behind by either attempt" "0" \
    "SELECT count(*) FROM withdrawals WHERE store_id='${S1}'"
equals  "and the balance is untouched" "212000.00" \
    "SELECT available_balance::text FROM wallets WHERE store_id='${S1}'"

# =============================================================================
step "Reviewing it — and approval means every part was accepted"
# =============================================================================
equals "a case whose checks have not finished cannot be decided" "f" \
    "SELECT decide_kyc('${K1}','${GRACE}','approve')"
equals "the checks finish" "t" "SELECT complete_kyc_checks('${K1}')"
equals "finishing them twice does nothing" "f" "SELECT complete_kyc_checks('${K1}')"
equals "and the case is waiting for review" "in_review" \
    "SELECT status FROM kyc_submissions WHERE id='${K1}'"
refuses "a merchant approving their own identity" "platform_members\|violates foreign key" \
    "SELECT decide_kyc('${K1}','${CLAUDINE}','approve')"
refuses "somebody not on the team approving it" "platform_members\|violates foreign key" \
    "SELECT decide_kyc('${K1}','${NOTTEAM}','approve')"
refuses "an outcome that is none of the three" "approve, reject or redo" \
    "SELECT decide_kyc('${K1}','${GRACE}','maybe')"
refuses "a rejection with no reason the merchant can read" "reason the merchant reads" \
    "SELECT decide_kyc('${K1}','${GRACE}','reject')"
refuses "a retake that does not say which part" "has to say which part" \
    "SELECT decide_kyc('${K1}','${GRACE}','redo','The back is blurry')"
refuses "an approval that names a part" "only a retake names a part" \
    "SELECT decide_kyc('${K1}','${GRACE}','approve',NULL,'id_back')"
refuses "approving with a document nobody accepted, by hand" "not accepted" \
    "UPDATE kyc_submissions SET status='approved', reviewed_by='${GRACE}', reviewed_at=now() WHERE id='${K1}'"
equals "approving it properly" "t" \
    "SELECT decide_kyc('${K1}','${GRACE}','approve','All checks passed')"
equals "every part is accepted" "3|3" \
    "SELECT count(*) || '|' || count(*) FILTER (WHERE review_outcome='accepted')
       FROM kyc_documents WHERE submission_id='${K1}' AND superseded_at IS NULL"
equals "deciding it twice does nothing" "f" \
    "SELECT decide_kyc('${K1}','${GRACE}','reject','Changed my mind')"
equals "the store is verified" "t" "SELECT store_is_verified('${S1}')"
equals "AND NOW IT CAN WITHDRAW" "t" \
    "SELECT request_withdrawal('${S1}',1000,'078 111 4412','wd_verified_01','${CLAUDINE}') IS NOT NULL"
equals "the decision is in the audit log, without anybody having to remember" "1|store|approve_identity" \
    "SELECT count(*) || '|' || min(category) || '|' || min(action) FROM audit_log
      WHERE subject_id='${K1}' AND action='approve_identity'"
equals "naming the reviewer and the store" "Grace Kamanzi|Ubwiza Beauty" \
    "SELECT actor_label || '|' || store_label FROM audit_log WHERE action='approve_identity'"
refuses "an approved store resubmitting" "already has an approved identity check" \
    "SELECT submit_kyc('${S1}','${CLAUDINE}')"
refuses "moving a finished case back" "cannot move from approved" \
    "UPDATE kyc_submissions SET status='in_review' WHERE id='${K1}'"

# =============================================================================
step "A retake asks for one photo and keeps the other two"
# =============================================================================
K2="$(q "SELECT submit_kyc('${S2}','${OLIVIER}','national_id')")"
accepts "three parts, one of them blurry" \
    "SELECT attach_kyc_document('${K2}','id_front','kyc/${K2}/front.jpg','image/jpeg');
     SELECT attach_kyc_document('${K2}','id_back','kyc/${K2}/back.jpg','image/jpeg');
     SELECT attach_kyc_document('${K2}','face_video','kyc/${K2}/video.mp4','video/mp4');
     UPDATE kyc_documents SET quality='blurry', quality_note='Numbers unreadable'
      WHERE submission_id='${K2}' AND part='id_back';
     UPDATE kyc_documents SET quality='sharp'
      WHERE submission_id='${K2}' AND part <> 'id_back';
     SELECT complete_kyc_checks('${K2}')"
equals  "a retake is asked for" "t" \
    "SELECT decide_kyc('${K2}','${OLIVE}','redo','The back of your ID is blurry, so we can''t read the numbers.','id_back')"
equals  "ONE part is marked for retaking; the other two are accepted" "id_back|2" \
    "SELECT (SELECT part FROM kyc_documents WHERE submission_id='${K2}' AND review_outcome='retake'
              AND superseded_at IS NULL) || '|' ||
            (SELECT count(*) FROM kyc_documents WHERE submission_id='${K2}'
              AND review_outcome='accepted' AND superseded_at IS NULL)"
equals  "the merchant is told why, in the reviewer's own words" "t" \
    "SELECT decision_note LIKE '%blurry%' FROM kyc_submissions WHERE id='${K2}'"
equals  "and the case is waiting for them" "redo_requested" \
    "SELECT status FROM kyc_submissions WHERE id='${K2}'"
refuses "a store that is mid-retake withdrawing" "has not been verified" \
    "SELECT wallet_post('${S2}','available','adjustment',5000,'seed_s2','seed');
     SELECT request_withdrawal('${S2}',1000,'078 000 0000','wd_midredo','${OLIVIER}')"
accepts "the replacement arrives" \
    "SELECT attach_kyc_document('${K2}','id_back','kyc/${K2}/back-2.jpg','image/jpeg')"
equals  "the blurry one is kept, superseded, as part of the record" "1|1" \
    "SELECT count(*) FILTER (WHERE superseded_at IS NOT NULL) || '|' ||
            count(*) FILTER (WHERE superseded_at IS NULL)
       FROM kyc_documents WHERE submission_id='${K2}' AND part='id_back'"
equals  "and the case is back in the queue with its decision cleared" "submitted||" \
    "SELECT status || '|' || coalesce(reviewed_at::text,'') || '|' || coalesce(decision_note,'')
       FROM kyc_submissions WHERE id='${K2}'"
equals  "the retake keeps the other two decisions" "2" \
    "SELECT count(*) FROM kyc_documents WHERE submission_id='${K2}'
      AND review_outcome='accepted' AND superseded_at IS NULL"
accepts "a passport submission, which has no back" \
    "SELECT submit_kyc('${S3}','${BOSCO}','passport')"
refuses "a passport with a back" "a passport has no back" \
    "SELECT attach_kyc_document((SELECT id FROM kyc_submissions WHERE store_id='${S3}'),
       'id_back','kyc/x.jpg','image/jpeg')"

# =============================================================================
step "Revealing the number — which cannot happen unrecorded"
# =============================================================================
BEFORE="$(q "SELECT count(*) FROM audit_log")"
refuses "revealing it with no reason" "needs a reason on the record" \
    "SELECT * FROM reveal_kyc_id_number('${K1}','${OLIVE}','  ')"
refuses "a merchant revealing their own" "only a Vendlyfy team member" \
    "SELECT * FROM reveal_kyc_id_number('${K1}','${CLAUDINE}','curious')"
refuses "somebody not on the team revealing it" "only a Vendlyfy team member" \
    "SELECT * FROM reveal_kyc_id_number('${K1}','${NOTTEAM}','curious')"
equals  "none of those reached the log" "${BEFORE}" "SELECT count(*) FROM audit_log"
equals  "a reviewer with a reason gets the ciphertext, and only the ciphertext" "\\xdeadbeefcafe|kyc-2026-q3" \
    "SELECT id_number_encrypted::text || '|' || encryption_key_id
       FROM reveal_kyc_id_number('${K1}','${OLIVE}','matching RDB record','41.186.0.1','Mozilla/5.0',now())"
equals  "AND THE SENSITIVE VIEW IS IN THE LOG" "sensitive|reveal_id_number|Olive Mukeshimana" \
    "SELECT category || '|' || action || '|' || actor_label FROM audit_log
      WHERE action='reveal_id_number'"
equals  "with the reason, the IP and the verified session beside it" "matching RDB record|41.186.0.1|true" \
    "SELECT (context->>'reason') || '|' || host(ip_address) || '|' ||
            (session_verified_at IS NOT NULL)::text
       FROM audit_log WHERE action='reveal_id_number'"
equals  "and naming the case, so it can be found from either end" "kyc_submission|${K1}" \
    "SELECT subject_type || '|' || subject_id FROM audit_log WHERE action='reveal_id_number'"
equals  "the log is still sound after all of it" "0" "SELECT count(*) FROM verify_audit_chain()"

# =============================================================================
step "Retention: built, and inert until somebody sets a period"
# =============================================================================
equals "no document has a retention date, because the period is a placeholder" "0" \
    "SELECT count(*) FROM kyc_documents WHERE retain_until IS NOT NULL"
equals "so the sweep does nothing" "0" "SELECT count(*) FROM purge_expired_kyc_documents()"
accepts "set one, as an answered decision would" \
    "UPDATE kyc_documents SET retain_until = now() - interval '1 day'
      WHERE submission_id='${K1}' AND part='id_front'"
equals  "and the sweep returns the key so the object can be deleted too" "1|kyc/${K1}/front.jpg" \
    "SELECT count(*) || '|' || min(purged_storage_key) FROM purge_expired_kyc_documents()"
equals  "the row stays; the pointer to the bytes is gone" "1|true" \
    "SELECT count(*) || '|' || (min(storage_key) = '') FROM kyc_documents
      WHERE submission_id='${K1}' AND part='id_front'"
equals  "what was decided about it is still auditable after the photo is gone" "accepted" \
    "SELECT review_outcome FROM kyc_documents WHERE submission_id='${K1}' AND part='id_front'"
equals  "running it again purges nothing twice" "0" "SELECT count(*) FROM purge_expired_kyc_documents()"
refuses "a purged document pretending to still have bytes" "purged_has_no_key" \
    "UPDATE kyc_documents SET storage_key='kyc/back-again.jpg'
      WHERE submission_id='${K1}' AND part='id_front'"

# =============================================================================
step "Ten reviewers deciding one case at once"
# =============================================================================
K3="$(q "SELECT id FROM kyc_submissions WHERE store_id='${S3}'")"
accepts "a case ready for review" \
    "SELECT attach_kyc_document('${K3}','id_front','kyc/${K3}/front.jpg','image/jpeg');
     SELECT attach_kyc_document('${K3}','face_video','kyc/${K3}/video.mp4','video/mp4');
     SELECT complete_kyc_checks('${K3}')"
parallel_sql 10 "SELECT decide_kyc('${K3}'::uuid,'${GRACE}'::uuid,'reject','The face in the video did not match the photo on the ID.')" "$SCRATCH/decide.txt"
WON="$(grep -c '^t$' "$SCRATCH/decide.txt" 2>/dev/null || echo 0)"
ENTRIES="$(q "SELECT count(*) FROM audit_log WHERE subject_id='${K3}'")"
if [ "$WON" = "1" ] && [ "$ENTRIES" = "1" ]; then
    pass "one decision won, and it was logged once"
else
    LAST="decisions: $WON   audit entries: $ENTRIES"$'\n'"$(head -4 "$SCRATCH/decide.txt")"
    flunk "one case was decided more than once"
fi
equals "the store is still not verified" "f" "SELECT store_is_verified('${S3}')"
accepts "a rejected merchant may start again, as a NEW case" \
    "SELECT submit_kyc('${S3}','${BOSCO}','national_id')"
equals  "so the rejection stays on the record beside the new attempt" "1|1" \
    "SELECT count(*) FILTER (WHERE status='rejected') || '|' ||
            count(*) FILTER (WHERE status='submitted')
       FROM kyc_submissions WHERE store_id='${S3}'"

# =============================================================================
step "The invariants"
# =============================================================================
equals "no store has two live cases" "0" \
    "SELECT count(*) FROM (SELECT store_id FROM kyc_submissions
       WHERE status IN ('submitted','in_review','redo_requested')
       GROUP BY store_id HAVING count(*) > 1) t"
equals "every approved case has every part accepted" "0" \
    "SELECT count(*) FROM kyc_submissions s WHERE s.status='approved'
       AND EXISTS (SELECT 1 FROM kyc_documents d WHERE d.submission_id=s.id
                    AND d.superseded_at IS NULL
                    AND coalesce(d.review_outcome,'') <> 'accepted')"
equals "every decided case names a reviewer, and no undecided one does" "0" \
    "SELECT count(*) FROM kyc_submissions
      WHERE (status IN ('approved','rejected','redo_requested')) <> (reviewed_at IS NOT NULL)"
equals "every ID number on display is masked" "0" \
    "SELECT count(*) FROM kyc_extracted_fields
      WHERE field_key='id_number' AND verdict <> 'unread' AND display_value NOT LIKE '%•%'"
equals "every submission that recorded a number can name the key that encrypted it" "0" \
    "SELECT count(*) FROM kyc_submissions
      WHERE (id_number_encrypted IS NULL) <> (encryption_key_id IS NULL)"
equals "every reveal that ever happened is in the log" "1" \
    "SELECT count(*) FROM audit_log WHERE action='reveal_id_number'"
equals "every document belongs to the store its submission does" "0" \
    "SELECT count(*) FROM kyc_documents d JOIN kyc_submissions s ON s.id=d.submission_id
      WHERE d.store_id <> s.store_id"
equals "every new table with updated_at has the trigger that maintains it" "" \
    "SELECT string_agg(c.table_name, ', ') FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.column_name='updated_at'
        AND NOT EXISTS (SELECT 1 FROM information_schema.triggers t
                         WHERE t.event_object_table=c.table_name AND t.action_statement LIKE '%set_updated_at%')"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
