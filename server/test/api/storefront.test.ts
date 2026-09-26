// server/test/api/storefront.test.ts — milestone 16.
//
// The shopfront, over HTTP, against a real catalogue.
//
// WHAT IS WORTH TESTING HERE, and it is not "does the grid return products". Four things:
//
//   1. WHAT A SHOPPER CANNOT SEE. A draft product, another store's product, a suspended store and a
//      store awaiting approval. Each of those is a leak if it answers, and the last two have to answer
//      DIFFERENTLY from each other and identically to a store that does not exist.
//
//   2. THE RULES THAT LIVE IN SQL, asserted through the endpoint rather than by reading the migration:
//      the average is hidden below three reviews, a section is hidden when it has no active products, a
//      variant sold out is struck through while its siblings are not.
//
//   3. THE CART'S ATOMICITY. Adding the same line twice merges; adding it twenty times CONCURRENTLY
//      merges; and the option set is what makes two lines different. The merge is V018's unique index,
//      and the concurrent case is the one a SELECT-then-INSERT would fail.
//
//   4. THE REVIEW's IDEMPOTENCY, both ways it happens — a retry after the response was lost, and two
//      requests in flight together.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql, withTransaction } from '../../src/db/index.ts';
import { boot, call } from './client.ts';
import type { Api } from './client.ts';
import {
  CATALOGUE,
  STORE,
  USER,
  cartLines,
  cleanup,
  countReviews,
  seedFixtures,
  seedStorefront,
} from './support.ts';
import { tokenFor } from './client.ts';

let api: Api;

const SLUG = 'escalation-store-a';
const OTHER = 'escalation-store-b';

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
});

