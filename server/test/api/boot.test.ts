// server/test/api/boot.test.ts — milestone 11.
//
// The refusals. Each one exists because the alternative is a server that starts and then
// behaves wrongly in a way nobody notices:
//
//   * no APP_DATABASE_URL           — would fall through to whatever the first query
//                                     found, or hang on the first request
//   * the owner role                — the application would run with DDL rights
//   * a weak or absent JWT_SECRET   — everything works, including forged tokens
//   * an unreachable database       — 500 to real users instead of a failed deploy
//   * a permission string nobody has — 403 for everybody, reading as a broken role
//
// The first four are asserted by SPAWNING the entrypoint, because a refusal is
// process.exit(1) and a message on stderr — behaviour a function call cannot show.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { REQUIRED_PERMISSIONS } from '../../src/api/app.ts';
import { closePool, sql } from '../../src/db/index.ts';
import { assertPermissionsExist } from '../../src/middleware/authorize.ts';

const run = promisify(execFile);

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINT = path.join(SERVER_ROOT, 'src/api/server.ts');

const GOOD_SECRET = 'a-secret-long-enough-to-satisfy-the-assertion-0123456789';

/**
 * Boots the entrypoint with exactly the environment given.
 *
 * NOTHING IS INHERITED, so a variable set in this process cannot make a test pass. PATH is
 * kept because Node needs it, and API_PORT is a port nothing else uses: none of these runs
 * should get as far as listening, and one that did would fail on a busy port rather than
 * hold one.
 *
 * ENV_FILE points at a path that does not exist, which is the only way these assertions
 * mean anything: api/env.ts loads server/.env, a developer's copy of which supplies
 * APP_DATABASE_URL and JWT_SECRET — so with the real file loaded, "refuses to start without
 * APP_DATABASE_URL" would start perfectly well and the test would be measuring nothing.
 * That is not hypothetical; it is what this test caught.
 */
async function boot(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  try {
    await run(process.execPath, [ENTRYPOINT], {
      env: {
        PATH: process.env.PATH ?? '',
        API_PORT: '5399',
        ENV_FILE: path.join(SERVER_ROOT, 'test/api/.env.does-not-exist'),
        ...env,
      },
      cwd: SERVER_ROOT,
      timeout: 30_000,
    });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    return { code: e.code ?? -1, stderr: e.stderr ?? '' };
  }
}

after(async () => {
  await closePool();
});

describe('the server refuses to start when it is not safe to', () => {
  it('without APP_DATABASE_URL', async () => {
    const { code, stderr } = await boot({ JWT_SECRET: GOOD_SECRET });
    assert.equal(code, 1);
    assert.match(stderr, /APP_DATABASE_URL is not set/);
    // And it says what to do about it, with the local value spelled out.
    assert.match(stderr, /vendlyfy_app/);
  });

  it('when the connection string is the schema owner', async () => {
    const { code, stderr } = await boot({
      JWT_SECRET: GOOD_SECRET,
      APP_DATABASE_URL: 'postgresql://vendlyfy_owner:localdev@127.0.0.1:55432/vendlyfy',
    });
    assert.equal(code, 1);
    assert.match(stderr, /owns the schema and can run DDL/);
    assert.match(stderr, /APP_DB_ALLOW_OWNER=true/, 'and names the explicit escape hatch');
  });

  it('when the connection string is not a postgres URL', async () => {
    const { code, stderr } = await boot({
      JWT_SECRET: GOOD_SECRET,
      APP_DATABASE_URL: 'https://db.example.supabase.co/postgres',
    });
    assert.equal(code, 1);
    assert.match(stderr, /must be a postgres:\/\/ URL/);
  });

  it('when JWT_SECRET is too short, and when it is a placeholder', async () => {
    const url = process.env.APP_DATABASE_URL ?? '';

    const short = await boot({ JWT_SECRET: 'short', APP_DATABASE_URL: url });
    assert.equal(short.code, 1);
    assert.match(short.stderr, /JWT_SECRET is only 5 characters/);

    const placeholder = await boot({ JWT_SECRET: 'your_jwt_secret_here', APP_DATABASE_URL: url });
    assert.equal(placeholder.code, 1);
    assert.match(placeholder.stderr, /still a placeholder/);
  });

  it('when the database is unreachable — before it accepts any traffic', async () => {
    const { code, stderr } = await boot({
      JWT_SECRET: GOOD_SECRET,
      // Port 55499: nothing listens there, and it is not 5432, so a mistyped host cannot
      // reach a real database instead.
      APP_DATABASE_URL: 'postgresql://vendlyfy_app:localdev@127.0.0.1:55499/vendlyfy',
      PGPOOL_CONNECT_MS: '2000',
    });
    assert.equal(code, 1);
    assert.match(stderr, /cannot reach the database/);
    assert.match(stderr, /npm run db:up/, 'and says how to fix it locally');
  });
});

describe('every permission the routes ask for exists', () => {
  it('passes for the real list', async () => {
    await assertPermissionsExist(REQUIRED_PERMISSIONS);
  });

  it('names a misspelt one instead of letting it become 403 for everybody', async () => {
    // The failure this prevents is silent: the guard finds 'wallet.raed' in nobody's
    // permission set, so every caller is refused and it reads as a role problem. V001
    // refuses a typo'd ROLE at the column for the same reason and says so; the
    // permission half lives in application code, where no constraint can see it.
    await assert.rejects(
      () => assertPermissionsExist(['wallet.read', 'wallet.raed', 'payuots.request']),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /wallet\.raed/);
        assert.match(message, /payuots\.request/);
        assert.equal(message.includes('wallet.read,'), false, 'and does not accuse the valid one');
        return true;
      },
    );
  });

  it('the four the routes require are the four in role_permissions', async () => {
    const { rows } = await sql<{ permission: string }>(
      `SELECT DISTINCT permission
         FROM role_permissions
        WHERE permission = ANY($1::text[])
        ORDER BY permission`,
      [[...REQUIRED_PERMISSIONS]],
    );
    assert.deepEqual(
      rows.map((r) => r.permission),
      [...REQUIRED_PERMISSIONS].sort(),
    );
  });
});
