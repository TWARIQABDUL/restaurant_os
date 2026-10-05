// server/test/api/kyc.test.ts — milestone 26: the merchant's identity check.
//
//   1. ONLY SOMEBODY WHO MAY CHANGE SETTINGS can start, send or read a check — a manager cannot.
//   2. WHAT A FILE IS decided by its bytes: HTML declared as a photo is refused, and a passport has no back.
//   3. NOTHING IS STORED IN THE CLEAR. The object on disk is sealed, opens only with the key, and a tampered one refuses.
//   4. THE CASE FOLLOWS THE DATABASE'S STATES — building, in review, a retake of ONE part, approved — and a case in review
//      does not take new uploads under the reviewer.
//   5. THE FACE VIDEO IS DELETED ONCE USED; THE ID PHOTOS ARE KEPT. Decided case → video due → purge deletes the object and
//      clears the pointer; the ID photos are untouched. A replaced video is due at once.
//   6. THE ID NUMBER IS SEALED: no plaintext in the row, a mask with something hidden, a keyed fingerprint, and it comes
//      back only through the key.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { revealIdNumber } from '../../src/crypto/kyc.ts';
import * as kyc from '../../src/repositories/kyc.ts';
import { localPrivateStore, setPrivateStore } from '../../src/storage/private.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { STORE, USER, cleanup, seedFixtures } from './support.ts';

process.env['KYC_ENCRYPTION_KEY'] ??= Buffer.alloc(32, 7).toString('base64');
process.env['KYC_FINGERPRINT_PEPPER'] ??= 'test-pepper-test-pepper-test-pepper';

let api: Api;
let dir: string;
const owner = (): string => tokenFor(USER.ownerA);
const manager = (): string => tokenFor(USER.managerA);
const base = `/api/stores/${STORE.a}/kyc`;

type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => v as Json;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-pretend-this-is-a-photo-of-an-id-card')]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('pretend-this-is-five-seconds-of-a-face')]);

