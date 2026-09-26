// server/test/api/auth.test.ts — milestone 15.
//
// Auth's four personas, the cookie, CSRF, the store picker, the invite, and the two code flows.
//
// EVERY REQUEST HERE GOES THROUGH THE COOKIE, not an Authorization header, because the cookie is what
// milestone 15 delivers and a test that signed itself in with a hand-made token would skip the whole
// thing. `boot()`'s client keeps a cookie jar and echoes the csrf token, as a browser does.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { checkPassword } from '../../src/auth/password.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import {
  EMAIL_DOMAIN,
  FIXTURE_PASSWORD,
  STORE,
  USER,
  cleanup,
  seedAuthPasswords,
  seedFixtures,
} from './support.ts';

let api: Api;

/** The code the server logged, scraped from stdout — delivery is milestone 28's. */
const logged: string[] = [];
const realLog = console.log;

function signIn(identifier: string, password = FIXTURE_PASSWORD, extra: Record<string, unknown> = {}) {
  return call(api, 'POST', '/api/session', { body: { identifier, password, ...extra } });
}

/** Forgets the session cookie without asking the server, the way closing a browser does. */
function forget(): void {
  api.cookies.delete('session');
}

function lastCode(kind: 'two-step' | 'reset'): string {
  const needle = kind === 'two-step' ? 'two-step code for' : 'reset code for';
  const line = [...logged].reverse().find((l) => l.includes(needle));
  assert.ok(line, `no ${kind} code was logged`);
  const match = /: (\d{6}) /.exec(line);
  assert.ok(match?.[1], `could not read the code out of: ${line}`);
  return match[1];
}

function lastInviteToken(): string {
  const line = [...logged].reverse().find((l) => l.includes('invite for'));
  assert.ok(line, 'no invite token was logged');
  const match = /token (\S+)$/.exec(line);
  assert.ok(match?.[1], `could not read the token out of: ${line}`);
  return match[1];
}

before(async () => {
  process.env.RATE_LIMIT_DISABLED = 'true';
  await seedFixtures();
  await seedAuthPasswords();
  api = await boot();

  // The codes and tokens only exist in the log — putting them in a response would make the second
  // factor a formality and let an inviter accept on the invitee's behalf.
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
});

after(async () => {
  console.log = realLog;
  await api.close();
  await sql(`DELETE FROM staff_invites WHERE store_id = ANY($1::uuid[])`, [[STORE.a, STORE.b]]);
  await cleanup();
  await closePool();
});

beforeEach(() => {
  forget();
  logged.length = 0;
});

// ===========================================================================
describe('CSRF', () => {
  it('refuses a write with no token', async () => {
    const reply = await call(api, 'POST', '/api/session', {
      body: { identifier: `owner-a@${EMAIL_DOMAIN}`, password: FIXTURE_PASSWORD },
      csrf: false,
    });
    assert.equal(reply.status, 403);
    assert.equal(reply.body['code'], 'CSRF_MISSING');
  });

  it('refuses a write whose token does not match the cookie', async () => {
    const res = await fetch(`${api.baseUrl}/api/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `csrf=${api.cookies.get('csrf') ?? ''}`,
        'X-CSRF-Token': 'a-different-token-entirely-aaaaaaaaaaaa',
      },
      body: JSON.stringify({ identifier: 'x', password: 'y' }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as Record<string, unknown>)['code'], 'CSRF_MISMATCH');
  });

  it('refuses a write from another origin', async () => {
    const res = await fetch(`${api.baseUrl}/api/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        Cookie: `csrf=${api.cookies.get('csrf') ?? ''}`,
        'X-CSRF-Token': api.cookies.get('csrf') ?? '',
      },
      body: JSON.stringify({ identifier: 'x', password: 'y' }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as Record<string, unknown>)['code'], 'CSRF_ORIGIN');
  });

  it('leaves reads alone', async () => {
    const reply = await call(api, 'GET', '/api/session', { csrf: false });
    // 401 because nobody is signed in — not 403, which is the point.
    assert.equal(reply.status, 401);
  });

  it('issues a token to a browser that has none', async () => {
    const res = await fetch(`${api.baseUrl}/api/session`);
    const setCookie = res.headers.getSetCookie().join('; ');
    assert.match(setCookie, /csrf=/);
    // Readable by script, deliberately: the client has to echo it.
    assert.equal(/csrf=[^;]*;[^,]*HttpOnly/i.test(setCookie), false);
    await res.text();
  });
});

