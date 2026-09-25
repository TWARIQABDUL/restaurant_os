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
import { readConsistent } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { authOf, requireSession } from '../middleware/authorize.ts';
import * as memberships from '../repositories/memberships.ts';
import * as permissions from '../repositories/permissions.ts';

const router = Router();

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

export default router;
