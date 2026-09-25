// server/test/api/authorization.test.ts — milestone 11.
//
// §5.4's FOUR ESCALATION TESTS, "because each of these is a silent takeover if it
// passes", plus the cases around them that the same guard has to get right.
//
//   1. A store admin cannot create a super_admin or any platform role.
//   2. A store admin cannot add a member to a store they do not belong to.
//   3. A manager cannot reach payout, wallet or store-settings endpoints — verified
//      against the endpoint, not against whether the nav item is hidden.
//   4. Revoking a membership denies the next request, not the next login.
//
// Every one of them goes over a real socket to the real app. Run with:
//   npm run api:test        (from the repository root — it supplies the connection string)

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import {
  EMAIL_DOMAIN,
  STORE,
  USER,
  cleanup,
  countPlatformMembers,
  seedFixtures,
  userExistsWithEmail,
} from './support.ts';

let api: Api;

const token = {
  ownerA: '',
  adminA: '',
  managerA: '',
  adminB: '',
  superAdmin: '',
  customerA: '',
  multiStore: '',
};

before(async () => {
  // The limiters key on req.ip and this suite drives dozens of requests from one
  // address, which is exactly what they exist to stop. Opting out by the variable
  // rateLimit.js already reads, rather than by sniffing NODE_ENV.
  process.env.RATE_LIMIT_DISABLED = 'true';

  await seedFixtures();
  api = await boot();

  token.ownerA = tokenFor(USER.ownerA);
  token.adminA = tokenFor(USER.adminA);
  token.managerA = tokenFor(USER.managerA);
  token.adminB = tokenFor(USER.adminB);
  token.superAdmin = tokenFor(USER.superAdmin);
  token.customerA = tokenFor(USER.customerA);
  token.multiStore = tokenFor(USER.multiStore);
});

after(async () => {
  await api.close();
  await cleanup();
  await closePool();
});

// ===========================================================================
// Escalation test 1 — a store admin cannot grant a platform role
// ===========================================================================
describe('escalation 1: a store admin cannot create a platform role', () => {
  it('refuses role=super_admin and creates nothing', async () => {
    const before = await countPlatformMembers();

    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: token.adminA,
      body: {
        name: 'Escalated Person',
        email: `escalated@${EMAIL_DOMAIN}`,
        password: 'a-long-enough-password',
        role: 'super_admin',
      },
    });

    assert.equal(reply.status, 400, 'super_admin is not a role this endpoint can grant');
    assert.equal(reply.body['code'], 'INVALID_VALUE');

    // The refusal has to be a refusal, not a 400 after the write.
    assert.equal(await countPlatformMembers(), before, 'no platform member was created');
    assert.equal(
      await userExistsWithEmail(`escalated@${EMAIL_DOMAIN}`),
      false,
      'no identity was created either',
    );
  });

  it('refuses role=owner — granting ownership is a transfer, not a create', async () => {
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: token.adminA,
      body: {
        name: 'Second Owner',
        email: `second-owner@${EMAIL_DOMAIN}`,
        password: 'a-long-enough-password',
        role: 'owner',
      },
    });

    assert.equal(reply.status, 400);
    assert.equal(await userExistsWithEmail(`second-owner@${EMAIL_DOMAIN}`), false);
  });

  it('there is no endpoint that writes platform_members at all', async () => {
    // The structural half of the guarantee: V001 put platform roles in a different
    // table so that granting one is a different write. Nothing in this app performs it.
    const reply = await call(api, 'POST', '/api/platform-members', {
      token: token.superAdmin,
      body: { role: 'super_admin' },
    });
    assert.equal(reply.status, 404);
    assert.equal(reply.body['code'], 'NO_SUCH_ROUTE');
  });
});

