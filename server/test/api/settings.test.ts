// server/test/api/settings.test.ts — milestone 25: what Settings writes.
//
//   1. EVERY WRITE IS settings.write: a manager can answer a customer and cannot change where the money goes, how
//      delivery is priced or who the staff are.
//   2. THE PAYOUT DESTINATION NEEDS THE PASSWORD, every time. It is the one setting that redirects the store's money, so a
//      stolen session cookie must not be enough — a wrong password is a 403 that changes nothing, and a change is audited.
//   3. NOTHING A MERCHANT CAN SAVE LEAVES THE STORE WITHOUT A WAY TO GET PAID or with an area in two zones.
//   4. A STRANGER'S ZONE IS A 404, and a zone of another store cannot be reached through this store's URL.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { FIXTURE_PASSWORD, STORE, USER, cleanup, seedAuthPasswords, seedFixtures, seedStorefront } from './support.ts';

let api: Api;
const owner = (): string => tokenFor(USER.ownerA);
const manager = (): string => tokenFor(USER.managerA);
const otherAdmin = (): string => tokenFor(USER.adminB);
const base = `/api/stores/${STORE.a}/settings`;
const STRANGER = '00000000-0000-4000-8000-000000000bad';

type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => v as Json;
const list = (v: unknown): Json[] => v as Json[];

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  await seedAuthPasswords();
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
});

describe('who may change settings', () => {
  it('a manager cannot read the extra panels or write any of them', async () => {
    assert.equal((await call(api, 'GET', `${base}/extra`, { token: manager() })).status, 403);
    const attempts: [string, string, unknown][] = [
      ['PUT', '/details', { name: 'x', timeZone: 'Africa/Kigali' }],
      ['PUT', '/hours', { days: [] }],
      ['POST', '/zones', { name: 'x', fee: '1', etaMin: 1, etaMax: 2 }],
      ['PUT', '/pickup', { enabled: false }],
      ['PUT', '/payments/cash', { connected: true }],
      ['PUT', '/payout', { methodKey: 'mtn_momo', phone: '0781234567', password: FIXTURE_PASSWORD }],
    ];
    for (const [method, path, body] of attempts) {
      assert.equal((await call(api, method, `${base}${path}`, { token: manager(), body })).status, 403, `${method} ${path}`);
    }
    assert.equal((await call(api, 'GET', `${base}/extra`, { token: otherAdmin() })).status, 403, 'another store\'s admin');
  });
});

