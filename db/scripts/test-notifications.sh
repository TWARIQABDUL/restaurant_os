#!/usr/bin/env bash
#
# Notifications acceptance tests — milestone 9, fifth part.
#
# The interesting half is not the inbox; it is WHO SEES WHAT. A store broadcast
# reaches several people at once, each with their own unread dot, and a manager
# must not see a payout. That rule has one definition in the schema, and this suite
# attacks it from both ends: a manager reading the payout notification, and the
# unread count that has to agree with the list.
#
# The second is that "mark all as read" is a watermark, not two hundred rows — so
# it has to cover a notification that arrives a moment later without covering one
# that arrives after the click.

. "$(dirname "$0")/_lib.sh"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DB="vendlyfy_notifications_test"
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

printf '\nNotifications acceptance tests\n'
info "database  : ${TEST_DB}"

step "Building the schema, one store, an owner, a manager, a rider and a customer"
psql_db "$OWNER_ROLE" "$OWNER_PASSWORD" "$DB_NAME" -q \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" -c "CREATE DATABASE ${TEST_DB}" >/dev/null
if DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" >/dev/null 2>&1; then
    pass "the migrations apply to an empty database"
else
    LAST="$(DATABASE_URL="$TEST_URL" bash "$SELF_DIR/migrate.sh" 2>&1)"; flunk "migrations did not apply"
    printf '\n%s\n' "$PASSED passed, $FAILED failed."; exit 1
fi

S1='11111111-0000-0000-0000-000000000001'
S2='22222222-0000-0000-0000-000000000002'
ALINE='aaaa0000-0000-0000-0000-000000000001'    # owner
PATRICK='aaaa0000-0000-0000-0000-000000000002'  # manager — must not see payouts
ERIC='aaaa0000-0000-0000-0000-000000000003'     # rider
OUTSIDER='aaaa0000-0000-0000-0000-000000000004' # staff at the other store
VENDLY='aaaa0000-0000-0000-0000-000000000005'   # Vendlyfy, who approves the identity check
SAND='bbbb0000-0000-0000-0000-000000000001'     # a customer
O1='eeee0000-0000-0000-0000-000000000001'
FOOD="$(q "SELECT id FROM industry_templates WHERE key='food'")"

accepts "the fixtures" \
    "INSERT INTO stores (id,slug,name,country,selling_currency,status,industry_template_id,industry_template_version) VALUES
       ('${S1}','nyama','Nyama & Co.','RW','RWF','active','${FOOD}',1),
       ('${S2}','inzu','Inzu Threads','RW','RWF','active','${FOOD}',1);
     INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('${ALINE}','platform','aline@example.com','h','Aline Uwase'),
       ('${PATRICK}','platform','patrick@example.com','h','Patrick Ishimwe'),
       ('${ERIC}','platform','eric@example.com','h','Eric Mugisha'),
       ('${OUTSIDER}','platform','olivier@example.com','h','Olivier Nzeyimana');
     INSERT INTO users (id,scope,store_id,email,password_hash,name) VALUES
       ('${SAND}','store','${S1}','sandrine@example.com','h','Sandrine Keza');
     INSERT INTO store_members (user_id,store_id,role) VALUES
       ('${ALINE}','${S1}','owner'), ('${PATRICK}','${S1}','manager'),
       ('${ERIC}','${S1}','rider'), ('${OUTSIDER}','${S2}','owner');
     INSERT INTO users (id,scope,email,password_hash,name) VALUES
       ('${VENDLY}','platform','team@vendlyfy.com','h','Vendlyfy Support');
     INSERT INTO platform_members (user_id,role) VALUES ('${VENDLY}','super_admin');
     INSERT INTO products (id,store_id,name,base_price,track_stock,status) VALUES
       ('cccc0000-0000-0000-0000-000000000001','${S1}','Grilled chicken',8500,false,'active');
     INSERT INTO product_variants (id,product_id,store_id,sku,is_default) VALUES
       ('dddd0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000001','${S1}','CHK',true);
     INSERT INTO orders (id,store_id,order_number,tracking_code,idempotency_key,customer_user_id,
        delivery_address,fulfilment_type,payment_method,currency,subtotal_amount)
      VALUES ('${O1}','${S1}',next_order_number('${S1}'),'trk_notify_00001','idem_notify_000001','${SAND}','Kimihurura','delivery','mtn_momo','RWF',8500);
     INSERT INTO order_items (order_id,store_id,variant_id,product_name,unit_price_amount,quantity)
      VALUES ('${O1}','${S1}','dddd0000-0000-0000-0000-000000000001','Grilled chicken',8500,1)"

