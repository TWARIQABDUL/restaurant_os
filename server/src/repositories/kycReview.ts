// server/src/repositories/kycReview.ts — milestone 27: the reviewer's side of the identity check (AdminKYC).
//
// M26 built the merchant's half and left four things for this one, each named in its own header:
//   * READING THE ID NUMBER OFF THE PHOTO. No OCR, so the reviewer types what they read and `recordDetails` seals it.
//   * THE SIX AUTOMATIC CHECKS. The board draws a vendor's output. There is no vendor, and a tick nobody earned is the thing
//     AdminKYC exists to prevent — so each check says who made it: two are COMPUTED (the number is not on another store's
//     case; the name on the ID is the name on the account) and four are the REVIEWER'S OWN CALL, recorded as theirs.
//   * VIEWING A DOCUMENT. Only here, only behind kyc.review, and writing an audit entry BEFORE the bytes leave — the same order
//     reveal_kyc_id_number() uses for the number, for the same reason: a reader who crashes on the way out has still been
//     recorded as having asked.
//   * TELLING THE MERCHANT. A decision notifies them in-app (V029), because the board's SMS does not exist yet.

import { revealIdNumber, sealIdNumber } from '../crypto/kyc.ts';
import { AppError, badRequest, conflict, db, notFound } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';
import { privateStore } from '../storage/private.ts';
import type { Part } from './kyc.ts';

export type Ctx = { ip: string | null; userAgent: string | null; verifiedAt: Date | null };

export type QueueItem = {
  id: string;
  reference: number;
  owner: string;
  store: string;
  storeId: string;
  documentType: 'national_id' | 'passport';
  ageHours: number;
  flag: { tone: 'ok' | 'warn' | 'bad'; label: string };
};

/** Automatic checks need a recorded number; until it is, "not used by another store" cannot be answered. */
export async function queue(on: Queryable = db): Promise<QueueItem[]> {
  const r = await on.query<{ id: string; reference_number: string; owner: string; store: string; store_id: string; document_type: QueueItem['documentType']; age_h: string; dup: string; has_number: boolean; failing: string }>(
    `SELECT k.id, k.reference_number::text, u.name AS owner, s.name AS store, s.id AS store_id, k.document_type,
            (extract(epoch FROM now() - k.submitted_at) / 3600)::text AS age_h,
            (SELECT count(*) FROM kyc_submissions o WHERE o.id_number_fingerprint IS NOT NULL AND o.id_number_fingerprint = k.id_number_fingerprint AND o.store_id <> k.store_id)::text AS dup,
            (k.id_number_encrypted IS NOT NULL) AS has_number,
            (SELECT count(*) FROM kyc_checks c WHERE c.submission_id = k.id AND c.outcome <> 'pass')::text AS failing
       FROM kyc_submissions k
       JOIN stores s ON s.id = k.store_id
       JOIN users u ON u.id = k.subject_user_id
      WHERE k.status = 'in_review'
      ORDER BY k.submitted_at, k.id
      LIMIT 100`,
  );
  return r.rows.map((x) => ({
    id: x.id,
    reference: Number(x.reference_number),
    owner: x.owner,
    store: x.store,
    storeId: x.store_id,
    documentType: x.document_type,
    ageHours: Number(x.age_h),
    flag:
      Number(x.dup) > 0
        ? { tone: 'bad', label: 'ID used by another store' }
        : Number(x.failing) > 0
          ? { tone: 'warn', label: 'A check needs a look' }
          : !x.has_number
            ? { tone: 'warn', label: 'ID number not entered' }
            : { tone: 'ok', label: 'Ready to decide' },
  }));
}

export type CheckState = 'pass' | 'warn' | 'fail' | 'open';

export const REVIEWER_CHECKS = ['document_genuine', 'face_in_view', 'liveness', 'face_matches_document'] as const;
export type ReviewerCheck = (typeof REVIEWER_CHECKS)[number];