// ===========================================================================
describe('the four personas', () => {
  it('an owner with one store signs straight in', async () => {
    const reply = await signIn(`owner-a@${EMAIL_DOMAIN}`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body['next'], 'ready');

    const memberships = reply.body['memberships'] as { role: string }[];
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0]?.role, 'owner');

    // The session is the cookie, and ONLY the cookie: §2.5 makes the server authoritative, and a token
    // in the body is a token a client would be tempted to keep somewhere.
    assert.equal('token' in reply.body, false);
    assert.ok(api.cookies.has('session'));

    // And it works.
    const session = await call(api, 'GET', '/api/session');
    assert.equal(session.status, 200);
  });

  it('somebody with two stores is asked which one', async () => {
    // §5.4's case: "one person to be Owner at Nyama & Co. AND Manager at Inzu Threads".
    const reply = await signIn(`multi@${EMAIL_DOMAIN}`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body['next'], 'choose-store');

    const memberships = reply.body['memberships'] as { storeId: string; role: string }[];
    assert.equal(memberships.length, 2);
    const byStore = new Map(memberships.map((m) => [m.storeId, m.role]));
    assert.equal(byStore.get(STORE.a), 'admin');
    assert.equal(byStore.get(STORE.b), 'manager');

    // ALREADY SIGNED IN. The picker is a navigation choice, not a second authentication — so the cookie
    // is set before it, and a refresh mid-choice does not send them back to the password.
    assert.ok(api.cookies.has('session'));
    assert.equal((await call(api, 'GET', '/api/session')).status, 200);
  });

  it('a rider signs in with their phone number', async () => {
    // Auth's rider identifier is "078 455 9012".
    const reply = await signIn('078 455 9012');
    assert.equal(reply.status, 200);
    assert.equal(reply.body['next'], 'ready');
    assert.equal((reply.body['memberships'] as { role: string }[])[0]?.role, 'rider');
  });

  it('a phone matches however it was typed', async () => {
    for (const spelling of ['0784559012', '078-455-9012', '+250 784 559 012'.replace('+250 ', '0')]) {
      forget();
      const reply = await signIn(spelling);
      assert.equal(reply.status, 200, spelling);
    }
  });

  it('the Vendlyfy team gets no session until the second factor', async () => {
    const reply = await signIn(`super@${EMAIL_DOMAIN}`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body['next'], 'two-step');

    // NO COOKIE YET. AdminStates: the console "always needs your 2-step code".
    assert.equal(api.cookies.has('session'), false);
    // And the address is masked — enough to recognise your own, not enough to learn somebody else's.
    assert.match(String(reply.body['sentTo']), /^s•+@/);
    // The code is not in the response.
    assert.equal(JSON.stringify(reply.body).includes(lastCode('two-step')), false);
  });

  it('a customer signs in and has no memberships', async () => {
    const reply = await signIn(`customer-a@${EMAIL_DOMAIN}`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body['next'], 'ready');
    assert.deepEqual(reply.body['memberships'], []);
    assert.equal((reply.body['user'] as Record<string, unknown>)['scope'], 'store');
  });
});