// ---------------------------------------------------------------------------
describe('the store itself', () => {
  it('answers with its name, hours, fulfilment and banner in one request', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}`);
    assert.equal(reply.status, 200);

    const store = reply.body['store'] as Record<string, unknown>;
    assert.equal(store['slug'], SLUG);
    assert.equal(store['name'], 'Escalation Store A');
    assert.equal(store['currency'], 'RWF');
    assert.equal(store['phone'], '+250 78 000 1234');

    const open = reply.body['open'] as Record<string, unknown>;
    assert.equal(open['isOpen'], true, 'the fixture store trades every hour of every day');

    assert.equal((reply.body['hours'] as unknown[]).length, 7);

    // The CHEAPEST zone, not the first: 1,000 rather than 2,500. See deliverySummary().
    const delivery = reply.body['delivery'] as Record<string, unknown>;
    assert.equal(delivery['fromFee'], '1000.00');
    assert.equal(delivery['etaMinMinutes'], 25);
    assert.equal(delivery['zoneCount'], 2);

    const banner = reply.body['banner'] as Record<string, unknown>;
    assert.equal(banner['title'], 'Ten per cent off this week');
  });

  it('never caches: the open flag is true for a few hours', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}`);
    assert.equal(reply.status, 200);
    // no-store rather than an ETag. Being told the kitchen is open when it is not is the one wrong
    // answer this endpoint must not give.
    const res = await fetch(`${api.baseUrl}/api/storefront/${SLUG}`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await res.text();
  });

  it('lists only sections that are visible AND have something active in them', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}`);
    const categories = reply.body['categories'] as { name: string; productCount: number }[];
    const names = categories.map((c) => c.name);
    assert.deepEqual(names, ['Mains', 'Drinks']);

    // Mains holds seven ACTIVE products plus the draft plus Still Water: the draft does not count.
    const mains = categories.find((c) => c.name === 'Mains');
    assert.equal(mains?.productCount, 7, 'the draft product is not counted');

    // Hide the section and it leaves the rail entirely.
    await sql(`UPDATE categories SET is_visible = false WHERE id = $1`, [CATALOGUE.drinks]);
    const hidden = await call(api, 'GET', `/api/storefront/${SLUG}`);
    assert.deepEqual((hidden.body['categories'] as { name: string }[]).map((c) => c.name), ['Mains']);
    await sql(`UPDATE categories SET is_visible = true WHERE id = $1`, [CATALOGUE.drinks]);
  });

  it('refuses a suspended store by name, and a pending one as if it did not exist', async () => {
    await sql(`UPDATE stores SET status = 'suspended' WHERE id = $1`, [STORE.a]);
    const suspended = await call(api, 'GET', `/api/storefront/${SLUG}`);
    assert.equal(suspended.status, 403);
    assert.equal(suspended.body['code'], 'STORE_SUSPENDED');
    // It NAMES the store, because the shopper knows where they meant to be.
    assert.match(String(suspended.body['error']), /Escalation Store A/);

    await sql(`UPDATE stores SET status = 'pending' WHERE id = $1`, [STORE.a]);
    const pending = await call(api, 'GET', `/api/storefront/${SLUG}`);
    const missing = await call(api, 'GET', `/api/storefront/no-such-store-at-all`);

    // BYTE-IDENTICAL. Otherwise the storefront enumerates which slugs are taken.
    assert.equal(pending.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(pending.body, missing.body);

    await sql(`UPDATE stores SET status = 'active' WHERE id = $1`, [STORE.a]);
  });

  it('refuses a malformed slug with a different answer from a missing one', async () => {
    const bad = await call(api, 'GET', `/api/storefront/Not_A_Slug`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body['code'], 'INVALID_SLUG');
  });
});

// ---------------------------------------------------------------------------
describe('browsing the catalogue', () => {
  it('lists active products in the merchant’s order and leaves the draft out', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products?limit=50`);
    assert.equal(reply.status, 200);
    const products = reply.body['products'] as { id: string; name: string }[];

    assert.deepEqual(
      products.map((p) => p.name),
      ['Passion Juice', 'Linen Tee', 'Chicken Burger', 'Veggie Wrap', 'Cotton Cap', 'Brochette Plate', 'Still Water'],
    );
    assert.equal(
      products.some((p) => p.id === CATALOGUE.secret),
      false,
      'a draft product is not on the shopfront',
    );
  });

  it('answers a product from another store as if it were not there', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${OTHER}/products/${CATALOGUE.juice}`);
    assert.equal(reply.status, 404);
    assert.equal(reply.body['code'], 'NO_SUCH_PRODUCT');

    // And the draft, from its own store, answers the same way.
    const draft = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.secret}`);
    assert.equal(draft.status, 404);
    assert.deepEqual(draft.body, reply.body);
  });

  it('reports each product’s stock the way the cards are drawn', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products?limit=50`);
    const byId = new Map(
      (reply.body['products'] as { id: string; stock: Record<string, unknown> }[]).map((p) => [p.id, p.stock]),
    );

    // Every variant withdrawn → sold out, even though nothing is counted.
    assert.equal(byId.get(CATALOGUE.wrap)?.['soldOut'], true);

    // Tracked, 2 left, threshold 3 → few left.
    assert.equal(byId.get(CATALOGUE.cap)?.['soldOut'], false);
    assert.equal(byId.get(CATALOGUE.cap)?.['lowStock'], true);
    assert.equal(byId.get(CATALOGUE.cap)?.['fewestLeft'], 2);

    // The tee: M/Sand is 0 and M/Black is 2, so the PRODUCT is low but not sold out. Per variant, which
    // is what "Only 2 left in size 43" means.
    assert.equal(byId.get(CATALOGUE.tee)?.['soldOut'], false);
    assert.equal(byId.get(CATALOGUE.tee)?.['lowStock'], true);
    assert.equal(byId.get(CATALOGUE.tee)?.['fewestLeft'], 2);

    // Untracked → no count to report, and never low.
    assert.equal(byId.get(CATALOGUE.juice)?.['lowStock'], false);
    assert.equal(byId.get(CATALOGUE.juice)?.['fewestLeft'], null);
  });

  it('says which products need a choice before they can be added', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products?limit=50`);
    const byId = new Map(
      (reply.body['products'] as { id: string; hasChoices: boolean; hasExtras: boolean; defaultVariantId: string | null }[]).map(
        (p) => [p.id, p],
      ),
    );

    assert.equal(byId.get(CATALOGUE.tee)?.hasChoices, true, 'Size and Colour are pick-one');
    assert.equal(byId.get(CATALOGUE.tee)?.hasExtras, false);
    assert.equal(byId.get(CATALOGUE.burger)?.hasChoices, false);
    assert.equal(byId.get(CATALOGUE.burger)?.hasExtras, true, 'Extras is pick-several');
    assert.equal(byId.get(CATALOGUE.juice)?.hasChoices, false);
    assert.notEqual(byId.get(CATALOGUE.juice)?.defaultVariantId, null, 'a one-tap add needs a variant');
  });

  it('prices are strings, never numbers', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products?limit=50`);
    for (const product of reply.body['products'] as { price: unknown; compareAtPrice: unknown }[]) {
      assert.equal(typeof product.price, 'string', 'money must not arrive as a float');
      if (product.compareAtPrice !== null) assert.equal(typeof product.compareAtPrice, 'string');
    }
  });

  it('filters by section, in that section’s own order', async () => {
    const drinks = await call(api, 'GET', `/api/storefront/${SLUG}/products?category=${CATALOGUE.drinks}`);
    assert.deepEqual((drinks.body['products'] as { name: string }[]).map((p) => p.name), ['Still Water']);

    // Still Water is in both sections, at position 8 in Mains and 1 in Drinks. A product in two sections
    // is what makes product_categories a join rather than a column.
    const mains = await call(api, 'GET', `/api/storefront/${SLUG}/products?category=${CATALOGUE.mains}&limit=50`);
    const names = (mains.body['products'] as { name: string }[]).map((p) => p.name);
    assert.equal(names[names.length - 1], 'Still Water');
  });

  it('pages by keyset, without repeating or dropping a product', async () => {
    const seen: string[] = [];
    let cursor: { position: number; id: string } | null = null;

    for (let page = 0; page < 10; page += 1) {
      const query =
        cursor === null ? 'limit=2' : `limit=2&afterPosition=${cursor.position}&afterId=${cursor.id}`;
      const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products?${query}`);
      const products = reply.body['products'] as { id: string }[];
      seen.push(...products.map((p) => p.id));
      cursor = reply.body['nextCursor'] as { position: number; id: string } | null;
      if (cursor === null) break;
    }

    assert.equal(seen.length, 7, 'every active product, once');
    assert.equal(new Set(seen).size, 7, 'no product appeared on two pages');
  });

  it('refuses half a cursor', async () => {
    const half = await call(api, 'GET', `/api/storefront/${SLUG}/products?afterId=${CATALOGUE.juice}`);
    assert.equal(half.status, 400);
    assert.equal(half.body['code'], 'INVALID_CURSOR');
  });
});

