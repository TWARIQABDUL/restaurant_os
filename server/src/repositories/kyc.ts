// server/src/repositories/kyc.ts — milestone 26: the merchant's side of identity verification.
//
// V012 holds the rules (five states, a retake is per part, one live case per store, approval needs every part, the reveal
// writes its own audit entry). This file is the application's way in, and it adds three things the database cannot know:
//
//   * WHAT THE MERCHANT IS TOLD. A submission's five statuses are the database's vocabulary; KYCOutcomes draws four
//     screens, and the one that matters most — "building" (documents arriving, nothing submitted) — is not a status at all,
//     it is `submitted` with `checks_completed_at` still null. `outcomeOf` is the one place that translation lives.
//   * THAT BYTES AND ROWS AGREE. A document row is only written after its bytes are sealed and stored, and the old
//     bytes of a replaced part are deleted after the swap, so a crash leaves an orphaned object (harmless, unreferenced,
//     sealed) rather than a row pointing at nothing.
//   * THE VIDEO'S DELETION. V028 makes a decided case's face video due; `purgeDue()` is what acts on it.
//
// THE ID NUMBER IS NOT COLLECTED HERE. The board draws photos and a video and nothing else, and there is no OCR — so the
// number is read off the photo by the reviewer and recorded with `recordIdNumber`, which seals it. That keeps the
// merchant's flow the board's and puts the one human reading in the one place that is audited.

import { badRequest, conflict, db, withTransaction } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import { sealIdNumber } from '../crypto/kyc.ts';
import { privateStore } from '../storage/private.ts';

export type Part = 'id_front' | 'id_back' | 'face_video';
export type DocumentType = 'national_id' | 'passport';

export const PARTS: readonly Part[] = ['id_front', 'id_back', 'face_video'];
export const requiredParts = (type: DocumentType): Part[] => (type === 'passport' ? ['id_front', 'face_video'] : ['id_front', 'id_back', 'face_video']);

/** What the screen is: the board's four outcomes, plus the two states before and around them. */
export type Outcome = 'none' | 'building' | 'inReview' | 'redoRequested' | 'rejected' | 'approved';

export type PartState = 'missing' | 'received' | 'accepted' | 'retake';

export type KycStatus = {
  outcome: Outcome;
  /** store_is_verified(): derived from an approved case, never a flag. Payouts ask the same function. */
  verified: boolean;
  submission: null | {
    id: string;
    reference: number;
    documentType: DocumentType;
    submittedAt: string;
    decisionNote: string | null;
    parts: { part: Part; state: PartState; purged: boolean }[];
  };
};

type Row = {
  id: string;
  reference_number: string;
  document_type: DocumentType;
  status: 'submitted' | 'in_review' | 'redo_requested' | 'approved' | 'rejected';
  checks_completed_at: Date | null;
  submitted_at: Date;
  decision_note: string | null;
};

export function outcomeOf(status: Row['status'], checksCompleted: boolean): Outcome {
  switch (status) {
    case 'submitted':
      return checksCompleted ? 'inReview' : 'building';
    case 'in_review':
      return 'inReview';
    case 'redo_requested':
      return 'redoRequested';
    case 'rejected':
      return 'rejected';
    case 'approved':
      return 'approved';
  }
}

async function latest(storeId: string, on: Queryable): Promise<Row | null> {
  // Newest first, but a LIVE case beats a decided one created later by the clock: there can be only one live case, and
  // it is the one the merchant is working on.
  const { rows } = await on.query<Row>(
    `SELECT id, reference_number::text, document_type, status, checks_completed_at, submitted_at, decision_note
       FROM kyc_submissions
      WHERE store_id = $1
      ORDER BY (status IN ('submitted', 'in_review', 'redo_requested')) DESC, created_at DESC
      LIMIT 1`,
    [storeId],
  );
  return rows[0] ?? null;
}

export async function status(storeId: string, on: Queryable = db): Promise<KycStatus> {
  const verified = (await on.query<{ v: boolean }>(`SELECT store_is_verified($1) AS v`, [storeId])).rows[0]?.v === true;
  const row = await latest(storeId, on);
  if (row === null) return { outcome: 'none', verified, submission: null };

  const docs = await on.query<{ part: Part; review_outcome: 'accepted' | 'retake' | null; purged_at: Date | null }>(
    `SELECT part, review_outcome, purged_at FROM kyc_documents WHERE submission_id = $1 AND superseded_at IS NULL`,
    [row.id],
  );
  const live = new Map(docs.rows.map((d) => [d.part, d]));
  const parts = requiredParts(row.document_type).map((part) => {
    const d = live.get(part);
    const state: PartState = d === undefined ? 'missing' : d.review_outcome === 'accepted' ? 'accepted' : d.review_outcome === 'retake' ? 'retake' : 'received';
    return { part, state, purged: d?.purged_at != null };
  });

  return {
    outcome: outcomeOf(row.status, row.checks_completed_at !== null),
    verified,
    submission: {
      id: row.id,
      reference: Number(row.reference_number),
      documentType: row.document_type,
      submittedAt: row.submitted_at.toISOString(),
      decisionNote: row.decision_note,
      parts,
    },
  };
}

/**
 * Stores one part, opening the case if there is none. Returns the new status.
 *
 * A case is open for documents while it is being put together (`submitted`, not yet checked) or after a retake was asked
 * for. Once it is in review it is not taking uploads — the reviewer is looking at THOSE files — and the merchant is told so
 * rather than being allowed to swap evidence under a reader.
 */
