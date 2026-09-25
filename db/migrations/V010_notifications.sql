-- V010_notifications.sql
--
-- Milestone 9, fifth part. The notification inbox, the store-wide new-order alert,
-- and the per-device sound preference.
--
-- Notifications.dc.html is short and contains four decisions.
--
--   1. SOME NOTIFICATIONS ARE A BROADCAST, not a message to a person. The
--      new-order alert "shows on every signed-in screen at this store", while the
--      inbox has a per-person unread dot and a per-person "Mark all as read". So
--      one event, many readers, each with their own read state — which is §5.3's
--      eighth delta, recorded there as unresolved.
--
--   2. NOT EVERY MEMBER SEES EVERYTHING. "Payout sent · 212,000 RWF" is in the
--      same list as "New order", and §5.4 says a manager "can't see payouts, the
--      wallet or store settings". Who may see a kind of event is a property of the
--      KIND, so it lives on the type, not on every row.
--
--   3. THE WORDS ARE NOT STORED. "New order #1031 · 8,500 RWF" is the food
--      template's wording; a barber's says booking. §3's whole point is that
--      industries are configurations, so storing that sentence in English would
--      freeze one industry's vocabulary into every row. What is stored is the type
--      and the VALUES; the words come from t(key) at read time.
--
--   4. "SOUND IS OFF FOR THIS DEVICE." Per device, not per person — and with no
--      browser storage (§2.5), a device is a server-issued cookie and a row. This
--      settles one of the two small things Part 9 left open.
--
-- "Mark all as read" is a WATERMARK rather than a row per notification. It is both
-- cheaper and truer: the click says "everything up to now", not "these 200 rows",
-- and it keeps saying that about rows written a second later by a slow webhook.


-- =============================================================================
-- 1. notification_types
-- =============================================================================
-- Reference data, seeded from the board's own list. A type carries what is true of
-- every notification of that kind: who it is for, which roles may see it, where
-- tapping it goes, and which values the client needs to write the sentence.

CREATE TABLE notification_types (
    code                  text        PRIMARY KEY,

    -- Who it is written for. Referenced by notifications together with the code, so
    -- a staff-only kind cannot be delivered to a customer.
    audience              text        NOT NULL,

    -- Which store roles may see it, for audience = store_staff. Empty for a
    -- customer's own notifications, which are not role-filtered.
    visible_to_roles      text[]      NOT NULL DEFAULT '{}',

    -- The five the board colours with: blue informational, green good, red bad,
    -- amber wants attention, violet in progress.
    tone                  text        NOT NULL,

    -- Which subject column a notification of this kind must carry.
    subject               text        NOT NULL,

    -- Where tapping it goes, as a route template. The subject fills the parameter.
    route                 text        NOT NULL,

    -- The values the client needs to compose the sentence from the store's own
    -- vocabulary. Checked on every write, so a notification cannot render blank.
    required_payload_keys text[]      NOT NULL DEFAULT '{}',

    -- Whether the alert dialog is raised for it, not just an inbox row. Only the
    -- new order does that: "Chime repeats every 20 seconds until someone accepts".
    is_alert              boolean     NOT NULL DEFAULT false,

    description           text        NOT NULL,
    is_active             boolean     NOT NULL DEFAULT true,

    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT notification_types_audience_values
        CHECK (audience IN ('store_staff', 'customer')),
    CONSTRAINT notification_types_tone_values
        CHECK (tone IN ('info', 'good', 'bad', 'attention', 'progress')),
    CONSTRAINT notification_types_subject_values
        CHECK (subject IN ('order', 'complaint', 'review', 'withdrawal', 'store')),

    -- Roles are the ones store_members has, and only a staff broadcast has any.
    CONSTRAINT notification_types_roles_are_store_roles
        CHECK (visible_to_roles <@ ARRAY['owner', 'admin', 'manager', 'rider']::text[]),
    CONSTRAINT notification_types_roles_match_audience
        CHECK ((audience = 'store_staff') = (cardinality(visible_to_roles) > 0)),

    -- Only the store's own people get an interrupting alert; a customer does not.
    CONSTRAINT notification_types_alert_is_staff
        CHECK (NOT is_alert OR audience = 'store_staff'),

    CONSTRAINT notification_types_route_shape CHECK (route LIKE '/%'),

    -- Referenced by notifications (type_code, audience), which is what makes a
    -- staff notification addressed to a customer unrepresentable.
    CONSTRAINT notification_types_code_audience_key UNIQUE (code, audience)
);

