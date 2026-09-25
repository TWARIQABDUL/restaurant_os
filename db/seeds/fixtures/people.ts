// db/seeds/fixtures/people.ts
//
// Staff, the Vendlyfy team, riders and customers.
//
// The shape here is §5.4's, and the seed is the first thing that exercises it end
// to end: staff and the platform team are users.scope = 'platform' and hold roles
// through memberships; a customer is users.scope = 'store' with a store_id and NO
// membership at all. One person holding two roles at two stores is the case Auth's
// store picker is drawn around, so Kevin gets it.

import { STORE, STAFF, TEAM, CUSTOMER, PHONE, type Ctx } from './context.ts';

type Person = { id: string; name: string; email: string; phone?: string };

const STAFF_PEOPLE: (Person & { memberships: { store: string; role: string }[] })[] = [
  {
    id: STAFF.aline, name: 'Aline Uwase', email: 'owner@nyama.example', phone: PHONE.aline,
    memberships: [{ store: STORE.nyama, role: 'owner' }],
  },
  {
    id: STAFF.patrick, name: 'Patrick Mukama', email: 'manager@nyama.example', phone: PHONE.patrick,
    memberships: [{ store: STORE.nyama, role: 'manager' }],
  },
  {
    id: STAFF.eric, name: 'Eric Mugisha', email: 'eric@nyama.example', phone: PHONE.eric,
    memberships: [{ store: STORE.nyama, role: 'rider' }],
  },
  {
    id: STAFF.claude, name: 'Claude Habineza', email: 'claude@nyama.example', phone: PHONE.claude,
    memberships: [{ store: STORE.nyama, role: 'rider' }],
  },
  {
    id: STAFF.olivier, name: 'Olivier Nzeyimana', email: 'olivier@nyama.example', phone: PHONE.olivier,
    memberships: [{ store: STORE.nyama, role: 'rider' }],
  },
  {
    // AUTH'S STORE PICKER, as a row: owner of one store and manager of another.
    // One identity, two roles, two stores — which a `users.role` column could not
    // express and is why §5.4 moved role onto the membership.
    id: STAFF.kevin, name: 'Kevin Nkusi', email: 'owner@inzu.example', phone: PHONE.kevin,
    memberships: [
      { store: STORE.inzu, role: 'owner' },
      { store: STORE.kicks, role: 'manager' },
    ],
  },
  {
    id: STAFF.yves, name: 'Yves Bizimana', email: 'owner@kigalikicks.example',
    memberships: [{ store: STORE.kicks, role: 'owner' }],
  },
  {
    id: STAFF.claudine, name: 'Claudine Mukamana', email: 'owner@ubwiza.example',
    memberships: [{ store: STORE.ubwiza, role: 'owner' }],
  },
  {
    id: STAFF.habimana, name: 'Olivier Habimana', email: 'owner@kigalitechhub.example',
    memberships: [{ store: STORE.techhub, role: 'owner' }],
  },
  {
    id: STAFF.bosco, name: 'Jean Bosco Nkurunziza', email: 'owner@deals4u.example',
    memberships: [{ store: STORE.deals4u, role: 'owner' }],
  },
  {
    // Inzu Threads delivers too, and a rider belongs to ONE store: the composite key
    // on (user_id, store_id, role) is what refuses Nyama's riders on Inzu's orders.
    id: STAFF.fabrice, name: 'Fabrice Twagira', email: 'fabrice@inzu.example', phone: '078 606 8890',
    memberships: [{ store: STORE.inzu, role: 'rider' }],
  },
];

// AdminAudit's own cast. platform_members only defines `super_admin` until
// AdminTeam widens it at milestone 27, so all four hold it — and the CHECK on that
// column is what will refuse `support` or `finance` until that migration exists,
// which is the right way round.
const TEAM_PEOPLE: Person[] = [
  { id: TEAM.grace, name: 'Grace Kamanzi', email: 'grace@vendlyfy.example' },
  { id: TEAM.olive, name: 'Olive Mukeshimana', email: 'olive@vendlyfy.example' },
  { id: TEAM.diane, name: 'Diane Uwimana', email: 'diane@vendlyfy.example' },
  { id: TEAM.samuel, name: 'Samuel Rugamba', email: 'samuel@vendlyfy.example' },
];

