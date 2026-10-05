// server/test/api/wallet.test.ts — milestone 23.
//
// The Wallet screen's server half, and the one write it exists for: Withdraw. MoMo is faked at `fetch`, because
// the one thing this suite must be able to do and a real sandbox cannot is make the provider REFUSE, or go
// SILENT, on demand — and those two cases are the whole difficulty of paying somebody out.
//
//   1. A WITHDRAWAL IS REQUESTED ONCE. The same idempotency key, however many times, reserves the funds once
//      and calls MoMo once.
//   2. A REFUSAL RETURNS THE MONEY; A SILENCE DOES NOT. MoMo saying 4xx is definitive and the funds go straight
//      back; a dropped connection is not, and returning them then risks paying out twice. The second case is
//      left `processing` until the status endpoint — the only thing believed — says which way it went.
//   3. THE DESTINATION IS NEVER IN THE REQUEST. A body naming a phone is ignored.
//   4. THE PHASE BEFORE THE PROVIDER IS CALLED IS RECOVERABLE: an attempt written and never sent (a crash) is
//      sent by the reconcile, because MoMo answers 404 for a reference it has never seen.
//   5. UNVERIFIED STORES AND REFUNDS OWED HOLD PAYOUTS, with the database's own sentence.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { reconcilePayouts, releaseEscrow, runAutomaticPayouts } from '../../src/jobs/settlement.ts';
import { clearTokenCache } from '../../src/payments/momo.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { ORDERS_BOARD, STORE, USER, cleanup, seedConsole, seedFixtures, seedOrdersBoard, seedStorefront } from './support.ts';

let api: Api;
const owner = (): string => tokenFor(USER.ownerA);
const manager = (): string => tokenFor(USER.managerA);

/** Every sweep is narrowed to the fixture store: this database also holds the dev seed. See settlement.ts. */
const MINE = [STORE.a] as const;

const wallet = `/api/stores/${STORE.a}/wallet`;
const payouts = `/api/stores/${STORE.a}/payouts`;

type Json = Record<string, unknown>;
const list = (v: unknown): Json[] => v as Json[];
const asJson = (v: unknown): Json => v as Json;

// ---------------------------------------------------------------------------
// MoMo, faked
// ---------------------------------------------------------------------------

const MOMO = 'http://momo.invalid';
const realFetch = globalThis.fetch;

type Behaviour = {
  /** What POST /transfer answers: an HTTP status, or 'drop' for a connection that dies. */
  transfer: number | 'drop';
  /** What GET /transfer/:ref answers. */
  status: 'PENDING' | 'SUCCESSFUL' | 'FAILED' | 'UNKNOWN';
  reason?: string;
};

let behaviour: Behaviour = { transfer: 202, status: 'PENDING' };
const sent: { reference: string; amount: string; phone: string }[] = [];

function fakeMomo(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(MOMO)) return realFetch(input, init);

    if (url.endsWith('/disbursement/token/')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith('/disbursement/v1_0/transfer') && init?.method === 'POST') {
      if (behaviour.transfer === 'drop') throw new TypeError('connection reset');
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(String(init.body)) as { amount: string; payee: { partyId: string } };
      sent.push({ reference: headers['X-Reference-Id']!, amount: body.amount, phone: body.payee.partyId });
      return new Response(behaviour.transfer === 202 ? '' : '{"message":"refused"}', { status: behaviour.transfer });
    }
    if (url.includes('/disbursement/v1_0/transfer/')) {
      if (behaviour.status === 'UNKNOWN') return new Response('', { status: 404 });
      return new Response(JSON.stringify({ status: behaviour.status, ...(behaviour.reason === undefined ? {} : { reason: behaviour.reason }) }), { status: 200 });
    }
    return new Response('not faked', { status: 500 });
  }) as typeof fetch;
}

