// server/src/repositories/memberships.ts — milestone 11.
//
// store_members and platform_members. §5.4's delegated creation is an authorization
// rule enforced at the endpoint; this file is the data underneath it, and it is
// deliberately unopinionated about who may call it — an authorization check buried in
// a repository is a check the next caller does not know is there.
//
// ONE THING IS ENFORCED HERE, because it is not a policy but an invariant: the roles
// this repository will insert are ('admin', 'manager', 'rider'). `owner` is excluded.
// store_members.role permits it, and it must — every store has one — but granting
// ownership is a transfer, not a create: it decides who keeps the store if the current
// owner leaves. It lands with Settings → Staff at milestone 25 as its own operation.
// Refusing it here means the widest thing POST /members can do is create another admin,
// which is what §5.4 says a store admin may do.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import type { StoreMembersRole } from '../db/rows.ts';

/** The roles POST /api/stores/:storeId/members may grant. See the note above about `owner`. */
export const GRANTABLE_ROLES = ['admin', 'manager', 'rider'] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export function isGrantableRole(value: unknown): value is GrantableRole {
  return typeof value === 'string' && (GRANTABLE_ROLES as readonly string[]).includes(value);
}

/** One of a person's memberships, with enough of the store to render Auth's picker. */
export type MembershipOfUser = {
  store_id: string;
  store_slug: string;
  store_name: string;
  store_status: string;
  role: StoreMembersRole;
};

/** One of a store's members, for the Settings → Staff panel. */
export type MemberOfStore = {
  user_id: string;
  name: string;
  email: string;
  phone: string | null;
  role: StoreMembersRole;
  created_at: Date;
  created_by: string | null;
  /** Present only for a rider, which is the one role with a profile. */
  plate_number: string | null;
  availability: string | null;
};

/**
 * Every store this person is staff at.
 *
 * Serves Auth's store picker, which §5.4 describes: "requires one person to be Owner
 * at Nyama & Co. AND Manager at Inzu Threads". Uses store_members_pkey, which leads
 * with user_id for exactly this direction.
 *
 * Suspended stores are RETURNED, not filtered. A merchant whose store was suspended
 * must still be able to sign in and see why; hiding the store would make it look
 * deleted. Whether a suspended store's screens are usable is the route's decision.
 */
export async function listForUser(userId: string, on: Queryable = db): Promise<MembershipOfUser[]> {
  const { rows } = await on.query<MembershipOfUser>(
    `SELECT sm.store_id,
            s.slug   AS store_slug,
            s.name   AS store_name,
            s.status AS store_status,
            sm.role
       FROM store_members sm
       JOIN stores s ON s.id = sm.store_id
      WHERE sm.user_id = $1
      ORDER BY s.name`,
    [userId],
  );
  return rows;
}

/** The role this person holds in this store, or null. */
export async function findRole(
  storeId: string,
  userId: string,
  on: Queryable = db,
): Promise<StoreMembersRole | null> {
  const { rows } = await on.query<{ role: StoreMembersRole }>(
    `SELECT role FROM store_members WHERE store_id = $1 AND user_id = $2`,
    [storeId, userId],
  );
  return rows[0]?.role ?? null;
}

/**
 * One membership, in full. `created_by` is what makes a retried create distinguishable
 * from somebody else's row: the endpoint replays only a request whose membership this
 * same caller created.
 */
export async function find(
  storeId: string,
  userId: string,
  on: Queryable = db,
): Promise<{ user_id: string; role: StoreMembersRole; created_by: string | null; created_at: Date } | null> {
  const { rows } = await on.query<{
    user_id: string;
    role: StoreMembersRole;
    created_by: string | null;
    created_at: Date;
  }>(
    `SELECT user_id, role, created_by, created_at
       FROM store_members
      WHERE store_id = $1 AND user_id = $2`,
    [storeId, userId],
  );
  return rows[0] ?? null;
}

/**
 * A store's staff. Uses store_members_store_role_idx, which V001 added leading with
 * store_id precisely because the primary key already serves the other direction.
 *
 * The LEFT JOIN to rider_profiles is not an N+1 avoided by accident: the Staff panel
 * shows a rider's plate beside their name, and the profile exists for riders only, so
 * a join that dropped non-riders would hide every manager.
 */
