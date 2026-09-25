// server/src/routes/members.ts — milestone 11.
//
// §5.4's delegated creation, "enforced server-side". The rules, verbatim from the plan,
// "and they are authorization checks on the endpoint, not UI affordances":
//
//   * A store admin may create members only in a store where they hold owner/admin.
//   * A store admin may grant only store roles, never a platform role.
//   * A manager may create nobody.
//   * Only super_admin creates stores and platform team members.
//
// HOW EACH ONE IS ENFORCED HERE:
//
//   1st — requireStorePermission('staff.create') on the store named in the PATH. Only
//         owner and admin hold staff.create in V001's rows, and the membership is
//         looked up for that store, so an admin of another store holds nothing here.
//         (§5.4's second escalation test.)
//   2nd — the role must be one of GRANTABLE_ROLES. A platform role is not merely
//         absent from that list: it lives in a DIFFERENT TABLE, which nothing in this
//         file writes. V001 chose two tables for exactly this, so granting a platform
//         role is "a different write, not a different string".
//         (§5.4's first escalation test.)
//   3rd — manager holds no staff.create row, so the same guard refuses them.
//   4th — creating stores and platform members is not in this file at all. It is
//         /api/admin/* with platform permissions, milestone 27.
//
// AN EXISTING ACCOUNT IS NOT ATTACHED, IT IS REFUSED. One person holding two roles at
// two stores is the case §5.4 needs and V001 supports — but silently attaching an
// existing Vendlyfy identity to your store on nothing but their email address would
// hand you their real name and phone number from the staff list, and give them a store
// they never agreed to work at. That is what Auth's INVITE screen is for, and the
// invite is milestone 15. Until then this endpoint creates new accounts only and says
// so, which is a smaller thing that is wholly true rather than a larger one that leaks.

import { Router } from 'express';
import { badRequest, conflict, withTransaction } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, optionalString, requiredEmail, requiredOneOf, requiredString } from '../api/validate.ts';
import { authOf, isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import * as memberships from '../repositories/memberships.ts';
import * as users from '../repositories/users.ts';
import { GRANTABLE_ROLES } from '../repositories/memberships.ts';

const router = Router({ mergeParams: true });

/**
 * A floor, not a policy. Milestone 15 owns the password rules, and its invite flow will
 * have the person choose their own rather than an admin typing one for them. The legacy
 * endpoint allowed six characters; a staff account can read a store's entire order and
 * customer history, so ten is the lowest this will accept in the meantime.
 */
const MIN_PASSWORD = 10;

/** GET /api/stores/:storeId/members — the Settings → Staff panel's list. */
router.get(
  '/',
  requireStorePermission('staff.create'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    res.json({ members: await memberships.listForStore(storeId) });
  }),
);

/**
 * POST /api/stores/:storeId/members — create a manager, rider or another admin.
 *
 * ATOMIC. The identity, the membership and — for a rider — the profile carrying their
 * plate are one transaction. A staff row with no membership would be an account that
 * cannot sign in anywhere; a rider with no profile cannot be assigned an order. Either
 * halfway state is a support ticket, so neither is reachable.
 *
 * IDEMPOTENT FOR A REPLAY, and only for a replay. A double-submitted form finds the
 * membership this same caller already created with this same role and returns it with
 * `created: false`. Anything else about an existing email is a 409: a replay is a
 * request that already succeeded, not any request that collides with one.
 */