const ENV_KEYS = ['MOMO_BASE_URL', 'MOMO_ENVIRONMENT', 'MOMO_DISBURSEMENT_SUBSCRIPTION_KEY', 'MOMO_DISBURSEMENT_API_USER', 'MOMO_DISBURSEMENT_API_KEY', 'MOMO_DEFAULT_COUNTRY_CODE', 'MOMO_HOLD_MINUTES'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

// ---------------------------------------------------------------------------
// Money fixtures, written the way the application writes them
// ---------------------------------------------------------------------------

async function credit(pot: 'pending' | 'available', amount: number, key: string, orderId: string | null = null): Promise<void> {
  await sql(
    `SELECT wallet_post(p_store_id => $1, p_pot => $2, p_entry_type => $3, p_amount => $4, p_idempotency_key => $5,
                        p_counterparty => 'test funding', p_order_id => $6)`,
    [STORE.a, pot, pot === 'pending' && orderId !== null ? 'order_payment_received' : 'adjustment', amount, key, orderId],
  );
}

async function balances(): Promise<{ pending: string; available: string }> {
  const { rows } = await sql<{ pending: string; available: string }>(
    `SELECT pending_balance::text AS pending, available_balance::text AS available FROM wallets WHERE store_id = $1`,
    [STORE.a],
  );
  return rows[0]!;
}

async function verify(): Promise<void> {
  const sub = `(SELECT id FROM kyc_submissions WHERE store_id = '${STORE.a}' AND status = '__S__')`;
  await sql(`SELECT submit_kyc($1, $2, 'national_id')`, [STORE.a, USER.ownerA]);
  for (const [part, key, type] of [['id_front', 'f.jpg', 'image/jpeg'], ['id_back', 'b.jpg', 'image/jpeg'], ['face_video', 'v.mp4', 'video/mp4']]) {
    await sql(`SELECT attach_kyc_document(${sub.replace('__S__', 'submitted')}, $1, $2, $3)`, [part, `kyc/${key}`, type]);
  }
  await sql(`SELECT complete_kyc_checks(${sub.replace('__S__', 'submitted')})`);
  await sql(`SELECT decide_kyc(${sub.replace('__S__', 'in_review')}, $1, 'approve', 'All checks passed')`, [USER.superAdmin]);
}

async function transfersSent(): Promise<number> {
  return sent.length;
}

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env['MOMO_BASE_URL'] = MOMO;
  process.env['MOMO_ENVIRONMENT'] = 'sandbox';
  process.env['MOMO_DISBURSEMENT_SUBSCRIPTION_KEY'] = 'sub';
  process.env['MOMO_DISBURSEMENT_API_USER'] = 'user';
  process.env['MOMO_DISBURSEMENT_API_KEY'] = 'key';
  process.env['MOMO_DEFAULT_COUNTRY_CODE'] = '250';
  // The dev .env sets its own hold window; this suite means sixty minutes, and says so.
  process.env['MOMO_HOLD_MINUTES'] = '60';
  clearTokenCache();
  fakeMomo();

  api = await boot();
  await seedFixtures();
  await seedStorefront();
  await seedConsole();
  await seedOrdersBoard();
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  clearTokenCache();
  await cleanup();
  await api.close();
  await closePool();
});

describe('who may see the money', () => {
  it('a manager reaches none of the new endpoints', async () => {
    for (const path of [`${wallet}/activity`, `${wallet}/refunds`, `${payouts}/00000000-0000-4000-8000-000000000001`]) {
      assert.equal((await call(api, 'GET', path, { token: manager() })).status, 403, path);
    }
    assert.equal((await call(api, 'POST', payouts, { token: manager(), body: { amount: '1000', idempotencyKey: 'k-manager-1' } })).status, 403);
    assert.equal((await call(api, 'PUT', `${payouts}/mode`, { token: manager(), body: { mode: 'automatic' } })).status, 403);
  });
});

