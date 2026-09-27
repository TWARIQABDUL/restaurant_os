// server/test/api/account.test.ts — milestone 18.
//
// The customer's own account, over HTTP. Four things are worth testing and the rest follows from them:
//
//   1. THE CART SURVIVES SIGNING IN. The sheet promises it in as many words, and the interesting case is when
//      BOTH carts exist — the same product with the same options must add up rather than become two lines.
//   2. A GUEST KEEPS THE ORDER THEY JUST PLACED, and the tracking code is the only thing that proves the offer
//      is theirs. Without requiring it this endpoint would hand any guest order to anybody.
//   3. ONE ACCOUNT PER STORE. The same email at two stores is two accounts with two passwords, which is V001's
//      whole shape and the board's own sentence.
//   4. REORDERING ADDS WHAT IT CAN AND SAYS WHAT IT COULD NOT.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { CATALOGUE, STORE, USER, cleanup, seedFixtures, seedStorefront } from './support.ts';

let api: Api;
const SLUG = 'escalation-store-a';
const OTHER = 'escalation-store-b';

const JUICE_VARIANT = 'eeeeeeee-0000-4000-8000-000000000310';
const BURGER_VARIANT = 'eeeeeeee-0000-4000-8000-000000000311';
const CHEESE = 'eeeeeeee-0000-4000-8000-000000000220';

let zoneNear = '';

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  const { rows } = await sql<{ id: string }>(
    `SELECT id FROM delivery_zones WHERE store_id = $1 ORDER BY fee_amount LIMIT 1`,
    [STORE.a],
  );
  zoneNear = rows[0]?.id ?? '';
  // Store A's automatic 10% is switched off for this file: every assertion here is about accounts and carts,
  // and a discount in the middle of the arithmetic makes the numbers harder to read without testing anything
  // the checkout suite does not already cover.
  await sql(`UPDATE promotions SET is_active = false WHERE store_id = $1`, [STORE.a]);
});

after(async () => {
  await sql(`UPDATE promotions SET is_active = true WHERE store_id = $1`, [STORE.a]);
  await cleanup();
  await api.close();
  await closePool();
});

async function shopper(): Promise<Api> {
  return boot();
}

