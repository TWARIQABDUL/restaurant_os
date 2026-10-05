// server/test/api/support.test.ts — milestone 24: Complaints, Reviews and Customers over HTTP.
//
// V008 and V009 already hold the rules — every complaint move writes its own event, a review cannot be edited, a reply
// is a table of its own — and their DB suites test them. What this file tests is what the endpoints add around them:
//
//   1. A STRANGER'S ID IS A 404. reply_to_review() and resolve_complaint() take an id and nothing else, so every write
//      here checks the row is THIS store's first, and answers "not found" rather than acting on somebody else's.
//   2. A MOVE ON A COMPLAINT THAT HAS ALREADY MOVED IS A 409 NAMING WHERE IT IS NOW — two managers, one complaint.
//   3. A CUSTOMER IS A PERSON, NOT A ROW. A guest who later made an account is one customer, matched on the last nine
//      digits of the phone however it was typed.
//   4. THE EXPORT CANNOT EXECUTE. A customer who names themselves `=HYPERLINK(...)` must not run in the merchant's
//      spreadsheet.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql, withTransaction } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { STORE, USER, cleanup, seedConsole, seedFixtures, seedStorefront } from './support.ts';

// Same scheme as support.ts's own (its helper is not exported): a fixed prefix, then the number.
const uid = (n: number): string => `eeeeeeee-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
// The one catalogue variant a guest order needs: Passion Juice's default (support.ts's uid(0x310)).

let api: Api;
let complaintId = '';

const owner = (): string => tokenFor(USER.ownerA);
const manager = (): string => tokenFor(USER.managerA);
const rider = (): string => tokenFor(USER.riderA);
const otherAdmin = (): string => tokenFor(USER.adminB);

const base = `/api/stores/${STORE.a}`;
type Json = Record<string, unknown>;
const list = (v: unknown): Json[] => v as Json[];
const asJson = (v: unknown): Json => v as Json;
const STRANGER = '00000000-0000-4000-8000-000000000bad';

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  ({ complaintId } = await seedConsole());
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
});

describe('who may reach support and customers', () => {
  it('owners and managers do; a rider and another store\'s admin do not', async () => {
    for (const path of ['/reviews', '/complaints', '/customers']) {
      assert.equal((await call(api, 'GET', `${base}${path}`, { token: owner() })).status, 200, `owner ${path}`);
      assert.equal((await call(api, 'GET', `${base}${path}`, { token: manager() })).status, 200, `manager ${path}`);
      assert.equal((await call(api, 'GET', `${base}${path}`, { token: rider() })).status, 403, `rider ${path}`);
      assert.equal((await call(api, 'GET', `${base}${path}`, { token: otherAdmin() })).status, 403, `other store ${path}`);
    }
  });
});

describe('Reviews', () => {
  it('shows the figures, a page and the by-product list — with the customer shortened', async () => {
    const res = await call(api, 'GET', `${base}/reviews`, { token: owner() });
    const o = asJson(res.body['overview']);
    assert.equal(o['needsReply'], 1);
    assert.equal(o['reportedOpen'], 0);
    assert.equal(o['averageRating'], '4.0');
    const rows = list(res.body['reviews']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['product'], 'Passion Juice');
    assert.match(String(rows[0]!['customer']), /^\S+( \S\.)?$/, 'a first name and an initial, never the whole name');
    assert.equal(rows[0]!['reply'], null);
    const byProduct = list(res.body['byProduct']);
    const juice = byProduct.find((p) => p['name'] === 'Passion Juice')!;
    assert.equal(juice['count'], 1);
    assert.equal(juice['average'], null, 'one review is under the three it takes to show an average');
  });

  it('filters, replies, and lets a reply be edited', async () => {
    const id = String(list((await call(api, 'GET', `${base}/reviews`, { token: owner() })).body['reviews'])[0]!['id']);
    assert.equal(list((await call(api, 'GET', `${base}/reviews?filter=low`, { token: owner() })).body['reviews']).length, 0);
    assert.equal(list((await call(api, 'GET', `${base}/reviews?filter=reply`, { token: owner() })).body['reviews']).length, 1);

    assert.equal((await call(api, 'POST', `${base}/reviews/${id}/reply`, { token: manager(), body: { body: '   ' } })).status, 400);
    const posted = await call(api, 'POST', `${base}/reviews/${id}/reply`, { token: manager(), body: { body: 'Thanks!' } });
    assert.equal(posted.status, 200);
    const after = await call(api, 'GET', `${base}/reviews`, { token: owner() });
    assert.equal(asJson(after.body['overview'])['needsReply'], 0, 'answered, so the badge clears');
    assert.equal(list(after.body['reviews'])[0]!['reply'], 'Thanks!');
    assert.equal(list((await call(api, 'GET', `${base}/reviews?filter=reply`, { token: owner() })).body['reviews']).length, 0);

    await call(api, 'POST', `${base}/reviews/${id}/reply`, { token: owner(), body: { body: 'Thanks, Kevin!' } });
    assert.equal(list((await call(api, 'GET', `${base}/reviews`, { token: owner() })).body['reviews'])[0]!['reply'], 'Thanks, Kevin!', 'editing replaces it');
  });

  it('reports to Vendlyfy once, and the review stays visible while it is open', async () => {
    const id = String(list((await call(api, 'GET', `${base}/reviews`, { token: owner() })).body['reviews'])[0]!['id']);
    assert.equal((await call(api, 'POST', `${base}/reviews/${id}/report`, { token: owner(), body: { reason: 'because' } })).status, 400);
    assert.equal((await call(api, 'POST', `${base}/reviews/${id}/report`, { token: owner(), body: { reason: 'spam' } })).status, 200);
    assert.equal((await call(api, 'POST', `${base}/reviews/${id}/report`, { token: owner(), body: { reason: 'abusive' } })).status, 200, 'a second report is the first, not a second row');

    const res = await call(api, 'GET', `${base}/reviews`, { token: owner() });
    assert.equal(asJson(res.body['overview'])['reportedOpen'], 1);
    const row = list(res.body['reviews'])[0]!;
    assert.deepEqual(row['reported'], { reason: 'spam' }, 'still listed, and says it is reported');
    const n = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM review_reports WHERE review_id = $1`, [id]);
    assert.equal(n.rows[0]!.n, '1');
  });

  it('answers 404 for a review that is not this store\'s', async () => {
    assert.equal((await call(api, 'POST', `${base}/reviews/${STRANGER}/reply`, { token: owner(), body: { body: 'x' } })).status, 404);
    assert.equal((await call(api, 'POST', `${base}/reviews/${STRANGER}/report`, { token: owner(), body: { reason: 'spam' } })).status, 404);
    assert.equal((await call(api, 'POST', `${base}/reviews/not-a-uuid/reply`, { token: owner(), body: { body: 'x' } })).status, 400);
  });
});

