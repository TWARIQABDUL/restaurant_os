// server/test/api/config.test.ts — milestone 12.
//
// The done-when, first: "Switching a store's template changes vocabulary and feature gates
// through one API call."
//
// Then the things that make it trustworthy: the ETag, the override merge, a store with no
// template, and the two refusals that would otherwise be silent.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { STORE, USER, cleanup, seedFixtures } from './support.ts';

let api: Api;
let owner = '';

/** Fixture store A's slug, from support.ts. */
const SLUG = 'escalation-store-a';

type Payload = {
  store: { id: string; slug: string; name: string };
  config: {
    template: { key: string; name: string; accentColor: string; version: number } | null;
    words: Record<string, { many: string; one: string; source: string; derived: boolean }>;
    modules: Record<string, { enabled: boolean; source: string; label: string }>;
    attributes: { name: string; pick: string; priced?: boolean }[];
    orderSteps: { key: string; label: string }[];
    productFlags: string[];
  };
};

async function config(): Promise<{ status: number; body: Payload; etag: string | null }> {
  const res = await fetch(`${api.baseUrl}/api/storefront/${SLUG}/config`);
  const body = (await res.json()) as Payload;
  return { status: res.status, body, etag: res.headers.get('etag') };
}

async function setTemplate(key: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return call(api, 'PUT', `/api/stores/${STORE.a}/config/template`, {
    token: owner,
    body: { templateKey: key },
  });
}

before(async () => {
  process.env.RATE_LIMIT_DISABLED = 'true';
  await seedFixtures();
  api = await boot();
  owner = tokenFor(USER.ownerA);
});

after(async () => {
  await api.close();
  await cleanup();
  await closePool();
});

// ===========================================================================
describe('the done-when: one API call reflects a template switch', () => {
  it('switching from Food to Services changes vocabulary AND feature gates', async () => {
    await setTemplate('food');

    const asFood = await config();
    assert.equal(asFood.status, 200);
    assert.equal(asFood.body.config.template?.key, 'food');

    // Vocabulary — V002 ships food's words verbatim from AdminIndustries' editor.
    assert.equal(asFood.body.config.words['product']?.many, 'Menu items');
    assert.equal(asFood.body.config.words['category']?.many, 'Sections');
    // And the singular the screens need: Categories.dc.html's button reads "Add section".
    assert.equal(asFood.body.config.words['category']?.one, 'Section');

    // Feature gates.
    assert.equal(asFood.body.config.modules['modifiers']?.enabled, true, 'food has priced extras');
    assert.equal(asFood.body.config.modules['table']?.enabled, true, 'and QR table ordering');
    assert.equal(asFood.body.config.modules['stock']?.enabled, false, 'and no stock counts');
    assert.equal(asFood.body.config.modules['appointments']?.enabled, false);

    // The order timeline.
    assert.deepEqual(
      asFood.body.config.orderSteps.map((s) => s.key),
      ['new', 'preparing', 'ready', 'delivered'],
    );

    // ---- one call to switch ------------------------------------------------
    const switched = await setTemplate('services');
    assert.equal(switched.status, 200);
    assert.equal(switched.body['changed'], true);

    // ---- one call to see everything change --------------------------------
    const asServices = await config();
    assert.equal(asServices.body.config.template?.key, 'services');

    assert.equal(asServices.body.config.words['product']?.many, 'Services');
    assert.equal(asServices.body.config.words['product']?.one, 'Service');
    assert.equal(asServices.body.config.words['category']?.many, 'Categories');
    assert.equal(asServices.body.config.words['category']?.one, 'Category');

    // Services has no delivery and no pickup — V002's own note: "The same order machine, read
    // differently."
    assert.equal(asServices.body.config.modules['delivery']?.enabled, false);
    assert.equal(asServices.body.config.modules['pickup']?.enabled, false);
    assert.equal(asServices.body.config.modules['appointments']?.enabled, true);
    assert.equal(asServices.body.config.modules['table']?.enabled, false);

    assert.deepEqual(
      asServices.body.config.orderSteps.map((s) => s.key),
      ['booked', 'confirmed', 'in_progress', 'done'],
    );
    // The first step's LABEL differs where food's says New — the reason an order step carries
    // both a key and a label.
    assert.equal(asServices.body.config.orderSteps[0]?.label, 'Booked');
  });

  it('every one of the eight templates resolves, and Pharmacy is refused', async () => {
    const offered = await call(api, 'GET', `/api/stores/${STORE.a}/config/templates`, { token: owner });
    assert.equal(offered.status, 200);
    const keys = (offered.body['templates'] as { key: string }[]).map((t) => t.key).sort();

    // Seven, not eight: V002 ships Pharmacy as a draft, and "no store can pin it".
    assert.deepEqual(keys, ['beauty', 'electronics', 'fashion', 'food', 'furniture', 'grocery', 'services']);

    for (const key of keys) {
      const switched = await setTemplate(key);
      assert.equal(switched.status, 200, key);
      const seen = await config();
      assert.equal(seen.body.config.template?.key, key, key);
      assert.ok(seen.body.config.orderSteps.length >= 2, `${key} has a timeline`);
      for (const word of ['product', 'catalog', 'category', 'option']) {
        assert.ok((seen.body.config.words[word]?.many ?? '').length > 0, `${key}.${word}`);
      }
    }

    const pharmacy = await setTemplate('pharmacy');
    assert.equal(pharmacy.status, 404);
    assert.equal(pharmacy.body['code'], 'TEMPLATE_NOT_OFFERED');

    const nonsense = await setTemplate('taxidermy');
    assert.equal(nonsense.status, 404, 'answered the same way, because it is the same answer');
  });

  it('repinning to the version already pinned changes nothing', async () => {
    await setTemplate('food');
    const again = await setTemplate('food');
    assert.equal(again.status, 200);
    assert.equal(again.body['changed'], false);
  });
});

