#!/usr/bin/env bash
#
# Catalogue acceptance tests — milestone 7.
#
# The three cases the plan asks for: a fashion product with 12 size x colour
# variants each carrying its own stock and SKU, a shared store-wide option group
# attached to two products, and a cart that survives a browser with storage
# disabled. Then the integrity rules, because a matrix that can be half-built is a
# storefront that sells something it cannot ship.
#
# Note on transactions: each sql() call is one psql -c, which Postgres runs as one
# transaction. That matters here — the matrix check is DEFERRABLE INITIALLY
# DEFERRED, so it fires at COMMIT and sees a variant together with its values.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_catalogue_test"
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

printf '\nCatalogue acceptance tests\n'
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

FASHION="$(q "SELECT id FROM industry_templates WHERE key='fashion'")"
FOOD="$(q "SELECT id FROM industry_templates WHERE key='food'")"
S1='11111111-0000-0000-0000-000000000001'   # Inzu Threads, fashion
S2='22222222-0000-0000-0000-000000000002'   # Nyama & Co., food
accepts "two stores, pinned to published templates" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version) VALUES
       ('${S1}','inzu','Inzu Threads','RW','RWF','active','${FASHION}',1),
       ('${S2}','nyama','Nyama & Co.','RW','RWF','active','${FOOD}',1)"

# =============================================================================
step "A fashion product with 12 size x colour variants"
# =============================================================================
P1='aaaa1111-0000-0000-0000-000000000001'
G_SIZE='bbbb1111-0000-0000-0000-000000000001'
G_COLOR='bbbb1111-0000-0000-0000-000000000002'
accepts "the product, its two single-select groups and their values" \
    "INSERT INTO products (id,store_id,name,base_price,track_stock,status) VALUES
       ('${P1}','${S1}','Linen tee',15000,true,'active');
     INSERT INTO option_groups (id,store_id,name,select_mode,position) VALUES
       ('${G_SIZE}','${S1}','Size','one',1), ('${G_COLOR}','${S1}','Color','one',2);
     INSERT INTO option_values (option_group_id,store_id,label,position) VALUES
       ('${G_SIZE}','${S1}','S',1), ('${G_SIZE}','${S1}','M',2), ('${G_SIZE}','${S1}','L',3), ('${G_SIZE}','${S1}','XL',4),
       ('${G_COLOR}','${S1}','Black',1), ('${G_COLOR}','${S1}','White',2), ('${G_COLOR}','${S1}','Sand',3);
     INSERT INTO product_option_groups (product_id,option_group_id,store_id,position) VALUES
       ('${P1}','${G_SIZE}','${S1}',1), ('${P1}','${G_COLOR}','${S1}',2)"

# Built the way the app will: one variant per combination, values attached in the
# same transaction so the deferred check sees each one whole.
accepts "the matrix — 4 sizes x 3 colours, each its own row" "
DO \$\$
DECLARE sz record; cl record; v uuid; n int := 0;
BEGIN
  FOR sz IN SELECT id,label FROM option_values WHERE option_group_id='${G_SIZE}' ORDER BY position LOOP
    FOR cl IN SELECT id,label FROM option_values WHERE option_group_id='${G_COLOR}' ORDER BY position LOOP
      n := n + 1;
      INSERT INTO product_variants (product_id,store_id,sku,stock_quantity,position)
        VALUES ('${P1}','${S1}',
                'TS-' || upper(substr(cl.label,1,3)) || '-' || upper(sz.label),
                n, n)
        RETURNING id INTO v;
      INSERT INTO product_variant_values (variant_id,product_id,option_group_id,option_value_id)
        VALUES (v,'${P1}','${G_SIZE}',sz.id), (v,'${P1}','${G_COLOR}',cl.id);
    END LOOP;
  END LOOP;
END \$\$;"
equals "twelve variants" "12" "SELECT count(*) FROM product_variants WHERE product_id='${P1}'"
equals "each carries its own stock — no two the same" "12" \
    "SELECT count(DISTINCT stock_quantity) FROM product_variants WHERE product_id='${P1}'"
equals "each carries its own SKU" "12" \
    "SELECT count(DISTINCT sku) FROM product_variants WHERE product_id='${P1}'"
equals "Black/M is one row, and its stock is its own" "TS-BLA-M|4" \
    "SELECT v.sku || '|' || v.stock_quantity FROM product_variants v
      WHERE v.product_id='${P1}'
        AND EXISTS (SELECT 1 FROM product_variant_values pv JOIN option_values o ON o.id=pv.option_value_id
                     WHERE pv.variant_id=v.id AND o.label='Black')
        AND EXISTS (SELECT 1 FROM product_variant_values pv JOIN option_values o ON o.id=pv.option_value_id
                     WHERE pv.variant_id=v.id AND o.label='M')"
