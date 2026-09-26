// server/src/repositories/auth.ts — milestone 15.
//
// Signing in, and the three flows around it: the 2-step code, the reset code, the staff invite.
//
// THE CANDIDATE LOOKUP IS THE LEGACY SERVER'S, and its reasoning is carried across verbatim because it
// was learned the hard way. server/src/routes/auth.js:
//
//   "Authentication resolves an identity. It must not depend on ambient state — a slug remembered from
//    browsing some other storefront, a cached user, a hardcoded default. Any of those can name the
//    wrong store, and a lookup filtered by the wrong store rejects a correct password.
//
//    So the email is looked up across the platform and the PASSWORD decides which account it is. A
//    store, when one is named, is only a preference for disambiguating between several matches — never
//    a filter that can exclude the right account."
//
// §5.4 says why that matters here: "the reason it exists is that scoping the sign-in lookup wrongly
// once locked real users out of production."
//
// THE IDENTIFIER MAY BE A PHONE. Auth's rider signs in as "078 455 9012". Neither email nor phone is
// unique across the platform — V001's uniqueness is per scope — so both are candidate lookups and the
// password disambiguates, exactly as for email.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import type { StoreMembersRole, UsersScope } from '../db/rows.ts';

/**
 * How many rows one identifier may turn into bcrypt work.
 *
 * The legacy server's bound, and its reason: "so one address cannot turn a single attempt into
 * unbounded bcrypt work". bcrypt at cost 12 is ~250 ms; ten is a quarter of a second, a thousand is a
 * denial of service that needs one valid-looking email.
 */
export const MAX_LOGIN_CANDIDATES = 10;

/**
 * A bcrypt hash of a value nobody knows, compared against when there is no candidate.
 *
 * The legacy server's again: "Always spend one comparison, against a fixed hash when there is no
 * candidate, so a miss costs what a wrong password costs and timing does not reveal which addresses
 * are registered." Generated at cost 12 to match users.password_hash.
 */
export const DUMMY_PASSWORD_HASH = '$2a$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export type Candidate = {
  id: string;
  scope: UsersScope;
  store_id: string | null;
  email: string;
  name: string;
  phone: string | null;
  password_hash: string;
  session_version: number;
  /** The most privileged role this person holds anywhere, for disambiguating. See rank() below. */
  best_role: string | null;
};

/**
 * Every account an identifier could name.
 *
 * Matches on email OR phone. Uses users_email_idx for the email arm — V001 added that non-unique
 * index precisely because "sign-in from the global page names no store and so cannot use either
 * partial index; Postgres only uses a partial index when the query implies its predicate".
 *
 * `best_role` comes from the membership tables so the caller can disambiguate without a second query.
 */
export async function findLoginCandidates(identifier: string, on: Queryable = db): Promise<Candidate[]> {
  const { rows } = await on.query<Candidate>(
    `SELECT u.id, u.scope, u.store_id, u.email, u.name, u.phone,
            u.password_hash, u.session_version,
            COALESCE(
                (SELECT pm.role FROM platform_members pm WHERE pm.user_id = u.id),
                (SELECT sm.role FROM store_members sm
                  WHERE sm.user_id = u.id
                  ORDER BY CASE sm.role
                               WHEN 'owner'   THEN 0
                               WHEN 'admin'   THEN 1
                               WHEN 'manager' THEN 2
                               ELSE 3
                           END
                  LIMIT 1)
            ) AS best_role
       FROM users u
      -- ONE WHERE WITH AN OR, and that is the measured choice rather than the obvious one. An earlier
      -- version split this into two UNIONed arms on the theory that a planner facing an OR across two
      -- different expressions reaches for a sequential scan. Measured on 120,000 users, it does not:
      -- Postgres builds a BitmapOr across users_email_idx and users_phone_digits_idx and the OR form is
      -- both simpler and FASTER — 0.041 ms reading 7 buffers, against 0.124 ms reading 20 for the
      -- UNION. What mattered was V017's index, not the shape of the clause.
      WHERE lower(u.email) = lower($1)
         OR (u.phone IS NOT NULL AND digits($1) <> '' AND digits(u.phone) = digits($1))
      LIMIT $2`,
    [identifier, MAX_LOGIN_CANDIDATES],
  );
  return rows;
}

/**
 * Rank for disambiguating several accounts that share an identifier AND a password.
 *
 * The legacy server's order and its reason: "Most privileged first: someone signing in to run a store
 * is the common case, and a customer account is the one you would rather land on by accident than the
 * reverse." A customer has no membership at all, so `best_role` is null for them.
 */
