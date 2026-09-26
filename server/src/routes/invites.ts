// server/src/routes/invites.ts — milestone 15.
//
// The staff invite, which is what milestone 11's POST /members refused to do without.
//
// That endpoint creates a NEW account and answers 409 ACCOUNT_EXISTS for an address that already has a
// Vendlyfy account, because attaching somebody to your store on nothing but their email would hand you
// their real name and phone from the staff list and give them a store they never agreed to work at. The
// invite is the consent that makes it safe: nothing exists until the invitee accepts.
//
// TWO MOUNT POINTS, because the two halves have different callers:
//
//   /api/stores/:storeId/invites   the inviter. staff.create, same as POST /members.
//   /api/invites/:token            the invitee, who has no session and no membership yet — so this half
//                                  is unauthenticated, and the TOKEN is the credential.
//
// WHAT AN EXISTING ACCOUNT DOES. If the address already has a platform identity, accepting requires a
// SESSION for that person: otherwise anyone holding the link could set a password on somebody else's
// account and take it over. A new address takes a name and password and creates the account.

import { Router } from 'express';
import { badRequest, conflict, forbidden, notFound, unauthorized, withTransaction } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, optionalString, requiredEmail, requiredOneOf, requiredString } from '../api/validate.ts';
import { authOf, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { readToken, setSessionCookie, signSessionToken, ttlFor, verifySessionToken } from '../auth/sessionToken.ts';
import { checkPassword, firstPasswordProblem } from '../auth/password.ts';
import * as auth from '../repositories/auth.ts';
import * as memberships from '../repositories/memberships.ts';
import { GRANTABLE_ROLES } from '../repositories/memberships.ts';
import * as users from '../repositories/users.ts';

/** Mounted under /api/stores/:storeId/invites — the inviter's half. */
export const storeInvitesRouter = Router({ mergeParams: true });

/** Mounted under /api/invites — the invitee's half. Unauthenticated; the token is the credential. */
export const publicInvitesRouter = Router();

// ---------------------------------------------------------------------------
// The inviter
// ---------------------------------------------------------------------------

/** GET …/invites — what is outstanding, for the Settings → Staff panel. */
storeInvitesRouter.get(
  '/',
  requireStorePermission('staff.create'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const pending = await auth.listPendingInvites(storeId);
    res.json({
      invites: pending.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        name: i.invitee_name,
        createdAt: i.created_at,
        expiresAt: i.expires_at,
      })),
    });
  }),
);

/**
 * POST …/invites — invite somebody.
 *
 * Re-inviting the same address REVOKES AND REISSUES rather than adding a second invite, which V016's
 * partial unique index requires: two live invites for one address would let a later one with a different
 * role sit behind an earlier one and grant whichever link was clicked.
 */
storeInvitesRouter.post(
  '/',
  requireStorePermission('staff.create'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const body = bodyOf(req.body);

    const email = requiredEmail(body);
    const name = requiredString(body, 'name', { max: 120 });
    const role = requiredOneOf(body, 'role', GRANTABLE_ROLES);

    const created = await withTransaction(
      async (tx) => {
        // Already staff here? Then there is nothing to invite them to, and saying so is not a leak: the
        // inviter can already see this store's staff list.
        const existing = await users.findPlatformByEmail(email, tx);
        if (existing !== null) {
          const held = await memberships.find(storeId, existing.id, tx);
          if (held !== null) {
            throw conflict('That person is already a member of this store.', 'ALREADY_A_MEMBER');
          }
        }

        return auth.createInvite(
          storeId,
          { email, role, inviteeName: name, invitedBy: context.userId },
          tx,
        );
      },
      { label: 'POST /api/stores/:storeId/invites' },
    );

    // Delivery is milestone 28's (Messages). Logged until then, and never returned in the response: a
    // token in the body would let anybody who can invite also accept on the invitee's behalf.
    console.log(`[auth] invite for ${email} to store ${storeId}: token ${created.token}`);

    res.status(201).json({
      invite: { id: created.id, email, name, role, expiresAt: created.expiresAt },
    });
  }),
);

/** DELETE …/invites/:inviteId — withdraw one. Idempotent. */
storeInvitesRouter.delete(
  '/:inviteId',
  requireStorePermission('staff.create'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const inviteId = req.params['inviteId'];
    if (typeof inviteId !== 'string' || inviteId === '') {
      throw badRequest('That is not a valid invite id.', 'INVALID_INVITE_ID');
    }

    const revoked = await withTransaction((tx) => auth.revokeInvite(storeId, inviteId, tx), {
      label: 'DELETE /api/stores/:storeId/invites/:inviteId',
    });
    res.json({ revoked });
  }),
);

// ---------------------------------------------------------------------------
// The invitee
// ---------------------------------------------------------------------------

function tokenFrom(req: { params: Record<string, string | undefined> }): string {
  const token = req.params['token'];
  // Length only: the token is 32 random bytes base64url. A malformed one simply will not match, and
  // saying more would distinguish "wrong shape" from "no such invite".
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw notFound('That invitation link is not valid any more.', 'INVITE_NOT_FOUND');
  }
  return token;
}

/**
 * GET /api/invites/:token — what this invitation is.
 *
 * Unauthenticated, because the invitee has no account yet. It answers only what the acceptance screen
 * needs and what the invitee already knows: Auth renders "Join Nyama & Co. — Aline Uwase invited Patrick
 * Niyonzima as a Manager."
 *
 * `hasAccount` tells the client which of the two acceptance paths to draw — a password form, or a
 * prompt to sign in first.
 */
publicInvitesRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const invite = await auth.findLiveInvite(tokenFrom(req));
    if (invite === null) throw notFound('That invitation link has expired or been withdrawn.', 'INVITE_NOT_FOUND');

    const existing = await users.findPlatformByEmail(invite.email);

    res.json({
      invite: {
        store: { name: invite.store_name, slug: invite.store_slug },
        email: invite.email,
        name: invite.invitee_name,
        role: invite.role,
        invitedBy: invite.inviter_name,
        expiresAt: invite.expires_at,
      },
      hasAccount: existing !== null,
      // So the client renders the same checklist the server enforces.
      passwordRules: checkPassword('').map((rule) => rule.label),
    });
  }),
);

/**
 * POST /api/invites/:token/accept — join.
 *
 * ATOMIC: the identity, the membership and — for a rider — the profile carrying their plate commit
 * together, and the invite is claimed in the same transaction by a single-shot `WHERE accepted_at IS
 * NULL`, so two clicks on one link cannot both create a membership.
 *
 * SIGNS THEM IN on success, because the board's button reads "Join and sign in" and sending somebody to
 * a sign-in form immediately after they chose a password is a step for no reason.
 */
publicInvitesRouter.post(
  '/:token/accept',
  asyncHandler(async (req, res) => {
    const token = tokenFrom(req);
    const body = bodyOf(req.body);

    const outcome = await withTransaction(
      async (tx) => {
        const invite = await auth.findLiveInvite(token, tx);
        if (invite === null) {
          throw notFound('That invitation link has expired or been withdrawn.', 'INVITE_NOT_FOUND');
        }

        const existing = await users.findPlatformByEmail(invite.email, tx);

        let userId: string;
        let sessionVersion: number;
        let name: string;

        if (existing === null) {
          // A new person. Name and password are theirs to choose.
          const chosenName = optionalString(body, 'name', { max: 120 }) ?? invite.invitee_name;
          const password = requiredString(body, 'password', { max: 200 });
          const problem = firstPasswordProblem(password, {
            email: invite.email,
            storeName: invite.store_name,
            phone: optionalString(body, 'phone', { max: 40 }),
          });
          if (problem !== null) throw badRequest(problem, 'WEAK_PASSWORD');

          const created = await users.insertPlatformUser(tx, {
            email: invite.email,
            name: chosenName,
            phone: optionalString(body, 'phone', { max: 40 }),
            passwordHash: await users.hashPassword(password),
          });
          userId = created.id;
          name = created.name;
          sessionVersion = 1;
        } else {
          // AN EXISTING ACCOUNT MUST PROVE IT IS THEM. Without this, anybody holding the link could set
          // a password on an address that already has an account and take it over — which is precisely
          // the takeover milestone 11's 409 existed to avoid.
          const sessionToken = readToken(req);
          if (sessionToken === null || sessionToken === undefined || sessionToken === '') {
            throw unauthorized(
              'That email address already has a Vendlyfy account. Sign in first, then open this link again.',
              'INVITE_NEEDS_SIGN_IN',
            );
          }
          const claim = verifySessionToken(sessionToken);
          if (claim.userId !== existing.id) {
            throw forbidden(
              'This invitation is for a different account. Sign out and sign in as ' +
                `${invite.email}, then open the link again.`,
              'INVITE_WRONG_ACCOUNT',
            );
          }
          const current = await auth.sessionVersionOf(existing.id, tx);
          if (current === null || current !== claim.sessionVersion) {
            throw unauthorized('Please sign in again, then open this link.', 'SESSION_REVOKED');
          }
          userId = existing.id;
          name = existing.name;
          sessionVersion = current;
        }

        // The single-shot claim. If somebody else clicked first, nothing below runs.
        const claimed = await auth.claimInvite(invite.id, userId, tx);
        if (!claimed) {
          throw conflict('That invitation has already been used.', 'INVITE_ALREADY_USED');
        }

        await memberships.insert(
          invite.store_id,
          {
            userId,
            role: invite.role as (typeof GRANTABLE_ROLES)[number],
            // The inviter, from the invite, so the audit trail survives them accepting weeks later.
            createdBy: userId,
          },
          tx,
        );

        if (invite.role === 'rider') {
          const plate = optionalString(body, 'plateNumber', { max: 40 });
          if (plate === null) throw badRequest('A rider needs a plate number.', 'MISSING_FIELD');
          await memberships.insertRiderProfile(invite.store_id, { userId, plateNumber: plate }, tx);
        }

        return {
          userId,
          name,
          sessionVersion,
          store: { name: invite.store_name, slug: invite.store_slug },
          role: invite.role,
        };
      },
      { label: 'POST /api/invites/:token/accept' },
    );

    // "Join and sign in".
    const remembered = body['remember'] === true;
    setSessionCookie(
      res,
      signSessionToken(outcome.userId, {
        sessionVersion: outcome.sessionVersion,
        expiresInSeconds: ttlFor(remembered),
      }),
      { remembered },
    );

    res.json({
      next: 'ready',
      user: { id: outcome.userId, name: outcome.name },
      store: outcome.store,
      role: outcome.role,
    });
  }),
);