// ===========================================================================
describe('store overrides', () => {
  it('renames a word for this store only, and says the store did it', async () => {
    await setTemplate('food');

    const patched = await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { words: { category: 'Aisles' } },
    });
    assert.equal(patched.status, 200);

    const seen = await config();
    assert.equal(seen.body.config.words['category']?.many, 'Aisles');
    assert.equal(seen.body.config.words['category']?.one, 'Aisle');
    assert.equal(seen.body.config.words['category']?.source, 'store');
    // Untouched words still come from the template.
    assert.equal(seen.body.config.words['product']?.source, 'template');
    assert.equal(seen.body.config.words['product']?.many, 'Menu items');
  });

  it('an override survives a template switch — which is what a rollout promises', async () => {
    // AdminIndustries, about publishing: "Only defaults change. Anything a merchant customized
    // is kept." It holds for a merchant's own switch too, because the pin and the overrides are
    // different columns.
    const switched = await setTemplate('fashion');
    assert.equal(switched.status, 200);

    const seen = await config();
    assert.equal(seen.body.config.template?.key, 'fashion');
    assert.equal(seen.body.config.words['category']?.many, 'Aisles', 'still theirs');
    assert.equal(seen.body.config.words['option']?.many, 'Variants', "fashion's word, not food's");
  });

  it('switches a module on that the template had off, and off that it had on', async () => {
    await setTemplate('food');

    await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { modules: { stock: true, table: false } },
    });

    const seen = await config();
    assert.equal(seen.body.config.modules['stock']?.enabled, true);
    assert.equal(seen.body.config.modules['stock']?.source, 'store');
    assert.equal(seen.body.config.modules['table']?.enabled, false);
    assert.equal(seen.body.config.modules['table']?.source, 'store');
    assert.equal(seen.body.config.modules['modifiers']?.enabled, true, 'untouched');
    assert.equal(seen.body.config.modules['modifiers']?.source, 'template');
  });

  it('null removes an override and falls back to the template', async () => {
    // Settings needs "reset to the template's default", and a null is the ordinary way to say it.
    await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { words: { category: null }, modules: { table: null } },
    });

    const seen = await config();
    assert.equal(seen.body.config.words['category']?.many, 'Sections');
    assert.equal(seen.body.config.words['category']?.source, 'template');
    assert.equal(seen.body.config.modules['table']?.enabled, true);
    assert.equal(seen.body.config.modules['table']?.source, 'template');
  });

  it('drops an empty section rather than storing {}', async () => {
    // config_overrides is meant to answer "what did this merchant change". `{"words":{}}`
    // answers it misleadingly, and would make the resolver's `source` field a lie.
    await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { words: { product: 'Dishes' } },
    });
    await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { words: { product: null } },
    });

    const { rows } = await sql<{ overrides: string }>(
      `SELECT config_overrides::text AS overrides FROM stores WHERE id = $1`,
      [STORE.a],
    );
    const stored = JSON.parse(rows[0]?.overrides ?? '{}') as Record<string, unknown>;
    assert.equal('words' in stored, false, `stored: ${rows[0]?.overrides}`);
  });

  it('a patch touches only the keys it names', async () => {
    await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { words: { product: 'Dishes', catalog: 'Kitchen' } },
    });
    await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { modules: { stock: true } },
    });

    const seen = await config();
    assert.equal(seen.body.config.words['product']?.many, 'Dishes', 'the earlier patch survived');
    assert.equal(seen.body.config.words['catalog']?.many, 'Kitchen');
    assert.equal(seen.body.config.modules['stock']?.enabled, true);
  });

  it('refuses a word key and a module the platform does not have', async () => {
    // The silent-failure pair V002 fights with foreign keys. An override of "prodcut" or of
    // "stok" would be stored cleanly and ignored forever.
    const badWord = await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { words: { prodcut: 'Dishes' } },
    });
    assert.equal(badWord.status, 400);
    assert.equal(badWord.body['code'], 'UNKNOWN_WORD');

    const badModule = await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { modules: { stok: true } },
    });
    assert.equal(badModule.status, 400);
    assert.equal(badModule.body['code'], 'UNKNOWN_MODULE');
    assert.match(String(badModule.body['error']), /stock/, 'and it lists what does exist');
  });

  it('refuses a blank word and a non-boolean module', async () => {
    const blank = await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { words: { product: '   ' } },
    });
    assert.equal(blank.status, 400);

    const notBool = await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { modules: { stock: 'yes' } },
    });
    assert.equal(notBool.status, 400);
  });

  it('refuses an empty patch rather than reporting success for nothing', async () => {
    const empty = await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: {},
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.body['code'], 'NOTHING_TO_CHANGE');
  });
});