verify_store "Nyama & Co." "${S1}" "${ALINE}" "${VENDLY}"

# =============================================================================
step "The eight kinds the board draws, seeded"
# =============================================================================
equals "eight types, all active" "8|8" \
    "SELECT count(*) || '|' || count(*) FILTER (WHERE is_active) FROM notification_types"
equals "exactly one of them raises the alert, and it is the new order" "order_placed" \
    "SELECT code FROM notification_types WHERE is_alert"
equals "the two money ones do not reach a manager" "identity_verified|payout_sent" \
    "SELECT string_agg(code,'|' ORDER BY code) FROM notification_types
      WHERE NOT ('manager' = ANY (visible_to_roles))"
equals "no type reaches a rider's inbox" "0" \
    "SELECT count(*) FROM notification_types WHERE 'rider' = ANY (visible_to_roles)"
refuses "a role the memberships do not have" "roles_are_store_roles" \
    "INSERT INTO notification_types (code,audience,visible_to_roles,tone,subject,route,description)
      VALUES ('x','store_staff','{accountant}','info','order','/app/orders','x')"
refuses "a staff broadcast nobody may see" "roles_match_audience" \
    "INSERT INTO notification_types (code,audience,tone,subject,route,description)
      VALUES ('x','store_staff','info','order','/app/orders','x')"
refuses "a customer type with a role filter" "roles_match_audience" \
    "INSERT INTO notification_types (code,audience,visible_to_roles,tone,subject,route,description)
      VALUES ('x','customer','{owner}','info','order','/app/orders','x')"
refuses "an alert that interrupts a customer" "alert_is_staff" \
    "INSERT INTO notification_types (code,audience,tone,subject,route,description,is_alert)
      VALUES ('x','customer','info','order','/app/orders','x',true)"
refuses "a tone nobody has a colour for" "tone_values" \
    "INSERT INTO notification_types (code,audience,visible_to_roles,tone,subject,route,description)
      VALUES ('x','store_staff','{owner}','puce','order','/app/orders','x')"

# =============================================================================
step "Writing one, which happens once however often it is asked for"
# =============================================================================
N1="$(q "SELECT notify('${S1}','order_placed','order_placed:${O1}',
     '{\"order_number\":1001,\"total_amount\":\"8500\",\"customer_name\":\"Aimable K.\"}'::jsonb,
     NULL,'${O1}')")"
equals "it is a store broadcast, addressed to nobody in particular" "store_staff|" \
    "SELECT audience || '|' || coalesce(user_id::text,'') FROM notifications WHERE id='${N1}'"
equals "the audience was taken from the type, not from the caller" "store_staff" \
    "SELECT audience FROM notifications WHERE id='${N1}'"
equals "the same event again hands back the same notification" "${N1}" \
    "SELECT notify('${S1}','order_placed','order_placed:${O1}',
       '{\"order_number\":1001,\"total_amount\":\"8500\",\"customer_name\":\"Aimable K.\"}'::jsonb,
       NULL,'${O1}')"
equals "so the chime sounds once" "1" "SELECT count(*) FROM notifications WHERE store_id='${S1}'"
equals "and no sentence was stored, only the values" "1001|Aimable K." \
    "SELECT (payload->>'order_number') || '|' || (payload->>'customer_name')
       FROM notifications WHERE id='${N1}'"
refuses "a notification with nothing to render from" "needs customer_name in its payload" \
    "SELECT notify('${S1}','order_placed','order_placed:missing_payload',
       '{\"order_number\":1002,\"total_amount\":\"1\"}'::jsonb, NULL,'${O1}')"
