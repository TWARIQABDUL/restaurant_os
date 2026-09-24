#!/usr/bin/env bash
#
# Schema acceptance tests — milestone 5 onward.
#
# Every rule §5.4 states is asserted here against a real database, and the
# expected-failure cases assert on the CONSTRAINT NAME rather than just on "it
# errored", so a test cannot pass because some unrelated rule fired.
#
# Runs in a throwaway database built from the migrations, so it also proves they
# apply to an empty database in order.
#
#   npm run db:test         runs this and every other db/scripts/test-*.sh
#   bash db/scripts/test-schema.sh   just this one

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_schema_test"
TEST_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${TEST_DB}"
PASSED=0
FAILED=0
LAST=""

cleanup() {
    psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
        -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

require_docker
[ "$(container_state)" = "running" ] || die "the database is not running. Run: npm run db:up"

pass()  { PASSED=$((PASSED + 1)); printf '  [pass] %s\n' "$1"; }
flunk() { FAILED=$((FAILED + 1)); printf '  [FAIL] %s\n' "$1" >&2; printf '%s\n' "$LAST" | sed 's/^/         | /' >&2; }

sql()  { LAST="$(psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$TEST_DB" -q -c "$1" 2>&1)"; }
q()    { psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$TEST_DB" -tAc "$1" 2>/dev/null || echo '?'; }

# accepts <description> <sql> — must succeed
accepts() { if sql "$2"; then pass "$1"; else flunk "$1 — expected it to be accepted"; fi; }

# refuses <description> <constraint-or-message> <sql> — must fail, naming that rule
refuses() {
    if sql "$3"; then
        flunk "$1 — it was ACCEPTED"
    elif printf '%s' "$LAST" | grep -q "$2"; then
        pass "$1"
    else
        flunk "$1 — refused, but not by '$2'"
    fi
}

# equals <description> <expected> <query>
equals() {
    local got; got="$(q "$3")"
    if [ "$got" = "$2" ]; then pass "$1"; else LAST="query: $3"$'\n'"got:   $got"$'\n'"want:  $2"; flunk "$1"; fi
}

printf '\nSchema acceptance tests\n'
info "database  : ${TEST_DB} (created and dropped by this script)"

step "Building the schema from the migrations"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" -c "CREATE DATABASE ${TEST_DB}" >/dev/null
if DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" >/dev/null 2>&1; then
    pass "V000 and V001 apply to an empty database"
else
    LAST="$(DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" 2>&1)"
    flunk "migrations did not apply"
    printf '\n%s\n' "$PASSED passed, $FAILED failed."
    exit 1
fi
equals "the five tables exist" "5" \
    "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('stores','users','store_members','platform_members','role_permissions')"

# =============================================================================
step "stores"
# =============================================================================
accepts "a well-formed store" \
    "INSERT INTO stores (id, slug, name, country, selling_currency, status) VALUES
     ('11111111-1111-1111-1111-111111111111','nyama-and-co','Nyama & Co.','RW','RWF','active')"
accepts "a second store" \
    "INSERT INTO stores (id, slug, name, country, selling_currency, status) VALUES
     ('22222222-2222-2222-2222-222222222222','inzu-threads','Inzu Threads','RW','RWF','active')"
refuses "a duplicate slug"            "stores_slug_key"          "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('nyama-and-co','Copycat','RW','RWF')"
refuses "an upper-case slug"          "stores_slug_format"       "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('Nyama','X','RW','RWF')"
refuses "a slug with a space"         "stores_slug_format"       "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('nyama co','X','RW','RWF')"
refuses "a slug with a leading hyphen" "stores_slug_format"      "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('-nyama','X','RW','RWF')"
refuses "a one-character slug"        "stores_slug_length"       "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('n','X','RW','RWF')"
refuses "a lower-case country"        "stores_country_format"    "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('x-store','X','rw','RWF')"
refuses "a two-letter currency"       "stores_currency_format"   "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('y-store','Y','RW','RW')"
refuses "an invented status"          "stores_status_values"     "INSERT INTO stores (slug,name,country,selling_currency,status) VALUES ('z-store','Z','RW','RWF','archived')"
refuses "a store slugged 'api' — it would shadow the API routes"   "stores_slug_not_reserved" \
    "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('api','Sneaky','RW','RWF')"
refuses "a store slugged 'admin'"                                  "stores_slug_not_reserved" \
    "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('admin','Sneaky','RW','RWF')"
refuses "a store slugged 'checkout'"                               "stores_slug_not_reserved" \
    "INSERT INTO stores (slug,name,country,selling_currency) VALUES ('checkout','Sneaky','RW','RWF')"
accepts "a custom domain" \
    "UPDATE stores SET custom_domain='shop.nyama.rw' WHERE slug='nyama-and-co'"
refuses "the same custom domain twice" "stores_custom_domain_key" \
    "UPDATE stores SET custom_domain='shop.nyama.rw' WHERE slug='inzu-threads'"
refuses "a custom domain with no dot"  "stores_custom_domain_format" \
    "UPDATE stores SET custom_domain='localhost' WHERE slug='inzu-threads'"

# =============================================================================
step "users — the scope discriminator"
# =============================================================================
accepts "a platform identity" \
    "INSERT INTO users (id,scope,email,password_hash,name) VALUES
     ('aaaaaaaa-0000-0000-0000-000000000001','platform','grace@example.com','hash','Grace I.')"
refuses "a platform identity with a store_id" "users_scope_store_agree" \
    "INSERT INTO users (scope,store_id,email,password_hash,name) VALUES
     ('platform','11111111-1111-1111-1111-111111111111','x@example.com','hash','X')"
refuses "a store identity with no store_id"   "users_scope_store_agree" \
    "INSERT INTO users (scope,email,password_hash,name) VALUES ('store','y@example.com','hash','Y')"
# Matched on the shared prefix: an unknown scope violates users_scope_values AND
# users_scope_store_agree at once, and which one Postgres reports first is not
# something a test should depend on. What matters is that a scope outside the two
# cannot be stored.
refuses "an invented scope"                   "users_scope_" \
    "INSERT INTO users (scope,email,password_hash,name) VALUES ('superuser','z@example.com','hash','Z')"
refuses "an address with no @"                "users_email_shape" \
    "INSERT INTO users (scope,email,password_hash,name) VALUES ('platform','not-an-address','hash','Z')"

step "users — one email, several accounts, and where that stops"
accepts "the same address as a customer of store A" \
    "INSERT INTO users (scope,store_id,email,password_hash,name) VALUES
     ('store','11111111-1111-1111-1111-111111111111','grace@example.com','other-hash','Grace I.')"
accepts "the same address as a customer of store B too" \
    "INSERT INTO users (scope,store_id,email,password_hash,name) VALUES
     ('store','22222222-2222-2222-2222-222222222222','grace@example.com','third-hash','Grace I.')"
equals  "so one address now has three accounts, each with its own password" "3" \
    "SELECT count(*) FROM users WHERE lower(email)='grace@example.com'"
refuses "a second platform identity for that address"        "users_platform_email_key" \
    "INSERT INTO users (scope,email,password_hash,name) VALUES ('platform','grace@example.com','hash','Impostor')"
refuses "the same address twice at ONE store"                "users_store_email_key" \
    "INSERT INTO users (scope,store_id,email,password_hash,name) VALUES
     ('store','11111111-1111-1111-1111-111111111111','grace@example.com','hash','Impostor')"
refuses "a case variant of a platform address"               "users_platform_email_key" \
    "INSERT INTO users (scope,email,password_hash,name) VALUES ('platform','GRACE@example.com','hash','Impostor')"
refuses "a case variant at the same store"                   "users_store_email_key" \
    "INSERT INTO users (scope,store_id,email,password_hash,name) VALUES
     ('store','11111111-1111-1111-1111-111111111111','Grace@Example.com','hash','Impostor')"

# =============================================================================
step "The case Auth's store picker draws"
# =============================================================================
accepts "Owner at Nyama & Co." \
    "INSERT INTO store_members (user_id,store_id,role) VALUES
     ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','owner')"
accepts "AND Manager at Inzu Threads — one person, two stores, two roles" \
    "INSERT INTO store_members (user_id,store_id,role) VALUES
     ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','manager')"
equals  "the store picker's query returns both" "owner@nyama-and-co,manager@inzu-threads" \
    "SELECT string_agg(m.role || '@' || s.slug, ',' ORDER BY m.created_at, s.slug)
       FROM store_members m JOIN stores s ON s.id = m.store_id
      WHERE m.user_id = 'aaaaaaaa-0000-0000-0000-000000000001'"
refuses "two roles for one person in one store" "store_members_pkey" \
    "INSERT INTO store_members (user_id,store_id,role) VALUES
     ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','manager')"

# =============================================================================
step "Privilege escalation the schema itself refuses"
# =============================================================================
CUSTOMER_ID="$(q "SELECT id FROM users WHERE scope='store' AND store_id='11111111-1111-1111-1111-111111111111' LIMIT 1")"
refuses "a store customer cannot be given a staff membership" "store_members_user_id_user_scope_fkey" \
    "INSERT INTO store_members (user_id,store_id,role) VALUES ('${CUSTOMER_ID}','11111111-1111-1111-1111-111111111111','admin')"
refuses "a store customer cannot be given a platform role"    "platform_members_user_id_user_scope_fkey" \
    "INSERT INTO platform_members (user_id,role) VALUES ('${CUSTOMER_ID}','super_admin')"
refuses "'customer' is not a staff role"                      "store_members_role_values" \
    "INSERT INTO store_members (user_id,store_id,role) VALUES
     ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','customer')"
refuses "'super_admin' is not a store role"                   "store_members_role_values" \
    "INSERT INTO store_members (user_id,store_id,role) VALUES
     ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','super_admin')"
refuses "a store role is not a platform role"                 "platform_members_role_values" \
    "INSERT INTO platform_members (user_id,role) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','admin')"
refuses "user_scope cannot be forged on a membership"         "store_members_user_is_platform_scoped" \
    "INSERT INTO store_members (user_id,user_scope,store_id,role) VALUES
     ('${CUSTOMER_ID}','store','11111111-1111-1111-1111-111111111111','admin')"
accepts "a platform identity CAN hold the platform role" \
    "INSERT INTO platform_members (user_id,role) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','super_admin')"

# =============================================================================
step "Referential integrity"
# =============================================================================
refuses "a store with customers cannot be deleted"  "violates foreign key constraint" \
    "DELETE FROM stores WHERE id='11111111-1111-1111-1111-111111111111'"
refuses "a membership in a store that does not exist" "store_members_store_id_fkey" \
    "INSERT INTO store_members (user_id,store_id,role) VALUES
     ('aaaaaaaa-0000-0000-0000-000000000001','99999999-9999-9999-9999-999999999999','manager')"
accepts "deleting a person removes their memberships (cascade)" \
    "INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('bbbbbbbb-0000-0000-0000-000000000002','platform','rider@example.com','hash','Eric M.');
     INSERT INTO store_members (user_id,store_id,role) VALUES
       ('bbbbbbbb-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','rider');
     DELETE FROM users WHERE id='bbbbbbbb-0000-0000-0000-000000000002'"
equals  "and the membership is gone with them" "0" \
    "SELECT count(*) FROM store_members WHERE user_id='bbbbbbbb-0000-0000-0000-000000000002'"

# =============================================================================
step "role_permissions — Auth's invite screen, verbatim"
# =============================================================================
equals "a manager can accept and update orders, assign riders, edit products and stock" \
    "orders.assign_rider,orders.read,orders.update,products.write,stock.write" \
    "SELECT string_agg(permission, ',' ORDER BY permission) FROM role_permissions WHERE scope='store' AND role='manager'"
equals "a manager cannot see payouts, the wallet or store settings" "0" \
    "SELECT count(*) FROM role_permissions WHERE scope='store' AND role='manager'
       AND permission IN ('wallet.read','payouts.request','settings.write')"
equals "an owner can" "3" \
    "SELECT count(*) FROM role_permissions WHERE scope='store' AND role='owner'
       AND permission IN ('wallet.read','payouts.request','settings.write')"
equals "an admin can too" "3" \
    "SELECT count(*) FROM role_permissions WHERE scope='store' AND role='admin'
       AND permission IN ('wallet.read','payouts.request','settings.write')"
equals "only super_admin creates stores and platform members" "super_admin" \
    "SELECT string_agg(DISTINCT role, ',') FROM role_permissions
      WHERE permission IN ('stores.create','platform_members.create')"
refuses "a malformed permission key" "role_permissions_permission_format" \
    "INSERT INTO role_permissions (scope,role,permission) VALUES ('store','owner','Orders Read')"
refuses "a typo'd role — the failure would otherwise be a manager who can do nothing" \
    "role_permissions_scope_role_coherent" \
    "INSERT INTO role_permissions (scope,role,permission) VALUES ('store','manger','orders.read')"
refuses "a platform role granted in store scope" "role_permissions_scope_role_coherent" \
    "INSERT INTO role_permissions (scope,role,permission) VALUES ('store','super_admin','stores.create')"
refuses "a store role granted in platform scope" "role_permissions_scope_role_coherent" \
    "INSERT INTO role_permissions (scope,role,permission) VALUES ('platform','owner','orders.read')"
accepts "'customer' is a recognised store role" \
    "INSERT INTO role_permissions (scope,role,permission) VALUES ('store','customer','orders.own_read')"
equals  "but it ships with no console permissions of its own" "1" \
    "SELECT count(*) FROM role_permissions WHERE role='customer'"

# =============================================================================
step "updated_at maintains itself"
# =============================================================================
accepts "touching a store" "UPDATE stores SET name='Nyama and Company' WHERE slug='nyama-and-co'"
equals  "its updated_at moved past created_at" "t" \
    "SELECT updated_at > created_at FROM stores WHERE slug='nyama-and-co'"
equals  "and the trigger exists on every table that carries the column" "4" \
    "SELECT count(DISTINCT c.relname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgfoid = 'set_updated_at'::regproc"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