// ===========================================================================
describe('the ETag', () => {
  it('is stable across identical requests and answers 304', async () => {
    const first = await config();
    assert.ok(first.etag, 'an ETag is set');

    const again = await config();
    assert.equal(again.etag, first.etag, 'the same answer hashes the same');

    const res = await fetch(`${api.baseUrl}/api/storefront/${SLUG}/config`, {
      headers: { 'If-None-Match': first.etag },
    });
    assert.equal(res.status, 304);
    assert.equal((await res.text()).length, 0, 'and sends no body');
  });

  it('changes when the configuration does, and only then', async () => {
    const before = await config();

    // A change that does not touch the config at all.
    await sql(`UPDATE stores SET updated_at = now() WHERE id = $1`, [STORE.a]);
    const untouched = await config();
    assert.equal(untouched.etag, before.etag, 'a store update that changes no config keeps the ETag');

    await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: owner,
      body: { words: { option: 'Toppings' } },
    });
    const afterOverride = await config();
    assert.notEqual(afterOverride.etag, before.etag);

    await setTemplate('beauty');
    const afterSwitch = await config();
    assert.notEqual(afterSwitch.etag, afterOverride.etag);

    // A stale validator is not honoured.
    const stale = await fetch(`${api.baseUrl}/api/storefront/${SLUG}/config`, {
      headers: { 'If-None-Match': before.etag ?? '' },
    });
    assert.equal(stale.status, 200);
  });

  it('honours a list of validators and a wildcard', async () => {
    const current = await config();
    assert.ok(current.etag);

    const list = await fetch(`${api.baseUrl}/api/storefront/${SLUG}/config`, {
      headers: { 'If-None-Match': `"something-else", ${current.etag}` },
    });
    assert.equal(list.status, 304);

    const wildcard = await fetch(`${api.baseUrl}/api/storefront/${SLUG}/config`, {
      headers: { 'If-None-Match': '*' },
    });
    assert.equal(wildcard.status, 304);
  });
});

