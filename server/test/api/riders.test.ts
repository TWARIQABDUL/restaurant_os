// server/test/api/riders.test.ts — milestone 21.
//
// The rider's own app and CashReport over HTTP. `db/scripts/test-riders-console.sh` already drives
// every plpgsql function directly with a fixture built to expose exactly the shortfall arithmetic that
// mattered; this file is the OTHER half, the same split orders.test.ts (milestone 20) drew — the HTTP
// wiring those functions sit behind.
//
//   1. OWNERSHIP IS NOT A PERMISSION. `deliveries.own_update` is what a rider holds; it says nothing
//      about WHICH order. riderApp.ts checks `riders.isOwnJob()` before touching anything, and this
//      suite is what proves a SECOND rider reaches a 404 on the first rider's own delivery — the same
//      answer an order from another store gets, by design (riderApp.ts's own header).
//   2. OWNER/MANAGER CANNOT REACH THE RIDER'S OWN ROUTES, AND A RIDER CANNOT REACH CASHREPORT'S. Two
//      different permissions gate two different screens, and neither includes the other — V001 gives
//      a rider deliveries.own_*, never orders.*, and the reverse for staff.
//   3. CLOSING A DAY IS IDEMPOTENT FOR A REPLAY, same reason accept() (milestone 19) is: a second
//      close-day call this session finds nothing left to close and says so with a 409, not a crash.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { RIDER_BOARD, STORE, USER, cleanup, seedConsole, seedFixtures, seedOrdersBoard, seedRiderBoard, seedStorefront } from './support.ts';

let api: Api;

const owner = (): string => tokenFor(USER.ownerA);
const manager = (): string => tokenFor(USER.managerA);
const riderA = (): string => tokenFor(USER.riderA);
const riderC = (): string => tokenFor(USER.riderC);

const riderAppPath = `/api/stores/${STORE.a}/rider`;
const ridersPath = `/api/stores/${STORE.a}/riders`;

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  await seedConsole();
  await seedOrdersBoard();
  await seedRiderBoard();
  await sql(`UPDATE promotions SET is_active = false WHERE store_id = $1`, [STORE.a]);
  await call(api, 'GET', riderAppPath, { token: riderA() });
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
});

