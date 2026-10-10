// server/src/repositories/adminTeam.ts — milestone 27, part C: AdminTeam. Who at Vendlyfy can open this console, and as what.
//
// THE FIRST PLACE THE APPLICATION EVER WRITES platform_members. V001 split the platform team into its own table "so that granting a
// platform role is a different write, not a different string" and its first escalation test is that no store endpoint can do it —
// that still holds, because these writes are reachable only behind platform_members.create, which only super_admin holds (V032).
//
// A TEAM MEMBER IS CREATED, NOT INVITED. The board's "Invite teammate" sends an email with a link; there is no email service in the
// new server (milestone 28) and Auth's invite flow is for STORE staff. So this works the way the merchant console's Staff panel
// does: a super admin creates the account with a starting password and hands it over. Two-step sign-in is not a setting — every
// platform sign-in asks for a code (routes/session.ts) — so the board's "2-step: On · app" column is a fact about the whole team, said
// once in the header, rather than a per-person state that could not differ.
//
// THE TEAM CANNOT LOCK ITSELF OUT: nobody can change their own role or remove themselves, and the last super admin can be neither
// demoted nor removed — not by anyone, including themselves. Both are refused with the sentence for why.

import { badRequest, conflict, db, notFound, withTransaction } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';
import * as auth from './auth.ts';
import * as users from './users.ts';

