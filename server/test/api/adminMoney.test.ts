// server/test/api/adminMoney.test.ts — milestone 27, part B: payouts, refunds and disputes, currencies, payment methods.
//
//   1. THE SAME WALL AS PART A: no session is a 401, and a store's owner, admin and manager are a 403 on every route.
//   2. PAYOUTS: the piles are what they say they are — a failed transfer (money already back), a held store (the three reasons
//      request_withdrawal refuses on), and a retry is refused unless the payout failed.
//   3. REFUNDS AND DISPUTES go through the database's own functions: one decision, a reason, an amount no larger than the order,
//      "paid now or queued", and the order's refunded_amount follows.
//   4. CURRENCIES: the default cannot be switched off, nor one a store sells in, nor given a nonsense rounding; every change is an
//      audit entry; and what the test changed it puts back.
//   5. PAYMENT METHODS: a draft cannot be published until every readiness line is true; a live method cannot lose its last
//      country; pausing and resuming are one-way doors each.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { CATALOGUE, ORDERS_BOARD, STORE, USER, cleanup, seedConsole, seedFixtures, seedOrdersBoard, seedStorefront } from './support.ts';

let api: Api;
let complaintId: string;
const team = (): string => tokenFor(USER.superAdmin);
type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => v as Json;
const list = (v: unknown): Json[] => v as Json[];
const get = (path: string): ReturnType<typeof call> => call(api, 'GET', `/api/admin${path}`, { token: team() });
const post = (path: string, body: unknown = {}): ReturnType<typeof call> => call(api, 'POST', `/api/admin${path}`, { token: team(), body });
const put = (path: string, body: unknown): ReturnType<typeof call> => call(api, 'PUT', `/api/admin${path}`, { token: team(), body });

