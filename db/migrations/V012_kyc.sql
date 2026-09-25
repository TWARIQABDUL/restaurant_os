-- V012_kyc.sql
--
-- Milestone 9, seventh part. Identity verification: what a merchant sends, what
-- the automatic checks say about it, what a reviewer decides, and the one thing
-- that decision controls.
--
-- Part 8 of the plan rates this the highest-risk area in the whole rewrite, and not
-- because it is complicated: "KYC is biometric data. Face video plus national ID
-- number. Retention, encryption at rest, restricted access and a lawful basis are
-- obligations." So this migration is shaped by what it REFUSES to store as much as
-- by what it stores.
--
--   THERE IS NO PLAINTEXT ID NUMBER COLUMN. AdminKYC shows "1 1994 7 ••••••• 0 18"
--   with a "Show full ID number" button behind it, and AdminAudit shows what that
--   button does: "Revealed full ID number · Claudine Mukamana", category
--   `sensitive`, with a reason and the reviewer's IP. So the schema keeps three
--   different things and they are not interchangeable:
--     * the MASKED form, which is what review actually works from;
--     * the number itself, ENCRYPTED, with the key outside the database — the same
--       decision V007 recorded for provider credentials, for the same reason: a
--       plaintext column is readable by every repository method, every backup and
--       every support query;
--     * a FINGERPRINT, computed outside the database with a pepper, which is what
--       "Not used by another store" compares — a duplicate can be found without
--       anybody being able to read either number.
--
--   AND THE REVEAL CANNOT HAPPEN WITHOUT THE AUDIT ENTRY, because the only function
--   that returns the ciphertext is the one that writes the entry. "Every sensitive
--   view" stops being a promise about endpoints for the view that matters most.
--
-- What the boards settle:
--
--   * FIVE STATES. KYCOutcomes draws four of them from the merchant's side —
--     inReview, redoRequested, rejected, approved — and AdminKYC adds the one
--     between: a case whose automatic checks are done and which is "Waiting for
--     review".
--   * A REDO IS PER DOCUMENT, not per case. "One photo needs redoing. Everything
--     else is fine." ID front accepted, ID back retake, face video accepted — so
--     the outcome lives on the document, and the replacement supersedes one part
--     while the other two keep the decisions already made about them.
--   * SIX AUTOMATIC CHECKS, listed on AdminKYC, each with a pass, a warning or a
--     failure and a note. They are a vendor's output, which is why they are rows
--     rather than columns: the vendor is an open decision and its report will not
--     be six booleans.
--   * VERIFICATION GATES PAYOUTS AND NOTHING ELSE. "You can keep selling. Payouts
--     stay on hold until the check is finished; your balance keeps adding up." And
--     for a rejection: "Money you've earned is safe in your balance but can't be
--     withdrawn until you're verified." So selling, orders, cash and MoMo all work
--     unverified; request_withdrawal is the one thing that must refuse.


-- =============================================================================
-- 1. The state machine, as data
-- =============================================================================

CREATE TABLE kyc_status_transitions (
    from_status text NOT NULL,
    to_status   text NOT NULL,
    description text NOT NULL,

    PRIMARY KEY (from_status, to_status)
);

INSERT INTO kyc_status_transitions (from_status, to_status, description) VALUES
    ('submitted',      'in_review',      'The automatic checks finished; a reviewer picks it up'),
    ('in_review',      'approved',       'Verified. Payouts unlock'),
    ('in_review',      'rejected',       'Not verified. The merchant may start again with another document'),
    ('in_review',      'redo_requested', 'One document must be retaken; the others keep their decisions'),
    ('redo_requested', 'submitted',      'The replacement arrived and the checks run again');

COMMENT ON TABLE kyc_status_transitions IS
    'Every move a submission may make. approved and rejected are terminal — "Start again" is a NEW submission, because a rejection is part of the record.';


-- =============================================================================
-- 2. kyc_submissions
-- =============================================================================