equals "every variant names exactly two values" "12" \
    "SELECT count(*) FROM (SELECT variant_id FROM product_variant_values pv
       JOIN product_variants v ON v.id=pv.variant_id WHERE v.product_id='${P1}'
       GROUP BY variant_id HAVING count(*)=2) x"
equals "a variant's price is its base plus its deltas, computed not stored" "15000.00" \
    "SELECT (p.base_price + coalesce(sum(o.price_delta),0))::text FROM product_variants v
       JOIN products p ON p.id=v.product_id
       LEFT JOIN product_variant_values pv ON pv.variant_id=v.id
       LEFT JOIN option_values o ON o.id=pv.option_value_id
      WHERE v.sku='TS-BLA-M' GROUP BY p.base_price"

# =============================================================================
step "A shared store-wide option group attached to two products"
# =============================================================================
P2='aaaa2222-0000-0000-0000-000000000002'
P3='aaaa2222-0000-0000-0000-000000000003'
G_EXTRAS='bbbb2222-0000-0000-0000-000000000003'
accepts "two food products and one Extras group" \
    "INSERT INTO products (id,store_id,name,base_price,status) VALUES
       ('${P2}','${S2}','Chicken burger',3500,'active'), ('${P3}','${S2}','Beef burger',4000,'active');
     INSERT INTO option_groups (id,store_id,name,select_mode,is_required) VALUES
       ('${G_EXTRAS}','${S2}','Extras','several',false);
     INSERT INTO option_values (option_group_id,store_id,label,price_delta,position) VALUES
       ('${G_EXTRAS}','${S2}','Cheese',500,1), ('${G_EXTRAS}','${S2}','Fries',1000,2), ('${G_EXTRAS}','${S2}','Extra sauce',300,3);
     INSERT INTO product_option_groups (product_id,option_group_id,store_id) VALUES
       ('${P2}','${G_EXTRAS}','${S2}'), ('${P3}','${G_EXTRAS}','${S2}');
     INSERT INTO product_variants (product_id,store_id,is_default) VALUES
       ('${P2}','${S2}',true), ('${P3}','${S2}',true)"
equals "one group, two products, no copy" "1|2" \
    "SELECT count(DISTINCT option_group_id) || '|' || count(*) FROM product_option_groups WHERE option_group_id='${G_EXTRAS}'"
equals "both products read Cheese from the one shared row" "2|1|500.00" \
    "SELECT count(*) || '|' || count(DISTINCT o.id) || '|' || min(o.price_delta)::text
       FROM product_option_groups pog
       JOIN option_values o ON o.option_group_id=pog.option_group_id
      WHERE pog.option_group_id='${G_EXTRAS}' AND o.label='Cheese'"
equals "a 'pick several' group does NOT multiply into variants" "1|1" \
    "SELECT (SELECT count(*) FROM product_variants WHERE product_id='${P2}') || '|' ||
            (SELECT count(*) FROM product_variants WHERE product_id='${P3}')"
equals "those default variants name no combination at all" "0" \
    "SELECT count(*) FROM product_variant_values pv JOIN product_variants v ON v.id=pv.variant_id
      WHERE v.product_id IN ('${P2}','${P3}')"

# =============================================================================
step "Matrix integrity — what cannot be half-built"
# =============================================================================
refuses "a variant missing one of the product's dimensions" "do not name one value from each" \
    "INSERT INTO product_variants (id,product_id,store_id,stock_quantity) VALUES
       ('cccc0000-0000-0000-0000-000000000001','${P1}','${S1}',5);
     INSERT INTO product_variant_values (variant_id,product_id,option_group_id,option_value_id)
       SELECT 'cccc0000-0000-0000-0000-000000000001','${P1}','${G_SIZE}',id FROM option_values WHERE option_group_id='${G_SIZE}' AND label='S'"
refuses "a duplicate combination" "two variants with the same combination" \
    "INSERT INTO product_variants (id,product_id,store_id,stock_quantity) VALUES
       ('cccc0000-0000-0000-0000-000000000002','${P1}','${S1}',5);
     INSERT INTO product_variant_values (variant_id,product_id,option_group_id,option_value_id)
       SELECT 'cccc0000-0000-0000-0000-000000000002','${P1}',option_group_id,id FROM option_values
        WHERE (option_group_id='${G_SIZE}' AND label='M') OR (option_group_id='${G_COLOR}' AND label='Black')"
refuses "a variant built over a 'pick several' group" "are line add-ons and not variant dimensions" \
    "INSERT INTO product_variants (id,product_id,store_id) VALUES
       ('cccc0000-0000-0000-0000-000000000003','${P2}','${S2}');
     INSERT INTO product_variant_values (variant_id,product_id,option_group_id,option_value_id)
       SELECT 'cccc0000-0000-0000-0000-000000000003','${P2}','${G_EXTRAS}',id FROM option_values WHERE label='Cheese'"
