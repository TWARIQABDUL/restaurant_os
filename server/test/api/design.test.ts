// server/test/api/design.test.ts — milestone 25: Customize's half of the look.
//
//   1. A DESIGN IS NOT A PALETTE. Layout, sections and logo are stored beside the theme and published with it, in one
//      transaction — a store never gets a new colour scheme with the old layout.
//   2. THE TWO STUDIOS SHARE ONE DRAFT. ThemeStudio saves colours without a `design`, and that must LEAVE what Customize
//      chose, not reset it to the default.
//   3. THE STOREFRONT NEVER SEES A DRAFT. It reads the published design, or the default for a store that never opened
//      the editor — which must look exactly as the shopfront always did.
//   4. NOTHING CAN BE SMUGGLED IN: the products section cannot be switched off, and a logo has to be this store's own
//      upload, not a URL and not another store's file.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import type { ThemeInputs } from '../../src/core.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { STORE, USER, cleanup, seedFixtures } from './support.ts';

let api: Api;
const owner = (): string => tokenFor(USER.ownerA);
const manager = (): string => tokenFor(USER.managerA);
const base = `/api/stores/${STORE.a}/theme`;
const SLUG = 'escalation-store-a';

type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => v as Json;

const INPUTS: ThemeInputs = { brand: '#E4572E', accent: null, harmony: 'complementary', mood: 'light', shape: 'round', headingFont: 'sport', cardTreatment: 'shadow', hero: 'fill' };
const LIST = { productLayout: 'list', sections: { promo: false, categories: true, featured: false, info: true }, logoUrl: null };

async function publicDesign(): Promise<Json> {
  const res = await fetch(`${api.baseUrl}/api/storefront/${SLUG}/theme`);
  return asJson(asJson(await res.json())['design']);
}

before(async () => {
  process.env.RATE_LIMIT_DISABLED = 'true';
  await seedFixtures();
  api = await boot();
});

after(async () => {
  await api.close();
  await sql(`DELETE FROM store_designs WHERE store_id = ANY($1::uuid[])`, [[STORE.a, STORE.b]]);
  await sql(`DELETE FROM store_themes WHERE store_id = ANY($1::uuid[])`, [[STORE.a, STORE.b]]);
  await cleanup();
  await closePool();
});

describe('a store that never opened Customize', () => {
  it('has the default design — a grid, every section — in the studio and on the storefront', async () => {
    const studio = asJson((await call(api, 'GET', base, { token: owner() })).body['design']);
    assert.equal(studio['draft'], null);
    assert.equal(studio['published'], null);
    const defaults = asJson(studio['defaults']);
    assert.equal(defaults['productLayout'], 'grid');
    assert.deepEqual(defaults['sections'], { promo: true, categories: true, featured: true, info: true });
    assert.equal(defaults['logoUrl'], null);

    const live = await publicDesign();
    assert.equal(live['productLayout'], 'grid', 'the shopfront looks exactly as it always did');
    assert.deepEqual(live['sections'], defaults['sections']);
  });
});

