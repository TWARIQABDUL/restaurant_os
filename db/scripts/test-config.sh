#!/usr/bin/env bash
#
# Config acceptance tests — milestone 6.
#
# The done-when is that the templates AdminIndustries draws are expressible as
# rows, so most of this asserts the SHIPPED data against the board rather than
# inserting fixtures: if the migration and the design disagree, that is the
# failure worth catching.
#
# The rest proves the rules hold — a published version cannot change, a store
# cannot pin a draft, an override cannot name a module that does not exist.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_config_test"
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
sql()   { LAST="$(psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$TEST_DB" -q -c "$1" 2>&1)"; }
q()     { psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$TEST_DB" -tAc "$1" 2>/dev/null || echo '?'; }
accepts() { if sql "$2"; then pass "$1"; else flunk "$1 — expected it to be accepted"; fi; }
refuses() {
    if sql "$3"; then flunk "$1 — it was ACCEPTED"
    elif printf '%s' "$LAST" | grep -q "$2"; then pass "$1"
    else flunk "$1 — refused, but not by '$2'"; fi
}
equals() {
    local got; got="$(q "$3")"
    if [ "$got" = "$2" ]; then pass "$1"; else LAST="query: $3"$'\n'"got:   $got"$'\n'"want:  $2"; flunk "$1"; fi
}

printf '\nConfig acceptance tests\n'
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

# =============================================================================
step "The eight templates AdminIndustries draws are rows"
# =============================================================================
equals "eight templates ship" "8" "SELECT count(*) FROM industry_templates"
equals "each has exactly one version" "8" \
    "SELECT count(*) FROM (SELECT template_id FROM industry_template_versions GROUP BY 1 HAVING count(*)=1) x"
equals "seven are published, Pharmacy is a draft" "published:7,draft:1" \
    "SELECT string_agg(status || ':' || n, ',' ORDER BY n DESC) FROM (SELECT status, count(*) n FROM industry_template_versions GROUP BY 1) x"
equals "the keys match the board" "beauty,electronics,fashion,food,furniture,grocery,pharmacy,services" \
    "SELECT string_agg(key, ',' ORDER BY key) FROM industry_templates"

step "Words — the same four keys, read differently"
equals "Food calls a product a Menu item, and its catalog a Menu" "Menu items|Menu|Sections|Extras" \
    "SELECT concat_ws('|', words->>'product', words->>'catalog', words->>'category', words->>'option')
       FROM industry_template_versions v JOIN industry_templates t ON t.id=v.template_id WHERE t.key='food'"
equals "Pharmacy calls one a Medicine" "Medicines|Shop|Sections|Pack sizes" \
    "SELECT concat_ws('|', words->>'product', words->>'catalog', words->>'category', words->>'option')
       FROM industry_template_versions v JOIN industry_templates t ON t.id=v.template_id WHERE t.key='pharmacy'"
equals "Services calls one a Service" "Services|Services|Categories|Add-ons" \
    "SELECT concat_ws('|', words->>'product', words->>'catalog', words->>'category', words->>'option')
       FROM industry_template_versions v JOIN industry_templates t ON t.id=v.template_id WHERE t.key='services'"
equals "every template fills all four word keys" "8" \
    "SELECT count(*) FROM industry_template_versions WHERE words ?& array['product','catalog','category','option']"

step "Modules"
equals "Food: priced extras and table ordering, no stock" "delivery,modifiers,pickup,table" \
    "SELECT string_agg(m.module_key, ',' ORDER BY m.module_key) FROM industry_template_version_modules m
       JOIN industry_templates t ON t.id=m.template_id WHERE t.key='food'"
equals "Fashion: stock, no modifiers" "delivery,pickup,stock" \
    "SELECT string_agg(m.module_key, ',' ORDER BY m.module_key) FROM industry_template_version_modules m
       JOIN industry_templates t ON t.id=m.template_id WHERE t.key='fashion'"
equals "Services: appointments and scheduling, and NO delivery or pickup" "appointments,modifiers,scheduled" \
    "SELECT string_agg(m.module_key, ',' ORDER BY m.module_key) FROM industry_template_version_modules m
       JOIN industry_templates t ON t.id=m.template_id WHERE t.key='services'"
equals "Furniture delivers but does not offer pickup" "0" \
    "SELECT count(*) FROM industry_template_version_modules m JOIN industry_templates t ON t.id=m.template_id
      WHERE t.key='furniture' AND m.module_key='pickup'"
equals "every module a template names exists in the registry" "0" \
    "SELECT count(*) FROM industry_template_version_modules m
      WHERE NOT EXISTS (SELECT 1 FROM modules r WHERE r.key=m.module_key)"

step "Pharmacy — a new industry without a redesign"
equals "its extra step sits between new and preparing" "new,pharmacist_check,preparing,ready,delivered" \
    "SELECT string_agg(s->>'key', ',' ORDER BY ord) FROM industry_template_versions v
       JOIN industry_templates t ON t.id=v.template_id,
       jsonb_array_elements(v.order_steps) WITH ORDINALITY AS a(s, ord)
      WHERE t.key='pharmacy'"
equals "the step carries its own label for the customer timeline" "Pharmacist check" \
    "SELECT s->>'label' FROM industry_template_versions v JOIN industry_templates t ON t.id=v.template_id,
       jsonb_array_elements(v.order_steps) AS a(s)
      WHERE t.key='pharmacy' AND s->>'key'='pharmacist_check'"
equals "it carries the prescription_required product flag" "prescription_required" \
    "SELECT f.flag_key FROM industry_template_version_product_flags f
       JOIN industry_templates t ON t.id=f.template_id WHERE t.key='pharmacy'"
equals "and the rx module that enables it" "1" \
    "SELECT count(*) FROM industry_template_version_modules m JOIN industry_templates t ON t.id=m.template_id
      WHERE t.key='pharmacy' AND m.module_key='rx'"
equals "no other template carries a product flag" "1" \
    "SELECT count(*) FROM industry_template_version_product_flags"

step "Order steps differ per industry, over one machine"
equals "Services begins at Booked, not New" "booked" \
    "SELECT v.order_steps->0->>'key' FROM industry_template_versions v
       JOIN industry_templates t ON t.id=v.template_id WHERE t.key='services'"
equals "Grocery picks, Furniture makes to order" "made_to_order|picking" \
    "SELECT concat_ws('|',
       (SELECT v.order_steps->1->>'key' FROM industry_template_versions v JOIN industry_templates t ON t.id=v.template_id WHERE t.key='furniture'),
       (SELECT v.order_steps->1->>'key' FROM industry_template_versions v JOIN industry_templates t ON t.id=v.template_id WHERE t.key='grocery'))"