refuses "a value filed under the wrong group" "product_variant_values_option_value_id_option_group_id_fkey" \
    "INSERT INTO product_variants (id,product_id,store_id,stock_quantity) VALUES
       ('cccc0000-0000-0000-0000-000000000004','${P1}','${S1}',1);
     INSERT INTO product_variant_values (variant_id,product_id,option_group_id,option_value_id)
       SELECT 'cccc0000-0000-0000-0000-000000000004','${P1}','${G_SIZE}',id FROM option_values WHERE label='Black'"
refuses "a tracked product with a variant that has no count" "need a count" \
    "INSERT INTO products (id,store_id,name,base_price,track_stock) VALUES
       ('aaaa3333-0000-0000-0000-000000000009','${S1}','Tracked',100,true);
     INSERT INTO product_variants (product_id,store_id,is_default) VALUES
       ('aaaa3333-0000-0000-0000-000000000009','${S1}',true)"
refuses "an untracked product carrying a count nobody maintains" "must not carry a count" \
    "INSERT INTO products (id,store_id,name,base_price,track_stock) VALUES
       ('aaaa3333-0000-0000-0000-00000000000a','${S1}','Untracked',100,false);
     INSERT INTO product_variants (product_id,store_id,stock_quantity,is_default) VALUES
       ('aaaa3333-0000-0000-0000-00000000000a','${S1}',7,true)"
refuses "two default variants on one product" "product_variants_one_default_per_product" \
    "INSERT INTO product_variants (product_id,store_id,is_default) VALUES ('${P2}','${S2}',true)"
refuses "negative stock" "product_variants_stock_not_negative" \
    "UPDATE product_variants SET stock_quantity=-1 WHERE sku='TS-BLA-M'"

step "Tenancy — a leak that would not announce itself"
refuses "attaching another store's option group to a product" "product_option_groups_option_group_id_store_id_fkey" \
    "INSERT INTO product_option_groups (product_id,option_group_id,store_id) VALUES ('${P1}','${G_EXTRAS}','${S1}')"
refuses "filing a product under another store's section" "product_categories_category_id_store_id_fkey" \
    "INSERT INTO categories (id,store_id,name) VALUES ('dddd0000-0000-0000-0000-000000000001','${S2}','Burgers');
     INSERT INTO product_categories (product_id,category_id,store_id) VALUES ('${P1}','dddd0000-0000-0000-0000-000000000001','${S1}')"
accepts "the same SKU in two different stores" \
    "INSERT INTO products (id,store_id,name,base_price,status) VALUES ('aaaa4444-0000-0000-0000-00000000000b','${S2}','Other',1,'draft');
     INSERT INTO product_variants (product_id,store_id,sku,is_default) VALUES ('aaaa4444-0000-0000-0000-00000000000b','${S2}','TS-BLA-M',true)"
refuses "the same SKU twice in one store" "product_variants_store_sku_key" \
    "UPDATE product_variants SET sku='TS-BLA-S' WHERE sku='TS-BLA-M' AND store_id='${S1}'"

step "Sections"
accepts "a product in two sections at once" \
    "INSERT INTO categories (id,store_id,name,position) VALUES
       ('dddd1111-0000-0000-0000-000000000002','${S2}','Burgers',1), ('dddd1111-0000-0000-0000-000000000003','${S2}','Lunch',2);
     INSERT INTO product_categories (product_id,category_id,store_id,position) VALUES
       ('${P2}','dddd1111-0000-0000-0000-000000000002','${S2}',1), ('${P2}','dddd1111-0000-0000-0000-000000000003','${S2}',1)"
accepts "deleting a section" "DELETE FROM categories WHERE id='dddd1111-0000-0000-0000-000000000003'"
equals  "its products stay in the catalogue" "1" "SELECT count(*) FROM products WHERE id='${P2}'"
equals  "they are just no longer in that section" "1" \
    "SELECT count(*) FROM product_categories WHERE product_id='${P2}'"
refuses "two sections with the same name in one store" "categories_store_name_key" \
    "INSERT INTO categories (store_id,name) VALUES ('${S2}','burgers')"

step "Product flags follow the industry template"
refuses "a prescription flag on a burger" "does not offer the product flag" \
    "INSERT INTO product_product_flags (product_id,store_id,flag_key) VALUES ('${P2}','${S2}','prescription_required')"
PHARM="$(q "SELECT id FROM industry_templates WHERE key='pharmacy'")"
accepts "publishing Pharmacy and opening a pharmacy" \
    "UPDATE industry_template_versions SET status='published', published_at=now() WHERE template_id='${PHARM}';
     INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version)
       VALUES ('33333333-0000-0000-0000-000000000003','ubuzima','Ubuzima Pharmacy','RW','RWF','active','${PHARM}',1);
     INSERT INTO products (id,store_id,name,base_price,status) VALUES
       ('aaaa5555-0000-0000-0000-00000000000c','33333333-0000-0000-0000-000000000003','Amoxicillin 500mg',4200,'active')"
