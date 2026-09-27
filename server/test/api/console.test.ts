// server/test/api/console.test.ts — milestone 19.
//
// The merchant console over HTTP: the shell, the dashboard, the pause switch, the notifications panel and the
// new-order alert. Five things are worth testing here and the rest follows from them.
//
//   1. WHAT A MANAGER IS AND IS NOT GIVEN. §5.4 refused a manager at /wallet on the grounds that a role is a set
//      of permission rows rather than code, and the dashboard is the same question asked about revenue: the
//      counts and the queue arrive, `sales` and `week` simply are not there. And it is not only a hidden
//      component — a manager reading the notifications inbox does not receive the payout at all.
//   2. THE ALERT IS THE OLDEST WAITING ORDER, NOT THE NEWEST. Its whole specification is "shows on every
//      signed-in screen at this store", which only works because it is derived from `orders` rather than held in
//      a session. With two orders pending, choosing wrongly is invisible in the UI and obvious here.
//   3. ACCEPTING IS IDEMPOTENT, AND DECLINED IS NOT THE SAME AS ACCEPTED. The alert is on every screen at once,
//      so two people pressing Accept in the same second is the expected case. The second must be told it worked.
//      Accepting something already declined must not be.
//   4. PAUSING NEW ORDERS STOPS CHECKOUT AND NOTHING ELSE. A merchant pausing the kitchen is not closing the
//      shop: the shopfront keeps listing what it sells, and place_order() refuses with a sentence a customer can
//      act on.
//   5. THE SOUND SWITCH IS PER DEVICE. "Sound is off for this device" is the board's own wording, so a second
//      browser at the same store must still chime.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import {
  CATALOGUE,
  CONSOLE,
  STORE,
  USER,
  cleanup,
  seedConsole,
  seedFixtures,
  seedNotifications,
  seedStorefront,
} from './support.ts';

let api: Api;
let complaintId = '';
const SLUG = 'escalation-store-a';

const owner = (): string => tokenFor(USER.ownerA);
const manager = (): string => tokenFor(USER.managerA);
const rider = (): string => tokenFor(USER.riderA);

const shellPath = `/api/stores/${STORE.a}/shell`;
const dashPath = `/api/stores/${STORE.a}/dashboard`;
const notifyPath = `/api/stores/${STORE.a}/notifications`;

/** seedStorefront's plain product: one variant, no options, no stock tracking. */
const JUICE_VARIANT = 'eeeeeeee-0000-4000-8000-000000000310';

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  const seeded = await seedConsole();
  complaintId = seeded.complaintId;
  await seedNotifications(complaintId);
  // Store A's automatic promotion would change the totals this file prints; every assertion here is about the
  // console's own reads, so it is switched off rather than worked around.
  await sql(`UPDATE promotions SET is_active = false WHERE store_id = $1`, [STORE.a]);
  // One GET so the "browser" holds a csrf cookie, which every unsafe method below echoes.
  await call(api, 'GET', shellPath, { token: owner() });
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
});

