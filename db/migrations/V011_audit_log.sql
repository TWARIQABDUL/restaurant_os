-- V011_audit_log.sql
--
-- Milestone 9, sixth part. The platform's audit log.
--
-- AdminAudit.dc.html makes the strongest claim in the whole design about a table,
-- in its subheading: "Every admin action and every sensitive view. ENTRIES CAN'T BE
-- EDITED OR DELETED, INCLUDING BY SUPER ADMINS."
--
-- An append-only trigger is the ordinary answer and it is not enough for that
-- sentence, because the people it names are the ones who could turn a trigger off.
-- So this table does what wallet_ledger does for money: it CHAINS. Every entry
-- carries the hash of the one before it, and verify_audit_chain() reports the first
-- place the chain breaks. An entry that is edited, deleted or inserted in the
-- middle — by anybody, through any route, with every trigger disabled — leaves a
-- break that cannot be repaired without rewriting every entry after it.
--
-- That is the honest version of the promise. Nothing inside a database can stop
-- somebody with enough privilege from changing a row; what it can do is make the
-- change impossible to hide.
--
-- Three other decisions the board settles:
--
--   1. IT LOGS READS. "Revealed full ID number", "Viewed as merchant for 6 min" —
--      the most sensitive entries are not writes, so no trigger on another table
--      could produce them. The writer is the application, through audit(), and
--      that is a deliberate choice rather than an omission.
--
--   2. THE NAMES ARE CAPTURED. "Olive Mukeshimana", "Ubwiza Beauty". An entry is
--      evidence and must still read correctly after the account is closed and the
--      store is gone, so the label is copied in beside the id. The id is what a
--      query joins on; the label is what survives.
--
--   3. IT NEVER REFUSES AN ENTRY FOR BEING UNFAMILIAR. `action` is open text, not
--      a foreign key to a registry of known actions. A log that declines to record
--      something because nobody has declared it yet is worse than one with an
--      unrecognised code in it — the gap is the thing you would have wanted.


-- =============================================================================
-- 1. audit_log
-- =============================================================================

CREATE TABLE audit_log (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The chain's position. Global and gapless: a gap would be indistinguishable
    -- from a removed entry, which is the thing this exists to detect.
    sequence            bigint      NOT NULL,

    -- The board's five filters. Closed, because the filter bar is the filter bar.
    category            text        NOT NULL,

    -- What was done, as a stable code for querying. OPEN on purpose — see the
    -- header. Shape only: lower_snake_case, so it stays greppable.
    action              text        NOT NULL,

    -- The "What" column, in words: "Approved partial refund 3,000 of 12,500 RWF ·
    -- #1019". In English, unlike a notification: this is the platform's own record,
    -- read by the platform's own team, and it must read the same in ten years.
    summary             text        NOT NULL,

    -- The expandable block, as the board renders it — several lines of plain text.
    detail              text,

    -- WHO. The id for joining, the label for surviving. "Unknown" is a real value:
    -- the board's last row is three failed sign-ins with no account behind them.
    --
    -- RESTRICT, not SET NULL, and this is forced rather than chosen: an append-only
    -- table cannot have a SET NULL foreign key, because the cascade is an UPDATE and
    -- the trigger below refuses every UPDATE. Declaring SET NULL would produce the
    -- same refusal with a baffling message. So an administrator who has done things
    -- cannot be deleted from the database — they are deactivated, and if a person
    -- must genuinely be erased that is an anonymisation of their user row, which is
    -- a deliberate operation rather than a side effect of a DELETE.
    actor_id            uuid        REFERENCES users (id) ON DELETE RESTRICT,
    actor_label         text        NOT NULL,
    actor_role          text,

    -- WHICH STORE, or none: the board shows an em dash for platform-wide actions
    -- like publishing a template.
    store_id            uuid        REFERENCES stores (id) ON DELETE RESTRICT,
    store_label         text,

    -- WHAT IT WAS ABOUT. Deliberately NOT a foreign key, and the only table in this
    -- schema where that is the right answer: an audit entry must be able to name a
    -- row that has since been deleted, and to name kinds of thing that do not exist
    -- yet. A foreign key here would either block the deletion or erase the evidence.
    subject_type        text,
    subject_id          uuid,

    -- The context the board prints under a sensitive entry: "IP 41.186.x.x ·
    -- Kigali", "Session 2-step verified 13:02".
    ip_address          inet,
    user_agent          text,
    session_verified_at timestamptz,

    -- Everything else, queryable: a support ticket number, a KYC case reference,
    -- the reason given for revealing an ID.
    context             jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- The chain. previous_hash is NULL for the first entry only.
    previous_hash       text,
    entry_hash          text        NOT NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT audit_log_sequence_positive CHECK (sequence >= 1),
    CONSTRAINT audit_log_category_values CHECK (category IN (
        'sensitive', 'money', 'store', 'config', 'access')),
    CONSTRAINT audit_log_action_shape CHECK (action ~ '^[a-z][a-z0-9_]{2,63}$'),
    CONSTRAINT audit_log_summary_not_blank CHECK (btrim(summary) <> ''),
    CONSTRAINT audit_log_actor_label_not_blank CHECK (btrim(actor_label) <> ''),
    CONSTRAINT audit_log_context_is_object CHECK (jsonb_typeof(context) = 'object'),

    -- A subject is a type and an id together, or neither.
    CONSTRAINT audit_log_subject_complete
        CHECK ((subject_type IS NULL) = (subject_id IS NULL)),

    -- Hex sha256.
    CONSTRAINT audit_log_entry_hash_shape CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT audit_log_previous_hash_shape
        CHECK (previous_hash IS NULL OR previous_hash ~ '^[0-9a-f]{64}$'),
    -- Only the first entry has nothing before it.
    CONSTRAINT audit_log_first_has_no_previous
        CHECK ((sequence = 1) = (previous_hash IS NULL)),

    CONSTRAINT audit_log_sequence_key UNIQUE (sequence),
    CONSTRAINT audit_log_entry_hash_key UNIQUE (entry_hash)
);

