// server/test/api/exports.test.ts — milestone 28: the orders CSV (PrintExports' export dialog).
//
//   1. WHO: orders.read — a manager can, a rider and another store's admin cannot, and one store's export never holds another's orders.
//   2. WHAT: only the columns asked for; the period is the store's own; a formula in a customer's name is defused; over the cap is refused
//      with a sentence rather than an enormous file.
//   3. LOGGED: every download is a SENSITIVE audit entry — who, how many, and whether phone numbers were in it.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { CONSOLE, STORE, USER, cleanup, seedConsole, seedFixtures, seedStorefront } from './support.ts';

let api: Api;
const owner = (): string => tokenFor(USER.ownerA);
const base = `/api/stores/${STORE.a}/exports/orders`;

async function csv(query: string, token = owner()): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(`${api.baseUrl}${base}?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  await seedConsole();
  await sql(`UPDATE orders SET guest_name = '=HYPERLINK("http://evil.test")' WHERE id = $1`, [CONSOLE.newestPending]);
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
});

describe('who may', () => {
  it('a manager can; a rider and another store’s admin cannot; nobody without a session', async () => {
    assert.equal((await csv('range=today', tokenFor(USER.managerA))).status, 200);
    assert.equal((await csv('range=today', tokenFor(USER.riderA))).status, 403);
    assert.equal((await csv('range=today', tokenFor(USER.adminB))).status, 403);
    assert.equal((await call(api, 'GET', `${base}?range=today`)).status, 401);
  });
});

describe('the file', () => {
  it('counts first, without building anything', async () => {
    const r = await call(api, 'GET', `${base}?range=today&count=1`, { token: owner() });
    assert.equal(r.status, 200);
    assert.ok(Number(r.body['rows']) >= 3, 'the console fixtures are all today’s');
  });

  it('is a CSV download with the columns asked for and no others', async () => {
    const r = await csv('range=today&cols=customer');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="orders-\d{4}-\d{2}-\d{2}-today\.csv"/);
    const header = r.text.split('\r\n')[0]!;
    assert.equal(header, '"Order","Placed","Status","Type","Total","Currency","Customer"');
    assert.ok(!r.text.includes('078 000 0001'), 'no phone column, no phone numbers');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  it('with phone and payment and rider, it says so in the header and carries them', async () => {
    const r = await csv('range=today&cols=items,customer,phone,payment,rider');
    const header = r.text.split('\r\n')[0]!;
    assert.match(header, /"Items","Customer","Customer phone","Payment method","Payment status","Rider","Delivered"$/);
    assert.ok(r.text.includes('078 000 0001'));
    assert.ok(r.text.includes('Passion Juice'));
  });

  it('defuses a formula typed as a name', async () => {
    const r = await csv('range=today&cols=customer');
    assert.ok(r.text.includes(`"'=HYPERLINK(""http://evil.test"")"`), 'prefixed with an apostrophe, quotes doubled');
    assert.ok(!r.text.includes(',"=HYPERLINK'), 'never a bare formula cell');
  });

  it('holds only this store’s orders, in the store’s own period', async () => {
    const mine = await csv('range=today&cols=customer');
    const n = mine.text.trim().split('\r\n').length - 1;
    assert.equal(n, Number((await call(api, 'GET', `${base}?range=today&count=1`, { token: owner() })).body['rows']));
    const lastMonth = await csv('range=last_month');
    assert.equal(lastMonth.text.trim().split('\r\n').length, 1, 'last month has none of today’s orders — just the header');
    const week = await csv('range=week');
    assert.ok(week.text.trim().split('\r\n').length - 1 >= n, 'a week contains today');
  });
});

describe('refusals', () => {
  it('an unknown period, an unknown column and a missing period are each a 400', async () => {
    assert.equal((await csv('range=forever')).status, 400);
    assert.equal((await csv('')).status, 400);
    assert.equal((await csv('range=today&cols=password')).status, 400);
  });

  it('unticking every column is a file of just the orders, not the default set', async () => {
    const r = await csv('range=today&cols=');
    assert.equal(r.text.split('\r\n')[0], '"Order","Placed","Status","Type","Total","Currency"');
  });
});

describe('the log', () => {
  it('every download is a sensitive entry, and one with phone numbers says so', async () => {
    const before = Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'export_orders' AND store_id = $1`, [STORE.a])).rows[0]!.n);
    await csv('range=today&cols=customer');
    await csv('range=today&cols=customer,phone');
    const rows = (await sql<{ category: string; summary: string; actor_id: string; detail: string }>(`SELECT category, summary, actor_id, detail FROM audit_log WHERE action = 'export_orders' AND store_id = $1 ORDER BY sequence DESC LIMIT 2`, [STORE.a])).rows;
    assert.equal(Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'export_orders' AND store_id = $1`, [STORE.a])).rows[0]!.n), before + 2);
    assert.ok(rows.every((r) => r.category === 'sensitive' && r.actor_id === USER.ownerA));
    assert.match(rows[0]!.summary, /including customer phone numbers/);
    assert.ok(!/phone numbers/.test(rows[1]!.summary));
    assert.match(rows[0]!.detail, /columns: customer, phone/);
  });

  it('a count is not a download and is not logged', async () => {
    const before = Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'export_orders' AND store_id = $1`, [STORE.a])).rows[0]!.n);
    await call(api, 'GET', `${base}?range=today&count=1`, { token: owner() });
    assert.equal(Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'export_orders' AND store_id = $1`, [STORE.a])).rows[0]!.n), before);
  });
});