describe('the shell — one document the whole console reads', () => {
  it('carries the store, its own time zone, its currency, its config and the badges', async () => {
    const res = await call(api, 'GET', shellPath, { token: owner() });
    assert.equal(res.status, 200);

    const store = res.body['store'] as Record<string, unknown>;
    assert.equal(store['slug'], SLUG);
    // V021's trigger filled this from the country, and every time the console prints is formatted in it.
    assert.equal(store['timeZone'], 'Africa/Kigali');
    const currency = store['currency'] as Record<string, unknown>;
    assert.equal(currency['code'], 'RWF');
    assert.equal(currency['decimals'], 0);

    const me = res.body['me'] as Record<string, unknown>;
    assert.equal(me['role'], 'owner');
    assert.ok((me['permissions'] as string[]).includes('wallet.read'));

    // The config engine's answer, not an industry name: §2.3's rule is that a component asks a question.
    const config = res.body['config'] as Record<string, unknown>;
    assert.ok(config['words'] !== undefined, 'the shell carries the words');
    assert.ok(config['modules'] !== undefined, 'and which modules are on');

    const badges = res.body['badges'] as Record<string, number>;
    assert.equal(badges['orders'], 2, 'two orders are pending');
    assert.equal(badges['complaints'], 1, 'one complaint is open');
    assert.equal(badges['reviews'], 1, 'one review has no reply yet');
  });

  it('gives a manager the shell, without wallet.read in it', async () => {
    const res = await call(api, 'GET', shellPath, { token: manager() });
    assert.equal(res.status, 200);
    const me = res.body['me'] as Record<string, unknown>;
    assert.equal(me['role'], 'manager');
    assert.equal((me['permissions'] as string[]).includes('wallet.read'), false);
    // The frame still loads, which is the point: a shell guarded by more than the lowest console permission
    // would be a console a manager could not draw.
    assert.ok((res.body['store'] as Record<string, unknown>)['name']);
  });

  it('refuses a store the signed-in person does not work at, and anybody not signed in', async () => {
    const other = await call(api, 'GET', `/api/stores/${STORE.b}/shell`, { token: owner() });
    assert.equal(other.status, 403);

    const anonymous = await call(api, 'GET', shellPath);
    assert.equal(anonymous.status, 401);
  });

  it("clears the Reviews badge when the merchant's reply lands", async () => {
    await sql(
      `INSERT INTO review_replies (review_id, store_id, author_id, body)
            VALUES ($1, $2, $3, 'Thank you!')`,
      [CONSOLE.review, STORE.a, USER.ownerA],
    );
    const res = await call(api, 'GET', shellPath, { token: owner() });
    assert.equal((res.body['badges'] as Record<string, number>)['reviews'], 0);

    // Put it back: every other assertion in this file counts from the seeded state.
    await sql(`DELETE FROM review_replies WHERE review_id = $1`, [CONSOLE.review]);
  });
});

describe('the dashboard', () => {
  it('answers the whole screen in one request', async () => {
    const res = await call(api, 'GET', dashPath, { token: owner() });
    assert.equal(res.status, 200);

    const counts = res.body['counts'] as Record<string, unknown>;
    assert.equal(counts['ordersWaiting'], 2);
    assert.equal(counts['acceptingOrders'], true);
    // seedStorefront opens the shop 00:00–23:59 every day, so this does not depend on when the suite runs.
    assert.equal(counts['isOpen'], true);
    assert.equal(typeof counts['localDate'], 'string');

    const sales = res.body['sales'] as Record<string, unknown>;
    assert.ok(sales !== null, 'an owner holds wallet.read, so the money is there');
    assert.equal(typeof sales['salesToday'], 'string');

    assert.equal((res.body['week'] as unknown[]).length, 7, 'seven days, always');

    // Oldest first: the queue is a work list, and the customer who has waited longest is at the top.
    const queue = res.body['needsAttention'] as Record<string, unknown>[];
    assert.equal(queue.length, 2);
    assert.equal(queue[0]?.['orderNumber'], 9002);

    const recent = res.body['recent'] as Record<string, unknown>[];
    assert.ok(recent.length >= 3, 'the table shows the newest orders whatever their status');
    assert.ok(recent.some((r) => r['status'] === 'approved'));

    // The phone's one warning names a product. seedStorefront's cap is tracked and under its threshold.
    const lowest = res.body['lowestStock'] as Record<string, unknown> | null;
    assert.ok(lowest !== null && typeof lowest['productName'] === 'string');
  });

  it('omits the money for a role without wallet.read, and keeps everything else', async () => {
    const res = await call(api, 'GET', dashPath, { token: manager() });
    assert.equal(res.status, 200);
    assert.equal(res.body['sales'], null);
    assert.equal(res.body['week'], null);
    // A manager's dashboard is a complete dashboard of the things a manager does.
    assert.equal((res.body['counts'] as Record<string, unknown>)['ordersWaiting'], 2);
    assert.equal((res.body['needsAttention'] as unknown[]).length, 2);
  });
});