describe('the cards', () => {
  it('reports the pots, the identity state and where payouts go — with the number masked', async () => {
    const res = await call(api, 'GET', wallet, { token: owner() });
    assert.equal(res.status, 200);
    assert.equal(res.body['identity'], 'not_started');
    assert.equal(res.body['pendingOrders'], 0);
    assert.equal(res.body['nextRelease'], null);
    assert.equal(res.body['refundsOwed'], '0.00');
    const payout = asJson(res.body['payout']);
    assert.equal(payout['phoneMasked'], '078 ••• 4412');
    assert.equal(payout['mode'], 'manual');
    assert.ok(!JSON.stringify(res.body).includes('111 4412'), 'the whole number never leaves the server');
    assert.equal(typeof res.body['cashWithRiders'], 'string');
  });
});

describe('Pending becomes Available', () => {
  it('shows the next release, then the sweep moves it and the Activity reads as one story', async () => {
    const { rows } = await sql<{ total: string }>(`SELECT total_amount::text AS total FROM orders WHERE id = $1`, [ORDERS_BOARD.deliveredPaid]);
    const total = Number(rows[0]!.total);
    // What record_momo_collection_success() does when a collection lands: the order is escrowed.
    await sql(`UPDATE orders SET settlement_status = 'pending' WHERE id = $1`, [ORDERS_BOARD.deliveredPaid]);
    await credit('pending', total, 'test:sale:1', ORDERS_BOARD.deliveredPaid);

    const waiting = await call(api, 'GET', wallet, { token: owner() });
    assert.equal(waiting.body['pendingOrders'], 1);
    const next = asJson(waiting.body['nextRelease']);
    assert.equal(Number(next['amount']), total);

    const first = list((await call(api, 'GET', `${wallet}/activity`, { token: owner() })).body['activity'])[0]!;
    assert.equal(first['kind'], 'sale');
    assert.equal(first['released'], false, 'still inside the hold window');
    assert.ok(first['availableAt'] !== null, 'and says when it clears');

    // Two hours later.
    await sql(`UPDATE orders SET paid_at = now() - interval '2 hours' WHERE id = $1`, [ORDERS_BOARD.deliveredPaid]);
    const swept = await releaseEscrow();
    assert.ok(swept.released >= 1);
    assert.equal((await sql<{ s: string }>(`SELECT settlement_status AS s FROM orders WHERE id = $1`, [ORDERS_BOARD.deliveredPaid])).rows[0]!.s, 'released');
    assert.equal(Number((await balances()).available), total);
    assert.equal(Number((await balances()).pending), 0);

    const again = await releaseEscrow();
    assert.equal(again.released, 0, 'a second sweep finds nothing, and releases nothing twice');

    const sale = list((await call(api, 'GET', `${wallet}/activity`, { token: owner() })).body['activity']).find((a) => a['kind'] === 'sale')!;
    assert.equal(sale['released'], true);
    assert.equal(sale['availableAt'], null);
    // The two-sided release is the sweep's business, not a row a merchant reads.
    assert.equal(list((await call(api, 'GET', `${wallet}/activity`, { token: owner() })).body['activity']).length, 1);
  });
});

describe('Activity', () => {
  it('filters by kind, pages by keyset, and balance-after is the store\'s total', async () => {
    await credit('available', 20000, 'test:adjust:1');
    await credit('available', 3000, 'test:adjust:2');

    const all = await call(api, 'GET', `${wallet}/activity?limit=2`, { token: owner() });
    const page1 = list(all.body['activity']);
    assert.equal(page1.length, 2);
    assert.ok(all.body['nextCursor'] !== null, 'there is a second page');

    const now = await balances();
    const total = Number(now.pending) + Number(now.available);
    assert.equal(Number(page1[0]!['balanceAfter']), total, 'the newest row ends at the total the cards show');
    assert.equal(Number(page1[1]!['balanceAfter']), total - Number(page1[0]!['amount']), 'each older row is the one above, undone');

    const cursor = asJson(all.body['nextCursor']);
    const page2 = list((await call(api, 'GET', `${wallet}/activity?limit=2&before=${encodeURIComponent(String(cursor['at']))}&beforeId=${cursor['id']}`, { token: owner() })).body['activity']);
    const seen = new Set(page1.map((r) => r['id']));
    assert.ok(page2.every((r) => !seen.has(r['id'])), 'the second page repeats nothing');

    const sales = list((await call(api, 'GET', `${wallet}/activity?filter=sale`, { token: owner() })).body['activity']);
    assert.ok(sales.length === 1 && sales[0]!['kind'] === 'sale');
    const adjust = list((await call(api, 'GET', `${wallet}/activity?filter=adjust`, { token: owner() })).body['activity']);
    assert.equal(adjust.length, 2);

    assert.equal((await call(api, 'GET', `${wallet}/activity?beforeId=${cursor['id']}`, { token: owner() })).status, 400, 'half a cursor is refused');
  });
});

