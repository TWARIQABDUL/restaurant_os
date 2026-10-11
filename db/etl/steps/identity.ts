// db/etl/steps/identity.ts — tenants → stores, and users → people + memberships (plan §5.5).
//
// Both mappings are product decisions, not technical ones (§5.5's own words), so each default is
// written down here AND emitted as a Decision into the report where a human reads it.

import { Ctx, Unmapped, read } from '../lib.ts';

const COUNTRY = 'RW';
const CURRENCY = 'RWF';
const TEMPLATE_KEY = 'food';
const PLAN = 'starter';

// The new schema's slug rules (stores_slug_*). A slug is a URL customers already hold, so a change is
// a visible event — it is never silent.
const RESERVED = new Set(['api', 'app', 'admin', 'www', 'mail', 'ftp', 'assets', 'static']);

type Tenant = { id: string; name: string; slug: string; logo_url: string | null; settings: unknown; active: boolean | null; created_at: Date };
type OldUser = {
  id: string; tenant_id: string; name: string; email: string; password_hash: string; role: string;
  phone: string | null; plate_number: string | null; created_at: Date;
};

export function usableSlug(raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base;
}

export async function stores(ctx: Ctx): Promise<void> {
  const tenants = await read<Tenant>(ctx, 'tenants', ['id', 'name', 'slug', 'logo_url', 'settings', 'active', 'created_at'], 'created_at, id');

  const pin = await ctx.tgt.query<{ template_id: string; version: number }>(
    `SELECT v.template_id, max(v.version)::int AS version
       FROM industry_template_versions v JOIN industry_templates t ON t.id = v.template_id
      WHERE t.key = $1 AND v.status = 'published' GROUP BY v.template_id`,
    [TEMPLATE_KEY],
  );
  const template = pin.rows[0];
  if (template === undefined) throw new Unmapped(`no published "${TEMPLATE_KEY}" industry template`, 'Run the migrations first: the reference data ships with them.');

  const usesMomo = await ctx.src.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM public.orders WHERE payment_method = 'mobile_money'
     UNION SELECT DISTINCT tenant_id FROM public.momo_transactions WHERE tenant_id IS NOT NULL`,
  );
  const momoStores = new Set(usesMomo.rows.map((r) => r.tenant_id));

  const taken = new Set<string>();
  for (const t of tenants) {
    let slug = usableSlug(t.slug);
    if (slug.length < 2 || RESERVED.has(slug) || taken.has(slug)) {
      const next = `${slug.length >= 2 ? slug : 'store'}-${t.id.slice(0, 4)}`;
      ctx.decide('stores', 'slug-changed', t.id, `"${t.slug}" cannot be used as is (${slug.length < 2 ? 'too short' : RESERVED.has(slug) ? 'reserved' : 'already taken'}); the store gets "${next}". Its customers' links change.`);
      slug = next;
    } else if (slug !== t.slug) {
      ctx.decide('stores', 'slug-changed', t.id, `"${t.slug}" becomes "${slug}" to fit the new address rules. Its customers' links change.`);
    }
    taken.add(slug);

    const status = t.active === false ? 'suspended' : 'active';
    await ctx.tgt.query(
      `INSERT INTO stores (id, slug, name, country, selling_currency, status, plan_key, created_at, industry_template_id, industry_template_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [t.id, slug, t.name, COUNTRY, CURRENCY, status, PLAN, t.created_at, template.template_id, template.version],
    );
    ctx.counter('tenants').written += 1;

    // Cash always; MTN MoMo where the store has actually taken a mobile-money order. The old system only had the one provider.
    await ctx.tgt.query(`INSERT INTO store_payment_methods (store_id, payment_method_key, is_connected, connected_at) VALUES ($1, 'cash', true, $2)`, [t.id, t.created_at]);
    if (momoStores.has(t.id)) {
      await ctx.tgt.query(`INSERT INTO store_payment_methods (store_id, payment_method_key, is_connected, connected_at) VALUES ($1, 'mtn_momo', true, $2)`, [t.id, t.created_at]);
    }

    // The old system had no opening hours: it took orders at any time. A new store with no hours is shown as CLOSED, so
    // each carries "open all day" (00:00–23:59) until the merchant sets real ones. Orders are not blocked either way.
    await ctx.tgt.query(
      `INSERT INTO store_hours (store_id, day_of_week, opens_at, closes_at) SELECT $1, d, '00:00', '23:59' FROM generate_series(1, 7) d`,
      [t.id],
    );

    const extras: Record<string, unknown> = {};
    if (t.logo_url !== null && t.logo_url !== '') extras['logo_url'] = t.logo_url;
    const settings = t.settings;
    if (settings !== null && typeof settings === 'object' && Object.keys(settings as object).length > 0) extras['settings'] = settings;
    if (Object.keys(extras).length > 0) {
      await ctx.archive('tenants', t.id, t.id, 'logo and free-form settings have no column in the new schema; images move to the new media storage by hand at cutover', extras);
    }
  }

  ctx.decide('stores', 'defaults', 'all', `Every store is created in ${COUNTRY} selling in ${CURRENCY}, on the "${PLAN}" plan, pinned to the latest published "${TEMPLATE_KEY}" template (the old product was a food-ordering app). Stores start on the platform's default look; merchants choose theirs in Customize.`);
  ctx.decide('stores', 'hours', 'all', 'The old system had no opening hours, so every store is created open 00:00–23:59 every day, as it behaved before. Merchants set real hours in Settings; until they do, the storefront does not show them as closed.');
  ctx.decide('stores', 'status', 'all', 'tenants.active=false becomes "suspended"; everything else "active". There is no "pending" in the old system, and its owners were never identity-checked: payouts stay locked until each completes the new identity check.');
}