export type CaseDetail = {
  id: string;
  reference: number;
  status: 'submitted' | 'in_review' | 'redo_requested' | 'approved' | 'rejected';
  storeId: string;
  storeName: string;
  storeSlug: string;
  owner: string;
  documentType: 'national_id' | 'passport';
  submittedAt: string;
  decisionNote: string | null;
  documents: { part: Part; contentType: string; byteSize: number | null; purged: boolean; outcome: 'accepted' | 'retake' | null }[];
  checks: { code: string; label: string; by: 'computed' | 'reviewer'; state: CheckState; note: string }[];
  fields: { fullName: string | null; accountName: string; dateOfBirth: string | null; expiresOn: string | null; idNumberMasked: string | null; hasIdNumber: boolean };
};

const LABEL: Record<string, string> = {
  document_genuine: 'Document looks genuine',
  face_in_view: 'Face in view for all 5 s',
  liveness: 'Live person',
  face_matches_document: 'Face matches ID photo',
  name_matches_account: 'Name on the ID is the name on the account',
  not_used_by_another_store: 'Not used by another store',
};

const normName = (s: string): string[] =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== '').sort();

export async function caseDetail(id: string, on: Queryable = db): Promise<CaseDetail | null> {
  const k = (await on.query<{ id: string; reference_number: string; status: CaseDetail['status']; store_id: string; store_name: string; store_slug: string; owner: string; document_type: CaseDetail['documentType']; submitted_at: Date; decision_note: string | null; full_name: string | null; date_of_birth: Date | null; document_expires_on: Date | null; id_number_masked: string | null; has_number: boolean; fingerprint: string | null }>(
    `SELECT k.id, k.reference_number::text, k.status, s.id AS store_id, s.name AS store_name, s.slug AS store_slug, u.name AS owner, k.document_type,
            k.submitted_at, k.decision_note, k.full_name, k.date_of_birth, k.document_expires_on, k.id_number_masked,
            (k.id_number_encrypted IS NOT NULL) AS has_number, k.id_number_fingerprint AS fingerprint
       FROM kyc_submissions k JOIN stores s ON s.id = k.store_id JOIN users u ON u.id = k.subject_user_id
      WHERE k.id = $1`,
    [id],
  )).rows[0];
  if (k === undefined) return null;

  const docs = await on.query<{ part: Part; content_type: string; byte_size: string | null; purged_at: Date | null; review_outcome: 'accepted' | 'retake' | null }>(
    `SELECT part, content_type, byte_size::text, purged_at, review_outcome FROM kyc_documents WHERE submission_id = $1 AND superseded_at IS NULL ORDER BY part`,
    [id],
  );
  const stored = await on.query<{ check_code: string; outcome: 'pass' | 'warn' | 'fail'; note: string | null }>(
    `SELECT check_code, outcome, note FROM kyc_checks WHERE submission_id = $1`,
    [id],
  );
  const byCode = new Map(stored.rows.map((r) => [r.check_code, r]));

  const checks: CaseDetail['checks'] = REVIEWER_CHECKS.map((code) => {
    const r = byCode.get(code);
    return { code, label: LABEL[code]!, by: 'reviewer', state: r === undefined ? 'open' : r.outcome, note: r === undefined ? 'Your call' : (r.note ?? { pass: 'Looks right', warn: 'Unsure', fail: 'Does not' }[r.outcome]) };
  });

  const named = k.full_name === null ? null : normName(k.full_name).join(' ') === normName(k.owner).join(' ');
  checks.push({ code: 'name_matches_account', label: LABEL['name_matches_account']!, by: 'computed', state: named === null ? 'open' : named ? 'pass' : 'warn', note: named === null ? 'Enter the name from the ID' : named ? 'Same words' : `The ID says “${k.full_name}”; the account says “${k.owner}”` });

  if (k.fingerprint === null) {
    checks.push({ code: 'not_used_by_another_store', label: LABEL['not_used_by_another_store']!, by: 'computed', state: 'open', note: 'Enter the ID number to check' });
  } else {
    const dup = (await on.query<{ name: string }>(
      `SELECT st.name FROM kyc_submissions o JOIN stores st ON st.id = o.store_id WHERE o.id_number_fingerprint = $1 AND o.store_id <> $2 LIMIT 3`,
      [k.fingerprint, k.store_id],
    )).rows;
    checks.push({ code: 'not_used_by_another_store', label: LABEL['not_used_by_another_store']!, by: 'computed', state: dup.length === 0 ? 'pass' : 'fail', note: dup.length === 0 ? 'No other store uses it' : `Also on ${dup.map((d) => d.name).join(', ')}` });
  }

  return {
    id: k.id,
    reference: Number(k.reference_number),
    status: k.status,
    storeId: k.store_id,
    storeName: k.store_name,
    storeSlug: k.store_slug,
    owner: k.owner,
    documentType: k.document_type,
    submittedAt: k.submitted_at.toISOString(),
    decisionNote: k.decision_note,
    documents: docs.rows.map((d) => ({ part: d.part, contentType: d.content_type, byteSize: d.byte_size === null ? null : Number(d.byte_size), purged: d.purged_at !== null, outcome: d.review_outcome })),
    checks,
    fields: { fullName: k.full_name, accountName: k.owner, dateOfBirth: k.date_of_birth === null ? null : k.date_of_birth.toISOString().slice(0, 10), expiresOn: k.document_expires_on === null ? null : k.document_expires_on.toISOString().slice(0, 10), idNumberMasked: k.id_number_masked, hasIdNumber: k.has_number },
  };
}

