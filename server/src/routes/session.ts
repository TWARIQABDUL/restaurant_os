// server/src/routes/session.ts — milestone 11.
//
// Who am I, where do I work, and what may I do.
//
// This is the endpoint Auth's store picker reads at milestone 15 — §5.4's case of one
// person being "Owner at Nyama & Co. AND Manager at Inzu Threads", which a
// `users.tenant_id` column could not express. It is also the honest answer to "is my
// session still good", because it re-reads: a revoked membership disappears from the
// list on the next call, not at the next sign-in.
//
// SIGNING IN IS NOT HERE. POST /api/session — credentials, the httpOnly cookie, CSRF,
// the four personas — is milestone 15, which owns the whole flow. This milestone needs
// to read a session, not to create one.

import { Router } from 'express';
import { readConsistent, unauthorized, withTransaction } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, requiredString } from '../api/validate.ts';
import { authOf, requireSession } from '../middleware/authorize.ts';
import {
  clearSessionCookie,
  setSessionCookie,
  signSessionToken,
  ttlFor,
} from '../auth/sessionToken.ts';
import { sendCode } from '../messaging/otp.ts';
import * as auth from '../repositories/auth.ts';
import * as memberships from '../repositories/memberships.ts';
import * as permissions from '../repositories/permissions.ts';
import * as users from '../repositories/users.ts';
import { authLimiter } from '../middleware/rateLimit.js';

const router = Router();

/**
 * The one thing a failed sign-in ever says.
 *
 * The legacy server's rule, kept: a uniform error means the endpoint cannot be used to discover which
 * addresses are registered. It is also why the candidate lookup spends a bcrypt comparison even when
 * there is no candidate — otherwise timing says what the message will not.
 */
const SIGN_IN_FAILED = 'That email or password is not right.';

function readRemembered(body: Record<string, unknown>): boolean {
  // Auth's checkbox: "Keep me signed in on this device". Absent means no.
  return body['remember'] === true;
}

/** Signs a token at the user's current session version and sets the cookie. */
function issueSession(
  res: Parameters<typeof setSessionCookie>[0],
  user: { id: string; session_version: number },
  remembered: boolean,
): void {
  const token = signSessionToken(user.id, {
    sessionVersion: user.session_version,
    expiresInSeconds: ttlFor(remembered),
  });
  setSessionCookie(res, token, { remembered });
}

/**
 * "g•••@vendlyfy.example" — enough for somebody to recognise their own address and not enough to learn
 * somebody else's. Shown on the two-step screen, which is reached by password, so the address is
 * already known to whoever is looking; masking it means a shoulder-surfer does not also get it.
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '•••';
  const first = email.slice(0, 1);
  return `${first}${'•'.repeat(Math.max(2, Math.min(6, at - 1)))}${email.slice(at)}`;
}

/**
 * GET /api/session — the signed-in person, their memberships and their permissions.
 *
 * The permission list here is the PLATFORM half only, because permissions are
 * per-store and this route names no store: each membership carries its own role, and
 * what that role may do is in the roles payload below. A client that wants "may I see
 * the wallet at Nyama" reads the role from `memberships` and looks it up in `roles` —
 * which is §5.4's rule that a component asks whether a role may do something and never
 * contains the list.
 */
router.get(
  '/',
  requireSession,
  asyncHandler(async (req, res) => {
    const { context } = authOf(req);

    // One consistent read: a membership list and the role definitions behind it, taken
    // at the same moment. Two separate reads could show a role the list no longer has.
    const payload = await readConsistent(async (tx) => {
      const mine = await memberships.listForUser(context.userId, tx);
      const roles = await permissions.listAll(tx);
      return { mine, roles };
    }, 'GET /api/session');

    res.json({
      user: {
        id: context.userId,
        name: context.name,
        email: context.email,
        phone: context.phone,
        scope: context.scope,
        // Set only for a customer: the one store their account belongs to.
        // CustomerAccount: "This account is only for Nyama & Co."
        customerStoreId: context.customerStoreId,
      },
      platformRole: context.platformRole,
      platformPermissions: context.permissions,
      memberships: payload.mine.map((m) => ({
        storeId: m.store_id,
        slug: m.store_slug,
        name: m.store_name,
        status: m.store_status,
        role: m.role,
      })),
      roles: payload.roles,
    });
  }),
);



/**
 * POST /api/session — sign in.
 *
 * THE IDENTIFIER IS LOOKED UP ACROSS THE PLATFORM AND THE PASSWORD DECIDES WHICH ACCOUNT IT IS. A
 * store, when one is named, is only a preference for disambiguating between several matches — never a
 * filter that can exclude the right account. The reasoning is at length in repositories/auth.ts, and
 * §5.4 says why it matters: "scoping the sign-in lookup wrongly once locked real users out of
 * production."
 *
 * WHAT COMES BACK DEPENDS ON WHO SIGNED IN, which is Auth's four personas:
 *
 *   one membership   → `{ next: 'ready' }` and a session cookie. The client routes by role.
 *   several          → `{ next: 'choose-store' }` with the list. Already signed in; the picker is a
 *                      navigation choice, not a second authentication.
 *   platform member  → `{ next: 'two-step' }` and NO session cookie yet. The Vendlyfy team's console
 *                      "always needs your 2-step code" (AdminStates), so the password alone must not
 *                      produce a session.
 *   no membership    → `{ next: 'ready' }`. A customer, or staff whose membership was revoked; both
 *                      have a valid identity and nothing to pick.
 */
