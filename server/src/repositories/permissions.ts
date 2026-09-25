// server/src/repositories/permissions.ts — milestone 11.
//
// §5.4: "Permissions are data, not code branches. Auth's invite screen renders a
// role's permissions in prose, and AdminTeam is an entire board about roles. Both
// need a role_permissions mapping to read from — the same discipline as the config
// engine. A component asks whether a role may do something; it never contains the
// list."
//
// So this file has no list in it. It reads rows.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import type { RolePermissionsScope } from '../db/rows.ts';

export type RolePermissions = {
  scope: RolePermissionsScope;
  role: string;
  permissions: string[];
};

/**
 * Every role and what it may do, for Auth's invite screen and AdminTeam.
 *
 * `customer` comes back with an empty list, which is correct and deliberate: V001
 * lists it as a store role with no permission rows because "a customer's
 * capabilities are not console permissions. A lookup for it correctly returns
 * nothing." A caller that treats an empty list as "role not found" would be wrong,
 * which is why this reads from the CHECK constraint's role list rather than from the
 * permission rows — a role with no permissions still has to appear.
 */
export async function listAll(on: Queryable = db): Promise<RolePermissions[]> {
  const { rows } = await on.query<RolePermissions>(
    `SELECT scope, role, array_agg(permission ORDER BY permission) AS permissions
       FROM role_permissions
      GROUP BY scope, role
      ORDER BY scope, role`,
  );
  return rows;
}

/** What one role may do. An unknown role and a role with no permissions both give []. */
export async function forRole(
  scope: RolePermissionsScope,
  role: string,
  on: Queryable = db,
): Promise<string[]> {
  const { rows } = await on.query<{ permission: string }>(
    `SELECT permission
       FROM role_permissions
      WHERE scope = $1 AND role = $2
      ORDER BY permission`,
    [scope, role],
  );
  return rows.map((r) => r.permission);
}