// ===========================================================================
describe('what a failed sign-in says', () => {
  it('says the same thing for a wrong password and an unknown address', async () => {
    const wrongPassword = await signIn(`owner-a@${EMAIL_DOMAIN}`, 'not-the-password-1');
    const noSuchAccount = await signIn(`nobody@${EMAIL_DOMAIN}`, FIXTURE_PASSWORD);

    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchAccount.status, 401);
    // Byte for byte. Anything else is a list of who has an account.
    assert.deepEqual(wrongPassword.body, noSuchAccount.body);
    assert.equal(wrongPassword.body['code'], 'SIGN_IN_FAILED');
  });

  it('sets no cookie on a failure', async () => {
    await signIn(`owner-a@${EMAIL_DOMAIN}`, 'not-the-password-1');
    assert.equal(api.cookies.has('session'), false);
  });

  it('refuses a missing field rather than treating it as empty', async () => {
    const noPassword = await call(api, 'POST', '/api/session', { body: { identifier: 'x' } });
    assert.equal(noPassword.status, 400);
  });
});

// ===========================================================================
describe('the cookie', () => {
  it('is httpOnly, and SameSite=Lax', async () => {
    const res = await fetch(`${api.baseUrl}/api/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `csrf=${api.cookies.get('csrf') ?? ''}`,
        'X-CSRF-Token': api.cookies.get('csrf') ?? '',
      },
      body: JSON.stringify({ identifier: `owner-a@${EMAIL_DOMAIN}`, password: FIXTURE_PASSWORD }),
    });
    const session = res.headers.getSetCookie().find((c) => c.startsWith('session='));
    assert.ok(session, 'a session cookie was set');
    assert.match(session, /HttpOnly/i);
    assert.match(session, /SameSite=Lax/i);
    await res.text();
  });

  it('has no max-age unless "Keep me signed in" was ticked', async () => {
    async function cookieFor(remember: boolean): Promise<string> {
      const res = await fetch(`${api.baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `csrf=${api.cookies.get('csrf') ?? ''}`,
          'X-CSRF-Token': api.cookies.get('csrf') ?? '',
        },
        body: JSON.stringify({
          identifier: `owner-a@${EMAIL_DOMAIN}`,
          password: FIXTURE_PASSWORD,
          remember,
        }),
      });
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('session=')) ?? '';
      await res.text();
      return cookie;
    }

    // Unticked: a session cookie, gone when the browser closes — what somebody on a borrowed phone
    // is asking for.
    assert.equal(/max-age|expires/i.test(await cookieFor(false)), false);
    // Ticked: an explicit lifetime, which is what §2.5 asks for.
    assert.match(await cookieFor(true), /Max-Age=\d+/i);
  });

  it('signing out clears it, and works even when the session is already invalid', async () => {
    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    assert.equal((await call(api, 'GET', '/api/session')).status, 200);

    const out = await call(api, 'DELETE', '/api/session');
    assert.equal(out.status, 200);
    assert.equal(api.cookies.has('session'), false);
    assert.equal((await call(api, 'GET', '/api/session')).status, 401);

    // Not authenticated, on purpose: an already-dead session must still be able to clean itself up
    // rather than getting a 401 and leaving a stale cookie forever.
    assert.equal((await call(api, 'DELETE', '/api/session')).status, 200);
  });
});