COMMENT ON TABLE audit_log IS
    'Every admin action and every sensitive view, chained by hash so that editing or removing an entry is detectable even by somebody who can turn the triggers off.';
COMMENT ON COLUMN audit_log.action IS
    'A stable code for querying, open by design: the log never refuses an entry because nobody declared its kind yet.';
COMMENT ON COLUMN audit_log.subject_type IS
    'What the entry is about, as loose text and an id rather than a foreign key — the one place in this schema where that is correct. Evidence must outlive its subject.';
COMMENT ON COLUMN audit_log.entry_hash IS
    'sha256 over the previous hash and this entry''s own fields. Recomputed and checked by verify_audit_chain().';

-- Serves: the log itself, newest first, which is how it is always read.
CREATE INDEX audit_log_recent_idx ON audit_log (created_at DESC);
-- Serves: the five filter chips.
CREATE INDEX audit_log_category_idx ON audit_log (category, created_at DESC);
-- Serves: "everything this person did", and "everything that happened to this
-- store" — the two questions an investigation starts from.
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC)
    WHERE actor_id IS NOT NULL;
CREATE INDEX audit_log_store_idx ON audit_log (store_id, created_at DESC)
    WHERE store_id IS NOT NULL;
-- Serves: "every time this row was touched", across actions.
CREATE INDEX audit_log_subject_idx ON audit_log (subject_type, subject_id)
    WHERE subject_id IS NOT NULL;


-- What goes into the hash. A function of its own, so the writer and the verifier
-- cannot drift: both call this, and a field added to the table without being added
-- here would show up as an unverifiable chain rather than as silence.
CREATE FUNCTION audit_entry_hash(
    p_previous_hash       text,
    p_sequence            bigint,
    p_category            text,
    p_action              text,
    p_summary             text,
    p_detail              text,
    p_actor_id            uuid,
    p_actor_label         text,
    p_actor_role          text,
    p_store_id            uuid,
    p_store_label         text,
    p_subject_type        text,
    p_subject_id          uuid,
    p_ip_address          inet,
    p_user_agent          text,
    p_session_verified_at timestamptz,
    p_context             jsonb,
    p_created_at          timestamptz
) RETURNS text
    LANGUAGE sql
    IMMUTABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT encode(sha256(convert_to(concat_ws(E'\x1f',
        COALESCE(p_previous_hash, ''),
        p_sequence::text,
        p_category,
        p_action,
        p_summary,
        COALESCE(p_detail, ''),
        COALESCE(p_actor_id::text, ''),
        p_actor_label,
        COALESCE(p_actor_role, ''),
        COALESCE(p_store_id::text, ''),
        COALESCE(p_store_label, ''),
        COALESCE(p_subject_type, ''),
        COALESCE(p_subject_id::text, ''),
        COALESCE(p_ip_address::text, ''),
        COALESCE(p_user_agent, ''),
        -- A fixed rendering, not the session's: to_char with an explicit pattern,
        -- so a server with a different DateStyle verifies the same chain.
        COALESCE(to_char(p_session_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), ''),
        -- jsonb's text form is canonical: keys sorted, whitespace normalised.
        p_context::text,
        to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
    ), 'UTF8')), 'hex');