refuses "a new order that names no order" "and none was given" \
    "SELECT notify('${S1}','order_placed','order_placed:no_subject',
       '{\"order_number\":1,\"total_amount\":\"1\",\"customer_name\":\"x\"}'::jsonb)"
refuses "a kind nobody defined" "notifications_type_code" \
    "SELECT notify('${S1}','the_sky_is_falling','falling:0001','{}'::jsonb,NULL,'${O1}')"
refuses "a payload that is not an object" "payload_is_object" \
    "INSERT INTO notifications (store_id,type_code,audience,payload,order_id,idempotency_key)
      VALUES ('${S1}','order_placed','store_staff','[1,2]'::jsonb,'${O1}','hand_written_0001')"
refuses "editing one after the fact" "append-only" \
    "UPDATE notifications SET payload='{}'::jsonb WHERE id='${N1}'"
refuses "an order from another store" "notifications_order_id" \
    "SELECT notify('${S2}','order_placed','order_placed:cross_store',
       '{\"order_number\":1,\"total_amount\":\"1\",\"customer_name\":\"x\"}'::jsonb, NULL,'${O1}')"
refuses "a type that has been switched off" "switched off" \
    "UPDATE notification_types SET is_active=false WHERE code='order_delivered';
     SELECT notify('${S1}','order_delivered','delivered:${O1}',
       '{\"order_number\":1001,\"customer_name\":\"x\"}'::jsonb, NULL,'${O1}')"
accepts "switching it back on" \
    "UPDATE notification_types SET is_active=true WHERE code='order_delivered'"

# =============================================================================
step "Who sees a broadcast — the rule the manager's role depends on"
# =============================================================================
W1="$(q "WITH w AS (SELECT request_withdrawal('${S1}',0.00,'078 000 0000','never','${ALINE}') AS id) SELECT id FROM w" 2>/dev/null)"
accepts "a payout to notify about" \
    "SELECT wallet_post('${S1}','available','adjustment',212000,'seed_for_payout','seed');
     SELECT request_withdrawal('${S1}',212000,'078 111 4412','wd_payout_0001','${ALINE}')"
WD="$(q "SELECT id FROM withdrawals WHERE store_id='${S1}' AND idempotency_key='wd_payout_0001'")"
N2="$(q "SELECT notify('${S1}','payout_sent','payout:${WD}',
     '{\"amount\":\"212000\",\"destination\":\"MTN MoMo 078 ••• 4412\"}'::jsonb, NULL, NULL, NULL, NULL,'${WD}')")"
equals "the owner sees the new order" "t"  "SELECT notification_is_for('${N1}','${ALINE}')"
equals "so does the manager" "t"           "SELECT notification_is_for('${N1}','${PATRICK}')"
equals "the rider does not — no type reaches them" "f" \
    "SELECT notification_is_for('${N1}','${ERIC}')"
equals "the owner sees the payout" "t"     "SELECT notification_is_for('${N2}','${ALINE}')"
equals "THE MANAGER DOES NOT SEE THE PAYOUT" "f" \
    "SELECT notification_is_for('${N2}','${PATRICK}')"
equals "and neither does another store's owner" "false|false" \
    "SELECT notification_is_for('${N1}','${OUTSIDER}') || '|' || notification_is_for('${N2}','${OUTSIDER}')"
equals "a customer sees neither" "false|false" \
    "SELECT notification_is_for('${N1}','${SAND}') || '|' || notification_is_for('${N2}','${SAND}')"
equals "the owner's inbox has both" "2" \
    "SELECT count(*) FROM notification_inbox('${ALINE}','${S1}')"
equals "the manager's has only the order" "1|order_placed" \
    "SELECT count(*) || '|' || min(type_code) FROM notification_inbox('${PATRICK}','${S1}')"
