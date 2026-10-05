// server/src/repositories/onboarding.ts — milestone 26: a person becomes a merchant.
//
// NOTHING IN THE NEW SERVER CREATED A STORE. Auth (M15) signs people in, resets passwords and accepts invites; Settings
// (M25) edits a store; the seed and the test fixtures write stores directly. The one path a stranger takes to get from
// "I sell things" to "I have a store" did not exist — the legacy server's /register did it, against the old database. This
// is that path, and it is ONE TRANSACTION: an account with no store, or a store with no owner, is a state nobody can get
// out of from the screen, so neither is ever committed.
//
// WHAT A NEW STORE STARTS WITH, and why each is here rather than left for Settings:
//   * active, not pending — the board says "Your store is ready … is live". Identity is a separate lifecycle (V012) and
//     gates payouts only; selling is the first thing a merchant should be able to do.
//   * the owner's membership. Their permissions come from role_permissions rows, as everyone's do.
//   * a wallet — made by stores_create_wallet (V005), not here.
//   * the business type's pinned template, so the vocabulary and modules are right from the first screen.
//   * Cash connected. A store with no payment method cannot take an order, and Settings refuses to disconnect the last one
//     (LAST_METHOD) — starting with one the merchant can turn off later is the same rule applied at the start.
//   NOT created: delivery zones, pickup, hours, a payout number. Each needs a fact only the merchant has; Settings asks.

import { badRequest, conflict, db } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';
import * as config from './config.ts';
import * as users from './users.ts';

export const COUNTRY = 'RW';
export const CURRENCY = 'RWF';

/** Mirrors stores_slug_not_reserved (V001). The database is the arbiter; this only avoids offering what it will refuse. */
const RESERVED = new Set([
  'api', 'app', 'admin', 'www', 'mail', 'ftp', 'assets', 'static', 'public', 'auth', 'login', 'logout', 'signup', 'signin',
  'register', 'password', 'account', 'accounts', 'dashboard', 'settings', 'checkout', 'cart', 'orders', 'order', 'products',
  'health', 'status', 'support', 'help', 'about', 'terms', 'privacy', 'blog', 'docs', 'vendlyfy', 'store', 'stores',
]);

/** "Nyama & Co." → "nyama-and-co". Empty when nothing usable is left; the caller decides what to do about that. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 55)
    .replace(/-+$/g, '');
}

export const isUsableSlug = (slug: string): boolean => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length >= 2 && slug.length <= 63 && !RESERVED.has(slug);

export async function slugTaken(slug: string, on: Queryable = db): Promise<boolean> {
  const { rowCount } = await on.query(`SELECT 1 FROM stores WHERE slug = $1`, [slug]);
  return (rowCount ?? 0) > 0;
}

/** The first free slug for a name: "nyama", then "nyama-2", "nyama-3"… */
export async function suggestSlug(name: string, on: Queryable = db): Promise<{ slug: string; available: boolean }> {
  const base = slugify(name);
  if (base.length < 2) return { slug: base, available: false };
  for (let n = 1; n <= 25; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (isUsableSlug(candidate) && !(await slugTaken(candidate, on))) return { slug: candidate, available: true };
  }
  return { slug: base, available: false };
}

export type NewMerchant = {
  name: string;
  email: string;
  phone: string | null;
  password: string;
  businessName: string;
  slug: string;
  templateKey: string | null;
};

export type Created = { userId: string; storeId: string; slug: string; sessionVersion: number };

export async function createMerchant(input: NewMerchant, tx: Tx): Promise<Created> {
  if (!isUsableSlug(input.slug)) throw badRequest('Choose a different store address.', 'SLUG_INVALID');
  if (await slugTaken(input.slug, tx)) throw conflict('That store address is taken. Choose another.', 'SLUG_TAKEN');

  const exists = await tx.query(`SELECT 1 FROM users WHERE scope = 'platform' AND lower(email) = lower($1)`, [input.email]);
  if ((exists.rowCount ?? 0) > 0) {
    // Said plainly, because the person is the one who typed it. Auth's sign-in is careful not to reveal which addresses are
    // registered; a sign-UP that cannot say so would be unusable, and the hint is where to go next.
    throw conflict('That email already has an account. Sign in instead.', 'EMAIL_TAKEN');
  }

  let template: { templateId: string; version: number } | null = null;
  if (input.templateKey !== null) {
    template = await config.latestPublishedVersion(input.templateKey, tx);
    if (template === null) throw badRequest('That business type is not available.', 'TEMPLATE_UNAVAILABLE');
  }

  const passwordHash = await users.hashPassword(input.password);
  const user = await users.insertPlatformUser(tx, { email: input.email, name: input.name, phone: input.phone, passwordHash });

  const store = await tx.query<{ id: string }>(
    `INSERT INTO stores (slug, name, country, selling_currency, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [input.slug, input.businessName, COUNTRY, CURRENCY],
  );
  const storeId = store.rows[0]?.id;
  if (storeId === undefined) throw new Error('INSERT INTO stores returned no row');

  await tx.query(`INSERT INTO store_members (user_id, store_id, role) VALUES ($1, $2, 'owner')`, [user.id, storeId]);
  if (template !== null) await config.setTemplate(storeId, template, tx);
  await tx.query(
    `INSERT INTO store_payment_methods (store_id, payment_method_key, is_connected, connected_at) VALUES ($1, 'cash', true, now())`,
    [storeId],
  );

  const version = await tx.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [user.id]);
  return { userId: user.id, storeId, slug: input.slug, sessionVersion: version.rows[0]?.session_version ?? 0 };
}