describe('pausing new orders', () => {
  it('is the manager\'s to press — it is an operational decision, not a setting', async () => {
    const paused = await call(api, 'PUT', `${dashPath}/accepting`, {
      token: manager(),
      body: { accepting: false },
    });
    assert.equal(paused.status, 200);
    assert.equal(paused.body['acceptingOrders'], false);
  });

  it('stops checkout with a sentence a customer can act on, and leaves the shopfront alone', async () => {
    // The shop is still a shop: pausing is not closing, and a customer browsing should see the menu.
    const browse = await call(api, 'GET', `/api/storefront/${SLUG}/products?limit=2`);
    assert.equal(browse.status, 200);
    assert.ok((browse.body['products'] as unknown[]).length > 0);

    // A cart, then an attempt to check out. The cart itself is unaffected — only placing the order is refused.
    const shopper: Api = { ...api, cookies: new Map() };
    await call(shopper, 'GET', `/api/storefront/${SLUG}/cart`);
    const added = await call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, {
      body: { variantId: JUICE_VARIANT, quantity: 1 },
    });
    // 201: adding a line to a cart creates one. The cart endpoint's own suite pins that; here it only has to work.
    assert.equal(added.status, 201);

    const placed = await call(shopper, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: {
        idempotencyKey: 'console-paused-attempt-0001',
        fulfilment: 'pickup',
        paymentMethod: 'cash',
        expectedTotal: '1200',
        name: 'A Buyer',
        phone: '078 000 0009',
      },
    });
    assert.equal(placed.status, 409);
    assert.equal(placed.body['code'], 'STALE_CATALOGUE');
    // V021 raises with the store's NAME in it, and VLCAT passes the message and hint through untouched.
    assert.match(String(placed.body['error']), /paused new orders/);
    assert.ok(String(placed.body['hint']).length > 0, 'and tells them what to do instead');
  });

  it('goes back, and a rider was never allowed to touch it', async () => {
    const refused = await call(api, 'PUT', `${dashPath}/accepting`, {
      token: rider(),
      body: { accepting: true },
    });
    assert.equal(refused.status, 403);

    const back = await call(api, 'PUT', `${dashPath}/accepting`, {
      token: owner(),
      body: { accepting: true },
    });
    assert.equal(back.status, 200);
    assert.equal(back.body['acceptingOrders'], true);
  });

  it('refuses a body that does not say which way', async () => {
    const bad = await call(api, 'PUT', `${dashPath}/accepting`, { token: owner(), body: { accepting: 'yes' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body['code'], 'MISSING_FIELD');
  });
});