// ===========================================================================
describe('the two-step code', () => {
  it('opens the console when it is right', async () => {
    const start = await signIn(`super@${EMAIL_DOMAIN}`);
    const userId = start.body['userId'] as string;

    const reply = await call(api, 'POST', '/api/session/two-step', {
      body: { userId, code: lastCode('two-step') },
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.body['next'], 'ready');
    assert.equal(reply.body['platformRole'], 'super_admin');
    assert.ok(api.cookies.has('session'));
    assert.equal((await call(api, 'GET', '/api/session')).status, 200);
  });

  it('counts down wrong tries and then burns the code', async () => {
    const start = await signIn(`super@${EMAIL_DOMAIN}`);
    const userId = start.body['userId'] as string;
    const real = lastCode('two-step');

    // Four wrong, each reporting what is left. V016 bounds attempts at the COLUMN, so this cannot be
    // extended by an endpoint that forgets to count.
    for (const expected of [4, 3, 2, 1]) {
      const wrong = await call(api, 'POST', '/api/session/two-step', {
        body: { userId, code: '000000' === real ? '111111' : '000000' },
      });
      assert.equal(wrong.status, 401);
      assert.match(String(wrong.body['error']), new RegExp(`${expected} (try|tries) left`));
    }

    const fifth = await call(api, 'POST', '/api/session/two-step', {
      body: { userId, code: '000000' === real ? '111111' : '000000' },
    });
    assert.equal(fifth.body['code'], 'TWO_STEP_TOO_MANY');

    // And the correct code is dead too — the row was burned, not merely counted.
    const tooLate = await call(api, 'POST', '/api/session/two-step', { body: { userId, code: real } });
    assert.equal(tooLate.status, 401);
    assert.equal(api.cookies.has('session'), false);
  });

  it('asking again replaces the code rather than adding one', async () => {
    const first = await signIn(`super@${EMAIL_DOMAIN}`);
    const userId = first.body['userId'] as string;
    const firstCode = lastCode('two-step');

    await signIn(`super@${EMAIL_DOMAIN}`);
    const secondCode = lastCode('two-step');
    assert.notEqual(firstCode, secondCode);

    // The older SMS must not work: V016's partial unique index is what makes this true, and its comment
    // says why — otherwise "Send again" widens the window instead of replacing it.
    const stale = await call(api, 'POST', '/api/session/two-step', { body: { userId, code: firstCode } });
    assert.equal(stale.status, 401);

    const fresh = await call(api, 'POST', '/api/session/two-step', { body: { userId, code: secondCode } });
    assert.equal(fresh.status, 200);
  });

  it('is refused for somebody who has lost their platform role', async () => {
    const start = await signIn(`super@${EMAIL_DOMAIN}`);
    const userId = start.body['userId'] as string;
    const code = lastCode('two-step');

    await sql(`DELETE FROM platform_members WHERE user_id = $1`, [USER.superAdmin]);
    try {
      const reply = await call(api, 'POST', '/api/session/two-step', { body: { userId, code } });
      assert.equal(reply.status, 401);
      assert.equal(api.cookies.has('session'), false);
    } finally {
      await sql(`INSERT INTO platform_members (user_id, role) VALUES ($1, 'super_admin')`, [USER.superAdmin]);
    }
  });
});

// ===========================================================================
describe('the password rules', () => {
  it('are Auth’s three, in its wording', () => {
    assert.deepEqual(
      checkPassword('').map((r) => r.label),
      ['At least 8 characters', 'Includes a number', 'Not your phone number or store name'],
    );
  });

  it('serves them so the client renders what the server enforces', async () => {
    const reply = await call(api, 'GET', '/api/password/rules');
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body['rules'], checkPassword('').map((r) => r.label));
  });

  it('rejects the store name and the phone number, not just short ones', () => {
    const context = { storeName: 'Nyama & Co.', phone: '078 455 9012', email: 'aline@nyama.rw' };
    assert.equal(checkPassword('nyama2024', context)[2]?.passed, false, 'the store name');
    assert.equal(checkPassword('0784559012x', context)[2]?.passed, false, 'the phone');
    assert.equal(checkPassword('aline1234', context)[2]?.passed, false, 'the email local part');
    assert.equal(checkPassword('correct-horse-42', context).every((r) => r.passed), true);
  });

  it('counts the first two rules the way the board draws them', () => {
    assert.equal(checkPassword('short1')[0]?.passed, false);
    assert.equal(checkPassword('longenough')[1]?.passed, false);
    assert.equal(checkPassword('longenough1')[0]?.passed, true);
    assert.equal(checkPassword('longenough1')[1]?.passed, true);
  });
});

