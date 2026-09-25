// server/test/api/payouts.test.ts — milestone 11.
//
// The keyset cursor, against the case that breaks a naive one: rows whose timestamps are
// IDENTICAL.
//
// Milestone 10 shipped this bug and had to fix it. Six notifications written in one
// transaction share `now()` to the microsecond, and a cursor on the timestamp alone
// either skips the row after the boundary or repeats the row before it. §2.3 asks for
// keyset pagination "for anything that grows"; this is what makes the keyset correct
// rather than merely present.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { STORE, USER, cleanup, seedFixtures } from './support.ts';

let api: Api;
let owner = '';

/** All three share this instant, which is the whole point of the test. */
const SAME_INSTANT = '2026-09-01T08:00:00.000Z';

const PAYOUTS = [
  { id: 'eeeeeeee-0000-4000-8000-0000000000f1', amount: '1000.00', key: 'keyset-1' },
  { id: 'eeeeeeee-0000-4000-8000-0000000000f2', amount: '2000.00', key: 'keyset-2' },
  { id: 'eeeeeeee-0000-4000-8000-0000000000f3', amount: '3000.00', key: 'keyset-3' },
];

before(async () => {
  process.env.RATE_LIMIT_DISABLED = 'true';
  await seedFixtures();

  // Written directly rather than through request_withdrawal(): that function moves money
  // and needs the store verified, and what is under test is the cursor, not the money
  // path. Milestone 23 owns requesting a payout.
  for (const p of PAYOUTS) {
    await sql(
      `INSERT INTO withdrawals (id, store_id, amount, phone, status, idempotency_key, requested_at)
            VALUES ($1, $2, $3, '078 111 4412', 'pending', $4, $5::timestamptz)`,
      [p.id, STORE.a, p.amount, p.key, SAME_INSTANT],
    );
  }

  api = await boot();
  owner = tokenFor(USER.ownerA);
});

after(async () => {
  await api.close();
  await sql(`DELETE FROM withdrawals WHERE store_id = $1`, [STORE.a]);
  await cleanup();
  await closePool();
});

describe('payout pagination', () => {
  it('walks three rows with one timestamp without skipping or repeating any', async () => {
    const first = await call(api, 'GET', `/api/stores/${STORE.a}/payouts?limit=2`, { token: owner });
    assert.equal(first.status, 200);

    const page1 = first.body['payouts'] as { id: string }[];
    assert.equal(page1.length, 2);

    const cursor = first.body['nextCursor'] as { requestedAt: string; id: string } | null;
    assert.notEqual(cursor, null, 'there is a third row, so there is a cursor');
    assert.ok(cursor);

    const second = await call(
      api,
      'GET',
      `/api/stores/${STORE.a}/payouts?limit=2&before=${encodeURIComponent(cursor.requestedAt)}&beforeId=${cursor.id}`,
      { token: owner },
    );
    assert.equal(second.status, 200);

    const page2 = second.body['payouts'] as { id: string }[];
    assert.equal(page2.length, 1, 'exactly the one row left — not zero, not two');
    assert.equal(second.body['nextCursor'], null);

    const seen = [...page1, ...page2].map((p) => p.id);
    assert.equal(new Set(seen).size, 3, 'no row appeared twice');
    assert.deepEqual(
      [...seen].sort(),
      PAYOUTS.map((p) => p.id).sort(),
      'and none was skipped',
    );
  });

  it('orders newest first, with the id breaking the tie deterministically', async () => {
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/payouts`, { token: owner });
    const ids = (reply.body['payouts'] as { id: string }[]).map((p) => p.id);

    // ORDER BY requested_at DESC, id DESC. With one timestamp, the id decides — and it
    // has to decide the same way every time or the cursor cannot be trusted.
    assert.deepEqual(ids, [...PAYOUTS].map((p) => p.id).reverse());

    const again = await call(api, 'GET', `/api/stores/${STORE.a}/payouts`, { token: owner });
    assert.deepEqual((again.body['payouts'] as { id: string }[]).map((p) => p.id), ids);
  });

  it('refuses half a cursor rather than silently paging from the start', async () => {
    const orphanId = await call(
      api,
      'GET',
      `/api/stores/${STORE.a}/payouts?beforeId=${PAYOUTS[0]?.id ?? ''}`,
      { token: owner },
    );
    assert.equal(orphanId.status, 400);
    assert.equal(orphanId.body['code'], 'INVALID_CURSOR');

    const badId = await call(
      api,
      'GET',
      `/api/stores/${STORE.a}/payouts?before=${encodeURIComponent(SAME_INSTANT)}&beforeId=nonsense`,
      { token: owner },
    );
    assert.equal(badId.status, 400);
  });

  it('caps the page size instead of honouring a request for everything', async () => {
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/payouts?limit=100000`, { token: owner });
    assert.equal(reply.status, 200);
    // MAX_PAGE is 100 in repositories/money.ts. Three rows exist, so the assertion is
    // that the request was accepted and bounded rather than refused.
    assert.equal((reply.body['payouts'] as unknown[]).length, 3);

    const nonsense = await call(api, 'GET', `/api/stores/${STORE.a}/payouts?limit=0`, { token: owner });
    assert.equal(nonsense.status, 400, 'a limit of zero is a mistake, not a page');
  });

  it('a manager still cannot see any of it', async () => {
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/payouts?limit=2`, {
      token: tokenFor(USER.managerA),
    });
    assert.equal(reply.status, 403);
  });
});