async function put(part: string, body: Buffer, contentType: string, token = owner(), query = ''): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': contentType };
  const jar = [...api.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  if (jar !== '') headers['Cookie'] = jar;
  const csrf = api.cookies.get('csrf');
  if (csrf !== undefined) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${api.baseUrl}${base}/documents/${part}${query}`, { method: 'POST', headers, body });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Json) };
}

const state = async (): Promise<Json> => asJson((await call(api, 'GET', base, { token: owner() })).body);
const partsOf = (s: Json): Record<string, string> => Object.fromEntries((asJson(s['submission'])['parts'] as Json[]).map((p) => [p['part'] as string, p['state'] as string]));
const decide = (outcome: string, note: string | null, redoPart: string | null = null): Promise<unknown> =>
  sql(
    `SELECT decide_kyc((SELECT id FROM kyc_submissions WHERE store_id = $1 AND status = 'in_review'), $2, $3, $4, $5)`,
    [STORE.a, USER.superAdmin, outcome, note, redoPart],
  );

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kyc-test-'));
  setPrivateStore(localPrivateStore(dir));
  api = await boot();
  await seedFixtures();
});

after(async () => {
  await cleanup();
  setPrivateStore(null);
  await rm(dir, { recursive: true, force: true });
  await api.close();
  await closePool();
});

describe('who may', () => {
  it('a manager can neither read, upload nor send', async () => {
    assert.equal((await call(api, 'GET', base, { token: manager() })).status, 403);
    assert.equal((await put('id_front', JPEG, 'image/jpeg', manager())).status, 403);
    assert.equal((await call(api, 'POST', `${base}/submit`, { token: manager() })).status, 403);
  });

  it('a store with no check says so, and is not verified', async () => {
    const s = await state();
    assert.equal(s['outcome'], 'none');
    assert.equal(s['verified'], false);
    assert.equal(s['submission'], null);
  });
});

describe('what a file is', () => {
  it('refuses HTML declared as a photo, a photo as a video, and a passport back', async () => {
    assert.equal((await put('id_front', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png')).status, 415);
    assert.equal((await put('face_video', JPEG, 'video/webm')).status, 415, 'a photo is not a video');
    assert.equal((await put('id_front', WEBM, 'image/jpeg')).status, 415, 'a video is not a photo');
    assert.equal((await put('id_back', JPEG, 'image/jpeg', owner(), '?type=passport')).status, 400, 'a passport has no back');
    assert.equal((await put('selfie', JPEG, 'image/jpeg')).status, 400, 'not a part of the check');
    assert.equal((await state())['outcome'], 'none', 'nothing refused left a case behind');
  });
});

describe('storing', () => {
  it('seals what it stores: the bytes on disk are not the photo, open with the key, and refuse when altered', async () => {
    const r = await put('id_front', JPEG, 'image/jpeg');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body['outcome'], 'building');
    assert.deepEqual(partsOf(r.body), { id_front: 'received', id_back: 'missing', face_video: 'missing' });

    const row = (await sql<{ storage_key: string }>(`SELECT storage_key FROM kyc_documents WHERE store_id = $1 AND part = 'id_front'`, [STORE.a])).rows[0]!;
    const [keyId, key] = row.storage_key.split(':') as [string, string];
    const onDisk = await readFile(join(dir, key.slice(0, 2), key));
    assert.ok(!onDisk.includes(Buffer.from('JFIF-pretend')), 'the photo is not readable on disk');
    assert.notDeepEqual([...onDisk.subarray(0, 3)], [0xff, 0xd8, 0xff], 'and does not start like a JPEG');

    const opened = await localPrivateStore(dir).read(key, keyId);
    assert.deepEqual(opened, JPEG, 'it opens to exactly what was sent');

    const path = join(dir, key.slice(0, 2), key);
    const tampered = Buffer.from(onDisk);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    await writeFile(path, tampered);
    await assert.rejects(() => localPrivateStore(dir).read(key, keyId), 'an altered file does not open as something else');
    await writeFile(path, onDisk);
  });

  it('will not store an identity document without a key', async () => {
    const saved = process.env['KYC_ENCRYPTION_KEY'];
    delete process.env['KYC_ENCRYPTION_KEY'];
    try {
      const r = await put('id_back', JPEG, 'image/jpeg');
      assert.equal(r.status, 503);
      assert.equal(r.body['code'], 'KYC_NOT_CONFIGURED');
    } finally {
      process.env['KYC_ENCRYPTION_KEY'] = saved;
    }
  });
});

describe('the case', () => {
  it('will not be sent until every part is there, then goes to review', async () => {
    const early = await call(api, 'POST', `${base}/submit`, { token: owner() });
    assert.equal(early.status, 400);
    assert.match(String(early.body['error']), /back of your ID.*face video/);

    assert.equal((await put('id_back', JPEG, 'image/jpeg')).status, 201);
    assert.equal((await put('face_video', WEBM, 'video/webm')).status, 201);
    const sent = await call(api, 'POST', `${base}/submit`, { token: owner() });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body['outcome'], 'inReview');
  });

  it('does not take new files while a reviewer is looking at the old ones, and does not send twice', async () => {
    assert.equal((await put('id_back', JPEG, 'image/jpeg')).status, 409);
    assert.equal((await call(api, 'POST', `${base}/submit`, { token: owner() })).status, 409);
  });

  it('a retake asks for ONE part and leaves the others accepted, with the reviewer\'s sentence', async () => {
    assert.equal(await decide('redo', 'The back of your ID is blurry.', 'id_back').then(() => true), true);
    const s = await state();
    assert.equal(s['outcome'], 'redoRequested');
    assert.deepEqual(partsOf(s), { id_front: 'accepted', id_back: 'retake', face_video: 'accepted' });
    assert.equal(asJson(s['submission'])['decisionNote'], 'The back of your ID is blurry.');

    // Answering the retake puts the case back in building; sending it puts it back in the queue.
    assert.equal((await put('id_back', JPEG, 'image/jpeg')).body['outcome'], 'building');
    assert.equal((await call(api, 'POST', `${base}/submit`, { token: owner() })).body['outcome'], 'inReview');
  });
});

describe('retention: the video goes, the ID stays', () => {
  const files = async (): Promise<number> => (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.bin')).length;

  it('a decided case makes its face video due, and the sweep deletes that object and nothing else', async () => {
    const before = await files();
    const video = (await sql<{ storage_key: string; retain_until: Date | null }>(`SELECT storage_key, retain_until FROM kyc_documents WHERE store_id = $1 AND part = 'face_video' AND superseded_at IS NULL`, [STORE.a])).rows[0]!;
    assert.equal(video.retain_until, null, 'not due while the case is open');

    await decide('approve', null);
    const due = (await sql<{ part: string; retain_until: Date | null }>(`SELECT part, retain_until FROM kyc_documents WHERE store_id = $1 AND superseded_at IS NULL ORDER BY part`, [STORE.a])).rows;
    assert.deepEqual(due.map((d) => [d.part, d.retain_until !== null]), [['face_video', true], ['id_back', false], ['id_front', false]], 'only the video is due');

    const removed = await kyc.purgeDue();
    assert.ok(removed >= 1);
    assert.equal(await files(), before - 1, 'one object deleted');
    const after = (await sql<{ part: string; storage_key: string; purged_at: Date | null }>(`SELECT part, storage_key, purged_at FROM kyc_documents WHERE store_id = $1 AND superseded_at IS NULL ORDER BY part`, [STORE.a])).rows;
    assert.deepEqual(after.map((d) => [d.part, d.purged_at !== null, d.storage_key === '']), [['face_video', true, true], ['id_back', false, false], ['id_front', false, false]]);
    assert.equal(await localPrivateStore(dir).read(video.storage_key.split(':')[1]!, video.storage_key.split(':')[0]!), null, 'the footage is gone');

    const s = await state();
    assert.equal(s['outcome'], 'approved');
    assert.equal(s['verified'], true);
  });

  it('a second sweep finds nothing', async () => {
    assert.equal(await kyc.purgeDue(), 0);
  });
});

describe('the ID number', () => {
  it('is sealed, masked and fingerprinted, and comes back only through the key', async () => {
    const id = (await sql<{ id: string }>(`SELECT id FROM kyc_submissions WHERE store_id = $1`, [STORE.a])).rows[0]!.id;
    await kyc.recordIdNumber(id, '1 1994 7 0012345 0 18');
    const row = (await sql<{ id_number_encrypted: Buffer; encryption_key_id: string; id_number_masked: string; id_number_fingerprint: string }>(
      `SELECT id_number_encrypted, encryption_key_id, id_number_masked, id_number_fingerprint FROM kyc_submissions WHERE id = $1`, [id])).rows[0]!;

    assert.ok(!row.id_number_encrypted.includes(Buffer.from('1199470012345018')), 'no plaintext in the row');
    assert.match(row.id_number_masked, /•/);
    assert.ok(!row.id_number_masked.includes('0012345'), 'the middle is hidden');
    assert.match(row.id_number_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(revealIdNumber(row.id_number_encrypted, row.encryption_key_id), '1199470012345018');

    // The same number, written differently, is the same fingerprint: duplicate detection survives spaces and dashes.
    const { fingerprintOf } = await import('../../src/crypto/kyc.ts');
    assert.equal(fingerprintOf('1-1994-7-0012345-0-18'), row.id_number_fingerprint);
  });
});
