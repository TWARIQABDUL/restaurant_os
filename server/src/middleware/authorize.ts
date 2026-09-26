// server/src/middleware/authorize.ts — milestone 11.
//
// The membership-aware guard that replaces `user.tenant_id !== req.tenant.id`.
//
// §5.4 states the change: "With memberships that becomes: does this user hold a
// membership in the store this request names, and does that membership's role permit
// this action? The per-request DB re-read stays — it is what makes a revoked role take
// effect immediately, and that property is worth keeping."
//
// FOUR DECISIONS, each one an escalation test in §5.4:
//
//   1. THE STORE COMES FROM THE PATH, NEVER FROM A HEADER OR A BODY. The old guard
//      resolved the store from X-Tenant-Slug — a client-controlled header — and then
//      compared it to the user's single tenant_id. Here the route names the store in
//      its own URL and the membership lookup is against that. A caller can still ask
//      about any store they like; asking is what produces the 403.
//
//   2. THERE IS NO FALLBACK STORE. The old resolveTenant() fell back to "the first
//      active tenant" when no slug was given. A guard whose subject can be guessed is
//      not a guard, and a request that names no store simply holds no store
//      permissions here.
//
//   3. NO super_admin BYPASS. See repositories/authContext.ts for why: V001 gave the
//      platform team explicit permissions rather than a wildcard, so a platform role
//      reaches a store through /api/admin/* and its own permissions, not through the
//      merchant's endpoint.
//
//   4. THE PERMISSION IS CHECKED, NOT THE ROLE. `requireStorePermission('wallet.read')`
//      rather than `authorize('owner', 'admin')`. §5.4: "A component asks whether a
//      role may do something; it never contains the list." A route that named roles
//      would have to be edited every time AdminTeam adds one.
//
// WHY EACH GUARD IS ONE MIDDLEWARE AND NOT THREE. Authenticating, loading the context
// and checking the permission are one function per route, so there is no order to get
// wrong and no route that can be mounted with the second half missing. The cost is one
// database round trip per request, which is the re-read §5.4 asks for anyway.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { badRequest, db, forbidden, toAppError, unauthorized } from '../db/index.ts';
import { readToken, verifySessionToken } from '../auth/sessionToken.ts';
import { loadAuthContext } from '../repositories/authContext.ts';
import type { AuthContext } from '../repositories/authContext.ts';

/** What the guard proved. Reachable from a handler only through authOf(). */
export type RequestAuth = {
  context: AuthContext;
  /** The store this request named, or null for a route that names none. */
  storeId: string | null;
  /** The permission the guard required to let this request through. */
  granted: string | null;
};

/**
 * A symbol, not a property name, and no `declare global` augmentation of
 * Express.Request.
 *
 * Augmenting Request would make `req.auth` optional on EVERY route in the process —
 * including the legacy ones — so a handler that forgot its guard would read `undefined`
 * and a `req.auth?.context.userId` would quietly be nobody. authOf() throws instead:
 * a route mounted without its guard fails on the first request, loudly, in development,
 * rather than serving one person's data to another.
 */
const AUTH = Symbol('vendlyfy.requestAuth');

type Carrier = { [AUTH]?: RequestAuth };

function attach(req: Request, value: RequestAuth): void {
  (req as Request & Carrier)[AUTH] = value;
}

/**
 * What the guard proved about this request. Throws if no guard ran — which is a
 * programming error, not a client error, so it is a plain Error and a 500.
 */
export function authOf(req: Request): RequestAuth {
  const value = (req as Request & Carrier)[AUTH];
  if (value === undefined) {
    throw new Error(
      'authOf() called on a request that no guard ran on — mount requireSession or ' +
        'requireStorePermission on this route.',
    );
  }
  return value;
}

/** The store this request named, having been proved a member of it. */
export function storeIdOf(req: Request): string {
  const { storeId } = authOf(req);
  if (storeId === null) {
    throw new Error('storeIdOf() called on a route that names no store.');
  }
  return storeId;
}

// A uuid, any version. Validated before it reaches a query so that a malformed path
// parameter is a 400 that says so, rather than a 22P02 from Postgres translated back
// into a vaguer one.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** The identity and session version this request's token claims. Throws an AppError otherwise. */
function caller(req: Request): { userId: string; sessionVersion: number } {
  const token = readToken(req);
  if (token === null || token === undefined || token === '') {
    throw unauthorized();
  }
  return verifySessionToken(token);
}

