// server/test/api/checkout.test.ts — milestone 17.
//
// Checkout, over HTTP, against a real catalogue. This is the money path, so the tests are about the four ways
// it can go wrong with a customer's money rather than about whether the happy path returns 201.
//
//   1. AN ORDER PLACED TWICE. A retry, and a retry storm, and two tabs. One order each time.
//   2. A TOTAL THAT MOVED. The customer agreed to a figure; anything else is refused, not charged.
//   3. STOCK. The last unit sold to two people is the failure reserve_stock() exists to prevent.
//   4. CASH ROUNDING. AdminCurrencies shows Total 8,017 / Cash due 8,000 — the gap the plan has owed since
//      milestone 13, tested against the board's own number.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call } from './client.ts';
import type { Api } from './client.ts';
import { CATALOGUE, STORE, USER, cleanup, seedFixtures, seedStorefront } from './support.ts';

let api: Api;
const SLUG = 'escalation-store-a';
const OTHER = 'escalation-store-b';

const JUICE_VARIANT = 'eeeeeeee-0000-4000-8000-000000000310';
const BURGER_VARIANT = 'eeeeeeee-0000-4000-8000-000000000311';
const CHEESE = 'eeeeeeee-0000-4000-8000-000000000220';
const SET_MENU_VARIANT = 'eeeeeeee-0000-4000-8000-000000000317';
const CAP_VARIANT = 'eeeeeeee-0000-4000-8000-000000000313';

let zoneNear = '';
let zoneFar = '';

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  const { rows } = await sql<{ id: string; fee_amount: string }>(
    `SELECT id, fee_amount::text FROM delivery_zones WHERE store_id = $1 ORDER BY fee_amount`,
    [STORE.a],
  );
  zoneNear = rows[0]?.id ?? '';
  zoneFar = rows[1]?.id ?? '';
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
});

/** A shopper with their own cookie jar, so no two tests share a cart. */
async function shopper(): Promise<Api> {
  return boot();
}

async function add(who: Api, variantId: string, quantity = 1, optionValueIds: string[] = []): Promise<void> {
  const reply = await call(who, 'POST', `/api/storefront/${SLUG}/cart/items`, {
    body: { variantId, optionValueIds, quantity },
  });
  assert.equal(reply.status, 201, `adding ${variantId}: ${JSON.stringify(reply.body)}`);
}