# =============================================================================
step "What the registries refuse"
# =============================================================================
DRAFT_T="$(q "SELECT id FROM industry_templates WHERE key='pharmacy'")"
refuses "a module that does not exist" "industry_template_version_modules_module_key_fkey" \
    "INSERT INTO industry_template_version_modules (template_id,version,module_key) VALUES ('${DRAFT_T}',1,'stok')"
refuses "a product flag that does not exist" "industry_template_version_product_flags_flag_key_fkey" \
    "INSERT INTO industry_template_version_product_flags (template_id,version,flag_key) VALUES ('${DRAFT_T}',1,'needs_fridge')"

step "What the validators refuse"
accepts "a new template to experiment on" \
    "INSERT INTO industry_templates (id,key,name,accent_color) VALUES
     ('dddddddd-0000-0000-0000-000000000001','testing','Testing','#123ABC')"
refuses "a word key the platform does not have" "itv_words_valid" \
    "INSERT INTO industry_template_versions (template_id,version,words,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',1,'{\"prodcut\":\"X\"}','[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"}]')"
refuses "an empty word value" "itv_words_valid" \
    "INSERT INTO industry_template_versions (template_id,version,words,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',1,'{\"product\":\"  \"}','[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"}]')"
refuses "an attribute rule that is neither one nor several" "itv_attributes_valid" \
    "INSERT INTO industry_template_versions (template_id,version,words,attributes,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',1,'{\"product\":\"X\"}','[{\"name\":\"Size\",\"pick\":\"many\"}]','[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"}]')"
refuses "an attribute with a stray field" "itv_attributes_valid" \
    "INSERT INTO industry_template_versions (template_id,version,words,attributes,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',1,'{\"product\":\"X\"}','[{\"name\":\"Size\",\"pick\":\"one\",\"colour\":\"red\"}]','[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"}]')"
refuses "a duplicated order step key" "itv_order_steps_valid" \
    "INSERT INTO industry_template_versions (template_id,version,words,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',1,'{\"product\":\"X\"}','[{\"key\":\"new\",\"label\":\"New\"},{\"key\":\"new\",\"label\":\"Again\"}]')"
refuses "an order flow with only one step" "itv_order_steps_valid" \
    "INSERT INTO industry_template_versions (template_id,version,words,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',1,'{\"product\":\"X\"}','[{\"key\":\"new\",\"label\":\"New\"}]')"
refuses "an order step with no label" "itv_order_steps_valid" \
    "INSERT INTO industry_template_versions (template_id,version,words,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',1,'{\"product\":\"X\"}','[{\"key\":\"new\"},{\"key\":\"b\",\"label\":\"B\"}]')"
refuses "a published version with no publication time" "itv_published_at_agrees" \
    "INSERT INTO industry_template_versions (template_id,version,status,words,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',1,'published','{\"product\":\"X\"}','[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"}]')"

# =============================================================================
step "Versioning"
# =============================================================================
accepts "a draft on the new template" \
    "INSERT INTO industry_template_versions (template_id,version,words,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',1,'{\"product\":\"Thing\"}','[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"}]')"
refuses "a second draft for the same template" "itv_one_draft_per_template" \
    "INSERT INTO industry_template_versions (template_id,version,words,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',2,'{\"product\":\"Thing\"}','[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"}]')"
accepts "editing the draft" \
    "UPDATE industry_template_versions SET words='{\"product\":\"Widget\"}'
      WHERE template_id='dddddddd-0000-0000-0000-000000000001'"
