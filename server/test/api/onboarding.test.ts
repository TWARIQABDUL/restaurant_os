// server/test/api/onboarding.test.ts — milestone 26: a stranger becomes a merchant.
//
//   1. ONE TRANSACTION. A refused sign-up — email taken, address taken, a business type that does not exist — leaves NO
//      user and NO store behind. An account with no store, or a store with no owner, is a state nobody can leave.
//   2. IT SIGNS THE NEW OWNER IN, and what they get is the owner role at a live store with the business type pinned, Cash
//      connected and a wallet — and the console's own endpoints answer them.
//   3. STORE ADDRESSES: derived from the name, unique, never reserved.
//   4. THE PASSWORD FLOOR is ten characters, as for staff.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { slugify } from '../../src/repositories/onboarding.ts';
import { boot, call } from './client.ts';
import type { Api } from './client.ts';

let api: Api;
const DOMAIN = 'onboarding.test';
const SLUG = 'ob-test-';

type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => v as Json;

async function teardown(): Promise<void> {
  const stores = `(SELECT id FROM stores WHERE slug LIKE '${SLUG}%')`;
  await sql(`DELETE FROM store_payment_methods WHERE store_id IN ${stores}`);
  await sql(`DELETE FROM store_members WHERE store_id IN ${stores}`);
  await sql(`DELETE FROM users WHERE email LIKE '%@${DOMAIN}'`);
  await sql(`DELETE FROM wallets WHERE store_id IN ${stores}`);
  await sql(`DELETE FROM stores WHERE slug LIKE '${SLUG}%'`);
}

const counts = async (): Promise<[number, number]> => [
  Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM users WHERE email LIKE '%@${DOMAIN}'`)).rows[0]!.n),
  Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM stores WHERE slug LIKE '${SLUG}%'`)).rows[0]!.n),
];

const signup = (over: Json = {}): Promise<{ status: number; body: Json }> =>
  call(api, 'POST', '/api/onboarding', {
    body: { name: 'Aline Uwase', email: `aline@${DOMAIN}`, password: 'a-long-enough-password', businessName: 'Ob Test Nyama', slug: `${SLUG}nyama`, templateKey: 'food', ...over },
  });

before(async () => {
  api = await boot();
  await teardown();
});

after(async () => {
  await teardown();
  await api.close();
  await closePool();
});

describe('what a new merchant can pick and where they land', () => {
  it('offers the published business types and not the draft one', async () => {
    const r = await call(api, 'GET', '/api/onboarding/templates');
    assert.equal(r.status, 200);
    const keys = (r.body['templates'] as Json[]).map((t) => t['key']);
    assert.ok(keys.includes('food') && keys.includes('fashion'));
    assert.ok(!keys.includes('pharmacy'), 'a draft template is not offered');
  });

  it('derives a store address from the name, and never offers a reserved or a taken one', async () => {
    assert.equal(slugify('Nyama & Co.'), 'nyama-and-co');
    assert.equal(slugify('  Café   Müller  '), 'cafe-muller');
    assert.equal(slugify('日本'), '');
    const free = asJson((await call(api, 'GET', '/api/onboarding/slug?name=Ob%20Zebra%20Shop')).body);
    assert.deepEqual([free['slug'], free['available']], ['ob-zebra-shop', true]);
    const reserved = asJson((await call(api, 'GET', '/api/onboarding/slug?name=Dashboard')).body);
    assert.notEqual(reserved['slug'], 'dashboard');
    const nothing = asJson((await call(api, 'GET', '/api/onboarding/slug?name=%E6%97%A5%E6%9C%AC')).body);
    assert.equal(nothing['available'], false);
  });
});