async function quoteFor(
  who: Api,
  options: { fulfilment?: 'delivery' | 'pickup'; zone?: string } = {},
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ fulfilment: options.fulfilment ?? 'delivery' });
  if (options.zone !== undefined) params.set('zone', options.zone);
  const reply = await call(who, 'GET', `/api/storefront/${SLUG}/checkout?${params.toString()}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body['quote'] as Record<string, unknown>;
}

let keySeq = 0;
/** A distinct key per attempt, unless a test is deliberately reusing one. */
function freshKey(): string {
  keySeq += 1;
  return `test-checkout-key-${Date.now()}-${keySeq}`;
}

type PlaceBody = Record<string, unknown>;

function cashOrder(total: string, key: string, extra: PlaceBody = {}): PlaceBody {
  return {
    idempotencyKey: key,
    fulfilment: 'delivery',
    paymentMethod: 'cash',
    expectedTotal: total,
    name: 'Test Buyer',
    phone: '078 000 0001',
    address: 'KG 1 Ave, Kigali',
    zone: zoneNear,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
describe('the quote', () => {
  it('adds up the cart, the delivery fee and the discount the way the order will', async () => {
    const who = await shopper();
    await add(who, BURGER_VARIANT, 2, [CHEESE]); // 2 x (3500 + 500) = 8000
    await add(who, JUICE_VARIANT, 1); //            1 x 1200         = 1200

    const quote = await quoteFor(who, { fulfilment: 'delivery', zone: zoneNear });
    assert.equal(quote['subtotal'], '9200.00');
    assert.equal(quote['deliveryFee'], '1000.00');
    // THE STORE'S AUTOMATIC OFFER IS IN HERE. support.ts gives store A a live 10%-off promotion, and the
    // quote applies it without anybody typing a code — which is what `automatic` means. 10% of the ITEMS,
    // not of the total: V013 is explicit that "a discount comes off the items", so the delivery fee is
    // untouched.
    assert.equal(quote['discount'], '920.00');
    assert.equal(quote['total'], '9280.00', '9,200 items + 1,000 delivery − 920 automatic');
    assert.equal(quote['itemCount'], 3);
    await who.close();
  });

  it('carries the automatic offer into the order at the same figure', async () => {
    // The quote and the placement compute the discount in different places — promotion_quote() against the
    // cart, apply_automatic_promotions() against the order — and both go through promotion_evaluate(). This
    // is the test that says they agree.
    const who = await shopper();
    await add(who, BURGER_VARIANT, 2, [CHEESE]);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    assert.equal(quote['discount'], '800.00', '10% of 8,000');

    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey(), {
        fulfilment: 'pickup',
        address: null,
        zone: null,
      }),
    });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));

    const code = String((placed.body['order'] as Record<string, unknown>)['trackingCode']);
    const read = await call(who, 'GET', `/api/storefront/${SLUG}/orders/${code}`);
    const order = read.body['order'] as Record<string, unknown>;
    assert.equal(order['discount'], '800.00', 'the charged discount is the quoted discount');
    assert.equal(order['total'], quote['total']);
    await who.close();
  });

  it('quotes the zone that was chosen, not the cheapest', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);

    const near = await quoteFor(who, { fulfilment: 'delivery', zone: zoneNear });
    const far = await quoteFor(who, { fulfilment: 'delivery', zone: zoneFar });
    assert.equal(near['deliveryFee'], '1000.00');
    assert.equal(far['deliveryFee'], '2500.00');
    // 1,200 of juice, less the store's automatic 120, plus the zone's fee.
    assert.equal(near['total'], '2080.00');
    assert.equal(far['total'], '3580.00');
    await who.close();
  });

  it('charges nothing to deliver a pickup order', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    assert.equal(quote['deliveryFee'], '0');
    assert.equal(quote['total'], '1080.00', '1,200 less the automatic 120, and nothing to deliver');
    await who.close();
  });

  it('offers only what the store connected and what can take this total', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const methods = quote['paymentMethods'] as { key: string; usableForTotal: boolean }[];

    // Store A connected cash and mtn_momo (support.ts). No card: AdminPayments has no processor (Part 9), so
    // there is no payment_methods row for one and nothing to offer.
    assert.deepEqual(methods.map((m) => m.key).sort(), ['cash', 'mtn_momo']);
    assert.equal(
      methods.some((m) => m.key === 'card' || m.key === 'visa'),
      false,
      'a method with no integration behind it is never offered',
    );
    for (const method of methods) assert.equal(method.usableForTotal, true, `${method.key} takes 1,200`);
    await who.close();
  });

  it('shows a method that cannot take this total, and says it cannot', async () => {
    // V006: "Tell the customer before they try, not after the provider refuses." mtn_momo takes from 100 RWF,
    // so a 50 RWF order is below it — the row is still shown, marked unusable.
    const who = await shopper();
    await sql(`UPDATE products SET base_price = 50 WHERE id = $1`, [CATALOGUE.water]);
    await add(who, 'eeeeeeee-0000-4000-8000-000000000316', 1);

    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const methods = quote['paymentMethods'] as { key: string; usableForTotal: boolean; minAmount: string | null }[];
    const momo = methods.find((m) => m.key === 'mtn_momo');
    assert.equal(momo?.usableForTotal, false, '50 is below MoMo’s 100 minimum');
    assert.equal(momo?.minAmount, '100.00');
    assert.equal(methods.find((m) => m.key === 'cash')?.usableForTotal, true, 'cash has no minimum');

    await sql(`UPDATE products SET base_price = 500 WHERE id = $1`, [CATALOGUE.water]);
    await who.close();
  });

  it('names what sold out rather than refusing with nothing to act on', async () => {
    const who = await shopper();
    await add(who, CAP_VARIANT, 1);
    await sql(`UPDATE product_variants SET stock_quantity = 0 WHERE id = $1`, [CAP_VARIANT]);

    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const unavailable = quote['unavailable'] as { productName: string }[];
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0]?.productName, 'Cotton Cap');

    await sql(`UPDATE product_variants SET stock_quantity = 2 WHERE id = $1`, [CAP_VARIANT]);
    await who.close();
  });

  it('refuses to quote an empty cart', async () => {
    const who = await shopper();
    const reply = await call(who, 'GET', `/api/storefront/${SLUG}/checkout?fulfilment=pickup`);
    assert.equal(reply.status, 404);
    assert.equal(reply.body['code'], 'NO_CART');
    await who.close();
  });
});

// ---------------------------------------------------------------------------
describe('editing the cart', () => {
  it('changes a quantity and re-prices the line', async () => {
    const who = await shopper();
    await add(who, BURGER_VARIANT, 1, [CHEESE]);
    const cart = (await call(who, 'GET', `/api/storefront/${SLUG}/cart`)).body['cart'] as Record<string, unknown>;
    const lineId = (cart['lines'] as { id: string }[])[0]?.id;

    const changed = await call(who, 'PATCH', `/api/storefront/${SLUG}/cart/items/${lineId}`, {
      body: { quantity: 3 },
    });
    assert.equal(changed.status, 200);
    const updated = changed.body['cart'] as Record<string, unknown>;
    assert.equal(updated['itemCount'], 3);
    assert.equal(updated['subtotal'], '12000.00', '3 x 4,000');
    await who.close();
  });

  it('refuses a quantity of zero, because that is a removal', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const cart = (await call(who, 'GET', `/api/storefront/${SLUG}/cart`)).body['cart'] as Record<string, unknown>;
    const lineId = (cart['lines'] as { id: string }[])[0]?.id;

    const refused = await call(who, 'PATCH', `/api/storefront/${SLUG}/cart/items/${lineId}`, {
      body: { quantity: 0 },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body['code'], 'INVALID_QUANTITY');
    await who.close();
  });

  it('removes a line, and removing it twice is not an error', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const cart = (await call(who, 'GET', `/api/storefront/${SLUG}/cart`)).body['cart'] as Record<string, unknown>;
    const lineId = (cart['lines'] as { id: string }[])[0]?.id;

    const first = await call(who, 'DELETE', `/api/storefront/${SLUG}/cart/items/${lineId}`);
    assert.equal(first.status, 200);
    assert.equal((first.body['cart'] as Record<string, unknown>)['itemCount'], 0);

    // The board's Remove button can be tapped twice.
    const again = await call(who, 'DELETE', `/api/storefront/${SLUG}/cart/items/${lineId}`);
    assert.equal(again.status, 200);
    await who.close();
  });

  it('cannot edit a line in somebody else’s cart', async () => {
    const mine = await shopper();
    const theirs = await shopper();
    await add(mine, JUICE_VARIANT, 1);
    const cart = (await call(mine, 'GET', `/api/storefront/${SLUG}/cart`)).body['cart'] as Record<string, unknown>;
    const lineId = (cart['lines'] as { id: string }[])[0]?.id;

    // A different shopper, holding a valid line id from another cart.
    await add(theirs, BURGER_VARIANT, 1);
    const refused = await call(theirs, 'PATCH', `/api/storefront/${SLUG}/cart/items/${lineId}`, {
      body: { quantity: 9 },
    });
    assert.equal(refused.status, 404, 'a line id is not an access rule');
    assert.equal(refused.body['code'], 'NO_SUCH_LINE');

    // And mine is untouched.
    const still = (await call(mine, 'GET', `/api/storefront/${SLUG}/cart`)).body['cart'] as Record<string, unknown>;
    assert.equal(still['itemCount'], 1);
    await mine.close();
    await theirs.close();
  });
});

// ---------------------------------------------------------------------------
describe('placing an order', () => {
  it('places it at the quoted total and empties the cart', async () => {
    const who = await shopper();
    await add(who, BURGER_VARIANT, 2, [CHEESE]);
    const quote = await quoteFor(who, { fulfilment: 'delivery', zone: zoneNear });

    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey()),
    });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const order = placed.body['order'] as Record<string, unknown>;
    assert.equal(order['total'], '8200.00', '8,000 of burgers + 1,000 delivery − 800 automatic');
    assert.equal(placed.body['created'], true);
    assert.equal(placed.body['needsPayment'], false, 'cash needs no provider');

    const after2 = (await call(who, 'GET', `/api/storefront/${SLUG}/cart`)).body['cart'] as Record<string, unknown>;
    assert.equal(after2['itemCount'], 0, 'the cart is emptied by the placement');
    await who.close();
  });

  it('copies the lines with their options, priced as they were', async () => {
    const who = await shopper();
    await add(who, BURGER_VARIANT, 2, [CHEESE]);
    await add(who, JUICE_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });

    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey(), { fulfilment: 'pickup', address: null, zone: null }),
    });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const code = (placed.body['order'] as Record<string, unknown>)['trackingCode'];

    const read = await call(who, 'GET', `/api/storefront/${SLUG}/orders/${String(code)}`);
    const lines = (read.body['order'] as Record<string, unknown>)['lines'] as Record<string, unknown>[];
    assert.equal(lines.length, 2, 'two lines, not one merged one');

    const burger = lines.find((l) => l['productName'] === 'Chicken Burger');
    assert.deepEqual(burger?.['optionLabels'], ['Extra cheese']);
    assert.equal(burger?.['unitPrice'], '3500.00', 'the base price, captured');
    assert.equal(burger?.['lineTotal'], '8000.00', 'and the options in the line total');
    await who.close();
  });

  it('refuses a total the customer did not agree to', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);

    const refused = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder('99999.00', freshKey()),
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body['code'], 'STALE_CATALOGUE');
    assert.match(String(refused.body['error']), /total changed/i);

    // And nothing was written: the cart is still there to try again with.
    const cart = (await call(who, 'GET', `/api/storefront/${SLUG}/cart`)).body['cart'] as Record<string, unknown>;
    assert.equal(cart['itemCount'], 1, 'a refused order leaves the cart alone');
    await who.close();
  });

  it('refuses when a price moved between the quote and the button', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });

    // The merchant raises the price while the customer is reading the screen.
    await sql(`UPDATE products SET base_price = 1500 WHERE id = $1`, [CATALOGUE.juice]);

    const refused = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey(), { fulfilment: 'pickup', address: null, zone: null }),
    });
    assert.equal(refused.status, 409, 'the figure they agreed to is no longer the figure');
    assert.equal(refused.body['code'], 'STALE_CATALOGUE');

    await sql(`UPDATE products SET base_price = 1200 WHERE id = $1`, [CATALOGUE.juice]);
    await who.close();
  });

  it('refuses an empty cart, a bad zone and a missing address', async () => {
    const who = await shopper();

    const empty = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder('1200.00', freshKey()),
    });
    assert.equal(empty.status, 404);
    assert.equal(empty.body['code'], 'NO_CART');

    await add(who, JUICE_VARIANT, 1);

    const noAddress = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder('2200.00', freshKey(), { address: null }),
    });
    assert.equal(noAddress.status, 400);
    assert.equal(noAddress.body['code'], 'MISSING_ADDRESS');

    const noZone = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder('2200.00', freshKey(), { zone: null }),
    });
    assert.equal(noZone.status, 400);
    assert.equal(noZone.body['code'], 'INVALID_ZONE');

    const otherZone = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder('2200.00', freshKey(), {
        zone: (await sql<{ id: string }>(
          `INSERT INTO delivery_zones (store_id, name, fee_amount, eta_min_minutes, eta_max_minutes)
                VALUES ($1, 'Elsewhere', 500, 10, 20) RETURNING id`,
          [STORE.b],
        )).rows[0]?.id,
      }),
    });
    assert.equal(otherZone.status, 409, 'another store’s zone is not a zone here');
    await who.close();
  });

  it('a guest must leave a name and a number', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);

    const noName = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder('2200.00', freshKey(), { name: null }),
    });
    assert.equal(noName.status, 400);
    assert.equal(noName.body['code'], 'MISSING_NAME');

    const noPhone = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder('2200.00', freshKey(), { phone: null }),
    });
    assert.equal(noPhone.status, 400);
    assert.equal(noPhone.body['code'], 'MISSING_PHONE');
    await who.close();
  });

  it('refuses a short idempotency key, because a weak one is a second order', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const refused = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder('2200.00', 'tooshort'),
    });
    assert.equal(refused.status, 400);
    await who.close();
  });

  it('needs its CSRF token', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const refused = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder('2200.00', freshKey()),
      csrf: false,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body['code'], 'CSRF_MISSING');
    await who.close();
  });
});

// ---------------------------------------------------------------------------
describe('placing it twice', () => {
  it('a retry returns the first order, with 200 rather than 201', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const key = freshKey();
    const body = cashOrder(String(quote['total']), key, { fulfilment: 'pickup', address: null, zone: null });

    const first = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, { body });
    assert.equal(first.status, 201);
    assert.equal(first.body['created'], true);

    const retry = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, { body });
    assert.equal(retry.status, 200, 'nothing was created');
    assert.equal(retry.body['created'], false);
    assert.deepEqual(retry.body['order'], first.body['order'], 'the same order comes back');

    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders WHERE store_id = $1 AND idempotency_key = $2`,
      [STORE.a, key],
    );
    assert.equal(rows[0]?.n, '1', 'exactly one order exists');
    await who.close();
  });

  it('ten SIMULTANEOUS requests with one key produce one order and no failures', async () => {
    // The retry storm: a button pressed repeatedly on a slow connection. Before place_order() re-checked
    // idempotency AFTER taking the cart lock, nine of these were told "that cart is empty" — at the moment
    // their order existed.
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const key = freshKey();
    const body = cashOrder(String(quote['total']), key, { fulfilment: 'pickup', address: null, zone: null });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => call(who, 'POST', `/api/storefront/${SLUG}/orders`, { body })),
    );

    assert.equal(
      results.filter((r) => r.status !== 200 && r.status !== 201).length,
      0,
      `every request succeeded: ${JSON.stringify(results.map((r) => [r.status, r.body['code']]))}`,
    );
    assert.equal(results.filter((r) => r.body['created'] === true).length, 1, 'exactly one created it');

    const numbers = new Set(
      results.map((r) => (r.body['order'] as Record<string, unknown>)['orderNumber']),
    );
    assert.equal(numbers.size, 1, 'and they all describe the same order');

    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders WHERE store_id = $1 AND idempotency_key = $2`,
      [STORE.a, key],
    );
    assert.equal(rows[0]?.n, '1');
    await who.close();
  });

  it('two tabs with DIFFERENT keys produce one order, and the second is told why', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const total = String(quote['total']);

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
          body: cashOrder(total, `${freshKey()}-tab${i}`, {
            fulfilment: 'pickup',
            address: null,
            zone: null,
          }),
        }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    assert.equal(created.length, 1, 'the cart lock means exactly one wins');
    for (const refused of results.filter((r) => r.status !== 201)) {
      assert.equal(refused.body['code'], 'STALE_CATALOGUE');
      assert.match(String(refused.body['error']), /empty/i, 'the cart was emptied by the one that won');
    }
    await who.close();
  });
});

// ---------------------------------------------------------------------------
describe('stock', () => {
  it('reserves it, and the last unit cannot be sold twice', async () => {
    await sql(`UPDATE product_variants SET stock_quantity = 1 WHERE id = $1`, [CAP_VARIANT]);

    const first = await shopper();
    const second = await shopper();
    await add(first, CAP_VARIANT, 1);
    await add(second, CAP_VARIANT, 1);

    const q1 = await quoteFor(first, { fulfilment: 'pickup' });
    const q2 = await quoteFor(second, { fulfilment: 'pickup' });

    const [a, b] = await Promise.all([
      call(first, 'POST', `/api/storefront/${SLUG}/orders`, {
        body: cashOrder(String(q1['total']), freshKey(), { fulfilment: 'pickup', address: null, zone: null }),
      }),
      call(second, 'POST', `/api/storefront/${SLUG}/orders`, {
        body: cashOrder(String(q2['total']), freshKey(), { fulfilment: 'pickup', address: null, zone: null }),
      }),
    ]);

    const ok = [a, b].filter((r) => r.status === 201);
    const refused = [a, b].filter((r) => r.status !== 201);
    assert.equal(ok.length, 1, 'exactly one of them got the last cap');
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.body['code'], 'INSUFFICIENT_STOCK');

    const { rows } = await sql<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM product_variants WHERE id = $1`,
      [CAP_VARIANT],
    );
    assert.equal(rows[0]?.stock_quantity, 0, 'and the shelf is empty, not negative');

    await sql(`UPDATE product_variants SET stock_quantity = 2 WHERE id = $1`, [CAP_VARIANT]);
    await first.close();
    await second.close();
  });

  it('does not decrement for a product that does not track stock', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 3);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey(), { fulfilment: 'pickup', address: null, zone: null }),
    });
    assert.equal(placed.status, 201);

    const { rows } = await sql<{ stock_quantity: number | null }>(
      `SELECT stock_quantity FROM product_variants WHERE id = $1`,
      [JUICE_VARIANT],
    );
    assert.equal(rows[0]?.stock_quantity, null, 'opt-in stock tracking: a juice is switched off, not counted');
    await who.close();
  });
});

