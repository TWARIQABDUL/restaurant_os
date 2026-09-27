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
import { Client } from 'pg';
import { db, sql, withTransaction } from '../../src/db/index.ts';

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

/**
 * The shopfront's own fixtures — milestone 16. A catalogue on store A with one product of every shape the
 * storefront has to render, and one delivered order behind it so a review has a line to attach to.
 */
export const CATALOGUE = {
  /** Sections. */
  mains: uid(0x100),
  drinks: uid(0x101),
  /** A plain product: no options, no stock tracking. One tap adds it. */
  juice: uid(0x110),
  /** Two "pick one" groups, so its variants are a 2x2 matrix with one combination sold out. */
  tee: uid(0x111),
  /** A "pick several" group — priced extras, not a variant dimension. */
  burger: uid(0x112),
  /** Every variant withdrawn: the sold-out card. */
  wrap: uid(0x113),
  /** Tracked, and below its threshold: the "Few left" card. */
  cap: uid(0x114),
  /** status = draft. Must not appear on the shopfront at all. */
  secret: uid(0x115),
  /** compare_at_price above the price: the discount badge. */
  plate: uid(0x116),
  /** In BOTH sections, which is what makes product_categories a join. */
  water: uid(0x117),
  /**
   * Priced at 8,017 — AdminCurrencies' own example, so the cash-rounding rule is exercised against the
   * figure the board shows rather than against a total that happens to be a multiple of 50 already.
   */
  setMenu: uid(0x118),

  size: uid(0x120),
  colour: uid(0x121),
  extras: uid(0x122),

  promo: uid(0x130),
  order: uid(0x140),
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

/**
 * Remove the append-only rows the fixture stores left behind, which needs table ownership.
 *
 * SIX TABLES IN THIS SCHEMA REFUSE TO FORGET, by design and for different reasons:
 *
 *   reviews         "Reviews go live straight away and stay. Vendlyfy can hide one after a report; nobody can
 *                   remove it." (V009)
 *   order_events    "A history that can be rewritten is not a history." (V004)
 *   wallet_ledger   the money's own record, whose rows chain to each other (V005)
 *   audit_log       the platform's, hash-chained (V011)
 *   complaint_events  the argument a refund is settled from, chained per complaint (V008)
 *   complaint_evidence what the customer photographed (V008)
 *
 * Every one of those triggers raises for EVERY role, including the table's owner — which is what makes the
 * promise real rather than a convention. So a test that places an order cannot remove it, and therefore
 * cannot remove the store it belongs to either.
 *
 * TEARDOWN IS NOT A FIXTURE, and that distinction is what keeps support.ts's rule intact: every row a test
 * READS was written through the app role, so no test asserts on a state the application could not produce.
 * Removing rows afterwards is housekeeping, and it is the only thing this connection does.
 *
 * ALTER TABLE ... DISABLE TRIGGER is transactional and takes an ACCESS EXCLUSIVE lock, so the window where
 * these tables are mutable is one transaction long on a local test database, and a rollback puts every
 * trigger back without anybody's help.
 */
async function deleteAppendOnlyAsOwner(stores: readonly string[]): Promise<void> {
  const url = process.env['OWNER_DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'OWNER_DATABASE_URL is not set, so the append-only fixture rows cannot be removed — reviews, order ' +
        'events, the ledger and the audit log are undeletable by design, and teardown needs to disable those ' +
        'triggers. Run the suite through npm run api:test.',
    );
  }

  const owner = new Client({ connectionString: url });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('ALTER TABLE reviews DISABLE TRIGGER reviews_immutable');
    await owner.query('ALTER TABLE order_events DISABLE TRIGGER order_events_no_update');
    await owner.query('ALTER TABLE wallet_ledger DISABLE TRIGGER wallet_ledger_no_change');
    await owner.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await owner.query('ALTER TABLE complaint_events DISABLE TRIGGER complaint_events_no_update');
    await owner.query('ALTER TABLE complaint_evidence DISABLE TRIGGER complaint_evidence_no_update');

    // Children before parents, as everywhere else: a reply and a report both reference a review.
    await owner.query(
      `DELETE FROM review_reports WHERE review_id IN (SELECT id FROM reviews WHERE store_id = ANY($1::uuid[]))`,
      [stores],
    );
    await owner.query(`DELETE FROM review_replies WHERE store_id = ANY($1::uuid[])`, [stores]);
    await owner.query(`DELETE FROM reviews WHERE store_id = ANY($1::uuid[])`, [stores]);
    await owner.query(`DELETE FROM order_events WHERE store_id = ANY($1::uuid[])`, [stores]);
    // A complaint is a thread: its evidence and its events go before it, and it goes before the order it is
    // about — `complaints_order_id_store_id_fkey` is what says so.
    await owner.query(`DELETE FROM complaint_evidence WHERE store_id = ANY($1::uuid[])`, [stores]);
    await owner.query(`DELETE FROM complaint_events WHERE store_id = ANY($1::uuid[])`, [stores]);
    await owner.query(`DELETE FROM complaints WHERE store_id = ANY($1::uuid[])`, [stores]);
    await owner.query(`DELETE FROM wallet_ledger WHERE store_id = ANY($1::uuid[])`, [stores]);
    await owner.query(`DELETE FROM audit_log WHERE store_id = ANY($1::uuid[])`, [stores]);

    await owner.query('ALTER TABLE complaint_evidence ENABLE TRIGGER complaint_evidence_no_update');
    await owner.query('ALTER TABLE complaint_events ENABLE TRIGGER complaint_events_no_update');
    await owner.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
    await owner.query('ALTER TABLE wallet_ledger ENABLE TRIGGER wallet_ledger_no_change');
    await owner.query('ALTER TABLE order_events ENABLE TRIGGER order_events_no_update');
    await owner.query('ALTER TABLE reviews ENABLE TRIGGER reviews_immutable');
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  } finally {
    await owner.end();
  }
}

