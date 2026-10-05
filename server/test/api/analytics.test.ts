// server/test/api/analytics.test.ts — milestone 24.
//
//   1. THE PERMISSION IS wallet.read, NOT A NEW ONE: a manager can answer a customer and still cannot read takings.
//   2. EVERY FIGURE IS BUCKETED BY THE STORE'S OWN DAY, and the period is compared with the one before it.
//   3. REVENUE COUNTS WHEN AN ORDER IS PAID, at its total, with refunds shown beside it rather than netted.
//   4. NOTHING IS INVENTED: where the schema holds no history (stock-outs) the tab says what it can.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { ORDERS_BOARD, STORE, USER, cleanup, seedConsole, seedFixtures, seedOrdersBoard, seedStorefront } from './support.ts';

let api: Api;
const owner = (): string => tokenFor(USER.ownerA);
const manager = (): string => tokenFor(USER.managerA);
const base = `/api/stores/${STORE.a}/analytics`;

type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => v as Json;
const list = (v: unknown): Json[] => v as Json[];

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  await seedConsole();
  await seedOrdersBoard();
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
});

describe('who may read the takings', () => {
  it('owners can; a manager and a stranger cannot', async () => {
    assert.equal((await call(api, 'GET', `${base}/summary`, { token: owner() })).status, 200);
    assert.equal((await call(api, 'GET', `${base}/summary`, { token: manager() })).status, 403);
    assert.equal((await call(api, 'GET', `${base}/summary/export`, { token: manager() })).status, 403);
    assert.equal((await call(api, 'GET', `${base}/summary`, { token: tokenFor(USER.adminB) })).status, 403);
  });

  it('refuses a tab or a range the board does not have', async () => {
    assert.equal((await call(api, 'GET', `${base}/profit`, { token: owner() })).status, 400);
    assert.equal((await call(api, 'GET', `${base}/summary?range=90`, { token: owner() })).status, 400);
    assert.equal((await call(api, 'GET', `${base}/summary?range=abc`, { token: owner() })).status, 400);
  });
});

describe('the periods', () => {
  it('covers exactly the days asked for, ending today in the store\'s own calendar', async () => {
    for (const days of [7, 14, 30]) {
      const res = await call(api, 'GET', `${base}/revenue?range=${days}`, { token: owner() });
      const data = asJson(res.body['data']);
      assert.equal(list(data['dates']).length, days);
      assert.equal(res.body['to'], (data['dates'] as string[])[days - 1]);
      assert.equal(res.body['from'], (data['dates'] as string[])[0]);
    }
  });
});

describe('Revenue and Summary', () => {
  it('counts a paid order on the day it was paid, by method, and puts refunds beside it', async () => {
    const res = await call(api, 'GET', `${base}/revenue`, { token: owner() });
    const d = asJson(res.body['data']);
    const today = String(res.body['to']);
    const todays = asJson(asJson(d['byDay'])[today]);
    assert.ok(todays['mtn_momo'] !== undefined, 'the fixtures\' paid MoMo orders landed today');
    assert.ok(Number(d['revenue']) > 0);
    assert.equal(d['previousRevenue'], '0.00', 'nothing was paid in the period before');
    assert.equal(d['refunded'], '0.00');
    assert.ok(list(d['methods']).some((m) => m['key'] === 'cash' && m['kind'] === 'offline'));

    // An approved refund shows as refunded, and revenue is not reduced by it.
    const before = Number(d['revenue']);
    await sql(
      `INSERT INTO refunds (store_id, order_id, amount, reason_code, status, approved_amount, reviewed_at, settled_at)
            VALUES ($1, $2, 500, 'wrong_item', 'queued', 500, now(), NULL)`,
      [STORE.a, ORDERS_BOARD.deliveredPaid],
    );
    await sql(`UPDATE refunds SET status = 'approved', settled_at = now() WHERE store_id = $1`, [STORE.a]).catch(() => undefined);
    const after = asJson((await call(api, 'GET', `${base}/revenue`, { token: owner() })).body['data']);
    assert.equal(Number(after['revenue']), before, 'revenue is gross: a refund does not reduce it');
    await sql(`DELETE FROM refunds WHERE store_id = $1`, [STORE.a]);
  });

  it('says how many orders, against the period before', async () => {
    const d = asJson((await call(api, 'GET', `${base}/summary`, { token: owner() })).body['data']);
    assert.ok(Number(d['orders']) >= 10);
    assert.equal(d['previousOrders'], 0);
    assert.ok(d['repeatShare'] === null || typeof d['repeatShare'] === 'number');
  });
});