export async function attach(
  storeId: string,
  userId: string,
  input: { part: Part; documentType: DocumentType; bytes: Buffer; contentType: string },
): Promise<KycStatus> {
  const { part, documentType } = input;
  if (documentType === 'passport' && part === 'id_back') throw badRequest('A passport has no back to photograph.', 'NO_BACK_SIDE');

  // BYTES FIRST, ROWS SECOND. The object is sealed and written before any row refers to it.
  const stored = await privateStore().put(input.bytes);
  const storageKey = `${stored.keyId}:${stored.key}`;

  try {
    await withTransaction(
      async (tx) => {
        const current = await latest(storeId, tx);
        const open = current !== null && ['submitted', 'redo_requested'].includes(current.status) ? current : null;

        if (current !== null && current.status === 'in_review') {
          throw conflict('Your documents are being checked. We’ll tell you if anything needs retaking.', 'KYC_IN_REVIEW');
        }
        if (current !== null && current.status === 'approved') throw conflict('You’re already verified.', 'KYC_APPROVED');

        let submissionId: string;
        if (open === null) {
          const made = await tx.query<{ id: string }>(`SELECT submit_kyc($1, $2, $3) AS id`, [storeId, userId, documentType]);
          const id = made.rows[0]?.id;
          if (id === undefined) throw new Error('submit_kyc returned nothing');
          submissionId = id;
        } else {
          submissionId = open.id;
          // A merchant who started with a national ID and switches to a passport changes the type — only while the case is
          // still being built, because a retake is a retake of the same document.
          if (open.document_type !== documentType) {
            if (open.status !== 'submitted') throw badRequest('A retake has to be of the same document.', 'DOCUMENT_TYPE_LOCKED');
            await tx.query(`UPDATE kyc_submissions SET document_type = $2 WHERE id = $1`, [submissionId, documentType]);
            if (documentType === 'passport') {
              await tx.query(`UPDATE kyc_documents SET superseded_at = now() WHERE submission_id = $1 AND part = 'id_back' AND superseded_at IS NULL`, [submissionId]);
            }
          }
        }

        await tx.query(`SELECT attach_kyc_document($1, $2, $3, $4, $5)`, [submissionId, part, storageKey, input.contentType, input.bytes.length]);
      },
      { label: 'POST /kyc/documents', retries: 0 },
    );
  } catch (cause) {
    await privateStore().delete(stored.key).catch(() => undefined);
    throw cause;
  }

  // A replaced ID photo stays as the record of what was first sent (V012: "a superseded row stays") and is kept like the
  // rest. A replaced VIDEO was scheduled for deletion by V028 the moment it was superseded; purgeDue() removes the object.
  return status(storeId);
}

/** The merchant presses Send: every part is there, so the case moves to the reviewer's queue. */
export async function submit(storeId: string): Promise<KycStatus> {
  await withTransaction(
    async (tx) => {
      const current = await latest(storeId, tx);
      if (current === null || current.status !== 'submitted') {
        throw conflict(current === null ? 'Add your documents first.' : 'This check has already been sent.', 'KYC_NOT_OPEN');
      }
      const have = await tx.query<{ part: Part }>(
        `SELECT part FROM kyc_documents WHERE submission_id = $1 AND superseded_at IS NULL AND purged_at IS NULL`,
        [current.id],
      );
      const got = new Set(have.rows.map((r) => r.part));
      const missing = requiredParts(current.document_type).filter((p) => !got.has(p));
      if (missing.length > 0) throw badRequest(`Still needed: ${missing.map(partName).join(', ')}.`, 'KYC_INCOMPLETE');
      await tx.query(`SELECT complete_kyc_checks($1)`, [current.id]);
    },
    { label: 'POST /kyc/submit', retries: 0 },
  );
  return status(storeId);
}

export const partName = (p: Part): string => (p === 'id_front' ? 'the front of your ID' : p === 'id_back' ? 'the back of your ID' : 'your face video');

/**
 * Records the number the reviewer read off the photo, sealed. Called by the admin console (M27); built and tested here
 * because it is where the encryption key meets the schema, and an untested seal is the thing that fails the day a
 * regulator asks.
 */
export async function recordIdNumber(submissionId: string, raw: string, on: Queryable = db): Promise<void> {
  const s = sealIdNumber(raw);
  await on.query(
    `UPDATE kyc_submissions
        SET id_number_encrypted = $2, encryption_key_id = $3, id_number_masked = $4, id_number_fingerprint = $5
      WHERE id = $1`,
    [submissionId, s.encrypted, s.keyId, s.masked, s.fingerprint],
  );
}

/**
 * Deletes the objects whose retention has passed — in practice, face videos of decided cases and replaced videos.
 * The database clears the pointer first (purge_expired_kyc_documents) and returns the keys; the objects go second, so a
 * crash between the two leaves an unreferenced sealed file rather than a row pointing at a deleted one.
 */
export async function purgeDue(): Promise<number> {
  const due = await withTransaction(
    async (tx) => (await tx.query<{ purged_storage_key: string }>(`SELECT purged_storage_key FROM purge_expired_kyc_documents()`)).rows,
    { label: 'kyc purge', retries: 0 },
  );
  for (const row of due) {
    const key = row.purged_storage_key.split(':')[1];
    if (key !== undefined) await privateStore().delete(key);
  }
  return due.length;
}
