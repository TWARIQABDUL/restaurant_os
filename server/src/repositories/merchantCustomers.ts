// server/src/repositories/merchantCustomers.ts — milestone 24, from project/Customers.dc.html.
//
// "Everyone who ordered, with or without an account. Guests are matched by phone number."
//
// A CUSTOMER IS NOT A ROW — there is no customers table, and adding one would be a second copy of what orders
// already say, kept in step by nothing. A customer is the answer to "who are these orders from", computed:
//
//   key = the last nine digits of their phone (V026's customer_key), or `u:<user id>` for an account with no number.
//
// So a person who ordered once as a guest and later made an account is ONE row, typed Account — which is the
// board's own point ("Guests are matched by phone number") and the case a table keyed on user id gets wrong.
//
// WHAT COUNTS. "Orders" is every order that was not turned away (rejected, cancelled): a customer who ordered ten
// times and had three declined is a customer of seven. "Spent" is only what was actually delivered or collected —
// a pending order is a promise, and a spend figure that counted promises would shrink every time a merchant
// declined one. "Complaints" counts every complaint filed on any of their orders, including closed ones.
//
// THE WHOLE STORE'S ORDERS ARE AGGREGATED ON EACH READ. That is one pass over a store's orders, not over the
// platform's (every statement is `store_id = $1` first), and it is measured against the 30,000-order seed rather
// than assumed — see the comment at `aggregate`. A store large enough for it to matter would take a summary table
// kept by the order functions, which is a decision for when a store is.

import { csvCell } from '../api/csv.ts';
import { db } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';

export type Segment = 'all' | 'regular' | 'account' | 'guest';

export type CustomerRow = {
  key: string;
  name: string;
  phone: string | null;
  orders: number;
  spent: string;
  lastOrderAt: Date;
  account: boolean;
  complaints: number;
};

export type CustomerList = {
  rows: CustomerRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Per segment, for the pill labels: "All · 1,240". Independent of the search, as the board's are. */
  counts: Record<Segment, number>;
};

/** A "regular" is five orders or more — the board's own label: "Regulars (5+ orders)". */
export const REGULAR_AT = 5;
const PAGE = 25;

/**
 * One row per customer, from the store's orders.
 *
 * `array_agg(... ORDER BY placed_at DESC)[1]` takes the NAME AND PHONE FROM THE LATEST ORDER, because a person
 * corrects a misspelt name and changes number, and the latest is what they last called themselves.
 */
const AGGREGATE = `
  WITH base AS (
    SELECT COALESCE(customer_key(u.phone), customer_key(o.guest_phone),
                    CASE WHEN o.customer_user_id IS NOT NULL THEN 'u:' || o.customer_user_id::text END) AS k,
           o.customer_user_id, COALESCE(u.name, o.guest_name) AS name, COALESCE(u.phone, o.guest_phone) AS phone,
           o.total_amount, o.status, o.placed_at, COALESCE(cc.n, 0) AS complaints
      FROM orders o
      LEFT JOIN users u ON u.id = o.customer_user_id
      -- ONE grouped read of the store's complaints, joined — a correlated count per order is one subselect per
      -- row, which measured at about a second for 20,000 orders where the join is a fraction of that.
      LEFT JOIN (SELECT order_id, count(*) AS n FROM complaints WHERE store_id = $1 GROUP BY order_id) cc ON cc.order_id = o.id
     WHERE o.store_id = $1 AND o.status NOT IN ('rejected', 'cancelled')
  ), people AS (
    SELECT k,
           (array_agg(name  ORDER BY placed_at DESC) FILTER (WHERE name  IS NOT NULL))[1] AS name,
           (array_agg(phone ORDER BY placed_at DESC) FILTER (WHERE phone IS NOT NULL))[1] AS phone,
           count(*)                                                                      AS orders,
           COALESCE(sum(total_amount) FILTER (WHERE status IN ('delivered', 'collected')), 0) AS spent,
           max(placed_at)                                                                AS last_at,
           bool_or(customer_user_id IS NOT NULL)                                         AS account,
           sum(complaints)                                                               AS complaints
      FROM base WHERE k IS NOT NULL
     GROUP BY k
  )`;

/** The pool refuses `SELECT *` (§2.3), CTEs included — so the columns are named once. */
const COLS = 'k, name, phone, orders, spent, last_at, account, complaints';

type PeopleRow = {
  k: string;
  name: string | null;
  phone: string | null;
  orders: string;
  spent: string;
  last_at: Date;
  account: boolean;
  complaints: string;
};

const toRow = (r: PeopleRow): CustomerRow => ({
  key: r.k,
  name: r.name ?? 'A customer',
  phone: r.phone,
  orders: Number(r.orders),
  spent: r.spent,
  lastOrderAt: r.last_at,
  account: r.account,
  complaints: Number(r.complaints),
});

const SEGMENT_SQL: Record<Segment, string> = {
  all: 'true',
  regular: `orders >= ${REGULAR_AT}`,
  account: 'account',
  guest: 'NOT account',
};

