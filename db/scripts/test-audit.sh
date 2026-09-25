#!/usr/bin/env bash
#
# Audit log acceptance tests — milestone 9, sixth part.
#
# The board promises entries "can't be edited or deleted, INCLUDING BY SUPER
# ADMINS". An append-only trigger alone cannot make that true, because the people
# it names can turn a trigger off — so the log is hash-chained, and this suite
# proves the chain by DOING exactly that: it disables the trigger, edits an entry,
# removes another, and forges a third, and checks that every one of them is
# reported. That is the only way to test a tamper-evident table.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_audit_test"
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

printf '\nAudit log acceptance tests\n'
info "database  : ${TEST_DB}"

step "Building the schema, the Vendlyfy team and two stores"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" -c "CREATE DATABASE ${TEST_DB}" >/dev/null
if DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" >/dev/null 2>&1; then
    pass "the migrations apply to an empty database"
else
    LAST="$(DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" 2>&1)"; flunk "migrations did not apply"
    printf '\n%s\n' "$PASSED passed, $FAILED failed."; exit 1
fi

S1='11111111-0000-0000-0000-000000000001'
GRACE='aaaa0000-0000-0000-0000-000000000001'   # Vendlyfy
OLIVE='aaaa0000-0000-0000-0000-000000000002'   # Vendlyfy
ALINE='aaaa0000-0000-0000-0000-000000000003'   # the merchant's owner
FOOD="$(q "SELECT id FROM industry_templates WHERE key='food'")"

accepts "the fixtures" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version)
       VALUES ('${S1}','nyama','Nyama & Co.','RW','RWF','active','${FOOD}',1);
     INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('${GRACE}','platform','grace@vendlyfy.com','h','Grace Kamanzi'),
       ('${OLIVE}','platform','olive@vendlyfy.com','h','Olive Mukeshimana'),
       ('${ALINE}','platform','aline@example.com','h','Aline Uwase');
     INSERT INTO store_members (user_id,store_id,role) VALUES ('${ALINE}','${S1}','owner');
     INSERT INTO platform_members (user_id,role) VALUES ('${GRACE}','super_admin'),('${OLIVE}','super_admin')"
equals "an empty log verifies, because there is nothing to be wrong" "0" \
    "SELECT count(*) FROM verify_audit_chain()"

# =============================================================================
step "Writing entries, which capture who and where"
# =============================================================================
A1="$(q "SELECT audit('config','publish_template','Published Fashion template v5 · new stores only','${GRACE}',NULL,'Changed: default attributes (added Material)')")"
equals "the first entry is number one and follows nothing" "1|" \
    "SELECT sequence || '|' || coalesce(previous_hash,'') FROM audit_log WHERE id='${A1}'"
equals "the actor's NAME was captured, not just their id" "Grace Kamanzi|super_admin" \
    "SELECT actor_label || '|' || actor_role FROM audit_log WHERE id='${A1}'"
equals "a platform-wide action names no store" "|" \
    "SELECT coalesce(store_id::text,'') || '|' || coalesce(store_label,'') FROM audit_log WHERE id='${A1}'"
A2="$(q "SELECT audit('sensitive','reveal_id_number','Revealed full ID number · Claudine Mukamana','${OLIVE}','${S1}',
     E'Case KYC-5521 · reason: “matching RDB record”\nIP 41.186.0.1 · Kigali',
     'kyc_submission','dddd0000-0000-0000-0000-000000000001','41.186.0.1','Mozilla/5.0',now(),
     '{\"case\":\"KYC-5521\",\"reason\":\"matching RDB record\",\"ticket\":4412}'::jsonb)")"
equals "the store's NAME was captured too" "Nyama & Co." \
    "SELECT store_label FROM audit_log WHERE id='${A2}'"
equals "it follows the first entry exactly" "t" \
    "SELECT (SELECT previous_hash FROM audit_log WHERE id='${A2}')
          = (SELECT entry_hash FROM audit_log WHERE id='${A1}')"
equals "the sensitive context is queryable, not only readable" "KYC-5521|4412|41.186.0.1" \
    "SELECT (context->>'case') || '|' || (context->>'ticket') || '|' || host(ip_address)
       FROM audit_log WHERE id='${A2}'"
equals "the subject is named without a foreign key to it" "kyc_submission" \
    "SELECT subject_type FROM audit_log WHERE id='${A2}'"
A3="$(q "SELECT audit('access','failed_sign_in','3 failed sign-ins · grace@[DOMAIN]',NULL,NULL,
     E'Sign-in paused for this account\nIP 102.22.0.1',NULL,NULL,'102.22.0.1',NULL,NULL,'{}'::jsonb)")"