equals "the rider's is empty" "0" "SELECT count(*) FROM notification_inbox('${ERIC}','${S1}')"
equals "the list and the unread count agree, for everyone" "0" \
    "SELECT count(*) FROM (VALUES ('${ALINE}'::uuid),('${PATRICK}'),('${ERIC}'),('${SAND}')) u(id)
      WHERE unread_notification_count(u.id,'${S1}')
         <> (SELECT count(*) FROM notification_inbox(u.id,'${S1}',NULL,NULL,500,true))"
refuses "the manager marking the payout read" "not in" \
    "SELECT mark_notification_read('${N2}','${PATRICK}')"
equals "which leaves no read row behind" "0" \
    "SELECT count(*) FROM notification_reads WHERE notification_id='${N2}'"

# =============================================================================
step "Unread is per person, even for one broadcast"
# =============================================================================
equals "both of them start unread for the owner" "2" \
    "SELECT unread_notification_count('${ALINE}','${S1}')"
equals "and the one is unread for the manager" "1" \
    "SELECT unread_notification_count('${PATRICK}','${S1}')"
equals "the owner opens the new order" "t" "SELECT mark_notification_read('${N1}','${ALINE}')"
equals "reading it twice changes nothing" "f" "SELECT mark_notification_read('${N1}','${ALINE}')"
equals "the owner is down to one unread" "1" \
    "SELECT unread_notification_count('${ALINE}','${S1}')"
equals "AND THE MANAGER'S DOT IS STILL THERE" "1" \
    "SELECT unread_notification_count('${PATRICK}','${S1}')"
equals "the owner's inbox says which one is still unread" "payout_sent" \
    "SELECT type_code FROM notification_inbox('${ALINE}','${S1}',NULL,NULL,20,true)"

# =============================================================================
step "\"Mark all as read\" is a moment, not two hundred rows"
# =============================================================================
MARK="$(q "SELECT mark_all_notifications_read('${ALINE}','${S1}')")"
equals "the owner is caught up" "0" "SELECT unread_notification_count('${ALINE}','${S1}')"
equals "and it took one row, not one per notification" "1|1" \
    "SELECT (SELECT count(*) FROM notification_inbox_state WHERE user_id='${ALINE}') || '|' ||
            (SELECT count(*) FROM notification_reads WHERE user_id='${ALINE}')"
equals "the manager is untouched" "1" "SELECT unread_notification_count('${PATRICK}','${S1}')"
accepts "a complaint arrives after the click" \
    "SELECT file_complaint('${O1}','arrived_late','Waited over an hour.','${SAND}')"
C1="$(q "SELECT id FROM complaints WHERE order_id='${O1}'")"
N3="$(q "SELECT notify('${S1}','complaint_filed','complaint:${C1}',
     '{\"order_number\":1001,\"reason\":\"arrived_late\",\"customer_name\":\"Sandrine K.\"}'::jsonb,
     NULL, NULL, '${C1}')")"
equals "which is unread, because the watermark was before it" "1" \
    "SELECT unread_notification_count('${ALINE}','${S1}')"
equals "a second mark-all never moves backwards" "t" \
    "SELECT mark_all_notifications_read('${ALINE}','${S1}') >= '${MARK}'::timestamptz"
equals "and the watermark on the row is the later one" "0" \
    "SELECT count(*) FROM notification_inbox_state
      WHERE user_id='${ALINE}' AND all_read_before < '${MARK}'::timestamptz"
equals "caught up again" "0" "SELECT unread_notification_count('${ALINE}','${S1}')"
equals "the manager sees the complaint too, and it is still unread" "2" \
    "SELECT unread_notification_count('${PATRICK}','${S1}')"