export async function cleanup(): Promise<void> {
  const stores = [STORE.a, STORE.b];
  const like = `%@${EMAIL_DOMAIN}`;

  // The append-only rows first, through the owner: see deleteAppendOnlyAsOwner(). Everything below is the
  // app role, as every fixture is.
  await deleteAppendOnlyAsOwner(stores);

  // ONE TRANSACTION for every delete, and this is not tidiness either. Several of these tables carry
  // DEFERRABLE constraint triggers that check a SET of rows — a variant must name one value per group, an
  // order must have at least one line — so deleting the children in one statement and the parents in the
  // next leaves an invalid state committed in between, and the trigger refuses it. Inside a transaction
  // every check runs once, at the end, when the rows are all gone.
  // Order is still the schema's, not a guess: wallets and users both reference stores with ON DELETE
  // RESTRICT, so the stores go last, and the shopfront's rows go first because reviews reference order
  // lines and lines reference variants. Inside one transaction the ORDER no longer has to be right for
  // the deletes to succeed — but keeping it right means a failure names the table that actually refused.
  await withTransaction(async (tx) => {
    await tx.query(`DELETE FROM cart_item_option_values WHERE cart_id IN (SELECT id FROM carts WHERE store_id = ANY($1::uuid[]))`, [stores]);
    await tx.query(`DELETE FROM cart_items WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM carts WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM order_item_option_values WHERE order_item_id IN (SELECT id FROM order_items WHERE store_id = ANY($1::uuid[]))`, [stores]);
    await tx.query(`DELETE FROM order_items WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM momo_transactions WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM refunds WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM notifications WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(
      `DELETE FROM customer_addresses WHERE user_id IN (SELECT id FROM users WHERE store_id = ANY($1::uuid[]))`,
      [stores],
    );
    await tx.query(`DELETE FROM order_discounts WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM orders WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM store_order_counters WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM promotions WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM product_variant_values WHERE variant_id IN (SELECT id FROM product_variants WHERE store_id = ANY($1::uuid[]))`, [stores]);
    await tx.query(`DELETE FROM product_variants WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM product_option_groups WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM option_values WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM option_groups WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM product_categories WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM products WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM categories WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM delivery_zone_areas WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM delivery_zones WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM store_hours WHERE store_id = ANY($1::uuid[])`, [stores]);

    await tx.query(`DELETE FROM rider_profiles WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM store_members WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM platform_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [like]);
    await tx.query(`DELETE FROM store_payment_methods WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM store_payout_settings WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM store_pickup_settings WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM users WHERE email LIKE $1`, [like]);
    await tx.query(`DELETE FROM wallets WHERE store_id = ANY($1::uuid[])`, [stores]);
    await tx.query(`DELETE FROM stores WHERE id = ANY($1::uuid[])`, [stores]);
  });
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

/**
 * The shopfront's fixtures — milestone 16.
 *
 * ONE PRODUCT OF EVERY SHAPE the browse boards draw, because the interesting bugs are in the shapes
 * rather than in the count: a variant matrix with a hole in it, a product whose every variant is
 * withdrawn, a tracked product under its threshold, a draft that must stay invisible, and one filed in
 * two sections.
 *
 * Called by the storefront suite only. The authorization suites do not need a catalogue and paying for
 * one on every file would slow them all down.
 */
export async function seedStorefront(): Promise<void> {
  // Hours: open every day, 00:00–23:59, so "is the shop open" never depends on when the suite runs.
  // The open/closed logic itself is tested against store_open_state() directly, with fixed timestamps.
  await sql(
    `INSERT INTO store_hours (store_id, day_of_week, opens_at, closes_at)
     SELECT $1, d, '00:00', '23:59' FROM generate_series(1, 7) d`,
    [STORE.a],
  );
  await sql(`UPDATE stores SET public_phone = '+250 78 000 1234' WHERE id = $1`, [STORE.a]);

  await sql(
    `INSERT INTO delivery_zones (store_id, name, fee_amount, eta_min_minutes, eta_max_minutes, position)
          VALUES ($1, 'Near', 1000, 25, 35, 1), ($1, 'Far', 2500, 40, 60, 2)`,
    [STORE.a],
  );

  await sql(
    `INSERT INTO categories (id, store_id, name, position)
          VALUES ($1, $3, 'Mains', 1), ($2, $3, 'Drinks', 2)`,
    [CATALOGUE.mains, CATALOGUE.drinks, STORE.a],
  );

  // (id, name, price, compare_at, tracked, threshold, status, position)
  const products: [string, string, number, number | null, boolean, number, 'active' | 'draft', number][] = [
    [CATALOGUE.juice, 'Passion Juice', 1200, null, false, 0, 'active', 1],
    [CATALOGUE.tee, 'Linen Tee', 18000, null, true, 3, 'active', 2],
    [CATALOGUE.burger, 'Chicken Burger', 3500, null, false, 0, 'active', 3],
    [CATALOGUE.wrap, 'Veggie Wrap', 3000, null, false, 0, 'active', 4],
    [CATALOGUE.cap, 'Cotton Cap', 7000, null, true, 3, 'active', 5],
    [CATALOGUE.secret, 'Unreleased Special', 9000, null, false, 0, 'draft', 6],
    [CATALOGUE.plate, 'Brochette Plate', 5000, 6000, false, 0, 'active', 7],
    [CATALOGUE.water, 'Still Water', 500, null, false, 0, 'active', 8],
    [CATALOGUE.setMenu, 'Set Menu', 8017, null, false, 0, 'active', 9],
  ];
  for (const [id, name, price, compareAt, tracked, threshold, status, position] of products) {
    await sql(
      `INSERT INTO products (id, store_id, name, description, base_price, compare_at_price,
                             low_stock_threshold, track_stock, status, position)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, STORE.a, name, `${name} description`, price, compareAt, threshold, tracked, status, position],
    );
  }

  // Sections, numbered WITHIN each section — V003's own meaning for the column.
  await sql(
    `INSERT INTO product_categories (product_id, category_id, store_id, position) VALUES
       ($1, $9, $11, 1), ($2, $9, $11, 2), ($3, $9, $11, 3), ($4, $9, $11, 4),
       ($5, $9, $11, 5), ($6, $9, $11, 6), ($7, $9, $11, 7),
       ($8, $10, $11, 1),
       -- Still Water is in BOTH, at a different position in each.
       ($8, $9, $11, 8),
       ($12, $9, $11, 9)`,
    [
      CATALOGUE.juice, CATALOGUE.tee, CATALOGUE.burger, CATALOGUE.wrap, CATALOGUE.cap,
      CATALOGUE.secret, CATALOGUE.plate, CATALOGUE.water,
      CATALOGUE.mains, CATALOGUE.drinks, STORE.a, CATALOGUE.setMenu,
    ],
  );

  await sql(
    `INSERT INTO option_groups (id, store_id, name, select_mode, is_required, position) VALUES
       ($1, $4, 'Size',   'one',     true,  1),
       ($2, $4, 'Colour', 'one',     true,  2),
       ($3, $4, 'Extras', 'several', false, 3)`,
    [CATALOGUE.size, CATALOGUE.colour, CATALOGUE.extras, STORE.a],
  );

  const values: [string, string, string, number][] = [
    [uid(0x200), CATALOGUE.size, 'S', 0],
    [uid(0x201), CATALOGUE.size, 'M', 0],
    [uid(0x210), CATALOGUE.colour, 'Black', 0],
    [uid(0x211), CATALOGUE.colour, 'Sand', 0],
    [uid(0x220), CATALOGUE.extras, 'Extra cheese', 500],
    [uid(0x221), CATALOGUE.extras, 'Extra chilli', 300],
  ];
  for (const [id, group, label, delta] of values) {
    await sql(
      `INSERT INTO option_values (id, option_group_id, store_id, label, price_delta, position)
            VALUES ($1, $2, $3, $4, $5, 1)`,
      [id, group, STORE.a, label, delta],
    );
  }

  await sql(
    `INSERT INTO product_option_groups (product_id, option_group_id, store_id, position) VALUES
       ($1, $3, $5, 1), ($1, $4, $5, 2), ($2, $6, $5, 1)`,
    [CATALOGUE.tee, CATALOGUE.burger, CATALOGUE.size, CATALOGUE.colour, STORE.a, CATALOGUE.extras],
  );

  // The tee's matrix: S/Black, S/Sand, M/Black, M/Sand. M/Sand is counted down to nothing, so exactly
  // one combination is struck through and "fewestLeft" has something to report.
  //
  // IN ONE TRANSACTION, and not by preference. V003's matrix rule — "every variant must name one value
  // from EVERY single-select group its product offers" — is a DEFERRABLE INITIALLY DEFERRED constraint
  // trigger, so it fires at COMMIT. sql() commits each statement on its own, which means a variant
  // inserted by itself is checked before its values exist and is refused for being incomplete. The
  // constraint is right; writing the two halves outside a transaction was not.
  const matrix: [string, string, string, number][] = [
    [uid(0x300), uid(0x200), uid(0x210), 7],
    [uid(0x301), uid(0x200), uid(0x211), 5],
    [uid(0x302), uid(0x201), uid(0x210), 2],
    [uid(0x303), uid(0x201), uid(0x211), 0],
  ];
  await withTransaction(async (tx) => {
    for (const [variant, size, colour, stock] of matrix) {
      await tx.query(
        `INSERT INTO product_variants (id, product_id, store_id, sku, stock_quantity, is_default, position)
              VALUES ($1, $2, $3, $4, $5, $6, 1)`,
        [variant, CATALOGUE.tee, STORE.a, `TEE-${variant.slice(-3)}`, stock, variant === uid(0x300)],
      );
      await tx.query(
        `INSERT INTO product_variant_values (variant_id, option_group_id, option_value_id, product_id)
              VALUES ($1, $2, $3, $5), ($1, $4, $6, $5)`,
        [variant, CATALOGUE.size, size, CATALOGUE.colour, CATALOGUE.tee, colour],
      );
    }
  });

  // A default variant each for everything without a matrix. V003: every product has at least one.
  const singles: [string, string, number | null, boolean][] = [
    [uid(0x310), CATALOGUE.juice, null, true],
    [uid(0x311), CATALOGUE.burger, null, true],
    // Withdrawn rather than counted to zero, which is the other way to be sold out.
    [uid(0x312), CATALOGUE.wrap, null, false],
    [uid(0x313), CATALOGUE.cap, 2, true],
    [uid(0x314), CATALOGUE.secret, null, true],
    [uid(0x315), CATALOGUE.plate, null, true],
    [uid(0x316), CATALOGUE.water, null, true],
    [uid(0x317), CATALOGUE.setMenu, null, true],
  ];
  for (const [variant, product, stock, available] of singles) {
    await sql(
      `INSERT INTO product_variants (id, product_id, store_id, stock_quantity, is_available, is_default, position)
            VALUES ($1, $2, $3, $4, $5, true, 1)`,
      [variant, product, STORE.a, stock, available],
    );
  }

  // An automatic promotion with a banner, live at every moment: no dates, no days, no hours.
  await sql(
    `INSERT INTO promotions (id, store_id, kind, discount_type, percent_off, banner_title, banner_subtitle)
          VALUES ($1, $2, 'automatic', 'percentage', 10, 'Ten per cent off this week', 'Applied automatically at checkout.')`,
    [CATALOGUE.promo, STORE.a],
  );

  // A DELIVERED order for customer A, with one line of the juice — so exactly one product on this
  // shopfront can be reviewed, and the rest answer "nothing to review". V009 makes that structural.
  //
  // ONE TRANSACTION, for the same reason the matrix above needs one: V004 requires an order to have at
  // least one line and enforces it with a deferred constraint trigger, so an order written by itself is
  // refused at its own commit. Two of these in one fixture is a pattern worth naming — the schema's
  // invariants are about SETS of rows, and a fixture that writes rows one statement at a time is
  // asserting things the application never does.
  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key, customer_user_id,
                           delivery_address, fulfilment_type, status, payment_method, currency, subtotal_amount)
            VALUES ($1, $2, 9001, 'trk_storefront_1', 'idem_storefront_1', $3,
                    'KG 11 Ave, Kigali', 'delivery', 'delivered', 'cash', 'RWF', 1200)`,
      [CATALOGUE.order, STORE.a, USER.customerA],
    );
    await tx.query(
      `INSERT INTO order_items (id, order_id, store_id, variant_id, product_name, unit_price_amount, quantity)
            VALUES ($1, $2, $3, $4, 'Passion Juice', 1200, 1)`,
      [uid(0x400), CATALOGUE.order, STORE.a, uid(0x310)],
    );
  });
}

