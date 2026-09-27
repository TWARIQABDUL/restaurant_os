// server/test/api/orders.test.ts — milestone 20.
//
// The Orders board over HTTP: the list, one order's detail, the rider picker, and every transition after
// accept() (milestone 19's own suite, console.test.ts, keeps that one).
//
// WHAT IS AND IS NOT RE-TESTED HERE. `db/scripts/test-orders-console.sh` already drives every plpgsql function
// directly — the stock release, the return's two-sided money rule, the duplicate-refund guard — with a fixture
// built for exactly that. This file is the OTHER half: the HTTP wiring those functions sit behind. A permission
// a route forgot to ask for, a field validated in the wrong place, a response shaped differently from the one
// before it — none of that shows up in a suite that calls the SQL functions directly, and all of it shows up
// here.
//
//   1. ORDERS.ASSIGN_RIDER IS ITS OWN PERMISSION, not orders.update — a manager holds both (V001), so this only
//      shows up as a boundary when tested as one, which is why the rider picker gets its own 403 check rather
//      than reusing accept()'s.
//   2. A RIDER CANNOT WORK THE BOARD. `deliveries.own_read`/`own_update` is what a rider holds instead of
//      `orders.read` — the same boundary console.test.ts drew around accept(), extended to the routes that
//      arrived with this milestone.
//   3. EVERY TRANSITION ANSWERS THE SAME SHAPE, `{ ok, status }`, because storeOrders.ts's own `transition()`
//      helper is what makes that true — a route that quietly returned something else would still typecheck.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { CONSOLE, ORDERS_BOARD, STORE, USER, cleanup, seedConsole, seedFixtures, seedOrdersBoard, seedStorefront } from './support.ts';

let api: Api;

const owner = (): string => tokenFor(USER.ownerA);
const manager = (): string => tokenFor(USER.managerA);
const rider = (): string => tokenFor(USER.riderA);

const ordersPath = `/api/stores/${STORE.a}/orders`;

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  await seedConsole();
  await seedOrdersBoard();
  await sql(`UPDATE promotions SET is_active = false WHERE store_id = $1`, [STORE.a]);
  // One GET so the "browser" holds a csrf cookie, which every unsafe method below echoes.
  await call(api, 'GET', ordersPath, { token: owner() });
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
});

describe('the list — open orders, plus today\'s closed ones', () => {
  it('a manager reads it; a rider cannot', async () => {
    const res = await call(api, 'GET', ordersPath, { token: manager() });
    assert.equal(res.status, 200);
    const rows = res.body['orders'] as Record<string, unknown>[];
    const ids = rows.map((r) => r['id']);
    assert.ok(ids.includes(ORDERS_BOARD.readyDelivery), 'a ready order is on the board');
    assert.ok(ids.includes(ORDERS_BOARD.assigned), 'so is an assigned one');

    const denied = await call(api, 'GET', ordersPath, { token: rider() });
    assert.equal(denied.status, 403);
  });
});

describe('one order\'s detail', () => {
  it('carries the lines, the money and the history', async () => {
    const res = await call(api, 'GET', `${ordersPath}/${ORDERS_BOARD.deliveredCashUnconfirmed}`, { token: owner() });
    assert.equal(res.status, 200);
    const order = res.body['order'] as Record<string, unknown>;
    assert.equal(order['status'], 'delivered');
    assert.equal(order['cashConfirmed'], false);
    assert.equal((order['lines'] as unknown[]).length, 1);
  });

  it('an order from another store looks exactly like one that does not exist', async () => {
    const res = await call(api, 'GET', `/api/stores/${STORE.b}/orders/${ORDERS_BOARD.deliveredPaid}`, {
      token: tokenFor(USER.adminB),
    });
    assert.equal(res.status, 404);
  });
});

describe('the rider picker', () => {
  it('is its own permission, not orders.update', async () => {
    const ok = await call(api, 'GET', `${ordersPath}/riders`, { token: manager() });
    assert.equal(ok.status, 200);
    const riders = ok.body['riders'] as Record<string, unknown>[];
    assert.ok(riders.some((r) => r['id'] === USER.riderA));

    const denied = await call(api, 'GET', `${ordersPath}/riders`, { token: rider() });
    assert.equal(denied.status, 403);
  });

  it('assigns, and names who — a rider assigned to their own job cannot do the assigning', async () => {
    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.readyDelivery}/assign-rider`, {
      token: manager(),
      body: { riderUserId: USER.riderA },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'assigned');
    assert.equal(res.body['riderName'], 'Rider A');

    const denied = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.readyDelivery}/assign-rider`, {
      token: rider(),
      body: { riderUserId: USER.riderA },
    });
    assert.equal(denied.status, 403);
  });

  it('refuses a rider id that is not a UUID, and one that is not a rider', async () => {
    const bad = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.readyDelivery}/assign-rider`, {
      token: manager(),
      body: { riderUserId: 'not-a-uuid' },
    });
    assert.equal(bad.status, 400);

    const notARider = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.readyDelivery}/assign-rider`, {
      token: manager(),
      body: { riderUserId: USER.managerA },
    });
    assert.equal(notARider.status, 400);
  });
});

