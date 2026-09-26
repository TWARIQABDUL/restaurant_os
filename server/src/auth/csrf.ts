// server/src/auth/csrf.ts — milestone 15.
//
// §2.5: "CSRF becomes mandatory. Cookie-borne credentials are sent automatically, so every
// state-changing request needs a token or a strict same-origin check. `X-Tenant-Slug` is not CSRF
// protection — it is a client-controlled value, as middleware/auth.js itself notes."
//
// THREE LAYERS, and each covers a case the others do not:
//
//   1. SameSite=Lax on the session cookie (sessionToken.ts). A cross-site POST does not carry it at
//      all, which is most of the problem solved by the browser. It is not sufficient alone: an
//      attacker on a SUBDOMAIN of the same site is same-site, and older browsers ignore it.
//   2. An ORIGIN check. When the browser sends Origin or Referer — which it does on every
//      cross-origin request and on every same-origin POST in current browsers — it must match an
//      origin we serve. This is the layer that needs nothing of the client.
//   3. A DOUBLE-SUBMIT TOKEN. A random value in a readable cookie, echoed in a header. An attacker
//      on another origin can cause the cookie to be sent but cannot read it to set the header, and
//      cannot set the header cross-origin without CORS consent.
//
// WHY THE TOKEN AS WELL AS THE ORIGIN CHECK. A request with no Origin and no Referer is not
// obviously hostile — some privacy tooling strips both — so refusing those outright would break real
// people, and accepting them leaves a gap. The token closes it without guessing.
//
// THE CSRF COOKIE IS NOT httpOnly, on purpose: the client has to read it to echo it. That is not
// "browser storage as a source of truth" in §2.5's sense — the server issued it, the server verifies
// the pair, and a forged value fails. Nothing is trusted because the browser remembered it.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { forbidden } from '../db/index.ts';

export const CSRF_COOKIE = 'csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Methods that cannot change state, so they need none of this. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function allowedOrigins(): string[] {
  const client = process.env.CLIENT_URL ?? 'http://localhost:5173';
  const extra = (process.env.CSRF_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  return [client, ...extra];
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Issues a CSRF token cookie if the request does not already carry one.
 *
 * Mounted for every request so a client that has only ever done GETs still has a token when it first
 * needs to POST — otherwise the first sign-in attempt of a fresh browser would fail and the client
 * would have to know to fetch something first.
 */
export const issueCsrfToken: RequestHandler = (req, res, next) => {
  const existing = (req.cookies as Record<string, unknown> | undefined)?.[CSRF_COOKIE];
  if (typeof existing !== 'string' || existing.length < 32) {
    res.cookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
      // Readable by script, deliberately — see the header.
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
  }
  next();
};

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which is itself the answer.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Refuses a state-changing request that does not prove it came from our own page.
 *
 * Mount it once, for the whole API, rather than per route: a route added later that forgot it would
 * be a hole nobody notices, and the only routes that must NOT have it are webhooks — which are called
 * by a payment provider rather than a browser, carry no cookie, and are mounted before this.
 */
export const requireCsrf: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // --- layer 2: the origin ---------------------------------------------------
  const stated = req.get('origin') ?? req.get('referer');
  if (stated !== undefined && stated !== '') {
    const origin = originOf(stated);
    if (origin === null || !allowedOrigins().includes(origin)) {
      next(forbidden('That request did not come from this site.', 'CSRF_ORIGIN'));
      return;
    }
  }

  // --- layer 3: the double-submit token -------------------------------------
  const cookie = (req.cookies as Record<string, unknown> | undefined)?.[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);

  if (typeof cookie !== 'string' || cookie === '' || header === undefined || header === '') {
    next(
      forbidden(
        'That request is missing its security token. Reload the page and try again.',
        'CSRF_MISSING',
      ),
    );
    return;
  }

  if (!equal(cookie, header)) {
    next(forbidden('That request’s security token did not match. Reload the page and try again.', 'CSRF_MISMATCH'));
    return;
  }

  next();
};