/**
 * The merchant console's fixtures — milestone 19.
 *
 * WHAT THE DASHBOARD AND THE ALERT NEED IS ORDERS WITH DIFFERENT AGES AND STATUSES, because almost every figure
 * on the screen is a question about which of those it counts. Two pending orders rather than one, and the older
 * one placed half an hour ago: the alert is specified as "the order that has been waiting longest, not the newest
 * one", and with a single pending order that assertion cannot fail.
 *
 * EVERY ORDER IS WRITTEN IN ITS OWN TRANSACTION for the reason seedStorefront() gives above — V004 requires an
 * order to have at least one line and enforces it with a deferred constraint trigger, so an order written by
 * itself is refused at its own commit.
 *
 * `placed_at` IS SET EXPLICITLY AND `status` IS WRITTEN DIRECTLY. Walking each order through
 * order_status_transitions would be truer to production and is what db/seeds does, but these fixtures exist to
 * fix the READ side: the dashboard's counts, the alert's choice and the badges. The one transition this milestone
 * writes — pending → approved — is tested through the endpoint, where the trigger is live.
 */
export const CONSOLE = {
  /** Pending, 30 minutes old. The alert must choose this one. */
  oldestPending: uid(0x500),
  /** Pending, 2 minutes old. */
  newestPending: uid(0x501),
  /** Already accepted, so it counts in "orders today" and not in "waiting". */
  accepted: uid(0x502),
  review: uid(0x510),
} as const;