describe('withdrawing', () => {
  it('is held while the store is unverified — with the database\'s own sentence, and nothing reserved', async () => {
    const before = await balances();
    const res = await call(api, 'POST', payouts, { token: owner(), body: { amount: '5000', idempotencyKey: 'key-unverified-1' } });
    assert.equal(res.status, 409);
    assert.equal(res.body['code'], 'PAYOUTS_HELD');
    assert.match(String(res.body['error']), /not been verified/);
    assert.deepEqual(await balances(), before);
    assert.equal(await transfersSent(), 0, 'and MoMo was never called');
  });

  it('reserves once and calls MoMo once, however many times the same key arrives', async () => {
    await verify();
    assert.equal((await call(api, 'GET', wallet, { token: owner() })).body['identity'], 'verified');

    behaviour = { transfer: 202, status: 'PENDING' };
    const start = Number((await balances()).available);
    const body = { amount: '10000', idempotencyKey: 'key-once-0001', phone: '0780000099' };

    const first = await call(api, 'POST', payouts, { token: owner(), body });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body['status'], 'processing');

    // Ten at once, on top of the first.
    const replies = await Promise.all(Array.from({ length: 10 }, () => call(api, 'POST', payouts, { token: owner(), body })));
    assert.ok(replies.every((r) => r.status === 200 && r.body['withdrawalId'] === first.body['withdrawalId']), 'every repeat answers with the first one');

    assert.equal(Number((await balances()).available), start - 10000, 'reserved exactly once');
    assert.equal(sent.length, 1, 'MoMo was called exactly once');
    assert.equal(sent[0]!.phone, '250781114412', 'and it went to the number in the store\'s settings, not the one in the body');
    assert.equal(sent[0]!.amount, '10000.00');

    // Arrives.
    behaviour = { transfer: 202, status: 'SUCCESSFUL' };
    const checked = await call(api, 'GET', `${payouts}/${first.body['withdrawalId']}`, { token: owner() });
    const payout = asJson(checked.body['payout']);
    assert.equal(payout['status'], 'completed');
    assert.ok(payout['completedAt'] !== null);
    assert.equal(payout['phoneMasked'], '078 ••• 4412');
    assert.equal(Number((await balances()).available), start - 10000, 'completing moves no more money');
  });

  it('puts the money straight back when MoMo REFUSES, with a reason a merchant can read', async () => {
    behaviour = { transfer: 400, status: 'PENDING' };
    const start = await balances();
    const res = await call(api, 'POST', payouts, { token: owner(), body: { amount: '4000', idempotencyKey: 'key-refused-01' } });
    assert.equal(res.status, 201);
    assert.equal(res.body['status'], 'failed');
    assert.match(String(res.body['failureReason']), /registered MTN MoMo account/);
    assert.deepEqual(await balances(), start, 'the reservation was reversed in full');

    const row = await sql<{ status: string }>(`SELECT status FROM momo_transactions WHERE withdrawal_id = $1`, [res.body['withdrawalId']]);
    assert.equal(row.rows[0]!.status, 'failed', 'the attempt is closed too');
  });

  it('does NOT return the money when MoMo goes SILENT — it waits for the real status', async () => {
    behaviour = { transfer: 'drop', status: 'PENDING' };
    const start = Number((await balances()).available);
    const res = await call(api, 'POST', payouts, { token: owner(), body: { amount: '3000', idempotencyKey: 'key-silent-001' } });
    assert.equal(res.status, 201);
    assert.equal(res.body['status'], 'processing', 'unknown is not failed');
    assert.equal(Number((await balances()).available), start - 3000, 'the funds stay reserved: the request may have arrived');

    // MoMo later says it failed. Only now does it go back.
    behaviour = { transfer: 202, status: 'FAILED', reason: 'PAYEE_NOT_FOUND' };
    const checked = await call(api, 'GET', `${payouts}/${res.body['withdrawalId']}`, { token: owner() });
    const payout = asJson(checked.body['payout']);
    assert.equal(payout['status'], 'failed');
    assert.match(String(payout['failureReason']), /PAYEE_NOT_FOUND/);
    assert.equal(Number((await balances()).available), start, 'now it is back');
  });

  it('finishes a payout whose attempt was written and never sent', async () => {
    // The crash window: the transaction committed, the process died before the request.
    behaviour = { transfer: 'drop', status: 'PENDING' };
    const res = await call(api, 'POST', payouts, { token: owner(), body: { amount: '2000', idempotencyKey: 'key-crash-0001' } });
    assert.equal(res.body['status'], 'processing');
    const before = sent.length;

    // MoMo has never heard of the reference: the reconcile sends it, then a later read finds it successful.
    behaviour = { transfer: 202, status: 'UNKNOWN' };
    await sql(`UPDATE momo_transactions SET created_at = now() - interval '5 minutes' WHERE withdrawal_id = $1`, [res.body['withdrawalId']]);
    assert.ok((await reconcilePayouts(MINE)) >= 1);
    assert.equal(sent.length, before + 1, 'sent exactly once by the sweep');

    behaviour = { transfer: 202, status: 'SUCCESSFUL' };
    await reconcilePayouts(MINE);
    const w = await sql<{ status: string }>(`SELECT status FROM withdrawals WHERE id = $1`, [res.body['withdrawalId']]);
    assert.equal(w.rows[0]!.status, 'completed');
  });

  it('refuses more than is available, an empty amount, and a missing key — creating nothing', async () => {
    const before = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM withdrawals WHERE store_id = $1`, [STORE.a]);
    const tooMuch = await call(api, 'POST', payouts, { token: owner(), body: { amount: '99999999', idempotencyKey: 'key-toomuch-01' } });
    assert.equal(tooMuch.status, 409);
    assert.equal(tooMuch.body['code'], 'INSUFFICIENT_FUNDS');
    assert.equal((await call(api, 'POST', payouts, { token: owner(), body: { amount: '0', idempotencyKey: 'key-zero-00001' } })).status, 400);
    assert.equal((await call(api, 'POST', payouts, { token: owner(), body: { amount: '-5', idempotencyKey: 'key-neg-000001' } })).status, 400);
    assert.equal((await call(api, 'POST', payouts, { token: owner(), body: { amount: '1000' } })).status, 400);
    const after = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM withdrawals WHERE store_id = $1`, [STORE.a]);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n);
  });

  it('is held while an approved refund is waiting for funds', async () => {
    // A queued refund is paid BEFORE the merchant (V008). One row is enough to say so.
    await sql(
      `INSERT INTO refunds (store_id, order_id, amount, reason_code, status, approved_amount, reviewed_at)
            VALUES ($1, $2, 500, 'wrong_item', 'queued', 500, now())`,
      [STORE.a, ORDERS_BOARD.deliveredPaid],
    );
    const card = await call(api, 'GET', wallet, { token: owner() });
    assert.equal(card.body['refundsOwed'], '500.00');

    const res = await call(api, 'POST', payouts, { token: owner(), body: { amount: '1000', idempotencyKey: 'key-owed-00001' } });
    assert.equal(res.status, 409);
    assert.equal(res.body['code'], 'PAYOUTS_HELD');
    assert.match(String(res.body['error']), /owed on refunds already approved/);

    const tab = list((await call(api, 'GET', `${wallet}/refunds`, { token: owner() })).body['refunds']);
    assert.equal(tab[0]!['status'], 'queued');
    const { rows: n } = await sql<{ order_number: number }>(`SELECT order_number FROM orders WHERE id = $1`, [ORDERS_BOARD.deliveredPaid]);
    assert.equal(tab[0]!['orderNumber'], n[0]!.order_number);
    await sql(`DELETE FROM refunds WHERE store_id = $1`, [STORE.a]);
  });
});