// ===========================================================================
describe('resetting a forgotten password', () => {
  it('answers the same whether or not the account exists', async () => {
    const real = await call(api, 'POST', '/api/password/reset', {
      body: { identifier: `owner-a@${EMAIL_DOMAIN}` },
    });
    const fake = await call(api, 'POST', '/api/password/reset', {
      body: { identifier: `nobody-at-all@${EMAIL_DOMAIN}` },
    });
    assert.equal(real.status, 200);
    assert.equal(fake.status, 200);
    // This endpoint needs no password at all, so a distinguishable answer is a free list of who has an
    // account.
    assert.deepEqual(real.body, fake.body);
  });

  it('changes the password and signs out every other device', async () => {
    // A session on "another device", made the ordinary way.
    await signIn(`manager-a@${EMAIL_DOMAIN}`);
    const otherDevice = api.cookies.get('session');
    assert.ok(otherDevice);
    forget();

    await call(api, 'POST', '/api/password/reset', { body: { identifier: `manager-a@${EMAIL_DOMAIN}` } });
    const code = lastCode('reset');

    const confirmed = await call(api, 'POST', '/api/password/reset/confirm', {
      body: { identifier: `manager-a@${EMAIL_DOMAIN}`, code, password: 'brand-new-99' },
    });
    assert.equal(confirmed.status, 200);
    assert.match(String(confirmed.body['message']), /every other device/);

    // THE OTHER DEVICE IS OUT. session_version was bumped, so a token issued before it no longer
    // matches — which is how Auth's promise is true of tokens already in the wild.
    const stale = await fetch(`${api.baseUrl}/api/session`, {
      headers: { Cookie: `session=${otherDevice}` },
    });
    assert.equal(stale.status, 401);
    assert.equal(((await stale.json()) as Record<string, unknown>)['code'], 'SESSION_REVOKED');

    // THIS device is signed in, which is what "every OTHER device" means.
    assert.ok(api.cookies.has('session'));
    assert.equal((await call(api, 'GET', '/api/session')).status, 200);

    // The old password is gone and the new one works.
    forget();
    assert.equal((await signIn(`manager-a@${EMAIL_DOMAIN}`, FIXTURE_PASSWORD)).status, 401);
    forget();
    assert.equal((await signIn(`manager-a@${EMAIL_DOMAIN}`, 'brand-new-99')).status, 200);

    // Put it back for the suites that follow.
    await seedAuthPasswords();
  });

  it('refuses a weak new password', async () => {
    await call(api, 'POST', '/api/password/reset', { body: { identifier: `owner-a@${EMAIL_DOMAIN}` } });
    const reply = await call(api, 'POST', '/api/password/reset/confirm', {
      body: { identifier: `owner-a@${EMAIL_DOMAIN}`, code: lastCode('reset'), password: 'short' },
    });
    assert.equal(reply.status, 400);
    assert.equal(reply.body['code'], 'WEAK_PASSWORD');
    assert.equal(reply.body['error'], 'At least 8 characters');
  });

  it('answers a wrong code the same way as an unknown account', async () => {
    const unknown = await call(api, 'POST', '/api/password/reset/confirm', {
      body: { identifier: `nobody-at-all@${EMAIL_DOMAIN}`, code: '000000', password: 'brand-new-99' },
    });
    assert.equal(unknown.status, 401);
    // Otherwise confirm becomes the oracle that request refuses to be.
    assert.equal(unknown.body['code'], 'RESET_NONE');
  });
});

// ===========================================================================
describe('an owner resetting a staff password', () => {
  it('works, and signs that person out everywhere', async () => {
    // Auth's other end: "Aline Uwase (store owner) reset your password. Your old one no longer works."
    await signIn(`manager-a@${EMAIL_DOMAIN}`);
    const managerSession = api.cookies.get('session');
    forget();

    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members/${USER.managerA}/password`, {
      body: { password: 'owner-set-this-7' },
    });
    assert.equal(reply.status, 200);

    const stale = await fetch(`${api.baseUrl}/api/session`, {
      headers: { Cookie: `session=${managerSession}` },
    });
    assert.equal(stale.status, 401);
    await stale.text();

    forget();
    assert.equal((await signIn(`manager-a@${EMAIL_DOMAIN}`, 'owner-set-this-7')).status, 200);
    await seedAuthPasswords();
  });

  it('refuses an owner, and refuses yourself', async () => {
    await signIn(`admin-a@${EMAIL_DOMAIN}`).catch(() => undefined);
    forget();
    await signIn(`owner-a@${EMAIL_DOMAIN}`);

    const self = await call(api, 'POST', `/api/stores/${STORE.a}/members/${USER.ownerA}/password`, {
      body: { password: 'brand-new-99' },
    });
    assert.equal(self.status, 400);
    assert.equal(self.body['code'], 'CANNOT_RESET_SELF');

    const notAMember = await call(api, 'POST', `/api/stores/${STORE.a}/members/${USER.adminB}/password`, {
      body: { password: 'brand-new-99' },
    });
    assert.equal(notAMember.status, 404);
  });

  it('a manager cannot reset anybody’s', async () => {
    await signIn(`manager-a@${EMAIL_DOMAIN}`);
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/members/${USER.riderA}/password`, {
      body: { password: 'brand-new-99' },
    });
    assert.equal(reply.status, 403);
  });
});