describe('Store details', () => {
  it('reads and updates the name, phone, address and time zone', async () => {
    const before = asJson((await call(api, 'GET', `${base}/extra`, { token: owner() })).body['store']);
    assert.equal(before['timeZone'], 'Africa/Kigali');

    const res = await call(api, 'PUT', `${base}/details`, { token: owner(), body: { name: 'Store A Renamed', publicPhone: '078 111 2222', address: 'KG 9 Ave, Kigali', timeZone: 'Africa/Nairobi' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = asJson((await call(api, 'GET', `${base}/extra`, { token: owner() })).body['store']);
    assert.deepEqual([after['name'], after['publicPhone'], after['address'], after['timeZone']], ['Store A Renamed', '078 111 2222', 'KG 9 Ave, Kigali', 'Africa/Nairobi']);
    // The slug is the store's address on the internet: nothing here changes it.
    assert.equal(after['slug'], before['slug']);

    await call(api, 'PUT', `${base}/details`, { token: owner(), body: { name: 'Escalation Store A', timeZone: 'Africa/Kigali' } });
  });

  it('refuses a name that is too short, a phone that is not one, and a time zone that does not exist', async () => {
    assert.equal((await call(api, 'PUT', `${base}/details`, { token: owner(), body: { name: 'x', timeZone: 'Africa/Kigali' } })).status, 400);
    assert.equal((await call(api, 'PUT', `${base}/details`, { token: owner(), body: { name: 'Fine', publicPhone: '123', timeZone: 'Africa/Kigali' } })).status, 400);
    const tz = await call(api, 'PUT', `${base}/details`, { token: owner(), body: { name: 'Fine', timeZone: 'Mars/Olympus' } });
    assert.equal(tz.status, 400);
    assert.equal(tz.body['code'], 'INVALID_TIME_ZONE');
  });
});

describe('Opening hours', () => {
  const day = (d: number, opens: string, closes: string): Json => ({ day: d, opens, closes });

  it('replaces the whole week, and an absent day is a closed one', async () => {
    const res = await call(api, 'PUT', `${base}/hours`, { token: owner(), body: { days: [day(1, '09:00', '18:00'), day(2, '09:00', '18:00'), day(6, '18:00', '01:00')] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(list(res.body['hours']).map((h) => h['day']), [1, 2, 6]);
    assert.deepEqual(list(res.body['hours'])[2], { day: 6, opens: '18:00', closes: '01:00' }, 'an overnight day is allowed: a grill open past midnight');

    const second = await call(api, 'PUT', `${base}/hours`, { token: owner(), body: { days: [day(3, '10:00', '20:00')] } });
    assert.deepEqual(list(second.body['hours']).map((h) => h['day']), [3], 'the previous week is gone, not merged');
    await call(api, 'PUT', `${base}/hours`, { token: owner(), body: { days: [] } });
    assert.equal(list(asJson((await call(api, 'GET', `${base}/extra`, { token: owner() })).body)['hours']).length, 0, 'no hours at all is valid: the store is always closed');
  });

  it('refuses the mistakes a merchant makes', async () => {
    const put = (days: Json[]) => call(api, 'PUT', `${base}/hours`, { token: owner(), body: { days } });
    assert.equal((await put([day(1, '09:00', '09:00')])).status, 400, 'open for no time');
    assert.equal((await put([day(1, '9:00', '18:00')])).status, 400, 'a time that is not HH:MM');
    assert.equal((await put([day(0, '09:00', '18:00')])).status, 400);
    assert.equal((await put([day(8, '09:00', '18:00')])).status, 400);
    assert.equal((await put([day(1, '09:00', '18:00'), day(1, '10:00', '19:00')])).status, 400, 'a day twice');
    const n = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM store_hours WHERE store_id = $1`, [STORE.a]);
    assert.equal(n.rows[0]!.n, '0', 'a refused week changed nothing');
  });
});

describe('Delivery zones', () => {
  let central = '';
  const zone = (over: Json = {}): Json => ({ name: 'Kigali city centre', fee: '1000', etaMin: 25, etaMax: 35, areas: ['Kacyiru', 'Kimihurura', 'Kiyovu'], ...over });

  it('creates a zone with its areas, and lists it in the board\'s order', async () => {
    const res = await call(api, 'POST', `${base}/zones`, { token: owner(), body: zone() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const created = list(res.body['zones']).find((z) => z['name'] === 'Kigali city centre')!;
    central = String(created['id']);
    assert.equal(created['feeAmount'], '1000.00');
    assert.deepEqual([created['etaMinMinutes'], created['etaMaxMinutes']], [25, 35]);
    assert.deepEqual(created['areas'], ['Kacyiru', 'Kimihurura', 'Kiyovu']);
  });

  it('refuses a second zone with the same name, and an area that is already in another zone — naming it', async () => {
    const dup = await call(api, 'POST', `${base}/zones`, { token: owner(), body: zone({ name: ' KIGALI CITY CENTRE ', areas: [] }) });
    assert.equal(dup.status, 409);
    assert.equal(dup.body['code'], 'NAME_TAKEN');

    const clash = await call(api, 'POST', `${base}/zones`, { token: owner(), body: zone({ name: 'Greater Kigali', fee: '2000', etaMin: 40, etaMax: 60, areas: ['Remera', 'kacyiru'] }) });
    assert.equal(clash.status, 409);
    assert.equal(clash.body['code'], 'AREA_TAKEN');
    assert.match(String(clash.body['error']), /Kacyiru is already delivered under “Kigali city centre”/);
    const n = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM delivery_zones WHERE store_id = $1 AND lower(name) = 'greater kigali'`, [STORE.a]);
    assert.equal(n.rows[0]!.n, '0', 'the refused zone was not half-created');
  });

  it('moves an area from one zone to another by editing both', async () => {
    const greater = await call(api, 'POST', `${base}/zones`, { token: owner(), body: zone({ name: 'Greater Kigali', fee: '2000', etaMin: 40, etaMax: 60, areas: ['Remera', 'Kicukiro'] }) });
    assert.equal(greater.status, 201);
    const id = String(list(greater.body['zones']).find((z) => z['name'] === 'Greater Kigali')!['id']);

    const trimmed = await call(api, 'PUT', `${base}/zones/${central}`, { token: owner(), body: zone({ areas: ['Kacyiru', 'Kiyovu'] }) });
    assert.equal(trimmed.status, 200);
    const moved = await call(api, 'PUT', `${base}/zones/${id}`, { token: owner(), body: zone({ name: 'Greater Kigali', fee: '2000', etaMin: 40, etaMax: 60, areas: ['Remera', 'Kicukiro', 'Kimihurura'] }) });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.ok(list(moved.body['zones']).find((z) => z['name'] === 'Greater Kigali')!['areas'] instanceof Array);
  });

  it('refuses a fee that is not money and a time that runs backwards', async () => {
    assert.equal((await call(api, 'POST', `${base}/zones`, { token: owner(), body: zone({ name: 'A', fee: 'free', areas: [] }) })).status, 400);
    assert.equal((await call(api, 'POST', `${base}/zones`, { token: owner(), body: zone({ name: 'A', etaMin: 60, etaMax: 30, areas: [] }) })).status, 400);
    assert.equal((await call(api, 'POST', `${base}/zones`, { token: owner(), body: zone({ name: '  ', areas: [] }) })).status, 400);
  });

  it('answers 404 for a zone that is not this store\'s, and deletes one that is', async () => {
    assert.equal((await call(api, 'PUT', `${base}/zones/${STRANGER}`, { token: owner(), body: zone({ areas: [] }) })).status, 404);
    assert.equal((await call(api, 'DELETE', `${base}/zones/${STRANGER}`, { token: owner() })).status, 404);
    assert.equal((await call(api, 'DELETE', `${base}/zones/not-a-uuid`, { token: owner() })).status, 400);

    const res = await call(api, 'DELETE', `${base}/zones/${central}`, { token: owner() });
    assert.equal(res.status, 200);
    assert.ok(!list(res.body['zones']).some((z) => z['id'] === central));
    const areas = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM delivery_zone_areas WHERE zone_id = $1`, [central]);
    assert.equal(areas.rows[0]!.n, '0', 'its areas went with it');
  });
});

describe('Pickup', () => {
  it('is on when there is a row, and off when there is not', async () => {
    const on = await call(api, 'PUT', `${base}/pickup`, { token: owner(), body: { enabled: true, address: 'KG 7 Ave, Kacyiru', readyMinutes: 15 } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const row = await sql<{ address: string; ready_minutes: number }>(`SELECT address, ready_minutes FROM store_pickup_settings WHERE store_id = $1`, [STORE.a]);
    assert.deepEqual(row.rows[0], { address: 'KG 7 Ave, Kacyiru', ready_minutes: 15 });

    assert.equal((await call(api, 'PUT', `${base}/pickup`, { token: owner(), body: { enabled: true, address: '  ', readyMinutes: 15 } })).status, 400);
    assert.equal((await call(api, 'PUT', `${base}/pickup`, { token: owner(), body: { enabled: true, address: 'x', readyMinutes: 0 } })).status, 400);
    assert.equal((await call(api, 'PUT', `${base}/pickup`, { token: owner(), body: { address: 'x' } })).status, 400, 'enabled is required');

    await call(api, 'PUT', `${base}/pickup`, { token: owner(), body: { enabled: false } });
    const gone = await sql(`SELECT 1 FROM store_pickup_settings WHERE store_id = $1`, [STORE.a]);
    assert.equal(gone.rows.length, 0);
  });
});

describe('Payments', () => {
  it('connects one the platform has made live, and refuses one it has not', async () => {
    assert.equal((await call(api, 'PUT', `${base}/payments/airtel_money`, { token: owner(), body: { connected: true } })).status, 200);
    const connected = await sql<{ is_connected: boolean }>(`SELECT is_connected FROM store_payment_methods WHERE store_id = $1 AND payment_method_key = 'airtel_money'`, [STORE.a]);
    assert.equal(connected.rows[0]!.is_connected, true);

    const draft = await call(api, 'PUT', `${base}/payments/mpesa`, { token: owner(), body: { connected: true } });
    assert.equal(draft.status, 409);
    assert.equal(draft.body['code'], 'METHOD_UNAVAILABLE');
    assert.equal((await call(api, 'PUT', `${base}/payments/nonsense`, { token: owner(), body: { connected: true } })).status, 404);
    assert.equal((await call(api, 'PUT', `${base}/payments/cash`, { token: owner(), body: { connected: 'yes' } })).status, 400);
  });

  it('will not switch off the last way to get paid', async () => {
    assert.equal((await call(api, 'PUT', `${base}/payments/airtel_money`, { token: owner(), body: { connected: false } })).status, 200);
    assert.equal((await call(api, 'PUT', `${base}/payments/cash`, { token: owner(), body: { connected: false } })).status, 200);
    const last = await call(api, 'PUT', `${base}/payments/mtn_momo`, { token: owner(), body: { connected: false } });
    assert.equal(last.status, 409);
    assert.equal(last.body['code'], 'LAST_METHOD');
    const still = await sql<{ is_connected: boolean }>(`SELECT is_connected FROM store_payment_methods WHERE store_id = $1 AND payment_method_key = 'mtn_momo'`, [STORE.a]);
    assert.equal(still.rows[0]!.is_connected, true);
    await call(api, 'PUT', `${base}/payments/cash`, { token: owner(), body: { connected: true } });
  });
});

describe('Where payouts go', () => {
  const put = (body: Json, token = owner()) => call(api, 'PUT', `${base}/payout`, { token, body });
  const phoneNow = async (): Promise<string> => (await sql<{ p: string }>(`SELECT payout_phone AS p FROM store_payout_settings WHERE store_id = $1`, [STORE.a])).rows[0]!.p;

  it('needs the password — a wrong one is a 403 that changes nothing', async () => {
    const before = await phoneNow();
    const wrong = await put({ methodKey: 'mtn_momo', phone: '0789990000', password: 'not-the-password' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body['code'], 'WRONG_PASSWORD');
    assert.equal(await phoneNow(), before);

    const missing = await put({ methodKey: 'mtn_momo', phone: '0789990000' });
    assert.equal(missing.status, 400);
    assert.equal(await phoneNow(), before);
  });

  it('changes the destination with the right one, and the change is in the audit log with the numbers masked', async () => {
    const res = await put({ methodKey: 'airtel_money', phone: '073 111 9988', password: FIXTURE_PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(asJson(res.body['payout'])['payout_method_key'], 'airtel_money');
    assert.equal(await phoneNow(), '073 111 9988');

    const log = await sql<{ summary: string; detail: string; actor_id: string }>(
      `SELECT summary, detail, actor_id FROM audit_log WHERE store_id = $1 AND action = 'payout_destination_changed' ORDER BY sequence DESC LIMIT 1`,
      [STORE.a],
    );
    assert.match(log.rows[0]!.summary, /airtel_money ••• 9988/);
    assert.match(log.rows[0]!.detail, /It was ••• 4412/, 'the old number, masked, so the owner can recognise what was replaced');
    assert.ok(!JSON.stringify(log.rows[0]).includes('111 9988'), 'and neither number is ever whole in the log');
    assert.equal(log.rows[0]!.actor_id, USER.ownerA);
  });

  it('keeps automatic payouts as they were — changing the number is not changing the schedule', async () => {
    await sql(`UPDATE store_payout_settings SET settlement_mode = 'automatic', automatic_at = '08:00' WHERE store_id = $1`, [STORE.a]);
    await put({ methodKey: 'mtn_momo', phone: '078 111 4412', password: FIXTURE_PASSWORD });
    const row = await sql<{ settlement_mode: string; automatic_at: string }>(`SELECT settlement_mode, automatic_at::text FROM store_payout_settings WHERE store_id = $1`, [STORE.a]);
    assert.deepEqual(row.rows[0], { settlement_mode: 'automatic', automatic_at: '08:00:00' });
  });

  it('refuses a method money cannot go to, and a number that is not one', async () => {
    assert.equal((await put({ methodKey: 'cash', phone: '0781234567', password: FIXTURE_PASSWORD })).status, 400, 'cash is not a payout account');
    assert.equal((await put({ methodKey: 'mpesa', phone: '0781234567', password: FIXTURE_PASSWORD })).status, 400, 'a draft method');
    assert.equal((await put({ methodKey: 'mtn_momo', phone: '12', password: FIXTURE_PASSWORD })).status, 400);
    assert.equal((await put({ methodKey: 'mtn_momo', phone: '0781234567', password: FIXTURE_PASSWORD }, manager())).status, 403);
  });
});