describe('the notifications panel', () => {
  it('gives the owner every kind, and the manager one fewer', async () => {
    const mine = await call(api, 'GET', notifyPath, { token: owner() });
    assert.equal(mine.status, 200);
    const types = (mine.body['notifications'] as Record<string, unknown>[]).map((n) => n['type']);
    assert.ok(types.includes('identity_verified'), 'an owner sees the money-side notification');
    assert.equal(mine.body['unread'], 3);

    const theirs = await call(api, 'GET', notifyPath, { token: manager() });
    const managerTypes = (theirs.body['notifications'] as Record<string, unknown>[]).map((n) => n['type']);
    // NOT FILTERED BY THE ENDPOINT. V010's visible_to_roles is what excludes it, so the rule holds for every
    // caller of notification_inbox() rather than for the ones that remembered.
    assert.equal(managerTypes.includes('identity_verified'), false, 'a manager does not');
    assert.equal(theirs.body['unread'], 2);
  });

  it('carries the values the sentence needs, and never the sentence', async () => {
    const res = await call(api, 'GET', notifyPath, { token: owner() });
    const placed = (res.body['notifications'] as Record<string, unknown>[]).find((n) => n['type'] === 'order_placed');
    assert.ok(placed !== undefined);
    const payload = placed['payload'] as Record<string, unknown>;
    assert.equal(payload['order_number'], 9002);
    assert.equal(payload['customer_name'], 'Aimable K.');
    // The tone and the destination come from the type, so the client needs neither a colour table nor a router.
    assert.equal(placed['tone'], 'info');
    assert.equal(placed['route'], '/app/orders');
  });

  it('marks one read, then all of them, and the count follows', async () => {
    const before = await call(api, 'GET', notifyPath, { token: owner() });
    const first = (before.body['notifications'] as Record<string, unknown>[])[0];
    const id = String(first?.['id']);

    const read = await call(api, 'POST', `${notifyPath}/${id}/read`, { token: owner() });
    assert.equal(read.status, 200);
    assert.equal(read.body['unread'], 2);

    // Reading it twice is not an error: a merchant who taps the same row twice has not done anything wrong.
    const again = await call(api, 'POST', `${notifyPath}/${id}/read`, { token: owner() });
    assert.equal(again.status, 200);
    assert.equal(again.body['unread'], 2);

    const unreadOnly = await call(api, 'GET', `${notifyPath}?unread=true`, { token: owner() });
    assert.equal((unreadOnly.body['notifications'] as unknown[]).length, 2);

    const all = await call(api, 'POST', `${notifyPath}/read-all`, { token: owner() });
    assert.equal(all.body['unread'], 0);

    // The manager's own count is untouched by the owner reading theirs: the read state is per person.
    const theirs = await call(api, 'GET', notifyPath, { token: manager() });
    assert.equal(theirs.body['unread'], 2);
  });

  it("refuses a notification that is not in the reader's inbox", async () => {
    const res = await call(api, 'POST', `${notifyPath}/${CONSOLE.oldestPending}/read`, { token: owner() });
    // A guessed id reveals nothing about whether it exists — V010 raises, and the route turns that into a 404.
    assert.equal(res.status, 404);

    const nonsense = await call(api, 'POST', `${notifyPath}/not-a-uuid/read`, { token: owner() });
    assert.equal(nonsense.status, 400);
  });

  it('refuses half a cursor, because V010\'s cursor is the pair', async () => {
    const half = await call(api, 'GET', `${notifyPath}?before=2026-09-27T00:00:00Z`, { token: owner() });
    assert.equal(half.status, 400);
    assert.equal(half.body['code'], 'INVALID_CURSOR');
  });
});