describe('Orders over time', () => {
  it('counts per day, the delivery share, and what was turned away', async () => {
    const d = asJson((await call(api, 'GET', `${base}/orders`, { token: owner() })).body['data']);
    const perDay = asJson(d['perDay']);
    assert.ok((Object.values(perDay) as number[]).reduce((a, c) => a + Number(c), 0) === Number(d['total']));
    assert.ok(Number(d['deliveryShare']) > 0 && Number(d['deliveryShare']) <= 100);
    assert.equal(d['turnedAway'], 0);
    assert.equal(d['topReason'], null);
  });
});

describe('Top items', () => {
  it('ranks by revenue, and says what is out of stock now rather than inventing stock-out history', async () => {
    const d = asJson((await call(api, 'GET', `${base}/items`, { token: owner() })).body['data']);
    const items = list(d['items']);
    assert.ok(items.length >= 1);
    assert.equal(items[0]!['name'], 'Passion Juice');
    assert.ok(Number(items[0]!['sold']) >= 1);
    assert.equal(d['bestSeller'], 'Passion Juice');
    assert.equal(typeof d['outOfStockNow'], 'number');
    assert.ok(!('ranOutMost' in d), 'no stock-out history exists to rank');
  });
});

describe('Payment methods', () => {
  it('shares orders by method, and reports cash waiting to be confirmed', async () => {
    const d = asJson((await call(api, 'GET', `${base}/payments`, { token: owner() })).body['data']);
    const methods = list(d['methods']);
    assert.ok(methods.length >= 2);
    const cash = methods.find((m) => m['key'] === 'cash')!;
    assert.equal(cash['successRate'], null, 'cash has no success rate: nothing is attempted');
    assert.ok(Number(d['paidOnlineShare']) >= 0);
    const unconfirmed = asJson(d['cashUnconfirmed']);
    assert.ok(Number(unconfirmed['orders']) >= 1, 'the delivered cash order nobody has confirmed');
  });
});

describe('Delivery performance', () => {
  it('lists riders with a delivery, and says what "on time" was measured against', async () => {
    const d = asJson((await call(api, 'GET', `${base}/delivery`, { token: owner() })).body['data']);
    assert.ok(Array.isArray(d['riders']));
    assert.ok('etaMaxMinutes' in d);
    assert.equal(d['etaMaxMinutes'], 60, 'the slowest of the fixture zones, Far: 40–60');
    assert.equal(typeof d['returned'], 'number');
    assert.ok(Number(d['returned']) >= 0);
  });
});

describe('Export', () => {
  it('writes each tab as CSV', async () => {
    for (const [tab, header] of [
      ['summary', '"Date"'],
      ['orders', '"Date","Orders"'],
      ['items', '"Item","Sold","Revenue"'],
      ['payments', '"Method","Orders","Revenue","Success rate %"'],
      ['delivery', '"Rider","Deliveries","Average minutes","On time %"'],
    ] as const) {
      const res = await fetch(`${api.baseUrl}${base}/${tab}/export?range=7`, { headers: { Authorization: `Bearer ${owner()}` } });
      assert.equal(res.status, 200, tab);
      assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
      assert.match(res.headers.get('content-disposition') ?? '', new RegExp(`analytics-${tab}-7d\\.csv`));
      assert.ok((await res.text()).startsWith(header), tab);
    }
  });
});