type Person = { id: string; email: string; name: string; phone: string | null; hash: string; created: Date; rows: OldUser[] };

export async function people(ctx: Ctx): Promise<void> {
  const rows = await read<OldUser>(
    ctx, 'users',
    ['id', 'tenant_id', 'name', 'email', 'password_hash', 'role', 'phone', 'plate_number', 'created_at'],
    'created_at, id',
  );

  const known = new Set((await ctx.tgt.query<{ id: string }>(`SELECT id FROM stores`)).rows.map((r) => r.id));
  for (const u of rows) {
    if (!known.has(u.tenant_id)) throw new Unmapped(`user ${u.id} belongs to tenant ${u.tenant_id}, which does not exist`, 'The source has an orphan; decide what it means before migrating.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email)) throw new Unmapped(`user ${u.id} has an email the new schema rejects`, 'Fix it in the source copy or decide to drop the account.');
  }

  // STAFF are one identity per email (a person who works at two stores is one login with two memberships). A
  // CUSTOMER is per store, exactly as before — the same address ordering from two stores stays two customer
  // records, because merging them would hand one store another's order history.
  const staff = rows.filter((u) => u.role !== 'customer');
  const customers = rows.filter((u) => u.role === 'customer');

  const byEmail = new Map<string, Person>();
  for (const u of staff) {
    const key = u.email.toLowerCase();
    const existing = byEmail.get(key);
    if (existing === undefined) {
      byEmail.set(key, { id: u.id, email: u.email, name: u.name, phone: u.phone, hash: u.password_hash, created: u.created_at, rows: [u] });
    } else {
      existing.rows.push(u);
      if (existing.hash !== u.password_hash) {
        ctx.decide('people', 'password-conflict', existing.id, `One person (${existing.rows.length} staff rows, ${existing.rows.map((r) => r.role).join(' + ')}) had different password hashes in different stores. The EARLIEST account's password wins; the others no longer work. Suggest a reset link.`);
      }
      if (existing.phone === null && u.phone !== null) existing.phone = u.phone;
    }
    ctx.userMap.set(u.id, byEmail.get(key)!.id);
  }

  for (const p of byEmail.values()) {
    await ctx.tgt.query(
      `INSERT INTO users (id, scope, email, phone, password_hash, name, created_at) VALUES ($1, 'platform', $2, $3, $4, $5, $6)`,
      [p.id, p.email, p.phone, p.hash, p.name, p.created],
    );
    ctx.counter('users').written += 1;
  }

  // Memberships. The first admin of a store becomes its owner (they created it); further admins are admins.
  const ownerTaken = new Set<string>();
  for (const u of staff) {
    const personId = ctx.userMap.get(u.id)!;
    if (u.role === 'super_admin') {
      await ctx.tgt.query(
        `INSERT INTO platform_members (user_id, role) VALUES ($1, 'super_admin') ON CONFLICT DO NOTHING`, [personId],
      );
      continue;
    }
    let role: 'owner' | 'admin' | 'manager' | 'rider';
    if (u.role === 'admin') {
      role = ownerTaken.has(u.tenant_id) ? 'admin' : 'owner';
      ownerTaken.add(u.tenant_id);
      if (role === 'admin') ctx.decide('people', 'extra-admin', u.id, `Store ${u.tenant_id} already has an owner, so this old "admin" becomes an "admin" member, not a second owner.`);
    } else if (u.role === 'manager') role = 'manager';
    else if (u.role === 'delivery') role = 'rider';
    else throw new Unmapped(`unknown role "${u.role}" on user ${u.id}`, 'Add a rule for it in db/etl/steps/identity.ts.');

    await ctx.tgt.query(
      `INSERT INTO store_members (user_id, store_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, store_id) DO NOTHING`,
      [personId, u.tenant_id, role, u.created_at],
    );
    if (role === 'rider') {
      const plate = (u.plate_number ?? '').trim();
      if (plate === '') ctx.decide('people', 'rider-no-plate', u.id, 'The rider has no plate number; "NOT RECORDED" is stored. Ask them to correct it.');
      await ctx.tgt.query(
        `INSERT INTO rider_profiles (user_id, store_id, plate_number) VALUES ($1, $2, $3)`,
        [personId, u.tenant_id, plate === '' ? 'NOT RECORDED' : plate],
      );
    }
  }

  // Customers keep their ids.
  const storeEmail = new Set<string>();
  for (const u of customers) {
    const key = `${u.tenant_id}:${u.email.toLowerCase()}`;
    if (storeEmail.has(key)) throw new Unmapped(`two customers share ${u.email} at store ${u.tenant_id}`, 'The old UNIQUE(email, tenant_id) should have prevented this.');
    storeEmail.add(key);
    await ctx.tgt.query(
      `INSERT INTO users (id, scope, store_id, email, phone, password_hash, name, created_at) VALUES ($1, 'store', $2, $3, $4, $5, $6, $7)`,
      [u.id, u.tenant_id, u.email, u.phone, u.password_hash, u.name, u.created_at],
    );
    ctx.userMap.set(u.id, u.id);
    ctx.counter('users').written += 1;
  }

  const shared = [...byEmail.values()].filter((p) => p.rows.length > 1).length;
  ctx.decide('people', 'merge-rule', 'staff', `${staff.length} staff rows became ${byEmail.size} people (${shared} merged by email); ${customers.length} customers stay per-store. Passwords are carried as hashes, so nobody has to reset unless listed as a conflict.`);
}