router.post(
  '/',
  requireStorePermission('staff.create'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const body = bodyOf(req.body);

    const name = requiredString(body, 'name', { max: 120 });
    const email = requiredEmail(body);
    const password = requiredString(body, 'password', { min: MIN_PASSWORD, max: 200 });
    const role = requiredOneOf(body, 'role', GRANTABLE_ROLES);
    const phone = optionalString(body, 'phone', { max: 40 });
    const plateNumber = optionalString(body, 'plateNumber', { max: 40 });

    // A rider without a plate cannot be put on the roster: rider_profiles.plate_number
    // is NOT NULL and the Orders board's rider picker reads it. Asked for here rather
    // than discovered as a constraint violation.
    if (role === 'rider' && plateNumber === null) {
      throw badRequest('A rider needs a plate number.', 'MISSING_FIELD');
    }
    if (role !== 'rider' && plateNumber !== null) {
      throw badRequest('Only a rider has a plate number.', 'INVALID');
    }

    const result = await withTransaction(async (tx) => {
      const existing = await users.findPlatformByEmail(email, tx);

      if (existing !== null) {
        const held = await memberships.find(storeId, existing.id, tx);

        // The replay: same store, same role, created by the same person. Returning it
        // is the truthful answer to "did my request go through" — yes, once.
        if (held !== null && held.role === role && held.created_by === context.userId) {
          return {
            created: false as const,
            userId: existing.id,
            name: existing.name,
            email: existing.email,
            role: held.role,
            createdAt: held.created_at,
          };
        }

        if (held !== null) {
          throw conflict('That person is already a member of this store.', 'ALREADY_A_MEMBER');
        }

        // Deliberately says nothing about who they are — not their name, not which
        // stores they work at. See the note at the head of this file.
        throw conflict(
          'That email address already has a Vendlyfy account. Invite them instead of creating a new one.',
          'ACCOUNT_EXISTS',
        );
      }

      const passwordHash = await users.hashPassword(password);
      const created = await users.insertPlatformUser(tx, { email, name, phone, passwordHash });
      const membership = await memberships.insert(
        storeId,
        { userId: created.id, role, createdBy: context.userId },
        tx,
      );

      if (role === 'rider' && plateNumber !== null) {
        await memberships.insertRiderProfile(storeId, { userId: created.id, plateNumber }, tx);
      }

      return {
        created: true as const,
        userId: created.id,
        name: created.name,
        email: created.email,
        role: membership.role,
        createdAt: membership.created_at,
      };
    }, { label: 'POST /api/stores/:storeId/members' });

    res.status(result.created ? 201 : 200).json({
      created: result.created,
      member: {
        userId: result.userId,
        name: result.name,
        email: result.email,
        role: result.role,
        createdAt: result.createdAt,
      },
    });
  }),
);

/**
 * DELETE /api/stores/:storeId/members/:userId — revoke a membership.
 *
 * §5.4's fourth escalation test is about what happens next: the removed person's very
 * next request is denied, because the guard re-reads memberships rather than trusting
 * their token.
 *
 * Two refusals of its own, and one from the database:
 *   * an OWNER cannot be revoked here. Every store has one and losing the last would
 *     leave a store nobody can administer; handing ownership to someone else is a
 *     transfer, and it lands with Settings → Staff at milestone 25.
 *   * YOU cannot revoke yourself. The sole admin of a store would lock themselves out
 *     of their own money, and it reads as a misclick rather than an intention.
 *   * a RIDER WITH AN ORDER ASSIGNED is refused by the composite foreign key on
 *     orders, ON DELETE RESTRICT — an order may not be orphaned of its rider. It
 *     arrives as 409 IN_USE through db/errors.ts.
 */
router.delete(
  '/:userId',
  requireStorePermission('staff.create'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const userId = req.params['userId'];

    if (!isUuid(userId)) throw badRequest('That is not a valid person id.', 'INVALID_USER_ID');

    if (userId === context.userId) {
      throw conflict('You cannot remove your own access.', 'CANNOT_REMOVE_SELF');
    }

    const removedRole = await withTransaction(async (tx) => {
      const held = await memberships.find(storeId, userId, tx);

      // Already gone. A repeat of a delete that worked is not an error — and it is how
      // a client retrying a timed-out request finds out it succeeded.
      if (held === null) return null;

      if (held.role === 'owner') {
        throw conflict(
          "A store owner's access cannot be removed here. Transfer ownership first.",
          'OWNER_NOT_REMOVABLE',
        );
      }

      return memberships.remove(storeId, userId, tx);
    }, { label: 'DELETE /api/stores/:storeId/members/:userId' });

    res.json({ removed: removedRole !== null, role: removedRole });
  }),
);

export default router;
