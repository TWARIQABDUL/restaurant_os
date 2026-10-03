// server/test/api/catalogue.test.ts — milestone 22.
//
// The merchant's catalogue over HTTP: the Products list, AddProduct's whole save, Categories, and the photo
// upload. There is no db/scripts suite for this milestone because V024 added no function — its two triggers
// (the cover photo, the eight-photo cap) are exercised here, through the only path that writes them.
//
//   1. ONE "SIZE" PER PRODUCT. The reason V024 exists: V003 made option groups unique per store by name, so a
//      second product's "Size" could not be saved. The first assertion that matters is that two can.
//   2. EDITING KEEPS WHAT IT CAN. A save replaces the whole product, and the variants of the combinations that
//      still exist must keep their ids — an order line points at one.
//   3. WHAT HAS BEEN SOLD IS NOT REWRITTEN: the option structure of an ordered product is locked, and a bulk
//      delete names what it kept instead of failing whole or deleting it.
//   4. THE UPLOAD TRUSTS BYTES, NOT HEADERS.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { localImageStore, setImageStore } from '../../src/storage/images.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { CATALOGUE, STORE, USER, cleanup, seedConsole, seedFixtures, seedStorefront } from './support.ts';

let api: Api;
let mediaDir: string;

const owner = (): string => tokenFor(USER.ownerA);
const manager = (): string => tokenFor(USER.managerA);
const rider = (): string => tokenFor(USER.riderA);
const otherStoreAdmin = (): string => tokenFor(USER.adminB);

const products = `/api/stores/${STORE.a}/products`;
const categories = `/api/stores/${STORE.a}/categories`;
const uploads = `/api/stores/${STORE.a}/uploads`;

type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => v as Json;
const list = (v: unknown): Json[] => v as Json[];

// A real, if tiny, PNG: signature plus IHDR. sniff() reads only the signature.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

