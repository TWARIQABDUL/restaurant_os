// server/test/api/members.test.ts — milestone 11.
//
// Delegated creation as a whole operation: what it writes, what it refuses, and — the
// part that matters most — that a refusal leaves NOTHING behind.
//
// "we need atomic action on all levels": a staff row with no membership is an account
// that cannot sign in anywhere, and a rider with no profile cannot be given an order.
// Both are support tickets, so neither may be reachable by a request that failed
// halfway.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { EMAIL_DOMAIN, STORE, USER, cleanup, seedFixtures, userExistsWithEmail } from './support.ts';

let api: Api;
let owner = '';

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

async function memberCount(storeId: string): Promise<number> {
  const { rows } = await sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM store_members WHERE store_id = $1`,
    [storeId],
  );
  return Number(rows[0]?.n ?? '0');
}

describe('creating a member', () => {
  it('creates the identity, the membership and a rider’s profile in one transaction', async () => {
    const email = `new-rider@${EMAIL_DOMAIN}`;
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: owner,
      body: {
        name: 'New Rider',
        email,
        password: 'a-long-enough-password',
        role: 'rider',
        plateNumber: 'RAB 777 B',
      },
    });

    assert.equal(reply.status, 201);
    const member = reply.body['member'] as Record<string, unknown>;
    assert.equal(member['role'], 'rider');

    const { rows } = await sql<{ scope: string; role: string; plate_number: string; created_by: string }>(
      `SELECT u.scope, sm.role, rp.plate_number, sm.created_by
         FROM users u
         JOIN store_members sm ON sm.user_id = u.id AND sm.store_id = $2
         JOIN rider_profiles rp ON rp.user_id = u.id AND rp.store_id = $2
        WHERE lower(u.email) = lower($1)`,
      [email, STORE.a],
    );
    assert.equal(rows.length, 1, 'all three rows exist');
    assert.equal(rows[0]?.scope, 'platform', 'staff are platform-scoped, never store-scoped');
    assert.equal(rows[0]?.plate_number, 'RAB 777 B');
    // V001: "a rule without a record of its use cannot be reviewed after the fact."
    assert.equal(rows[0]?.created_by, USER.ownerA);
  });

  it('rolls the whole thing back when the plate is already taken', async () => {
    // The fixtures' rider holds RAX 100 A, and rider_profiles_store_plate_key strips
    // all whitespace and upper-cases — so this spelling collides on purpose.
    const email = `doomed@${EMAIL_DOMAIN}`;
    const before = await memberCount(STORE.a);

    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: owner,
      body: {
        name: 'Doomed Rider',
        email,
        password: 'a-long-enough-password',
        role: 'rider',
        plateNumber: ' rax100a ',
      },
    });

    assert.equal(reply.status, 409);
    assert.match(String(reply.body['error']), /plate number/i);

    // THE POINT: the user and the membership were written before the profile failed.
    assert.equal(await userExistsWithEmail(email), false, 'no identity survived');
    assert.equal(await memberCount(STORE.a), before, 'no membership survived');
  });

  it('a rider must have a plate, and only a rider may have one', async () => {
    const noPlate = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: owner,
      body: { name: 'Plateless', email: `plateless@${EMAIL_DOMAIN}`, password: 'a-long-enough-password', role: 'rider' },
    });
    assert.equal(noPlate.status, 400);
    assert.equal(noPlate.body['code'], 'MISSING_FIELD');

    const managerWithPlate = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: owner,
      body: {
        name: 'Manager With Plate',
        email: `mgr-plate@${EMAIL_DOMAIN}`,
        password: 'a-long-enough-password',
        role: 'manager',
        plateNumber: 'RAC 001 C',
      },
    });
    assert.equal(managerWithPlate.status, 400);

    assert.equal(await userExistsWithEmail(`plateless@${EMAIL_DOMAIN}`), false);
    assert.equal(await userExistsWithEmail(`mgr-plate@${EMAIL_DOMAIN}`), false);
  });

  it('a double-submitted form is a replay, answered 200 and written once', async () => {
    const body = {
      name: 'Replayed Manager',
      email: `replayed@${EMAIL_DOMAIN}`,
      password: 'a-long-enough-password',
      role: 'manager',
    };

    const first = await call(api, 'POST', `/api/stores/${STORE.a}/members`, { token: owner, body });
    assert.equal(first.status, 201);
    assert.equal(first.body['created'], true);

    const second = await call(api, 'POST', `/api/stores/${STORE.a}/members`, { token: owner, body });
    assert.equal(second.status, 200, 'not a 409 — the request already succeeded');
    assert.equal(second.body['created'], false);

    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM users WHERE lower(email) = lower($1)`,
      [body.email],
    );
    assert.equal(rows[0]?.n, '1', 'one account, two requests');
  });

  it('a different role for the same person is a conflict, not a silent change', async () => {
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: owner,
      body: {
        name: 'Replayed Manager',
        email: `replayed@${EMAIL_DOMAIN}`,
        password: 'a-long-enough-password',
        role: 'admin',
      },
    });
    assert.equal(reply.status, 409);
    assert.equal(reply.body['code'], 'ALREADY_A_MEMBER');

    const { rows } = await sql<{ role: string }>(
      `SELECT sm.role FROM store_members sm
         JOIN users u ON u.id = sm.user_id
        WHERE lower(u.email) = lower($1) AND sm.store_id = $2`,
      [`replayed@${EMAIL_DOMAIN}`, STORE.a],
    );
    assert.equal(rows[0]?.role, 'manager', 'the existing role is untouched');
  });

  it('an existing Vendlyfy account is refused rather than attached', async () => {
    // Attaching on nothing but an email address would hand the caller that person's
    // real name and phone number from the staff list, and give them a store they never
    // agreed to work at. Auth's invite screen is milestone 15.
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: owner,
      body: {
        name: 'Not Their Real Name',
        email: `admin-b@${EMAIL_DOMAIN}`, // an admin at store B
        password: 'a-long-enough-password',
        role: 'manager',
      },
    });

    assert.equal(reply.status, 409);
    assert.equal(reply.body['code'], 'ACCOUNT_EXISTS');
    // Nothing about who they are.
    assert.equal(String(reply.body['error']).includes('Admin B'), false);

    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM store_members WHERE user_id = $1`,
      [USER.adminB],
    );
    assert.equal(rows[0]?.n, '1', 'they gained no membership');
  });

  it('refuses a password below the floor, and writes nothing', async () => {
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: owner,
      body: { name: 'Weak', email: `weak@${EMAIL_DOMAIN}`, password: 'short', role: 'manager' },
    });
    assert.equal(reply.status, 400);
    assert.equal(reply.body['code'], 'TOO_SHORT');
    assert.equal(await userExistsWithEmail(`weak@${EMAIL_DOMAIN}`), false);
  });

  it('refuses an address that is not one', async () => {
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: owner,
      body: { name: 'Bad Email', email: 'not an email', password: 'a-long-enough-password', role: 'manager' },
    });
    assert.equal(reply.status, 400);
    assert.equal(reply.body['code'], 'INVALID_EMAIL');
  });
});

describe('the staff list', () => {
  it('orders by role then name, and carries a rider’s plate', async () => {
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/members`, { token: owner });
    assert.equal(reply.status, 200);

    const members = reply.body['members'] as { role: string; name: string; plate_number: string | null }[];
    const roles = members.map((m) => m.role);
    assert.equal(roles[0], 'owner', 'the owner is first');

    // Role groups do not interleave.
    const rank: Record<string, number> = { owner: 0, admin: 1, manager: 2, rider: 3 };
    for (let i = 1; i < roles.length; i += 1) {
      const prev = rank[roles[i - 1] ?? ''] ?? 9;
      const here = rank[roles[i] ?? ''] ?? 9;
      assert.ok(here >= prev, `${roles[i - 1]} then ${roles[i]}`);
    }

    const rider = members.find((m) => m.role === 'rider' && m.plate_number !== null);
    assert.ok(rider, 'a rider carries a plate');
    // A manager has no profile, and the LEFT JOIN must not drop them.
    assert.ok(members.some((m) => m.role === 'manager' && m.plate_number === null));
  });
});