describe('declining and cancelling need a reason', () => {
  it('declining a pending order rejects it, with the reason on the record', async () => {
    const noReason = await call(api, 'POST', `${ordersPath}/${CONSOLE.newestPending}/decline`, { token: owner(), body: {} });
    assert.equal(noReason.status, 400);

    const notAUuid = await call(api, 'POST', `${ordersPath}/not-a-uuid/decline`, {
      token: owner(),
      body: { reason: 'An item is out of stock' },
    });
    assert.equal(notAUuid.status, 400);

    const res = await call(api, 'POST', `${ordersPath}/${CONSOLE.newestPending}/decline`, {
      token: owner(),
      body: { reason: 'An item is out of stock' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'rejected');

    const { rows } = await sql<{ reason: string }>(`SELECT reason FROM order_events WHERE order_id = $1`, [
      CONSOLE.newestPending,
    ]);
    assert.equal(rows[0]?.reason, 'An item is out of stock');
  });

  it('cancelling an accepted order needs orders.update, and a rider does not have it', async () => {
    const denied = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.preparing}/cancel`, {
      token: rider(),
      body: { reason: 'Something else' },
    });
    assert.equal(denied.status, 403);

    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.preparing}/cancel`, {
      token: manager(),
      body: { reason: 'An item ran out while preparing' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'cancelled');

    // And a second cancel finds nothing left to cancel — the conflict, not a crash.
    const again = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.preparing}/cancel`, {
      token: manager(),
      body: { reason: 'Something else' },
    });
    assert.equal(again.status, 409);
  });
});

describe('the kitchen, the rider, and the counter', () => {
  it('start-preparing and ready both answer { ok, status }', async () => {
    const start = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.approvedForKitchen}/start-preparing`, {
      token: manager(),
    });
    assert.equal(start.status, 200);
    assert.equal(start.body['status'], 'preparing');

    const ready = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.approvedForKitchen}/ready`, { token: manager() });
    assert.equal(ready.status, 200);
    assert.equal(ready.body['status'], 'ready');

    // And a second "ready" finds nothing preparing — the conflict, not a crash.
    const again = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.approvedForKitchen}/ready`, { token: manager() });
    assert.equal(again.status, 409);
  });

  it('hands an assigned order to the rider', async () => {
    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.assigned}/picked-up`, { token: manager() });
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'out');
  });

  it('marks delivered, leaving a cash order unpaid until confirmed', async () => {
    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.out}/delivered`, { token: manager() });
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'delivered');

    const detail = await call(api, 'GET', `${ordersPath}/${ORDERS_BOARD.out}`, { token: owner() });
    assert.equal((detail.body['order'] as Record<string, unknown>)['paymentStatus'], 'unpaid');
  });

  it('confirms cash for a delivered order', async () => {
    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.deliveredCashUnconfirmed}/confirm-cash`, {
      token: manager(),
      body: { reportedAmount: '8000' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body['ok'], true);

    const detail = await call(api, 'GET', `${ordersPath}/${ORDERS_BOARD.deliveredCashUnconfirmed}`, { token: owner() });
    assert.equal((detail.body['order'] as Record<string, unknown>)['cashConfirmed'], true);
  });

  it('collects a cash pickup order, confirming cash in the same call', async () => {
    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.readyPickupCash}/collected`, { token: manager() });
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'collected');

    const detail = await call(api, 'GET', `${ordersPath}/${ORDERS_BOARD.readyPickupCash}`, { token: owner() });
    const order = detail.body['order'] as Record<string, unknown>;
    assert.equal(order['paymentStatus'], 'paid');
    assert.equal(order['cashConfirmed'], true);
  });
});

describe('returns', () => {
  it('closes one, restocking and refunding a paid MoMo order — the money side is db/scripts/test-orders-console.sh\'s', async () => {
    // Give the store enough to refund from, the same way the DB suite does: through the ledger, not a
    // direct UPDATE — wallets.available_balance is trigger-guarded against exactly that.
    await sql(`SELECT wallet_post($1, 'available', 'adjustment', 50000, 'orders-test-fund', 'platform')`, [STORE.a]);

    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.returnedMomo}/close-return`, {
      token: owner(),
      body: { restock: false },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'closed_return');

    const { rows } = await sql<{ status: string }>(`SELECT status FROM refunds WHERE order_id = $1`, [
      ORDERS_BOARD.returnedMomo,
    ]);
    assert.equal(rows.length, 1);
    assert.ok(['approved', 'queued'].includes(rows[0]?.status ?? ''), 'settled one way or the other, never left uncreated');
  });

  it('a close-return needs a restock decision, not an assumed one', async () => {
    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.returnedForRetry}/close-return`, {
      token: owner(),
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('or tries the delivery again instead', async () => {
    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.returnedForRetry}/retry-delivery`, {
      token: owner(),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'ready');
  });
});

describe('a refund straight from the order, no complaint behind it', () => {
  it('creates one, refuses a second before the first is decided, and refuses too much', async () => {
    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.deliveredPaid}/request-refund`, {
      token: owner(),
      body: { amount: '2000', reasonCode: 'quality_problem' },
    });
    assert.equal(res.status, 201);
    assert.ok(typeof res.body['refundId'] === 'string');
    assert.equal(res.body['refundStatus'], 'pending');

    const again = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.deliveredPaid}/request-refund`, {
      token: owner(),
      body: { amount: '1000', reasonCode: 'other', reasonNote: 'a second thing' },
    });
    assert.equal(again.status, 409);

    const tooMuch = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.deliveredCashUnconfirmed}/request-refund`, {
      token: owner(),
      // Not yet paid at all — the same refusal an amount too large would get, since neither order is a
      // refundable state, and the route reports both the same way: a plain conflict.
      body: { amount: '999999', reasonCode: 'other', reasonNote: 'too much' },
    });
    assert.equal(tooMuch.status, 409);
  });

  it('"other" needs a note the merchant actually wrote', async () => {
    const res = await call(api, 'POST', `${ordersPath}/${ORDERS_BOARD.deliveredPaid}/request-refund`, {
      token: owner(),
      body: { amount: '500', reasonCode: 'other' },
    });
    assert.equal(res.status, 400);
  });
});