$init$;

COMMENT ON FUNCTION audit_entry_hash IS
    'The chain''s hash, over every field of an entry and the hash before it. Unit separators between fields, so no two different entries can concatenate to the same string.';


-- Append-only, and the trigger says what it is for. It is the first of the two
-- defences; the chain is the one that holds when this is switched off.
CREATE FUNCTION audit_log_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only (attempted % on entry %)', TG_OP, OLD.sequence
        USING HINT = 'Entries cannot be edited or deleted, including by super admins. Every entry is hashed into the next one, so a change made around this trigger is still visible to verify_audit_chain().';
END;
$init$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();


-- =============================================================================
-- 2. Writing an entry
-- =============================================================================

CREATE FUNCTION audit(
    p_category            text,
    p_action              text,
    p_summary             text,
    p_actor_id            uuid        DEFAULT NULL,
    p_store_id            uuid        DEFAULT NULL,
    p_detail              text        DEFAULT NULL,
    p_subject_type        text        DEFAULT NULL,
    p_subject_id          uuid        DEFAULT NULL,
    p_ip_address          inet        DEFAULT NULL,
    p_user_agent          text        DEFAULT NULL,
    p_session_verified_at timestamptz DEFAULT NULL,
    p_context             jsonb       DEFAULT '{}'::jsonb,
    p_actor_label         text        DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_sequence    bigint;
    v_previous    text;
    v_actor_label text;
    v_actor_role  text;
    v_store_label text;
    v_context     jsonb := COALESCE(p_context, '{}'::jsonb);
    v_created     timestamptz := clock_timestamp();
    v_hash        text;
    v_id          uuid;
BEGIN
    -- THE CHAIN IS SERIALISED HERE. One lock for the whole log, because the chain
    -- is one chain: two entries that both read the same "previous" would each claim
    -- to follow it and one of them would be lying. Admin actions are rare enough
    -- that a global lock costs nothing; if that ever stops being true, the answer
    -- is a chain per day, not a chain with races in it.
    PERFORM pg_advisory_xact_lock(hashtext('vendlyfy.audit_log')::bigint);

    SELECT sequence, entry_hash INTO v_sequence, v_previous
      FROM audit_log ORDER BY sequence DESC LIMIT 1;

    v_sequence := COALESCE(v_sequence, 0) + 1;

    -- The labels, captured now. A caller may pass one for an actor with no account
    -- at all — the board's "Unknown" against three failed sign-ins.
    IF p_actor_id IS NOT NULL THEN
        SELECT u.name, COALESCE(pm.role, sm.role)
          INTO v_actor_label, v_actor_role
          FROM users u
          LEFT JOIN platform_members pm ON pm.user_id = u.id
          LEFT JOIN store_members sm ON sm.user_id = u.id AND sm.store_id = p_store_id
         WHERE u.id = p_actor_id;
    END IF;

    v_actor_label := COALESCE(v_actor_label, NULLIF(btrim(COALESCE(p_actor_label, '')), ''), 'Unknown');

    IF p_store_id IS NOT NULL THEN
        SELECT name INTO v_store_label FROM stores WHERE id = p_store_id;
    END IF;

    -- clock_timestamp(), not now(): several entries written by one transaction are
    -- several things that happened, in an order, and now() would give them all the
    -- same instant. The chain would still verify, but the log would read wrongly.
    v_hash := audit_entry_hash(v_previous, v_sequence, p_category, p_action, p_summary,
                               p_detail, p_actor_id, v_actor_label, v_actor_role,
                               p_store_id, v_store_label, p_subject_type, p_subject_id,
                               p_ip_address, p_user_agent, p_session_verified_at,
                               v_context, v_created);

    INSERT INTO audit_log (sequence, category, action, summary, detail,
                           actor_id, actor_label, actor_role,
                           store_id, store_label, subject_type, subject_id,
                           ip_address, user_agent, session_verified_at, context,
                           previous_hash, entry_hash, created_at)
         VALUES (v_sequence, p_category, p_action, p_summary, p_detail,
                 p_actor_id, v_actor_label, v_actor_role,
                 p_store_id, v_store_label, p_subject_type, p_subject_id,
                 p_ip_address, p_user_agent, p_session_verified_at, v_context,
                 v_previous, v_hash, v_created)
      RETURNING id INTO v_id;

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION audit IS
    'Writes one audit entry, capturing the actor and store labels and linking it into the hash chain. The only sanctioned writer; a hand-written INSERT will not have a hash that verifies.';


-- =============================================================================
-- 3. Checking it
-- =============================================================================
-- Run it in CI against the seeded log, and on a schedule in production. It returns
-- nothing when the log is sound, which is the only result anybody wants.

CREATE FUNCTION verify_audit_chain(p_from bigint DEFAULT 1)
    RETURNS TABLE (broken_sequence bigint, problem text)
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    r          record;
    v_expected bigint := p_from;
    v_previous text;
BEGIN
    -- Where the caller starts from, the hash before it is whatever is recorded.
    SELECT entry_hash INTO v_previous FROM audit_log WHERE sequence = p_from - 1;

    FOR r IN SELECT * FROM audit_log WHERE sequence >= p_from ORDER BY sequence
    LOOP
        IF r.sequence <> v_expected THEN
            broken_sequence := r.sequence;
            problem := format('the entry after %s is %s — %s entr%s missing',
                              v_expected - 1, r.sequence, r.sequence - v_expected,
                              CASE WHEN r.sequence - v_expected = 1 THEN 'y' ELSE 'ies' END);
            RETURN NEXT;
            -- Carry on from where it actually is, so one gap does not report as
            -- every entry after it being wrong.
            v_expected := r.sequence;
        END IF;

        IF r.previous_hash IS DISTINCT FROM v_previous THEN
            broken_sequence := r.sequence;
            problem := format('entry %s follows %s but the entry before it hashes to %s',
                              r.sequence, COALESCE(r.previous_hash, 'nothing'),
                              COALESCE(v_previous, 'nothing'));
            RETURN NEXT;
        END IF;

        IF r.entry_hash <> audit_entry_hash(r.previous_hash, r.sequence, r.category,
                r.action, r.summary, r.detail, r.actor_id, r.actor_label, r.actor_role,
                r.store_id, r.store_label, r.subject_type, r.subject_id, r.ip_address,
                r.user_agent, r.session_verified_at, r.context, r.created_at) THEN
            broken_sequence := r.sequence;
            problem := format('entry %s has been changed since it was written', r.sequence);
            RETURN NEXT;
        END IF;

        v_previous := r.entry_hash;
        v_expected := r.sequence + 1;
    END LOOP;
END;
$init$;

COMMENT ON FUNCTION verify_audit_chain IS
    'Recomputes the chain and returns every break: a missing entry, an entry that does not follow its predecessor, or an entry whose contents have been altered. Returns nothing when the log is sound.';


-- =============================================================================
-- Recorded rather than invented
-- =============================================================================
-- 1. THE APPLICATION IS THE WRITER, and nothing here can make it call audit().
--    A trigger on every watched table would catch writes and miss exactly the
--    entries that matter most — "Revealed full ID number" is a read. What the
--    schema can do, and does, is make an entry that HAS been written impossible to
--    alter quietly. Coverage is the endpoints' job, and the endpoints that do
--    sensitive things are few and reviewable.
--
-- 2. RETENTION IS UNDECIDED, and deliberately not implemented. An audit log is
--    evidence; deleting old entries is a legal question, and it interacts with the
--    chain — pruning the oldest entries means the chain no longer starts at 1, so
--    verify_audit_chain() takes a starting point rather than assuming one. That is
--    the only accommodation made for a decision nobody has taken.
--
-- 3. "EXPORT CSV" reads this table and writes a file. No schema.
--
-- 4. TWO EARLIER TABLES DECLARE SET NULL WHERE THEY MEAN RESTRICT. order_events
--    (V004) and wallet_ledger (V005) are append-only and name users with ON DELETE
--    SET NULL, which their own triggers then refuse. The BEHAVIOUR is already what
--    it should be — the delete fails, the history stays — but the message a caller
--    gets is the append-only complaint rather than a foreign key violation. Left
--    alone rather than migrated, because changing a shipped constraint to say what
--    it already does is churn; recorded here so the next reader does not take the
--    declaration at face value.
--
-- 5. NO SEED DATA. Every other reference table in this milestone ships its rows,
--    because a fresh database must be able to onboard a merchant. An audit log
--    that shipped with entries in it would be a log with fiction at the bottom.