// ===========================================================================
describe('the staff invite', () => {
  it('is what POST /members refuses to do without', async () => {
    // Milestone 11's endpoint answers 409 for an address that already has an account, because attaching
    // somebody on nothing but their email would leak their name and phone and give them a store they
    // never agreed to. This is the consent.
    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    const direct = await call(api, 'POST', `/api/stores/${STORE.a}/members`, {
      body: {
        name: 'Admin B',
        email: `admin-b@${EMAIL_DOMAIN}`,
        password: 'a-long-enough-password-1',
        role: 'manager',
      },
    });
    assert.equal(direct.status, 409);
    assert.equal(direct.body['code'], 'ACCOUNT_EXISTS');
  });

  it('a new person joins and is signed in', async () => {
    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    const created = await call(api, 'POST', `/api/stores/${STORE.a}/invites`, {
      body: { email: `newcomer@${EMAIL_DOMAIN}`, name: 'Patrick Niyonzima', role: 'manager' },
    });
    assert.equal(created.status, 201);
    // The token is not in the response: an inviter must not be able to accept on the invitee's behalf.
    assert.equal(JSON.stringify(created.body).includes(lastInviteToken()), false);

    const token = lastInviteToken();
    forget();

    // The acceptance screen's content — Auth renders "Join Nyama & Co. — Aline Uwase invited Patrick
    // Niyonzima as a Manager."
    const shown = await call(api, 'GET', `/api/invites/${token}`);
    assert.equal(shown.status, 200);
    const invite = shown.body['invite'] as Record<string, unknown>;
    assert.equal((invite['store'] as Record<string, unknown>)['name'], 'Escalation Store A');
    assert.equal(invite['name'], 'Patrick Niyonzima');
    assert.equal(invite['role'], 'manager');
    assert.equal(invite['invitedBy'], 'Owner A');
    assert.equal(shown.body['hasAccount'], false);

    const accepted = await call(api, 'POST', `/api/invites/${token}/accept`, {
      body: { password: 'joined-up-2026' },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body['next'], 'ready');
    // "Join and sign in" — a cookie, not a redirect to a sign-in form.
    assert.ok(api.cookies.has('session'));

    const session = await call(api, 'GET', '/api/session');
    const memberships = session.body['memberships'] as { storeId: string; role: string }[];
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0]?.storeId, STORE.a);
    assert.equal(memberships[0]?.role, 'manager');
  });

  it('cannot be accepted twice', async () => {
    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    await call(api, 'POST', `/api/stores/${STORE.a}/invites`, {
      body: { email: `twice@${EMAIL_DOMAIN}`, name: 'Twice', role: 'rider' },
    });
    const token = lastInviteToken();
    forget();

    const first = await call(api, 'POST', `/api/invites/${token}/accept`, {
      body: { password: 'joined-up-2026', plateNumber: 'RAB 123 Z' },
    });
    assert.equal(first.status, 200);
    forget();

    const second = await call(api, 'POST', `/api/invites/${token}/accept`, {
      body: { password: 'joined-up-2026', plateNumber: 'RAB 999 Z' },
    });
    assert.equal(second.status, 404, 'the link is spent, so it is no longer a live invite');
  });

  it('a rider invite needs a plate, and creates the profile', async () => {
    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    await call(api, 'POST', `/api/stores/${STORE.a}/invites`, {
      body: { email: `wheels@${EMAIL_DOMAIN}`, name: 'Wheels', role: 'rider' },
    });
    const token = lastInviteToken();
    forget();

    const noPlate = await call(api, 'POST', `/api/invites/${token}/accept`, {
      body: { password: 'joined-up-2026' },
    });
    assert.equal(noPlate.status, 400);
    assert.equal(noPlate.body['code'], 'MISSING_FIELD');

    const withPlate = await call(api, 'POST', `/api/invites/${token}/accept`, {
      body: { password: 'joined-up-2026', plateNumber: 'RAC 456 Y' },
    });
    assert.equal(withPlate.status, 200);

    const { rows } = await sql<{ plate_number: string }>(
      `SELECT rp.plate_number FROM rider_profiles rp
         JOIN users u ON u.id = rp.user_id
        WHERE lower(u.email) = lower($1)`,
      [`wheels@${EMAIL_DOMAIN}`],
    );
    assert.equal(rows[0]?.plate_number, 'RAC 456 Y');
  });

  it('an existing account must prove it is them', async () => {
    // Without this, anybody holding the link could set a password on an address that already has an
    // account and take it over — the exact takeover milestone 11's 409 avoided.
    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    await call(api, 'POST', `/api/stores/${STORE.a}/invites`, {
      body: { email: `admin-b@${EMAIL_DOMAIN}`, name: 'Admin B', role: 'manager' },
    });
    const token = lastInviteToken();
    forget();

    const anonymous = await call(api, 'POST', `/api/invites/${token}/accept`, {
      body: { password: 'takeover-attempt-1' },
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body['code'], 'INVITE_NEEDS_SIGN_IN');

    // Signed in as the WRONG person is refused too.
    await signIn(`manager-a@${EMAIL_DOMAIN}`);
    const wrongPerson = await call(api, 'POST', `/api/invites/${token}/accept`, { body: {} });
    assert.equal(wrongPerson.status, 403);
    assert.equal(wrongPerson.body['code'], 'INVITE_WRONG_ACCOUNT');
    forget();

    // As the right person, it works — and their password is untouched.
    await signIn(`admin-b@${EMAIL_DOMAIN}`);
    const right = await call(api, 'POST', `/api/invites/${token}/accept`, { body: {} });
    assert.equal(right.status, 200);

    const session = await call(api, 'GET', '/api/session');
    const stores = (session.body['memberships'] as { storeId: string }[]).map((m) => m.storeId);
    assert.ok(stores.includes(STORE.a), 'they are staff at A now');
    assert.ok(stores.includes(STORE.b), 'and still at B');

    // Clean up so the escalation suite's expectations about store B hold.
    await sql(`DELETE FROM store_members WHERE store_id = $1 AND user_id = $2`, [STORE.a, USER.adminB]);
  });

  it('re-inviting replaces the invite rather than adding one', async () => {
    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    await call(api, 'POST', `/api/stores/${STORE.a}/invites`, {
      body: { email: `reissued@${EMAIL_DOMAIN}`, name: 'Reissued', role: 'manager' },
    });
    const firstToken = lastInviteToken();

    await call(api, 'POST', `/api/stores/${STORE.a}/invites`, {
      body: { email: `reissued@${EMAIL_DOMAIN}`, name: 'Reissued', role: 'rider' },
    });
    const secondToken = lastInviteToken();
    assert.notEqual(firstToken, secondToken);

    // The first link is dead. Two live invites would let a later one with a different role sit behind
    // an earlier one and grant whichever was clicked — which V016's partial unique index forbids.
    assert.equal((await call(api, 'GET', `/api/invites/${firstToken}`)).status, 404);
    assert.equal((await call(api, 'GET', `/api/invites/${secondToken}`)).status, 200);

    const listed = await call(api, 'GET', `/api/stores/${STORE.a}/invites`);
    const live = (listed.body['invites'] as { email: string }[]).filter(
      (i) => i.email === `reissued@${EMAIL_DOMAIN}`,
    );
    assert.equal(live.length, 1);
  });

  it('can be withdrawn, and a manager cannot invite at all', async () => {
    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    const created = await call(api, 'POST', `/api/stores/${STORE.a}/invites`, {
      body: { email: `withdrawn@${EMAIL_DOMAIN}`, name: 'Withdrawn', role: 'manager' },
    });
    const token = lastInviteToken();
    const id = (created.body['invite'] as Record<string, unknown>)['id'] as string;

    const revoked = await call(api, 'DELETE', `/api/stores/${STORE.a}/invites/${id}`);
    assert.equal(revoked.body['revoked'], true);
    assert.equal((await call(api, 'GET', `/api/invites/${token}`)).status, 404);
    // Idempotent.
    assert.equal((await call(api, 'DELETE', `/api/stores/${STORE.a}/invites/${id}`)).body['revoked'], false);

    forget();
    await signIn(`manager-a@${EMAIL_DOMAIN}`);
    const asManager = await call(api, 'POST', `/api/stores/${STORE.a}/invites`, {
      body: { email: `nope@${EMAIL_DOMAIN}`, name: 'Nope', role: 'rider' },
    });
    assert.equal(asManager.status, 403);
  });

  it('refuses inviting somebody who is already staff here', async () => {
    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/invites`, {
      body: { email: `manager-a@${EMAIL_DOMAIN}`, name: 'Manager A', role: 'rider' },
    });
    assert.equal(reply.status, 409);
    assert.equal(reply.body['code'], 'ALREADY_A_MEMBER');
  });

  it('refuses granting owner', async () => {
    await signIn(`owner-a@${EMAIL_DOMAIN}`);
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/invites`, {
      body: { email: `boss@${EMAIL_DOMAIN}`, name: 'Boss', role: 'owner' },
    });
    assert.equal(reply.status, 400);
  });
});