equals "an event with nobody behind it is recorded as Unknown" "Unknown|" \
    "SELECT actor_label || '|' || coalesce(actor_id::text,'') FROM audit_log WHERE id='${A3}'"
accepts "the merchant's own owner can appear in it too" \
    "SELECT audit('money','confirm_cash','Confirmed cash 12,500 RWF · #1019','${ALINE}','${S1}')"
equals "captured with the role they hold AT THAT STORE" "owner" \
    "SELECT actor_role FROM audit_log WHERE action='confirm_cash'"
equals "four entries, an unbroken run from one" "4|1|4" \
    "SELECT count(*) || '|' || min(sequence) || '|' || max(sequence) FROM audit_log"
equals "and the chain verifies" "0" "SELECT count(*) FROM verify_audit_chain()"

# =============================================================================
step "What the log refuses to record"
# =============================================================================
refuses "a category the filter bar does not have" "category_values" \
    "SELECT audit('gossip','do_thing','Something happened','${GRACE}')"
refuses "an action code nobody could grep for" "action_shape" \
    "SELECT audit('config','Did A Thing!','Something happened','${GRACE}')"
refuses "an entry that says nothing" "summary_not_blank" \
    "SELECT audit('config','do_thing','   ','${GRACE}')"
refuses "a context that is not an object" "context_is_object" \
    "SELECT audit('config','do_thing','Something','${GRACE}',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'\"nope\"'::jsonb)"
refuses "half a subject" "subject_complete" \
    "SELECT audit('config','do_thing','Something','${GRACE}',NULL,NULL,'order')"
equals "none of which reached the log" "4" "SELECT count(*) FROM audit_log"
refuses "an action code long enough to be an essay" "action_shape" \
    "SELECT audit('config','$(printf 'a%.0s' {1..70})','Something','${GRACE}')"
equals "but an action nobody has heard of IS recorded — the log never refuses a new kind" "t" \
    "SELECT audit('store','froznicated_the_widget','A thing this schema has never heard of','${GRACE}','${S1}') IS NOT NULL"

# =============================================================================
step "Append-only, through the ordinary route"
# =============================================================================
refuses "editing an entry" "append-only" \
    "UPDATE audit_log SET summary='Nothing to see here' WHERE id='${A2}'"
refuses "deleting an entry" "append-only" "DELETE FROM audit_log WHERE id='${A2}'"
refuses "deleting the whole log" "append-only" "DELETE FROM audit_log"
refuses "reusing a sequence number" "audit_log_sequence_key\|duplicate key" \
    "INSERT INTO audit_log (sequence,category,action,summary,actor_label,previous_hash,entry_hash)
      VALUES (2,'config','do_thing','A second entry number two','Nobody',
              repeat('a',64), repeat('b',64))"
refuses "an entry that claims to be first but is not" "first_has_no_previous" \
    "INSERT INTO audit_log (sequence,category,action,summary,actor_label,entry_hash)
      VALUES (99,'config','do_thing','Following nothing','Nobody',repeat('c',64))"
refuses "a hash that is not one" "entry_hash_shape" \
    "INSERT INTO audit_log (sequence,category,action,summary,actor_label,previous_hash,entry_hash)
      VALUES (99,'config','do_thing','Bad hash','Nobody',repeat('a',64),'not-a-hash')"
refuses "deleting an administrator who has done things" "audit_log_actor_id_fkey\|violates foreign key" \
    "DELETE FROM users WHERE id='${OLIVE}'"
refuses "deleting a store with history" "violates foreign key" \
    "DELETE FROM stores WHERE id='${S1}'"

# =============================================================================
step "And now the part the chain exists for: tampering around the trigger"
# =============================================================================
# Everything below is done with the append-only trigger DISABLED, which is what
# somebody who owns the table can do. The chain has to notice anyway.
BEFORE="$(q "SELECT count(*) FROM audit_log")"
accepts "an administrator turns the trigger off, as they are able to" \
    "ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update"
accepts "and quietly rewrites what they did" \
    "UPDATE audit_log SET summary='Viewed a page' WHERE sequence=2"
equals  "the edit went through — the trigger is off" "Viewed a page" \
    "SELECT summary FROM audit_log WHERE sequence=2"
equals  "BUT THE CHAIN REPORTS IT, naming the entry" "1|2|true" \
    "SELECT count(*) || '|' || min(broken_sequence) || '|' || bool_and(problem LIKE '%changed since it was written%')
       FROM verify_audit_chain()"
accepts "putting it back exactly restores the chain" \
    "UPDATE audit_log SET summary='Revealed full ID number · Claudine Mukamana' WHERE sequence=2"