/**
 * One document's bytes — AFTER the audit entry. The entry is written in its own committed statement first and the object is
 * read second, so there is no ordering in which the file leaves unrecorded. A purged document answers 410: the footage is
 * gone by design, and "the video was deleted once the case was decided" is a fact the reviewer should be told, not a 404.
 */
export async function openDocument(caseId: string, part: Part, actorId: string, ctx: Ctx): Promise<{ bytes: Buffer; contentType: string }> {
  const d = (await db.query<{ storage_key: string; content_type: string; purged_at: Date | null; store_id: string; name: string }>(
    `SELECT d.storage_key, d.content_type, d.purged_at, d.store_id, u.name
       FROM kyc_documents d JOIN kyc_submissions k ON k.id = d.submission_id JOIN users u ON u.id = k.subject_user_id
      WHERE d.submission_id = $1 AND d.part = $2 AND d.superseded_at IS NULL`,
    [caseId, part],
  )).rows[0];
  if (d === undefined) throw notFound('That document was not sent.', 'NO_SUCH_DOCUMENT');
  if (d.purged_at !== null) throw new AppError({ status: 410, code: 'DOCUMENT_DELETED', message: 'That file was deleted once the case was decided.' });

  await db.query(
    `SELECT audit('sensitive', 'view_kyc_document', $1, $2, $3, NULL, 'kyc_submission', $4, $5::inet, $6, $7, jsonb_build_object('part', $8::text))`,
    [`Viewed ${part.replace('_', ' ')} · ${d.name}`, actorId, d.store_id, caseId, ctx.ip, ctx.userAgent, ctx.verifiedAt, part],
  );

  const [keyId, key] = d.storage_key.split(':') as [string, string];
  const bytes = await privateStore().read(key, keyId);
  if (bytes === null) throw notFound('The file is missing from storage.', 'DOCUMENT_MISSING');
  return { bytes, contentType: d.content_type };
}

export type Details = { fullName: string | null; dateOfBirth: string | null; expiresOn: string | null; idNumber: string | null };

/** What the reviewer read off the card. The number is sealed on the way in; the rest is display-safe. */
export async function recordDetails(caseId: string, actorId: string, d: Details, ctx: Ctx, tx: Tx): Promise<void> {
  const row = (await tx.query<{ status: string; store_id: string; name: string }>(
    `SELECT k.status, k.store_id, u.name FROM kyc_submissions k JOIN users u ON u.id = k.subject_user_id WHERE k.id = $1 FOR UPDATE OF k`,
    [caseId],
  )).rows[0];
  if (row === undefined) throw notFound('No such identity check.', 'NO_SUCH_CASE');
  if (row.status !== 'in_review') throw conflict('This check has been decided; its details can no longer be edited.', 'KYC_DECIDED');

  await tx.query(
    `UPDATE kyc_submissions SET full_name = $2, date_of_birth = $3::date, document_expires_on = $4::date WHERE id = $1`,
    [caseId, d.fullName, d.dateOfBirth, d.expiresOn],
  );
  if (d.idNumber !== null) {
    const sealed = sealIdNumber(d.idNumber);
    await tx.query(
      `UPDATE kyc_submissions SET id_number_encrypted = $2, encryption_key_id = $3, id_number_masked = $4, id_number_fingerprint = $5 WHERE id = $1`,
      [caseId, sealed.encrypted, sealed.keyId, sealed.masked, sealed.fingerprint],
    );
  }
  // The audit entry says that details were entered, never what they were: the number is exactly what the log must not hold.
  await tx.query(
    `SELECT audit('sensitive', 'record_identity_details', $1, $2, $3, NULL, 'kyc_submission', $4, $5::inet, $6, $7)`,
    [`Recorded details from the ID · ${row.name}${d.idNumber === null ? '' : ' (including the number)'}`, actorId, row.store_id, caseId, ctx.ip, ctx.userAgent, ctx.verifiedAt],
  );
}