async function upload(bytes: Buffer, contentType: string, token = owner()): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': contentType,
    Cookie: [...api.cookies].map(([n, v]) => `${n}=${v}`).join('; '),
  };
  const csrf = api.cookies.get('csrf');
  if (csrf !== undefined) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${api.baseUrl}${uploads}`, { method: 'POST', headers, body: new Uint8Array(bytes) });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Json) };
}

const plain = (over: Json = {}): Json => ({
  name: 'Mango Juice',
  description: 'Cold-pressed.',
  price: '1200',
  status: 'active',
  trackStock: false,
  ...over,
});

const sizeColour = (over: Json = {}): Json => ({
  name: 'Everyday Tee',
  price: '15000',
  status: 'active',
  trackStock: true,
  groups: [
    {
      name: 'Size',
      mode: 'one',
      values: [{ key: 's', label: 'S', priceDelta: '0' }, { key: 'm', label: 'M', priceDelta: '0' }],
    },
    {
      name: 'Colour',
      mode: 'one',
      values: [{ key: 'bk', label: 'Black', priceDelta: '0' }, { key: 'wh', label: 'White', priceDelta: '0' }],
    },
  ],
  variants: [
    { combo: ['s', 'bk'], sku: 'TEE-S-BK', stock: 4 },
    { combo: ['s', 'wh'], sku: 'TEE-S-WH', stock: 3 },
    { combo: ['m', 'bk'], sku: 'TEE-M-BK', stock: 0 },
    { combo: ['m', 'wh'], sku: 'TEE-M-WH', stock: 9 },
  ],
  ...over,
});

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), 'vendlyfy-media-'));
  setImageStore(localImageStore(mediaDir));
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  await seedConsole();
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
  setImageStore(null);
  await rm(mediaDir, { recursive: true, force: true });
});

describe('who may reach the catalogue admin', () => {
  it('owners and managers do; a rider and another store\'s admin do not', async () => {
    assert.equal((await call(api, 'GET', products, { token: owner() })).status, 200);
    assert.equal((await call(api, 'GET', products, { token: manager() })).status, 200);
    assert.equal((await call(api, 'GET', products, { token: rider() })).status, 403);
    assert.equal((await call(api, 'GET', products, { token: otherStoreAdmin() })).status, 403);
    assert.equal((await call(api, 'GET', categories, { token: rider() })).status, 403);
    assert.equal((await call(api, 'POST', products, { token: rider(), body: plain() })).status, 403);
  });
});

describe('the Products list', () => {
  it('counts every tab for the whole store, and the tabs filter what they count', async () => {
    const res = await call(api, 'GET', products, { token: owner() });
    const counts = asJson(res.body['counts']);
    assert.equal(counts['all'], 9);
    assert.equal(counts['draft'], 1);
    assert.equal(counts['active'], 8);
    // Cotton Cap (2 left, threshold 3) and the tee (M/Black at 2): low is per VARIANT.
    assert.equal(counts['low'], 2);
    assert.equal(counts['out'], 0);

    const drafts = await call(api, 'GET', `${products}?tab=draft`, { token: owner() });
    assert.deepEqual(list(drafts.body['rows']).map((r) => r['name']), ['Unreleased Special']);
    assert.equal(drafts.body['total'], 1);
    assert.equal(asJson(list(drafts.body['rows'])[0])['sub'], 'Not visible to customers');

    const low = await call(api, 'GET', `${products}?tab=low`, { token: owner() });
    assert.deepEqual(list(low.body['rows']).map((r) => r['name']).sort(), ['Cotton Cap', 'Linen Tee']);
  });

  it('searches by name or SKU, and by section', async () => {
    const byName = await call(api, 'GET', `${products}?q=juice`, { token: owner() });
    assert.deepEqual(list(byName.body['rows']).map((r) => r['name']), ['Passion Juice']);

    const bySku = await call(api, 'GET', `${products}?q=TEE-`, { token: owner() });
    assert.deepEqual(list(bySku.body['rows']).map((r) => r['name']), ['Linen Tee']);

    const drinks = await call(api, 'GET', `${products}?category=${CATALOGUE.drinks}`, { token: owner() });
    assert.deepEqual(list(drinks.body['rows']).map((r) => r['name']), ['Still Water']);

    // A wildcard typed into the box is text, not a pattern.
    const wild = await call(api, 'GET', `${products}?q=%25`, { token: owner() });
    assert.equal(list(wild.body['rows']).length, 0);
  });

  it('shows stock only where it is tracked, and describes the options', async () => {
    const res = await call(api, 'GET', `${products}?q=linen`, { token: owner() });
    const tee = asJson(list(res.body['rows'])[0]);
    assert.equal(tee['stock'], 14);
    assert.equal(tee['state'], 'low');
    assert.match(String(tee['sub']), /^2 option groups · SKU /);
    assert.deepEqual(tee['categories'], ['Mains']);

    const juice = asJson(list((await call(api, 'GET', `${products}?q=passion`, { token: owner() })).body['rows'])[0]);
    assert.equal(juice['stock'], null);
  });

  it('sorts by price and by best selling', async () => {
    const price = await call(api, 'GET', `${products}?sort=price`, { token: owner() });
    assert.equal(asJson(list(price.body['rows'])[0])['name'], 'Still Water');
    const best = await call(api, 'GET', `${products}?sort=best`, { token: owner() });
    assert.equal(asJson(list(best.body['rows'])[0])['name'], 'Passion Juice');
  });
});

describe('creating and editing a product', () => {
  let teeId = '';
  let jeansId = '';

  it('a product with no options gets one default variant carrying its SKU and count', async () => {
    const res = await call(api, 'POST', products, {
      token: owner(),
      body: plain({ trackStock: true, sku: 'MJ-001', stock: 12, compareAtPrice: '1500' }),
    });
    assert.equal(res.status, 201);
    const p = asJson(res.body['product']);
    assert.equal(p['sku'], 'MJ-001');
    assert.equal(p['stock'], 12);
    assert.equal(p['compareAtPrice'], '1500.00');
    assert.deepEqual(p['variants'], []);

    const rows = await sql<{ is_default: boolean; stock_quantity: number }>(
      `SELECT is_default, stock_quantity FROM product_variants WHERE product_id = $1`,
      [p['id']],
    );
    assert.deepEqual(rows.rows, [{ is_default: true, stock_quantity: 12 }]);
  });

  it('two products may each have their own "Size" — the reason V024 exists', async () => {
    const tee = await call(api, 'POST', products, { token: owner(), body: sizeColour() });
    assert.equal(tee.status, 201, JSON.stringify(tee.body));
    teeId = String(asJson(tee.body['product'])['id']);

    const jeans = await call(api, 'POST', products, {
      token: owner(),
      body: {
        name: 'Straight Jeans',
        price: '28000',
        status: 'draft',
        trackStock: false,
        groups: [{ name: 'Size', mode: 'one', values: ['28', '30', '32'].map((l) => ({ key: l, label: l, priceDelta: '0' })) }],
        variants: ['28', '30', '32'].map((l) => ({ combo: [l], sku: `JN-${l}` })),
      },
    });
    assert.equal(jeans.status, 201, JSON.stringify(jeans.body));
    jeansId = String(asJson(jeans.body['product'])['id']);
    assert.equal(list(asJson(jeans.body['product'])['variants']).length, 3);

    const groups = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM option_groups WHERE store_id = $1 AND lower(name) = 'size' AND product_id IS NOT NULL`, [STORE.a]);
    assert.equal(groups.rows[0]!.n, '2');
  });

  it('the tee came back as a 2x2 matrix, counted as sent', async () => {
    const res = await call(api, 'GET', `${products}/${teeId}`, { token: owner() });
    const p = asJson(res.body['product']);
    const variants = list(p['variants']);
    assert.equal(variants.length, 4);
    const mBlack = variants.find((v) => v['sku'] === 'TEE-M-BK')!;
    assert.equal(mBlack['stock'], 0);
    assert.equal(mBlack['label'], 'M / Black');
    assert.equal(list(p['groups']).length, 2);
  });

  it('a pick-several group is priced per line and is not a variant dimension', async () => {
    const res = await call(api, 'POST', products, {
      token: owner(),
      body: {
        name: 'Beef Burger',
        price: '4000',
        status: 'active',
        trackStock: false,
        groups: [{ name: 'Extras', mode: 'several', values: [{ key: 'c', label: 'Cheese', priceDelta: '500' }, { key: 'f', label: 'Fries', priceDelta: '1000' }] }],
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const p = asJson(res.body['product']);
    assert.deepEqual(p['variants'], []);
    assert.equal(asJson(list(p['groups'])[0])['mode'], 'several');
  });

  it('saving again keeps the id of every variant whose combination still exists', async () => {
    const before = await sql<{ id: string; sku: string }>(`SELECT id, sku FROM product_variants WHERE product_id = $1 ORDER BY sku`, [teeId]);
    const current = asJson((await call(api, 'GET', `${products}/${teeId}`, { token: owner() })).body['product']);
    const groups = list(current['groups']).map((g) => ({ id: g['id'], name: g['name'], mode: g['mode'], values: g['values'] }));
    const size = asJson(groups[0]);
    const sizeValues = list(size['values']);

    // Rename M to Medium, add L, restock M/Black — one save.
    const mKey = String(sizeValues.find((v) => v['label'] === 'M')!['key']);
    size['values'] = [...sizeValues.map((v) => (v['label'] === 'M' ? { ...v, label: 'Medium' } : v)), { key: 'l', label: 'L', priceDelta: '0' }];
    const colourKeys = list(asJson(groups[1])['values']).map((v) => String(v['key']));
    const sKey = String(sizeValues.find((v) => v['label'] === 'S')!['key']);
    const variants = [
      { combo: [sKey, colourKeys[0]], sku: 'TEE-S-BK', stock: 4 },
      { combo: [sKey, colourKeys[1]], sku: 'TEE-S-WH', stock: 3 },
      { combo: [mKey, colourKeys[0]], sku: 'TEE-M-BK', stock: 20 },
      { combo: [mKey, colourKeys[1]], sku: 'TEE-M-WH', stock: 9 },
      { combo: ['l', colourKeys[0]], sku: 'TEE-L-BK', stock: 1 },
      { combo: ['l', colourKeys[1]], sku: 'TEE-L-WH', stock: 1 },
    ];

    const res = await call(api, 'PUT', `${products}/${teeId}`, {
      token: owner(),
      body: { ...sizeColour({ groups }), variants },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const after = await sql<{ id: string; sku: string; stock_quantity: number }>(`SELECT id, sku, stock_quantity FROM product_variants WHERE product_id = $1 ORDER BY sku`, [teeId]);
    assert.equal(after.rows.length, 6);
    for (const b of before.rows) assert.ok(after.rows.some((a) => a.id === b.id && a.sku === b.sku), `${b.sku} kept its id`);
    assert.equal(after.rows.find((r) => r.sku === 'TEE-M-BK')!.stock_quantity, 20);

    const labels = await sql<{ label: string }>(`SELECT label FROM option_values WHERE option_group_id = $1 ORDER BY position`, [size['id']]);
    assert.deepEqual(labels.rows.map((r) => r.label), ['S', 'Medium', 'L']);
  });

  it('removing a value removes only the variants that used it', async () => {
    const current = asJson((await call(api, 'GET', `${products}/${teeId}`, { token: owner() })).body['product']);
    const groups = list(current['groups']).map((g) => ({ id: g['id'], name: g['name'], mode: g['mode'], values: g['values'] }));
    const size = asJson(groups[0]);
    const keep = list(size['values']).filter((v) => v['label'] !== 'L');
    size['values'] = keep;
    const keys = keep.map((v) => String(v['key']));
    const colours = list(asJson(groups[1])['values']).map((v) => String(v['key']));
    const variants = keys.flatMap((k) => colours.map((c) => ({ combo: [k, c], sku: `X-${k.slice(0, 4)}-${c.slice(0, 4)}`, stock: 1 })));

    const res = await call(api, 'PUT', `${products}/${teeId}`, { token: owner(), body: { ...sizeColour({ groups }), variants } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(list(asJson(res.body['product'])['variants']).length, 4);
  });

  it('changing the option STRUCTURE of an unsold product is allowed; of a sold one it is refused', async () => {
    const restructured = await call(api, 'PUT', `${products}/${jeansId}`, {
      token: owner(),
      body: { name: 'Straight Jeans', price: '28000', status: 'draft', trackStock: false },
    });
    assert.equal(restructured.status, 200, JSON.stringify(restructured.body));
    const jp = asJson(restructured.body['product']);
    assert.deepEqual(jp['groups'], []);
    assert.equal(list(await (async () => (await sql(`SELECT 1 FROM product_variants WHERE product_id = $1`, [jeansId])).rows)()).length, 1);

    // Passion Juice has an order line against it.
    const juice = asJson((await call(api, 'GET', `${products}/${CATALOGUE.juice}`, { token: owner() })).body['product']);
    assert.equal(juice['sold'], true);
    const refused = await call(api, 'PUT', `${products}/${CATALOGUE.juice}`, {
      token: owner(),
      body: { ...plain({ name: 'Passion Juice' }), groups: [{ name: 'Size', mode: 'one', values: [{ key: 'a', label: 'Small', priceDelta: '0' }] }], variants: [{ combo: ['a'] }] },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body['code'], 'OPTIONS_LOCKED');

    // But the things that are not structure are free to change.
    const repriced = await call(api, 'PUT', `${products}/${CATALOGUE.juice}`, { token: owner(), body: plain({ name: 'Passion Juice', price: '1300' }) });
    assert.equal(repriced.status, 200);
    assert.equal(asJson(repriced.body['product'])['price'], '1300.00');
  });

  it('refuses the mistakes a merchant makes, in words', async () => {
    const dup = await call(api, 'POST', products, { token: owner(), body: plain({ name: 'Another', sku: 'MJ-001' }) });
    assert.equal(dup.status, 409);
    assert.equal(dup.body['code'], 'SKU_TAKEN');

    const cheaper = await call(api, 'POST', products, { token: owner(), body: plain({ compareAtPrice: '1000' }) });
    assert.equal(cheaper.status, 400);
    assert.equal(cheaper.body['code'], 'COMPARE_AT_NOT_HIGHER');

    const emptyGroup = await call(api, 'POST', products, { token: owner(), body: plain({ groups: [{ name: 'Size', mode: 'one', values: [] }] }) });
    assert.equal(emptyGroup.status, 400);
    assert.equal(emptyGroup.body['code'], 'OPTION_NEEDS_VALUES');

    const twice = await call(api, 'POST', products, {
      token: owner(),
      body: plain({ groups: [{ name: 'Size', mode: 'several', values: [{ key: 'a', label: 'x', priceDelta: '0' }] }, { name: 'size', mode: 'several', values: [{ key: 'b', label: 'y', priceDelta: '0' }] }] }),
    });
    assert.equal(twice.body['code'], 'DUPLICATE_OPTION');

    const noName = await call(api, 'POST', products, { token: owner(), body: plain({ name: '  ' }) });
    assert.equal(noName.status, 400);

    const foreign = await call(api, 'POST', products, { token: owner(), body: plain({ images: ['https://evil.example/pixel.png'] }) });
    assert.equal(foreign.body['code'], 'INVALID_PHOTO');

    const otherStore = await call(api, 'GET', `${products}/${teeId}`, { token: otherStoreAdmin() });
    assert.equal(otherStore.status, 403);
  });

  it('cannot reach into another store\'s product through its own store\'s url', async () => {
    const res = await call(api, 'GET', `${products}/${'00000000-0000-4000-8000-000000000bad'}`, { token: owner() });
    assert.equal(res.status, 404);
    const put = await call(api, 'PUT', `${products}/${'00000000-0000-4000-8000-000000000bad'}`, { token: owner(), body: plain() });
    assert.equal(put.status, 404);
  });
});

describe('photos', () => {
  it('stores what is really an image, serves it back, and makes the first the cover', async () => {
    const up = await upload(PNG, 'image/png');
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const url = String(up.body['url']);
    assert.match(url, new RegExp(`^/api/media/${STORE.a}/[0-9a-f]{32}\\.png$`));

    const served = await fetch(`${api.baseUrl}${url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

    const second = String((await upload(PNG, 'image/png')).body['url']);
    const created = await call(api, 'POST', products, { token: owner(), body: plain({ name: 'With photos', images: [url, second] }) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = String(asJson(created.body['product'])['id']);
    const cover = await sql<{ cover_image_url: string }>(`SELECT cover_image_url FROM products WHERE id = $1`, [id]);
    assert.equal(cover.rows[0]!.cover_image_url, url);

    // Reorder: the second becomes the cover, and the trigger follows.
    await call(api, 'PUT', `${products}/${id}`, { token: owner(), body: plain({ name: 'With photos', images: [second, url] }) });
    const moved = await sql<{ cover_image_url: string }>(`SELECT cover_image_url FROM products WHERE id = $1`, [id]);
    assert.equal(moved.rows[0]!.cover_image_url, second);

    // Remove them all: no cover.
    await call(api, 'PUT', `${products}/${id}`, { token: owner(), body: plain({ name: 'With photos', images: [] }) });
    const none = await sql<{ cover_image_url: string | null }>(`SELECT cover_image_url FROM products WHERE id = $1`, [id]);
    assert.equal(none.rows[0]!.cover_image_url, null);
  });

  it('judges the bytes, not the header', async () => {
    const html = await upload(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png');
    assert.equal(html.status, 415);
    assert.equal(html.body['code'], 'UNSUPPORTED_IMAGE');

    const svg = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml');
    assert.equal(svg.status, 415);

    const empty = await upload(Buffer.alloc(0), 'image/png');
    assert.equal(empty.status, 415);
  });

  it('refuses an oversize file, and a rider', async () => {
    const big = await upload(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), 'image/png');
    assert.equal(big.status, 413);
    const asRider = await upload(PNG, 'image/png', rider());
    assert.equal(asRider.status, 403);
  });

  it('serves nothing it did not issue', async () => {
    assert.equal((await fetch(`${api.baseUrl}/api/media/${STORE.a}/..%2f..%2fetc%2fpasswd`)).status, 404);
    assert.equal((await fetch(`${api.baseUrl}/api/media/${STORE.a}/${'0'.repeat(32)}.png`)).status, 404);
    assert.equal((await fetch(`${api.baseUrl}/api/media/not-a-store/${'0'.repeat(32)}.png`)).status, 400);
  });
});

describe('bulk actions', () => {
  let a = '';
  let b = '';

  before(async () => {
    a = String(asJson((await call(api, 'POST', products, { token: owner(), body: plain({ name: 'Bulk A', status: 'draft' }) })).body['product'])['id']);
    b = String(asJson((await call(api, 'POST', products, { token: owner(), body: plain({ name: 'Bulk B', status: 'draft' }) })).body['product'])['id']);
  });

  it('activates, hides and moves a selection', async () => {
    const act = await call(api, 'POST', `${products}/bulk`, { token: owner(), body: { ids: [a, b], action: 'activate' } });
    assert.equal(act.body['changed'], 2);
    const again = await call(api, 'POST', `${products}/bulk`, { token: owner(), body: { ids: [a, b], action: 'activate' } });
    assert.equal(again.body['changed'], 0, 'a second activate changes nothing');

    await call(api, 'POST', `${products}/bulk`, { token: owner(), body: { ids: [a], action: 'draft' } });
    const rows = await sql<{ status: string }>(`SELECT status FROM products WHERE id = $1`, [a]);
    assert.equal(rows.rows[0]!.status, 'draft');

    const moved = await call(api, 'POST', `${products}/bulk`, { token: owner(), body: { ids: [a, b], action: 'category', categoryId: CATALOGUE.drinks } });
    assert.equal(moved.body['changed'], 2);
    const inDrinks = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM product_categories WHERE category_id = $1 AND product_id = ANY($2::uuid[])`, [CATALOGUE.drinks, [a, b]]);
    assert.equal(inDrinks.rows[0]!.n, '2');
  });

  it('ignores ids from another store, and demands a selection', async () => {
    const none = await call(api, 'POST', `${products}/bulk`, { token: owner(), body: { ids: [], action: 'delete' } });
    assert.equal(none.status, 400);
    const stranger = await call(api, 'POST', `${products}/bulk`, { token: owner(), body: { ids: ['00000000-0000-4000-8000-000000000bad'], action: 'delete' } });
    assert.equal(stranger.body['changed'], 0);
  });

  it('deletes what was never ordered and NAMES what it kept', async () => {
    const res = await call(api, 'POST', `${products}/bulk`, { token: owner(), body: { ids: [a, b, CATALOGUE.juice], action: 'delete' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['changed'], 2);
    assert.deepEqual(list(res.body['kept']).map((k) => k['name']), ['Passion Juice']);
    const left = await sql(`SELECT 1 FROM products WHERE id = ANY($1::uuid[])`, [[a, b, CATALOGUE.juice]]);
    assert.equal(left.rows.length, 1);
  });

  it('deleting a product with private options leaves no orphaned group behind', async () => {
    const made = await call(api, 'POST', products, { token: owner(), body: sizeColour({ name: 'Doomed tee', variants: [['s', 'bk'], ['s', 'wh'], ['m', 'bk'], ['m', 'wh']].map((combo) => ({ combo, sku: null, stock: 1 })) }) });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = String(asJson(made.body['product'])['id']);
    const del = await call(api, 'POST', `${products}/bulk`, { token: owner(), body: { ids: [id], action: 'delete' } });
    assert.equal(del.body['changed'], 1);
    const orphans = await sql(`SELECT 1 FROM option_groups WHERE product_id = $1`, [id]);
    assert.equal(orphans.rows.length, 0);
  });
});

describe('Categories', () => {
  it('lists them in order with counts', async () => {
    const res = await call(api, 'GET', categories, { token: owner() });
    const rows = list(res.body['categories']);
    assert.deepEqual(rows.map((r) => r['name']), ['Mains', 'Drinks']);
    const mains = asJson(rows[0]);
    assert.ok(Number(mains['productCount']) >= 8);
    assert.ok(Number(mains['activeCount']) < Number(mains['productCount']), 'a draft is in it but not live');
  });

  it('adds, refuses a duplicate in any case, renames, hides', async () => {
    const added = await call(api, 'POST', categories, { token: owner(), body: { name: '  Breakfast  ' } });
    assert.equal(added.status, 201);
    const rows = list(added.body['categories']);
    assert.equal(rows[rows.length - 1]!['name'], 'Breakfast');
    assert.equal(rows[rows.length - 1]!['productCount'], 0);

    const dup = await call(api, 'POST', categories, { token: owner(), body: { name: 'BREAKFAST' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body['code'], 'NAME_TAKEN');

    const id = String(rows[rows.length - 1]!['id']);
    const renamed = await call(api, 'PATCH', `${categories}/${id}`, { token: owner(), body: { name: 'Morning', isVisible: false } });
    const after = list(renamed.body['categories']).find((c) => c['id'] === id)!;
    assert.equal(after['name'], 'Morning');
    assert.equal(after['isVisible'], false);

    const clash = await call(api, 'PATCH', `${categories}/${id}`, { token: owner(), body: { name: 'mains' } });
    assert.equal(clash.status, 409);

    const missing = await call(api, 'PATCH', `${categories}/00000000-0000-4000-8000-000000000bad`, { token: owner(), body: { name: 'x' } });
    assert.equal(missing.status, 404);
  });

  it('a hidden section stops being served by the storefront', async () => {
    await call(api, 'PATCH', `${categories}/${CATALOGUE.drinks}`, { token: owner(), body: { isVisible: false } });
    const slug = (await sql<{ slug: string }>(`SELECT slug FROM stores WHERE id = $1`, [STORE.a])).rows[0]!.slug;
    const shop = await call(api, 'GET', `/api/storefront/${slug}`, {});
    const names = JSON.stringify(shop.body);
    assert.ok(!names.includes('"Drinks"'), 'the hidden section is not offered');
    await call(api, 'PATCH', `${categories}/${CATALOGUE.drinks}`, { token: owner(), body: { isVisible: true } });
  });

  it('reorders by sending the whole order — and refuses a stale one', async () => {
    const current = list((await call(api, 'GET', categories, { token: owner() })).body['categories']).map((c) => String(c['id']));
    const reversed = [...current].reverse();
    const res = await call(api, 'PUT', `${categories}/order`, { token: owner(), body: { ids: reversed } });
    assert.deepEqual(list(res.body['categories']).map((c) => c['id']), reversed);

    const stale = await call(api, 'PUT', `${categories}/order`, { token: owner(), body: { ids: reversed.slice(1) } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body['code'], 'ORDER_STALE');
    const dupes = await call(api, 'PUT', `${categories}/order`, { token: owner(), body: { ids: [reversed[0], reversed[0], ...reversed.slice(2)] } });
    assert.equal(dupes.status, 409);
  });

  it('deleting a section keeps its products', async () => {
    const before = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM products WHERE store_id = $1`, [STORE.a]);
    const res = await call(api, 'DELETE', `${categories}/${CATALOGUE.drinks}`, { token: owner() });
    assert.equal(res.status, 200);
    assert.equal(res.body['detached'], 1);
    const after = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM products WHERE store_id = $1`, [STORE.a]);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n);
    const gone = await call(api, 'DELETE', `${categories}/${CATALOGUE.drinks}`, { token: owner() });
    assert.equal(gone.status, 404);
  });
});
