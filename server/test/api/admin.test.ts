// server/test/api/admin.test.ts — milestone 27: the platform team's API, and the escalation tests for the platform scope that
// middleware/authorize.ts promised when it declined to ship requirePlatformPermission without them.
//
//   1. NOBODY BUT THE PLATFORM TEAM. No token is a 401; a store's owner, admin and manager are each a 403 on every admin route,
//      and the platform admin is NOT thereby a member of any store (a 403 from a merchant's own endpoint).
//   2. SUSPENDING A STORE DOES WHAT THE DIALOG SAYS: the storefront refuses it, its payouts are held, the reason is on the
//      record, and reinstating undoes both. Neither can be done twice.
//   3. A DOCUMENT IS NEVER READ UNRECORDED. Opening an ID photo writes the audit entry; the bytes are exactly what was sent;
//      a deleted video answers 410.
//   4. THE NUMBER IS NEVER IN A RESPONSE UNTIL ASKED FOR WITH A REASON, and asking is itself an entry in the log.
//   5. THE DECISION IS ONE-SHOT AND TELLS THE MERCHANT: a refusal needs a sentence, a retake names one part, and the
//      merchant's bell has the outcome.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import * as kyc from '../../src/repositories/kyc.ts';
import { localPrivateStore, setPrivateStore } from '../../src/storage/private.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { STORE, USER, cleanup, seedFixtures } from './support.ts';

process.env['KYC_ENCRYPTION_KEY'] ??= Buffer.alloc(32, 7).toString('base64');
process.env['KYC_FINGERPRINT_PEPPER'] ??= 'test-pepper-test-pepper-test-pepper';

let api: Api;
let dir: string;
const team = (): string => tokenFor(USER.superAdmin);
const owner = (): string => tokenFor(USER.ownerA);
const admin = (): string => tokenFor(USER.adminA);
const manager = (): string => tokenFor(USER.managerA);
const adminB = (): string => tokenFor(USER.adminB);

type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => v as Json;
const list = (v: unknown): Json[] => v as Json[];

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-the-front-of-an-id')]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('five-seconds-of-a-face')]);

async function upload(storeId: string, token: string, part: string, body: Buffer, contentType: string): Promise<number> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': contentType };
  const jar = [...api.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  if (jar !== '') headers['Cookie'] = jar;
  const csrf = api.cookies.get('csrf');
  if (csrf !== undefined) headers['X-CSRF-Token'] = csrf;
  return (await fetch(`${api.baseUrl}/api/stores/${storeId}/kyc/documents/${part}`, { method: 'POST', headers, body })).status;
}

/** A complete case on a fixture store, sent through the merchant's own endpoints, and its id. */
async function sentCase(storeId: string, token: string): Promise<string> {
  assert.equal(await upload(storeId, token, 'id_front', JPEG, 'image/jpeg'), 201);
  assert.equal(await upload(storeId, token, 'id_back', JPEG, 'image/jpeg'), 201);
  assert.equal(await upload(storeId, token, 'face_video', WEBM, 'video/webm'), 201);
  assert.equal((await call(api, 'POST', `/api/stores/${storeId}/kyc/submit`, { token })).status, 200);
  return (await sql<{ id: string }>(`SELECT id FROM kyc_submissions WHERE store_id = $1 AND status = 'in_review'`, [storeId])).rows[0]!.id;
}

