#!/usr/bin/env bash
#
# The catalogue admin's schema — milestone 22, V024_catalogue_console.sql.
#
# V024 adds no function, so there is no narrative to test here, only three properties the editor stands on:
# an option group may belong to ONE product (so two products can each have a "Size"), the first photo IS the
# cover, and a product has at most eight photos. server/test/api/catalogue.test.ts covers the same tables
# through the endpoints; this suite is what holds against a writer that is not the API.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_catalogue_console_test"
TEST_URL="postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST_ADDR}:${HOST_PORT}/${TEST_DB}"
PASSED=0; FAILED=0; LAST=""

cleanup() {
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

STORE="aaaaaaaa-4000-4000-8000-000000000001"
SHIRT="cccccccc-4000-4000-8000-000000000001"
JEANS="cccccccc-4000-4000-8000-000000000002"
G_SHIRT="dddddddd-4000-4000-8000-000000000001"
G_JEANS="dddddddd-4000-4000-8000-000000000002"
G_SHARED="dddddddd-4000-4000-8000-000000000003"

printf '\nCatalogue admin schema tests\n'
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

accepts "a store with two products" \
    "INSERT INTO stores (id, slug, name, country, selling_currency, status) VALUES ('$STORE', 'catalogue-test', 'Catalogue Test', 'RW', 'RWF', 'active');
     INSERT INTO products (id, store_id, name, base_price, status, position) VALUES
          ('$SHIRT', '$STORE', 'Tee', 15000, 'active', 1), ('$JEANS', '$STORE', 'Jeans', 28000, 'active', 2)"

step "An option group that belongs to one product"
accepts "the tee has its own Size" \
    "INSERT INTO option_groups (id, store_id, product_id, name, select_mode) VALUES ('$G_SHIRT', '$STORE', '$SHIRT', 'Size', 'one')"
accepts "and so do the jeans — two products, one name, which V003's index alone refused" \
    "INSERT INTO option_groups (id, store_id, product_id, name, select_mode) VALUES ('$G_JEANS', '$STORE', '$JEANS', 'Size', 'one')"
refuses "but one product cannot have two with the same name, in any case" "option_groups_private_name_key" \
    "INSERT INTO option_groups (store_id, product_id, name, select_mode) VALUES ('$STORE', '$SHIRT', ' size ', 'one')"
accepts "a SHARED group may still be called Size — shared and private names are different namespaces" \
    "INSERT INTO option_groups (id, store_id, name, select_mode) VALUES ('$G_SHARED', '$STORE', 'Size', 'one')"
refuses "but two shared groups may not share a name (the index V003 had)" "option_groups_shared_name_key" \
    "INSERT INTO option_groups (store_id, name, select_mode) VALUES ('$STORE', 'SIZE', 'one')"
refuses "a private group cannot name a product from another store" "option_groups_private_product_fkey" \
    "INSERT INTO option_groups (store_id, product_id, name, select_mode) VALUES ('$STORE', 'cccccccc-4000-4000-8000-0000000000ff', 'Fit', 'one')"

accepts "the tee offers its own Size" \
    "INSERT INTO product_option_groups (product_id, option_group_id, store_id, position) VALUES ('$SHIRT', '$G_SHIRT', '$STORE', 1)"
refuses "the jeans cannot offer the TEE's Size" "belongs to product" \
    "INSERT INTO product_option_groups (product_id, option_group_id, store_id, position) VALUES ('$JEANS', '$G_SHIRT', '$STORE', 1)"
accepts "but both can offer the shared one" \
    "INSERT INTO product_option_groups (product_id, option_group_id, store_id, position) VALUES ('$SHIRT', '$G_SHARED', '$STORE', 2), ('$JEANS', '$G_SHARED', '$STORE', 2)"
refuses "an update cannot move an attachment onto another product's private group either" "belongs to product" \
    "UPDATE product_option_groups SET option_group_id = '$G_SHIRT' WHERE product_id = '$JEANS' AND option_group_id = '$G_SHARED'"

step "Photos: the first is the cover"
equals "no photos, no cover" "" "SELECT COALESCE(cover_image_url, '') FROM products WHERE id = '$SHIRT'"
accepts "two photos" \
    "INSERT INTO product_images (product_id, store_id, url, position) VALUES ('$SHIRT', '$STORE', '/api/media/a.png', 1), ('$SHIRT', '$STORE', '/api/media/b.png', 2)"
equals "the cover is the first" "/api/media/a.png" "SELECT cover_image_url FROM products WHERE id = '$SHIRT'"
accepts "swapping the order in one statement is not a duplicate position (the constraint is deferred)" \
    "UPDATE product_images SET position = 3 - position WHERE product_id = '$SHIRT'"
equals "and the cover follows" "/api/media/b.png" "SELECT cover_image_url FROM products WHERE id = '$SHIRT'"
accepts "removing the cover promotes the next" "DELETE FROM product_images WHERE product_id = '$SHIRT' AND url = '/api/media/b.png'"
equals "the survivor is the cover" "/api/media/a.png" "SELECT cover_image_url FROM products WHERE id = '$SHIRT'"
accepts "removing the last clears it" "DELETE FROM product_images WHERE product_id = '$SHIRT'"
equals "no photos, no cover again" "" "SELECT COALESCE(cover_image_url, '') FROM products WHERE id = '$SHIRT'"
refuses "an empty url is not a photo" "product_images_url_present" \
    "INSERT INTO product_images (product_id, store_id, url, position) VALUES ('$SHIRT', '$STORE', '  ', 1)"
refuses "a photo cannot be attached with another store's id" "violates foreign key" \
    "INSERT INTO product_images (product_id, store_id, url, position) VALUES ('$SHIRT', 'aaaaaaaa-4000-4000-8000-0000000000ff', '/x.png', 1)"

step "At most eight photos"
accepts "eight is fine" \
    "INSERT INTO product_images (product_id, store_id, url, position) SELECT '$SHIRT', '$STORE', '/p' || n || '.png', n FROM generate_series(1, 8) n"
refuses "a ninth is refused at commit" "already has 8 photos" \
    "INSERT INTO product_images (product_id, store_id, url, position) VALUES ('$SHIRT', '$STORE', '/p9.png', 9)"

step "Deleting a product takes its private groups and photos with it"
accepts "delete the tee's attachments, then the tee" \
    "DELETE FROM product_option_groups WHERE product_id = '$SHIRT'; DELETE FROM products WHERE id = '$SHIRT'"
equals "its private group is gone" "0" "SELECT count(*) FROM option_groups WHERE id = '$G_SHIRT'"
equals "its photos are gone" "0" "SELECT count(*) FROM product_images WHERE product_id = '$SHIRT'"
equals "the shared group and the jeans' own group are untouched" "2" "SELECT count(*) FROM option_groups WHERE id IN ('$G_SHARED', '$G_JEANS')"

printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ]
