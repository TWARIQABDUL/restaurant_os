// server/test/api/writeFreeze.test.ts — milestone 30's cutover switch (middleware/writeFreeze.ts).
//
// Read live on every request, mounted ahead of CSRF and every router, so it is tested against the real
// app and a real socket — not the function in isolation — the same reasoning client.ts gives for every
// other guard test.

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { closePool } from '../../src/db/index.ts';
import { boot, call } from './client.ts';
import type { Api } from './client.ts';

let api: Api;

before(async () => {
  process.env.RATE_LIMIT_DISABLED = 'true';
  api = await boot();
});

after(async () => {
  await api.close();
  await closePool();
});

afterEach(() => {
  delete process.env.WRITE_FREEZE;
});

describe('the cutover write freeze', () => {
  it('leaves everything alone when unset', async () => {
    const health = await call(api, 'GET', '/api/health');
    assert.equal(health.status, 200);
    // password/reset always answers 200 regardless of whether the account exists (routes/password.ts) —
    // the point here is only that it is NOT refused as a frozen write.
    const write = await call(api, 'POST', '/api/password/reset', { body: { identifier: 'nobody@example.com' } });
    assert.equal(write.status, 200);
  });

  it('refuses a write with 503 once WRITE_FREEZE=on', async () => {
    process.env.WRITE_FREEZE = 'on';
    const write = await call(api, 'POST', '/api/password/reset', { body: { identifier: 'nobody@example.com' } });
    assert.equal(write.status, 503);
    assert.equal(write.body['error'], 'WRITE_FREEZE');
  });

  it('still answers reads while frozen — a health check has no reason to go down', async () => {
    process.env.WRITE_FREEZE = 'on';
    const health = await call(api, 'GET', '/api/health');
    assert.equal(health.status, 200);
  });

  it('takes effect without a restart, and lifts the same way', async () => {
    process.env.WRITE_FREEZE = 'on';
    const frozen = await call(api, 'POST', '/api/password/reset', { body: { identifier: 'nobody@example.com' } });
    assert.equal(frozen.status, 503);

    process.env.WRITE_FREEZE = 'off';
    const thawed = await call(api, 'POST', '/api/password/reset', { body: { identifier: 'nobody@example.com' } });
    assert.equal(thawed.status, 200);
  });
});
