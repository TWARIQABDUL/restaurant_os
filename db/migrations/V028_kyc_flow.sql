-- V028_kyc_flow.sql
--
-- Milestone 26. The retention rule V012 left as a placeholder, now that it has an answer.
--
-- V012 shipped `kyc_documents.retain_until` as NULL on every row because KYCOutcomes prints "[RETENTION PERIOD]" — the
-- design admitting the question was open. The answer, from the person who owns the business:
--
--   THE FACE VIDEO IS DELETED ONCE IT HAS BEEN USED. It is biometric, it exists to answer one question ("is this the
--   person on the ID?"), and nothing afterwards needs the footage — only the decision does, and that is kept.
--
--   THE ID DOCUMENTS ARE KEPT, ENCRYPTED. The business handles money; a payment partner, a bank or a regulator may ask
--   who a merchant was, and "we deleted it" is not an answer. Their retention_until stays NULL — no period has been
--   chosen, so none is invented — and the bytes are sealed with a key outside the database (crypto/kyc.ts).
--
-- Expressed as two triggers rather than application code, for the reason V012 gives for everything else in this area:
-- "and then deleted" should be checkable, not hopeful. A route that forgets to schedule the deletion is a route
-- that is wrong in review; a trigger cannot be forgotten.
--
--   1. WHEN A CASE IS DECIDED (approved or rejected), its live face video becomes due immediately.
--      A redo is not a decision about the video — it asks for ONE part again and the case continues — so a case in
--      redo_requested keeps its video until the retake arrives or the case is decided.
--   2. WHEN A VIDEO IS SUPERSEDED (the merchant retook it), the old one becomes due immediately. A replaced biometric
--      capture has no reason to outlive its replacement.
--
-- The rows stay. purge_expired_kyc_documents() (V012) clears the storage pointer and returns the key so the caller can
-- delete the object; what was sent and what was decided about it remain auditable after the footage is gone.

CREATE FUNCTION kyc_video_due_when_decided() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    UPDATE kyc_documents
       SET retain_until = now()
     WHERE submission_id = NEW.id
       AND part = 'face_video'
       AND purged_at IS NULL
       AND retain_until IS NULL;
    RETURN NULL;
END;
$init$;

CREATE TRIGGER kyc_submissions_video_due
    AFTER UPDATE OF status ON kyc_submissions
    FOR EACH ROW
    WHEN (NEW.status IN ('approved', 'rejected') AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION kyc_video_due_when_decided();

CREATE FUNCTION kyc_video_due_when_superseded() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF NEW.retain_until IS NULL THEN
        NEW.retain_until := now();
    END IF;
    RETURN NEW;
END;
$init$;

CREATE TRIGGER kyc_documents_video_due_on_supersede
    BEFORE UPDATE OF superseded_at ON kyc_documents
    FOR EACH ROW
    WHEN (NEW.part = 'face_video' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL AND NEW.purged_at IS NULL)
    EXECUTE FUNCTION kyc_video_due_when_superseded();

COMMENT ON COLUMN kyc_documents.retain_until IS
    'When the bytes may be deleted. Set by trigger for a face video (the moment the case is decided or the video is replaced); NULL for ID documents, which are kept encrypted — no period has been chosen, so none is invented.';

-- Serves: what the merchant sees about a case — its live documents and their per-part decisions.
-- (kyc_documents_submission_idx already covers the lookup; nothing new is needed.)