accepts "the same flag on a medicine" \
    "INSERT INTO product_product_flags (product_id,store_id,flag_key) VALUES
       ('aaaa5555-0000-0000-0000-00000000000c','33333333-0000-0000-0000-000000000003','prescription_required')"
refuses "a flag that does not exist at all" "product_product_flags_flag_key_fkey" \
    "INSERT INTO product_product_flags (product_id,store_id,flag_key) VALUES
       ('aaaa5555-0000-0000-0000-00000000000c','33333333-0000-0000-0000-000000000003','needs_fridge')"

# =============================================================================
step "A cart that survives a browser with storage disabled"
# =============================================================================
SESSION='s_9f2b7c14e8a04d6fb3125ae7'
accepts "an anonymous cart, keyed only by a cookie the server issued" \
    "INSERT INTO carts (id,store_id,anonymous_session_id) VALUES
       ('eeee0000-0000-0000-0000-000000000001','${S2}','${SESSION}');
     INSERT INTO cart_items (id,cart_id,variant_id,store_id,quantity)
       SELECT 'ffff0000-0000-0000-0000-000000000001','eeee0000-0000-0000-0000-000000000001',v.id,'${S2}',2
         FROM product_variants v WHERE v.product_id='${P2}';
     INSERT INTO cart_item_option_values (cart_item_id,cart_id,option_value_id)
       SELECT 'ffff0000-0000-0000-0000-000000000001','eeee0000-0000-0000-0000-000000000001',id
         FROM option_values WHERE label IN ('Cheese','Extra sauce')"
equals "the whole cart reads back from the session id alone — nothing was client-side" \
    "Chicken burger|2|Cheese,Extra sauce" \
    "SELECT p.name || '|' || i.quantity || '|' || string_agg(o.label, ',' ORDER BY o.label)
       FROM carts c
       JOIN cart_items i ON i.cart_id = c.id
       JOIN product_variants v ON v.id = i.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN cart_item_option_values civ ON civ.cart_item_id = i.id
       LEFT JOIN option_values o ON o.id = civ.option_value_id
      WHERE c.anonymous_session_id = '${SESSION}'
      GROUP BY p.name, i.quantity"
equals "it is kept for seven days" "7" \
    "SELECT round(EXTRACT(epoch FROM expires_at - created_at) / 86400)::int FROM carts WHERE anonymous_session_id='${SESSION}'"
equals "and holds no prices, so checkout re-reads them" "0" \
    "SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('carts','cart_items','cart_item_option_values')
        AND (column_name LIKE '%price%' OR column_name LIKE '%total%' OR column_name LIKE '%amount%')"
accepts "a customer of the store, to own a cart" \
    "INSERT INTO users (id,scope,store_id,email,password_hash,name) VALUES
       ('99999999-0000-0000-0000-000000000009','store','${S2}','shopper@example.com','hash','Grace I.')"
refuses "a cart owned by both a customer and a session" "carts_one_owner" \
    "INSERT INTO carts (store_id,anonymous_session_id,user_id) VALUES ('${S2}','s_another_session_value_here',
       '99999999-0000-0000-0000-000000000009')"
refuses "a cart owned by neither" "carts_one_owner" "INSERT INTO carts (store_id) VALUES ('${S2}')"
refuses "a guessably short session id" "carts_session_id_length" \
    "INSERT INTO carts (store_id,anonymous_session_id) VALUES ('${S2}','abc')"
refuses "two carts for one session in one store" "carts_store_session_key" \
    "INSERT INTO carts (store_id,anonymous_session_id) VALUES ('${S2}','${SESSION}')"
accepts "the same session may have a cart at another store" \
    "INSERT INTO carts (store_id,anonymous_session_id) VALUES ('${S1}','${SESSION}')"
refuses "a line naming another store's variant" "cart_items_variant_id_store_id_fkey" \
    "INSERT INTO cart_items (cart_id,variant_id,store_id)
       SELECT 'eeee0000-0000-0000-0000-000000000001', v.id, '${S2}' FROM product_variants v WHERE v.product_id='${P1}' LIMIT 1"
refuses "a quantity of zero" "cart_items_quantity_positive" \
    "UPDATE cart_items SET quantity=0 WHERE id='ffff0000-0000-0000-0000-000000000001'"
accepts "emptying a cart removes its lines" "DELETE FROM carts WHERE id='eeee0000-0000-0000-0000-000000000001'"
equals  "and their option choices with them" "0" "SELECT count(*) FROM cart_item_option_values"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