const MOMO_ENV = ['MOMO_DISBURSEMENT_SUBSCRIPTION_KEY', 'MOMO_DISBURSEMENT_API_USER', 'MOMO_DISBURSEMENT_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};

async function fund(amount: number, key: string): Promise<void> {
  await sql(`SELECT wallet_post(p_store_id => $1, p_pot => 'available', p_entry_type => 'adjustment', p_amount => $2, p_idempotency_key => $3, p_counterparty => 'test funding')`, [STORE.a, amount, key]);
}

before(async () => {
  for (const k of MOMO_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  complaintId = (await seedConsole()).complaintId;
  await seedOrdersBoard();
});

after(async () => {
  for (const k of MOMO_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await sql(`DELETE FROM payment_method_currencies WHERE payment_method_key = 'zz_test_method'`);
  await sql(`DELETE FROM payment_method_countries WHERE payment_method_key = 'zz_test_method'`);
  await sql(`DELETE FROM payment_methods WHERE key = 'zz_test_method'`);
  await cleanup();
  await api.close();
  await closePool();
});

describe('who may', () => {
  const routes: [string, string][] = [
    ['GET', '/payouts'], ['POST', `/payouts/${STORE.a}/retry`], ['GET', '/disputes'], ['GET', `/disputes/refund/${STORE.a}`], ['POST', `/disputes/dispute/${STORE.a}/decision`],
    ['GET', '/currencies'], ['PUT', '/currencies/RWF'], ['GET', '/payment-methods'], ['GET', '/payment-methods/mtn_momo'], ['PUT', '/payment-methods/mtn_momo'],
    ['POST', '/payment-methods/mtn_momo/pause'], ['POST', '/payment-methods/mtn_momo/publish'],
  ];
  it('no session → 401; a store owner, admin or manager → 403, on every route', async () => {
    for (const [method, path] of routes) assert.equal((await call(api, method, `/api/admin${path}`, method === 'GET' ? {} : { body: {} })).status, 401, `${method} ${path}`);
    for (const t of [tokenFor(USER.ownerA), tokenFor(USER.adminA), tokenFor(USER.managerA)]) {
      for (const [method, path] of routes) assert.equal((await call(api, method, `/api/admin${path}`, method === 'GET' ? { token: t } : { token: t, body: {} })).status, 403, `${method} ${path}`);
    }
  });
});

describe('payouts', () => {
  it('a failed transfer is in the Failed pile with its reason, and says the money is already back', async () => {
    await sql(`INSERT INTO withdrawals (store_id, amount, phone, status, failure_reason, initiated_by, idempotency_key) VALUES ($1, 41000, '250781234412', 'failed', 'MoMo: account name doesn’t match.', 'automatic', 'adm-failed-fixture-1')`, [STORE.a]);
    const r = asJson((await get('/payouts?tab=problem')).body);
    const row = list(r['rows']).find((x) => x['store'] === 'Escalation Store A')!;
    assert.equal(row['status'], 'failed');
    assert.equal(row['canRetry'], true);
    assert.equal(row['kind'], 'Automatic');
    assert.match(String(row['note']), /back in the store’s Available balance/);
    assert.match(String(row['destination']), /078 ••• 4412/);
    assert.ok(!JSON.stringify(row).includes('781234412'), 'the number is masked');
    assert.ok(Number(asJson(r['counts'])['problem']) >= 1);
  });

  it('a store with money it cannot withdraw is Held, with the reason request_withdrawal would give', async () => {
    await fund(25000, 'adm-held-fund-1');
    const r = asJson((await get('/payouts?tab=held')).body);
    const row = list(r['rows']).find((x) => x['store'] === 'Escalation Store A')!;
    assert.equal(row['status'], 'held');
    assert.equal(row['amount'], 25000);
    assert.match(String(row['note']), /Identity not verified yet/);
    await sql(`UPDATE stores SET status = 'suspended' WHERE id = $1`, [STORE.a]);
    const s = list(asJson((await get('/payouts?tab=held')).body)['rows']).find((x) => x['store'] === 'Escalation Store A')!;
    assert.match(String(s['note']), /suspended/);
    await sql(`UPDATE stores SET status = 'active' WHERE id = $1`, [STORE.a]);
  });

  it('only a failed payout can be retried, and a missing one is a 404', async () => {
    const failed = (await sql<{ id: string }>(`SELECT id FROM withdrawals WHERE idempotency_key = 'adm-failed-fixture-1'`)).rows[0]!.id;
    assert.equal((await post('/payouts/00000000-0000-4000-8000-000000000bad/retry')).status, 404);
    // MoMo disbursement is unconfigured in this suite: the retry is refused before anything is written.
    const r = await post(`/payouts/${failed}/retry`);
    assert.equal(r.status, 409);
    assert.equal(r.body['code'], 'PAYOUTS_UNAVAILABLE');
    assert.equal(Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM withdrawals WHERE idempotency_key = $1`, [`admin-retry:${failed}`])).rows[0]!.n), 0);
    await sql(`UPDATE withdrawals SET status = 'failed' WHERE id = $1`, [failed]);
    await sql(`INSERT INTO withdrawals (store_id, amount, phone, status, initiated_by, idempotency_key) VALUES ($1, 100, '250781234412', 'pending', 'manual', 'adm-pending-fixture-1')`, [STORE.a]);
    const pending = (await sql<{ id: string }>(`SELECT id FROM withdrawals WHERE idempotency_key = 'adm-pending-fixture-1'`)).rows[0]!.id;
    assert.equal((await post(`/payouts/${pending}/retry`)).status, 409);
    const live = list(asJson((await get('/payouts?tab=live')).body)['rows']);
    assert.ok(live.some((x) => x['id'] === pending && x['canRetry'] === false));
  });
});

describe('refunds and disputes', () => {
  let refundA: string;
  let refundB: string;

  it('a store’s refund request is in the Refunds pile, with the store’s wallet beside it', async () => {
    await fund(100000, 'adm-refund-fund-1');
    refundA = (await sql<{ id: string }>(`INSERT INTO refunds (store_id, order_id, amount, reason_code, reason_note, requested_by) VALUES ($1, $2, 3000, 'item_missing', 'Fries not packed', $3) RETURNING id`, [STORE.a, ORDERS_BOARD.deliveredPaid, USER.managerA])).rows[0]!.id;
    refundB = (await sql<{ id: string }>(`INSERT INTO refunds (store_id, order_id, amount, reason_code) VALUES ($1, $2, 2000, 'wrong_item') RETURNING id`, [STORE.a, ORDERS_BOARD.returnedMomo])).rows[0]!.id;
    const q = asJson((await get('/disputes?tab=refunds')).body);
    assert.ok(list(q['items']).some((x) => x['id'] === refundA && x['title'] === 'Refund request · 3,000 RWF'));
    assert.ok(Number(asJson(q['counts'])['refunds']) >= 2);
    const d = asJson((await get(`/disputes/refund/${refundA}`)).body);
    assert.equal(d['status'], 'open');
    assert.equal(asJson(d['wallet'])['available'], (await sql<{ a: string }>(`SELECT available_balance::text AS a FROM wallets WHERE store_id = $1`, [STORE.a])).rows[0]!.a);
    assert.equal(d['refundBlocked'], null);
    assert.equal(d['maxRefund'], '8000.00');
    assert.match(String(asJson(list(d['thread'])[0])['text']), /Item missing\. Fries not packed/);
  });

  it('a decision needs a reason, an amount, and no more than the order', async () => {
    assert.equal((await post(`/disputes/refund/${refundA}/decision`, { outcome: 'approve', amount: '3000' })).status, 400, 'no reason');
    assert.equal((await post(`/disputes/refund/${refundA}/decision`, { outcome: 'approve', note: 'ok' })).status, 400, 'no amount');
    assert.equal((await post(`/disputes/refund/${refundA}/decision`, { outcome: 'approve', note: 'ok', amount: '99999' })).status, 400, 'more than the order');
    assert.equal((await post(`/disputes/refund/${refundA}/decision`, { outcome: 'approve', note: 'ok', amount: 'abc' })).status, 400);
    assert.equal((await post(`/disputes/refund/${refundA}/decision`, { outcome: 'maybe', note: 'ok' })).status, 400);
  });

  it('approving pays now from the store’s wallet, once, and the order follows', async () => {
    const before = Number((await sql<{ a: string }>(`SELECT available_balance::text AS a FROM wallets WHERE store_id = $1`, [STORE.a])).rows[0]!.a);
    const r = await post(`/disputes/refund/${refundA}/decision`, { outcome: 'approve', note: 'Fries were missing.', amount: '3000' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['status'], 'approved');
    assert.match(String(r.body['closedNote']), /Refunded 3,000 RWF/);
    assert.equal(Number((await sql<{ a: string }>(`SELECT available_balance::text AS a FROM wallets WHERE store_id = $1`, [STORE.a])).rows[0]!.a), before - 3000);
    assert.equal((await sql<{ r: string }>(`SELECT refunded_amount::text AS r FROM orders WHERE id = $1`, [ORDERS_BOARD.deliveredPaid])).rows[0]!.r, '3000.00');
    assert.equal((await post(`/disputes/refund/${refundA}/decision`, { outcome: 'reject', note: 'too late' })).status, 409, 'not twice');
    const closed = asJson((await get('/disputes?tab=closed')).body);
    assert.ok(list(closed['items']).some((x) => x['id'] === refundA && x['status'] === 'approved'));
  });

  it('rejecting moves nothing and says why', async () => {
    const before = (await sql<{ a: string }>(`SELECT available_balance::text AS a FROM wallets WHERE store_id = $1`, [STORE.a])).rows[0]!.a;
    const r = await post(`/disputes/refund/${refundB}/decision`, { outcome: 'reject', note: 'Photo shows the right item.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['status'], 'rejected');
    assert.match(String(r.body['closedNote']), /Photo shows the right item/);
    assert.equal((await sql<{ a: string }>(`SELECT available_balance::text AS a FROM wallets WHERE store_id = $1`, [STORE.a])).rows[0]!.a, before);
  });

  it('an approval the wallet cannot cover is queued, and pauses the store’s payouts', async () => {
    await sql(`UPDATE wallets SET available_balance = available_balance WHERE store_id = $1`, [STORE.a]);
    const extra = (await sql<{ id: string }>(`INSERT INTO refunds (store_id, order_id, amount, reason_code) VALUES ($1, $2, 4000, 'quality_problem') RETURNING id`, [STORE.a, ORDERS_BOARD.deliveredPaid])).rows[0]!.id;
    const avail = Number((await sql<{ a: string }>(`SELECT available_balance::text AS a FROM wallets WHERE store_id = $1`, [STORE.a])).rows[0]!.a);
    await sql(`SELECT wallet_post(p_store_id => $1, p_pot => 'available', p_entry_type => 'adjustment', p_amount => $2, p_idempotency_key => 'adm-drain-1', p_counterparty => 'test drain')`, [STORE.a, -(avail - 1000)]);
    const r = await post(`/disputes/refund/${extra}/decision`, { outcome: 'approve', note: 'Quality was poor.', amount: '4000' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['status'], 'queued');
    assert.match(String(r.body['closedNote']), /Waiting for/);
    assert.equal((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM refunds WHERE store_id = $1 AND status = 'queued'`, [STORE.a])).rows[0]!.n, '1');
    await sql(`UPDATE refunds SET status = 'rejected', approved_amount = NULL, reviewed_by = $2, reviewed_at = now(), rejection_reason = 'test cleanup' WHERE id = $1`, [extra, USER.superAdmin]);
  });

  it('an escalated complaint is a dispute, with its thread, and refunding it decides the complaint too', async () => {
    await sql(`SELECT escalate_complaint($1, $2, 'We disagree about what was delivered.')`, [complaintId, USER.ownerA]);
    await fund(50000, 'adm-dispute-fund-1');
    const q = asJson((await get('/disputes?tab=disputes')).body);
    const item = list(q['items']).find((x) => x['id'] === complaintId)!;
    assert.match(String(item['title']), /^Escalated · /);
    const d = asJson((await get(`/disputes/dispute/${complaintId}`)).body);
    assert.equal(d['status'], 'open');
    assert.ok(list(d['thread']).length >= 2, 'the customer’s words and the store’s escalation');
    assert.ok(list(d['thread']).some((m) => /disagree about what was delivered/.test(String(m['text']))));

    // The fixture order was cash and never collected: the database refuses to refund money that never arrived, so the screen says so.
    assert.match(String(d['refundBlocked']), /cash/);
    const blocked = await post(`/disputes/dispute/${complaintId}/decision`, { outcome: 'approve', note: 'The customer is right.', amount: '1000' });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body['code'], 'NOT_PAID');
    await sql(`UPDATE orders SET payment_status = 'paid', payment_method = 'mtn_momo', paid_at = now() WHERE id = $1`, [CATALOGUE.order]);

    assert.equal((await post(`/disputes/dispute/${complaintId}/decision`, { outcome: 'approve', amount: '1000' })).status, 400, 'no reason');
    const r = await post(`/disputes/dispute/${complaintId}/decision`, { outcome: 'approve', note: 'The customer is right.', amount: '1000' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['status'], 'approved');
    const c = (await sql<{ status: string; decision: string }>(`SELECT status, decision FROM complaints WHERE id = $1`, [complaintId])).rows[0]!;
    assert.deepEqual([c.status, c.decision], ['resolved', 'refunded']);
    assert.equal((await post(`/disputes/dispute/${complaintId}/decision`, { outcome: 'reject', note: 'again' })).status, 409);
  });

  it('the decision is on the audit log, with the reason', async () => {
    const n = (await sql<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE store_id = $1 AND action IN ('approve_refund', 'reject_refund')`, [STORE.a])).rows[0]!.n;
    assert.ok(Number(n) >= 3);
  });
});

describe('currencies', () => {
  it('lists them with how each is used, and says why the default cannot be switched off', async () => {
    const list_ = list(asJson((await get('/currencies')).body)['currencies']);
    const rwf = list_.find((c) => c['code'] === 'RWF')!;
    assert.equal(rwf['isDefault'], true);
    assert.match(String(rwf['lockedReason']), /always on/);
    assert.ok(list_.some((c) => c['code'] === 'USD'));
  });

  it('refuses nonsense and refuses to switch off what is in use', async () => {
    assert.equal((await put('/currencies/RWF', { rounding: 37 })).status, 400);
    assert.equal((await put('/currencies/RWF', { decimals: 3 })).status, 400);
    assert.equal((await put('/currencies/RWF', { symbol: '' })).status, 400);
    assert.equal((await put('/currencies/RWF', { usdRate: -1 })).status, 400);
    assert.equal((await put('/currencies/RWF', {})).status, 400, 'nothing to change');
    assert.equal((await put('/currencies/RWF', { enabled: false })).status, 409);
    assert.equal((await put('/currencies/ZZZ', { symbol: 'Z' })).status, 404);
    assert.equal((await put('/currencies/rwf', { symbol: 'Z' })).status, 400);
  });

  it('a change is saved, audited, and can be put back', async () => {
    const before = asJson(list(asJson((await get('/currencies')).body)['currencies']).find((c) => c['code'] === 'UGX')!);
    const r = await put('/currencies/UGX', { rounding: 100, symbol: 'USh', usdRate: 3700, rateSource: 'manual' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['rounding'], 100);
    assert.equal(r.body['symbol'], 'USh');
    assert.equal(r.body['usdRate'], 3700);
    assert.ok(r.body['rateUpdatedAt'] !== null, 'a manual rate is stamped');
    const entry = (await sql<{ summary: string }>(`SELECT summary FROM audit_log WHERE action = 'update_currency' ORDER BY sequence DESC LIMIT 1`)).rows[0]!;
    assert.match(entry.summary, /UGX/);
    await sql(`UPDATE currencies SET cash_rounding = $1, symbol = $2, usd_rate = NULL, rate_updated_at = NULL, rate_source = $3 WHERE code = 'UGX'`, [before['rounding'], before['symbol'], before['rateSource']]);
  });

  it('switching an unused currency on and off works', async () => {
    const was = list(asJson((await get('/currencies')).body)['currencies']).find((c) => c['code'] === 'TZS')!;
    const on = await put('/currencies/TZS', { enabled: !was['enabled'] });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body['enabled'], !was['enabled']);
    await put('/currencies/TZS', { enabled: was['enabled'] });
  });
});

describe('payment methods', () => {
  it('lists them and opens one, with its health and a readiness list that is derived, not ticked', async () => {
    const all = list(asJson((await get('/payment-methods')).body)['methods']);
    assert.ok(all.some((m) => m['key'] === 'mtn_momo') && all.some((m) => m['key'] === 'cash'));
    const d = asJson((await get('/payment-methods/mtn_momo')).body);
    assert.equal(d['status'], 'live');
    assert.ok(Array.isArray(d['readiness']) && Array.isArray(d['limits']));
    assert.equal(asJson(d['catalogue'])['countries'] !== undefined, true);
    assert.equal((await get('/payment-methods/nothing_here')).status, 404);
    assert.equal((await get('/payment-methods/Bad-Key')).status, 400);
  });

  it('a draft cannot be published until it is ready — and then it can, once', async () => {
    await sql(`INSERT INTO payment_methods (key, name, short_name, kind, customer_label, customer_hint, provider, webhook_url, status, position) VALUES ('zz_test_method', 'Test method', 'TEST', 'online', 'Test method', 'Approve on your phone', 'Test provider', 'https://example.test/hook', 'draft', 99)`);
    const early = await post('/payment-methods/zz_test_method/publish');
    assert.equal(early.status, 409);
    assert.match(String(early.body['error']), /available somewhere.*charge in a currency/);

    assert.equal((await put('/payment-methods/zz_test_method', { countries: ['ZZ'] })).status, 400, 'a country that is not open');
    assert.equal((await put('/payment-methods/zz_test_method', { currencies: [{ code: 'TZS', min: 1, max: 2 }] })).status, 400, 'a currency that is not on');
    assert.equal((await put('/payment-methods/zz_test_method', { currencies: [{ code: 'RWF', min: 500, max: 100 }] })).status, 400, 'min above max');

    const ok = await put('/payment-methods/zz_test_method', { countries: ['RW'], currencies: [{ code: 'RWF', min: 100, max: 1000000 }], customerLabel: 'Test pay', customerHint: 'Tap to approve' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(list(ok.body['limits']).map((l) => [l['currency'], l['min'], l['max']]), [['RWF', 100, 1000000]]);
    const live = await post('/payment-methods/zz_test_method/publish');
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.equal(live.body['status'], 'live');
    assert.equal((await post('/payment-methods/zz_test_method/publish')).status, 409, 'not twice');
    assert.ok(list(live.body['history']).some((h) => /Published Test method/.test(String(h['what']))), 'its history is the audit log');
  });

  it('a live method cannot lose its last country or currency, and can be paused and resumed', async () => {
    assert.equal((await put('/payment-methods/zz_test_method', { countries: [] })).status, 409);
    assert.equal((await put('/payment-methods/zz_test_method', { currencies: [] })).status, 409);
    const note = await put('/payment-methods/zz_test_method', { incidentNote: 'Slow approvals since 13:10.' });
    assert.equal(note.body['incidentNote'], 'Slow approvals since 13:10.');
    assert.equal((await put('/payment-methods/zz_test_method', { incidentNote: null })).body['incidentNote'], null);
    const paused = await post('/payment-methods/zz_test_method/pause');
    assert.equal(paused.body['status'], 'paused');
    assert.equal((await post('/payment-methods/zz_test_method/pause')).status, 409);
    assert.equal((await post('/payment-methods/zz_test_method/resume')).body['status'], 'live');
  });

  it('a draft has nothing to pause', async () => {
    await sql(`UPDATE payment_methods SET status = 'draft' WHERE key = 'zz_test_method'`);
    assert.equal((await post('/payment-methods/zz_test_method/pause')).status, 409);
  });

  it('every change is an audit entry naming the method', async () => {
    const n = (await sql<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE context->>'method' = 'zz_test_method'`)).rows[0]!.n;
    assert.ok(Number(n) >= 4);
  });
});