COMMENT ON TABLE notification_types IS
    'The kinds of notification, seeded. A type says who may see it, which values the client needs and where it leads — so none of that is repeated on every row.';
COMMENT ON COLUMN notification_types.visible_to_roles IS
    'Whose inbox a store broadcast reaches. Payouts do not reach a manager, per Auth''s own description of the role.';

CREATE TRIGGER notification_types_set_updated_at BEFORE UPDATE ON notification_types
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The eight the board draws, in its own order.
INSERT INTO notification_types
    (code, audience, visible_to_roles, tone, subject, route, required_payload_keys, is_alert, description) VALUES
    ('order_placed', 'store_staff', '{owner,admin,manager}', 'info', 'order', '/app/orders',
     '{order_number,total_amount,customer_name}', true,
     'A new order is waiting to be accepted. The only kind that raises the alert dialog.'),

    ('order_picked_up', 'store_staff', '{owner,admin,manager}', 'progress', 'order', '/app/orders',
     '{order_number,rider_name}', false,
     'A rider has collected an order and is on the way.'),

    ('order_delivered', 'store_staff', '{owner,admin,manager}', 'good', 'order', '/app/orders',
     '{order_number,customer_name}', false,
     'An order reached the customer.'),

    ('order_declined', 'store_staff', '{owner,admin,manager}', 'bad', 'order', '/app/orders',
     '{order_number,actor_name,reason}', false,
     'A member of staff declined an order, with the reason they gave.'),

    ('complaint_filed', 'store_staff', '{owner,admin,manager}', 'attention', 'complaint', '/app/complaints',
     '{order_number,reason,customer_name}', false,
     'A customer filed a complaint against an order.'),

    ('review_posted', 'store_staff', '{owner,admin,manager}', 'attention', 'review', '/app/reviews',
     '{rating,product_name}', false,
     'A new review is live. Reviews go live straight away, so this is news, not a request.'),

    -- The two a manager must not see. §5.4: "can't see payouts, the wallet or
    -- store settings."
    ('payout_sent', 'store_staff', '{owner,admin}', 'good', 'withdrawal', '/app/money',
     '{amount,destination}', false,
     'A payout left for the merchant''s own account.'),

    ('identity_verified', 'store_staff', '{owner,admin}', 'info', 'store', '/app/money',
     '{}', false,
     'KYC came back approved and payouts are unlocked.');


-- =============================================================================
-- 2. notifications
-- =============================================================================

CREATE TABLE notifications (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Every notification belongs to a store, including a customer's: it is about
    -- something that happened at one.
    store_id        uuid        NOT NULL REFERENCES stores (id) ON DELETE CASCADE,

    type_code       text        NOT NULL,

    -- Carried from the type so the pair can be a foreign key. Derived, never
    -- passed in.
    audience        text        NOT NULL,

    -- The person, for a customer's own notification. NULL for a store broadcast,
    -- which every member holding one of the type's roles sees.
    user_id         uuid        REFERENCES users (id) ON DELETE CASCADE,

    -- THE VALUES, not the words. See the header.
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- The subject. Which one is required is the type's business; the composite keys
    -- keep every one of them inside this store.
    order_id        uuid,
    complaint_id    uuid,
    review_id       uuid,
    withdrawal_id   uuid,

    -- The same event notifies once. A webhook delivered twice, a retried request
    -- and a sweep that runs again all collide here.
    idempotency_key text        NOT NULL,

    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT notifications_audience_values
        CHECK (audience IN ('store_staff', 'customer')),

    -- A broadcast has no addressee; a personal notification has exactly one.
    CONSTRAINT notifications_addressee_matches_audience
        CHECK ((audience = 'customer') = (user_id IS NOT NULL)),

    CONSTRAINT notifications_payload_is_object
        CHECK (jsonb_typeof(payload) = 'object'),

    CONSTRAINT notifications_idempotency_key_shape
        CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),

    FOREIGN KEY (type_code, audience)
        REFERENCES notification_types (code, audience) ON DELETE RESTRICT,

    FOREIGN KEY (order_id, store_id)      REFERENCES orders (id, store_id) ON DELETE CASCADE,
    FOREIGN KEY (complaint_id, store_id)  REFERENCES complaints (id, store_id) ON DELETE CASCADE,
    FOREIGN KEY (review_id, store_id)     REFERENCES reviews (id, store_id) ON DELETE CASCADE,
    FOREIGN KEY (withdrawal_id)           REFERENCES withdrawals (id) ON DELETE CASCADE
);