// ---------------------------------------------------------------------------
describe('cash rounding', () => {
  // THE STORE'S AUTOMATIC OFFER IS SWITCHED OFF FOR THESE, so that what is under test is the rounding and not
  // a discount. With 10% off, 8,017 becomes 7,215.30 and the board's own example stops being visible — and
  // the board's example is the whole point: AdminCurrencies shows Total 8,017 / Cash due 8,000.
  before(async () => {
    await sql(`UPDATE promotions SET is_active = false WHERE store_id = $1`, [STORE.a]);
  });
  after(async () => {
    await sql(`UPDATE promotions SET is_active = true WHERE store_id = $1`, [STORE.a]);
  });

  it('rounds the total to the cash step — AdminCurrencies’ own 8,017 becomes 8,000', async () => {
    const who = await shopper();
    await add(who, SET_MENU_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });

    assert.equal(quote['total'], '8017.00', 'the board’s own figure');
    assert.equal(quote['cashDue'], '8000.00', 'and the board’s own cash due');

    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey(), { fulfilment: 'pickup', address: null, zone: null }),
    });
    assert.equal(placed.status, 201);
    const order = placed.body['order'] as Record<string, unknown>;
    assert.equal(order['total'], '8017.00');
    assert.equal(order['cashDue'], '8000.00', 'the rider collects 8,000');
    await who.close();
  });

  it('leaves a momo order with no cash-due figure at all', async () => {
    const who = await shopper();
    await add(who, SET_MENU_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });

    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey(), {
        fulfilment: 'pickup',
        address: null,
        zone: null,
        paymentMethod: 'mtn_momo',
      }),
    });
    assert.equal(placed.status, 201);
    assert.equal((placed.body['order'] as Record<string, unknown>)['cashDue'], null);
    assert.equal(placed.body['needsPayment'], true);
    await who.close();
  });

  it('re-derives the figure when a discount changes the total', async () => {
    // The bug that turned this column from checked into derived: a discount is applied AFTER the order is
    // written, so a cash-due figure computed at insert time is a rounding of a total that no longer exists.
    const who = await shopper();
    await add(who, SET_MENU_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey(), { fulfilment: 'pickup', address: null, zone: null }),
    });
    const code = (placed.body['order'] as Record<string, unknown>)['trackingCode'];

    const { rows: before } = await sql<{ total_amount: string; cash_due_amount: string }>(
      `SELECT total_amount::text, cash_due_amount::text FROM orders WHERE tracking_code = $1`,
      [String(code)],
    );
    assert.equal(before[0]?.total_amount, '8017.00');
    assert.equal(before[0]?.cash_due_amount, '8000.00');

    // A manual discount, the way a merchant would give one.
    await sql(
      `SELECT record_manual_discount(
         (SELECT id FROM orders WHERE tracking_code = $1), 17, 'goodwill', $2)`,
      [String(code), USER.ownerA],
    );

    const { rows: afterRows } = await sql<{ total_amount: string; cash_due_amount: string }>(
      `SELECT total_amount::text, cash_due_amount::text FROM orders WHERE tracking_code = $1`,
      [String(code)],
    );
    assert.equal(afterRows[0]?.total_amount, '8000.00', '17 off');
    assert.equal(
      afterRows[0]?.cash_due_amount,
      '8000.00',
      'and the cash due followed the total rather than staying at the old rounding',
    );
    await who.close();
  });
});