describe('saving and publishing', () => {
  it('saves a draft design with the palette, and the storefront does not see it', async () => {
    const res = await call(api, 'PUT', `${base}/draft`, { token: owner(), body: { ...INPUTS, design: LIST } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const studio = asJson((await call(api, 'GET', base, { token: owner() })).body['design']);
    assert.equal(asJson(studio['draft'])['productLayout'], 'list');
    assert.equal(studio['published'], null);
    assert.equal((await publicDesign())['productLayout'], 'grid', 'a draft is not live');
  });

  it('keeps the design when ThemeStudio saves colours alone', async () => {
    const res = await call(api, 'PUT', `${base}/draft`, { token: owner(), body: { ...INPUTS, brand: '#1D6B47' } });
    assert.equal(res.status, 200);
    const draft = asJson(asJson((await call(api, 'GET', base, { token: owner() })).body['design'])['draft']);
    assert.equal(draft['productLayout'], 'list', 'colours alone must not reset the layout Customize chose');
    assert.deepEqual(draft['sections'], LIST.sections);
  });

  it('publishes the palette AND the design together', async () => {
    const res = await call(api, 'POST', `${base}/publish`, { token: owner(), body: { ...INPUTS, design: LIST } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const live = await publicDesign();
    assert.equal(live['productLayout'], 'list');
    assert.deepEqual(live['sections'], LIST.sections);

    const themeRow = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM store_themes WHERE store_id = $1 AND status = 'published'`, [STORE.a]);
    const designRow = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM store_designs WHERE store_id = $1 AND status = 'published'`, [STORE.a]);
    assert.deepEqual([themeRow.rows[0]!.n, designRow.rows[0]!.n], ['1', '1']);
  });

  it('publishes the DRAFT\'s design when a request carries none', async () => {
    await call(api, 'PUT', `${base}/draft`, { token: owner(), body: { ...INPUTS, design: { ...LIST, productLayout: 'grid', sections: { ...LIST.sections, promo: true } } } });
    const res = await call(api, 'POST', `${base}/publish`, { token: owner(), body: { ...INPUTS } });
    assert.equal(res.status, 200);
    const live = await publicDesign();
    assert.equal(live['productLayout'], 'grid');
    assert.equal(asJson(live['sections'])['promo'], true);
  });

  it('reverting to the default look reverts the design too, and keeps the draft', async () => {
    await call(api, 'POST', `${base}/publish`, { token: owner(), body: { ...INPUTS, design: LIST } });
    assert.equal((await publicDesign())['productLayout'], 'list');
    const res = await call(api, 'DELETE', `${base}/published`, { token: owner() });
    assert.equal(res.status, 200);
    assert.equal((await publicDesign())['productLayout'], 'grid');
    const studio = asJson((await call(api, 'GET', base, { token: owner() })).body['design']);
    assert.equal(studio['published'], null);
    assert.notEqual(studio['draft'], null, 'the work is not thrown away');
  });
});

describe('what cannot be smuggled in', () => {
  const put = (design: unknown) => call(api, 'PUT', `${base}/draft`, { token: owner(), body: { ...INPUTS, design } });

  it('refuses a layout the editor does not have', async () => {
    const res = await put({ ...LIST, productLayout: 'carousel' });
    assert.equal(res.status, 400);
  });

  it('refuses to switch the products section off, by name', async () => {
    const res = await put({ ...LIST, sections: { ...LIST.sections, products: false } });
    assert.equal(res.status, 400);
    assert.match(String(res.body['error']), /products/);
  });

  it('refuses a section that is not one, and one that is not on or off', async () => {
    assert.equal((await put({ ...LIST, sections: { banner: true } })).status, 400);
    assert.equal((await put({ ...LIST, sections: { promo: 'yes' } })).status, 400);
  });

  it('accepts only this store\'s own uploaded logo', async () => {
    assert.equal((await put({ ...LIST, logoUrl: 'https://evil.example/pixel.png' })).status, 400, 'a URL');
    assert.equal((await put({ ...LIST, logoUrl: `/api/media/${STORE.b}/${'a'.repeat(32)}.png` })).status, 400, 'another store\'s file');
    assert.equal((await put({ ...LIST, logoUrl: `/api/media/${STORE.a}/../${STORE.b}/x.png` })).status, 400, 'a path trick');
    const ok = await put({ ...LIST, logoUrl: `/api/media/${STORE.a}/${'a'.repeat(32)}.png` });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it('the database refuses a logo that is not ours even if the route is bypassed', async () => {
    await assert.rejects(
      sql(`INSERT INTO store_designs (store_id, status, logo_url) VALUES ($1, 'draft', 'https://evil.example/x.png') ON CONFLICT (store_id, status) DO UPDATE SET logo_url = EXCLUDED.logo_url`, [STORE.a]),
      /store_designs_logo_is_ours/,
    );
  });
});

describe('who may change the design', () => {
  it('a manager cannot read, save or publish it', async () => {
    assert.equal((await call(api, 'GET', base, { token: manager() })).status, 403);
    assert.equal((await call(api, 'PUT', `${base}/draft`, { token: manager(), body: { ...INPUTS, design: LIST } })).status, 403);
    assert.equal((await call(api, 'POST', `${base}/publish`, { token: manager(), body: { ...INPUTS, design: LIST } })).status, 403);
  });
});
