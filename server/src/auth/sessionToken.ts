// server/src/auth/sessionToken.ts — milestone 11.
//
// Signing and verifying the session token, and nothing else. WHO is asking.
//
// Milestone 15 owns the sign-in flow — the four personas, the store picker across
// memberships, CSRF, and §2.5's "no browser storage". This file is the piece that
// authorization needs before any of that exists: the guard has to turn a request into
// a user id, and the escalation tests have to be able to make an authenticated
// request. It is deliberately the smallest thing that does that.
//
// WHAT THE TOKEN DOES NOT CARRY: a role, a store, a permission. The old token carried
// `tenantId` and `role` (services/session.js), which is what made a revoked role keep
// working until the token expired. §5.4's fourth escalation test — "revoking a
// membership denies the next request, not the next login" — is a test of this
// decision. The token says who; every request re-reads what they may do.
//
// COOKIE_NAME and readToken come from the legacy session service rather than being
// copied, so the two servers cannot drift on the cookie a browser holds. That module
// imports jsonwebtoken and nothing else — no supabase — which test/no-supabase.test.ts
// checks rather than assumes.

import jwt from 'jsonwebtoken';
import { COOKIE_NAME, readToken } from '../services/session.js';
import { unauthorized } from '../db/index.ts';

export { COOKIE_NAME, readToken };

/**
 * `typ` separates a session from a socket ticket, as it already does in
 * services/session.js. Requiring it also means a token issued by the OLD server —
 * which sets no `typ` — cannot authenticate here. That is correct rather than
 * incidental: the two databases hold different people under different ids, so a
 * token from one is not an identity in the other.
 */
const TOKEN_TYPE = 'session';

const MIN_SECRET_LENGTH = 32;

type SessionClaims = {
  sub: string;
  typ: string;
};

/** '24h' | '30m' | '90s' | '7d' → seconds. Matches services/session.js so the two agree. */
function ttlSeconds(): number {
  const raw = String(process.env.JWT_EXPIRES_IN ?? '24h').trim();
  const m = /^(\d+)\s*([smhd])?$/.exec(raw);
  if (m === null) return 24 * 60 * 60;
  const n = Number.parseInt(m[1] ?? '0', 10);
  const unit = m[2] ?? 's';
  const seconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return n * (seconds[unit] ?? 1);
}

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (value === undefined || value.length < MIN_SECRET_LENGTH) {
    // Reachable only if assertSessionConfig() was not called at boot.
    throw new Error('JWT_SECRET is missing or too short; call assertSessionConfig() at boot.');
  }
  return value;
}

/**
 * Boot-time check, the counterpart of assertDatabaseConfig(). A weak secret is worse
 * than a missing one, because everything works — including forged tokens for anyone.
 * config/env.js says the same thing for the legacy server; this is the new stack's
 * copy, kept separate so the new server does not inherit that file's MoMo assertions.
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

/**
 * Signs a session token for a user id.
 *
 * Milestone 15 wraps this in the cookie-setting sign-in endpoint. Until then its only
 * callers are the tests, which is why it takes an id rather than a user row: there is
 * nothing else about the person a token is allowed to carry.
 */
export function signSessionToken(userId: string, options: { expiresInSeconds?: number } = {}): string {
  const claims: SessionClaims = { sub: userId, typ: TOKEN_TYPE };
  return jwt.sign(claims, secret(), { expiresIn: options.expiresInSeconds ?? ttlSeconds() });
}

/**
 * The user id this token claims, or an AppError describing why it does not.
 *
 * Every failure is the same 401 from the caller's point of view — a token that is
 * expired, forged, for a socket, or simply absent are all "not signed in" — while the
 * `code` distinguishes them so a client can tell "sign in again" from "your session
 * ended".
 */
export function verifySessionToken(token: string): string {
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

  const { sub, typ } = decoded as Partial<SessionClaims>;

  // A socket ticket is scoped to a WebSocket handshake and lives 60 seconds; it must
  // never stand in for a session. The legacy server checks the same thing.
  if (typ !== TOKEN_TYPE) {
    throw unauthorized('Please sign in again.', 'SESSION_INVALID');
  }

  if (typeof sub !== 'string' || sub === '') {
    throw unauthorized('Please sign in again.', 'SESSION_INVALID');
  }

  return sub;
}