COMMENT ON TABLE notifications IS
    'One row per event, not per reader. A store broadcast has no user_id and is filtered by the type''s roles; a customer''s own notification names them. The words are composed at read time from the type and the payload.';
COMMENT ON COLUMN notifications.payload IS
    'The values the sentence needs — order number, amount, a name. Never the sentence: that is the industry template''s, and it changes when a store changes template.';

CREATE UNIQUE INDEX notifications_store_idempotency_key
    ON notifications (store_id, idempotency_key);

-- Serves: the staff inbox, newest first, with keyset pagination on created_at
-- (§2.2). The store leads because a broadcast is read by store, not by person.
CREATE INDEX notifications_store_idx ON notifications (store_id, created_at DESC)
    WHERE audience = 'store_staff';

-- Serves: a customer's own inbox across their orders at one store.
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

-- The alert — "shows on every signed-in screen at this store" — is a read of
-- notifications_store_idx above, narrowed by the type's is_alert. It gets no index
-- of its own: a second (store_id, created_at DESC) WHERE audience = 'store_staff'
-- would be the same index under another name, which is exactly the redundancy §2.3
-- set out to remove from the old schema.

CREATE INDEX notifications_order_idx ON notifications (order_id) WHERE order_id IS NOT NULL;


-- A notification is written once and never rewritten. There is nothing on it that
-- could change: the read state is somebody else's row, and the words are not here.
CREATE FUNCTION notifications_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    RAISE EXCEPTION 'notifications is append-only (attempted % on notification %)', TG_OP, OLD.id
        USING HINT = 'Read state lives in notification_reads. An event that turned out differently is a new notification.';
END;
$init$;

CREATE TRIGGER notifications_no_update BEFORE UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION notifications_append_only();


-- The two things a row must agree with its type about: it carries the subject the
-- type names, and the payload has the keys the client will look for.
CREATE FUNCTION notifications_check_against_type() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_subject  text;
    v_keys     text[];
    v_audience text;
    v_active   boolean;
    v_missing  text;
    v_present  uuid;
BEGIN
    SELECT subject, required_payload_keys, audience, is_active
      INTO v_subject, v_keys, v_audience, v_active
      FROM notification_types WHERE code = NEW.type_code;

    IF NOT FOUND THEN
        -- The composite foreign key owns an unknown type. Leave audience as it came
        -- so that key reports it, rather than this trigger failing on a NULL.
        RETURN NEW;
    END IF;

    -- audience is derived from the type, never passed in.
    NEW.audience := v_audience;

    IF NOT v_active THEN
        RAISE EXCEPTION 'notification type % is switched off', NEW.type_code;
    END IF;

    -- notifications_payload_is_object owns a payload that is not an object. Bail
    -- out rather than reporting a missing key in something that could not have
    -- keys — the ? operator is simply false on an array, which would send whoever
    -- reads the error looking in the wrong place.
    IF jsonb_typeof(NEW.payload) <> 'object' THEN
        RETURN NEW;
    END IF;

    v_present := CASE v_subject
        WHEN 'order'      THEN NEW.order_id
        WHEN 'complaint'  THEN NEW.complaint_id
        WHEN 'review'     THEN NEW.review_id
        WHEN 'withdrawal' THEN NEW.withdrawal_id
        WHEN 'store'      THEN NEW.store_id
    END;

    IF v_present IS NULL THEN
        RAISE EXCEPTION 'a % notification is about a %, and none was given', NEW.type_code, v_subject
            USING HINT = 'See notification_types.subject for what each kind must name.';
    END IF;

    SELECT k INTO v_missing
      FROM unnest(v_keys) AS k
     WHERE NOT (NEW.payload ? k)
     ORDER BY k LIMIT 1;

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'a % notification needs % in its payload', NEW.type_code, v_missing
            USING HINT = 'The client composes the sentence from these values. A missing one renders as a blank.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER notifications_check_against_type BEFORE INSERT ON notifications
    FOR EACH ROW EXECUTE FUNCTION notifications_check_against_type();