equals  "which verifies again" "0" "SELECT count(*) FROM verify_audit_chain()"
accepts "so they try removing the entry altogether" \
    "DELETE FROM audit_log WHERE sequence=2"
equals  "the row is gone" "$((BEFORE - 1))" "SELECT count(*) FROM audit_log"
equals  "AND THE GAP IS REPORTED, at the entry where the run jumps" "3|true" \
    "SELECT min(broken_sequence) || '|' ||
            bool_or(problem LIKE '%missing%') FROM verify_audit_chain()"
equals  "and so is the entry that no longer follows anything" "true" \
    "SELECT bool_or(problem LIKE '%the entry before it hashes to%')::text FROM verify_audit_chain()"
accepts "so they forge a replacement in the gap, with a plausible hash" \
    "INSERT INTO audit_log (sequence,category,action,summary,actor_label,previous_hash,entry_hash,created_at)
      SELECT 2,'store','viewed_page','Viewed a page','Olive Mukeshimana',
             (SELECT entry_hash FROM audit_log WHERE sequence=1),
             encode(sha256('a plausible looking hash'::bytea),'hex'), now()"
equals  "the forgery is in the table" "Viewed a page" \
    "SELECT summary FROM audit_log WHERE sequence=2"
equals  "AND IT IS CAUGHT: its own hash does not match its contents" "true" \
    "SELECT bool_or(broken_sequence=2 AND problem LIKE '%changed since it was written%')::text
       FROM verify_audit_chain()"
equals  "which breaks everything after it as well" "true" \
    "SELECT bool_or(broken_sequence=3)::text FROM verify_audit_chain()"
accepts "the trigger goes back on" \
    "ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update"
equals  "and the log is now permanently known to be tampered with" "true" \
    "SELECT (count(*) > 0)::text FROM verify_audit_chain()"
equals  "verifying from after the break reports nothing, which is how a pruned log works" "0" \
    "SELECT count(*) FROM verify_audit_chain(4)"

# =============================================================================
step "The chain under concurrency — ten entries at once"
# =============================================================================
accepts "a clean log to chain onto" \
    "ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;
     DELETE FROM audit_log;
     ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update"
parallel_sql 10 "SELECT audit('store','bulk_action','Entry from a racing connection','${GRACE}'::uuid,'${S1}'::uuid)" "$SCRATCH/race.txt"
WROTE="$(q "SELECT count(*) FROM audit_log")"
RUN="$(q "SELECT (count(*) = max(sequence) AND min(sequence) = 1)::text FROM audit_log")"
BROKEN="$(q "SELECT count(*) FROM verify_audit_chain()")"
if [ "$WROTE" = "10" ] && [ "$RUN" = "true" ] && [ "$BROKEN" = "0" ]; then
    pass "ten entries, numbered 1 to 10 with no gaps, and the chain verifies"
else
    LAST="entries: $WROTE   unbroken run: $RUN   breaks: $BROKEN"$'\n'"$(head -4 "$SCRATCH/race.txt")"
    flunk "concurrent writers broke the chain"
fi
equals "every entry links to exactly one predecessor" "0" \
    "SELECT count(*) FROM audit_log a WHERE a.sequence > 1
       AND a.previous_hash <> (SELECT entry_hash FROM audit_log b WHERE b.sequence = a.sequence - 1)"
equals "no two entries hash the same, even written in the same instant" "10" \
    "SELECT count(DISTINCT entry_hash) FROM audit_log"
equals "and they are ordered within the second they were written" "true" \
    "SELECT bool_and(ok)::text FROM (
       SELECT created_at >= lag(created_at) OVER (ORDER BY sequence) AS ok FROM audit_log) t
     WHERE ok IS NOT NULL"

# =============================================================================
step "The invariants"
# =============================================================================
equals "the log is sound" "0" "SELECT count(*) FROM verify_audit_chain()"
equals "every entry has a real category" "0" \
    "SELECT count(*) FROM audit_log WHERE category NOT IN ('sensitive','money','store','config','access')"
equals "every entry says who, even when that is nobody" "0" \
    "SELECT count(*) FROM audit_log WHERE btrim(actor_label) = ''"
equals "every recorded actor id still resolves to a user" "0" \
    "SELECT count(*) FROM audit_log a WHERE a.actor_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.actor_id)"
equals "the hash function is deterministic — recomputing every entry changes nothing" "0" \
    "SELECT count(*) FROM audit_log a WHERE a.entry_hash <> audit_entry_hash(
       a.previous_hash,a.sequence,a.category,a.action,a.summary,a.detail,a.actor_id,
       a.actor_label,a.actor_role,a.store_id,a.store_label,a.subject_type,a.subject_id,
       a.ip_address,a.user_agent,a.session_verified_at,a.context,a.created_at)"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