CREATE TABLE kyc_submissions (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- "Case KYC-5521", as the audit log quotes it.
    reference_number       bigint      NOT NULL GENERATED ALWAYS AS IDENTITY,

    store_id               uuid        NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    -- WHOSE identity. Must be staff of this store, by composite key rather than by
    -- a check somebody remembered to write.
    subject_user_id        uuid        NOT NULL,

    document_type          text        NOT NULL,

    status                 text        NOT NULL DEFAULT 'submitted',

    -- What the reviewer reads. The masked form is the working copy: review happens
    -- against this, and the full number is a separate, logged act.
    id_number_masked       text,

    -- The number itself, encrypted outside this database. Which key encrypted it is
    -- recorded so a rotation can find its own rows; the key itself is not here and
    -- must not be.
    id_number_encrypted    bytea,
    encryption_key_id      text,

    -- For "Not used by another store". A keyed hash computed outside the database,
    -- so a match can be found without either number being readable. NOT unique: one
    -- person may legitimately own two stores, and the board treats this as
    -- something a reviewer is told, not something the system forbids.
    id_number_fingerprint  text,

    -- Extra facts the reviewer sees, none of which is the number.
    full_name              text,
    date_of_birth          date,
    document_expires_on    date,

    -- The decision.
    reviewed_by            uuid        REFERENCES platform_members (user_id) ON DELETE RESTRICT,
    reviewed_at            timestamptz,
    -- Shown to the merchant verbatim: "The face in the video didn't match the photo
    -- on the ID."
    decision_note          text,

    submitted_at           timestamptz NOT NULL DEFAULT now(),
    checks_completed_at    timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT kyc_submissions_status_values CHECK (status IN (
        'submitted', 'in_review', 'redo_requested', 'approved', 'rejected')),

    -- AdminKYC shows "National ID"; a passport is the other thing a Rwandan
    -- merchant can present. Both have a front; only an ID has a back, which the
    -- documents table enforces.
    CONSTRAINT kyc_submissions_document_type_values
        CHECK (document_type IN ('national_id', 'passport')),

    -- Encryption is all three parts or none: ciphertext nobody can name a key for
    -- is ciphertext nobody can read.
    CONSTRAINT kyc_submissions_encryption_complete
        CHECK ((id_number_encrypted IS NULL) = (encryption_key_id IS NULL)),

    -- If the number was captured at all, the masked form exists — because that is
    -- what every screen shows and no screen should fall back to the real one.
    CONSTRAINT kyc_submissions_masked_present
        CHECK (id_number_encrypted IS NULL OR id_number_masked IS NOT NULL),

    -- A mask has something hidden in it. AdminKYC's own example is "1 1994 7
    -- ••••••• 0 18"; a "mask" with no bullets in it is the number.
    CONSTRAINT kyc_submissions_mask_is_masked
        CHECK (id_number_masked IS NULL OR id_number_masked LIKE '%•%'),

    CONSTRAINT kyc_submissions_fingerprint_shape
        CHECK (id_number_fingerprint IS NULL OR id_number_fingerprint ~ '^[0-9a-f]{64}$'),

    -- A decision is who, when and why, together.
    CONSTRAINT kyc_submissions_decision_complete
        CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL)),
    -- A decided case has a reviewer and a timestamp; an undecided one has neither.
    -- Both sides are total, so this cannot be satisfied by a NULL.
    CONSTRAINT kyc_submissions_decided_states
        CHECK ((status IN ('approved', 'rejected', 'redo_requested')) = (reviewed_at IS NOT NULL)),
    -- A rejection and a redo both tell the merchant something. An approval need not.
    CONSTRAINT kyc_submissions_refusal_has_reason
        CHECK (status NOT IN ('rejected', 'redo_requested')
               OR btrim(COALESCE(decision_note, '')) <> ''),

    -- Nobody reviews a case whose checks have not finished.
    CONSTRAINT kyc_submissions_review_needs_checks
        CHECK (status IN ('submitted') OR checks_completed_at IS NOT NULL),

    CONSTRAINT kyc_submissions_id_store_key UNIQUE (id, store_id),

    FOREIGN KEY (subject_user_id, store_id) REFERENCES store_members (user_id, store_id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE kyc_submissions IS
    'One identity check. Holds the masked number, the encrypted number and a keyed fingerprint — never the number itself in readable form.';
COMMENT ON COLUMN kyc_submissions.id_number_encrypted IS
    'Encrypted outside the database, with a key that is not in it. Readable only through reveal_kyc_id_number(), which writes an audit entry first.';
COMMENT ON COLUMN kyc_submissions.id_number_fingerprint IS
    'A keyed hash for duplicate detection, computed outside the database with a pepper. Deliberately NOT unique: one person may own two stores.';

CREATE UNIQUE INDEX kyc_submissions_reference_key ON kyc_submissions (reference_number);

-- ONE LIVE CASE PER STORE. A merchant cannot have two checks running, and the
-- queue cannot show the same store twice.
CREATE UNIQUE INDEX kyc_submissions_one_live_per_store
    ON kyc_submissions (store_id)
    WHERE status IN ('submitted', 'in_review', 'redo_requested');

-- Serves: AdminKYC's queue — everything waiting for a human, oldest first, which is
-- the "19 h / 1 d" column it sorts by.
CREATE INDEX kyc_submissions_queue_idx ON kyc_submissions (submitted_at)
    WHERE status = 'in_review';

-- Serves: "is this store verified", which request_withdrawal asks on every payout.
CREATE INDEX kyc_submissions_approved_idx ON kyc_submissions (store_id)
    WHERE status = 'approved';

-- Serves: "Not used by another store".
CREATE INDEX kyc_submissions_fingerprint_idx ON kyc_submissions (id_number_fingerprint)
    WHERE id_number_fingerprint IS NOT NULL;

CREATE TRIGGER kyc_submissions_set_updated_at BEFORE UPDATE ON kyc_submissions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE FUNCTION kyc_status_transition_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM kyc_status_transitions
         WHERE from_status = OLD.status AND to_status = NEW.status
    ) THEN
        RAISE EXCEPTION 'identity check % cannot move from % to %', OLD.id, OLD.status, NEW.status
            USING HINT = 'approved and rejected are final. Starting again is a new submission.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER kyc_submissions_status_transition BEFORE UPDATE OF status ON kyc_submissions
    FOR EACH ROW EXECUTE FUNCTION kyc_status_transition_check();


