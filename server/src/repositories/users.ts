// server/src/repositories/users.ts — milestone 11.
//
// Identity only. Role lives on store_members and platform_members (§5.4), so
// nothing in this file reads or writes one.
//
// `password_hash` is not in any SELECT list here except the one method whose job is
// to verify a password, and that method returns the hash and nothing else. A row
// type that carries a hash gets logged eventually.

import bcrypt from 'bcryptjs';
import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import type { UsersRow } from '../db/rows.ts';

/**
 * Cost 12, matching server/src/routes/auth.js. It has to match: during the
 * migration a person may have been hashed by either server, and a cost change
 * would silently re-hash nothing while doubling the cost of every login.
 */
export const BCRYPT_COST = 12;

export type UserIdentity = Pick<UsersRow, 'id' | 'scope' | 'store_id' | 'email' | 'phone' | 'name'>;

const IDENTITY_COLUMNS = 'id, scope, store_id, email, phone, name';

export async function findById(userId: string, on: Queryable = db): Promise<UserIdentity | null> {
  const { rows } = await on.query<UserIdentity>(
    `SELECT ${IDENTITY_COLUMNS} FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * The platform identity for an email address — staff and the Vendlyfy team.
 *
 * `lower(email)` on both sides, which is what users_platform_email_key is built on.
 * `scope = 'platform'` is in the WHERE for two reasons: it is the index's partial
 * predicate, and Postgres only uses a partial index when the query implies it — and
 * without it this would also match a CUSTOMER of some store who happens to share the
 * email, which is a legitimate separate account (V001's comment on the two partial
 * indexes) and must never be returned to a staff lookup.
 */
export async function findPlatformByEmail(email: string, on: Queryable = db): Promise<UserIdentity | null> {
  const { rows } = await on.query<UserIdentity>(
    `SELECT ${IDENTITY_COLUMNS}
       FROM users
      WHERE scope = 'platform'
        AND lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

/** The stored hash, for verifying a password. Returns the id with it so the caller needs no second read. */
export async function findPlatformCredentials(
  email: string,
  on: Queryable = db,
): Promise<{ id: string; password_hash: string } | null> {
  const { rows } = await on.query<{ id: string; password_hash: string }>(
    `SELECT id, password_hash
       FROM users
      WHERE scope = 'platform'
        AND lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

/** The stored hash for a person known by id — for verifying a current password before changing it. */
export async function findCredentialsById(
  userId: string,
  on: Queryable = db,
): Promise<{ id: string; password_hash: string } | null> {
  const { rows } = await on.query<{ id: string; password_hash: string }>(
    `SELECT id, password_hash FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Replaces a password hash.
 *
 * Takes a HASH, not a password, so no caller can write a plaintext by mistake — and it deliberately
 * does not touch session_version: revoking sessions is auth.revokeAllSessions(), and keeping them
 * separate means a caller has to say which it meant.
 */
export async function setPassword(userId: string, passwordHash: string, tx: Queryable): Promise<void> {
  const { rowCount } = await tx.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
    userId,
    passwordHash,
  ]);
  if (rowCount === 0) throw new Error(`user ${userId} disappeared while setting a password`);
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Creates a platform identity — a person who can hold memberships.
 *
 * Nothing here says which store, because a platform identity belongs to none: the
 * membership is a separate row, written in the same transaction by the caller. That
 * separation is what lets one person be owner at one store and manager at another,
 * which a `users.tenant_id` column could not express.
 *
 * Writes more than one row when combined with the membership, so it requires a
 * transaction rather than trusting the caller to have opened one.
 */
export async function insertPlatformUser(
  tx: Queryable,
  input: { email: string; name: string; phone: string | null; passwordHash: string },
): Promise<UserIdentity> {
  const { rows } = await tx.query<UserIdentity>(
    `INSERT INTO users (scope, email, name, phone, password_hash)
          VALUES ('platform', $1, $2, $3, $4)
       RETURNING ${IDENTITY_COLUMNS}`,
    [input.email, input.name, input.phone, input.passwordHash],
  );
  const created = rows[0];
  if (created === undefined) {
    // RETURNING on a successful INSERT always yields a row; no row means the
    // statement did not run, which is a bug rather than a state.
    throw new Error('INSERT INTO users returned no row');
  }
  return created;
}
