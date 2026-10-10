// server/src/repositories/orderExport.ts — milestone 28: "Export orders" (project/PrintExports.dc.html, the CSV dialog).
//
// A FILE OF CUSTOMERS' PHONE NUMBERS IS PERSONAL DATA, and the board says so in its own footer: "Phone numbers are included, so this file
// is personal data. It's logged who downloaded it." So the export is audited — who, how many orders, which columns — as a SENSITIVE
// entry, and a download that includes the phone column says that in the entry.
//
// THE PERIOD IS THE STORE'S, NOT THE BROWSER'S: "Today" starts at the store's midnight (V021's store_local), the same rule every other
// screen uses, so a merchant exporting at 23:50 gets the evening they worked.
//
// BOUNDED. 20,000 rows is far beyond any day a small store has had and is not a streaming job; past it the screen says to narrow the
// period rather than building a file in memory that nobody asked for. (The board's "we'll email it if it takes more than a minute" is
// not built: there is no email service, and a synchronous download of this size is seconds.)

import { csvTable } from '../api/csv.ts';
import { badRequest, db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';

export const RANGES = ['today', 'week', 'month', 'last_month'] as const;
export type Range = (typeof RANGES)[number];
export const COLUMNS = ['items', 'customer', 'phone', 'payment', 'rider'] as const;
export type Column = (typeof COLUMNS)[number];
export const MAX_ROWS = 20_000;

/** The window as SQL on the store's own clock; `$1` is the store id. Half-open: [from, to). */
const WINDOW: Record<Range, string> = {
  today: `store_local($1, now())::date, store_local($1, now())::date + 1`,
  week: `store_local($1, now())::date - 6, store_local($1, now())::date + 1`,
  month: `date_trunc('month', store_local($1, now()))::date, store_local($1, now())::date + 1`,
  last_month: `(date_trunc('month', store_local($1, now())) - interval '1 month')::date, date_trunc('month', store_local($1, now()))::date`,
};

const FROM_WHERE = (r: Range): string => `
  FROM orders o
  JOIN stores s ON s.id = o.store_id
  LEFT JOIN users u ON u.id = o.customer_user_id
  LEFT JOIN users rd ON rd.id = o.rider_user_id
  CROSS JOIN LATERAL (SELECT ${WINDOW[r]}) w(d_from, d_to)
 WHERE o.store_id = $1
   AND (o.placed_at AT TIME ZONE s.time_zone) >= w.d_from AND (o.placed_at AT TIME ZONE s.time_zone) < w.d_to`;

export async function count(storeId: string, range: Range, on: Queryable = db): Promise<number> {
  const r = await on.query<{ n: string }>(`SELECT count(*)::text AS n ${FROM_WHERE(range)}`, [storeId]);
  return Number(r.rows[0]!.n);
}

export function parseColumns(raw: unknown): Column[] {
  // Absent means the default set; PRESENT BUT EMPTY means the person unticked everything, which is a file of just the order itself.
  if (raw === undefined) return ['items', 'customer', 'payment'];
  if (typeof raw !== 'string') throw badRequest('That is not a list of columns.', 'INVALID_COLUMN');
  const wanted = raw.split(',').map((c) => c.trim()).filter((c) => c !== '');
  const bad = wanted.find((c) => !(COLUMNS as readonly string[]).includes(c));
  if (bad !== undefined) throw badRequest(`“${bad}” is not a column you can export.`, 'INVALID_COLUMN');
  return COLUMNS.filter((c) => wanted.includes(c));
}

export async function build(storeId: string, range: Range, cols: readonly Column[], on: Queryable = db): Promise<{ csv: string; rows: number; filename: string }> {
  const n = await count(storeId, range, on);
  if (n > MAX_ROWS) throw badRequest(`That is ${n.toLocaleString('en-US')} orders — more than one file holds. Choose a shorter period.`, 'TOO_MANY_ROWS');

  const r = await on.query<{
    order_number: number; placed_local: string; status: string; fulfilment_type: string; total_amount: string; currency: string; payment_method: string; payment_status: string;
    cust: string | null; phone: string | null; rider: string | null; delivered_local: string | null; items: string | null; day: string;
  }>(
    `SELECT o.order_number, to_char(o.placed_at AT TIME ZONE s.time_zone, 'YYYY-MM-DD HH24:MI') AS placed_local, o.status, o.fulfilment_type, o.total_amount::text, o.currency,
            o.payment_method, o.payment_status, COALESCE(u.name, o.guest_name) AS cust, COALESCE(u.phone, o.guest_phone) AS phone, rd.name AS rider,
            to_char(o.delivered_at AT TIME ZONE s.time_zone, 'YYYY-MM-DD HH24:MI') AS delivered_local,
            (SELECT string_agg(oi.quantity || '× ' || oi.product_name || CASE WHEN oi.variant_label = '' THEN '' ELSE ' (' || oi.variant_label || ')' END, '; ' ORDER BY oi.created_at, oi.id)
               FROM order_items oi WHERE oi.order_id = o.id) AS items,
            to_char(w.d_from, 'YYYY-MM-DD') AS day
     ${FROM_WHERE(range)}
     ORDER BY o.placed_at, o.id
     LIMIT ${MAX_ROWS}`,
    [storeId],
  );

  const header = ['Order', 'Placed', 'Status', 'Type', 'Total', 'Currency', ...(cols.includes('items') ? ['Items'] : []), ...(cols.includes('customer') ? ['Customer'] : []), ...(cols.includes('phone') ? ['Customer phone'] : []), ...(cols.includes('payment') ? ['Payment method', 'Payment status'] : []), ...(cols.includes('rider') ? ['Rider', 'Delivered'] : [])];
  const rows = r.rows.map((x) => [
    x.order_number, x.placed_local, x.status, x.fulfilment_type, x.total_amount, x.currency,
    ...(cols.includes('items') ? [x.items] : []), ...(cols.includes('customer') ? [x.cust] : []), ...(cols.includes('phone') ? [x.phone] : []),
    ...(cols.includes('payment') ? [x.payment_method, x.payment_status] : []), ...(cols.includes('rider') ? [x.rider, x.delivered_local] : []),
  ]);
  // The file is named for what it holds: the first day of the period, then the period — orders-2026-10-01-month.csv.
  const from = r.rows[0]?.day ?? new Date().toISOString().slice(0, 10);
  return { csv: csvTable(header, rows), rows: rows.length, filename: `orders-${from}-${range.replace('_', '-')}.csv` };
}