// ---------------------------------------------------------------------------
describe('search', () => {
  const find = async (q: string): Promise<string[]> => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products?q=${encodeURIComponent(q)}&limit=50`);
    assert.equal(reply.status, 200);
    return (reply.body['products'] as { name: string }[]).map((p) => p.name);
  };

  it('matches a whole word and a prefix of one', async () => {
    assert.deepEqual(await find('juice'), ['Passion Juice']);
    assert.deepEqual(await find('jui'), ['Passion Juice']);
    assert.deepEqual(await find('PASSION'), ['Passion Juice'], 'case does not matter');
  });

  it('matches a word anywhere in the name, not just the start', async () => {
    assert.deepEqual(await find('tee'), ['Linen Tee']);
  });

  it('requires every word', async () => {
    assert.deepEqual(await find('chicken burger'), ['Chicken Burger']);
    assert.deepEqual(await find('chicken water'), []);
  });

  it('does NOT match the middle of a word — the documented departure from the board', async () => {
    // ILIKE '%uice%' would have found Passion Juice. V018's section 6 has the measurement that made this
    // a word-prefix search instead, and this test exists so the change is visible rather than surprising.
    assert.deepEqual(await find('uice'), []);
  });

  it('never matches a draft', async () => {
    assert.deepEqual(await find('unreleased'), []);
  });

  it('treats tsquery operators as text', async () => {
    // to_tsquery would read these as operators. They arrive as data, so the worst case is no match.
    for (const term of ['salt & pepper', 'juice | water', '!juice', 'juice <-> fresh', '(juice', "it's", '\\']) {
      const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products?q=${encodeURIComponent(term)}`);
      assert.equal(reply.status, 200, `"${term}" must not be a server error`);
    }
  });

  it('a search of nothing but punctuation is not a search', async () => {
    // Every word is stripped, so this is a plain browse rather than a search for the empty string.
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products?q=${encodeURIComponent('...')}&limit=50`);
    assert.equal((reply.body['products'] as unknown[]).length, 7);
  });

  it('refuses a term longer than a search', async () => {
    const long = await call(api, 'GET', `/api/storefront/${SLUG}/products?q=${'a'.repeat(200)}`);
    assert.equal(long.status, 400);
    assert.equal(long.body['code'], 'QUERY_TOO_LONG');
  });
});

// ---------------------------------------------------------------------------
describe('one product', () => {
  it('carries its groups and its whole variant matrix', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.tee}`);
    assert.equal(reply.status, 200);
    const product = reply.body['product'] as Record<string, unknown>;

    const groups = product['groups'] as { name: string; selectMode: string; values: unknown[] }[];
    assert.deepEqual(groups.map((g) => g.name), ['Size', 'Colour']);
    assert.equal(groups[0]?.selectMode, 'one');

    const variants = product['variants'] as { optionValueIds: string[]; stockQuantity: number }[];
    assert.equal(variants.length, 4, 'two sizes times two colours');
    // Each variant names one value from EVERY pick-one group — V003's matrix rule.
    for (const variant of variants) assert.equal(variant.optionValueIds.length, 2);
    assert.equal(
      variants.filter((v) => v.stockQuantity === 0).length,
      1,
      'exactly one combination is out of stock, and the others are not',
    );
  });

  it('a pick-several group is not a variant dimension', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.burger}`);
    const product = reply.body['product'] as Record<string, unknown>;
    const groups = product['groups'] as { name: string; selectMode: string }[];
    assert.deepEqual(groups.map((g) => g.selectMode), ['several']);
    // One default variant, despite the group having two values: extras multiply nothing.
    assert.equal((product['variants'] as unknown[]).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe('reviews', () => {
  it('hides the average below three reviews, then shows it', async () => {
    const summary = async (): Promise<Record<string, unknown>> => {
      const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.tee}`);
      return reply.body['rating'] as Record<string, unknown>;
    };

    assert.equal((await summary())['reviewCount'], 0);
    assert.equal((await summary())['averageRating'], null, 'no reviews is not an average of zero');

    // Written straight to the table, through the same purchase trigger an endpoint would hit: three
    // lines of the tee on a delivered order, one review each.
    //
    // The order and its lines commit TOGETHER, because V004 requires an order to have at least one line
    // and checks it at commit. The reviews are posted afterwards, one at a time, because watching the
    // threshold cross is the whole point of the test.
    const ORDER = 'eeeeeeee-0000-4000-8000-000000000141';
    const ratings = [5, 4, 3];
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key, customer_user_id,
                             delivery_address, fulfilment_type, status, payment_method, currency, subtotal_amount)
              VALUES ($1, $2, 9002, 'trk_reviews_1', 'idem_reviews_threshold_0001', $3,
                      'KG 11 Ave', 'delivery', 'delivered', 'cash', 'RWF', 54000)`,
        [ORDER, STORE.a, USER.customerA],
      );
      for (const index of ratings.keys()) {
        await tx.query(
          `INSERT INTO order_items (id, order_id, store_id, variant_id, product_name, unit_price_amount, quantity)
                VALUES ($1, $2, $3, $4, 'Linen Tee', 18000, 1)`,
          [`eeeeeeee-0000-4000-8000-00000000041${index}`, ORDER, STORE.a, 'eeeeeeee-0000-4000-8000-000000000300'],
        );
      }
    });

    for (const [index, rating] of ratings.entries()) {
      const itemId = `eeeeeeee-0000-4000-8000-00000000041${index}`;
      await sql(`SELECT post_review($1, $2, $3, $4)`, [itemId, USER.customerA, rating, `Review ${index}`]);

      const now = await summary();
      assert.equal(now['reviewCount'], index + 1);
      if (index < 2) {
        assert.equal(now['averageRating'], null, `${index + 1} reviews is still too few for an average`);
      } else {
        // (5 + 4 + 3) / 3 = 4.0, and it arrives as a STRING for the same reason money does.
        assert.equal(now['averageRating'], '4.0');
      }
    }
  });

  it('a hidden review counts for nothing', async () => {
    const before = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.tee}`);
    const countBefore = (before.body['rating'] as Record<string, unknown>)['reviewCount'] as number;
    const listBefore = (before.body['reviews'] as unknown[]).length;

    const { rows } = await sql<{ id: string }>(
      `SELECT id FROM reviews WHERE product_id = $1 ORDER BY created_at LIMIT 1`,
      [CATALOGUE.tee],
    );
    const reviewId = rows[0]?.id;
    assert.ok(reviewId !== undefined);

    const report = await sql<{ id: string }>(
      `SELECT report_review($1, $2, 'spam', 'testing') AS id`,
      [reviewId, USER.customerA],
    );
    await sql(`SELECT moderate_review($1, $2, 'uphold', 'testing')`, [report.rows[0]?.id, USER.superAdmin]);

    const after2 = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.tee}`);
    assert.equal((after2.body['rating'] as Record<string, unknown>)['reviewCount'], countBefore - 1);
    assert.equal((after2.body['reviews'] as unknown[]).length, listBefore - 1);
    // And it drops back below the threshold, so the average disappears again.
    assert.equal((after2.body['rating'] as Record<string, unknown>)['averageRating'], null);
  });

  it('shows the first name only', async () => {
    const reply = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.tee}`);
    for (const review of reply.body['reviews'] as { author: string }[]) {
      assert.equal(review.author, 'Customer', 'Customer A becomes Customer');
      assert.equal(review.author.includes(' '), false);
    }
  });

  it('tells an anonymous visitor to sign in, and a customer whether they have anything to review', async () => {
    const anon = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.juice}`);
    assert.deepEqual(anon.body['write'], { can: false, reason: 'needsSignIn' });

    const token = tokenFor(USER.customerA);
    const canReview = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.juice}`, { token });
    assert.equal((canReview.body['write'] as Record<string, unknown>)['can'], true);

    // The burger was never bought, so there is nothing of it to review.
    const cannot = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.burger}`, { token });
    assert.deepEqual(cannot.body['write'], { can: false, reason: 'nothingToReview' });
  });

  it('posts one, and a retry returns the same review rather than an error', async () => {
    const token = tokenFor(USER.customerA);
    const before = await countReviews(CATALOGUE.juice);

    const first = await call(api, 'POST', `/api/storefront/${SLUG}/products/${CATALOGUE.juice}/reviews`, {
      token,
      body: { rating: 5, body: 'Fresh and cold.' },
    });
    assert.equal(first.status, 201);
    const posted = first.body['review'] as Record<string, unknown>;
    assert.equal(posted['rating'], 5);

    // THE RETRY. Same request again — as a client whose response was lost would send it.
    const retry = await call(api, 'POST', `/api/storefront/${SLUG}/products/${CATALOGUE.juice}/reviews`, {
      token,
      body: { rating: 1, body: 'completely different text' },
    });
    assert.equal(retry.status, 200, 'nothing was created, so not a 201');
    const again = retry.body['review'] as Record<string, unknown>;
    assert.equal(again['id'], posted['id'], 'the same review comes back');
    // Their ORIGINAL words, because V009 makes a review immutable: "What the customer wrote is theirs."
    assert.equal(again['rating'], 5);
    assert.equal(again['body'], 'Fresh and cold.');

    assert.equal(await countReviews(CATALOGUE.juice), before + 1, 'exactly one review exists');

    // And the gate now says so, with the id, so the page can point at what they wrote.
    const gate = await call(api, 'GET', `/api/storefront/${SLUG}/products/${CATALOGUE.juice}`, { token });
    const write = gate.body['write'] as Record<string, unknown>;
    assert.equal(write['can'], false);
    assert.equal(write['reason'], 'alreadyReviewed');
    assert.equal(write['reviewId'], posted['id']);
  });

  it('refuses a review from somebody who is not this store’s customer', async () => {
    // A merchant's own staff session is not a customer of the shop.
    const staff = tokenFor(USER.ownerA);
    const refused = await call(api, 'POST', `/api/storefront/${SLUG}/products/${CATALOGUE.juice}/reviews`, {
      token: staff,
      body: { rating: 5 },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body['code'], 'NOT_A_CUSTOMER');
  });

  it('refuses a review with no session at all, and a rating outside one to five', async () => {
    const anon = await call(api, 'POST', `/api/storefront/${SLUG}/products/${CATALOGUE.juice}/reviews`, {
      body: { rating: 5 },
    });
    assert.equal(anon.status, 401);

    const token = tokenFor(USER.customerA);
    for (const rating of [0, 6, 2.5, -1, 'five']) {
      const bad = await call(api, 'POST', `/api/storefront/${SLUG}/products/${CATALOGUE.burger}/reviews`, {
        token,
        body: { rating },
      });
      assert.equal(bad.status, 400, `rating ${String(rating)} must be refused`);
      assert.equal(bad.body['code'], 'INVALID_RATING');
    }
  });

  it('cannot review a product with no arrived order behind it', async () => {
    const token = tokenFor(USER.customerA);
    const refused = await call(api, 'POST', `/api/storefront/${SLUG}/products/${CATALOGUE.burger}/reviews`, {
      token,
      body: { rating: 5 },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body['code'], 'NOTHING_TO_REVIEW');
  });
});

// ---------------------------------------------------------------------------
describe('the cart', () => {
  it('answers with an empty cart for a shopper who has never added anything', async () => {
    const fresh = await boot();
    const reply = await call(fresh, 'GET', `/api/storefront/${SLUG}/cart`);
    assert.equal(reply.status, 200);
    const cart = reply.body['cart'] as Record<string, unknown>;
    assert.equal(cart['id'], null, 'no row is created to describe emptiness');
    assert.equal(cart['itemCount'], 0);
    assert.equal(cart['subtotal'], '0.00');
    // And no cookie was issued: a visitor who only browses is not tracked.
    assert.equal(fresh.cookies.has('vf_shopper'), false);
    await fresh.close();
  });

  it('issues the shopper cookie on the first write, and prices the line from the server', async () => {
    const shopper = await boot();
    const added = await call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, {
      body: { variantId: 'eeeeeeee-0000-4000-8000-000000000311', optionValueIds: ['eeeeeeee-0000-4000-8000-000000000220'], quantity: 2 },
    });
    assert.equal(added.status, 201);
    assert.equal(shopper.cookies.has('vf_shopper'), true, 'the cookie appears on the first write');

    const cart = added.body['cart'] as Record<string, unknown>;
    const lines = cart['lines'] as Record<string, unknown>[];
    assert.equal(lines.length, 1);
    // 3,500 + 500 for the cheese, times two. Computed in SQL from the product and the option, because
    // V003 stores no price on a cart line.
    assert.equal(lines[0]?.['unitPrice'], '4000.00');
    assert.equal(lines[0]?.['lineTotal'], '8000.00');
    assert.deepEqual(lines[0]?.['optionLabels'], ['Extra cheese']);
    assert.equal(cart['subtotal'], '8000.00');
    assert.equal(cart['itemCount'], 2);
    await shopper.close();
  });

  it('merges an identical line and keeps a different choice apart', async () => {
    const shopper = await boot();
    const variant = 'eeeeeeee-0000-4000-8000-000000000311';
    const cheese = 'eeeeeeee-0000-4000-8000-000000000220';
    const chilli = 'eeeeeeee-0000-4000-8000-000000000221';

    const add = (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
      call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, { body });

    await add({ variantId: variant, optionValueIds: [cheese] });
    const second = await add({ variantId: variant, optionValueIds: [cheese] });
    assert.equal((second.body['line'] as Record<string, unknown>)['created'], false, 'merged');
    assert.equal((second.body['line'] as Record<string, unknown>)['quantity'], 2);

    // Order and duplicates must not make a different line.
    const third = await add({ variantId: variant, optionValueIds: [cheese, cheese] });
    assert.equal((third.body['line'] as Record<string, unknown>)['quantity'], 3);

    // A different option set IS a different line.
    const other = await add({ variantId: variant, optionValueIds: [chilli, cheese] });
    assert.equal((other.body['line'] as Record<string, unknown>)['created'], true);

    // And no options at all is a third.
    const plain = await add({ variantId: variant });
    assert.equal((plain.body['line'] as Record<string, unknown>)['created'], true);

    const cart = plain.body['cart'] as Record<string, unknown>;
    assert.equal((cart['lines'] as unknown[]).length, 3);
    assert.equal(cart['itemCount'], 5, '3 + 1 + 1');
    await shopper.close();
  });

  it('merges twenty CONCURRENT adds into one line', async () => {
    // The case a SELECT-then-INSERT loses. V018 makes it ON CONFLICT DO UPDATE against a unique index
    // that covers the option set, so the database resolves it whatever the timing.
    const shopper = await boot();
    const sessionId = 'concurrent-cart-session-000000001';
    // Prime the cookie by hand so all twenty requests are the same shopper from the first instant —
    // otherwise the first add is the one that issues it and the others race to create a cart instead.
    shopper.cookies.set('vf_shopper', sessionId);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, {
          body: { variantId: 'eeeeeeee-0000-4000-8000-000000000310', quantity: 1 },
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status !== 201).length, 0, 'none of them failed');

    const lines = await cartLines(STORE.a, sessionId);
    assert.equal(lines.length, 1, 'one line, not twenty');
    assert.equal(lines[0]?.quantity, 20, 'every add counted');
    await shopper.close();
  });

  it('refuses what cannot be bought, with a sentence a shopper can act on', async () => {
    const shopper = await boot();
    const add = (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
      call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, { body });

    // A withdrawn variant.
    const wrap = await add({ variantId: 'eeeeeeee-0000-4000-8000-000000000312' });
    assert.equal(wrap.status, 409);
    assert.equal(wrap.body['code'], 'INSUFFICIENT_STOCK');
    assert.match(String(wrap.body['error']), /sold out/i);

    // A variant counted down to nothing.
    const soldOut = await add({ variantId: 'eeeeeeee-0000-4000-8000-000000000303' });
    assert.equal(soldOut.status, 409);
    assert.equal(soldOut.body['code'], 'INSUFFICIENT_STOCK');

    // A draft product's variant.
    const draft = await add({ variantId: 'eeeeeeee-0000-4000-8000-000000000314' });
    assert.equal(draft.status, 409);

    // Another store's variant: the message says the page is stale, and the hint says to reload.
    const { rows } = await sql<{ id: string }>(
      `INSERT INTO products (store_id, name, base_price, status) VALUES ($1, 'Other Thing', 100, 'active') RETURNING id`,
      [STORE.b],
    );
    const otherProduct = rows[0]?.id;
    const otherVariant = await sql<{ id: string }>(
      `INSERT INTO product_variants (product_id, store_id, is_default) VALUES ($1, $2, true) RETURNING id`,
      [otherProduct, STORE.b],
    );
    const foreign = await add({ variantId: otherVariant.rows[0]?.id });
    assert.equal(foreign.status, 409);
    assert.equal(foreign.body['code'], 'STALE_CATALOGUE');
    assert.match(String(foreign.body['hint']), /Reload the page/);

    await shopper.close();
  });

  it('refuses a pick-one value sent as an extra', async () => {
    // The single-select choices ARE the variant, so repeating one as an extra would price it twice.
    const shopper = await boot();
    const refused = await call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, {
      body: {
        variantId: 'eeeeeeee-0000-4000-8000-000000000300',
        optionValueIds: ['eeeeeeee-0000-4000-8000-000000000200'],
      },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body['code'], 'STALE_CATALOGUE');
    await shopper.close();
  });

  it('refuses a quantity outside one to 999, and a malformed variant', async () => {
    const shopper = await boot();
    const variant = 'eeeeeeee-0000-4000-8000-000000000310';
    for (const quantity of [0, -1, 1000, 1.5]) {
      const bad = await call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, {
        body: { variantId: variant, quantity },
      });
      assert.equal(bad.status, 400, `quantity ${quantity}`);
      assert.equal(bad.body['code'], 'INVALID_QUANTITY');
    }

    const noVariant = await call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, { body: {} });
    assert.equal(noVariant.status, 400);
    assert.equal(noVariant.body['code'], 'INVALID_VARIANT');
    await shopper.close();
  });

  it('needs its CSRF token like every other write', async () => {
    const shopper = await boot();
    const refused = await call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, {
      body: { variantId: 'eeeeeeee-0000-4000-8000-000000000310' },
      csrf: false,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body['code'], 'CSRF_MISSING');
    await shopper.close();
  });

  it('one cookie, two stores, two carts', async () => {
    // carts is unique per (store, session), so the same pointer resolves to a different cart at each
    // shopfront. A shopper with a bag at two shops has two carts and one cookie.
    const shopper = await boot();
    await call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, {
      body: { variantId: 'eeeeeeee-0000-4000-8000-000000000310' },
    });
    const here = await call(shopper, 'GET', `/api/storefront/${SLUG}/cart`);
    const there = await call(shopper, 'GET', `/api/storefront/${OTHER}/cart`);

    assert.equal((here.body['cart'] as Record<string, unknown>)['itemCount'], 1);
    assert.equal((there.body['cart'] as Record<string, unknown>)['itemCount'], 0);
    assert.notEqual(
      (here.body['cart'] as Record<string, unknown>)['id'],
      (there.body['cart'] as Record<string, unknown>)['id'],
    );
    await shopper.close();
  });

  it('a signed-in customer’s cart follows the account, not the cookie', async () => {
    const token = tokenFor(USER.customerA);
    const first = await boot();
    await call(first, 'POST', `/api/storefront/${SLUG}/cart/items`, {
      token,
      body: { variantId: 'eeeeeeee-0000-4000-8000-000000000310', quantity: 3 },
    });

    // A DIFFERENT browser — no cookies at all — with the same account.
    const second = await boot();
    const reply = await call(second, 'GET', `/api/storefront/${SLUG}/cart`, { token });
    assert.equal((reply.body['cart'] as Record<string, unknown>)['itemCount'], 3, 'the cart came with them');

    await first.close();
    await second.close();
  });

  it('marks a line that sold out after it went in the cart', async () => {
    const shopper = await boot();
    const variant = 'eeeeeeee-0000-4000-8000-000000000302';
    const added = await call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, {
      body: { variantId: variant, quantity: 2 },
    });
    assert.equal(added.status, 201);

    // The shop sells the last two to somebody else.
    await sql(`UPDATE product_variants SET stock_quantity = 0 WHERE id = $1`, [variant]);
    const reread = await call(shopper, 'GET', `/api/storefront/${SLUG}/cart`);
    const lines = (reread.body['cart'] as Record<string, unknown>)['lines'] as Record<string, unknown>[];
    assert.equal(lines[0]?.['unavailable'], true, 'States.dc.html: "Sold out while you were choosing"');

    await sql(`UPDATE product_variants SET stock_quantity = 2 WHERE id = $1`, [variant]);
    await shopper.close();
  });

  it('a cart is never a hold on stock', async () => {
    // Filling a cart must not remove anything from the shelf, or anybody could empty a shop by browsing.
    const before = await sql<{ n: number }>(
      `SELECT stock_quantity AS n FROM product_variants WHERE id = $1`,
      ['eeeeeeee-0000-4000-8000-000000000302'],
    );
    const shopper = await boot();
    await call(shopper, 'POST', `/api/storefront/${SLUG}/cart/items`, {
      body: { variantId: 'eeeeeeee-0000-4000-8000-000000000302', quantity: 2 },
    });
    const after3 = await sql<{ n: number }>(
      `SELECT stock_quantity AS n FROM product_variants WHERE id = $1`,
      ['eeeeeeee-0000-4000-8000-000000000302'],
    );
    assert.equal(after3.rows[0]?.n, before.rows[0]?.n, 'reserve_stock() at checkout is the only decrement');
    await shopper.close();
  });
});