const CUSTOMERS: (Person & { store: string })[] = [
  { id: CUSTOMER.sandrine, name: 'Sandrine Keza', email: 'sandrine@example.com', phone: PHONE.sandrine, store: STORE.nyama },
  { id: CUSTOMER.pacifique, name: 'Pacifique Irakoze', email: 'pacifique@example.com', phone: PHONE.pacifique, store: STORE.nyama },
  { id: CUSTOMER.jeanpaul, name: 'Jean-Paul Nshuti', email: 'jeanpaul@example.com', phone: PHONE.jeanpaul, store: STORE.nyama },
  { id: CUSTOMER.grace, name: 'Grace Ingabire', email: 'grace.ingabire@example.com', phone: PHONE.grace, store: STORE.nyama },
  { id: CUSTOMER.aimable, name: 'Aimable Kayitare', email: 'aimable@example.com', phone: PHONE.aimable, store: STORE.nyama },
  { id: CUSTOMER.alice, name: 'Alice Mukamana', email: 'alice@example.com', phone: PHONE.alice, store: STORE.inzu },
  { id: CUSTOMER.hirwa, name: 'Eric Hirwa', email: 'hirwa@example.com', phone: PHONE.hirwa, store: STORE.techhub },
];

const RIDERS: { user: string; store: string; plate: string; availability: string }[] = [
  // The three riders §4.5 names, with their plates. Eric's and Claude's are the
  // boards'; Olivier's is invented, because no board prints it — noted rather than
  // passed off as canon.
  //
  // availability is only `available` or `off_duty`, and that is right: it is what
  // the rider sets in their own app. Whether they are mid-delivery is the ORDER's
  // business, so Claude is available AND has an order out — which is the state the
  // rider picker has to handle and the one a third enum value would have hidden.
  { user: STAFF.eric, store: STORE.nyama, plate: 'RAD 482 K', availability: 'available' },
  { user: STAFF.claude, store: STORE.nyama, plate: 'RAE 115 C', availability: 'available' },
  { user: STAFF.olivier, store: STORE.nyama, plate: 'RAF 207 M', availability: 'off_duty' },
  { user: STAFF.fabrice, store: STORE.inzu, plate: 'RAG 318 D', availability: 'available' },
];

export async function seedPeople(ctx: Ctx): Promise<void> {
  ctx.step('People');

  for (const p of STAFF_PEOPLE) {
    await ctx.sql(
      `INSERT INTO users (id, scope, email, phone, password_hash, name)
       VALUES ($1, 'platform', $2, $3, $4, $5)`,
      [p.id, p.email, p.phone ?? null, ctx.passwordHash, p.name],
    );
    for (const m of p.memberships) {
      await ctx.sql(
        `INSERT INTO store_members (user_id, store_id, role) VALUES ($1, $2, $3)`,
        [p.id, m.store, m.role],
      );
    }
  }
  ctx.ok(
    `${STAFF_PEOPLE.length} staff accounts, ` +
      `${STAFF_PEOPLE.reduce((n, p) => n + p.memberships.length, 0)} memberships ` +
      '(Kevin Nkusi holds two, which is Auth’s store picker)',
  );

  for (const p of TEAM_PEOPLE) {
    await ctx.sql(
      `INSERT INTO users (id, scope, email, password_hash, name) VALUES ($1, 'platform', $2, $3, $4)`,
      [p.id, p.email, ctx.passwordHash, p.name],
    );
    await ctx.sql(`INSERT INTO platform_members (user_id, role) VALUES ($1, 'super_admin')`, [p.id]);
  }
  ctx.ok(`${TEAM_PEOPLE.length} Vendlyfy team members`);

  for (const c of CUSTOMERS) {
    await ctx.sql(
      `INSERT INTO users (id, scope, store_id, email, phone, password_hash, name)
       VALUES ($1, 'store', $2, $3, $4, $5, $6)`,
      [c.id, c.store, c.email, c.phone ?? null, ctx.passwordHash, c.name],
    );
  }
  ctx.ok(`${CUSTOMERS.length} customers, scoped to their own store and holding no membership`);

  for (const r of RIDERS) {
    await ctx.sql(
      `INSERT INTO rider_profiles (user_id, store_id, plate_number, availability, availability_changed_at)
       VALUES ($1, $2, $3, $4, now() - interval '3 hours')`,
      [r.user, r.store, r.plate, r.availability],
    );
  }
  ctx.ok('4 riders \u2014 3 at Nyama (one off duty), 1 at Inzu, because a rider belongs to one store');
}