describe('the new-order alert', () => {
  it('is the order that has been waiting longest, not the newest', async () => {
    const res = await call(api, 'GET', `${notifyPath}/alert`, { token: owner() });
    assert.equal(res.status, 200);
    const alert = res.body['alert'] as Record<string, unknown>;
    assert.equal(alert['orderNumber'], 9002, 'the 30-minute-old one, not the 2-minute-old one');
    // Counted from the order's placed_at, so a reload shows the customer's wait rather than the tab's age.
    assert.ok(Number(alert['waitingSeconds']) > 1500);
    assert.equal(alert['customer'], 'Aimable Kayitare');
  });

  it('is the same answer for everybody at the store — that is what "every screen" means', async () => {
    const mine = await call(api, 'GET', `${notifyPath}/alert`, { token: owner() });
    const theirs = await call(api, 'GET', `${notifyPath}/alert`, { token: manager() });
    assert.equal(
      (mine.body['alert'] as Record<string, unknown>)['orderId'],
      (theirs.body['alert'] as Record<string, unknown>)['orderId'],
    );
  });

  it('turns the chime off for THIS device and leaves the next one alone', async () => {
    const off = await call(api, 'PUT', `${notifyPath}/sound`, { token: owner(), body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body['sound'], false);

    const check = await call(api, 'GET', `${notifyPath}/alert`, { token: owner() });
    assert.equal(check.body['sound'], false);

    // A second browser, same person, same store. It has never been told to be quiet.
    const otherDevice: Api = { ...api, cookies: new Map() };
    await call(otherDevice, 'GET', shellPath, { token: owner() });
    const second = await call(otherDevice, 'GET', `${notifyPath}/alert`, { token: owner() });
    assert.equal(second.body['sound'], true, 'sound is per device, as the board says in as many words');

    const on = await call(api, 'PUT', `${notifyPath}/sound`, { token: owner(), body: { enabled: true } });
    assert.equal(on.body['sound'], true);
  });
});

describe('accepting an order', () => {
  const accept = (orderId: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> =>
    call(api, 'POST', `/api/stores/${STORE.a}/orders/${orderId}/accept`, { token });

  it('moves it to approved, and says so once', async () => {
    const first = await accept(CONSOLE.newestPending, manager());
    assert.equal(first.status, 200);
    assert.equal(first.body['status'], 'approved');
    assert.equal(first.body['accepted'], true);
    assert.equal(first.body['orderNumber'], 9003);

    // V004's history has the move, with who made it — which is the audit a refund is argued from.
    const { rows } = await sql<{ from_status: string; to_status: string; actor_id: string }>(
      `SELECT from_status, to_status, actor_id FROM order_events WHERE order_id = $1`,
      [CONSOLE.newestPending],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.from_status, 'pending');
    assert.equal(rows[0]?.to_status, 'approved');
    assert.equal(rows[0]?.actor_id, USER.managerA);
  });

  it('tells the second person it worked, because it did', async () => {
    const again = await accept(CONSOLE.newestPending, owner());
    assert.equal(again.status, 200);
    assert.equal(again.body['status'], 'approved');
    // The difference between "you accepted it" and "it is accepted" — the toast says which.
    assert.equal(again.body['accepted'], false);

    // And no second event: the history records what happened, and nothing happened.
    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM order_events WHERE order_id = $1`,
      [CONSOLE.newestPending],
    );
    assert.equal(rows[0]?.n, '1');
  });

  it('will not quietly accept something already declined', async () => {
    // Declined through the status machine rather than written in place, so the trigger sees a legal move.
    await sql(`UPDATE orders SET status = 'rejected' WHERE id = $1`, [CONSOLE.oldestPending]);

    const res = await accept(CONSOLE.oldestPending, owner());
    assert.equal(res.status, 409);
    assert.equal(res.body['code'], 'ORDER_ALREADY_DECIDED');
    assert.match(String(res.body['error']), /already declined/);
    assert.ok(String(res.body['hint']).includes('Orders'));
  });

  it('cannot reach an order at another store, or be pressed by a rider', async () => {
    const elsewhere = await call(api, 'POST', `/api/stores/${STORE.b}/orders/${CATALOGUE.order}/accept`, {
      token: tokenFor(USER.adminB),
    });
    // An order id from another store must look exactly like an order id that does not exist.
    assert.equal(elsewhere.status, 404);

    const byRider = await accept(CATALOGUE.order, rider());
    assert.equal(byRider.status, 403);

    const nonsense = await accept('not-a-uuid', owner());
    assert.equal(nonsense.status, 400);
  });

  it('and the alert is empty once nothing is waiting', async () => {
    const res = await call(api, 'GET', `${notifyPath}/alert`, { token: owner() });
    assert.equal(res.body['alert'], null);

    const dash = await call(api, 'GET', dashPath, { token: owner() });
    assert.equal((dash.body['counts'] as Record<string, unknown>)['ordersWaiting'], 0);

    // And the sidebar's Orders badge with it — the same figure, read by the shell every console screen loads.
    const shell = await call(api, 'GET', shellPath, { token: owner() });
    assert.equal((shell.body['badges'] as Record<string, number>)['orders'], 0);
  });
});