# =============================================================================
step "Keyset pagination, because an inbox grows while it is being read"
# =============================================================================
accepts "six more notifications" \
    "SELECT notify('${S1}','order_delivered','delivered:${O1}',
       '{\"order_number\":1001,\"customer_name\":\"Sandrine K.\"}'::jsonb,NULL,'${O1}');
     SELECT notify('${S1}','order_picked_up','picked:${O1}',
       '{\"order_number\":1001,\"rider_name\":\"Eric\"}'::jsonb,NULL,'${O1}');
     SELECT notify('${S1}','order_declined','declined:${O1}',
       '{\"order_number\":1001,\"actor_name\":\"Patrick\",\"reason\":\"out of stock\"}'::jsonb,NULL,'${O1}');
     SELECT notify('${S1}','identity_verified','kyc:${S1}','{}'::jsonb);
     SELECT notify('${S1}','order_delivered','delivered:second',
       '{\"order_number\":1002,\"customer_name\":\"Kevin M.\"}'::jsonb,NULL,'${O1}');
     SELECT notify('${S1}','complaint_filed','complaint:second',
       '{\"order_number\":1001,\"reason\":\"wrong_item\",\"customer_name\":\"Kevin M.\"}'::jsonb,NULL,NULL,'${C1}')"
equals "the owner has nine altogether" "9" \
    "SELECT count(*) FROM notification_inbox('${ALINE}','${S1}',NULL,NULL,500)"
equals "six of them share one timestamp, which is what breaks a naive cursor" "6" \
    "SELECT max(c) FROM (SELECT count(*) AS c FROM notifications WHERE store_id='${S1}'
                          GROUP BY created_at) t"
equals "a page of three is newest first" "3" \
    "SELECT count(*) FROM notification_inbox('${ALINE}','${S1}',NULL,NULL,3)"
equals "three pages of three cover all nine, with no overlap and nothing skipped" "9" \
    "WITH p1 AS (SELECT * FROM notification_inbox('${ALINE}','${S1}',NULL,NULL,3)),
          c1 AS (SELECT created_at, notification_id FROM p1 ORDER BY created_at, notification_id LIMIT 1),
          p2 AS (SELECT * FROM notification_inbox('${ALINE}','${S1}',
                   (SELECT created_at FROM c1),(SELECT notification_id FROM c1),3)),
          c2 AS (SELECT created_at, notification_id FROM p2 ORDER BY created_at, notification_id LIMIT 1),
          p3 AS (SELECT * FROM notification_inbox('${ALINE}','${S1}',
                   (SELECT created_at FROM c2),(SELECT notification_id FROM c2),3))
     SELECT count(DISTINCT notification_id) FROM
       (SELECT notification_id FROM p1 UNION ALL SELECT notification_id FROM p2
        UNION ALL SELECT notification_id FROM p3) all_pages"
equals "while a cursor of the timestamp alone reaches only six of the nine" "6" \
    "WITH p1 AS (SELECT * FROM notification_inbox('${ALINE}','${S1}',NULL,NULL,3)),
          p2 AS (SELECT * FROM notification_inbox('${ALINE}','${S1}',(SELECT min(created_at) FROM p1),NULL,500))
     SELECT count(DISTINCT notification_id) FROM
       (SELECT notification_id FROM p1 UNION ALL SELECT notification_id FROM p2) all_pages"
equals "the manager still cannot see the payout, however many pages there are" "0" \
    "SELECT count(*) FROM notification_inbox('${PATRICK}','${S1}',NULL,NULL,500)
      WHERE type_code IN ('payout_sent','identity_verified')"

# =============================================================================
step "Sound is off for THIS device"
# =============================================================================
TOK1='device_token_counter_tablet_0001'
TOK2='device_token_alines_own_phone_01'
accepts "the counter tablet turns the chime on" \
    "SELECT set_device_sound('${TOK1}','${ALINE}',true)"
accepts "and her own phone turns it off" \
    "SELECT set_device_sound('${TOK2}','${ALINE}',false)"
equals  "two devices, two answers, one person" "true|false" \
    "SELECT (SELECT sound_enabled FROM notification_devices WHERE device_token='${TOK1}') || '|' ||
            (SELECT sound_enabled FROM notification_devices WHERE device_token='${TOK2}')"
accepts "changing one back does not touch the other" \
    "SELECT set_device_sound('${TOK1}','${ALINE}',false)"
equals  "still two rows" "2" \
    "SELECT count(*) FROM notification_devices WHERE user_id='${ALINE}'"
refuses "somebody else using that device's cookie" "does not belong to user" \
    "SELECT set_device_sound('${TOK1}','${PATRICK}',true)"