export function rank(candidate: Candidate): number {
  const order: Readonly<Record<string, number>> = {
    super_admin: 0,
    owner: 1,
    admin: 2,
    manager: 3,
    rider: 4,
  };
  return candidate.best_role === null ? 99 : (order[candidate.best_role] ?? 98);
}

/** Every store this person is staff at, for Auth's picker. Re-exported shape of memberships.listForUser. */
export type SignedInMembership = {
  store_id: string;
  store_slug: string;
  store_name: string;
  role: StoreMembersRole;
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Bumps session_version, signing out every device.
 *
 * Returns the new version so the caller can immediately issue a fresh cookie — which is what makes
 * Auth's wording exact: "This signs you out on every OTHER device."
 */
export async function revokeAllSessions(userId: string, tx: Queryable): Promise<number> {
  const { rows } = await tx.query<{ session_version: number }>(
    `UPDATE users SET session_version = session_version + 1
           WHERE id = $1
       RETURNING session_version`,
    [userId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`user ${userId} disappeared while revoking sessions`);
  return row.session_version;
}

/** users.session_version for one person — the two-step flow knows only an id. */
export async function sessionVersionOf(userId: string, on: Queryable = db): Promise<number | null> {
  const { rows } = await on.query<{ session_version: number }>(
    `SELECT session_version FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.session_version ?? null;
}

// setPassword lives in repositories/users.ts — passwords are identity, not session state.

// ---------------------------------------------------------------------------
// auth_codes — the 2-step code and the reset code
// ---------------------------------------------------------------------------

export type CodePurpose = 'platform_two_step' | 'password_reset';

/** How long a code lives. Short, because it is six digits. */
const CODE_TTL_MINUTES = 10;

/** Auth draws six boxes. */
export const CODE_LENGTH = 6;

/** The column's own ceiling (V016), repeated here so the endpoint can report it. */
export const MAX_CODE_ATTEMPTS = 5;

function hashCode(code: string): Buffer {
  return createHash('sha256').update(code).digest();
}

/**
 * Issues a code, replacing any live one for the same person and purpose.
 *
 * REPLACING RATHER THAN ADDING is what V016's partial unique index enforces, and the reason is in its
 * comment: leaving the old one usable would make "Send again" widen the guessing window instead of
 * replacing it, and somebody reading the older SMS would be told their correct code is wrong.
 *
 * Returns the PLAINTEXT code, which is the only moment it exists. The caller sends it; nothing stores
 * it.
 */
export async function issueCode(
  userId: string,
  purpose: CodePurpose,
  tx: Queryable,
): Promise<{ code: string; expiresAt: Date }> {
  // randomInt, not Math.random: this is a credential.
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');

  await tx.query(
    `UPDATE auth_codes SET consumed_at = now()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [userId, purpose],
  );

  const { rows } = await tx.query<{ expires_at: Date }>(
    `INSERT INTO auth_codes (user_id, purpose, code_hash, expires_at)
          VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)
       RETURNING expires_at`,
    [userId, purpose, hashCode(code), String(CODE_TTL_MINUTES)],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('issuing an auth code returned no row');

  return { code, expiresAt: row.expires_at };
}

export type CodeCheck =
  | { ok: true }
  | { ok: false; reason: 'none' | 'expired' | 'wrong' | 'too_many'; attemptsLeft: number };

/**
 * Checks a code and consumes it on success.
 *
 * ONE STATEMENT DOES THE CONSUMING, so two requests racing with the same correct code cannot both
 * succeed: `UPDATE … WHERE consumed_at IS NULL RETURNING` is the single-shot claim the money paths use
 * (§ the three layers of idempotency), and it is the right shape here for the same reason.
 *
 * A wrong code increments `attempts` — bounded at 5 by the column, so exhausting it makes the row
 * unusable rather than merely reporting a failure.
 */
export async function consumeCode(
  userId: string,
  purpose: CodePurpose,
  code: string,
  tx: Queryable,
): Promise<CodeCheck> {
  const { rows } = await tx.query<{
    id: string;
    attempts: number;
    expired: boolean;
    matches: boolean;
  }>(
    `SELECT id, attempts, (expires_at <= now()) AS expired, (code_hash = $3) AS matches
       FROM auth_codes
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
      FOR UPDATE`,
    [userId, purpose, hashCode(code)],
  );

  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'none', attemptsLeft: 0 };

  if (row.expired) {
    await tx.query(`UPDATE auth_codes SET consumed_at = now() WHERE id = $1`, [row.id]);
    return { ok: false, reason: 'expired', attemptsLeft: 0 };
  }

  if (!row.matches) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      // Burn it. A code guessed at five times is a code that should stop existing.
      await tx.query(`UPDATE auth_codes SET attempts = $2, consumed_at = now() WHERE id = $1`, [
        row.id,
        attempts,
      ]);
      return { ok: false, reason: 'too_many', attemptsLeft: 0 };
    }
    await tx.query(`UPDATE auth_codes SET attempts = $2 WHERE id = $1`, [row.id, attempts]);
    return { ok: false, reason: 'wrong', attemptsLeft: MAX_CODE_ATTEMPTS - attempts };
  }

  const claimed = await tx.query(
    `UPDATE auth_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
    [row.id],
  );
  if (claimed.rowCount === 0) return { ok: false, reason: 'none', attemptsLeft: 0 };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// staff_invites
// ---------------------------------------------------------------------------

const INVITE_TTL_DAYS = 7;

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export type Invite = {
  id: string;
  store_id: string;
  store_name: string;
  store_slug: string;
  email: string;
  role: StoreMembersRole;
  invitee_name: string;
  inviter_name: string | null;
  expires_at: Date;
};

/**
 * Creates an invite, revoking any live one for the same address and store.
 *
 * Returns the PLAINTEXT token — the only moment it exists — for the emailed link. V016's partial
 * unique index is what makes the revoke-and-reissue necessary rather than optional: two live invites
 * for one address would let a later invite with a different role sit behind an earlier one and grant
 * whichever link was clicked.
 */
export async function createInvite(
  storeId: string,
  input: { email: string; role: string; inviteeName: string; invitedBy: string },
  tx: Queryable,
): Promise<{ token: string; id: string; expiresAt: Date }> {
  await tx.query(
    `UPDATE staff_invites SET revoked_at = now()
      WHERE store_id = $1 AND lower(email) = lower($2)
        AND accepted_at IS NULL AND revoked_at IS NULL`,
    [storeId, input.email],
  );

  // 32 bytes of randomness. No attempt counter on this one: guessing it is not a thing that happens.
  const token = randomBytes(32).toString('base64url');

  const { rows } = await tx.query<{ id: string; expires_at: Date }>(
    `INSERT INTO staff_invites (store_id, email, role, invitee_name, token_hash, invited_by, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)
       RETURNING id, expires_at`,
    [storeId, input.email, input.role, input.inviteeName, hashToken(token), input.invitedBy, String(INVITE_TTL_DAYS)],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('creating an invite returned no row');

  return { token, id: row.id, expiresAt: row.expires_at };
}

/** The invite a token names, if it is live. Joined to the store and inviter so the acceptance screen can say who invited whom. */
export async function findLiveInvite(token: string, on: Queryable = db): Promise<Invite | null> {
  const { rows } = await on.query<Invite>(
    `SELECT i.id, i.store_id, s.name AS store_name, s.slug AS store_slug,
            i.email, i.role, i.invitee_name, u.name AS inviter_name, i.expires_at
       FROM staff_invites i
       JOIN stores s ON s.id = i.store_id
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1
        AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND i.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

/**
 * Marks an invite accepted. Returns false if somebody else got there first.
 *
 * The single-shot claim again: `WHERE accepted_at IS NULL RETURNING` means two clicks on the same link
 * cannot both create a membership.
 */
export async function claimInvite(inviteId: string, userId: string, tx: Queryable): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE staff_invites SET accepted_at = now(), accepted_user_id = $2
      WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [inviteId, userId],
  );
  return rowCount !== null && rowCount > 0;
}

export type PendingInvite = {
  id: string;
  email: string;
  role: StoreMembersRole;
  invitee_name: string;
  created_at: Date;
  expires_at: Date;
};

/** What is outstanding for a store — the Settings → Staff panel. */
export async function listPendingInvites(storeId: string, on: Queryable = db): Promise<PendingInvite[]> {
  const { rows } = await on.query<PendingInvite>(
    `SELECT id, email, role, invitee_name, created_at, expires_at
       FROM staff_invites
      WHERE store_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [storeId],
  );
  return rows;
}

export async function revokeInvite(storeId: string, inviteId: string, tx: Queryable): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE staff_invites SET revoked_at = now()
      WHERE id = $1 AND store_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [inviteId, storeId],
  );
  return rowCount !== null && rowCount > 0;
}