export async function listForStore(storeId: string, on: Queryable = db): Promise<MemberOfStore[]> {
  const { rows } = await on.query<MemberOfStore>(
    `SELECT sm.user_id,
            u.name,
            u.email,
            u.phone,
            sm.role,
            sm.created_at,
            sm.created_by,
            rp.plate_number,
            rp.availability
       FROM store_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN rider_profiles rp
              ON rp.user_id = sm.user_id
             AND rp.store_id = sm.store_id
      WHERE sm.store_id = $1
      ORDER BY CASE sm.role
                   WHEN 'owner'   THEN 0
                   WHEN 'admin'   THEN 1
                   WHEN 'manager' THEN 2
                   ELSE 3
               END,
               u.name`,
    [storeId],
  );
  return rows;
}

/**
 * Grants a membership.
 *
 * `created_by` is not bookkeeping. V001: "§5.4's delegated creation is an
 * authorization rule, and a rule without a record of its use cannot be reviewed
 * after the fact."
 *
 * The composite foreign key on (user_id, user_scope) refuses a store-scoped customer
 * here, declaratively — so this cannot be the place a customer acquires staff
 * privileges even if a caller passed one.
 */
export async function insert(
  storeId: string,
  input: { userId: string; role: GrantableRole; createdBy: string },
  tx: Queryable,
): Promise<{ user_id: string; store_id: string; role: StoreMembersRole; created_at: Date }> {
  const { rows } = await tx.query<{ user_id: string; store_id: string; role: StoreMembersRole; created_at: Date }>(
    `INSERT INTO store_members (user_id, store_id, role, created_by)
          VALUES ($2, $1, $3, $4)
       RETURNING user_id, store_id, role, created_at`,
    [storeId, input.userId, input.role, input.createdBy],
  );
  const created = rows[0];
  if (created === undefined) throw new Error('INSERT INTO store_members returned no row');
  return created;
}

/**
 * A rider's profile: the plate a manager reads off the roster.
 *
 * `member_role` is left to its DEFAULT of 'rider' rather than passed in. The composite
 * foreign key on (user_id, store_id, member_role) → store_members (user_id, store_id,
 * role) is what proves this person is a rider OF THIS STORE, and a caller that could
 * supply the role could supply a different one.
 *
 * Requires a transaction: on its own it would be a profile for a membership that might
 * not have committed.
 */
export async function insertRiderProfile(
  storeId: string,
  input: { userId: string; plateNumber: string },
  tx: Queryable,
): Promise<void> {
  await tx.query(
    `INSERT INTO rider_profiles (user_id, store_id, plate_number) VALUES ($2, $1, $3)`,
    [storeId, input.userId, input.plateNumber],
  );
}

/**
 * Revokes a membership. Returns the role that was removed, or null if there was none
 * — so the caller can answer a repeat of the same request the same way rather than
 * inventing a 404 for something already true.
 *
 * WHAT THE DATABASE MAY REFUSE, and both refusals are correct:
 *   * a rider with an order assigned — orders' composite FK to
 *     store_members (user_id, store_id, role) is ON DELETE RESTRICT, so an order
 *     cannot be orphaned of its rider. Surfaced as 409 by db/errors.ts.
 *   * nothing else. rider_profiles CASCADEs, which is right: a profile describes
 *     someone as a rider of this store, and they are no longer one.
 */
export async function remove(
  storeId: string,
  userId: string,
  tx: Queryable,
): Promise<StoreMembersRole | null> {
  const { rows } = await tx.query<{ role: StoreMembersRole }>(
    `DELETE FROM store_members
           WHERE store_id = $1 AND user_id = $2
       RETURNING role`,
    [storeId, userId],
  );
  return rows[0]?.role ?? null;
}

/** How many people hold a given role in a store. Used to refuse removing the last owner. */
export async function countRole(
  storeId: string,
  role: StoreMembersRole,
  on: Queryable = db,
): Promise<number> {
  const { rows } = await on.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM store_members WHERE store_id = $1 AND role = $2`,
    [storeId, role],
  );
  // count() is bigint, which node-postgres returns as a string. Cast in SQL rather
  // than trusting the driver, then parse once, here.
  return Number(rows[0]?.n ?? '0');
}

/** The Vendlyfy team role this person holds, or null. */
export async function findPlatformRole(userId: string, on: Queryable = db): Promise<string | null> {
  const { rows } = await on.query<{ role: string }>(
    `SELECT role FROM platform_members WHERE user_id = $1`,
    [userId],
  );
  return rows[0]?.role ?? null;
}
