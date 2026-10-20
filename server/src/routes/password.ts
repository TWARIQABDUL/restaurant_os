// server/src/routes/password.ts — milestone 15.
//
// Auth's three password paths: forgot → code → new password, and an owner resetting a staff member's.
//
// THE REQUEST ALWAYS SUCCEEDS. `POST /api/password/reset` answers 200 whether or not the identifier
// matches anybody — the same reasoning as the uniform sign-in error, and it matters more here because
// this endpoint needs no password at all, so a distinguishable response is a free list of who has an
// account.

import { Router } from 'express';
import { badRequest, notFound, unauthorized, withTransaction } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, requiredString } from '../api/validate.ts';
import { authOf, isUuid, requireSession, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { checkPassword, firstPasswordProblem } from '../auth/password.ts';
import { clearSessionCookie, setSessionCookie, signSessionToken, ttlFor } from '../auth/sessionToken.ts';
import { authLimiter } from '../middleware/rateLimit.js';
import { sendCodeEmail } from '../messaging/otp.ts';
import * as auth from '../repositories/auth.ts';
import * as memberships from '../repositories/memberships.ts';
import * as stores from '../repositories/stores.ts';
import * as users from '../repositories/users.ts';

/** Mounted at /api/password. Unauthenticated: somebody who cannot sign in is the whole audience. */
export const passwordRouter = Router();

/** Mounted under /api/stores/:storeId/members/:userId/password — the owner's reset. */
export const staffPasswordRouter = Router({ mergeParams: true });

/** The rules, so a client renders the checklist the server enforces rather than its own copy. */
passwordRouter.get(
  '/rules',
  asyncHandler(async (_req, res) => {
    res.json({ rules: checkPassword('').map((rule) => rule.label) });
  }),
);

/**
 * POST /api/password/reset — ask for a code.
 *
 * Answers the same thing either way. When the identifier does match, a code is issued and emailed —
 * replacing any live one, which V016's partial unique index requires so that "Send again" replaces the
 * window rather than widening it. The send happens after the transaction commits: it is a network call
 * to SendGrid, and holding a database transaction open for the duration of one would be wrong.
 */
passwordRouter.post(
  '/reset',
  authLimiter,
  asyncHandler(async (req, res) => {
    const identifier = requiredString(bodyOf(req.body), 'identifier', { max: 254 });

    const issued = await withTransaction(
      async (tx) => {
        const candidates = await auth.findLoginCandidates(identifier, tx);
        // With several accounts on one address, the most privileged is the one a reset means — the same
        // rank the sign-in uses, so the two agree about which account an identifier refers to.
        const target = [...candidates].sort((a, b) => auth.rank(a) - auth.rank(b))[0];
        if (target === undefined) return null;

        const { code, expiresAt } = await auth.issueCode(target.id, 'password_reset', tx);
        return { email: target.email, code, expiresAt };
      },
      { label: 'POST /api/password/reset' },
    );
    if (issued !== null) await sendCodeEmail(issued.email, 'password reset code', issued.code, issued.expiresAt);

    res.json({
      // Deliberately not "we sent a code to X". The response says what was done, not to whom.
      sent: true,
      message: 'If that account exists, a code is on its way. It is good for 10 minutes.',
    });
  }),
);

/**
 * POST /api/password/reset/confirm — the code and the new password.
 *
 * SIGNS OUT EVERY OTHER DEVICE, which is Auth's own promise beneath the field: "This signs you out on
 * every other device." Done by bumping users.session_version (V016) and then issuing a fresh cookie to
 * whoever made the change — so "every OTHER device" is exact rather than approximate.
 */
passwordRouter.post(
  '/reset/confirm',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = bodyOf(req.body);
    const identifier = requiredString(body, 'identifier', { max: 254 });
    const code = requiredString(body, 'code', { max: 12 });
    const password = requiredString(body, 'password', { max: 200 });

    const done = await withTransaction(
      async (tx) => {
        const candidates = await auth.findLoginCandidates(identifier, tx);
        const target = [...candidates].sort((a, b) => auth.rank(a) - auth.rank(b))[0];
        // No account is the same answer as a wrong code: this endpoint must not become the oracle the
        // request endpoint refuses to be.
        if (target === undefined) return { ok: false as const, reason: 'none' as const, attemptsLeft: 0 };

        const check = await auth.consumeCode(target.id, 'password_reset', code, tx);
        if (!check.ok) return { ok: false as const, reason: check.reason, attemptsLeft: check.attemptsLeft };

        const problem = firstPasswordProblem(password, {
          email: target.email,
          phone: target.phone,
          storeName: await storeNameFor(target.store_id, tx),
        });
        if (problem !== null) throw badRequest(problem, 'WEAK_PASSWORD');

        await users.setPassword(target.id, await users.hashPassword(password), tx);
        const version = await auth.revokeAllSessions(target.id, tx);

        return { ok: true as const, userId: target.id, name: target.name, version };
      },
      { label: 'POST /api/password/reset/confirm' },
    );

    if (!done.ok) {
      const message =
        done.reason === 'expired'
          ? 'That code has expired. Ask for a new one.'
          : done.reason === 'too_many'
            ? 'Too many wrong codes. Ask for a new one.'
            : done.reason === 'wrong'
              ? `That code is not right. ${done.attemptsLeft} ${done.attemptsLeft === 1 ? 'try' : 'tries'} left.`
              : 'That code is not right. Ask for a new one.';
      throw unauthorized(message, `RESET_${done.reason.toUpperCase()}`);
    }

    // A fresh cookie at the NEW version: the device that changed the password stays signed in.
    setSessionCookie(res, signSessionToken(done.userId, { sessionVersion: done.version, expiresInSeconds: ttlFor(false) }), {
      remembered: false,
    });

    res.json({
      next: 'ready',
      user: { id: done.userId, name: done.name },
      message: 'Password changed. You were signed out on every other device.',
    });
  }),
);