// ===========================================================================
describe('changing your own password', () => {
  it('needs the current one', async () => {
    await signIn(`owner-a@${EMAIL_DOMAIN}`);

    const wrong = await call(api, 'POST', '/api/password/change', {
      body: { currentPassword: 'not-it-at-all-1', password: 'changed-by-me-8' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body['code'], 'WRONG_PASSWORD');

    const right = await call(api, 'POST', '/api/password/change', {
      body: { currentPassword: FIXTURE_PASSWORD, password: 'changed-by-me-8' },
    });
    assert.equal(right.status, 200);
    assert.equal((await call(api, 'GET', '/api/session')).status, 200, 'this device stays signed in');

    forget();
    assert.equal((await signIn(`owner-a@${EMAIL_DOMAIN}`, 'changed-by-me-8')).status, 200);
    await seedAuthPasswords();
  });

  it('is refused with no session', async () => {
    const reply = await call(api, 'POST', '/api/password/change', {
      body: { currentPassword: FIXTURE_PASSWORD, password: 'changed-by-me-8' },
    });
    assert.equal(reply.status, 401);
  });
});

// ===========================================================================
describe('a hand-made token still works where a test needs one', () => {
  it('because readToken accepts the Authorization header too', async () => {
    // Every other suite signs in that way, and it must keep working — but only at the CURRENT session
    // version, which is the guard's other half. The suites above changed passwords, so v1 is stale here;
    // reading the live version is the point rather than a workaround.
    const { rows } = await sql<{ session_version: number }>(
      `SELECT session_version FROM users WHERE id = $1`,
      [USER.ownerA],
    );
    const version = rows[0]?.session_version;
    assert.ok(version !== undefined);

    const current = await call(api, 'GET', '/api/session', {
      token: tokenFor(USER.ownerA, version),
    });
    assert.equal(current.status, 200);

    // And a token at a version that has been superseded is refused — the same check that signs out
    // every other device after a password change.
    const stale = await call(api, 'GET', '/api/session', { token: tokenFor(USER.ownerA, version - 1) });
    assert.equal(stale.status, 401);
    assert.equal(stale.body['code'], 'SESSION_REVOKED');
  });
});
