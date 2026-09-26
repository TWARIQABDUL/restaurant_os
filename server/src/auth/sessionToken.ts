// server/src/auth/sessionToken.ts — milestone 11, completed at milestone 15.
//
// Signing, verifying and setting the session cookie. WHO is asking, and for how long.
//
// WHAT THE TOKEN CARRIES, and nothing else: the user id, a type, and the session VERSION it was
// issued at. No role and no store — §5.4's fourth escalation test ("revoking a membership denies the
// next request, not the next login") is a test of that, and milestone 11's guard re-reads both from
// the database on every request.
//
// THE VERSION IS THE REVOCATION MECHANISM. `users.session_version` (V016) is bumped to sign out every
// device; the guard compares. That is how Auth's "This signs you out on every other device" works,
// and it is why there is no sessions table — see V016's header for why that is enough.
//
// COOKIE_NAME and readToken come from the legacy session service rather than being copied, so the two
// servers cannot drift on the cookie a browser holds. That module imports jsonwebtoken and nothing
// else — no supabase — which test/api/no-supabase.test.ts checks rather than assumes.

import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { COOKIE_NAME, readToken } from '../services/session.js';
import { unauthorized } from '../db/index.ts';

export { COOKIE_NAME, readToken };

/**
 * `typ` separates a session from a socket ticket, as it already does in services/session.js.
 * Requiring it also means a token issued by the OLD server — which sets no `typ` — cannot
 * authenticate here. That is correct rather than incidental: the two databases hold different people
 * under different ids, so a token from one is not an identity in the other.
 */
const TOKEN_TYPE = 'session';

const MIN_SECRET_LENGTH = 32;

/**
 * Two lifetimes, because Auth draws a choice: "Keep me signed in on this device".
 *
 *   remembered = false → a SESSION cookie with no max-age. Gone when the browser closes, which is
 *                        what somebody on a shared or borrowed phone is asking for.
 *   remembered = true  → 30 days.
 *
 * The token's own expiry matches the cookie's in both cases, so a cookie that outlived its token
 * cannot exist. A session cookie still needs a token expiry, because a browser left open for a month
 * is not a month-long grant.
 */
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? String(12 * 60 * 60));
const REMEMBERED_TTL_SECONDS = Number(process.env.SESSION_REMEMBERED_TTL_SECONDS ?? String(30 * 24 * 60 * 60));

export type SessionClaims = {
  sub: string;
  typ: string;
  /** users.session_version at the moment this was issued. */
  v: number;
};

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (value === undefined || value.length < MIN_SECRET_LENGTH) {
    throw new Error('JWT_SECRET is missing or too short; call assertSessionConfig() at boot.');
  }
  return value;
}

/**
 * Boot-time check, the counterpart of assertDatabaseConfig(). A weak secret is worse than a missing
 * one, because everything works — including forged tokens for anyone.
 */
export function assertSessionConfig(): void {
  const value = process.env.JWT_SECRET;
  const problems: string[] = [];

  if (value === undefined || value.trim() === '') {
    problems.push('  JWT_SECRET is not set. Generate one: openssl rand -base64 48');
  } else {
    const normalized = value.trim().toLowerCase();
    if (normalized.startsWith('your_') || normalized === 'changeme' || normalized === 'secret') {
      problems.push('  JWT_SECRET is still a placeholder. Generate a real one: openssl rand -base64 48');
    } else if (value.length < MIN_SECRET_LENGTH) {
      problems.push(
        `  JWT_SECRET is only ${value.length} characters. Use at least ${MIN_SECRET_LENGTH}: openssl rand -base64 48`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(`\nRefusing to start — sessions are not safe to issue:\n\n${problems.join('\n')}\n`);
    process.exit(1);
  }
}

export function ttlFor(remembered: boolean): number {
  return remembered ? REMEMBERED_TTL_SECONDS : SESSION_TTL_SECONDS;
}

/** Signs a session token for a user at a given session version. */
export function signSessionToken(
  userId: string,
  options: { sessionVersion?: number; expiresInSeconds?: number } = {},
): string {
  const claims: SessionClaims = { sub: userId, typ: TOKEN_TYPE, v: options.sessionVersion ?? 1 };
  return jwt.sign(claims, secret(), { expiresIn: options.expiresInSeconds ?? SESSION_TTL_SECONDS });
}

/**
 * The user id and version this token claims, or an AppError describing why it does not.
 *
 * Every failure is the same 401 to the caller — expired, forged, for a socket, or absent are all "not
 * signed in" — while `code` distinguishes them so a client can tell "sign in again" from "your
 * session ended".
 */
export function verifySessionToken(token: string): { userId: string; sessionVersion: number } {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, secret());
  } catch (err) {
    if (err instanceof Error && err.name === 'TokenExpiredError') {
      throw unauthorized('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
    }
    throw unauthorized('Please sign in again.', 'SESSION_INVALID');
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw unauthorized('Please sign in again.', 'SESSION_INVALID');
  }

  const { sub, typ, v } = decoded as Partial<SessionClaims>;

  // A socket ticket is scoped to a WebSocket handshake and lives 60 seconds; it must never stand in
  // for a session. The legacy server checks the same thing.
  if (typ !== TOKEN_TYPE || typeof sub !== 'string' || sub === '') {
    throw unauthorized('Please sign in again.', 'SESSION_INVALID');
  }

  // A token with no version is one issued before V016. There are none in the wild — the new server
  // has never been deployed — so it is refused rather than defaulted, because defaulting it would
  // make the revocation check pass for a token that predates revocation.
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw unauthorized('Please sign in again.', 'SESSION_INVALID');
  }

  return { userId: sub, sessionVersion: v };
}

/**
 * Sets the session cookie.
 *
 * §2.5: "httpOnly, Secure, SameSite, with an explicit max-age for Auth's 'Keep me signed in on this
 * device'."
 *
 * SameSite=Lax rather than Strict, and rather than None: Lax still sends the cookie on a top-level
 * navigation back to the site — which is how somebody returns from an SMS link or an email — while
 * blocking it on a cross-site POST, which is the CSRF case. Strict would break the return from a
 * payment redirect. None would require Secure everywhere and is what Safari blocks.
 */
export function setSessionCookie(
  res: Response,
  token: string,
  options: { remembered: boolean },
): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // No maxAge at all for a non-remembered session: that is what makes it a session cookie.
    ...(options.remembered ? { maxAge: REMEMBERED_TTL_SECONDS * 1000 } : {}),
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}
