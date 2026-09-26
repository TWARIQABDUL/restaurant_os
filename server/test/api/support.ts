// server/test/api/support.ts — milestone 11.
//
// Fixtures for the authorization tests. SELF-CONTAINED: it creates its own stores and
// people rather than reading db/seeds, so the suite can run against a freshly migrated
// database and cannot be broken by a change to the demo data. The ids all begin
// `eeeeeeee`, which the seed does not use, and cleanup deletes exactly them.
//
// It connects through the SAME pool the app uses — the vendlyfy_app role, whose
// privileges come from V000's default grants. A fixture that needed the owner role
// would be testing something the application cannot do.

import bcrypt from 'bcryptjs';
import { db, sql } from '../../src/db/index.ts';

function uid(n: number): string {
  return `eeeeeeee-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const STORE = {
  a: uid(1),
  b: uid(2),
} as const;

export const USER = {
  ownerA: uid(0x11),
  adminA: uid(0x12),
  managerA: uid(0x13),
  riderA: uid(0x14),
  adminB: uid(0x15),
  superAdmin: uid(0x16),
  customerA: uid(0x17),
  /** Admin at A AND manager at B — §5.4's "Owner at Nyama & Co. and Manager at Inzu Threads". */
  multiStore: uid(0x18),
} as const;

/** Every fixture email ends this way, so cleanup can find accounts the endpoints created. */
export const EMAIL_DOMAIN = 'escalation.test';

// bcrypt cost 12 on eight accounts is about three seconds. These tests never verify a
// password — they authenticate with a signed token — so the column gets a fixed,
// obviously-not-a-hash placeholder and the suite stays fast. Nothing can sign in with it.
const PASSWORD_HASH = '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar';

const STAFF: { id: string; name: string; email: string; store: string; role: string; phone?: string }[] = [
  { id: USER.ownerA, name: 'Owner A', email: `owner-a@${EMAIL_DOMAIN}`, store: STORE.a, role: 'owner' },
  { id: USER.adminA, name: 'Admin A', email: `admin-a@${EMAIL_DOMAIN}`, store: STORE.a, role: 'admin' },
  { id: USER.managerA, name: 'Manager A', email: `manager-a@${EMAIL_DOMAIN}`, store: STORE.a, role: 'manager' },
  // A phone, because Auth's rider signs in with one: "078 455 9012".
  { id: USER.riderA, name: 'Rider A', email: `rider-a@${EMAIL_DOMAIN}`, store: STORE.a, role: 'rider', phone: '078 455 9012' },
  { id: USER.adminB, name: 'Admin B', email: `admin-b@${EMAIL_DOMAIN}`, store: STORE.b, role: 'admin' },
];

export async function cleanup(): Promise<void> {
  const stores = [STORE.a, STORE.b];
  const like = `%@${EMAIL_DOMAIN}`;

  // Order is the schema's, not a guess. wallets and users both reference stores with
  // ON DELETE RESTRICT, so the stores go last; store_members cascades from users, but
  // is removed explicitly so a failure names the right table.
  await sql(`DELETE FROM rider_profiles WHERE store_id = ANY($1::uuid[])`, [stores]);
  await sql(`DELETE FROM store_members WHERE store_id = ANY($1::uuid[])`, [stores]);
  await sql(`DELETE FROM platform_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [like]);
  await sql(`DELETE FROM store_payment_methods WHERE store_id = ANY($1::uuid[])`, [stores]);
  await sql(`DELETE FROM store_payout_settings WHERE store_id = ANY($1::uuid[])`, [stores]);
  await sql(`DELETE FROM store_pickup_settings WHERE store_id = ANY($1::uuid[])`, [stores]);
  await sql(`DELETE FROM users WHERE email LIKE $1`, [like]);
  await sql(`DELETE FROM wallets WHERE store_id = ANY($1::uuid[])`, [stores]);
  await sql(`DELETE FROM stores WHERE id = ANY($1::uuid[])`, [stores]);
}

