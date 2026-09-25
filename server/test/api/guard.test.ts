// server/test/api/guard.test.ts — milestone 11.
//
// The guard's edges: what a bad token does, what a deleted account does, and the two
// deliberate refusals that look like bugs until you read why they are not — a
// super_admin with no store bypass, and a customer who can never hold a membership.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { closePool, sql } from '../../src/db/index.ts';
import { signSessionToken } from '../../src/auth/sessionToken.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { EMAIL_DOMAIN, STORE, USER, cleanup, seedFixtures } from './support.ts';

let api: Api;

before(async () => {
  process.env.RATE_LIMIT_DISABLED = 'true';
  await seedFixtures();
  api = await boot();
});

after(async () => {
  await api.close();
  await cleanup();
  await closePool();
});

describe('authentication', () => {
  it('no token is 401', async () => {
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`);
    assert.equal(reply.status, 401);
    assert.equal(reply.body['code'], 'UNAUTHENTICATED');
  });

  it('a token signed with another secret is 401', async () => {
    const forged = jwt.sign({ sub: USER.ownerA, typ: 'session' }, 'a-different-secret-entirely-32chars');
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: forged });
    assert.equal(reply.status, 401);
    assert.equal(reply.body['code'], 'SESSION_INVALID');
  });

  it('an expired token says so, so a client can tell it apart from a forged one', async () => {
    const expired = signSessionToken(USER.ownerA, { expiresInSeconds: -10 });
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: expired });
    assert.equal(reply.status, 401);
    assert.equal(reply.body['code'], 'SESSION_EXPIRED');
  });

  it('a socket ticket is not a session', async () => {
    // Socket tickets live 60 seconds and are handed to a WebSocket handshake. `typ`
    // separates them from sessions in the legacy server too; requiring it here means a
    // ticket can never stand in for a session.
    const ticket = jwt.sign(
      { userId: USER.ownerA, typ: 'socket' },
      process.env.JWT_SECRET ?? '',
      { expiresIn: 60 },
    );
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: ticket });
    assert.equal(reply.status, 401);
    assert.equal(reply.body['code'], 'SESSION_INVALID');
  });

  it('a token with no typ — the shape the OLD server issues — is 401', async () => {
    const legacy = jwt.sign(
      { userId: USER.ownerA, tenantId: STORE.a, role: 'admin' },
      process.env.JWT_SECRET ?? '',
      { expiresIn: 3600 },
    );
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: legacy });
    assert.equal(reply.status, 401);
  });

  it('a token for an account that has since been deleted is 401, not 403', async () => {
    const id = 'eeeeeeee-0000-4000-8000-0000000000aa';
    await sql(
      `INSERT INTO users (id, scope, email, name, password_hash)
            VALUES ($1, 'platform', $2, 'Temporary', 'x')`,
      [id, `temporary@${EMAIL_DOMAIN}`],
    );
    const theirToken = tokenFor(id);

    const alive = await call(api, 'GET', '/api/session', { token: theirToken });
    assert.equal(alive.status, 200);

    await sql(`DELETE FROM users WHERE id = $1`, [id]);

    const gone = await call(api, 'GET', '/api/session', { token: theirToken });
    assert.equal(gone.status, 401, 'there is nobody left to authorize');
    assert.equal(gone.body['code'], 'ACCOUNT_GONE');
  });
});

describe('no super_admin bypass', () => {
  it('the platform team does not reach a merchant’s own endpoints', async () => {
    // Deliberate, and the reasoning is in repositories/authContext.ts: V001 gave the
    // platform team explicit permissions "rather than as a wildcard", and those are
    // PLATFORM permissions. The admin console (milestone 27) is where a super_admin
    // acts on a store, with payouts.process and its own audit entry — not by borrowing
    // the merchant's endpoint.
    for (const path of ['wallet', 'payouts', 'settings', 'members']) {
      const reply = await call(api, 'GET', `/api/stores/${STORE.a}/${path}`, {
        token: tokenFor(USER.superAdmin),
      });
      assert.equal(reply.status, 403, `GET /${path} is refused for a super_admin`);
    }
  });

  it('but their platform permissions are real and visible', async () => {
    const reply = await call(api, 'GET', '/api/session', { token: tokenFor(USER.superAdmin) });
    assert.equal(reply.status, 200);
    assert.equal(reply.body['platformRole'], 'super_admin');
    const perms = reply.body['platformPermissions'] as string[];
    assert.ok(perms.includes('kyc.review'));
    assert.ok(perms.includes('payouts.process'));
    assert.equal(perms.includes('wallet.read'), false, 'a store permission is not among them');
  });
});

describe('a customer is not staff', () => {
  it('a customer of the store is refused every console endpoint', async () => {
    for (const path of ['wallet', 'payouts', 'settings', 'members']) {
      const reply = await call(api, 'GET', `/api/stores/${STORE.a}/${path}`, {
        token: tokenFor(USER.customerA),
      });
      assert.equal(reply.status, 403);
    }
  });

  it('and cannot be given a membership even by a direct write', async () => {
    // The declarative half: users carries UNIQUE (id, scope) and store_members a
    // composite FK requiring 'platform'. No trigger, no application check — it holds
    // against a psql prompt too, which is what this asserts.
    await assert.rejects(
      () =>
        sql(`INSERT INTO store_members (user_id, store_id, role) VALUES ($1, $2, 'manager')`, [
          USER.customerA,
          STORE.a,
        ]),
      (err: unknown) => {
        const code = (err as { code?: string }).code;
        // 23503: the composite foreign key finds no ('<id>', 'platform') in users.
        assert.equal(code, '23503');
        return true;
      },
    );
  });

  it('their session says which store the account belongs to', async () => {
    const reply = await call(api, 'GET', '/api/session', { token: tokenFor(USER.customerA) });
    assert.equal(reply.status, 200);
    const user = reply.body['user'] as Record<string, unknown>;
    assert.equal(user['scope'], 'store');
    assert.equal(user['customerStoreId'], STORE.a);
    assert.equal((reply.body['memberships'] as unknown[]).length, 0);
  });
});

describe('GET /api/session', () => {
  it('lists one person’s two stores with two different roles', async () => {
    // §5.4: Auth's store picker "requires one person to be Owner at Nyama & Co. AND
    // Manager at Inzu Threads" — the case a users.tenant_id column could not express.
    const reply = await call(api, 'GET', '/api/session', { token: tokenFor(USER.multiStore) });
    assert.equal(reply.status, 200);

    const mine = reply.body['memberships'] as { storeId: string; role: string }[];
    assert.equal(mine.length, 2);
    const byStore = new Map(mine.map((m) => [m.storeId, m.role]));
    assert.equal(byStore.get(STORE.a), 'admin');
    assert.equal(byStore.get(STORE.b), 'manager');
  });

  it('serves the role→permission map the invite screen renders', async () => {
    const reply = await call(api, 'GET', '/api/session', { token: tokenFor(USER.ownerA) });
    const roles = reply.body['roles'] as { scope: string; role: string; permissions: string[] }[];

    const manager = roles.find((r) => r.scope === 'store' && r.role === 'manager');
    assert.ok(manager, 'manager is in the map');
    // Auth's invite screen, verbatim: "accept and update orders, assign riders, edit
    // products and stock" — and "can't see payouts, the wallet or store settings".
    assert.deepEqual(
      [...manager.permissions].sort(),
      ['orders.assign_rider', 'orders.read', 'orders.update', 'products.write', 'stock.write'],
    );
    assert.equal(manager.permissions.includes('wallet.read'), false);
    assert.equal(manager.permissions.includes('payouts.request'), false);
    assert.equal(manager.permissions.includes('settings.write'), false);
  });
});

describe('request shape', () => {
  it('a malformed store id is a 400 that says so, not a 500 from Postgres', async () => {
    const reply = await call(api, 'GET', '/api/stores/not-a-uuid/wallet', { token: tokenFor(USER.ownerA) });
    assert.equal(reply.status, 400);
    assert.equal(reply.body['code'], 'INVALID_STORE_ID');
  });

  it('an unmatched path is a 404 in the same shape as every other failure', async () => {
    const reply = await call(api, 'GET', '/api/nothing-here', { token: tokenFor(USER.ownerA) });
    assert.equal(reply.status, 404);
    assert.equal(reply.body['code'], 'NO_SUCH_ROUTE');
    assert.equal(typeof reply.body['error'], 'string');
  });

  it('a malformed JSON body is a 400, not a 500', async () => {
    const res = await fetch(`${api.baseUrl}/api/stores/${STORE.a}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(USER.ownerA)}`, 'Content-Type': 'application/json' },
      body: '{"name": ',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['code'], 'INVALID_JSON');
  });

  it('an oversized body is 413, not 500', async () => {
    // express.json() caps bodies at 200kb. body-parser throws an error that already knows
    // its status; without the error handler reading it, one byte over the limit would come
    // back as "something went wrong on our side" and the caller would retry forever.
    const res = await fetch(`${api.baseUrl}/api/stores/${STORE.a}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(USER.ownerA)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(300_000), email: 'a@b.co', password: 'x'.repeat(12), role: 'manager' }),
    });
    assert.equal(res.status, 413);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['code'], 'BODY_TOO_LARGE');
  });

  it('health checks the database, not just the process', async () => {
    const reply = await call(api, 'GET', '/api/health');
    assert.equal(reply.status, 200);
    assert.equal(reply.body['database'], 'ok');
  });
});
