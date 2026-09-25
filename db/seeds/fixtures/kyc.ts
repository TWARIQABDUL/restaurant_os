// db/seeds/fixtures/kyc.ts
//
// Identity checks in the three states §4.5 asks for: submitted, approved, redo.
//
// The three active stores are approved, because a store that takes payouts must be —
// `request_withdrawal` refuses otherwise, and the money fixtures above would fail
// without this. Ubwiza Beauty is still being read and Kigali Tech Hub has been asked
// for a new photo of the back of an ID, which are KYCOutcomes' `inReview` and
// `redoRequested` screens.
//
// The ID numbers are NOT stored. What is stored is a masked form for review, a
// fingerprint for "not used by another store", and a bytea standing in for
// ciphertext — the key belongs outside the database and the seed does not invent one,
// so `encryption_key_id` names a key that does not exist here on purpose.

import { STORE, STAFF, TEAM, KYC, type Ctx } from './context.ts';

type Case = {
  id: string;
  store: string;
  subject: string;
  name: string;
  masked: string;
  dob: string;
  expires: string;
  outcome: 'approved' | 'submitted' | 'redo';
  checks: [string, 'pass' | 'warn' | 'fail', string][];
  note?: string;
  redoPart?: 'id_front' | 'id_back' | 'face_video';
  blurry?: 'id_front' | 'id_back';
};

const ALL_PASS: Case['checks'] = [
  ['document_genuine', 'pass', 'No edits found'],
  ['face_in_view', 'pass', '50 of 50 frames'],
  ['liveness', 'pass', 'Turned head and blinked'],
  ['face_matches_document', 'pass', 'Strong match'],
  ['name_matches_registration', 'pass', 'Exact'],
  ['not_used_by_another_store', 'pass', 'No duplicates'],
];

const CASES: Case[] = [
  {
    id: KYC.nyama, store: STORE.nyama, subject: STAFF.aline, name: 'UWASE Aline',
    masked: '1 1991 8 ••••••• 0 42', dob: '1991-07-09', expires: '2029-11-30',
    outcome: 'approved', checks: ALL_PASS, note: 'All checks passed',
  },
  {
    id: KYC.inzu, store: STORE.inzu, subject: STAFF.kevin, name: 'NKUSI Kevin',
    masked: '1 1988 3 ••••••• 1 07', dob: '1988-02-21', expires: '2030-04-30',
    outcome: 'approved', checks: ALL_PASS, note: 'All checks passed',
  },
  {
    id: KYC.kicks, store: STORE.kicks, subject: STAFF.yves, name: 'BIZIMANA Yves',
    masked: '1 1995 1 ••••••• 0 88', dob: '1995-10-02', expires: '2032-01-31',
    outcome: 'approved', checks: ALL_PASS, note: 'All checks passed',
  },
  {
    // "We're checking your ID. Most checks are done within 24 hours." — the
    // automatic pass has not finished, so there is nothing for a reviewer to do yet.
    id: KYC.ubwiza, store: STORE.ubwiza, subject: STAFF.claudine, name: 'MUKAMANA Claudine',
    masked: '1 1994 7 ••••••• 0 18', dob: '1994-03-14', expires: '2031-06-30',
    outcome: 'submitted', checks: [],
  },
  {
    // AdminKYC's second case, verbatim: front sharp, back unreadable.
    id: KYC.techhub, store: STORE.techhub, subject: STAFF.habimana, name: 'HABIMANA Olivier',
    masked: '1 1990 2 ••••••• 1 55', dob: '1990-11-02', expires: '2028-08-31',
    outcome: 'redo', redoPart: 'id_back', blurry: 'id_back',
    note: 'The back of your ID is blurry, so we can’t read the numbers. Take it on a flat, dark surface with good light.',
    checks: [
      ['document_genuine', 'warn', 'Front OK, back unreadable'],
      ['face_in_view', 'pass', '50 of 50 frames'],
      ['liveness', 'pass', 'Turned head and blinked'],
      ['face_matches_document', 'pass', 'Strong match'],
      ['name_matches_registration', 'pass', 'Exact'],
      ['not_used_by_another_store', 'pass', 'No duplicates'],
    ],
  },
];