/** Milestone 20 — one order per state the Orders board's own actions need. */
export const ORDERS_BOARD = {
  approvedForKitchen: uid(0x51f),
  preparing: uid(0x520),
  readyDelivery: uid(0x521),
  readyPickupCash: uid(0x522),
  assigned: uid(0x523),
  out: uid(0x524),
  deliveredCashUnconfirmed: uid(0x525),
  deliveredPaid: uid(0x526),
  returnedMomo: uid(0x527),
  /** A separate returned order from returnedMomo's, so closing one and retrying the other cannot collide. */
  returnedForRetry: uid(0x528),
} as const;

/**
 * Returns the complaint's id, because the fixture does not choose it.
 *
 * A COMPLAINT IS FILED THROUGH file_complaint(), not written row by row. V008 requires a complaint to have at
 * least one event and enforces it with a deferred constraint, so an INSERT on its own is refused at commit —
 * and the function is what the storefront's own route calls, so the fixture and production build the same thing.
 */
export async function seedConsole(): Promise<{ complaintId: string }> {
  const orders: [string, number, string, number, string][] = [
    [CONSOLE.oldestPending, 9002, 'pending', 30, '10500'],
    [CONSOLE.newestPending, 9003, 'pending', 2, '4000'],
    [CONSOLE.accepted, 9004, 'approved', 45, '7300'],
  ];

  for (const [id, number, status, minutesAgo, subtotal] of orders) {
    await withTransaction(async (tx) => {
      await tx.query(
        // paid_at IS NOT DECORATION: V004's orders_paid_at_agrees makes "paid" and "when" the same fact, so a
        // paid order without a timestamp is refused. The alert prints "paid by MoMo", so these are paid.
        `INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key, guest_name, guest_phone,
                             delivery_address, fulfilment_type, status, payment_method, payment_status, currency,
                             subtotal_amount, placed_at, paid_at)
              VALUES ($1, $2, $3, $4, $5, 'Aimable Kayitare', '078 000 0001',
                      'KG 11 Ave, Kigali', 'delivery', $6, 'mtn_momo', 'paid', 'RWF', $7,
                      now() - make_interval(mins => $8), now() - make_interval(mins => $8))`,
        [id, STORE.a, number, `trk_console_${number}`, `idem_console_${number}`, status, subtotal, minutesAgo],
      );
      await tx.query(
        `INSERT INTO order_items (order_id, store_id, variant_id, product_name, unit_price_amount, quantity)
              VALUES ($1, $2, $3, 'Passion Juice', $4, 1)`,
        [id, STORE.a, uid(0x310), subtotal],
      );
    });
  }

  // A review with no reply — which is what the sidebar's Reviews badge counts. The suite adds the reply itself
  // and watches the badge clear, because "unanswered" is the rule worth testing rather than the number.
  await sql(
    `INSERT INTO reviews (id, store_id, product_id, order_id, order_item_id, customer_user_id, rating, body)
       SELECT $1, $2, $3, $4, i.id, $5, 4, 'Good, would order again.'
         FROM order_items i WHERE i.order_id = $4 LIMIT 1`,
    [CONSOLE.review, STORE.a, CATALOGUE.juice, CATALOGUE.order, USER.customerA],
  );

  // An open complaint, for the Complaints badge. The delivered order is the only one that can carry one, and
  // the customer comes from the order rather than from the caller — which is the function's own rule.
  const { rows } = await sql<{ id: string }>(`SELECT file_complaint($1, $2, $3, $4) AS id`, [
    CATALOGUE.order,
    'item_missing',
    'The juice was not in the bag.',
    USER.customerA,
  ]);
  const complaintId = rows[0]?.id;
  if (complaintId === undefined) throw new Error('file_complaint returned no id');
  return { complaintId };
}