-- =============================================================================
-- 3. Who has read what
-- =============================================================================
-- Two mechanisms, because the board has two gestures. Tapping one notification is
-- a row. "Mark all as read" is a watermark — a moment, not a set — which is why it
-- also covers a notification that arrives a second later while the click is in
-- flight, and why it costs one row instead of two hundred.

CREATE TABLE notification_reads (
    notification_id uuid        NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    read_at         timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (notification_id, user_id)
);

COMMENT ON TABLE notification_reads IS
    'One row per person per notification they opened. A broadcast read by one manager stays unread for the others, which is what the per-person dot means.';

-- Serves: the anti-join behind the unread count and the Unread tab.
CREATE INDEX notification_reads_user_idx ON notification_reads (user_id, notification_id);


CREATE TABLE notification_inbox_state (
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    store_id        uuid        NOT NULL REFERENCES stores (id) ON DELETE CASCADE,

    -- Everything created before this instant counts as read for this person, at
    -- this store. Set by "Mark all as read".
    all_read_before timestamptz,

    -- The last time they had the inbox open, for the alert's "since I last looked".
    last_seen_at    timestamptz,

    updated_at      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, store_id)
);

COMMENT ON TABLE notification_inbox_state IS
    'Per person, per store: the "mark all as read" watermark and when they last had the inbox open.';

CREATE TRIGGER notification_inbox_state_set_updated_at
    BEFORE UPDATE ON notification_inbox_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- 4. "Sound is off for this device"
-- =============================================================================
-- Per device, as the board says, and with no browser storage the device is a
-- server-issued cookie. A person signed in on the shop's counter tablet and on
-- their own phone can have the chime on one and off the other, which is the point:
-- the tablet is in the kitchen and the phone is at dinner.

CREATE TABLE notification_devices (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- The opaque value in the httpOnly cookie. Unguessable, because holding it is
    -- being this device.
    device_token  text        NOT NULL,

    -- What the person sees in a device list: "Chrome on Windows", "Counter tablet".
    label         text,

    sound_enabled boolean     NOT NULL DEFAULT true,

    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT notification_devices_token_shape
        CHECK (char_length(device_token) BETWEEN 20 AND 128)
);

COMMENT ON TABLE notification_devices IS
    'One row per device a person uses, identified by a server-issued cookie. Holds the per-device sound preference the design asks for, because there is no browser storage to hold it in.';

CREATE UNIQUE INDEX notification_devices_token_key ON notification_devices (device_token);
CREATE INDEX notification_devices_user_idx ON notification_devices (user_id, last_seen_at DESC);

CREATE TRIGGER notification_devices_set_updated_at BEFORE UPDATE ON notification_devices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- 5. The functions
-- =============================================================================

