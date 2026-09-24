#!/usr/bin/env bash
#
# Acceptance tests for the migration runner — milestone 2's done-when:
# "the runner rejects a duplicate version, an out-of-order version, and an edited
# checksum — each demonstrated."
#
# These drive the real CLI against the real container, in a throwaway database,
# with throwaway migration directories. Nothing here touches the development
# database or db/migrations.
#
#   npm run db:test

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_migrate_test"
TEST_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${TEST_DB}"
WORK="$(mktemp -d)"
PASSED=0
FAILED=0
LAST_OUTPUT=""

cleanup() {
    rm -rf "$WORK"
    psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
        -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

require_docker
[ "$(container_state)" = "running" ] || die "the database is not running. Run: npm run db:up"

# --- harness -----------------------------------------------------------------

pass() { PASSED=$((PASSED + 1)); printf '  [pass] %s\n' "$1"; }
flunk() {
    FAILED=$((FAILED + 1))
    printf '  [FAIL] %s\n' "$1" >&2
    printf '%s\n' "$LAST_OUTPUT" | sed 's/^/         | /' >&2
}

# Each test gets its own migrations directory.
new_dir() { local d; d="$(mktemp -d "$WORK/mXXXXXX")"; printf '%s' "$d"; }

# CREATE DATABASE cannot run inside a transaction, so each statement gets its own
# -c: psql wraps a single multi-statement -c in one transaction.
fresh_db() {
    psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
        -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" \
        -c "CREATE DATABASE ${TEST_DB}" >/dev/null
}

# The runner, through its wrapper, against the test database. A short lock wait
# so the concurrency test does not take a minute.
migrate() {
    LAST_OUTPUT="$(DATABASE_URL="$TEST_URL" MIGRATE_LOCK_WAIT_SECONDS=2 \
        bash "$SELF_DIR/migrate.sh" "$@" 2>&1)"
}

tsql() { psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$TEST_DB" -tAc "$1" 2>/dev/null || echo '?'; }

expect_ok() {           # expect_ok <description> <migrate args...>
    local desc="$1"; shift
    if migrate "$@"; then pass "$desc"; else flunk "$desc — expected success, got failure"; fi
}

expect_fail() {         # expect_fail <description> <regex the message must match> <migrate args...>
    local desc="$1" pattern="$2"; shift 2
    if migrate "$@"; then
        flunk "$desc — expected failure, it succeeded"
    elif printf '%s' "$LAST_OUTPUT" | grep -qiE "$pattern"; then
        pass "$desc"
    else
        flunk "$desc — failed, but the message did not match /$pattern/"
    fi
}

expect_sql() {          # expect_sql <description> <expected> <sql>
    local desc="$1" want="$2" sql="$3" got
    got="$(tsql "$sql")"
    if [ "$got" = "$want" ]; then pass "$desc"
    else LAST_OUTPUT="query: $sql"$'\n'"got:   $got"$'\n'"want:  $want"; flunk "$desc"; fi
}

# --- fixtures ----------------------------------------------------------------

sql_table() { printf 'CREATE TABLE %s (id int PRIMARY KEY);\n' "$1"; }

printf '\nMigration runner acceptance tests\n'
info "database    : ${TEST_DB} (created and dropped by this script)"
info "runner      : db/scripts/migrate.ts"

# =============================================================================
step "Requirement 6 — apply, record, and never re-apply"
# =============================================================================
# Counted from the directory rather than hardcoded: this suite has to keep working
# as Stage B adds migrations, and "every file was recorded" is a stronger claim
# than "there is one row".
REAL_MIGRATIONS="$(find "$SELF_DIR/../migrations" -name 'V*.sql' | wc -l | tr -d ' ')"
fresh_db
expect_ok   "all $REAL_MIGRATIONS real migrations apply to an empty database" --dir "$SELF_DIR/../migrations"
expect_sql  "every one is recorded in the ledger" "$REAL_MIGRATIONS" "SELECT count(*) FROM schema_migrations"
expect_sql  "recorded as transactional" "t" "SELECT transactional FROM schema_migrations WHERE version = 0"
expect_sql  "V000 created set_updated_at()" "1" "SELECT count(*) FROM pg_proc WHERE proname = 'set_updated_at'"
expect_ok   "a second run applies nothing" --dir "$SELF_DIR/../migrations"
expect_sql  "still exactly $REAL_MIGRATIONS ledger rows" "$REAL_MIGRATIONS" "SELECT count(*) FROM schema_migrations"

# =============================================================================
step "Requirement 2 — duplicate versions"
# =============================================================================
fresh_db
D="$(new_dir)"
sql_table one > "$D/V001_first_claim.sql"
sql_table two > "$D/V001_second_claim.sql"
expect_fail "two files claiming V001 are rejected" "two migrations claim version 1" --dir "$D"
expect_fail "the message names the first file"  "V001_first_claim\.sql"  --dir "$D"
expect_fail "the message names the second file" "V001_second_claim\.sql" --dir "$D"

# =============================================================================
step "Requirement 4 — out-of-order application"
# =============================================================================
fresh_db
D="$(new_dir)"
sql_table late > "$D/V002_later.sql"
expect_ok   "V002 applies on its own" --dir "$D"
sql_table early > "$D/V001_arrives_after.sql"
expect_fail "a pending V001 below the applied V002 is refused" "below the highest applied \(2\)" --dir "$D"
expect_fail "the message names the offending file" "V001_arrives_after\.sql" --dir "$D"
expect_sql  "nothing extra was applied" "1" "SELECT count(*) FROM schema_migrations"

# =============================================================================
step "Requirement 5 — checksums"
# =============================================================================
fresh_db
D="$(new_dir)"
sql_table stable > "$D/V001_stable.sql"
expect_ok   "V001 applies" --dir "$D"
printf 'CREATE TABLE sneaked_in (id int);\n' >> "$D/V001_stable.sql"
expect_fail "editing an applied migration is refused" "changed after it was applied" --dir "$D"
expect_fail "the message names the file" "V001_stable\.sql" --dir "$D"
expect_sql  "the edit was not applied" "" "SELECT to_regclass('sneaked_in')::text"
LAST_OUTPUT=""
if migrate status --dir "$D"; then
    printf '%s' "$LAST_OUTPUT" | grep -q "CHANGED SINCE APPLIED" \
        && pass "status reports the drift" \
        || { flunk "status does not report the drift"; }
else flunk "status failed"; fi

# A file that is gone is the same class of disagreement.
rm "$D/V001_stable.sql"
expect_fail "an applied migration whose file is gone is refused" "file is gone" --dir "$D"

# =============================================================================
step "Filename and content validation"
# =============================================================================
D="$(new_dir)"; sql_table x > "$D/V1-bad-name.sql"
expect_fail "a filename off-convention is refused" "bad migration filename" --dir "$D"

D="$(new_dir)"; printf -- '-- nothing but a comment\n' > "$D/V001_empty.sql"
expect_fail "an empty migration is refused" "contains no statements" --dir "$D"

D="$(new_dir)"; printf 'BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;\n' > "$D/V001_own_transaction.sql"
expect_fail "a migration managing its own transaction is refused" "transaction control" --dir "$D"

# =============================================================================
step "Requirement 3 — numeric ordering, not lexicographic"
# =============================================================================
fresh_db
D="$(new_dir)"
sql_table applied_second > "$D/V10_ten.sql"
sql_table applied_first  > "$D/V2_two.sql"
expect_ok  "unpadded V2 and V10 both apply" --dir "$D"
expect_sql "V2 was applied before V10 — lexicographic order would have reversed them" \
    "2,10" "SELECT string_agg(version::text, ',' ORDER BY applied_at, version) FROM schema_migrations"

fresh_db
D="$(new_dir)"
sql_table a > "$D/V001_one.sql"; sql_table b > "$D/V005_five.sql"
expect_ok  "a gap in the numbering is fine" --dir "$D"
expect_sql "both applied" "2" "SELECT count(*) FROM schema_migrations"

# =============================================================================
step "Requirement 6 — a failure leaves nothing behind"
# =============================================================================
fresh_db
D="$(new_dir)"
cat > "$D/V001_fails_halfway.sql" <<'SQL'
CREATE TABLE created_before_the_error (id int PRIMARY KEY);
SELECT this_function_does_not_exist();
SQL
expect_fail "a failing migration reports the statement and line" "V001_fails_halfway\.sql:2 failed" --dir "$D"
expect_sql  "the first statement was rolled back" "" "SELECT to_regclass('created_before_the_error')::text"
expect_sql  "nothing was recorded" "0" "SELECT count(*) FROM schema_migrations"

# =============================================================================
step "Requirement 7 — opting out of the transaction"
# =============================================================================
fresh_db
D="$(new_dir)"
cat > "$D/V001_index_without_optout.sql" <<'SQL'
CREATE TABLE things (id int PRIMARY KEY, name text);
CREATE INDEX CONCURRENTLY things_name_idx ON things (name);
SQL
expect_fail "CREATE INDEX CONCURRENTLY without the directive is refused, with the fix" \
    "migrate:no-transaction" --dir "$D"

fresh_db
D="$(new_dir)"
sql_table things > "$D/V001_things.sql"
cat > "$D/V002_index_concurrently.sql" <<'SQL'
-- V002_index_concurrently.sql
--
-- migrate:no-transaction
CREATE INDEX CONCURRENTLY things_id_idx ON things (id);
SQL
expect_ok  "with the directive it applies" --dir "$D"
expect_sql "recorded as non-transactional" "f" "SELECT transactional FROM schema_migrations WHERE version = 2"
expect_sql "the index exists" "1" "SELECT count(*) FROM pg_indexes WHERE indexname = 'things_id_idx'"

# =============================================================================
step "The statement splitter"
# =============================================================================
fresh_db
D="$(new_dir)"
cat > "$D/V001_semicolons_everywhere.sql" <<'SQL'
-- a comment with a semicolon; and another;
CREATE TABLE quoted (id int PRIMARY KEY, label text);
INSERT INTO quoted (id, label) VALUES (1, 'a value; with a semicolon and a '' quote');
/* a block comment; with /* a nested one; */ still a comment; */
CREATE FUNCTION counts_as_one() RETURNS int LANGUAGE plpgsql AS $body$
DECLARE
    total int;
BEGIN
    SELECT count(*) INTO total FROM quoted;
    RETURN total;
END;
$body$;
SQL
expect_ok  "semicolons in comments, strings and a dollar-quoted body" --dir "$D"
expect_sql "the function was created whole" "1" "SELECT counts_as_one()"
expect_sql "the literal kept its semicolon and quote" "a value; with a semicolon and a ' quote" \
    "SELECT label FROM quoted WHERE id = 1"

# =============================================================================
step "Requirement 1 — the advisory lock"
# =============================================================================
fresh_db
D="$(new_dir)"; sql_table locked_out > "$D/V001_one.sql"
# A session that takes the lock and then sits on it.
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$TEST_DB" -q \
    -c "SELECT pg_advisory_lock(4820250924); SELECT pg_sleep(60);" >/dev/null 2>&1 &
for _ in $(seq 1 30); do
    [ "$(tsql "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted")" = "1" ] && break
    sleep 0.5
done
expect_fail "a second run refuses while another holds the lock" "holds the advisory lock" --dir "$D"
# The lock is taken before the ledger is created, so a blocked run leaves no trace
# at all — not an empty ledger, no ledger.
expect_sql  "it applied nothing, and created nothing" "" "SELECT to_regclass('schema_migrations')::text"

# Killing the backgrounded `docker compose exec` does NOT stop the psql process
# inside the container, and pg_advisory_unlock_all() only releases the calling
# session's locks. Terminate the holding backend instead.
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$TEST_DB" -q -tAc \
    "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted" \
    >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
    [ "$(tsql "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted")" = "0" ] && break
    sleep 0.5
done
wait 2>/dev/null || true
expect_ok   "and succeeds once the lock is released" --dir "$D"

# =============================================================================
step "status and --dry-run are read-only"
# =============================================================================
fresh_db
D="$(new_dir)"; sql_table untouched > "$D/V001_one.sql"
expect_ok  "status runs against a database with no ledger" status --dir "$D"
expect_sql "status did not create the ledger" "" "SELECT to_regclass('schema_migrations')::text"
expect_ok  "--dry-run runs" --dry-run --dir "$D"
expect_sql "--dry-run did not create the ledger" "" "SELECT to_regclass('schema_migrations')::text"
expect_sql "--dry-run applied nothing" "" "SELECT to_regclass('untouched')::text"

# =============================================================================
step "migrate new"
# =============================================================================
D="$(new_dir)"; sql_table a > "$D/V001_one.sql"; sql_table b > "$D/V007_seven.sql"
expect_ok "new claims the next number after the highest" new --dir "$D" "Add Product Variants!"
if [ -f "$D/V008_add_product_variants.sql" ]; then pass "V008_add_product_variants.sql was created"
else LAST_OUTPUT="$(ls -1 "$D")"; flunk "expected V008_add_product_variants.sql"; fi

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