describe('Complaints', () => {
  it('lists by tab with counts, in the board\'s C-nnn form', async () => {
    const res = await call(api, 'GET', `${base}/complaints`, { token: owner() });
    assert.deepEqual(res.body['counts'], { open: 1, escalated: 0, closed: 0 });
    const row = list(res.body['complaints'])[0]!;
    assert.equal(row['id'], complaintId);
    assert.match(String(row['reference']), /^C-\d{3,}$/);
    assert.equal(row['reason'], 'item_missing');
    assert.equal(row['orderNumber'], 9001);
    assert.equal(list((await call(api, 'GET', `${base}/complaints?tab=closed`, { token: owner() })).body['complaints']).length, 0);
  });

  it('reads one thread with its order beside it', async () => {
    const res = await call(api, 'GET', `${base}/complaints/${complaintId}`, { token: owner() });
    const c = asJson(res.body['complaint']);
    assert.equal(c['text'], 'The juice was not in the bag.');
    const order = asJson(c['order']);
    assert.equal(order['number'], 9001);
    assert.deepEqual(list(order['items']).map((i) => i['label']), ['1× Passion Juice']);
    assert.equal(order['total'], '1200.00');
    const timeline = list(c['timeline']);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0]!['type'], 'filed');
    assert.equal(timeline[0]!['side'], 'customer');
    assert.equal(asJson(c['customer'])['name'] !== '', true);
  });

  it('needs a note for every move, and a stranger\'s complaint is a 404', async () => {
    for (const move of ['resolve', 'reject', 'escalate']) {
      assert.equal((await call(api, 'POST', `${base}/complaints/${complaintId}/${move}`, { token: owner(), body: { note: '  ' } })).status, 400, move);
    }
    assert.equal((await call(api, 'POST', `${base}/complaints/${STRANGER}/reject`, { token: owner(), body: { note: 'x' } })).status, 404);
    assert.equal((await call(api, 'GET', `${base}/complaints/${STRANGER}`, { token: owner() })).status, 404);
    assert.equal((await call(api, 'POST', `${base}/complaints/${complaintId}/reopen`, { token: owner() })).status, 409, 'an open complaint cannot be reopened');
  });

  it('rejects, which the customer may then reopen, and the thread keeps all of it', async () => {
    const rejected = await call(api, 'POST', `${base}/complaints/${complaintId}/reject`, { token: manager(), body: { note: 'Our packing photo shows the juice.' } });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(asJson(rejected.body['complaint'])['status'], 'rejected');
    assert.deepEqual((await call(api, 'GET', `${base}/complaints`, { token: owner() })).body['counts'], { open: 0, escalated: 0, closed: 1 });

    const again = await call(api, 'POST', `${base}/complaints/${complaintId}/reject`, { token: owner(), body: { note: 'second' } });
    assert.equal(again.status, 409);
    assert.equal(again.body['code'], 'COMPLAINT_CHANGED');
    assert.match(String(again.body['error']), /rejected/);

    const reopened = await call(api, 'POST', `${base}/complaints/${complaintId}/reopen`, { token: owner() });
    assert.equal(reopened.status, 200);
    const thread = list(asJson(reopened.body['complaint'])['timeline']).map((e) => e['type']);
    assert.deepEqual(thread, ['filed', 'rejected', 'reopened']);
  });

  it('resolves with a refund REQUEST — nothing leaves the wallet — and refuses a second resolution', async () => {
    const res = await call(api, 'POST', `${base}/complaints/${complaintId}/resolve`, { token: owner(), body: { note: 'Sorry, we will send it again.', refundAmount: '500' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const c = asJson(res.body['complaint']);
    assert.equal(c['status'], 'resolved');
    assert.equal(c['pendingRefund'], '500.00');
    const refund = await sql<{ status: string; amount: string }>(`SELECT status, amount::text FROM refunds WHERE complaint_id = $1`, [complaintId]);
    assert.deepEqual(refund.rows, [{ status: 'pending', amount: '500.00' }]);
    const wallet = await sql<{ a: string; p: string }>(`SELECT available_balance::text AS a, pending_balance::text AS p FROM wallets WHERE store_id = $1`, [STORE.a]);
    assert.deepEqual(wallet.rows[0], { a: '0.00', p: '0.00' }, 'a request moves no money');

    const twice = await call(api, 'POST', `${base}/complaints/${complaintId}/resolve`, { token: manager(), body: { note: 'also resolved' } });
    assert.equal(twice.status, 409);
  });

  it('escalates a reopened complaint, and refuses a bad refund amount', async () => {
    await call(api, 'POST', `${base}/complaints/${complaintId}/reopen`, { token: owner() });
    assert.equal((await call(api, 'POST', `${base}/complaints/${complaintId}/resolve`, { token: owner(), body: { note: 'x', refundAmount: '-5' } })).status, 400);
    assert.equal((await call(api, 'POST', `${base}/complaints/${complaintId}/resolve`, { token: owner(), body: { note: 'x', refundAmount: 'lots' } })).status, 400);

    const esc = await call(api, 'POST', `${base}/complaints/${complaintId}/escalate`, { token: owner(), body: { note: 'We disagree on what was delivered.' } });
    assert.equal(esc.status, 200, JSON.stringify(esc.body));
    assert.equal(asJson(esc.body['complaint'])['status'], 'escalated');
    assert.deepEqual((await call(api, 'GET', `${base}/complaints`, { token: owner() })).body['counts'], { open: 0, escalated: 1, closed: 0 });
    assert.equal((await call(api, 'POST', `${base}/complaints/${complaintId}/reopen`, { token: owner() })).status, 409, 'with Vendlyfy now: not the merchant\'s to reopen');
  });
});

describe('Customers', () => {
  const guestOrder = async (id: string, number: number, name: string, phone: string, status: string, total: number, hoursAgo: number): Promise<void> => {
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key, guest_name, guest_phone,
                             delivery_address, fulfilment_type, status, payment_method, payment_status, currency, subtotal_amount, placed_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, 'KG 11 Ave, Kigali', 'delivery', $8, 'cash', 'unpaid', 'RWF', $9, now() - make_interval(hours => $10))`,
        [id, STORE.a, number, `trk_cust_${number}`, `idem_customers_test_${number}`, name, phone, status, total, hoursAgo],
      );
      await tx.query(
        `INSERT INTO order_items (order_id, store_id, variant_id, product_name, unit_price_amount, quantity) VALUES ($1, $2, $3, 'Passion Juice', $4, 1)`,
        [id, STORE.a, uid(0x310), total],
      );
    });
  };

  before(async () => {
    // One person, three spellings of one number, over three orders — and one order turned away.
    await guestOrder(uid(0x600), 9701, 'Sandrine Keza', '+250 78 543 6671', 'delivered', 8000, 30);
    await guestOrder(uid(0x601), 9702, 'Sandrine Keza', '0785436671', 'delivered', 5000, 20);
    await guestOrder(uid(0x602), 9703, 'Sandrine K.', '250785436671', 'pending', 3000, 10);
    await guestOrder(uid(0x603), 9704, 'Sandrine Keza', '078 543 6671', 'rejected', 9000, 5);
    // A different guest, and one whose name is a spreadsheet formula.
    await guestOrder(uid(0x604), 9705, 'Aimable Kayitare', '078 330 1180', 'delivered', 1500, 3);
    await guestOrder(uid(0x605), 9706, '=HYPERLINK("http://evil.example","x")', '078 990 0000', 'delivered', 2000, 2);
    // The account holder gives a phone — and a guest order from the same number joins them.
    await sql(`UPDATE users SET phone = '+250 78 111 2222', name = 'Grace Ingabire' WHERE id = $1`, [USER.customerA]);
    await guestOrder(uid(0x607), 9707, 'Grace I', '0781112222', 'delivered', 4000, 1);
  });

  it('is one row per PERSON: three spellings of a number, and a guest who made an account', async () => {
    const res = await call(api, 'GET', `${base}/customers`, { token: owner() });
    const rows = list(res.body['rows']);
    const sandrine = rows.filter((r) => String(r['name']).startsWith('Sandrine'));
    assert.equal(sandrine.length, 1, 'one Sandrine, not three');
    assert.equal(sandrine[0]!['orders'], 3, 'the rejected order is not an order');
    assert.equal(Number(sandrine[0]!['spent']), 13000, 'only what was delivered counts as spent — the pending one is a promise');
    assert.equal(sandrine[0]!['account'], false);

    const grace = rows.filter((r) => r['name'] === 'Grace Ingabire');
    assert.equal(grace.length, 1);
    assert.equal(grace[0]!['account'], true, 'once they have an account they are an Account');
    assert.equal(grace[0]!['orders'], 2, 'the account\'s order and the guest order from the same number');
  });

  it('counts the segments for the whole store, whatever is searched', async () => {
    const all = await call(api, 'GET', `${base}/customers`, { token: owner() });
    const counts = asJson(all.body['counts']);
    assert.ok(Number(counts['all']) >= 4);
    assert.ok(Number(counts['account']) >= 1 && Number(counts['guest']) >= 3);
    assert.equal(Number(counts['account']) + Number(counts['guest']), Number(counts['all']));

    const guests = await call(api, 'GET', `${base}/customers?segment=guest`, { token: owner() });
    assert.ok(list(guests.body['rows']).every((r) => r['account'] === false));
    assert.deepEqual(guests.body['counts'], counts, 'a segment filter does not change the pills');

    const regular = await call(api, 'GET', `${base}/customers?segment=regular`, { token: owner() });
    assert.ok(list(regular.body['rows']).every((r) => Number(r['orders']) >= 5));
  });

  it('searches by name, and by phone digits however the number was typed', async () => {
    const byName = await call(api, 'GET', `${base}/customers?q=kayitare`, { token: owner() });
    // Two different people with one name (the console fixtures' Aimable, and this suite's): two rows, not one.
    assert.deepEqual(list(byName.body['rows']).map((r) => r['name']), ['Aimable Kayitare', 'Aimable Kayitare']);
    assert.notEqual(list(byName.body['rows'])[0]!['phone'], list(byName.body['rows'])[1]!['phone'], 'told apart by their numbers');
    const byPhone = await call(api, 'GET', `${base}/customers?q=${encodeURIComponent('078 543')}`, { token: owner() });
    assert.equal(list(byPhone.body['rows']).length, 1);
    assert.equal(byPhone.body['total'], 1);
    assert.equal(list((await call(api, 'GET', `${base}/customers?q=zzzz`, { token: owner() })).body['rows']).length, 0);
    assert.equal(list((await call(api, 'GET', `${base}/customers?q=%25`, { token: owner() })).body['rows']).length, 0, 'a wildcard is text');
  });

  it('shows one customer: usual address, recent orders, and a private note that can be set and removed', async () => {
    const key = '785436671';
    const res = await call(api, 'GET', `${base}/customers/${key}`, { token: owner() });
    assert.equal(res.status, 200);
    const c = asJson(res.body['customer']);
    assert.equal(c['usualAddress'], 'KG 11 Ave, Kigali');
    assert.equal(list(c['recent']).length, 3, 'three recent orders, newest first, including the rejected one');
    assert.equal(c['note'], null);

    assert.equal((await call(api, 'PUT', `${base}/customers/${key}/note`, { token: manager(), body: { note: 'Allergic to peanuts' } })).status, 200);
    assert.equal(asJson((await call(api, 'GET', `${base}/customers/${key}`, { token: owner() })).body['customer'])['note'], 'Allergic to peanuts');
    assert.equal((await call(api, 'PUT', `${base}/customers/${key}/note`, { token: owner(), body: { note: '   ' } })).status, 200);
    assert.equal(asJson((await call(api, 'GET', `${base}/customers/${key}`, { token: owner() })).body['customer'])['note'], null, 'an empty note removes it');
    const rows = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM customer_notes WHERE store_id = $1`, [STORE.a]);
    assert.equal(rows.rows[0]!.n, '0');

    assert.equal((await call(api, 'GET', `${base}/customers/123456789`, { token: owner() })).status, 404);
    assert.equal((await call(api, 'GET', `${base}/customers/not-a-key`, { token: owner() })).status, 400);
    assert.equal((await call(api, 'PUT', `${base}/customers/123456789/note`, { token: owner(), body: { note: 'x' } })).status, 404);
    assert.equal((await call(api, 'PUT', `${base}/customers/${key}/note`, { token: owner(), body: { note: 'x'.repeat(501) } })).status, 400);
  });

  it('exports CSV that cannot run a formula in the merchant\'s spreadsheet', async () => {
    const res = await fetch(`${api.baseUrl}${base}/customers/export`, { headers: { Authorization: `Bearer ${owner()}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    const text = await res.text();
    assert.ok(text.startsWith('"Name","Phone","Orders","Spent","Last order","Type","Complaints"'));
    assert.ok(text.includes(`"'=HYPERLINK(""http://evil.example"",""x"")"`), 'a formula is defused with an apostrophe and its quotes doubled');
    assert.ok(!text.includes(`,"=HYPERLINK`) && !text.includes(`\r\n"=HYPERLINK`), 'and never appears as a bare formula');
    assert.equal((await fetch(`${api.baseUrl}${base}/customers/export`, { headers: { Authorization: `Bearer ${rider()}` } })).status, 403);
  });
});