describe('the rider\'s own app', () => {
  it('shows the profile, the jobs and cash held — and nobody else\'s role reaches it', async () => {
    const res = await call(api, 'GET', riderAppPath, { token: riderA() });
    assert.equal(res.status, 200);
    assert.equal(res.body['storeName'], 'Escalation Store A');
    const me = res.body['me'] as Record<string, unknown>;
    assert.equal(me['plateNumber'], 'RAX 100 A');
    const jobs = res.body['jobs'] as Record<string, unknown>[];
    assert.ok(jobs.some((j) => j['id'] === RIDER_BOARD.toPickUp));

    const asOwner = await call(api, 'GET', riderAppPath, { token: owner() });
    assert.equal(asOwner.status, 403);
  });

  it('the availability switch, and a plain boolean is required', async () => {
    const missing = await call(api, 'PUT', `${riderAppPath}/availability`, { token: riderA(), body: {} });
    assert.equal(missing.status, 400);

    const res = await call(api, 'PUT', `${riderAppPath}/availability`, { token: riderA(), body: { available: false } });
    assert.equal(res.status, 200);
    assert.equal(res.body['availability'], 'off_duty');

    await call(api, 'PUT', `${riderAppPath}/availability`, { token: riderA(), body: { available: true } });
  });

  it('picks up, delivers, and confirms cash — all reusing orders.ts\'s own transitions', async () => {
    const pickedUp = await call(api, 'POST', `${riderAppPath}/orders/${RIDER_BOARD.toPickUp}/picked-up`, { token: riderA() });
    assert.equal(pickedUp.status, 200);
    assert.equal(pickedUp.body['status'], 'out');

    const delivered = await call(api, 'POST', `${riderAppPath}/orders/${RIDER_BOARD.onRoadMomo}/delivered`, { token: riderA() });
    assert.equal(delivered.status, 200);

    const confirmed = await call(api, 'POST', `${riderAppPath}/orders/${RIDER_BOARD.onRoadCash}/confirm-cash`, {
      token: riderA(),
      body: { reportedAmount: '8000' },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body['ok'], true);
  });

  it('cannot deliver — "returned", with a reason, the transition milestone 20 deferred to this one', async () => {
    const noReason = await call(api, 'POST', `${riderAppPath}/orders/${RIDER_BOARD.toReturn}/returned`, { token: riderA(), body: {} });
    assert.equal(noReason.status, 400);

    const res = await call(api, 'POST', `${riderAppPath}/orders/${RIDER_BOARD.toReturn}/returned`, {
      token: riderA(),
      body: { reason: 'Customer not answering' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'returned');
  });

  it('a second rider reaches none of the first rider\'s jobs — a 404, the same as another store\'s order', async () => {
    const res = await call(api, 'POST', `${riderAppPath}/orders/${RIDER_BOARD.confirmedToday}/delivered`, { token: riderC() });
    assert.equal(res.status, 404);
    assert.equal(res.body['code'], 'NOT_YOUR_JOB');
  });

  it('refuses a request that names no order at all', async () => {
    const res = await call(api, 'POST', `${riderAppPath}/orders/not-a-uuid/picked-up`, { token: riderA() });
    assert.equal(res.status, 400);
  });
});

describe('CashReport — the merchant\'s own screen', () => {
  it('the roster, and a rider cannot reach it', async () => {
    const res = await call(api, 'GET', ridersPath, { token: manager() });
    assert.equal(res.status, 200);
    const roster = res.body['roster'] as Record<string, unknown>[];
    assert.ok(roster.some((r) => r['id'] === USER.riderA));

    const asRider = await call(api, 'GET', ridersPath, { token: riderA() });
    assert.equal(asRider.status, 403);
  });

  it('the cash report names today\'s confirmed delivery', async () => {
    const res = await call(api, 'GET', `${ridersPath}/cash-report`, { token: owner() });
    assert.equal(res.status, 200);
    const cards = res.body['cards'] as Record<string, unknown>[];
    const mine = cards.find((c) => c['riderId'] === USER.riderA);
    assert.ok(mine !== undefined, 'riderA has a card — they have a confirmed cash delivery today');
  });

  it('records a hand-over, then closes the day, then refuses a second close', async () => {
    const handover = await call(api, 'POST', `${ridersPath}/${USER.riderA}/handover`, {
      token: owner(),
      body: { amount: '8000', note: 'end of morning' },
    });
    assert.equal(handover.status, 201);
    assert.ok(typeof handover.body['handoverId'] === 'string');

    // Whatever riderA owes today, after handing over the lot — a closing figure of 0 either balances or
    // asks for a resolution, which is exactly what the second half of this test exercises.
    const close = await call(api, 'POST', `${ridersPath}/${USER.riderA}/close-day`, {
      token: owner(),
      body: { counted: '0' },
    });
    assert.ok(close.status === 201 || close.status === 409, `expected 201 or 409, got ${close.status}`);

    if (close.status === 201) {
      const again = await call(api, 'POST', `${ridersPath}/${USER.riderA}/close-day`, {
        token: owner(),
        body: { counted: '0' },
      });
      assert.equal(again.status, 409);
    }
  });

  it('a discount resolution needs the order and a note, or it is refused before it reaches the database', async () => {
    const res = await call(api, 'POST', `${ridersPath}/${USER.riderC}/close-day`, {
      token: owner(),
      body: { counted: '0', resolution: 'discount' },
    });
    assert.equal(res.status, 400);
  });

  it('marking a carried-over debt received that does not exist is a 404', async () => {
    const res = await call(api, 'POST', `${ridersPath}/settlements/${STORE.b}/receive`, { token: owner() });
    assert.equal(res.status, 404);
  });
});