-- =============================================================================
-- 3. kyc_documents
-- =============================================================================
-- Three parts, and a redo replaces ONE of them. The superseded row stays: what was
-- sent the first time is part of the record, and "the back of your ID is blurry" is
-- only meaningful beside the photo it was said about.

CREATE TABLE kyc_documents (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id  uuid        NOT NULL,
    store_id       uuid        NOT NULL,

    part           text        NOT NULL,

    -- The bytes are in object storage, never here. Which store — the existing
    -- Supabase bucket behind signed URLs, or S3/R2 — is still open; what is not
    -- open is that biometric data does not sit in a column beside a store's name.
    storage_key    text        NOT NULL,
    content_type   text        NOT NULL,
    byte_size      bigint,

    -- What the automatic pass said about the image itself: AdminKYC's "Sharp" and
    -- "Blurry" labels next to each side.
    quality        text,
    quality_note   text,

    -- What the reviewer decided about THIS part. NULL until they do.
    review_outcome text,

    -- Retention. "Your ID photos and video are kept for [RETENTION PERIOD] and then
    -- deleted" — the period is a placeholder in the design and therefore NULL here.
    -- purge_expired_kyc_documents() acts on this column and does nothing until
    -- somebody sets it, which is the honest behaviour for an unanswered question.
    retain_until   timestamptz,
    purged_at      timestamptz,

    superseded_at  timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT kyc_documents_part_values
        CHECK (part IN ('id_front', 'id_back', 'face_video')),
    CONSTRAINT kyc_documents_quality_values
        CHECK (quality IS NULL OR quality IN ('sharp', 'blurry')),
    CONSTRAINT kyc_documents_review_outcome_values
        CHECK (review_outcome IS NULL OR review_outcome IN ('accepted', 'retake')),
    CONSTRAINT kyc_documents_byte_size_sane CHECK (byte_size IS NULL OR byte_size > 0),

    -- A purged document has no bytes left to point at. This is what makes
    -- "and then deleted" checkable rather than hopeful.
    CONSTRAINT kyc_documents_purged_has_no_key
        CHECK ((purged_at IS NULL) = (btrim(storage_key) <> '')),

    FOREIGN KEY (submission_id, store_id) REFERENCES kyc_submissions (id, store_id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE kyc_documents IS
    'The three parts of a submission, with a per-part review outcome so that a redo can ask for one photo and leave the other two accepted. Superseded rows stay: what was sent first is part of the record.';
COMMENT ON COLUMN kyc_documents.retain_until IS
    'When the bytes may be deleted. NULL because the retention period is a placeholder in the design — one of the two things Part 8 says to answer before this phase ships.';

-- ONE LIVE DOCUMENT PER PART.
CREATE UNIQUE INDEX kyc_documents_one_live_per_part
    ON kyc_documents (submission_id, part) WHERE superseded_at IS NULL;

CREATE INDEX kyc_documents_submission_idx ON kyc_documents (submission_id, created_at);

-- Serves: the retention sweep, once there is a period to sweep by.
CREATE INDEX kyc_documents_retention_idx ON kyc_documents (retain_until)
    WHERE purged_at IS NULL AND retain_until IS NOT NULL;

CREATE TRIGGER kyc_documents_set_updated_at BEFORE UPDATE ON kyc_documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- A passport has no back. Enforced here rather than trusted, because a submission
-- with a missing part cannot be approved and the reviewer would be left guessing
-- which of the two problems they had.
CREATE FUNCTION kyc_documents_part_suits_document() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_type text;
BEGIN
    SELECT document_type INTO v_type FROM kyc_submissions WHERE id = NEW.submission_id;
    IF NOT FOUND THEN
        -- The composite key owns this.
        RETURN NEW;
    END IF;

    IF v_type = 'passport' AND NEW.part = 'id_back' THEN
        RAISE EXCEPTION 'a passport has no back'
            USING HINT = 'A passport submission has id_front and face_video only.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER kyc_documents_part_suits_document BEFORE INSERT ON kyc_documents
    FOR EACH ROW EXECUTE FUNCTION kyc_documents_part_suits_document();


-- =============================================================================
-- 4. kyc_checks
-- =============================================================================
-- The vendor's report. Rows rather than columns because the vendor is an open
-- decision and its output will not be six booleans — but the six the board lists
-- are a closed set, because AdminKYC draws each one with its own label and note.

CREATE TABLE kyc_checks (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id uuid        NOT NULL,
    store_id      uuid        NOT NULL,

    check_code    text        NOT NULL,
    outcome       text        NOT NULL,

    -- The board's second line: "No edits found", "50 of 50 frames", "Weak match",
    -- "Front OK, back unreadable".
    note          text,

    -- Whatever the vendor returned, kept whole. A dispute about a rejection is
    -- argued from the report, not from our summary of it.
    vendor_name   text,
    vendor_result jsonb       NOT NULL DEFAULT '{}'::jsonb,

    ran_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT kyc_checks_code_values CHECK (check_code IN (
        'document_genuine',        -- "Document looks genuine"
        'face_in_view',            -- "Face in view for all 5 s"
        'liveness',                -- "Live person"
        'face_matches_document',   -- "Face matches ID photo"
        'name_matches_registration', -- "Name matches business registration"
        'not_used_by_another_store'  -- "Not used by another store"
    )),
    CONSTRAINT kyc_checks_outcome_values CHECK (outcome IN ('pass', 'warn', 'fail')),
    CONSTRAINT kyc_checks_vendor_result_is_object
        CHECK (jsonb_typeof(vendor_result) = 'object'),

    CONSTRAINT kyc_checks_one_per_code UNIQUE (submission_id, check_code),

    FOREIGN KEY (submission_id, store_id) REFERENCES kyc_submissions (id, store_id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE kyc_checks IS
    'The six automatic checks AdminKYC lists, one row each, with the vendor''s own result kept whole beside our summary of it.';

CREATE INDEX kyc_checks_submission_idx ON kyc_checks (submission_id);
-- Serves: the queue's flag column — "Weak face match", "Blurry ID back" — which is
-- the worst outcome on a case.
CREATE INDEX kyc_checks_failing_idx ON kyc_checks (submission_id)
    WHERE outcome <> 'pass';


-- =============================================================================
-- 5. kyc_extracted_fields
-- =============================================================================
-- The right-hand panel: each field read off the document, and whether it matches
-- what the merchant typed. Every value here is DISPLAY-SAFE — the ID number field
-- holds the masked form — so this table can be read by a reviewer's ordinary query
-- without any of it being a sensitive view.

CREATE TABLE kyc_extracted_fields (
    submission_id uuid        NOT NULL,
    store_id      uuid        NOT NULL,

    field_key     text        NOT NULL,

    -- Masked where masking applies. Never the full ID number.
    display_value text        NOT NULL,

    -- The board's third column: Match, Differs, Unread.
    verdict       text        NOT NULL,

    created_at    timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (submission_id, field_key),

    CONSTRAINT kyc_extracted_fields_key_values CHECK (field_key IN (
        'full_name', 'id_number', 'date_of_birth', 'document_expires_on', 'typed_name')),
    CONSTRAINT kyc_extracted_fields_verdict_values
        CHECK (verdict IN ('match', 'differs', 'unread')),
    CONSTRAINT kyc_extracted_fields_value_not_blank CHECK (btrim(display_value) <> ''),

    -- The one rule that keeps this table safe to read: the number that appears here
    -- is masked, or it says why it could not be read.
    CONSTRAINT kyc_extracted_fields_id_number_is_masked
        CHECK (field_key <> 'id_number' OR verdict = 'unread' OR display_value LIKE '%•%'),

    FOREIGN KEY (submission_id, store_id) REFERENCES kyc_submissions (id, store_id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE kyc_extracted_fields IS
    'What was read off the document and whether it agrees with what the merchant typed. Display-safe throughout: the ID number appears here masked, so reading this table is not a sensitive view.';


-- =============================================================================
-- 6. Approval means every part was accepted
-- =============================================================================
-- Deferred, because decide_kyc writes the documents' outcomes and the status in one
-- transaction.

CREATE FUNCTION kyc_approval_needs_all_parts() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_submission uuid;
    v_status     text;
    v_type       text;
    v_required   text[];
    v_missing    text;
    v_unaccepted bigint;
BEGIN
    IF TG_TABLE_NAME = 'kyc_submissions' THEN
        v_submission := NEW.id;
    ELSE
        v_submission := NEW.submission_id;
    END IF;

    SELECT status, document_type INTO v_status, v_type
      FROM kyc_submissions WHERE id = v_submission;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_status <> 'approved' THEN
        RETURN NULL;
    END IF;

    v_required := CASE v_type
        WHEN 'passport' THEN ARRAY['id_front', 'face_video']
        ELSE ARRAY['id_front', 'id_back', 'face_video'] END;

    SELECT p INTO v_missing
      FROM unnest(v_required) AS p
     WHERE NOT EXISTS (
        SELECT 1 FROM kyc_documents d
         WHERE d.submission_id = v_submission AND d.part = p AND d.superseded_at IS NULL)
     ORDER BY p LIMIT 1;

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'identity check % was approved without a %', v_submission, v_missing
            USING HINT = 'Every part of a submission must be present and accepted before it can be approved.';
    END IF;

    SELECT count(*) INTO v_unaccepted
      FROM kyc_documents
     WHERE submission_id = v_submission AND superseded_at IS NULL
       AND COALESCE(review_outcome, '') <> 'accepted';

    IF v_unaccepted > 0 THEN
        RAISE EXCEPTION 'identity check % was approved with % part(s) not accepted', v_submission, v_unaccepted
            USING HINT = 'Accept each document, or ask for a retake instead of approving.';
    END IF;

    RETURN NULL;
END;
$init$;

CREATE CONSTRAINT TRIGGER kyc_submissions_approval_complete
    AFTER INSERT OR UPDATE OF status ON kyc_submissions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION kyc_approval_needs_all_parts();

CREATE CONSTRAINT TRIGGER kyc_documents_approval_complete
    AFTER INSERT OR UPDATE OF review_outcome, superseded_at ON kyc_documents
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION kyc_approval_needs_all_parts();


-- =============================================================================
-- 7. The functions
-- =============================================================================

CREATE FUNCTION store_is_verified(p_store_id uuid) RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT EXISTS (SELECT 1 FROM kyc_submissions
                    WHERE store_id = p_store_id AND status = 'approved');
$init$;

COMMENT ON FUNCTION store_is_verified IS
    'Whether a store has an approved identity check. Derived, not stored: a "verified" flag beside the submissions would be a second truth that drifts the first time one is set by hand.';


CREATE FUNCTION submit_kyc(
    p_store_id        uuid,
    p_subject_user_id uuid,
    p_document_type   text DEFAULT 'national_id'
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_id uuid;
BEGIN
    -- A verified store does not resubmit. The partial unique index below cannot say
    -- this, because it deliberately does not cover approved cases — a REJECTED store
    -- must be able to start again, and that is the same insert. So the difference
    -- between the two is checked here.
    IF store_is_verified(p_store_id) THEN
        RAISE EXCEPTION 'store % already has an approved identity check', p_store_id
            USING HINT = 'A rejected store starts a new case; a verified one has nothing to prove. Re-verifying an expired document is a flow no board draws yet.';
    END IF;

    -- A merchant sending their documents twice has one case, not two. The partial
    -- unique index is what makes this safe against two taps at once.
    INSERT INTO kyc_submissions (store_id, subject_user_id, document_type)
         VALUES (p_store_id, p_subject_user_id, p_document_type)
    ON CONFLICT (store_id) WHERE status IN ('submitted', 'in_review', 'redo_requested')
        DO NOTHING
      RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT id INTO v_id FROM kyc_submissions
         WHERE store_id = p_store_id
           AND status IN ('submitted', 'in_review', 'redo_requested');
    END IF;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'could not open an identity check for store %', p_store_id;
    END IF;

    RETURN v_id;
END;
$init$;


CREATE FUNCTION attach_kyc_document(
    p_submission_id uuid,
    p_part          text,
    p_storage_key   text,
    p_content_type  text,
    p_byte_size     bigint DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store  uuid;
    v_status text;
    v_id     uuid;
BEGIN
    SELECT store_id, status INTO v_store, v_status
      FROM kyc_submissions WHERE id = p_submission_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'identity check % does not exist', p_submission_id;
    END IF;

    IF v_status NOT IN ('submitted', 'redo_requested') THEN
        RAISE EXCEPTION 'identity check % is % and is not taking documents', p_submission_id, v_status
            USING HINT = 'Documents arrive while a case is being put together, or after a retake has been asked for.';
    END IF;

    -- A replacement SUPERSEDES rather than overwrites: the blurry photo and the
    -- sentence explaining why it was refused belong together.
    UPDATE kyc_documents SET superseded_at = now()
     WHERE submission_id = p_submission_id AND part = p_part AND superseded_at IS NULL;

    INSERT INTO kyc_documents (submission_id, store_id, part, storage_key, content_type, byte_size)
         VALUES (p_submission_id, v_store, p_part, p_storage_key, p_content_type, p_byte_size)
      RETURNING id INTO v_id;

    -- A redo that has been answered goes back into the queue.
    IF v_status = 'redo_requested' THEN
        UPDATE kyc_submissions
           SET status = 'submitted', checks_completed_at = NULL,
               reviewed_by = NULL, reviewed_at = NULL, decision_note = NULL
         WHERE id = p_submission_id;
    END IF;

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION attach_kyc_document IS
    'Adds or replaces one part. A replacement supersedes the old row rather than overwriting it, and answering a retake puts the case back in the queue.';


CREATE FUNCTION complete_kyc_checks(p_submission_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    UPDATE kyc_submissions
       SET status = 'in_review', checks_completed_at = now()
     WHERE id = p_submission_id AND status = 'submitted';

    RETURN FOUND;
END;
$init$;

COMMENT ON FUNCTION complete_kyc_checks IS
    'Moves a case from "we are checking your ID" to "waiting for review". Returns false if it was already there.';


CREATE FUNCTION decide_kyc(
    p_submission_id uuid,
    p_decided_by    uuid,
    p_outcome       text,
    p_note          text DEFAULT NULL,
    p_redo_part     text DEFAULT NULL
) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store  uuid;
    v_status text;
    v_owner  uuid;
    v_name   text;
BEGIN
    IF p_outcome NOT IN ('approve', 'reject', 'redo') THEN
        RAISE EXCEPTION 'a decision is approve, reject or redo, not %', p_outcome;
    END IF;

    IF p_outcome <> 'approve' AND btrim(COALESCE(p_note, '')) = '' THEN
        RAISE EXCEPTION 'refusing a check needs a reason the merchant reads'
            USING HINT = 'KYCOutcomes shows it to them verbatim, under "What our team said".';
    END IF;

    IF p_outcome = 'redo' AND p_redo_part IS NULL THEN
        RAISE EXCEPTION 'a retake has to say which part'
            USING HINT = 'One photo needs redoing — the other two keep the decisions already made about them.';
    END IF;

    IF p_outcome <> 'redo' AND p_redo_part IS NOT NULL THEN
        RAISE EXCEPTION 'only a retake names a part';
    END IF;

    -- The claim. Two reviewers on one case: one decides it, the other is told.
    UPDATE kyc_submissions
       SET status = CASE p_outcome WHEN 'approve' THEN 'approved'
                                   WHEN 'reject'  THEN 'rejected'
                                   ELSE 'redo_requested' END,
           reviewed_by = p_decided_by, reviewed_at = now(),
           decision_note = NULLIF(btrim(COALESCE(p_note, '')), '')
     WHERE id = p_submission_id AND status = 'in_review'
     RETURNING store_id, subject_user_id INTO v_store, v_owner;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF p_outcome = 'redo' THEN
        -- Exactly one part is asked for again; everything else is accepted, which is
        -- what "Everything else is fine" means on the merchant's screen.
        UPDATE kyc_documents
           SET review_outcome = CASE WHEN part = p_redo_part THEN 'retake' ELSE 'accepted' END
         WHERE submission_id = p_submission_id AND superseded_at IS NULL;
    ELSIF p_outcome = 'approve' THEN
        UPDATE kyc_documents SET review_outcome = 'accepted'
         WHERE submission_id = p_submission_id AND superseded_at IS NULL;
    END IF;

    SELECT name INTO v_name FROM users WHERE id = v_owner;

    -- Every KYC decision is an admin action, so it is in the log by construction
    -- rather than because an endpoint remembered.
    PERFORM audit(
        p_category => 'store',
        p_action   => CASE p_outcome WHEN 'approve' THEN 'approve_identity'
                                     WHEN 'reject'  THEN 'reject_identity'
                                     ELSE 'request_identity_redo' END,
        p_summary  => CASE p_outcome
                        WHEN 'approve' THEN 'Approved identity · ' || COALESCE(v_name, 'unknown')
                        WHEN 'reject'  THEN 'Rejected identity · ' || COALESCE(v_name, 'unknown')
                        ELSE 'Asked for a new ' || p_redo_part || ' · ' || COALESCE(v_name, 'unknown') END,
        p_actor_id => p_decided_by,
        p_store_id => v_store,
        p_detail   => p_note,
        p_subject_type => 'kyc_submission',
        p_subject_id   => p_submission_id);

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION decide_kyc IS
    'Approves, rejects or asks for a retake, once, and writes the audit entry itself. A retake marks one part for replacement and accepts the rest.';


-- =============================================================================
-- 8. The one sensitive view, and the only way to take it
-- =============================================================================
-- AdminAudit's first row is this function being called: "Revealed full ID number ·
-- Claudine Mukamana", with a reason, an IP and whether the session was 2-step
-- verified. Returning the ciphertext and writing the entry are the same act, so
-- there is no code path that reads the number without leaving a record.

CREATE FUNCTION reveal_kyc_id_number(
    p_submission_id       uuid,
    p_actor_id            uuid,
    p_reason              text,
    p_ip_address          inet        DEFAULT NULL,
    p_user_agent          text        DEFAULT NULL,
    p_session_verified_at timestamptz DEFAULT NULL
) RETURNS TABLE (id_number_encrypted bytea, encryption_key_id text)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store  uuid;
    v_name   text;
    v_cipher bytea;
    v_key    text;
BEGIN
    IF btrim(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'revealing an ID number needs a reason on the record'
            USING HINT = 'The audit log shows it beside the reveal: reason "matching RDB record".';
    END IF;

    -- Only the Vendlyfy team, by the same key that guards every other platform
    -- decision in this schema.
    IF NOT EXISTS (SELECT 1 FROM platform_members WHERE user_id = p_actor_id) THEN
        RAISE EXCEPTION 'only a Vendlyfy team member can reveal an ID number';
    END IF;

    SELECT s.store_id, s.id_number_encrypted, s.encryption_key_id, u.name
      INTO v_store, v_cipher, v_key, v_name
      FROM kyc_submissions s
      LEFT JOIN users u ON u.id = s.subject_user_id
     WHERE s.id = p_submission_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'identity check % does not exist', p_submission_id;
    END IF;

    IF v_cipher IS NULL THEN
        RAISE EXCEPTION 'identity check % has no ID number recorded', p_submission_id;
    END IF;

    -- The entry is written BEFORE the ciphertext is returned, so a caller that
    -- crashes on the way out has still been recorded as having asked.
    PERFORM audit(
        p_category => 'sensitive',
        p_action   => 'reveal_id_number',
        p_summary  => 'Revealed full ID number · ' || COALESCE(v_name, 'unknown'),
        p_actor_id => p_actor_id,
        p_store_id => v_store,
        p_detail   => 'reason: ' || btrim(p_reason),
        p_subject_type => 'kyc_submission',
        p_subject_id   => p_submission_id,
        p_ip_address   => p_ip_address,
        p_user_agent   => p_user_agent,
        p_session_verified_at => p_session_verified_at,
        p_context  => jsonb_build_object('reason', btrim(p_reason)));

    id_number_encrypted := v_cipher;
    encryption_key_id   := v_key;
    RETURN NEXT;
END;
$init$;

COMMENT ON FUNCTION reveal_kyc_id_number IS
    'Returns the encrypted ID number and writes the sensitive-view audit entry in the same call. Refuses without a reason, and refuses anybody who is not on the Vendlyfy team. Decryption happens outside the database, with a key that is not in it.';


-- =============================================================================
-- 9. Payouts wait for verification
-- =============================================================================
-- "Money you've earned is safe in your balance but can't be withdrawn until you're
-- verified." A second reason for the hold V008 introduced, with the same SQLSTATE,
-- because to a merchant they are the same sentence: your payouts are paused, and
-- here is why. Otherwise unchanged from V008.

CREATE OR REPLACE FUNCTION request_withdrawal(
    p_store_id        uuid,
    p_amount          numeric,
    p_phone           text,
    p_idempotency_key text,
    p_requested_by    uuid DEFAULT NULL,
    p_initiated_by    text DEFAULT 'manual'
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_id     uuid;
    v_queued numeric(12,2);
BEGIN
    -- Idempotent on the caller's key: a double-clicked Withdraw returns the first
    -- request instead of reserving the money twice.
    SELECT id INTO v_id FROM withdrawals
     WHERE store_id = p_store_id AND idempotency_key = p_idempotency_key;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    -- The identity gate. Selling, orders, cash and MoMo all work unverified; this
    -- is the one thing that does not.
    IF NOT store_is_verified(p_store_id) THEN
        RAISE EXCEPTION 'payouts are paused: this store has not been verified yet'
            USING ERRCODE = 'VLHLD',
                  HINT = 'The balance keeps adding up. Payouts start the morning after the identity check is approved.';
    END IF;

    -- The pause. Checked before anything is written, so a held payout leaves no
    -- half-made request behind.
    SELECT COALESCE(sum(approved_amount), 0) INTO v_queued
      FROM refunds WHERE store_id = p_store_id AND status = 'queued';

    IF v_queued > 0 THEN
        RAISE EXCEPTION 'payouts are paused: % is owed on refunds already approved', v_queued
            USING ERRCODE = 'VLHLD',
                  HINT = 'An approved refund waiting for funds is paid before the merchant is. It settles as soon as the balance covers it.';
    END IF;

    INSERT INTO withdrawals (store_id, amount, phone, idempotency_key, requested_by, initiated_by)
         VALUES (p_store_id, p_amount, p_phone, p_idempotency_key, p_requested_by, p_initiated_by)
      RETURNING id INTO v_id;

    -- The funds leave `available` now, not when the transfer completes. Otherwise
    -- the same balance could be withdrawn again while the first payout is in
    -- flight. If it cannot be covered, this raises and the withdrawal row goes with
    -- it — there is no state where a request exists without its money reserved.
    PERFORM wallet_post(
        p_store_id => p_store_id, p_pot => 'available', p_entry_type => 'withdrawal_reserved',
        p_amount => -p_amount, p_idempotency_key => 'withdrawal:' || v_id::text,
        p_counterparty => 'merchant payout', p_withdrawal_id => v_id,
        p_created_by => p_requested_by, p_note => 'Withdrawal requested, funds reserved');

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION request_withdrawal IS
    'Creates a payout request and reserves the funds in the same transaction. Idempotent per store key. Raises VLFND if available cannot cover it, and VLHLD while the store is unverified or an approved refund is waiting for funds — leaving no request behind in any of those cases.';


-- =============================================================================
-- 10. Retention, ready but inert
-- =============================================================================

CREATE FUNCTION purge_expired_kyc_documents()
    RETURNS TABLE (purged_document_id uuid, purged_storage_key text)
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT id, storage_key FROM kyc_documents
         WHERE purged_at IS NULL
           AND retain_until IS NOT NULL
           AND retain_until <= now()
         ORDER BY retain_until
           FOR UPDATE SKIP LOCKED
    LOOP
        -- The row stays; the pointer to the bytes goes. What was sent and what was
        -- decided about it remain auditable after the biometric data itself is gone,
        -- which is the whole point of separating them.
        UPDATE kyc_documents
           SET storage_key = '', purged_at = now()
         WHERE id = r.id;

        purged_document_id := r.id;
        purged_storage_key := r.storage_key;
        RETURN NEXT;
    END LOOP;
END;
$init$;

COMMENT ON FUNCTION purge_expired_kyc_documents IS
    'Clears the storage pointer of every document past its retention date, and returns the keys so the caller can delete the objects. Does nothing at all until retain_until is being set — the period is still a placeholder in the design.';


-- =============================================================================
-- Recorded rather than invented
-- =============================================================================
-- 1. THE VENDOR IS NOT CHOSEN. Document authenticity, liveness, face match and
--    duplicate detection are bought, not built — Part 9 lists it as open. kyc_checks
--    therefore records six OUTCOMES and keeps the vendor's own result whole in
--    vendor_result, so adopting a vendor is a mapping rather than a migration.
--
-- 2. THE RETENTION PERIOD IS NOT CHOSEN EITHER. KYCOutcomes prints "[RETENTION
--    PERIOD]" to the merchant, which is the design admitting it. retain_until is
--    NULL on every row until somebody answers, and the sweep above does nothing.
--    Both of these must be answered before this phase ships, per Part 8.
--
-- 3. THE ENCRYPTION KEY IS NOT HERE, and adding a pgcrypto call with a key in a
--    settings table would be worse than plaintext, because it would look solved.
--    encryption_key_id names which key was used so a rotation can find its rows;
--    the key lives where the provider credentials do (V007), and that is the same
--    open decision.
--
-- 4. RE-VERIFICATION IS NOT IMPLEMENTED, because no board draws it. A document has
--    an expiry date and the schema records it; what should happen the day it passes
--    — whether the approval lapses, whether payouts stop, how much notice a merchant
--    gets — is a product decision nobody has taken. submit_kyc therefore refuses a
--    verified store outright rather than quietly allowing a second case beside the
--    approved one, which would leave store_is_verified() true throughout and mean
--    nothing.
--
-- 5. "PAYOUTS START THE MORNING AFTER YOU'RE VERIFIED" is a schedule, and
--    store_payout_settings already holds one. Nothing here reaches into it: this
--    migration answers whether a payout may happen at all, not when.
