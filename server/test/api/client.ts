// server/test/api/client.ts — milestone 11.
//
// Boots the real app on an ephemeral port and makes real HTTP requests to it.
//
// §5.4's third escalation test is explicit that a manager's refusal must be "verified
// against the endpoint, not against whether the nav item is hidden". Calling a handler
// function directly would skip the guard, the mount path and the error handler — the
// three things under test. So: a listening socket and fetch().

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/api/app.ts';
import { signSessionToken } from '../../src/auth/sessionToken.ts';

export type Api = {
  baseUrl: string;
  close: () => Promise<void>;
  /**
   * The CSRF token this "browser" holds, and the cookies it has been set.
   *
   * A real browser stores the csrf cookie the server issues and the client echoes it in a header
   * (auth/csrf.ts). The tests have to do the same or every unsafe method is a 403 — which is the point
   * of the middleware, so faking past it would be testing nothing.
   */
  cookies: Map<string, string>;
};

export async function boot(): Promise<Api> {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const address = server.address() as AddressInfo;
  const api: Api = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    cookies: new Map(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined || err === null ? resolve() : reject(err)));
      }),
  };

  // One GET to collect the csrf cookie, exactly as a browser's first page load does.
  //
  // NOT /api/health: that is mounted BEFORE the CSRF layer on purpose — it is a GET a load balancer
  // polls and it changes nothing, so issuing it a token would mean a Set-Cookie on every poll. So this
  // primes on /api/session, which is inside the layer and answers 401 without one, which is fine: the
  // cookie is what is wanted.
  const primed = await fetch(`${api.baseUrl}/api/session`);
  absorbCookies(api, primed);
  await primed.text();
  if (!api.cookies.has('csrf')) {
    // Loud rather than subtle. Without the token every unsafe request is a 403 from the CSRF layer —
    // and a test asserting 403 for an authorization reason would then pass for the wrong one.
    throw new Error('boot(): the server issued no csrf cookie, so every write would 403 for the wrong reason');
  }

  return api;
}

/** Stores whatever Set-Cookie the server sent, so later requests carry it. */
export function absorbCookies(api: Api, res: Response): void {
  for (const header of res.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // An empty value is a clear-cookie, which is a deletion rather than a value.
    if (value === '') api.cookies.delete(name);
    else api.cookies.set(name, value);
  }
}

function cookieHeader(api: Api): string {
  return [...api.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

export type Reply = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * One request, behaving like a browser: it sends the cookies it holds, echoes the csrf token on an
 * unsafe method, and absorbs whatever cookies come back.
 *
 * `token` still goes in the Authorization header where a test supplies one directly — readToken()
 * accepts both, and a test that wants to assert on one specific identity should not have to sign in
 * through the whole flow to get there. `cookieSession: true` uses the session cookie instead, which is
 * what the sign-in tests need.
 */
export async function call(
  api: Api,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; csrf?: boolean } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const jar = cookieHeader(api);
  if (jar !== '') headers['Cookie'] = jar;

  // The double-submit echo. `csrf: false` is how a test asserts the middleware actually refuses.
  const csrf = api.cookies.get('csrf');
  if (options.csrf !== false && csrf !== undefined) headers['X-CSRF-Token'] = csrf;

  const res = await fetch(`${api.baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  absorbCookies(api, res);

  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { raw: parsed };
    } catch {
      body = { raw: text };
    }
  }

  return { status: res.status, body };
}

/**
 * A token for a user, at a session version.
 *
 * Defaults to 1, which is what a freshly seeded user has (V016's column default). A suite that has
 * changed a password must pass the current version, because the guard compares — which is the whole
 * point of the column.
 */
export function tokenFor(userId: string, sessionVersion = 1): string {
  return signSessionToken(userId, { sessionVersion });
}