export async function seedFixtures(): Promise<void> {
  await cleanup();

  await sql(
    `INSERT INTO stores (id, slug, name, country, selling_currency, status)
          VALUES ($1, 'escalation-store-a', 'Escalation Store A', 'RW', 'RWF', 'active'),
                 ($2, 'escalation-store-b', 'Escalation Store B', 'RW', 'RWF', 'active')`,
    [STORE.a, STORE.b],
  );

  for (const person of STAFF) {
    await sql(
      `INSERT INTO users (id, scope, email, name, phone, password_hash) VALUES ($1, 'platform', $2, $3, $4, $5)`,
      [person.id, person.email, person.name, person.phone ?? null, PASSWORD_HASH],
    );
    await sql(`INSERT INTO store_members (user_id, store_id, role) VALUES ($1, $2, $3)`, [
      person.id,
      person.store,
      person.role,
    ]);
  }

  // The rider needs a profile to be a rider in any useful sense, and the test that
  // creates one through the endpoint needs a plate already taken to collide with.
  await sql(
    `INSERT INTO rider_profiles (user_id, store_id, plate_number, availability)
          VALUES ($1, $2, 'RAX 100 A', 'available')`,
    [USER.riderA, STORE.a],
  );

  // One identity, two stores, two roles.
  await sql(
    `INSERT INTO users (id, scope, email, name, password_hash) VALUES ($1, 'platform', $2, 'Multi Store', $3)`,
    [USER.multiStore, `multi@${EMAIL_DOMAIN}`, PASSWORD_HASH],
  );
  await sql(
    `INSERT INTO store_members (user_id, store_id, role)
          VALUES ($1, $2, 'admin'), ($1, $3, 'manager')`,
    [USER.multiStore, STORE.a, STORE.b],
  );

  // The Vendlyfy team. Holds platform permissions and NO store membership, which is
  // the point of the "no super_admin bypass" test.
  await sql(
    `INSERT INTO users (id, scope, email, name, password_hash) VALUES ($1, 'platform', $2, 'Super Admin', $3)`,
    [USER.superAdmin, `super@${EMAIL_DOMAIN}`, PASSWORD_HASH],
  );
  await sql(`INSERT INTO platform_members (user_id, role) VALUES ($1, 'super_admin')`, [USER.superAdmin]);

  // A customer of store A: scope 'store', and structurally unable to hold a membership.
  await sql(
    `INSERT INTO users (id, scope, store_id, email, name, password_hash)
          VALUES ($1, 'store', $2, $3, 'Customer A', $4)`,
    [USER.customerA, STORE.a, `customer-a@${EMAIL_DOMAIN}`, PASSWORD_HASH],
  );

  // Settings for store A, so GET /settings has all four of its tables to read.
  await sql(
    `INSERT INTO store_pickup_settings (store_id, address, ready_minutes)
          VALUES ($1, 'KG 11 Ave, Kigali', 15)`,
    [STORE.a],
  );
  await sql(
    `INSERT INTO store_payout_settings (store_id, payout_method_key, payout_phone, settlement_mode)
          VALUES ($1, 'mtn_momo', '078 111 4412', 'manual')`,
    [STORE.a],
  );
  await sql(
    `INSERT INTO store_payment_methods (store_id, payment_method_key, is_connected, connected_at)
          VALUES ($1, 'cash', true, now()), ($1, 'mtn_momo', true, now())`,
    [STORE.a],
  );
}

/**
 * The password the sign-in tests use, and the one account per persona that really has it.
 *
 * The fixtures above store an obviously-fake hash so eight accounts do not cost eight bcrypt runs —
 * every other suite authenticates with a signed token. The sign-in tests cannot: verifying a password is
 * the thing under test. So this hashes once, at cost 12, and applies it to the accounts those tests use.
 *
 * It satisfies the board's three rules (8+, a digit, not the store name or phone) on purpose: a fixture
 * password that the server would reject would make every test here pass or fail for the wrong reason.
 */
export const FIXTURE_PASSWORD = 'correct-horse-42';

export async function seedAuthPasswords(): Promise<void> {
  const hash = await bcrypt.hash(FIXTURE_PASSWORD, 12);
  await sql(
    `UPDATE users SET password_hash = $2
      WHERE id = ANY($1::uuid[])`,
    [[USER.ownerA, USER.managerA, USER.adminB, USER.superAdmin, USER.multiStore, USER.riderA, USER.customerA], hash],
  );
}

/** How many platform members exist. The first escalation test watches this number. */
export async function countPlatformMembers(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM platform_members`);
  return Number(rows[0]?.n ?? '0');
}

export async function userExistsWithEmail(email: string): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return Number(rows[0]?.n ?? '0') > 0;
}
