// server/src/repositories/authContext.ts — milestone 11.
//
// The per-request identity read. §5.4: "The per-request DB re-read stays — it is
// what makes a revoked role take effect immediately, and that property is worth
// keeping." This is that read, and it is ONE round trip: identity, the role held
// in the store the request names, the platform role, and the permission set those
// roles add up to.
//
// Nothing here comes from the token. A token that carried a role would make the
// fourth escalation test — "revoking a membership denies the next request, not the
// next login" — impossible to pass, because the revoked role would keep arriving
// with every request until the token expired. The token says who; the database says
// what they may do.
//
// WHY THERE IS NO super_admin BYPASS. The old guard exempted super_admin from the
// tenant check because routes scoped on req.tenant.id and there was nothing else to
// scope by. V001 chose differently and said so: super_admin's permissions are
// "listed explicitly rather than as a wildcard, so that 'what can the platform team
// do' is answerable by reading rows instead of by reading code". Its rows are
// platform permissions — stores.suspend, kyc.review, payouts.process, audit.read —
// and a merchant-console route asks for a STORE permission. So a platform admin gets
// 403 from GET /api/stores/:id/wallet, and reaches the same store's money through
// /api/admin/* with payouts.process. That is deliberate: the platform's view of a
// store is its own endpoint with its own audit trail, not the merchant's endpoint
// borrowed.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import type { PlatformMembersRole, StoreMembersRole, UsersScope } from '../db/rows.ts';

export type AuthContext = {
  userId: string;
  scope: UsersScope;
  /** The store a customer belongs to. NULL for staff and the platform team. */
  customerStoreId: string | null;
  email: string;
  name: string;
  phone: string | null;
  /** The role held in the store this request named, or null — including when it named none. */
  storeRole: StoreMembersRole | null;
  platformRole: PlatformMembersRole | null;
  permissions: readonly string[];
  /** users.session_version, which the guard compares against the token's. See V016. */
  sessionVersion: number;
};

type AuthContextRow = {
  id: string;
  scope: UsersScope;
  store_id: string | null;
  email: string;
  name: string;
  phone: string | null;
  store_role: StoreMembersRole | null;
  platform_role: PlatformMembersRole | null;
  permissions: string[];
  session_version: number;
};

// $2 is the store the request named, or NULL when it named none.
//
// `sm.store_id = $2::uuid` with a NULL $2 matches NOTHING, which is the wanted
// answer and not an accident: no store named means no store role, means no store
// permissions. It is written as an equality rather than IS NOT DISTINCT FROM
// precisely so that it cannot match a row — store_members.store_id is NOT NULL, but
// if it ever were not, IS NOT DISTINCT FROM would hand a request with no store the
// membership of a store with none.
const LOAD = `
    WITH me AS (
        SELECT id, scope, store_id, email, name, phone, session_version
          FROM users
         WHERE id = $1
    ),
    store_role AS (
        SELECT sm.role
          FROM store_members sm
         WHERE sm.user_id = $1
           AND sm.store_id = $2::uuid
    ),
    platform_role AS (
        SELECT pm.role
          FROM platform_members pm
         WHERE pm.user_id = $1
    ),
    perms AS (
        SELECT rp.permission
          FROM role_permissions rp
          JOIN platform_role r ON r.role = rp.role
         WHERE rp.scope = 'platform'
        UNION
        SELECT rp.permission
          FROM role_permissions rp
          JOIN store_role r ON r.role = rp.role
         WHERE rp.scope = 'store'
    )
    SELECT me.id,
           me.scope,
           me.store_id,
           me.email,
           me.name,
           me.phone,
           me.session_version,
           (SELECT role FROM store_role)    AS store_role,
           (SELECT role FROM platform_role) AS platform_role,
           COALESCE(
               (SELECT array_agg(permission ORDER BY permission) FROM perms),
               ARRAY[]::text[]
           ) AS permissions
      FROM me
`;

/**
 * Loads the caller's identity and effective permissions.
 *
 * `storeId` is the store the request named — from the path, never from a header or
 * a body — or null for a route that names none. Returns null when the user row is
 * gone, which is a 401: the token outlived the account.
 */
export async function loadAuthContext(
  storeId: string | null,
  userId: string,
  on: Queryable = db,
): Promise<AuthContext | null> {
  const { rows } = await on.query<AuthContextRow>(LOAD, [userId, storeId]);
  const row = rows[0];
  if (row === undefined) return null;

  return {
    userId: row.id,
    scope: row.scope,
    customerStoreId: row.store_id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    storeRole: row.store_role,
    platformRole: row.platform_role,
    permissions: row.permissions,
    sessionVersion: row.session_version,
  };
}