export async function setCheck(caseId: string, code: string, outcome: 'pass' | 'warn' | 'fail', note: string | null, tx: Tx): Promise<void> {
  if (!(REVIEWER_CHECKS as readonly string[]).includes(code)) throw badRequest('That check is computed, not entered.', 'NOT_A_REVIEWER_CHECK');
  const row = (await tx.query<{ status: string; store_id: string }>(`SELECT status, store_id FROM kyc_submissions WHERE id = $1 FOR UPDATE`, [caseId])).rows[0];
  if (row === undefined) throw notFound('No such identity check.', 'NO_SUCH_CASE');
  if (row.status !== 'in_review') throw conflict('This check has been decided.', 'KYC_DECIDED');
  await tx.query(
    `INSERT INTO kyc_checks (submission_id, store_id, check_code, outcome, note, vendor_name)
          VALUES ($1, $2, $3, $4, $5, 'reviewer')
     ON CONFLICT (submission_id, check_code) DO UPDATE SET outcome = EXCLUDED.outcome, note = EXCLUDED.note, ran_at = now()`,
    [caseId, row.store_id, code, outcome, note],
  );
}

/** The full number, through the one function that writes the entry first. A reason is required by the database itself. */
export async function reveal(caseId: string, actorId: string, reason: string, ctx: Ctx, tx: Tx): Promise<string> {
  const r = (await tx.query<{ id_number_encrypted: Buffer; encryption_key_id: string }>(
    `SELECT id_number_encrypted, encryption_key_id FROM reveal_kyc_id_number($1, $2, $3, $4::inet, $5, $6)`,
    [caseId, actorId, reason, ctx.ip, ctx.userAgent, ctx.verifiedAt],
  )).rows[0];
  if (r === undefined) throw notFound('No ID number was recorded.', 'NO_ID_NUMBER');
  return revealIdNumber(r.id_number_encrypted, r.encryption_key_id);
}

export const PART_OF: Record<string, Part> = { front: 'id_front', back: 'id_back', video: 'face_video' };

/**
 * approve | reject | redo — through decide_kyc(), which owns the rules (one decision, a reason for a refusal, one part for a
 * retake, the audit entry). This adds the merchant's notification and returns false when somebody else decided first.
 */
export async function decide(caseId: string, actorId: string, outcome: 'approve' | 'reject' | 'redo', note: string | null, part: string | null, tx: Tx): Promise<boolean> {
  if (outcome === 'redo' && (part === null || PART_OF[part] === undefined)) throw badRequest('Say which part to redo.', 'PART_REQUIRED');
  const row = (await tx.query<{ store_id: string }>(`SELECT store_id FROM kyc_submissions WHERE id = $1`, [caseId])).rows[0];
  if (row === undefined) throw notFound('No such identity check.', 'NO_SUCH_CASE');
  if (outcome !== 'approve' && (note === null || note.trim() === '')) throw badRequest('Tell the merchant why — they read this sentence.', 'REASON_REQUIRED');

  const ok = (await tx.query<{ decided: boolean }>(`SELECT decide_kyc($1, $2, $3, $4, $5) AS decided`, [caseId, actorId, outcome, note, part === null ? null : PART_OF[part]])).rows[0]?.decided === true;
  if (!ok) return false;

  const type = outcome === 'approve' ? 'identity_verified' : outcome === 'reject' ? 'identity_rejected' : 'identity_retake';
  await tx.query(`SELECT notify($1, $2, $3, '{}'::jsonb, NULL, NULL, NULL, NULL, NULL)`, [row.store_id, type, `identity-${caseId}-${outcome}`]);
  return true;
}

