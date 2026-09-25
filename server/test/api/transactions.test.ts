// server/test/api/transactions.test.ts — milestone 11.
//
// The transaction helper itself. Everything that writes money in Stage D goes through
// it, so the guarantees it claims are asserted here rather than assumed.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  closePool,
  currentTx,
  getPool,
  readConsistent,
  requireTx,
  sql,
  withTransaction,
} from '../../src/db/index.ts';

// Its own id range, so this file cannot collide with the fixtures in support.ts.
const STORE_ID = 'eeeeeef0-0000-4000-8000-000000000001';
const SLUG = 'transaction-helper-test';

async function storeExists(): Promise<boolean> {
  const { rows } = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM stores WHERE id = $1`, [
    STORE_ID,
  ]);
  return Number(rows[0]?.n ?? '0') > 0;
}

async function removeStore(): Promise<void> {
  await sql(`DELETE FROM wallets WHERE store_id = $1`, [STORE_ID]);
  await sql(`DELETE FROM stores WHERE id = $1`, [STORE_ID]);
}

async function insertStore(tx: { query: typeof sql }): Promise<void> {
  await tx.query(
    `INSERT INTO stores (id, slug, name, country, selling_currency, status)
          VALUES ($1, $2, 'Transaction Helper Test', 'RW', 'RWF', 'pending')`,
    [STORE_ID, SLUG],
  );
}

before(async () => {
  await removeStore();
});

after(async () => {
  await removeStore();
  await closePool();
});

describe('withTransaction', () => {
  it('commits what the callback did', async () => {
    await withTransaction(async (tx) => insertStore(tx));
    assert.equal(await storeExists(), true);
    await removeStore();
  });

  it('rolls back everything when the callback throws', async () => {
    await assert.rejects(
      () =>
        withTransaction(async (tx) => {
          await insertStore(tx);
          // The store AND its wallet — V005's trigger created one — must both vanish.
          throw new Error('deliberate');
        }),
      /deliberate/,
    );

    assert.equal(await storeExists(), false);
    const { rows } = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM wallets WHERE store_id = $1`, [
      STORE_ID,
    ]);
    assert.equal(rows[0]?.n, '0', 'the trigger-created wallet went with it');
  });

  it('refuses transaction control from inside the callback', async () => {
    // A caller that commits early leaves the rest of its own callback running outside
    // any transaction at all.
    for (const statement of ['COMMIT', 'ROLLBACK', 'BEGIN', 'SAVEPOINT mine']) {
      await assert.rejects(
        () => withTransaction(async (tx) => tx.query(statement)),
        /owns the transaction/,
        statement,
      );
    }
  });

  it('retries a serialization failure and then succeeds', async () => {
    let attempts = 0;

    const result = await withTransaction(
      async (tx) => {
        attempts += 1;
        if (attempts === 1) {
          // The shape Postgres raises. withTransaction reads the SQLSTATE, not the class.
          const err: Error & { code?: string } = new Error('could not serialize access');
          err.code = '40001';
          throw err;
        }
        await insertStore(tx);
        return 'second time';
      },
      { retries: 2, label: 'retry test' },
    );

    assert.equal(result, 'second time');
    assert.equal(attempts, 2);
    assert.equal(await storeExists(), true, 'the retry committed');
    await removeStore();
  });

  it('does not retry anything else', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withTransaction(
          async () => {
            attempts += 1;
            const err: Error & { code?: string } = new Error('duplicate key');
            err.code = '23505';
            throw err;
          },
          { retries: 3 },
        ),
      /duplicate key/,
    );
    // A unique violation is a decision the database made on purpose; repeating it just
    // makes the caller wait.
    assert.equal(attempts, 1);
  });

  it('gives up after the retry budget', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withTransaction(
          async () => {
            attempts += 1;
            const err: Error & { code?: string } = new Error('deadlock detected');
            err.code = '40P01';
            throw err;
          },
          { retries: 2 },
        ),
      /deadlock detected/,
    );
    assert.equal(attempts, 3, 'the first attempt plus two retries');
  });
});