// ===========================================================================
describe('reading the config', () => {
  it('needs no authentication — an anonymous shopper renders the shop', async () => {
    const res = await fetch(`${api.baseUrl}/api/storefront/${SLUG}/config`);
    assert.equal(res.status, 200);
    await res.text();
  });

  it('is keyed by slug, so a store uuid learns nothing', async () => {
    // Milestone 11 made store existence unobservable through the console, and an
    // unauthenticated endpoint keyed by uuid would hand that back. This one is keyed by slug,
    // and a uuid — which happens to be a syntactically valid slug, being hex and hyphens — is
    // simply not any store's address. So it 404s for a store that exists exactly as it does
    // for one that does not, which is the property that matters.
    const real = await fetch(`${api.baseUrl}/api/storefront/${STORE.a}/config`);
    const invented = await fetch(`${api.baseUrl}/api/storefront/eeeeeeee-0000-4000-8000-0000000009ff/config`);

    assert.equal(real.status, 404);
    assert.equal(invented.status, 404);
    assert.deepEqual(await real.json(), await invented.json(), 'byte-for-byte the same answer');
  });

  it('404s an address with no store, and 400s a malformed one', async () => {
    const missing = await fetch(`${api.baseUrl}/api/storefront/no-such-store-here/config`);
    assert.equal(missing.status, 404);
    await missing.text();

    const malformed = await fetch(`${api.baseUrl}/api/storefront/Not_A_Slug/config`);
    assert.equal(malformed.status, 400);
    await malformed.text();
  });

  it('resolves a store with no template to the platform words', async () => {
    // A half-onboarded store. Onboarding's first question is the business type, and the store
    // has to render before it is answered.
    await sql(
      `UPDATE stores SET industry_template_id = NULL, industry_template_version = NULL, config_overrides = '{}' WHERE id = $1`,
      [STORE.a],
    );

    const seen = await config();
    assert.equal(seen.status, 200);
    assert.equal(seen.body.config.template, null);
    assert.equal(seen.body.config.words['product']?.many, 'Products');
    assert.equal(seen.body.config.words['product']?.source, 'platform');
    assert.equal(seen.body.config.words['category']?.many, 'Categories');
    assert.deepEqual(seen.body.config.orderSteps, []);
    assert.deepEqual(seen.body.config.attributes, []);
    assert.equal(Object.values(seen.body.config.modules).every((m) => !m.enabled), true);
    // The registry is still complete, so has() has its closed world even with no template.
    assert.equal(Object.keys(seen.body.config.modules).length, 8);
  });

  it('carries the template name the Categories board prints', async () => {
    // Categories.dc.html, verbatim: "Called “Sections” in your Food & drinks template."
    await setTemplate('food');
    const seen = await config();
    assert.equal(seen.body.config.template?.name, 'Food & drinks');
    assert.equal(seen.body.config.words['category']?.many, 'Sections');
    assert.equal(
      `Called “${seen.body.config.words['category']?.many}” in your ${seen.body.config.template?.name} template.`,
      'Called “Sections” in your Food & drinks template.',
    );
  });

  it('carries the pharmacy flag set when a store is on a template that has one', async () => {
    // Pharmacy is a draft and unpinnable, so this asserts the mechanism on the data that does
    // exist: a template with no flags reports none, and the field is always present.
    await setTemplate('fashion');
    const seen = await config();
    assert.deepEqual(seen.body.config.productFlags, []);
  });
});

// ===========================================================================
describe('who may change it', () => {
  it('a manager cannot switch the template or patch overrides', async () => {
    const manager = tokenFor(USER.managerA);

    const put = await call(api, 'PUT', `/api/stores/${STORE.a}/config/template`, {
      token: manager,
      body: { templateKey: 'fashion' },
    });
    assert.equal(put.status, 403);

    const patch = await call(api, 'PATCH', `/api/stores/${STORE.a}/config/overrides`, {
      token: manager,
      body: { words: { product: 'Things' } },
    });
    assert.equal(patch.status, 403);

    const list = await call(api, 'GET', `/api/stores/${STORE.a}/config/templates`, { token: manager });
    assert.equal(list.status, 403);
  });

  it('an admin of another store cannot either', async () => {
    const put = await call(api, 'PUT', `/api/stores/${STORE.a}/config/template`, {
      token: tokenFor(USER.adminB),
      body: { templateKey: 'fashion' },
    });
    assert.equal(put.status, 403);
  });

  it('but reading it needs nothing at all', async () => {
    const seen = await config();
    assert.equal(seen.status, 200);
  });
});