export const TEAM_ROLES = ['super_admin', 'support', 'finance', 'verification'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const ROLE_LABEL: Record<TeamRole, string> = { super_admin: 'Super admin', support: 'Support', finance: 'Finance', verification: 'Verification' };

type Actor = { id: string; ip: string | null; userAgent: string | null };

export type Member = { userId: string; name: string; email: string; role: TeamRole; joinedAt: string; addedBy: string | null };

/** The board's matrix rows, each defined by the permissions that make it true. A role has a row only if it holds ALL of them. */
export const MATRIX: readonly { label: string; needs: readonly string[] }[] = [
  { label: 'See stores, orders and customers', needs: ['merchants.read'] },
  { label: 'Approve or reject identity checks, and reveal full ID numbers (logged)', needs: ['kyc.review'] },
  { label: 'Decide refunds and disputes', needs: ['refunds.approve', 'disputes.resolve'] },
  { label: 'Retry failed payouts', needs: ['payouts.process'] },
  { label: 'Suspend or reinstate stores', needs: ['stores.suspend'] },
  { label: 'Change plans and fees', needs: ['plans.manage'] },
  { label: 'Change payment methods and currencies', needs: ['payment_methods.manage', 'currencies.manage'] },
  { label: 'Edit industry templates', needs: ['templates.manage'] },
  { label: 'Change platform settings', needs: ['platform_settings.manage'] },
  { label: 'Read the audit log', needs: ['audit.read'] },
  { label: 'Manage the admin team', needs: ['platform_members.create'] },
];

export async function team(on: Queryable = db): Promise<{ members: Member[]; roles: TeamRole[]; matrix: { label: string; roles: Record<TeamRole, boolean> }[] }> {
  const m = await on.query<{ user_id: string; name: string; email: string; role: TeamRole; created_at: Date; by: string | null }>(
    `SELECT pm.user_id, u.name, u.email, pm.role, pm.created_at, b.name AS by
       FROM platform_members pm JOIN users u ON u.id = pm.user_id LEFT JOIN users b ON b.id = pm.created_by
      ORDER BY (pm.role = 'super_admin') DESC, pm.created_at, u.name`,
  );
  const p = await on.query<{ role: string; permission: string }>(`SELECT role, permission FROM role_permissions WHERE scope = 'platform'`);
  const held = new Map<string, Set<string>>();
  for (const r of p.rows) held.set(r.role, (held.get(r.role) ?? new Set()).add(r.permission));
  return {
    members: m.rows.map((x) => ({ userId: x.user_id, name: x.name, email: x.email, role: x.role, joinedAt: x.created_at.toISOString(), addedBy: x.by })),
    roles: [...TEAM_ROLES],
    matrix: MATRIX.map((row) => ({ label: row.label, roles: Object.fromEntries(TEAM_ROLES.map((r) => [r, row.needs.every((n) => held.get(r)?.has(n) === true)])) as Record<TeamRole, boolean> })),
  };
}

const isRole = (v: unknown): v is TeamRole => typeof v === 'string' && (TEAM_ROLES as readonly string[]).includes(v);

async function audit(tx: Tx, a: Actor, action: string, summary: string, subject: string, detail: string | null): Promise<void> {
  await tx.query(`SELECT audit('access', $1, $2, $3, NULL, $4, 'user', $5, $6::inet, $7)`, [action, summary, a.id, detail, subject, a.ip, a.userAgent]);
}

export async function add(input: { name: string; email: string; role: string; password: string }, a: Actor): Promise<Member> {
  if (!isRole(input.role)) throw badRequest('Choose a role from the list.', 'INVALID_ROLE');
  if (input.password.length < 10) throw badRequest('The starting password is at least 10 characters.', 'WEAK_PASSWORD');
  const passwordHash = await users.hashPassword(input.password);
  const role = input.role;
  return withTransaction(
    async (tx) => {
      const taken = await tx.query(`SELECT 1 FROM users WHERE scope = 'platform' AND lower(email) = lower($1)`, [input.email]);
      if ((taken.rowCount ?? 0) > 0) throw conflict('That email already has an account. A merchant’s email can’t also be on the team; use another address.', 'EMAIL_TAKEN');
      const u = await users.insertPlatformUser(tx, { email: input.email, name: input.name, phone: null, passwordHash });
      await tx.query(`INSERT INTO platform_members (user_id, role, created_by) VALUES ($1, $2, $3)`, [u.id, role, a.id]);
      await audit(tx, a, 'add_team_member', `Added ${input.name} to the team · ${ROLE_LABEL[role]}`, u.id, null);
      return { userId: u.id, name: input.name, email: input.email, role, joinedAt: new Date().toISOString(), addedBy: null };
    },
    { label: 'POST /admin/team', retries: 0 },
  );
}

async function lockedMember(tx: Tx, userId: string): Promise<{ role: TeamRole; name: string; supers: number }> {
  const row = (await tx.query<{ role: TeamRole; name: string }>(
    `SELECT pm.role, u.name FROM platform_members pm JOIN users u ON u.id = pm.user_id WHERE pm.user_id = $1 FOR UPDATE OF pm`, [userId],
  )).rows[0];
  if (row === undefined) throw notFound('That person is not on the team.', 'NOT_ON_TEAM');
  // Locked rows first, count second, in the same transaction: two admins demoting the last two super admins at once cannot both pass.
  await tx.query(`SELECT 1 FROM platform_members WHERE role = 'super_admin' FOR UPDATE`);
  const supers = Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM platform_members WHERE role = 'super_admin'`)).rows[0]!.n);
  return { ...row, supers };
}

export async function setRole(userId: string, role: string, a: Actor): Promise<void> {
  if (!isRole(role)) throw badRequest('Choose a role from the list.', 'INVALID_ROLE');
  if (userId === a.id) throw conflict('You can’t change your own role. Ask another super admin.', 'OWN_ROLE');
  await withTransaction(
    async (tx) => {
      const m = await lockedMember(tx, userId);
      if (m.role === role) throw conflict(`${m.name} is already ${ROLE_LABEL[role]}.`, 'NO_CHANGE');
      if (m.role === 'super_admin' && m.supers <= 1) throw conflict('There has to be at least one super admin.', 'LAST_SUPER_ADMIN');
      await tx.query(`UPDATE platform_members SET role = $2 WHERE user_id = $1`, [userId, role]);
      await audit(tx, a, 'change_team_role', `Changed ${m.name}: ${ROLE_LABEL[m.role]} → ${ROLE_LABEL[role]}`, userId, null);
    },
    { label: 'PUT /admin/team/role', retries: 0 },
  );
}

export async function remove(userId: string, a: Actor): Promise<void> {
  if (userId === a.id) throw conflict('You can’t remove yourself. Ask another super admin.', 'OWN_ROLE');
  await withTransaction(
    async (tx) => {
      const m = await lockedMember(tx, userId);
      if (m.role === 'super_admin' && m.supers <= 1) throw conflict('There has to be at least one super admin.', 'LAST_SUPER_ADMIN');
      await tx.query(`DELETE FROM platform_members WHERE user_id = $1`, [userId]);
      // The account stays (its past actions are in the log under its name) but signs out everywhere and holds no permission.
      await auth.revokeAllSessions(userId, tx);
      await audit(tx, a, 'remove_team_member', `Removed ${m.name} from the team`, userId, null);
    },
    { label: 'DELETE /admin/team', retries: 0 },
  );
}