describe('nesting', () => {
  it('a nested call joins the outer transaction under a savepoint', async () => {
    await withTransaction(async (outer) => {
      await insertStore(outer);
      assert.equal(outer.depth, 1);

      // The inner failure is contained: the outer transaction survives it.
      await assert.rejects(
        () =>
          withTransaction(async (inner) => {
            assert.equal(inner.depth, 2, 'joined, not a second connection');
            await inner.query(`UPDATE stores SET name = 'renamed by the inner call' WHERE id = $1`, [
              STORE_ID,
            ]);
            throw new Error('inner failed');
          }),
        /inner failed/,
      );

      // The outer transaction can still write, which it could not if the inner failure
      // had aborted it.
      await outer.query(`UPDATE stores SET status = 'active' WHERE id = $1`, [STORE_ID]);
    });

    const { rows } = await sql<{ name: string; status: string }>(
      `SELECT name, status FROM stores WHERE id = $1`,
      [STORE_ID],
    );
    assert.equal(rows[0]?.status, 'active', 'the outer transaction committed');
    assert.equal(
      rows[0]?.name,
      'Transaction Helper Test',
      'the inner rename was rolled back to the savepoint',
    );
    await removeStore();
  });

  it('a nested commit still depends on the outer one', async () => {
    await assert.rejects(
      () =>
        withTransaction(async (outer) => {
          await withTransaction(async (inner) => insertStore(inner));
          await outer.query(`SELECT 1`);
          throw new Error('outer failed after the inner succeeded');
        }),
      /outer failed/,
    );
    assert.equal(await storeExists(), false, 'nothing the inner call wrote survived');
  });

  it('currentTx and requireTx see the transaction, and only inside it', async () => {
    assert.equal(currentTx(), null);
    assert.throws(() => requireTx('a multi-row write'), /must run inside withTransaction/);

    await withTransaction(async () => {
      assert.notEqual(currentTx(), null);
      assert.equal(requireTx('a multi-row write').depth, 1);
    });

    assert.equal(currentTx(), null, 'and it is gone again afterwards');
  });
});

describe('readConsistent', () => {
  it('reads, and refuses to write', async () => {
    const count = await readConsistent(async (tx) => {
      const { rows } = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM role_permissions`);
      return Number(rows[0]?.n ?? '0');
    });
    assert.ok(count > 0);

    await assert.rejects(
      () => readConsistent(async (tx) => insertStore(tx)),
      (err: unknown) => {
        // 25006: read-only sql transaction. The point of a read-only transaction is that
        // a write in the middle of a report is an error rather than a surprise.
        assert.equal((err as { code?: string }).code, '25006');
        return true;
      },
    );
  });
});

describe('the SELECT * rule', () => {
  it('is refused on the pool and inside a transaction', async () => {
    // §2.3: "Explicit column lists. No SELECT * — it breaks silently on a new column
    // and defeats covering indexes." Enforced rather than reviewed.
    await assert.rejects(() => sql(`SELECT * FROM role_permissions LIMIT 1`), /SELECT \* is not allowed/);
    await assert.rejects(
      () => withTransaction(async (tx) => tx.query(`SELECT * FROM role_permissions LIMIT 1`)),
      /SELECT \* is not allowed/,
    );
  });

  it('does not mistake count(*) or a qualified star for a projection', async () => {
    const counted = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM role_permissions`);
    assert.ok(Number(counted.rows[0]?.n) > 0);

    const jsonb = await sql<{ row: unknown }>(
      `SELECT to_jsonb(rp.*) AS row FROM role_permissions rp LIMIT 1`,
    );
    assert.equal(jsonb.rows.length, 1);
  });
});

describe('the pool is not leaked', () => {
  it('returns every connection after 300 transactions, half of them failing', async () => {
    // THE FAILURE THIS CATCHES IS AN OUTAGE. A client that is checked out and never
    // released is gone for the life of the process; ten of them against max=10 and every
    // subsequent request waits for connectionTimeoutMillis and then 500s. It would not
    // show up in any of the tests above, because each of those releases its one client.
    const pool = getPool();
    const before = pool.totalCount;

    const work = Array.from({ length: 300 }, (_unused, i) =>
      withTransaction(async (tx) => {
        await tx.query(`SELECT count(*)::text AS n FROM role_permissions`);
        if (i % 2 === 0) throw new Error(`deliberate ${i}`);
        return i;
      }).catch(() => -1),
    );

    const results = await Promise.all(work);
    assert.equal(results.filter((r) => r === -1).length, 150, 'half of them failed');

    // Nothing is still checked out. waitingCount would be non-zero if a caller were
    // queued behind a client that never came back.
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount, 'every connection is idle again');
    assert.ok(
      pool.totalCount <= Math.max(before, Number(process.env.PGPOOL_MAX ?? '10')),
      `the pool did not grow past its ceiling (${pool.totalCount})`,
    );

    // And it still works, which is the part a leak breaks.
    const { rows } = await sql<{ n: string }>(`SELECT 1::text AS n`);
    assert.equal(rows[0]?.n, '1');
  });

  it('releases the connection when a savepoint-nested call fails too', async () => {
    const pool = getPool();

    for (let i = 0; i < 40; i += 1) {
      await withTransaction(async (outer) => {
        await withTransaction(async (inner) => {
          await inner.query(`SELECT 1`);
          throw new Error('inner');
        }).catch(() => undefined);
        await outer.query(`SELECT 1`);
      });
    }

    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount);
  });
});