equals  "and the device still belongs to whom it did" "${ALINE}" \
    "SELECT user_id FROM notification_devices WHERE device_token='${TOK1}'"
refuses "a token short enough to guess" "token_shape" \
    "SELECT set_device_sound('abc','${PATRICK}',true)"
refuses "two people holding one cookie" "notification_devices_token_key\|duplicate key" \
    "INSERT INTO notification_devices (user_id,device_token) VALUES ('${PATRICK}','${TOK1}')"

# =============================================================================
step "The same webhook, delivered ten times at once"
# =============================================================================
parallel_sql 10 "SELECT notify('${S1}'::uuid,'order_placed','order_placed:race',
  '{\"order_number\":1099,\"total_amount\":\"8500\",\"customer_name\":\"Race\"}'::jsonb,
  NULL,'${O1}'::uuid)" "$SCRATCH/notify.txt"
WROTE="$(q "SELECT count(*) FROM notifications WHERE idempotency_key='order_placed:race'")"
DISTINCT="$(sort -u "$SCRATCH/notify.txt" | grep -c '^[0-9a-f]' || echo 0)"
if [ "$WROTE" = "1" ] && [ "$DISTINCT" = "1" ]; then
    pass "one notification, and all ten callers were handed it"
else
    LAST="notifications: $WROTE   distinct ids: $DISTINCT"$'\n'"$(head -4 "$SCRATCH/notify.txt")"
    flunk "one event chimed more than once"
fi

step "Ten screens marking the same broadcast read at once"
parallel_sql 10 "SELECT mark_notification_read('${N3}'::uuid,'${PATRICK}'::uuid)" "$SCRATCH/read.txt"
WON="$(grep -c '^t$' "$SCRATCH/read.txt" 2>/dev/null || echo 0)"
ROWS="$(q "SELECT count(*) FROM notification_reads WHERE notification_id='${N3}' AND user_id='${PATRICK}'")"
if [ "$WON" = "1" ] && [ "$ROWS" = "1" ]; then
    pass "one read row, and nine callers told it was already read"
else
    LAST="wrote: $WON   rows: $ROWS"$'\n'"$(head -4 "$SCRATCH/read.txt")"
    flunk "a read was recorded more than once"
fi

# =============================================================================
step "The invariants"
# =============================================================================
equals "every notification's audience agrees with its type" "0" \
    "SELECT count(*) FROM notifications n JOIN notification_types t ON t.code=n.type_code
      WHERE n.audience <> t.audience"
equals "every broadcast is addressed to nobody and every personal one to somebody" "0" \
    "SELECT count(*) FROM notifications
      WHERE (audience='customer') <> (user_id IS NOT NULL)"
equals "every notification carries the subject its type names" "0" \
    "SELECT count(*) FROM notifications n JOIN notification_types t ON t.code=n.type_code
      WHERE CASE t.subject
              WHEN 'order' THEN n.order_id WHEN 'complaint' THEN n.complaint_id
              WHEN 'review' THEN n.review_id WHEN 'withdrawal' THEN n.withdrawal_id
              WHEN 'store' THEN n.store_id END IS NULL"
equals "every payload has the keys its type requires" "0" \
    "SELECT count(*) FROM notifications n JOIN notification_types t ON t.code=n.type_code,
            unnest(t.required_payload_keys) AS k
      WHERE NOT (n.payload ? k)"
equals "nobody has a read row for something they cannot see" "0" \
    "SELECT count(*) FROM notification_reads r WHERE NOT notification_is_for(r.notification_id, r.user_id)"
equals "every new table with updated_at has the trigger that maintains it" "" \
    "SELECT string_agg(c.table_name, ', ') FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.column_name='updated_at'
        AND NOT EXISTS (SELECT 1 FROM information_schema.triggers t
                         WHERE t.event_object_table=c.table_name AND t.action_statement LIKE '%set_updated_at%')"

# =============================================================================
printf '\n%s\n' "$PASSED passed, $FAILED failed."
[ "$FAILED" -eq 0 ] || exit 1