refuses "publishing and rewriting in one step" "may not also change it" \
    "UPDATE industry_template_versions SET status='published', published_at=now(), words='{\"product\":\"Sneaky\"}'
      WHERE template_id='dddddddd-0000-0000-0000-000000000001'"
accepts "publishing what was reviewed" \
    "UPDATE industry_template_versions SET status='published', published_at=now()
      WHERE template_id='dddddddd-0000-0000-0000-000000000001'"
refuses "changing it afterwards" "cannot modify published template version" \
    "UPDATE industry_template_versions SET words='{\"product\":\"Changed\"}'
      WHERE template_id='dddddddd-0000-0000-0000-000000000001'"
refuses "deleting it afterwards" "cannot delete published template version" \
    "DELETE FROM industry_template_versions WHERE template_id='dddddddd-0000-0000-0000-000000000001'"
refuses "adding a module to it afterwards" "cannot change industry_template_version_modules of published" \
    "INSERT INTO industry_template_version_modules (template_id,version,module_key) VALUES
     ('dddddddd-0000-0000-0000-000000000001',1,'delivery')"
refuses "removing a module from a published version" "cannot change industry_template_version_modules of published" \
    "DELETE FROM industry_template_version_modules WHERE template_id=(SELECT id FROM industry_templates WHERE key='food')"
accepts "a second version can be drafted once the first is published" \
    "INSERT INTO industry_template_versions (template_id,version,words,order_steps) VALUES
     ('dddddddd-0000-0000-0000-000000000001',2,'{\"product\":\"Widget v2\"}','[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"}]')"

# =============================================================================
step "A store's configuration"
# =============================================================================
FOOD_T="$(q "SELECT id FROM industry_templates WHERE key='food'")"
accepts "a store" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status) VALUES
     ('eeeeeeee-0000-0000-0000-000000000001','nyama','Nyama & Co.','RW','RWF','active')"
accepts "pinning it to a published template version" \
    "UPDATE stores SET industry_template_id='${FOOD_T}', industry_template_version=1
      WHERE id='eeeeeeee-0000-0000-0000-000000000001'"
refuses "pinning it to Pharmacy, which is still a draft" "is not published" \
    "UPDATE stores SET industry_template_id='${DRAFT_T}', industry_template_version=1
      WHERE id='eeeeeeee-0000-0000-0000-000000000001'"
refuses "half a pin" "stores_template_pin_complete" \
    "UPDATE stores SET industry_template_version=NULL WHERE id='eeeeeeee-0000-0000-0000-000000000001'"
refuses "pinning to a version that does not exist" "stores_template_pin_fkey" \
    "UPDATE stores SET industry_template_id='${FOOD_T}', industry_template_version=99
      WHERE id='eeeeeeee-0000-0000-0000-000000000001'"
refuses "deleting a template a store is pinned to" "violates foreign key constraint" \
    "DELETE FROM industry_templates WHERE id='${FOOD_T}'"

step "Overrides — what a merchant changed in Settings"
accepts "turning a module off and renaming a word" \
    "UPDATE stores SET config_overrides='{\"modules\":{\"table\":false},\"words\":{\"category\":\"Aisles\"}}'
      WHERE id='eeeeeeee-0000-0000-0000-000000000001'"
refuses "overriding a module that does not exist" "unknown module" \
    "UPDATE stores SET config_overrides='{\"modules\":{\"stok\":true}}' WHERE id='eeeeeeee-0000-0000-0000-000000000001'"
refuses "a module override that is not true or false" "must be true or false" \
    "UPDATE stores SET config_overrides='{\"modules\":{\"stock\":\"yes\"}}' WHERE id='eeeeeeee-0000-0000-0000-000000000001'"
refuses "overriding a word the platform does not have" "not a valid word map" \
    "UPDATE stores SET config_overrides='{\"words\":{\"prodcut\":\"X\"}}' WHERE id='eeeeeeee-0000-0000-0000-000000000001'"
refuses "inventing a whole override section" "unknown config override section" \
    "UPDATE stores SET config_overrides='{\"theme\":{\"accent\":\"#fff\"}}' WHERE id='eeeeeeee-0000-0000-0000-000000000001'"
refuses "overrides that are not an object" "stores_config_overrides_is_object" \
    "UPDATE stores SET config_overrides='[]' WHERE id='eeeeeeee-0000-0000-0000-000000000001'"

step "The resolver's inputs are all reachable in one read"
equals "pinned words, overridden words, and the module set for one store" \
    "Menu items|Aisles|delivery,modifiers,pickup,table|table" \
    "SELECT concat_ws('|',
              v.words->>'product',
              s.config_overrides->'words'->>'category',
              (SELECT string_agg(m.module_key, ',' ORDER BY m.module_key)
                 FROM industry_template_version_modules m
                WHERE m.template_id = v.template_id AND m.version = v.version),
              (SELECT string_agg(k.key, ',') FROM jsonb_object_keys(s.config_overrides->'modules') AS k(key)))
       FROM stores s JOIN industry_template_versions v
              ON v.template_id = s.industry_template_id AND v.version = s.industry_template_version
      WHERE s.id='eeeeeeee-0000-0000-0000-000000000001'"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