const audits = async (action: string, storeId: string): Promise<number> =>
  Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = $1 AND store_id = $2`, [action, storeId])).rows[0]!.n);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'admin-test-'));
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
  const routes: [string, string][] = [
    ['GET', '/me'], ['GET', '/overview'], ['GET', '/merchants'], ['GET', `/merchants/${STORE.a}`],
    ['POST', `/merchants/${STORE.a}/suspend`], ['POST', `/merchants/${STORE.a}/reinstate`],
    ['GET', '/kyc'], ['GET', `/kyc/${STORE.a}`], ['GET', `/kyc/${STORE.a}/documents/id_front`],
    ['PUT', `/kyc/${STORE.a}/details`], ['PUT', `/kyc/${STORE.a}/checks/liveness`],
    ['POST', `/kyc/${STORE.a}/reveal`], ['POST', `/kyc/${STORE.a}/decision`],
  ];

  it('no session is a 401 on every admin route', async () => {
    for (const [method, path] of routes) assert.equal((await call(api, method, `/api/admin${path}`, method === 'GET' ? {} : { body: {} })).status, 401, `${method} ${path}`);
  });

  it('a store owner, admin and manager are each a 403 on every admin route — seniority in a store buys nothing here', async () => {
    for (const token of [owner(), admin(), manager(), adminB()]) {
      for (const [method, path] of routes) assert.equal((await call(api, method, `/api/admin${path}`, method === 'GET' ? { token } : { token, body: {} })).status, 403, `${method} ${path}`);
    }
  });

  it('and the platform admin is not a member of any store: the merchant console refuses them', async () => {
    assert.equal((await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: team() })).status, 403);
    assert.equal((await call(api, 'GET', `/api/stores/${STORE.a}/kyc`, { token: team() })).status, 403);
  });

  it('the platform admin is told who they are and what they may do', async () => {
    const me = asJson((await call(api, 'GET', '/api/admin/me', { token: team() })).body);
    assert.equal(me['role'], 'super_admin');
    for (const p of ['kyc.review', 'stores.suspend', 'merchants.read', 'audit.read']) assert.ok((me['permissions'] as string[]).includes(p), p);
    assert.ok(!(me['permissions'] as string[]).includes('wallet.read'), 'no store permission rides along');
  });
});

describe('overview', () => {
  it('answers each range with five figures and the queue, providers, industries and activity', async () => {
    for (const range of ['today', 'week', 'month']) {
      const r = await call(api, 'GET', `/api/admin/overview?range=${range}`, { token: team() });
      assert.equal(r.status, 200, range);
      assert.equal(asJson(r.body)['range'], range);
      assert.deepEqual(list(asJson(r.body)['kpis']).map((k) => k['key']), ['sales', 'orders', 'stores', 'signups', 'payment']);
      for (const k of ['queue', 'providers', 'industries', 'activity']) assert.ok(Array.isArray(asJson(r.body)[k]), k);
    }
    assert.equal(asJson((await call(api, 'GET', '/api/admin/overview?range=nonsense', { token: team() })).body)['range'], 'today', 'an unknown range is today, not an error');
  });

  it('never invents a provider that does not exist: only the live online methods are listed', async () => {
    const keys = list(asJson((await call(api, 'GET', '/api/admin/overview', { token: team() })).body)['providers']).map((p) => p['key']);
    assert.ok(keys.includes('mtn_momo') && !keys.includes('cash'));
  });
});

describe('merchants', () => {
  it('lists by tab with counts, searches by name, and opens a store', async () => {
    const r = asJson((await call(api, 'GET', '/api/admin/merchants?tab=active&q=Escalation', { token: team() })).body);
    const names = list(r['rows']).map((x) => x['name']);
    assert.ok(names.includes('Escalation Store A') && names.includes('Escalation Store B'));
    const counts = asJson(r['counts']);
    assert.ok(Number(counts['active']) >= 2);
    const one = asJson((await call(api, 'GET', `/api/admin/merchants/${STORE.a}`, { token: team() })).body);
    assert.equal(one['name'], 'Escalation Store A');
    assert.ok(Array.isArray(one['checks']));
    assert.equal((await call(api, 'GET', '/api/admin/merchants/00000000-0000-4000-8000-000000000bad', { token: team() })).status, 404);
    assert.equal((await call(api, 'GET', '/api/admin/merchants/not-a-uuid', { token: team() })).status, 400);
  });

  it('a search with LIKE wildcards in it is a search, not a pattern', async () => {
    const r = asJson((await call(api, 'GET', '/api/admin/merchants?tab=active&q=%25', { token: team() })).body);
    assert.equal(list(r['rows']).length, 0);
  });
});

describe('suspending a store', () => {
  it('needs a reason from the list', async () => {
    assert.equal((await call(api, 'POST', `/api/admin/merchants/${STORE.b}/suspend`, { token: team(), body: {} })).status, 400);
    assert.equal((await call(api, 'POST', `/api/admin/merchants/${STORE.b}/suspend`, { token: team(), body: { reason: 'because' } })).status, 400);
  });

  it('takes the store off the storefront, holds its payouts, records why — and reinstating undoes it', async () => {
    const slug = (await sql<{ slug: string }>(`SELECT slug FROM stores WHERE id = $1`, [STORE.b])).rows[0]!.slug;
    assert.notEqual((await call(api, 'GET', `/api/storefront/${slug}`)).status, 403, 'live before');

    const r = await call(api, 'POST', `/api/admin/merchants/${STORE.b}/suspend`, { token: team(), body: { reason: 'goods', note: 'Reported counterfeit' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(asJson(r.body)['status'], 'suspended');
    assert.equal(asJson(asJson(r.body)['suspension'])['reason'], 'prohibited or counterfeit goods');
    assert.equal(await audits('suspend_store', STORE.b), 1, 'one entry, with the reason');

    const shop = await call(api, 'GET', `/api/storefront/${slug}`);
    assert.equal(shop.status, 403);
    assert.equal(shop.body['code'], 'STORE_SUSPENDED');

    await assert.rejects(
      () => sql(`SELECT request_withdrawal($1, 1000, '0781234567', 'suspension-hold-key-1234')`, [STORE.b]),
      /suspended/,
      'a suspended store cannot request a payout',
    );

    assert.equal((await call(api, 'POST', `/api/admin/merchants/${STORE.b}/suspend`, { token: team(), body: { reason: 'fraud' } })).status, 409, 'not twice');

    const back = await call(api, 'POST', `/api/admin/merchants/${STORE.b}/reinstate`, { token: team() });
    assert.equal(asJson(back.body)['status'], 'active');
    assert.notEqual((await call(api, 'GET', `/api/storefront/${slug}`)).status, 403, 'live again');
    assert.equal((await call(api, 'POST', `/api/admin/merchants/${STORE.b}/reinstate`, { token: team() })).status, 409, 'not twice');
    assert.equal(await audits('reinstate_store', STORE.b), 1);
  });
});

describe('reviewing an identity check', () => {
  let caseId: string;

  it('a sent case is in the queue, flagged until the number is entered', async () => {
    caseId = await sentCase(STORE.a, owner());
    const q = list(asJson((await call(api, 'GET', '/api/admin/kyc', { token: team() })).body)['queue']);
    const mine = q.find((x) => x['id'] === caseId);
    assert.ok(mine !== undefined);
    assert.equal(asJson(mine['flag'])['label'], 'ID number not entered');
    assert.equal(mine['store'], 'Escalation Store A');
  });

  it('the case lists its documents and what is and is not checked, saying who made each check', async () => {
    const c = asJson((await call(api, 'GET', `/api/admin/kyc/${caseId}`, { token: team() })).body);
    assert.deepEqual(list(c['documents']).map((d) => d['part']), ['face_video', 'id_back', 'id_front']);
    const checks = list(c['checks']);
    assert.equal(checks.length, 6);
    const by = Object.fromEntries(checks.map((k) => [k['code'], k['by']]));
    assert.equal(by['document_genuine'], 'reviewer');
    assert.equal(by['not_used_by_another_store'], 'computed');
    assert.equal(checks.find((k) => k['code'] === 'liveness')!['state'], 'open', 'nothing is ticked that nobody ticked');
    assert.equal(asJson(c['fields'])['hasIdNumber'], false);
  });

  it('opening a photo hands back exactly what was sent — and writes the entry', async () => {
    const before = await audits('view_kyc_document', STORE.a);
    const res = await fetch(`${api.baseUrl}/api/admin/kyc/${caseId}/documents/id_front`, { headers: { Authorization: `Bearer ${team()}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
    assert.equal(await audits('view_kyc_document', STORE.a), before + 1);
  });

  it('the merchant cannot read their own documents back, by either door', async () => {
    assert.equal((await fetch(`${api.baseUrl}/api/admin/kyc/${caseId}/documents/id_front`, { headers: { Authorization: `Bearer ${owner()}` } })).status, 403);
    assert.equal((await call(api, 'GET', `/api/stores/${STORE.a}/kyc/documents/id_front`, { token: owner() })).status, 404);
  });

  it('records what was read off the card: the number is sealed, the duplicate check wakes up', async () => {
    const r = await call(api, 'PUT', `/api/admin/kyc/${caseId}/details`, { token: team(), body: { fullName: 'Owner A', dateOfBirth: '1994-03-14', expiresOn: '2031-06-01', idNumber: '1 1994 7 0048213 0 18' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = asJson(r.body['fields']);
    assert.equal(f['hasIdNumber'], true);
    assert.match(String(f['idNumberMasked']), /•/);
    assert.ok(!JSON.stringify(r.body).includes('0048213'), 'the number is nowhere in the response');
    const checks = Object.fromEntries(list(r.body['checks']).map((k) => [k['code'], k['state']]));
    assert.equal(checks['name_matches_account'], 'pass');
    assert.equal(checks['not_used_by_another_store'], 'pass');
    const entry = (await sql<{ summary: string; detail: string | null }>(`SELECT summary, detail FROM audit_log WHERE action = 'record_identity_details' AND store_id = $1 ORDER BY sequence DESC LIMIT 1`, [STORE.a])).rows[0]!;
    assert.ok(!entry.summary.includes('0048213') && !(entry.detail ?? '').includes('0048213'), 'the log says details were entered, never what they were');
  });

  it('the reviewer records their own calls, and only theirs', async () => {
    const ok = await call(api, 'PUT', `/api/admin/kyc/${caseId}/checks/liveness`, { token: team(), body: { outcome: 'pass', note: 'Turned head and blinked' } });
    assert.equal(ok.status, 200);
    assert.equal(list(ok.body['checks']).find((k) => k['code'] === 'liveness')!['state'], 'pass');
    assert.equal((await call(api, 'PUT', `/api/admin/kyc/${caseId}/checks/not_used_by_another_store`, { token: team(), body: { outcome: 'pass' } })).status, 400, 'a computed check is not theirs to tick');
    assert.equal((await call(api, 'PUT', `/api/admin/kyc/${caseId}/checks/liveness`, { token: team(), body: { outcome: 'great' } })).status, 400);
  });

  it('the same ID on another store is caught on both', async () => {
    const other = await sentCase(STORE.b, adminB());
    await call(api, 'PUT', `/api/admin/kyc/${other}/details`, { token: team(), body: { fullName: 'Admin B', idNumber: '119947004821 8018' } });
    // Different spacing, one stray character: not the same number. Now the same one, written differently.
    const same = await call(api, 'PUT', `/api/admin/kyc/${other}/details`, { token: team(), body: { fullName: 'Admin B', idNumber: '1-1994-7-0048213-0-18' } });
    const dup = list(same.body['checks']).find((k) => k['code'] === 'not_used_by_another_store')!;
    assert.equal(dup['state'], 'fail');
    assert.match(String(dup['note']), /Escalation Store A/);
    const first = list(asJson((await call(api, 'GET', `/api/admin/kyc/${caseId}`, { token: team() })).body)['checks']).find((k) => k['code'] === 'not_used_by_another_store')!;
    assert.equal(first['state'], 'fail', 'and the first case now says so too');
    const flag = list(asJson((await call(api, 'GET', '/api/admin/kyc', { token: team() })).body)['queue']).find((x) => x['id'] === caseId)!;
    assert.equal(asJson(flag['flag'])['label'], 'ID used by another store');
    // Leave store B's case undecided but out of the way for the rest of the suite.
    await sql(`SELECT decide_kyc($1, $2, 'reject', 'test cleanup')`, [other, USER.superAdmin]);
  });

  it('the full number needs a reason, comes back once, and is on the record', async () => {
    assert.equal((await call(api, 'POST', `/api/admin/kyc/${caseId}/reveal`, { token: team(), body: {} })).status, 400);
    const before = await audits('reveal_id_number', STORE.a);
    const r = await call(api, 'POST', `/api/admin/kyc/${caseId}/reveal`, { token: team(), body: { reason: 'Matching RDB record' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['idNumber'], '1199470048213018');
    assert.equal(await audits('reveal_id_number', STORE.a), before + 1);
    assert.equal((await call(api, 'GET', `/api/admin/kyc/${caseId}`, { token: team() })).body['idNumber'], undefined, 'reading the case never carries it');
  });

  it('a refusal needs the sentence the merchant will read; a retake needs one part', async () => {
    assert.equal((await call(api, 'POST', `/api/admin/kyc/${caseId}/decision`, { token: team(), body: { outcome: 'reject' } })).status, 400);
    assert.equal((await call(api, 'POST', `/api/admin/kyc/${caseId}/decision`, { token: team(), body: { outcome: 'redo', note: 'Blurry' } })).status, 400);
    assert.equal((await call(api, 'POST', `/api/admin/kyc/${caseId}/decision`, { token: team(), body: { outcome: 'redo', note: 'Blurry', part: 'selfie' } })).status, 400);
  });

  it('a retake reaches the merchant: their status, their sentence, and a notification', async () => {
    const r = await call(api, 'POST', `/api/admin/kyc/${caseId}/decision`, { token: team(), body: { outcome: 'redo', note: 'The back of your ID is blurry.', part: 'back' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mine = asJson((await call(api, 'GET', `/api/stores/${STORE.a}/kyc`, { token: owner() })).body);
    assert.equal(mine['outcome'], 'redoRequested');
    assert.equal(asJson(mine['submission'])['decisionNote'], 'The back of your ID is blurry.');
    const n = (await sql<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE store_id = $1 AND type_code = 'identity_retake'`, [STORE.a])).rows[0]!.n;
    assert.equal(Number(n), 1);
    // Back through the merchant's door, and back in the queue.
    assert.equal(await upload(STORE.a, owner(), 'id_back', JPEG, 'image/jpeg'), 201);
    assert.equal((await call(api, 'POST', `/api/stores/${STORE.a}/kyc/submit`, { token: owner() })).status, 200);
  });

  it('approving is one-shot, unlocks payouts, tells the merchant — and the video is then deleted', async () => {
    const approved = await call(api, 'POST', `/api/admin/kyc/${caseId}/decision`, { token: team(), body: { outcome: 'approve' } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body['status'], 'approved');
    assert.equal((await call(api, 'POST', `/api/admin/kyc/${caseId}/decision`, { token: team(), body: { outcome: 'reject', note: 'too late' } })).status, 409);
    assert.equal(asJson((await call(api, 'GET', `/api/stores/${STORE.a}/kyc`, { token: owner() })).body)['verified'], true);
    assert.equal(Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE store_id = $1 AND type_code = 'identity_verified'`, [STORE.a])).rows[0]!.n) >= 1, true);

    assert.ok((await kyc.purgeDue()) >= 1);
    const gone = await fetch(`${api.baseUrl}/api/admin/kyc/${caseId}/documents/face_video`, { headers: { Authorization: `Bearer ${team()}` } });
    assert.equal(gone.status, 410, 'deleted footage is a 410 with a reason, not a 404');
    const photo = await fetch(`${api.baseUrl}/api/admin/kyc/${caseId}/documents/id_front`, { headers: { Authorization: `Bearer ${team()}` } });
    assert.equal(photo.status, 200, 'ID photos are kept');
  });

  it('a decided case can no longer be edited', async () => {
    assert.equal((await call(api, 'PUT', `/api/admin/kyc/${caseId}/details`, { token: team(), body: { fullName: 'Someone Else' } })).status, 409);
    assert.equal((await call(api, 'PUT', `/api/admin/kyc/${caseId}/checks/liveness`, { token: team(), body: { outcome: 'fail' } })).status, 409);
  });
});
