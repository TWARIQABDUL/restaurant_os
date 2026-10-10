// server/test/api/errorPages.test.ts — milestone 28: what ErrorPages needs from the server.
//
//   1. A SERVER ERROR HAS A REFERENCE, and a client error does not: "Errors always give a reference so support can find the failed
//      request" — random, in the log line and in the body, never derived from anything private.
//   2. "DID YOU MEAN …?" offers at most one LIVE store within two typos, and never a suspended or pending one, and never the exact
//      address (that store exists — the caller has the wrong idea, not the wrong spelling).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { distance } from '../../src/routes/lookup.ts';
import { boot, call } from './client.ts';
import type { Api } from './client.ts';
import { STORE, cleanup, seedFixtures } from './support.ts';

let api: Api;

before(async () => {
  api = await boot();
  await seedFixtures();
});

after(async () => {
  await cleanup();
  await api.close();
  await closePool();
});

describe('the edit distance', () => {
  it('counts typos, and gives up past the limit', () => {
    assert.equal(distance('nyama', 'nyama'), 0);
    assert.equal(distance('nyamaa', 'nyama'), 1);
    assert.equal(distance('nyma', 'nyama'), 1);
    assert.equal(distance('nayma', 'nyama'), 2, 'a swap is two edits');
    assert.ok(distance('kigali', 'nyama') > 2);
    assert.ok(distance('a', 'abcdef') > 2, 'lengths too far apart are far');
  });
});

describe('did you mean', () => {
  it('suggests the live store a typo points at', async () => {
    const r = await call(api, 'GET', '/api/lookup/store?near=escalation-store-aa');
    assert.equal(r.status, 200);
    assert.equal(r.body['slug'], 'escalation-store-a');
    assert.equal(r.body['name'], 'Escalation Store A');
  });

  it('suggests nothing for the exact address, for something far away, or for nonsense', async () => {
    assert.notEqual((await call(api, 'GET', '/api/lookup/store?near=escalation-store-a')).body['slug'], 'escalation-store-a', 'the exact address is never offered back to itself');
    assert.equal((await call(api, 'GET', '/api/lookup/store?near=zzzzzzzzzz')).body['slug'], null);
    assert.equal((await call(api, 'GET', '/api/lookup/store?near=')).body['slug'], null);
    assert.equal((await call(api, 'GET', '/api/lookup/store?near=Not%20A%20Slug!')).body['slug'], null);
    assert.equal((await call(api, 'GET', '/api/lookup/store')).status, 200);
  });

  it('never suggests a store that is suspended or pending', async () => {
    // Both fixture stores are one typo from each other, so both must be out of the running for "nothing" to be the right answer.
    for (const status of ['suspended', 'pending']) {
      await sql(`UPDATE stores SET status = $1 WHERE id = ANY($2::uuid[])`, [status, [STORE.a, STORE.b]]);
      assert.equal((await call(api, 'GET', '/api/lookup/store?near=escalation-store-aa')).body['slug'], null, status);
    }
    await sql(`UPDATE stores SET status = 'active' WHERE id = ANY($1::uuid[])`, [[STORE.a, STORE.b]]);
  });

  it('chooses the closest', async () => {
    const near = await call(api, 'GET', '/api/lookup/store?near=escalation-store-bb');
    assert.equal(near.body['slug'], 'escalation-store-b');
  });
});

describe('references', () => {
  it('a 4xx has none', async () => {
    const r = await call(api, 'GET', '/api/storefront/no-such-store-here');
    assert.equal(r.status, 404);
    assert.equal(r.body['reference'], undefined);
  });
});