// ---------------------------------------------------------------------------
describe('reading an order back', () => {
  let code = '';
  let who: Api;

  before(async () => {
    who = await shopper();
    await add(who, BURGER_VARIANT, 1, [CHEESE]);
    const quote = await quoteFor(who, { fulfilment: 'delivery', zone: zoneNear });
    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey()),
    });
    code = String((placed.body['order'] as Record<string, unknown>)['trackingCode']);
  });

  after(async () => {
    await who.close();
  });

  it('is openable cold, by the code alone, with no session and no cart', async () => {
    const stranger = await boot();
    const reply = await call(stranger, 'GET', `/api/storefront/${SLUG}/orders/${code}`);
    assert.equal(reply.status, 200);
    const order = reply.body['order'] as Record<string, unknown>;
    assert.equal(order['status'], 'pending');
    assert.equal(order['paymentStatus'], 'unpaid');
    assert.equal((order['store'] as Record<string, unknown>)['name'], 'Escalation Store A');
    // The first timeline entry, so a tracking page has something to draw from the moment it exists.
    assert.equal((order['events'] as unknown[]).length, 1);
    await stranger.close();
  });

  it('is 32 characters of randomness, because the code IS the credential', async () => {
    assert.match(code, /^[0-9a-f]{32}$/);
    const wrong = await call(who, 'GET', `/api/storefront/${SLUG}/orders/${'0'.repeat(32)}`);
    assert.equal(wrong.status, 404);
    assert.equal(wrong.body['code'], 'NO_SUCH_ORDER');
  });

  it('cannot be read through another store’s shopfront', async () => {
    const reply = await call(who, 'GET', `/api/storefront/${OTHER}/orders/${code}`);
    assert.equal(reply.status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('paying', () => {
  it('refuses to charge a cash order', async () => {
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey(), { fulfilment: 'pickup', address: null, zone: null }),
    });
    const code = String((placed.body['order'] as Record<string, unknown>)['trackingCode']);

    const refused = await call(who, 'POST', `/api/storefront/${SLUG}/orders/${code}/payment`, {
      body: { phone: '078 000 0001' },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body['code'], 'CASH_ON_DELIVERY');
    await who.close();
  });

  it('says plainly that the provider is not configured, rather than failing obscurely', async () => {
    // The suite runs without MOMO_* credentials, which is an EXPECTED deployment state: where provider
    // credentials live is an open decision (Part 9). It must not look like a broken order.
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey(), {
        fulfilment: 'pickup',
        address: null,
        zone: null,
        paymentMethod: 'mtn_momo',
      }),
    });
    const code = String((placed.body['order'] as Record<string, unknown>)['trackingCode']);

    const reply = await call(who, 'POST', `/api/storefront/${SLUG}/orders/${code}/payment`, {
      body: { phone: '078 000 0001' },
    });
    assert.equal(reply.status, 409);
    assert.equal(reply.body['code'], 'PAYMENTS_NOT_CONFIGURED');
    assert.match(String(reply.body['error']), /cash on delivery/i, 'and it says what to do instead');
    await who.close();
  });

  it('a paid order is charged once, whatever the webhook does', async () => {
    // The three layers V005 built, exercised through the function the webhook calls. No provider needed: what
    // is under test is that a repeated confirmation moves nothing.
    const who = await shopper();
    await add(who, JUICE_VARIANT, 1);
    const quote = await quoteFor(who, { fulfilment: 'pickup' });
    const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
      body: cashOrder(String(quote['total']), freshKey(), {
        fulfilment: 'pickup',
        address: null,
        zone: null,
        paymentMethod: 'mtn_momo',
      }),
    });
    const code = String((placed.body['order'] as Record<string, unknown>)['trackingCode']);

    const { rows: orderRows } = await sql<{ id: string; total_amount: string }>(
      `SELECT id, total_amount::text FROM orders WHERE tracking_code = $1`,
      [code],
    );
    const orderId = orderRows[0]?.id ?? '';

    const { rows: attempt } = await sql<{ id: string }>(
      `INSERT INTO momo_transactions (store_id, order_id, direction, reference_id, phone, amount, currency)
            VALUES ($1, $2, 'collection', gen_random_uuid()::text, '078 000 0001', $3::numeric, 'RWF')
        RETURNING id`,
      [STORE.a, orderId, orderRows[0]?.total_amount],
    );

    // Five confirmations of the same collection.
    const outcomes: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { rows } = await sql<{ ok: boolean }>(`SELECT record_momo_collection_success($1) AS ok`, [
        attempt[0]?.id,
      ]);
      outcomes.push(rows[0]?.ok === true);
    }
    assert.deepEqual(outcomes, [true, false, false, false, false], 'the first moved money; the rest did not');

    const { rows: ledger } = await sql<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(amount), 0)::text AS total
         FROM wallet_ledger WHERE order_id = $1 AND entry_type = 'order_payment_received'`,
      [orderId],
    );
    assert.equal(ledger[0]?.n, '1', 'one ledger entry, five confirmations');
    assert.equal(ledger[0]?.total, orderRows[0]?.total_amount, 'for exactly the order total');

    const { rows: paid } = await sql<{ payment_status: string; settlement_status: string }>(
      `SELECT payment_status, settlement_status FROM orders WHERE id = $1`,
      [orderId],
    );
    assert.equal(paid[0]?.payment_status, 'paid');
    assert.equal(paid[0]?.settlement_status, 'pending', 'and the money is in escrow, not released');
    await who.close();
  });

  it('the webhook answers 200 and believes nothing it is told', async () => {
    const who = await shopper();
    // A forged callback for a reference that does not exist: answered, and nothing happens.
    const reply = await call(who, 'POST', `/api/momo/callback/collection/${crypto.randomUUID()}`, {
      body: { status: 'SUCCESSFUL' },
      csrf: false,
    });
    assert.equal(reply.status, 200, 'the webhook is outside the CSRF layer — MTN cannot echo a token');
    assert.deepEqual(reply.body, { received: true });

    const nonsense = await call(who, 'POST', `/api/momo/callback/collection/not-a-uuid`, {
      body: { status: 'SUCCESSFUL' },
      csrf: false,
    });
    assert.equal(nonsense.status, 200, 'a malformed id is answered too, rather than retried at us');
    await who.close();
  });
});