/**
 * POST /api/stores/:storeId/members/:userId/password — an owner resets a staff member's password.
 *
 * Auth draws the other end of this: "Aline Uwase (store owner) reset your password. Your old one no
 * longer works." So the reset must invalidate the old password AND every session the staff member has —
 * which bumping session_version does.
 *
 * TWO REFUSALS. An owner cannot reset another OWNER's password, and cannot reset their own here (the
 * ordinary change-password path is theirs). Both would otherwise be a way for one admin to lock out
 * another.
 */
staffPasswordRouter.post(
  '/',
  requireStorePermission('staff.create'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const userId = req.params['userId'];
    if (!isUuid(userId)) throw badRequest('That is not a valid person id.', 'INVALID_USER_ID');

    if (userId === context.userId) {
      throw badRequest('Use the change-password page for your own account.', 'CANNOT_RESET_SELF');
    }

    const password = requiredString(bodyOf(req.body), 'password', { max: 200 });

    await withTransaction(
      async (tx) => {
        const held = await memberships.find(storeId, userId, tx);
        if (held === null) throw notFound('That person is not a member of this store.', 'NOT_A_MEMBER');
        if (held.role === 'owner') {
          throw badRequest("A store owner's password cannot be reset from here.", 'OWNER_NOT_RESETTABLE');
        }

        const identity = await users.findById(userId, tx);
        if (identity === null) throw notFound('That person no longer exists.');

        const problem = firstPasswordProblem(password, {
          email: identity.email,
          phone: identity.phone,
          storeName: await storeNameFor(storeId, tx),
        });
        if (problem !== null) throw badRequest(problem, 'WEAK_PASSWORD');

        await users.setPassword(userId, await users.hashPassword(password), tx);
        await auth.revokeAllSessions(userId, tx);
      },
      { label: 'POST /api/stores/:storeId/members/:userId/password' },
    );

    res.json({
      reset: true,
      message: 'Password changed. They were signed out everywhere and will need the new one.',
    });
  }),
);

/**
 * POST /api/password/change — signed in, changing your own.
 *
 * Requires the CURRENT password, because a session is not proof that the person at the keyboard is the
 * account holder — a borrowed phone is. Signs out every other device and re-cookies this one.
 */
passwordRouter.post(
  '/change',
  requireSession,
  asyncHandler(async (req, res) => {
    const { context } = authOf(req);
    const body = bodyOf(req.body);
    const current = requiredString(body, 'currentPassword', { max: 200 });
    const next = requiredString(body, 'password', { max: 200 });

    const done = await withTransaction(
      async (tx) => {
        const credentials = await users.findCredentialsById(context.userId, tx);
        if (credentials === null) throw unauthorized('Your account is no longer available.', 'ACCOUNT_GONE');

        if (!(await users.verifyPassword(current, credentials.password_hash))) {
          throw unauthorized('That current password is not right.', 'WRONG_PASSWORD');
        }

        const problem = firstPasswordProblem(next, {
          email: context.email,
          phone: context.phone,
          storeName: await storeNameFor(context.customerStoreId, tx),
        });
        if (problem !== null) throw badRequest(problem, 'WEAK_PASSWORD');

        await users.setPassword(context.userId, await users.hashPassword(next), tx);
        return auth.revokeAllSessions(context.userId, tx);
      },
      { label: 'POST /api/password/change' },
    );

    setSessionCookie(res, signSessionToken(context.userId, { sessionVersion: done, expiresInSeconds: ttlFor(false) }), {
      remembered: false,
    });

    res.json({ changed: true, message: 'Password changed. You were signed out on every other device.' });
  }),
);

/** A store's name, for the third password rule. Null store id — staff, not a customer — means no name. */
async function storeNameFor(storeId: string | null, tx: Parameters<typeof stores.findById>[1]): Promise<string | null> {
  if (storeId === null) return null;
  const store = await stores.findById(storeId, tx);
  return store?.name ?? null;
}

export { clearSessionCookie };