function guard(
  resolveStoreId: (req: Request) => string | null,
  permission: string | null,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      const { userId, sessionVersion } = caller(req);
      const storeId = resolveStoreId(req);

      // THE RE-READ. Not cached, not taken from the token. This is the statement that
      // makes a revoked membership deny the next request rather than the next login.
      const context = await loadAuthContext(storeId, userId);

      // The token outlived the account. A 401 rather than a 403: there is nobody to
      // authorize, and telling the client to sign in again is the useful answer.
      if (context === null) {
        throw unauthorized('Your account is no longer available.', 'ACCOUNT_GONE');
      }

      // THE OTHER HALF OF THE RE-READ, added at milestone 15. A password change bumps
      // users.session_version (V016), so a token issued before it no longer matches — which is how
      // Auth's "This signs you out on every other device" is true of tokens already in the wild.
      // Compared here rather than in verifySessionToken() because only the database knows the
      // current version, and a stateless check could never see a change.
      if (context.sessionVersion !== sessionVersion) {
        throw unauthorized('Your password changed, so you were signed out here.', 'SESSION_REVOKED');
      }

      if (permission !== null && !context.permissions.includes(permission)) {
        // Deliberately the same 403 whether the caller holds no membership in this
        // store, holds one whose role lacks the permission, or named a store that does
        // not exist. Distinguishing them would let anyone enumerate which store ids
        // are real and who works where.
        throw forbidden('You do not have access to do that in this store.');
      }

      attach(req, { context, storeId, granted: permission });
      next();
    })().catch((err: unknown) => {
      next(toAppError(err));
    });
  };
}

function storeIdFromParams(req: Request): string {
  const raw = req.params['storeId'];
  if (!isUuid(raw)) {
    throw badRequest('That is not a valid store id.', 'INVALID_STORE_ID');
  }
  return raw;
}

/**
 * Requires a store permission, in the store named by `:storeId` in the path.
 *
 * `permission` is a row in role_permissions — 'wallet.read', 'staff.create',
 * 'orders.update'. A typo'd ROLE is refused at the column (V001 keeps scope and role
 * coherent and says why), but a typo'd PERMISSION here is not: it would simply never
 * match, and every caller would get 403 — which reads as a broken role rather than a
 * misspelt string. assertPermissionsExist() below is what catches that, at boot.
 */
export function requireStorePermission(permission: string): RequestHandler {
  return guard(storeIdFromParams, permission);
}

// THERE IS NO requirePlatformPermission HERE, and its absence is deliberate. `guard()`
// would support it in one line — `guard(() => null, 'kyc.review')` — but no route in this
// app needs it until the admin console at milestone 27, and an untested branch in the file
// that decides who may do what is worse than three lines somebody has to write later.
// Milestone 27 adds it together with the escalation tests for the platform scope.

/**
 * Authenticates and loads the caller's context without requiring any permission.
 *
 * For the routes that tell a signed-in person about themselves — which store they
 * work at, what they may do. It still re-reads, so a deleted account is a 401 here
 * too.
 */
export const requireSession: RequestHandler = guard(() => null, null);

/**
 * Boot-time check that every permission string the routes ask for exists in
 * role_permissions.
 *
 * A misspelt permission in a route is invisible: the guard finds it in nobody's set
 * and answers 403 for everyone, which reads as "the role is wrong" rather than "the
 * string is wrong". V001 refuses a typo'd ROLE at the column for exactly this reason
 * and says so; this is the same protection for the other half of the pair, which no
 * constraint can see because it lives in application code.
 */
export async function assertPermissionsExist(required: readonly string[]): Promise<void> {
  const { rows } = await db.query<{ permission: string }>(
    `SELECT DISTINCT permission FROM role_permissions WHERE permission = ANY($1::text[])`,
    [[...required]],
  );
  const known = new Set(rows.map((r) => r.permission));
  const missing = required.filter((p) => !known.has(p));

  if (missing.length > 0) {
    throw new Error(
      `These permissions are required by routes but exist in no role_permissions row: ${missing.join(', ')}. ` +
        'Either the string is misspelt or the migration that grants it is missing.',
    );
  }
}