export async function list(storeId: string, segment: Segment, q: string, page: number, on: Queryable = db): Promise<CustomerList> {
  const search = q.trim();
  const digitsOnly = search.replace(/\D/g, '');
  const params: unknown[] = [storeId, PAGE, (Math.max(1, page) - 1) * PAGE];
  let where = SEGMENT_SQL[segment];
  if (search !== '') {
    params.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const byName = `name ILIKE $${params.length}`;
    // A phone is searched by its digits, so "078 455" finds "0784559012" however either was typed.
    if (digitsOnly.length >= 3) {
      params.push(`%${digitsOnly}%`);
      where += ` AND (${byName} OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE $${params.length})`;
    } else {
      where += ` AND ${byName}`;
    }
  }

  // ONE STATEMENT, ONE AGGREGATION. `people` is referenced three times (the page, the match count, the segment
  // counts), and a CTE read more than once is computed once. The counts ride along as a final row, so a store's
  // orders are read a single time per request — measured, because the first version aggregated them twice.
  const { rows } = await on.query<
    PeopleRow & { part: 'row' | 'counts'; matching: string | null; everyone: string | null; regular: string | null; accounts: string | null; guests: string | null }
  >(
    `${AGGREGATE}, filtered AS (SELECT ${COLS} FROM people WHERE ${where}),
     page AS (SELECT ${COLS} FROM filtered ORDER BY last_at DESC, k LIMIT $2 OFFSET $3)
     SELECT 'row' AS part, k, name, phone, orders::text, spent::text, last_at, account, complaints::text,
            NULL::text AS matching, NULL::text AS everyone, NULL::text AS regular, NULL::text AS accounts, NULL::text AS guests
       FROM page
     UNION ALL
     SELECT 'counts', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            (SELECT count(*) FROM filtered)::text, (SELECT count(*) FROM people)::text,
            (SELECT count(*) FROM people WHERE orders >= ${REGULAR_AT})::text,
            (SELECT count(*) FROM people WHERE account)::text, (SELECT count(*) FROM people WHERE NOT account)::text`,
    params,
  );

  const c = rows.find((r) => r.part === 'counts')!;
  return {
    rows: rows.filter((r) => r.part === 'row').map(toRow),
    total: Number(c.matching),
    page: Math.max(1, page),
    pageSize: PAGE,
    counts: { all: Number(c.everyone), regular: Number(c.regular), account: Number(c.accounts), guest: Number(c.guests) },
  };
}

export type CustomerDetail = CustomerRow & {
  /** The address they order to most often. Null for a pickup-only customer, which the board prints as "Pickup". */
  usualAddress: string | null;
  recent: { id: string; number: number; at: Date; total: string; status: string }[];
  note: string | null;
};

export async function get(storeId: string, key: string, on: Queryable = db): Promise<CustomerDetail | null> {
  const { rows } = await on.query<PeopleRow>(`${AGGREGATE} SELECT k, name, phone, orders::text, spent::text, last_at, account, complaints::text FROM people WHERE k = $2`, [storeId, key]);
  const person = rows[0];
  if (person === undefined) return null;

  // The same identity as AGGREGATE, spelt once more because a WHERE on the computed key needs the expression.
  const own = `COALESCE(customer_key(u.phone), customer_key(o.guest_phone), CASE WHEN o.customer_user_id IS NOT NULL THEN 'u:' || o.customer_user_id::text END) = $2`;

  const address = await on.query<{ address: string }>(
    `SELECT o.delivery_address AS address
       FROM orders o LEFT JOIN users u ON u.id = o.customer_user_id
      WHERE o.store_id = $1 AND o.delivery_address IS NOT NULL AND o.status NOT IN ('rejected', 'cancelled') AND ${own}
      GROUP BY o.delivery_address ORDER BY count(*) DESC, max(o.placed_at) DESC LIMIT 1`,
    [storeId, key],
  );
  const recent = await on.query<{ id: string; order_number: number; placed_at: Date; total: string; status: string }>(
    `SELECT o.id, o.order_number, o.placed_at, o.total_amount::text AS total, o.status
       FROM orders o LEFT JOIN users u ON u.id = o.customer_user_id
      WHERE o.store_id = $1 AND ${own}
      ORDER BY o.placed_at DESC, o.id DESC LIMIT 3`,
    [storeId, key],
  );
  const note = await on.query<{ note: string }>(`SELECT note FROM customer_notes WHERE store_id = $1 AND customer_key = $2`, [storeId, key]);

  return {
    ...toRow(person),
    usualAddress: address.rows[0]?.address ?? null,
    recent: recent.rows.map((r) => ({ id: r.id, number: r.order_number, at: r.placed_at, total: r.total, status: r.status })),
    note: note.rows[0]?.note ?? null,
  };
}

/** An empty note removes the row: "has a note" is the row existing, never an empty string. */
export async function setNote(storeId: string, key: string, note: string, userId: string, tx: Tx): Promise<boolean> {
  const text = note.trim();
  const exists = await tx.query(`${AGGREGATE} SELECT 1 FROM people WHERE k = $2`, [storeId, key]);
  if (exists.rows.length === 0) return false;
  if (text === '') {
    await tx.query(`DELETE FROM customer_notes WHERE store_id = $1 AND customer_key = $2`, [storeId, key]);
  } else {
    await tx.query(
      `INSERT INTO customer_notes (store_id, customer_key, note, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (store_id, customer_key) DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [storeId, key, text.slice(0, 500), userId],
    );
  }
  return true;
}

/** Every customer as CSV, for "Export CSV". */
export async function exportRows(storeId: string, on: Queryable = db): Promise<CustomerRow[]> {
  const { rows } = await on.query<PeopleRow>(
    `${AGGREGATE} SELECT k, name, phone, orders::text, spent::text, last_at, account, complaints::text FROM people ORDER BY last_at DESC, k LIMIT 50000`,
    [storeId],
  );
  return rows.map(toRow);
}

export { csvCell } from '../api/csv.ts';

export function toCsv(rows: CustomerRow[]): string {
  const header = ['Name', 'Phone', 'Orders', 'Spent', 'Last order', 'Type', 'Complaints'].map(csvCell).join(',');
  const lines = rows.map((r) =>
    [r.name, r.phone, r.orders, r.spent, r.lastOrderAt.toISOString().slice(0, 10), r.account ? 'Account' : 'Guest', r.complaints].map(csvCell).join(','),
  );
  return `${[header, ...lines].join('\r\n')}\r\n`;
}