export async function seedKyc(ctx: Ctx): Promise<void> {
  ctx.step('Identity checks');

  for (const c of CASES) {
    const created = await ctx.sql<{ id: string }>(`SELECT submit_kyc($1, $2, 'national_id') AS id`, [c.store, c.subject]);
    const submissionId = created.rows[0]!.id;
    // submit_kyc allocates the id; adopt the fixed one so a bookmarked case survives
    // a re-seed. Done before anything references it.
    await ctx.sql(`UPDATE kyc_submissions SET id = $2 WHERE id = $1`, [submissionId, c.id]);

    await ctx.sql(
      `UPDATE kyc_submissions
          SET id_number_masked = $2,
              id_number_encrypted = decode($3, 'hex'),
              encryption_key_id = 'kyc-2026-q3',
              id_number_fingerprint = encode(sha256($4::bytea), 'hex'),
              full_name = $5, date_of_birth = $6, document_expires_on = $7
        WHERE id = $1`,
      [c.id, c.masked, '00'.repeat(24), `fingerprint-of-${c.id}`, c.name, c.dob, c.expires],
    );

    for (const part of ['id_front', 'id_back', 'face_video'] as const) {
      await ctx.sql(
        `SELECT attach_kyc_document($1, $2, $3, $4, $5)`,
        [c.id, part, `kyc/${c.id}/${part}`, part === 'face_video' ? 'video/mp4' : 'image/jpeg',
         part === 'face_video' ? 1_400_000 : 204_800],
      );
      await ctx.sql(
        `UPDATE kyc_documents SET quality = $3, quality_note = $4
          WHERE submission_id = $1 AND part = $2 AND superseded_at IS NULL`,
        [c.id, part, c.blurry === part ? 'blurry' : 'sharp',
         c.blurry === part ? 'Numbers unreadable' : null],
      );
    }

    for (const [code, outcome, note] of c.checks) {
      await ctx.sql(
        `INSERT INTO kyc_checks (submission_id, store_id, check_code, outcome, note, vendor_name, vendor_result)
         VALUES ($1, $2, $3, $4, $5, 'seed-fixture', jsonb_build_object('seeded', true))`,
        [c.id, c.store, code, outcome, note],
      );
    }

    await ctx.sql(
      `INSERT INTO kyc_extracted_fields (submission_id, store_id, field_key, display_value, verdict) VALUES
         ($1, $2, 'full_name',           $3, 'match'),
         ($1, $2, 'id_number',           $4, $6),
         ($1, $2, 'date_of_birth',       $5, 'match')`,
      [c.id, c.store, c.name, c.blurry === 'id_back' ? 'Couldn’t read back' : c.masked,
       new Date(c.dob).toDateString(), c.blurry === 'id_back' ? 'unread' : 'match'],
    );

    if (c.outcome === 'submitted') continue;

    await ctx.sql(`SELECT complete_kyc_checks($1)`, [c.id]);

    if (c.outcome === 'approved') {
      await ctx.sql(`SELECT decide_kyc($1, $2, 'approve', $3)`, [c.id, TEAM.grace, c.note ?? null]);
    } else {
      await ctx.sql(`SELECT decide_kyc($1, $2, 'redo', $3, $4)`, [c.id, TEAM.olive, c.note ?? null, c.redoPart!]);
    }
  }

  // The sensitive view AdminAudit's first row records. Doing it here means the seed
  // also produces the audit entry, because the function cannot return the ciphertext
  // without writing one.
  await ctx.sql(
    `SELECT * FROM reveal_kyc_id_number($1, $2, 'matching RDB record', '41.186.0.11', 'Mozilla/5.0', now() - interval '2 hours')`,
    [KYC.ubwiza, TEAM.olive],
  );

  const states = await ctx.sql<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM kyc_submissions GROUP BY status ORDER BY status`,
  );
  ctx.ok(states.rows.map((r) => `${r.n} ${r.status}`).join(', '));
  ctx.ok('one ID number revealed, which wrote its own sensitive-view audit entry');
}