/**
 * One order per state `storeOrders.ts`'s own actions need — milestone 20. Same reasoning as `seedConsole()`:
 * inserted directly at the status each test wants rather than walked through the machine, because these
 * fixtures are for the READ side and for the ONE transition each test exercises through the endpoint, where
 * the trigger is live either way.
 */
export async function seedOrdersBoard(): Promise<void> {
  const base = {
    approvedForKitchen: ['approved', 'delivery', 'mtn_momo', 'unpaid', null] as const,
    preparing: ['preparing', 'delivery', 'mtn_momo', 'unpaid', null] as const,
    readyDelivery: ['ready', 'delivery', 'mtn_momo', 'unpaid', null] as const,
    readyPickupCash: ['ready', 'pickup', 'cash', 'unpaid', null] as const,
    assigned: ['assigned', 'delivery', 'mtn_momo', 'unpaid', USER.riderA] as const,
    out: ['out', 'delivery', 'cash', 'unpaid', USER.riderA] as const,
    deliveredCashUnconfirmed: ['delivered', 'delivery', 'cash', 'unpaid', USER.riderA] as const,
    deliveredPaid: ['delivered', 'delivery', 'mtn_momo', 'paid', null] as const,
    returnedMomo: ['returned', 'delivery', 'mtn_momo', 'paid', USER.riderA] as const,
    returnedForRetry: ['returned', 'delivery', 'cash', 'unpaid', USER.riderA] as const,
  } as const;

  let number = 9600;
  for (const [key, [status, fulfil, method, payStatus, rider]] of Object.entries(base)) {
    number += 1;
    const id = ORDERS_BOARD[key as keyof typeof ORDERS_BOARD];
    const address = fulfil === 'delivery' ? 'KG 11 Ave, Kigali' : null;
    const paidAt = payStatus === 'paid' ? new Date() : null;
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO orders (id, store_id, order_number, tracking_code, idempotency_key, guest_name, guest_phone,
                             delivery_address, fulfilment_type, status, payment_method, payment_status, paid_at,
                             currency, subtotal_amount, rider_user_id)
              VALUES ($1, $2, $3, $4, $5, 'A Customer', '078 000 0002',
                      $6, $7, $8, $9, $10, $11, 'RWF', 8000, $12)`,
        [id, STORE.a, number, `trk_board_${number}`, `idem_orders_board_${number}`, address, fulfil, status, method, payStatus, paidAt, rider],
      );
      await tx.query(
        `INSERT INTO order_items (order_id, store_id, variant_id, product_name, unit_price_amount, quantity)
              VALUES ($1, $2, $3, 'Passion Juice', 8000, 1)`,
        [id, STORE.a, uid(0x310)],
      );
    });
  }

  // returnedMomo needs its escrow released to be refundable the way a real delivered-then-returned order's
  // would be — the same fact the DB suite (db/scripts/test-orders-console.sh) sets up by hand.
  await sql(`UPDATE orders SET settlement_status = 'released' WHERE id = $1`, [ORDERS_BOARD.returnedMomo]);
}

/** The notifications the panel reads. Written through notify(), so V010 checks the payload keys as in production. */
export async function seedNotifications(complaintId: string): Promise<void> {
  await sql(
    `SELECT notify($1, 'order_placed', $2, $3::jsonb, NULL, $4, NULL, NULL)`,
    [
      STORE.a,
      `order_placed:${CONSOLE.oldestPending}`,
      JSON.stringify({ order_number: 9002, total_amount: '10500', customer_name: 'Aimable K.' }),
      CONSOLE.oldestPending,
    ],
  );
  await sql(
    `SELECT notify($1, 'complaint_filed', $2, $3::jsonb, NULL, NULL, $4, NULL)`,
    [
      STORE.a,
      `complaint:${complaintId}`,
      JSON.stringify({ order_number: 9001, reason: 'item_missing', customer_name: 'Customer A' }),
      complaintId,
    ],
  );
  // THE ONE A MANAGER MUST NOT SEE. §5.4: "can't see payouts, the wallet or store settings", and V010 enforces it
  // with visible_to_roles rather than with a filter in an endpoint — which is what the suite proves.
  //
  // `identity_verified` RATHER THAN `payout_sent`, and the reason is the schema again: a payout notification's
  // subject is a withdrawal, and V010 refuses one without it — "a payout_sent notification is about a withdrawal,
  // and none was given". Minting a real withdrawal means KYC, a verified store and a wallet with money in it,
  // which is three milestones' worth of fixture for a rule that both types share: both are visible to
  // {owner, admin} only, and this one needs no subject at all.
  await sql(
    `SELECT notify($1, 'identity_verified', $2, '{}'::jsonb, NULL, NULL, NULL, NULL, NULL)`,
    [STORE.a, `kyc:${STORE.a}`],
  );
}

/** How many reviews exist for a product, hidden ones included. */
export async function countReviews(productId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM reviews WHERE product_id = $1`,
    [productId],
  );
  return Number(rows[0]?.n ?? '0');
}

/** The cart lines a shopper holds at a store, for asserting the merge rather than trusting the answer. */
export async function cartLines(
  storeId: string,
  sessionId: string,
): Promise<{ quantity: number; signature: string }[]> {
  const { rows } = await db.query<{ quantity: number; option_signature: string }>(
    `SELECT i.quantity, i.option_signature
       FROM cart_items i JOIN carts c ON c.id = i.cart_id
      WHERE c.store_id = $1 AND c.anonymous_session_id = $2
      ORDER BY i.created_at, i.id`,
    [storeId, sessionId],
  );
  return rows.map((r) => ({ quantity: r.quantity, signature: r.option_signature }));
}