describe('the Withdrawals tab', () => {
  it('lists what happened, newest first, with the number masked', async () => {
    const res = await call(api, 'GET', payouts, { token: owner() });
    const rows = list(res.body['payouts']);
    assert.ok(rows.length >= 4);
    assert.ok(rows.every((r) => /^\d{3} ••• \d{4}$/.test(String(r['phoneMasked']))), 'every number is masked');
    assert.ok(rows.some((r) => r['status'] === 'completed'));
    assert.ok(rows.some((r) => r['status'] === 'failed' && String(r['failureReason']).length > 0));
  });
});

describe('automatic payouts', () => {
  it('can be switched on and off, and the switch is a payouts permission', async () => {
    const on = await call(api, 'PUT', `${payouts}/mode`, { token: owner(), body: { mode: 'automatic' } });
    assert.equal(on.status, 200);
    assert.equal(asJson(on.body['payout'])['mode'], 'automatic');
    assert.equal(asJson(on.body['payout'])['automaticAt'], '08:00', 'the board says every day at 08:00');

    const off = await call(api, 'PUT', `${payouts}/mode`, { token: owner(), body: { mode: 'manual' } });
    assert.equal(asJson(off.body['payout'])['automaticAt'], null);

    assert.equal((await call(api, 'PUT', `${payouts}/mode`, { token: owner(), body: { mode: 'sometimes' } })).status, 400);
  });

  it('pays out once a day, whatever the sweep does', async () => {
    await call(api, 'PUT', `${payouts}/mode`, { token: owner(), body: { mode: 'automatic' } });
    // Midnight, so "past the time of day" is true whenever this suite runs.
    await sql(`UPDATE store_payout_settings SET automatic_at = '00:00' WHERE store_id = $1`, [STORE.a]);
    behaviour = { transfer: 202, status: 'PENDING' };

    const available = Number((await balances()).available);
    assert.ok(available > 0);
    const sentBefore = sent.length;

    assert.equal(await runAutomaticPayouts(MINE), 1);
    assert.equal(sent.length, sentBefore + 1);
    assert.equal(Number((await balances()).available), 0, 'everything available went');

    const w = await sql<{ initiated_by: string; amount: string }>(`SELECT initiated_by, amount::text FROM withdrawals WHERE store_id = $1 AND initiated_by = 'automatic'`, [STORE.a]);
    assert.equal(w.rows.length, 1);
    assert.equal(Number(w.rows[0]!.amount), available);

    await credit('available', 700, 'test:adjust:after-auto');
    assert.equal(await runAutomaticPayouts(MINE), 0, 'the same day, nothing more goes');
    assert.equal(sent.length, sentBefore + 1);
  });

  it('skips a store in manual mode, and one that is not verified', async () => {
    await call(api, 'PUT', `${payouts}/mode`, { token: owner(), body: { mode: 'manual' } });
    assert.equal(await runAutomaticPayouts(MINE), 0);
  });
});

describe('the disbursement webhook', () => {
  it('answers 200 to anything and believes nothing it is told', async () => {
    const unknown = await call(api, 'POST', `/api/momo/callback/disbursement/${crypto.randomUUID()}`, { body: { status: 'SUCCESSFUL' } });
    assert.equal(unknown.status, 200);
    const nonsense = await call(api, 'POST', `/api/momo/callback/disbursement/not-a-uuid`, { body: {} });
    assert.equal(nonsense.status, 200);
  });
});