// ===========================================================================
// Escalation test 2 — a store admin cannot reach a store they do not belong to
// ===========================================================================
describe('escalation 2: a store admin cannot add a member to another store', () => {
  it('refuses a create in a store the caller has no membership in', async () => {
    const email = `planted@${EMAIL_DOMAIN}`;

    const reply = await call(api, 'POST', `/api/stores/${STORE.b}/members`, {
      token: token.adminA, // admin at A, nothing at B
      body: { name: 'Planted', email, password: 'a-long-enough-password', role: 'manager' },
    });

    assert.equal(reply.status, 403);
    assert.equal(reply.body['code'], 'FORBIDDEN');
    assert.equal(await userExistsWithEmail(email), false, 'nothing was written');
  });

  it('refuses reading another store’s staff list', async () => {
    const reply = await call(api, 'GET', `/api/stores/${STORE.b}/members`, { token: token.adminA });
    assert.equal(reply.status, 403);
  });

  it('refuses revoking a member of another store', async () => {
    const reply = await call(api, 'DELETE', `/api/stores/${STORE.b}/members/${USER.adminB}`, {
      token: token.adminA,
    });
    assert.equal(reply.status, 403);

    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM store_members WHERE store_id = $1 AND user_id = $2`,
      [STORE.b, USER.adminB],
    );
    assert.equal(rows[0]?.n, '1', 'the membership is untouched');
  });

  it('answers a store that does not exist exactly as it answers one you are not in', async () => {
    // Otherwise the pair of responses is a way to enumerate which store ids are real.
    const absent = await call(api, 'GET', `/api/stores/eeeeeeee-0000-4000-8000-0000000009ff/members`, {
      token: token.adminA,
    });
    const notMine = await call(api, 'GET', `/api/stores/${STORE.b}/members`, { token: token.adminA });

    assert.equal(absent.status, notMine.status);
    assert.deepEqual(absent.body, notMine.body);
  });

  it('the store is taken from the path — a header cannot redirect the check', async () => {
    // The old guard resolved the store from X-Tenant-Slug. Sending it now changes
    // nothing, because nothing reads it.
    const res = await fetch(`${api.baseUrl}/api/stores/${STORE.b}/members`, {
      headers: { Authorization: `Bearer ${token.adminA}`, 'X-Tenant-Slug': 'escalation-store-a' },
    });
    assert.equal(res.status, 403);
    await res.text();
  });
});

// ===========================================================================
// Escalation test 3 — a manager cannot reach money or settings
// ===========================================================================
describe('escalation 3: a manager cannot reach payout, wallet or settings endpoints', () => {
  it('refuses the wallet', async () => {
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: token.managerA });
    assert.equal(reply.status, 403);
  });

  it('refuses payouts', async () => {
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/payouts`, { token: token.managerA });
    assert.equal(reply.status, 403);
  });

  it('refuses store settings', async () => {
    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/settings`, { token: token.managerA });
    assert.equal(reply.status, 403);
  });

  it('refuses creating staff', async () => {
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: token.managerA,
      body: {
        name: 'Manager Made This',
        email: `manager-made@${EMAIL_DOMAIN}`,
        password: 'a-long-enough-password',
        role: 'rider',
        plateNumber: 'RAZ 999 Z',
      },
    });
    assert.equal(reply.status, 403);
    assert.equal(await userExistsWithEmail(`manager-made@${EMAIL_DOMAIN}`), false);
  });

  it('but the owner reaches all three', async () => {
    // The mirror image matters as much: a guard that refuses everybody passes the four
    // tests above and ships a console nobody can use.
    const wallet = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: token.ownerA });
    assert.equal(wallet.status, 200);
    assert.equal(wallet.body['currency'], 'RWF');
    // Amounts are strings, unrounded — packages/core formats them at milestone 13.
    assert.equal(typeof wallet.body['available'], 'string');

    const payouts = await call(api, 'GET', `/api/stores/${STORE.a}/payouts`, { token: token.ownerA });
    assert.equal(payouts.status, 200);
    assert.ok(Array.isArray(payouts.body['payouts']));

    const settings = await call(api, 'GET', `/api/stores/${STORE.a}/settings`, { token: token.ownerA });
    assert.equal(settings.status, 200);
    const payout = settings.body['payout'] as Record<string, unknown>;
    assert.equal(payout['methodKey'], 'mtn_momo');
    const pickup = settings.body['pickup'] as Record<string, unknown>;
    assert.equal(pickup['readyMinutes'], 15);
    assert.equal((settings.body['paymentMethods'] as unknown[]).length, 2);
  });

  it('a manager still reaches what a manager is for', async () => {
    // Nothing above should have cost them their own store's identity, which every
    // screen needs to render at all.
    const reply = await call(api, 'GET', '/api/session', { token: token.managerA });
    assert.equal(reply.status, 200);
    const mine = reply.body['memberships'] as { storeId: string; role: string }[];
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.storeId, STORE.a);
    assert.equal(mine[0]?.role, 'manager');
  });

  it('the refusal comes from role_permissions, not from a list in the code', async () => {
    // Grant the manager role wallet.read for the length of this test and the same
    // request succeeds — which proves the guard reads rows. §5.4: "A component asks
    // whether a role may do something; it never contains the list."
    await sql(`INSERT INTO role_permissions (scope, role, permission) VALUES ('store', 'manager', 'wallet.read')`);
    try {
      const allowed = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: token.managerA });
      assert.equal(allowed.status, 200, 'the same manager, the same token, one new row');
    } finally {
      await sql(
        `DELETE FROM role_permissions WHERE scope = 'store' AND role = 'manager' AND permission = 'wallet.read'`,
      );
    }

    const refusedAgain = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: token.managerA });
    assert.equal(refusedAgain.status, 403, 'and it is refused again the moment the row is gone');
  });
});

// ===========================================================================
// Escalation test 4 — revocation takes effect on the next request
// ===========================================================================
describe('escalation 4: revoking a membership denies the next request', () => {
  it('a created admin works, then does not, on the same token', async () => {
    const email = `revoked-admin@${EMAIL_DOMAIN}`;

    const created = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      token: token.ownerA,
      body: { name: 'Revoked Admin', email, password: 'a-long-enough-password', role: 'admin' },
    });
    assert.equal(created.status, 201);
    const member = created.body['member'] as Record<string, unknown>;
    const newUserId = member['userId'] as string;

    // One token, signed once, used for both halves of the test.
    const theirToken = tokenFor(newUserId);

    const before = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: theirToken });
    assert.equal(before.status, 200, 'the new admin can read the wallet');

    const removed = await call(api, 'DELETE', `/api/stores/${STORE.a}/members/${newUserId}`, {
      token: token.ownerA,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body['removed'], true);
    assert.equal(removed.body['role'], 'admin');

    // THE POINT. No new sign-in, no expiry, no cache to wait out.
    const after = await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: theirToken });
    assert.equal(after.status, 403, 'the very next request is denied');

    // Their identity survives — revoking a membership is not deleting a person.
    const session = await call(api, 'GET', '/api/session', { token: theirToken });
    assert.equal(session.status, 200);
    assert.equal((session.body['memberships'] as unknown[]).length, 0);
  });

  it('a repeated revoke is not an error', async () => {
    const reply = await call(api, 'DELETE', `/api/stores/${STORE.a}/members/${USER.riderA}`, {
      token: token.ownerA,
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.body['removed'], true);

    const again = await call(api, 'DELETE', `/api/stores/${STORE.a}/members/${USER.riderA}`, {
      token: token.ownerA,
    });
    assert.equal(again.status, 200);
    assert.equal(again.body['removed'], false, 'idempotent: the second call reports nothing to do');
  });

  it('the rider’s profile went with the membership', async () => {
    // rider_profiles CASCADEs from store_members, which is right: a profile says
    // somebody is a rider of this store, and they are not any more.
    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM rider_profiles WHERE user_id = $1 AND store_id = $2`,
      [USER.riderA, STORE.a],
    );
    assert.equal(rows[0]?.n, '0');
  });

  it('an owner cannot be revoked here, and you cannot revoke yourself', async () => {
    const owner = await call(api, 'DELETE', `/api/stores/${STORE.a}/members/${USER.ownerA}`, {
      token: token.adminA,
    });
    assert.equal(owner.status, 409);
    assert.equal(owner.body['code'], 'OWNER_NOT_REMOVABLE');

    const self = await call(api, 'DELETE', `/api/stores/${STORE.a}/members/${USER.adminA}`, {
      token: token.adminA,
    });
    assert.equal(self.status, 409);
    assert.equal(self.body['code'], 'CANNOT_REMOVE_SELF');
  });
});