describe('creating the account and the store', () => {
  it('makes an owner at a live store, pinned to the business type, with Cash on and a wallet — and signs them in', async () => {
    const r = await signup();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body['slug'], `${SLUG}nyama`);
    assert.ok(api.cookies.has('vendlyfy_session') || [...api.cookies.keys()].some((k) => /session|token/i.test(k)), 'a session cookie was set');

    const store = (await sql<{ status: string; country: string; selling_currency: string; t: string | null }>(
      `SELECT s.status, s.country, s.selling_currency, t.key AS t FROM stores s LEFT JOIN industry_templates t ON t.id = s.industry_template_id WHERE s.slug = $1`, [`${SLUG}nyama`])).rows[0]!;
    assert.deepEqual([store.status, store.country, store.selling_currency, store.t], ['active', 'RW', 'RWF', 'food']);

    const parts = (await sql<{ role: string; wallet: string; cash: boolean }>(
      `SELECT m.role, (SELECT count(*) FROM wallets w WHERE w.store_id = s.id)::text AS wallet,
              EXISTS (SELECT 1 FROM store_payment_methods p WHERE p.store_id = s.id AND p.payment_method_key = 'cash' AND p.is_connected) AS cash
         FROM stores s JOIN store_members m ON m.store_id = s.id WHERE s.slug = $1`, [`${SLUG}nyama`])).rows;
    assert.deepEqual(parts.map((p) => [p.role, p.wallet, p.cash]), [['owner', '1', true]]);

    // The cookie alone opens the new owner's console.
    const session = await call(api, 'GET', '/api/session');
    assert.equal(session.status, 200, JSON.stringify(session.body));
    const memberships = session.body['memberships'] as Json[];
    assert.deepEqual(memberships.map((m) => [m['slug'], m['role']]), [[`${SLUG}nyama`, 'owner']]);
    const settings = await call(api, 'GET', `/api/stores/${r.body['storeId']}/settings/extra`);
    assert.equal(settings.status, 200, 'the owner can open Settings');
  });

  it('stores a password that signs in', async () => {
    const hash = (await sql<{ password_hash: string }>(`SELECT password_hash FROM users WHERE email = $1`, [`aline@${DOMAIN}`])).rows[0]!.password_hash;
    assert.ok(hash.startsWith('$2'), 'bcrypt, not the password');
    assert.ok(!hash.includes('a-long-enough-password'));
  });
});

describe('a refused sign-up leaves nothing behind', () => {
  it('an email that already has an account → 409, no second store', async () => {
    const before = await counts();
    const r = await signup({ slug: `${SLUG}other`, businessName: 'Ob Test Other' });
    assert.equal(r.status, 409);
    assert.equal(r.body['code'], 'EMAIL_TAKEN');
    assert.deepEqual(await counts(), before);
  });

  it('an address that is taken → 409, and the account that would have owned it is not created', async () => {
    const before = await counts();
    const r = await signup({ email: `second@${DOMAIN}` });
    assert.equal(r.status, 409);
    assert.equal(r.body['code'], 'SLUG_TAKEN');
    assert.deepEqual(await counts(), before, 'no user either');
  });

  it('a business type that does not exist, or is only a draft → 400, nothing created', async () => {
    const before = await counts();
    for (const templateKey of ['made-up', 'pharmacy']) {
      const r = await signup({ email: `third@${DOMAIN}`, slug: `${SLUG}third`, templateKey });
      assert.equal(r.status, 400, templateKey);
    }
    assert.deepEqual(await counts(), before);
  });

  it('a reserved address → 400', async () => {
    const r = await signup({ email: `fourth@${DOMAIN}`, slug: 'dashboard' });
    assert.equal(r.status, 400);
  });

  it('a short password → 400, and a malformed email → 400', async () => {
    assert.equal((await signup({ email: `fifth@${DOMAIN}`, slug: `${SLUG}fifth`, password: 'short' })).status, 400);
    assert.equal((await signup({ email: 'not-an-email', slug: `${SLUG}sixth` })).status, 400);
  });
});

describe('a store with no business type', () => {
  it('is allowed — "Other" — and starts with no template', async () => {
    const r = await signup({ email: `other@${DOMAIN}`, slug: `${SLUG}other`, businessName: 'Ob Test Other', templateKey: null });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const t = (await sql<{ industry_template_id: string | null }>(`SELECT industry_template_id FROM stores WHERE slug = $1`, [`${SLUG}other`])).rows[0]!;
    assert.equal(t.industry_template_id, null);
  });
});