CREATE FUNCTION notify(
    p_store_id        uuid,
    p_type_code       text,
    p_idempotency_key text,
    p_payload         jsonb DEFAULT '{}'::jsonb,
    p_user_id         uuid  DEFAULT NULL,
    p_order_id        uuid  DEFAULT NULL,
    p_complaint_id    uuid  DEFAULT NULL,
    p_review_id       uuid  DEFAULT NULL,
    p_withdrawal_id   uuid  DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_id uuid;
BEGIN
    -- The same event notifies once, whichever caller got there first. audience is
    -- left out: the trigger takes it from the type.
    INSERT INTO notifications (store_id, type_code, audience, user_id, payload,
                               order_id, complaint_id, review_id, withdrawal_id,
                               idempotency_key)
         VALUES (p_store_id, p_type_code, 'store_staff', p_user_id,
                 COALESCE(p_payload, '{}'::jsonb),
                 p_order_id, p_complaint_id, p_review_id, p_withdrawal_id,
                 p_idempotency_key)
    ON CONFLICT (store_id, idempotency_key) DO NOTHING
      RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT id INTO v_id FROM notifications
         WHERE store_id = p_store_id AND idempotency_key = p_idempotency_key;
    END IF;

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION notify IS
    'Writes one notification, or returns the one this event already wrote. Idempotent per store key, so a webhook delivered twice does not chime twice.';


-- Whose inbox a notification is in. One definition, used by the inbox, the unread
-- count and the alert, so none of them can disagree about who sees what.
CREATE FUNCTION notification_is_for(p_notification_id uuid, p_user_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT EXISTS (
        SELECT 1
          FROM notifications n
          JOIN notification_types t ON t.code = n.type_code
         WHERE n.id = p_notification_id
           AND (
                -- Their own.
                n.user_id = p_user_id
                -- Or a broadcast at a store where they hold a role it reaches.
                OR (n.user_id IS NULL AND EXISTS (
                        SELECT 1 FROM store_members m
                         WHERE m.user_id = p_user_id
                           AND m.store_id = n.store_id
                           AND m.role = ANY (t.visible_to_roles)))
           )
    );
$init$;

COMMENT ON FUNCTION notification_is_for IS
    'Whether a person sees a notification: their own, or a broadcast at a store where their role is one the type reaches. The single answer to "can they see payouts".';


CREATE FUNCTION notification_inbox(
    p_user_id  uuid,
    p_store_id uuid,
    p_before   timestamptz DEFAULT NULL,
    p_before_id uuid       DEFAULT NULL,
    p_limit    integer     DEFAULT 20,
    p_unread_only boolean  DEFAULT false
)
    RETURNS TABLE (
        notification_id uuid,
        type_code       text,
        tone            text,
        route           text,
        payload         jsonb,
        order_id        uuid,
        complaint_id    uuid,
        review_id       uuid,
        withdrawal_id   uuid,
        is_unread       boolean,
        created_at      timestamptz
    )
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    -- Keyset pagination, per §2.2: an inbox grows, and OFFSET on a growing list
    -- skips rows that arrive while somebody is reading.
    --
    -- THE CURSOR IS THE WHOLE SORT KEY, (created_at, id), not the timestamp alone.
    -- Six notifications written by one transaction share its now() exactly, so a
    -- cursor of `created_at < :before` steps over all six at once and the reader
    -- never sees five of them. The pair is unique because id is.
    SELECT n.id, n.type_code, t.tone, t.route, n.payload,
           n.order_id, n.complaint_id, n.review_id, n.withdrawal_id,
           unread.yes, n.created_at
      FROM notifications n
      JOIN notification_types t ON t.code = n.type_code
      LEFT JOIN notification_inbox_state s
             ON s.user_id = p_user_id AND s.store_id = n.store_id
      CROSS JOIN LATERAL (
            SELECT NOT (
                       EXISTS (SELECT 1 FROM notification_reads r
                                WHERE r.notification_id = n.id AND r.user_id = p_user_id)
                    OR (s.all_read_before IS NOT NULL AND n.created_at <= s.all_read_before)
                   ) AS yes
      ) unread
     WHERE n.store_id = p_store_id
       AND notification_is_for(n.id, p_user_id)
       AND (p_before IS NULL
            OR (p_before_id IS NULL AND n.created_at < p_before)
            OR (p_before_id IS NOT NULL AND (n.created_at, n.id) < (p_before, p_before_id)))
       AND (NOT p_unread_only OR unread.yes)
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT greatest(p_limit, 1);
$init$;

COMMENT ON FUNCTION notification_inbox IS
    'One person''s inbox at one store, newest first. The cursor is (p_before, p_before_id) — the whole sort key, because rows written by one transaction share a timestamp. Unread means neither individually read nor covered by their mark-all watermark.';


CREATE FUNCTION unread_notification_count(p_user_id uuid, p_store_id uuid)
    RETURNS bigint
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT count(*)
      FROM notifications n
      LEFT JOIN notification_inbox_state s
             ON s.user_id = p_user_id AND s.store_id = n.store_id
     WHERE n.store_id = p_store_id
       AND notification_is_for(n.id, p_user_id)
       AND NOT EXISTS (SELECT 1 FROM notification_reads r
                        WHERE r.notification_id = n.id AND r.user_id = p_user_id)
       AND (s.all_read_before IS NULL OR n.created_at > s.all_read_before);
$init$;


CREATE FUNCTION mark_notification_read(p_notification_id uuid, p_user_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    -- Reading something addressed to somebody else is not a read; it is a bug
    -- worth hearing about.
    IF NOT notification_is_for(p_notification_id, p_user_id) THEN
        RAISE EXCEPTION 'notification % is not in %''s inbox', p_notification_id, p_user_id
            USING HINT = 'A broadcast reaches the roles its type names. See notification_is_for().';
    END IF;

    INSERT INTO notification_reads (notification_id, user_id)
         VALUES (p_notification_id, p_user_id)
    ON CONFLICT (notification_id, user_id) DO NOTHING;

    RETURN FOUND;
END;
$init$;


CREATE FUNCTION mark_all_notifications_read(p_user_id uuid, p_store_id uuid)
    RETURNS timestamptz
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_at timestamptz := now();
BEGIN
    INSERT INTO notification_inbox_state (user_id, store_id, all_read_before)
         VALUES (p_user_id, p_store_id, v_at)
    ON CONFLICT (user_id, store_id) DO UPDATE
       -- Never moves backwards: a second click cannot un-read anything.
       SET all_read_before = greatest(notification_inbox_state.all_read_before, v_at);

    RETURN v_at;
END;
$init$;

COMMENT ON FUNCTION mark_all_notifications_read IS
    'Moves the person''s watermark to now, at one store. Idempotent, and monotonic: it never uncovers something it already covered.';


CREATE FUNCTION set_device_sound(p_device_token text, p_user_id uuid, p_enabled boolean)
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    INSERT INTO notification_devices (user_id, device_token, sound_enabled)
         VALUES (p_user_id, p_device_token, p_enabled)
    ON CONFLICT (device_token) DO UPDATE
       SET sound_enabled = excluded.sound_enabled, last_seen_at = now()
     WHERE notification_devices.user_id = excluded.user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'device token does not belong to user %', p_user_id
            USING HINT = 'A device cookie identifies one person''s device. Issue a new one on sign-in.';
    END IF;
END;
$init$;

COMMENT ON FUNCTION set_device_sound IS
    'Turns the new-order chime on or off for ONE device. Refuses a token belonging to somebody else, so a stolen cookie cannot be reassigned by using it.';


-- =============================================================================
-- Recorded rather than invented
-- =============================================================================
-- 1. NOTHING HERE SENDS ANYTHING. These rows are the inbox and the in-app alert.
--    Email is SendGrid, already in the server; SMS has no provider at all (§5.3,
--    delta 10), and Messages.dc.html designs eleven SMS templates that cannot be
--    built until one is chosen. When it is, a delivery attempt is a row beside a
--    notification, not a column on it: one event can be shown in the inbox, sent
--    by SMS and emailed, each with its own outcome.
--
-- 2. THE CHIME'S REPEAT is not here either. "Chime repeats every 20 seconds until
--    someone accepts or opens it" is a rule about an order that is still pending,
--    which the client can see for itself from the order. Storing a "silenced until"
--    per person per order would be a second place for that truth.
--
-- 3. THE CUSTOMER SIDE has no types seeded, because Notifications is the merchant's
--    board and inventing a customer's wording here would be guessing. The audience
--    is in the schema and the composite key is ready for them; CustomerAccount adds
--    its own rows when milestone 18 reads that board.