async function add(who: Api, variantId: string, quantity = 1, options: string[] = []): Promise<void> {
  const reply = await call(who, 'POST', `/api/storefront/${SLUG}/cart/items`, {
    body: { variantId, optionValueIds: options, quantity },
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
}

let seq = 0;
function uniqueEmail(): string {
  seq += 1;
  return `customer-${Date.now()}-${seq}@escalation.test`;
}

/** A cash order, placed as a guest, returning its tracking code. */
async function placeAsGuest(who: Api): Promise<{ code: string; orderNumber: number }> {
  const quote = await call(who, 'GET', `/api/storefront/${SLUG}/checkout?fulfilment=delivery&zone=${zoneNear}`);
  const total = (quote.body['quote'] as Record<string, unknown>)['total'];
  const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
    body: {
      idempotencyKey: `account-test-${Date.now()}-${(seq += 1)}`,
      fulfilment: 'delivery',
      paymentMethod: 'cash',
      expectedTotal: String(total),
      name: 'Guest Buyer',
      phone: '078 000 0009',
      address: 'KG 1 Ave, Kigali',
      zone: zoneNear,
    },
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const order = placed.body['order'] as Record<string, unknown>;
  return { code: String(order['trackingCode']), orderNumber: Number(order['orderNumber']) };
}

// ---------------------------------------------------------------------------
describe('signing in keeps the cart', () => {
  it('moves an anonymous cart onto an account that has none', async () => {
    const who = await shopper();
    await add(who, BURGER_VARIANT, 2, [CHEESE]);

    const claimed = await call(who, 'POST', `/api/storefront/${SLUG}/cart/claim`, {
      token: tokenFor(USER.customerA),
    });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const cart = claimed.body['cart'] as Record<string, unknown>;
    assert.equal(cart['itemCount'], 2, 'the bag came with them');

    // And it is now the ACCOUNT's, reachable from a different browser with the same session.
    const elsewhere = await shopper();
    const read = await call(elsewhere, 'GET', `/api/storefront/${SLUG}/cart`, {
      token: tokenFor(USER.customerA),
    });
    assert.equal((read.body['cart'] as Record<string, unknown>)['itemCount'], 2);

    await sql(`DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id = $1)`, [
      USER.customerA,
    ]);
    await who.close();
    await elsewhere.close();
  });

  it('ADDS UP when both carts hold the same product with the same options', async () => {
    // The case the whole function exists for. One of each would be easy; the same choice in both is where a
    // naive move produces two lines of one burger.
    const account = await shopper();
    await call(account, 'POST', `/api/storefront/${SLUG}/cart/items`, {
      token: tokenFor(USER.customerA),
      body: { variantId: BURGER_VARIANT, optionValueIds: [CHEESE], quantity: 1 },
    });

    const anonymous = await shopper();
    await add(anonymous, BURGER_VARIANT, 2, [CHEESE]);
    await add(anonymous, JUICE_VARIANT, 1);

    const claimed = await call(anonymous, 'POST', `/api/storefront/${SLUG}/cart/claim`, {
      token: tokenFor(USER.customerA),
    });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

    const cart = claimed.body['cart'] as Record<string, unknown>;
    const lines = cart['lines'] as Record<string, unknown>[];
    assert.equal(lines.length, 2, 'two lines, not three');
    const burger = lines.find((l) => l['productName'] === 'Chicken Burger');
    assert.equal(burger?.['quantity'], 3, '1 in the account plus 2 anonymous');
    assert.equal(cart['itemCount'], 4);
    assert.deepEqual(claimed.body['merged'], { lines: 1, quantities: 1 }, 'one line moved, one merged');

    // The anonymous cart is gone: signing out must not produce a cart from before signing in.
    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM carts WHERE store_id = $1 AND anonymous_session_id IS NOT NULL`,
      [STORE.a],
    );
    assert.equal(rows[0]?.n, '0');

    await sql(`DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id = $1)`, [
      USER.customerA,
    ]);
    await account.close();
    await anonymous.close();
  });

  it('is idempotent: claiming twice moves nothing the second time', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);

    const first = await call(who, 'POST', `/api/storefront/${SLUG}/cart/claim`, {
      token: tokenFor(USER.customerA),
    });
    const second = await call(who, 'POST', `/api/storefront/${SLUG}/cart/claim`, {
      token: tokenFor(USER.customerA),
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((second.body['cart'] as Record<string, unknown>)['itemCount'], 1, 'not doubled');
    assert.deepEqual(second.body['merged'], { lines: 0, quantities: 0 });

    await sql(`DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id = $1)`, [
      USER.customerA,
    ]);
    await who.close();
  });

  it('refuses a session that is not a customer of this store', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);

    // A merchant's own staff session. Their cart is not a customer's cart.
    const staff = await call(who, 'POST', `/api/storefront/${SLUG}/cart/claim`, {
      token: tokenFor(USER.ownerA),
    });
    assert.equal(staff.status, 403);
    assert.equal(staff.body['code'], 'NOT_A_CUSTOMER');

    // And a customer of store A cannot claim a cart at store B.
    const wrongStore = await call(who, 'POST', `/api/storefront/${OTHER}/cart/claim`, {
      token: tokenFor(USER.customerA),
    });
    assert.equal(wrongStore.status, 403);
    await who.close();
  });
});

// ---------------------------------------------------------------------------
describe('a guest becomes a customer', () => {
  it('keeps the order, saves the address and is signed in', async () => {
    const who = await shopper();
    await add(who, BURGER_VARIANT, 1);
    const placed = await placeAsGuest(who);

    const email = uniqueEmail();
    const created = await call(who, 'POST', `/api/storefront/${SLUG}/account/claim-order`, {
      body: {
        trackingCode: placed.code,
        name: 'Didier Ndayisaba',
        email,
        phone: '078 707 1188',
        password: 'verygoodpass9',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body['claimed'], placed.orderNumber);

    // Signed in on the password they just chose — the response set a session cookie, which the client jar now
    // holds, so the account reads without a second sign-in.
    const account = await call(who, 'GET', `/api/storefront/${SLUG}/account`);
    assert.equal(account.status, 200, JSON.stringify(account.body));
    const orders = account.body['orders'] as Record<string, unknown>[];
    assert.equal(orders.length, 1, 'the order they just placed is theirs now');
    assert.equal(orders[0]?.['orderNumber'], placed.orderNumber);

    const addresses = account.body['addresses'] as Record<string, unknown>[];
    assert.equal(addresses.length, 1, 'and the address they typed was saved');
    assert.equal(addresses[0]?.['address'], 'KG 1 Ave, Kigali');
    assert.equal(addresses[0]?.['isDefault'], true, 'the first address is the default, or checkout has none');

    // The order is no longer a guest order: orders_has_a_customer allows one or the other, never both.
    const { rows } = await sql<{ guest_name: string | null; customer_user_id: string | null }>(
      `SELECT guest_name, customer_user_id FROM orders WHERE tracking_code = $1`,
      [placed.code],
    );
    assert.equal(rows[0]?.guest_name, null);
    assert.notEqual(rows[0]?.customer_user_id, null);
    await who.close();
  });

  it('needs the tracking code, which is the only thing a guest holds', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    await placeAsGuest(who);

    const guessed = await call(who, 'POST', `/api/storefront/${SLUG}/account/claim-order`, {
      body: {
        trackingCode: 'trk_not_a_real_code',
        name: 'Somebody Else',
        email: uniqueEmail(),
        password: 'verygoodpass9',
      },
    });
    assert.equal(guessed.status, 404, 'no order, no account');
    assert.equal(guessed.body['code'], 'NO_SUCH_ORDER');

    // And nothing was created: a failed claim must not leave an account behind.
    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM users WHERE email = $1`,
      ['somebody else'],
    );
    assert.equal(rows[0]?.n, '0');
    await who.close();
  });

  it('refuses a weak password with the rule that failed', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const placed = await placeAsGuest(who);

    for (const [password, expected] of [
      ['short1', 'At least 8 characters'],
      ['nodigitshere', 'Includes a number'],
      // The store is "Escalation Store A", so a password built from its name is refused.
      ['escalation1', 'Not your phone number or store name'],
    ] as const) {
      const refused = await call(who, 'POST', `/api/storefront/${SLUG}/account/claim-order`, {
        body: { trackingCode: placed.code, name: 'A Buyer', email: uniqueEmail(), password },
      });
      assert.equal(refused.status, 400, password);
      assert.equal(refused.body['code'], 'WEAK_PASSWORD');
      assert.equal(refused.body['error'], expected, `"${password}" fails on: ${expected}`);
    }
    await who.close();
  });

  it('will not quietly attach to an email that already has an account here', async () => {
    // Milestone 11's decision, applied to customers: attaching would hand the caller somebody else's saved
    // addresses and order history on the strength of knowing their email.
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const placed = await placeAsGuest(who);

    const { rows } = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [USER.customerA]);
    const taken = rows[0]?.email ?? '';

    const refused = await call(who, 'POST', `/api/storefront/${SLUG}/account/claim-order`, {
      body: { trackingCode: placed.code, name: 'Impostor', email: taken, password: 'verygoodpass9' },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body['code'], 'ACCOUNT_EXISTS');
    assert.match(String(refused.body['error']), /Sign in instead/);
    await who.close();
  });
});