router.post(
  '/',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = bodyOf(req.body);
    const identifier = requiredString(body, 'identifier', { max: 254 });
    const password = requiredString(body, 'password', { max: 200 });
    const remembered = readRemembered(body);

    const outcome = await withTransaction(
      async (tx) => {
        const candidates = await auth.findLoginCandidates(identifier, tx);

        // ALWAYS SPEND ONE COMPARISON. With no candidate, compare against a fixed hash so a miss costs
        // what a wrong password costs and timing does not reveal which addresses are registered.
        if (candidates.length === 0) {
          await users.verifyPassword(password, auth.DUMMY_PASSWORD_HASH);
          return null;
        }

        const matched: auth.Candidate[] = [];
        for (const candidate of candidates) {
          if (await users.verifyPassword(password, candidate.password_hash)) matched.push(candidate);
        }
        if (matched.length === 0) return null;

        // Most privileged first — see rank(). Several matches means one person reused a password
        // across their own accounts, which is common and not an error.
        const user = [...matched].sort((a, b) => auth.rank(a) - auth.rank(b))[0];
        if (user === undefined) return null;

        const platformRole = await memberships.findPlatformRole(user.id, tx);
        const stores = platformRole === null ? await memberships.listForUser(user.id, tx) : [];

        return { user, platformRole, stores };
      },
      { label: 'POST /api/session', retries: 0 },
    );

    if (outcome === null) throw unauthorized(SIGN_IN_FAILED, 'SIGN_IN_FAILED');

    const { user, platformRole, stores } = outcome;

    // The Vendlyfy team gets no cookie until the second factor. A password-only session for an account
    // that can suspend stores and read audit logs is exactly what the 2-step exists to prevent.
    if (platformRole !== null) {
      const { code, expiresAt } = await withTransaction(
        (tx) => auth.issueCode(user.id, 'platform_two_step', tx),
        { label: 'issue two-step code' },
      );
      // Sent, never returned in the response: putting it there would make the second factor a formality.
      await sendCode({ email: user.email, phone: user.phone }, 'two-step code', code, expiresAt);

      res.json({
        next: 'two-step',
        // The id is needed to submit the code, and it is not a credential — the code is.
        userId: user.id,
        sentTo: maskEmail(user.email),
        expiresAt,
      });
      return;
    }

    issueSession(res, user, remembered);

    res.json({
      next: stores.length > 1 ? 'choose-store' : 'ready',
      user: { id: user.id, name: user.name, email: user.email, scope: user.scope },
      memberships: stores.map((s) => ({
        storeId: s.store_id,
        slug: s.store_slug,
        name: s.store_name,
        role: s.role,
      })),
    });
  }),
);

/**
 * POST /api/session/two-step — the Vendlyfy team's second factor.
 *
 * Rate limited on the same bucket as the password: five wrong codes burn the row (V016 bounds attempts
 * at the column), and the limiter stops somebody cycling through fresh codes to get more attempts.
 */
router.post(
  '/two-step',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = bodyOf(req.body);
    const userId = requiredString(body, 'userId', { max: 64 });
    const code = requiredString(body, 'code', { max: 12 });
    const remembered = readRemembered(body);

    type TwoStep =
      | { ok: false; reason: 'none' | 'expired' | 'wrong' | 'too_many'; attemptsLeft: number }
      | {
          ok: true;
          user: { id: string; name: string; email: string; scope: 'platform' | 'store' };
          platformRole: string;
          sessionVersion: number;
        };

    const signedIn: TwoStep = await withTransaction(
      async (tx): Promise<TwoStep> => {
        const check = await auth.consumeCode(userId, 'platform_two_step', code, tx);
        if (!check.ok) return { ok: false, reason: check.reason, attemptsLeft: check.attemptsLeft };

        const identity = await users.findById(userId, tx);
        if (identity === null) return { ok: false, reason: 'none', attemptsLeft: 0 };

        // Belt to the code's braces: a code issued for somebody who has since lost their platform role
        // must not still open the console.
        const platformRole = await memberships.findPlatformRole(userId, tx);
        if (platformRole === null) return { ok: false, reason: 'none', attemptsLeft: 0 };

        const sessionVersion = await auth.sessionVersionOf(userId, tx);
        if (sessionVersion === null) return { ok: false, reason: 'none', attemptsLeft: 0 };

        return {
          ok: true,
          user: { id: identity.id, name: identity.name, email: identity.email, scope: identity.scope },
          platformRole,
          sessionVersion,
        };
      },
      { label: 'POST /api/session/two-step', retries: 0 },
    );

    if (!signedIn.ok) {
      // The reason is reported because it is actionable and reveals nothing: the caller already proved
      // the password, so "expired" or "3 tries left" tells an attacker nothing they could not measure.
      const message =
        signedIn.reason === 'expired'
          ? 'That code has expired. Ask for a new one.'
          : signedIn.reason === 'too_many'
            ? 'Too many wrong codes. Ask for a new one.'
            : signedIn.reason === 'wrong'
              ? `That code is not right. ${signedIn.attemptsLeft} ${signedIn.attemptsLeft === 1 ? 'try' : 'tries'} left.`
              : 'Ask for a new code.';
      throw unauthorized(message, `TWO_STEP_${signedIn.reason.toUpperCase()}`);
    }

    issueSession(res, { id: signedIn.user.id, session_version: signedIn.sessionVersion }, remembered);

    res.json({
      next: 'ready',
      user: signedIn.user,
      platformRole: signedIn.platformRole,
      memberships: [],
    });
  }),
);

/**
 * DELETE /api/session — sign out.
 *
 * NOT AUTHENTICATED, on purpose, and the legacy server made the same call: an expired or already
 * invalid session should still be able to clean itself up rather than getting a 401 and leaving a
 * stale cookie in the browser forever.
 */
router.delete(
  '/',
  asyncHandler(async (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

export default router;