// ---------------------------------------------------------------------------
describe('one account per store', () => {
  it('the same email is a separate account at each store', async () => {
    const email = uniqueEmail();

    const atA = await shopper();
    await add(atA, JUICE_VARIANT, 1);
    const a = await call(atA, 'POST', `/api/storefront/${SLUG}/account`, {
      body: { name: 'Two Shops', email, password: 'verygoodpass9' },
    });
    assert.equal(a.status, 201, JSON.stringify(a.body));

    // Store B connected nothing to sell, but an account there is still an account.
    const atB = await shopper();
    const b = await call(atB, 'POST', `/api/storefront/${OTHER}/account`, {
      body: { name: 'Two Shops', email, password: 'verygoodpass9' },
    });
    assert.equal(b.status, 201, 'the same email again, at another store');
    assert.notEqual(
      (a.body['customer'] as Record<string, unknown>)['id'],
      (b.body['customer'] as Record<string, unknown>)['id'],
      'two accounts, not one — V001 makes email unique WITHIN a store',
    );

    // A second account at the SAME store is refused.
    const again = await call(atA, 'POST', `/api/storefront/${SLUG}/account`, {
      body: { name: 'Two Shops', email, password: 'verygoodpass9' },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body['code'], 'ACCOUNT_EXISTS');

    await atA.close();
    await atB.close();
  });

  it('brings the cart with it when it is created mid-checkout', async () => {
    const who = await shopper();
    await add(who, BURGER_VARIANT, 2, [CHEESE]);

    const created = await call(who, 'POST', `/api/storefront/${SLUG}/account`, {
      body: { name: 'Mid Checkout', email: uniqueEmail(), password: 'verygoodpass9' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const cart = created.body['cart'] as Record<string, unknown> | null;
    assert.notEqual(cart, null, 'the anonymous cart came with them');
    assert.equal(cart?.['itemCount'], 2);
    await who.close();
  });

  it('a staff identity cannot reach a customer account', async () => {
    const who = await shopper();
    const refused = await call(who, 'GET', `/api/storefront/${SLUG}/account`, {
      token: tokenFor(USER.ownerA),
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body['code'], 'NOT_A_CUSTOMER');
    await who.close();
  });

  it('an anonymous visitor is told to sign in rather than shown an empty account', async () => {
    const who = await shopper();
    const refused = await call(who, 'GET', `/api/storefront/${SLUG}/account`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body['code'], 'NOT_A_CUSTOMER');
    await who.close();
  });
});

// ---------------------------------------------------------------------------
describe('saved addresses', () => {
  it('saves one, makes another the default, and never has two defaults', async () => {
    const who = await shopper();
    const token = tokenFor(USER.customerA);

    const home = await call(who, 'POST', `/api/storefront/${SLUG}/account/addresses`, {
      token,
      body: { label: 'Home', address: 'KG 541 St, house 12, Kacyiru' },
    });
    assert.equal(home.status, 201, JSON.stringify(home.body));
    assert.equal((home.body['address'] as Record<string, unknown>)['isDefault'], true, 'the first is default');

    const office = await call(who, 'POST', `/api/storefront/${SLUG}/account/addresses`, {
      token,
      body: { label: 'Office', address: 'KN 5 Rd, Remera, 3rd floor' },
    });
    assert.equal(office.status, 201);
    assert.equal(
      (office.body['address'] as Record<string, unknown>)['isDefault'],
      false,
      'the second is not, or the index would refuse it',
    );

    const officeId = (office.body['address'] as Record<string, unknown>)['id'];
    const switched = await call(
      who,
      'PUT',
      `/api/storefront/${SLUG}/account/addresses/${String(officeId)}/default`,
      { token },
    );
    assert.equal(switched.status, 200);
    const addresses = switched.body['addresses'] as Record<string, unknown>[];
    assert.equal(addresses.filter((a) => a['isDefault'] === true).length, 1, 'exactly one default, always');
    assert.equal(addresses[0]?.['label'], 'Office', 'and the default sorts first, which is what checkout offers');

    const duplicate = await call(who, 'POST', `/api/storefront/${SLUG}/account/addresses`, {
      token,
      body: { label: 'home', address: 'Somewhere else' },
    });
    assert.equal(duplicate.status, 409, 'two addresses called Home is a list the board cannot render');
    assert.equal(duplicate.body['code'], 'LABEL_TAKEN');

    await sql(`DELETE FROM customer_addresses WHERE user_id = $1`, [USER.customerA]);
    await who.close();
  });

  it('cannot touch somebody else’s address', async () => {
    const who = await shopper();
    const mine = await call(who, 'POST', `/api/storefront/${SLUG}/account/addresses`, {
      token: tokenFor(USER.customerA),
      body: { label: 'Home', address: 'KG 541 St, house 12' },
    });
    const id = (mine.body['address'] as Record<string, unknown>)['id'];

    // A second customer at the same store.
    const { rows } = await sql<{ id: string }>(
      `INSERT INTO users (scope, store_id, email, name, password_hash)
            VALUES ('store', $1, $2, 'Another Customer', '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar')
         RETURNING id`,
      [STORE.a, `another-${Date.now()}@escalation.test`],
    );

    const refused = await call(
      who,
      'PUT',
      `/api/storefront/${SLUG}/account/addresses/${String(id)}/default`,
      { token: tokenFor(rows[0]?.id ?? '') },
    );
    assert.equal(refused.status, 404, 'an address id is not an access rule');

    await sql(`DELETE FROM customer_addresses WHERE user_id = $1`, [USER.customerA]);
    await who.close();
  });

  it('a member of staff cannot save one at all', async () => {
    // V020's trigger, not this route: "Staff and the Vendlyfy team have no shopfront to be delivered to."
    const who = await shopper();
    const refused = await call(who, 'POST', `/api/storefront/${SLUG}/account/addresses`, {
      token: tokenFor(USER.ownerA),
      body: { label: 'Home', address: 'KG 1 Ave' },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body['code'], 'NOT_A_CUSTOMER');
    await who.close();
  });
});

// ---------------------------------------------------------------------------
describe('ordering it again', () => {
  it('adds every line at today’s prices', async () => {
    const who = await shopper();
    await add(who, BURGER_VARIANT, 2, [CHEESE]);
    await add(who, JUICE_VARIANT, 1);
    const placed = await placeAsGuest(who);

    // The merchant puts the juice up afterwards.
    await sql(`UPDATE products SET base_price = 1500 WHERE id = $1`, [CATALOGUE.juice]);

    const reordered = await call(who, 'POST', `/api/storefront/${SLUG}/orders/${placed.code}/reorder`);
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
    assert.equal(reordered.body['added'], 2);
    assert.equal(reordered.body['skipped'], 0);

    const cart = reordered.body['cart'] as Record<string, unknown>;
    const lines = cart['lines'] as Record<string, unknown>[];
    const juice = lines.find((l) => l['productName'] === 'Passion Juice');
    assert.equal(juice?.['unitPrice'], '1500.00', "today's price, not the one on the receipt");

    await sql(`UPDATE products SET base_price = 1200 WHERE id = $1`, [CATALOGUE.juice]);
    await who.close();
  });

  it('adds what it can and names what it cannot', async () => {
    // The board's own sentence: "Added 1 of 2 items. Fries are sold out today."
    const who = await shopper();
    await add(who, BURGER_VARIANT, 1);
    await add(who, JUICE_VARIANT, 1);
    const placed = await placeAsGuest(who);

    await sql(`UPDATE product_variants SET is_available = false WHERE id = $1`, [JUICE_VARIANT]);

    const reordered = await call(who, 'POST', `/api/storefront/${SLUG}/orders/${placed.code}/reorder`);
    assert.equal(reordered.status, 200);
    assert.equal(reordered.body['added'], 1);
    assert.equal(reordered.body['skipped'], 1);
    assert.deepEqual(reordered.body['skippedNames'], ['Passion Juice']);

    await sql(`UPDATE product_variants SET is_available = true WHERE id = $1`, [JUICE_VARIANT]);
    await who.close();
  });

  it('merges into what is already in the cart rather than duplicating', async () => {
    const who = await shopper();
    await add(who, BURGER_VARIANT, 1);
    const placed = await placeAsGuest(who);

    await add(who, BURGER_VARIANT, 1);
    const reordered = await call(who, 'POST', `/api/storefront/${SLUG}/orders/${placed.code}/reorder`);
    const cart = reordered.body['cart'] as Record<string, unknown>;
    assert.equal((cart['lines'] as unknown[]).length, 1, 'one line');
    assert.equal(cart['itemCount'], 2, 'two of it — reorder goes through add_to_cart()');
    await who.close();
  });

  it('cannot reorder another store’s order', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const placed = await placeAsGuest(who);

    const refused = await call(who, 'POST', `/api/storefront/${OTHER}/orders/${placed.code}/reorder`);
    assert.equal(refused.status, 404);
    await who.close();
  });
});

// ---------------------------------------------------------------------------
describe('telling the store something went wrong', () => {
  let code = '';
  let token = '';

  before(async () => {
    // A delivered order belonging to customer A, which is what a complaint needs behind it.
    const { rows } = await sql<{ tracking_code: string }>(
      `SELECT tracking_code FROM orders
        WHERE store_id = $1 AND customer_user_id = $2 AND status = 'delivered' LIMIT 1`,
      [STORE.a, USER.customerA],
    );
    if (rows[0] === undefined) {
      // The storefront fixtures give customer A one delivered order; if that changes, say so rather than
      // silently testing nothing.
      throw new Error('no delivered order for customer A — seedStorefront() is meant to create one');
    }
    code = rows[0].tracking_code;
    token = tokenFor(USER.customerA);
  });

  it('files one, and the account shows it with the store’s reply', async () => {
    const filed = await call(api, 'POST', `/api/storefront/${SLUG}/orders/${code}/complaints`, {
      token,
      body: { reason: 'arrived_late', detail: 'It arrived cold and an hour late.' },
    });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    const complaints = filed.body['complaints'] as Record<string, unknown>[];
    assert.equal(complaints[0]?.['status'], 'open');
    assert.equal(complaints[0]?.['canReopen'], false, 'an open complaint has nothing to reopen');
    assert.equal(typeof complaints[0]?.['reference'], 'number', 'the board’s "C-044"');

    const complaintId = String(complaints[0]?.['id']);

    // The store answers it.
    await sql(`SELECT resolve_complaint($1, $2, $3)`, [
      complaintId,
      USER.ownerA,
      'Sorry, a rider fell ill. Next order’s delivery is on us.',
    ]);

    const account = await call(api, 'GET', `/api/storefront/${SLUG}/account`, { token });
    const mine = (account.body['complaints'] as Record<string, unknown>[])[0];
    assert.equal(mine?.['status'], 'resolved');
    assert.match(String(mine?.['storeReply']), /a rider fell ill/, 'the reply comes from the event thread');
    assert.equal(mine?.['canReopen'], true, '"Not sorted? Reopen" appears');
  });

  it('reopens it, and counts that it was reopened', async () => {
    const account = await call(api, 'GET', `/api/storefront/${SLUG}/account`, { token });
    const complaint = (account.body['complaints'] as Record<string, unknown>[])[0];
    const id = String(complaint?.['id']);

    const reopened = await call(api, 'POST', `/api/storefront/${SLUG}/account/complaints/${id}/reopen`, {
      token,
      body: { note: 'Still not sorted.' },
    });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    const mine = (reopened.body['complaints'] as Record<string, unknown>[])[0];
    assert.equal(mine?.['status'], 'open');
    assert.equal(mine?.['reopenedCount'], 1, 'counted, which is how the badge says "Reopened"');
    assert.equal(mine?.['canReopen'], false, 'and it cannot be reopened again while it is open');

    const again = await call(api, 'POST', `/api/storefront/${SLUG}/account/complaints/${id}/reopen`, {
      token,
    });
    assert.equal(again.status, 409);
    assert.equal(again.body['code'], 'ALREADY_OPEN');
  });

  it('refuses a reason that is not one of the five', async () => {
    const refused = await call(api, 'POST', `/api/storefront/${SLUG}/orders/${code}/complaints`, {
      token,
      body: { reason: 'i_just_dont_like_it', detail: 'Nope.' },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body['code'], 'INVALID_REASON');
  });

  it('refuses an empty description, because a complaint needs their own words', async () => {
    const refused = await call(api, 'POST', `/api/storefront/${SLUG}/orders/${code}/complaints`, {
      token,
      body: { reason: 'other', detail: '   ' },
    });
    assert.equal(refused.status, 400);
  });

  it('needs an account: a guest has nobody to attach a complaint to', async () => {
    const who = await shopper();
    const refused = await call(who, 'POST', `/api/storefront/${SLUG}/orders/${code}/complaints`, {
      body: { reason: 'other', detail: 'Something happened.' },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body['code'], 'NOT_A_CUSTOMER');
    await who.close();
  });

  it('cannot reopen a complaint that is not theirs', async () => {
    const account = await call(api, 'GET', `/api/storefront/${SLUG}/account`, { token });
    const id = String((account.body['complaints'] as Record<string, unknown>[])[0]?.['id']);

    const { rows } = await sql<{ id: string }>(
      `INSERT INTO users (scope, store_id, email, name, password_hash)
            VALUES ('store', $1, $2, 'Nosy Customer', '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar')
         RETURNING id`,
      [STORE.a, `nosy-${Date.now()}@escalation.test`],
    );

    const refused = await call(api, 'POST', `/api/storefront/${SLUG}/account/complaints/${id}/reopen`, {
      token: tokenFor(rows[0]?.id ?? ''),
    });
    assert.equal(refused.status, 404, 'a complaint id is not an access rule');
  });
});
