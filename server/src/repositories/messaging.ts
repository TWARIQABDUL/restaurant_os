// server/src/repositories/messaging.ts — milestone 28: turning what happened into messages that are waiting to be sent.
//
// THE SWEEPS READ EVENTS THE SYSTEM ALREADY RECORDS; THEY ARE NOT CALLED FROM THE PLACES THINGS HAPPEN. An order's status moving is
// already an append-only row in order_events; an identity decision is already a notification; a payout failing is already a withdrawal
// row. Wiring a "send a text" call into each of those eleven code paths would put messaging in the middle of the money and the order
// machine and make it a way for them to fail. Instead a timer asks "what happened in the last two hours that has not been told?" and
// enqueues it — idempotently (message_outbox.idempotency_key), so asking twice, from two processes, or after a crash, sends nothing twice.
//
// TWO HOURS, AND NOT MORE. A text about an order moving, delivered the morning after the server was down, is worse than none: "your
// order is ready" at breakfast. The window is MESSAGE_WINDOW_MINUTES (default 120); anything older than it when the sweep first sees it
// is stale and is not sent.
//
// A MESSAGE WITH NOWHERE TO GO IS RECORDED, NOT DROPPED. An order with no phone number gets a `skipped` row for the SMS, so "why didn't
// they hear from us?" has an answer in the table.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import { MESSAGE_LABEL, formatMoney, renderCustomerEmail, renderEmailHtml, renderSms, senderId } from '../core.ts';
import type { CurrencyFormat, CustomerMessage, MessageContext, MessageKey } from '../core.ts';

export const windowMinutes = (): number => {
  const n = Number(process.env['MESSAGE_WINDOW_MINUTES']);
  return Number.isInteger(n) && n > 0 ? n : 120;
};

/** The public address of the storefront, for the tracking link. CLIENT_URL is already what CORS and CSRF trust. */
export const baseUrl = (): string => (process.env['CLIENT_URL'] ?? 'http://localhost:5173').replace(/\/+$/, '');

/** "078 812 3456" → "250788123456"; already-international numbers pass through. Digits only: gateways differ on "+", none on digits. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `${process.env['MOMO_DEFAULT_COUNTRY_CODE'] ?? '250'}${d.slice(1)}`;
  return d.length >= 9 && d.length <= 15 ? d : null;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type Enqueue = {
  storeId: string | null;
  orderId: string | null;
  channel: 'sms' | 'email';
  template: MessageKey;
  audience: 'customer' | 'merchant' | 'rider';
  recipient: string | null;
  sender: string;
  subject?: string;
  body: string;
  bodyHtml?: string;
  key: string;
};

/** Writes one message. Returns true if it was new. A missing recipient is a `skipped` row, so the gap is on the record. */
export async function enqueue(m: Enqueue, on: Queryable = db): Promise<boolean> {
  const ok = m.recipient !== null && m.recipient.trim() !== '';
  const r = await on.query(
    `INSERT INTO message_outbox (store_id, order_id, channel, template, audience, recipient, sender, subject, body, body_html, idempotency_key, status, last_error)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [m.storeId, m.orderId, m.channel, m.template, m.audience, ok ? m.recipient : 'unknown', m.sender, m.subject ?? null, m.body, m.bodyHtml ?? null, m.key, ok ? 'queued' : 'skipped', ok ? null : `No ${m.channel === 'sms' ? 'phone number' : 'email address'} on file.`],
  );
  return (r.rowCount ?? 0) > 0;
}

type OrderEventRow = {
  event_id: string; to_status: string; from_status: string | null; reason: string | null; order_id: string; order_number: number; tracking_code: string; total: string; currency: string;
  payment_method: string; payment_status: string; fulfilment: string; address: string | null; cash_due: string | null; delivered_at: Date | null; placed_at: Date;
  store_id: string; store_name: string; slug: string; store_phone: string | null; time_zone: string; brand: string | null;
  customer: string | null; phone: string | null; email: string | null; rider: string | null; rider_phone: string | null; plate: string | null; owner_phone: string | null;
  symbol: string; symbol_position: 'before' | 'after'; decimals: number; separator: string; rounding: string;
};

const clock = (d: Date, tz: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const stamp = (d: Date, tz: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(',', ',');

/** Everything a message about an order needs, shared by the two ways an order reaches the sweep (it MOVED, or it was PLACED). */
const ORDER_COLS = `o.id AS order_id, o.order_number, o.tracking_code, o.total_amount::text AS total, o.currency,
            o.payment_method, o.payment_status, o.fulfilment_type AS fulfilment, o.delivery_address AS address, o.cash_due_amount::text AS cash_due, o.delivered_at, o.placed_at,
            s.id AS store_id, s.name AS store_name, s.slug, s.public_phone AS store_phone, s.time_zone,
            (SELECT t.input_brand FROM store_themes t WHERE t.store_id = s.id AND t.status = 'published') AS brand,
            COALESCE(cu.name, o.guest_name) AS customer, COALESCE(cu.phone, o.guest_phone) AS phone, COALESCE(cu.email, o.guest_email) AS email,
            rd.name AS rider, rd.phone AS rider_phone, rp.plate_number AS plate, ow.phone AS owner_phone,
            c.symbol, c.symbol_position, c.decimals, c.thousands_separator AS separator, c.cash_rounding::text AS rounding`;

const ORDER_JOINS = `JOIN stores s ON s.id = o.store_id
       JOIN currencies c ON c.code = o.currency
       LEFT JOIN users cu ON cu.id = o.customer_user_id
       LEFT JOIN users rd ON rd.id = o.rider_user_id
       LEFT JOIN rider_profiles rp ON rp.user_id = o.rider_user_id AND rp.store_id = o.store_id
       LEFT JOIN LATERAL (SELECT u.phone FROM store_members m JOIN users u ON u.id = m.user_id WHERE m.store_id = s.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) ow ON true`;

/**
 * Orders moving → the customer is told (SMS and email), the owner hears of a new one, the rider hears of a job.
 *
 * PLACING AN ORDER WRITES NO order_events ROW — an order's history starts at its first transition — so "we got your order" and the owner's
 * "new order" come from the orders table by when they were placed. Everything after that comes from the events.
 */
export async function sweepOrderEvents(on: Queryable = db): Promise<number> {
  const moved = await on.query<OrderEventRow>(
    `SELECT e.id::text AS event_id, e.to_status, e.from_status, e.reason, ${ORDER_COLS}
       FROM order_events e JOIN orders o ON o.id = e.order_id AND o.store_id = e.store_id ${ORDER_JOINS}
      WHERE e.created_at > now() - make_interval(mins => $1)
        AND e.to_status IN ('approved', 'ready', 'assigned', 'out', 'delivered', 'collected', 'rejected', 'cancelled')
      ORDER BY e.created_at, e.id`,
    [windowMinutes()],
  );
  const placed = await on.query<OrderEventRow>(
    `SELECT o.id::text AS event_id, 'pending'::text AS to_status, NULL::text AS from_status, NULL::text AS reason, ${ORDER_COLS}
       FROM orders o ${ORDER_JOINS}
      WHERE o.placed_at > now() - make_interval(mins => $1)
      ORDER BY o.placed_at, o.id`,
    [windowMinutes()],
  );
  const r = { rows: [...placed.rows, ...moved.rows] };

  // The email shows the order's lines, so read them once for every order in the batch rather than once per event.
  const orderIds = [...new Set(r.rows.map((x) => x.order_id))];
  const linesOf = new Map<string, { quantity: number; product_name: string; variant_label: string; line_total: string }[]>();
  if (orderIds.length > 0) {
    const l = await on.query<{ order_id: string; quantity: number; product_name: string; variant_label: string; line_total: string }>(
      `SELECT order_id, quantity, product_name, variant_label, line_total_amount::text AS line_total FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY created_at, id`,
      [orderIds],
    );
    for (const row of l.rows) linesOf.set(row.order_id, [...(linesOf.get(row.order_id) ?? []), row]);
  }

  let added = 0;
  for (const x of r.rows) {
    const money = (v: string): string => formatMoney(v, { code: x.currency, symbol: x.symbol, symbolPosition: x.symbol_position, decimals: x.decimals, thousandsSeparator: x.separator, cashRounding: Number(x.rounding) } as CurrencyFormat);
    const track = `${baseUrl()}/${x.slug}/orders/${x.tracking_code}`;
    const cash = x.payment_method === 'cash' && x.payment_status !== 'paid';
    const ctx: MessageContext = {
      store: x.store_name, number: x.order_number, total: money(x.total), customer: x.customer?.split(' ')[0] ?? undefined, link: track, rider: x.rider?.split(' ')[0] ?? undefined,
      ...(x.plate === null ? {} : { plate: x.plate }), ...(x.rider_phone === null ? {} : { riderPhone: x.rider_phone }), ...(cash ? { cashDue: money(x.cash_due ?? x.total) } : {}),
      ...(x.delivered_at === null ? {} : { deliveredAt: clock(x.delivered_at, x.time_zone) }), paid: x.payment_status === 'paid',
      ...(x.reason === null ? {} : { reason: x.reason }), ...(x.to_status === 'cancelled' ? { reason: x.reason ?? 'the order was cancelled' } : {}),
      ...(x.address === null ? {} : { area: x.address.split(',')[0] ?? x.address }),
    };

    // Customer-facing: which template does this move mean?
    const key: CustomerMessage | null =
      x.to_status === 'pending' && x.from_status === null ? 'confirm'
      : x.to_status === 'approved' ? 'approved'
      : x.to_status === 'ready' ? 'ready'
      : x.to_status === 'out' ? 'assigned'
      : x.to_status === 'delivered' || x.to_status === 'collected' ? 'delivered'
      : x.to_status === 'rejected' || x.to_status === 'cancelled' ? 'rejected'
      : null;

    if (key !== null) {
      const sender = senderId(x.store_name);
      if (await enqueue({ storeId: x.store_id, orderId: x.order_id, channel: 'sms', template: key, audience: 'customer', recipient: normalisePhone(x.phone), sender, body: renderSms(key, ctx), key: `order_event:${x.event_id}:customer:sms` }, on)) added += 1;
      const email = x.email !== null && EMAIL.test(x.email) ? x.email : null;
      const rendered = renderCustomerEmail(key, ctx);
      const html = renderEmailHtml(rendered, { name: x.store_name, mark: x.store_name.trim().charAt(0).toUpperCase(), phone: x.store_phone, brand: x.brand ?? '#1D6B47' }, { number: x.order_number, placedAt: stamp(x.placed_at, x.time_zone), lines: (linesOf.get(x.order_id) ?? []).map((l) => ({ quantity: l.quantity, name: l.variant_label === '' ? l.product_name : `${l.product_name} (${l.variant_label})`, amount: money(l.line_total) })), delivery: null, total: money(x.total) }, track);
      if (await enqueue({ storeId: x.store_id, orderId: x.order_id, channel: 'email', template: key, audience: 'customer', recipient: email, sender: x.store_name, subject: rendered.subject, body: `${rendered.head}\n\n${rendered.body}\n\n${rendered.cta}: ${track}`, bodyHtml: html, key: `order_event:${x.event_id}:customer:email` }, on)) added += 1;
    }

    if (x.to_status === 'pending' && x.from_status === null && (await enqueue({ storeId: x.store_id, orderId: x.order_id, channel: 'sms', template: 'newOrder', audience: 'merchant', recipient: normalisePhone(x.owner_phone), sender: 'VENDLYFY', body: renderSms('newOrder', { ...ctx, link: `${baseUrl()}/app/${x.slug}/orders` }), key: `order_event:${x.event_id}:merchant:sms` }, on))) added += 1;
    if (x.to_status === 'assigned' && (await enqueue({ storeId: x.store_id, orderId: x.order_id, channel: 'sms', template: 'riderJob', audience: 'rider', recipient: normalisePhone(x.rider_phone), sender: 'VENDLYFY', body: renderSms('riderJob', ctx), key: `order_event:${x.event_id}:rider:sms` }, on))) added += 1;
  }
  return added;
}

/** Identity decisions and failed payouts → the owner, by SMS. (The in-app bell already has them; the text is for the person away from it.) */
export async function sweepMerchantEvents(on: Queryable = db): Promise<number> {
  let added = 0;
  const n = await on.query<{ id: string; type_code: string; store_id: string; store_name: string; owner_phone: string | null; note: string | null; part: string | null; method: string | null; dest: string | null; at: string | null }>(
    `SELECT n.id, n.type_code, n.store_id, s.name AS store_name, ow.phone AS owner_phone,
            (SELECT k.decision_note FROM kyc_submissions k WHERE k.store_id = s.id ORDER BY k.updated_at DESC LIMIT 1) AS note,
            (SELECT d.part FROM kyc_submissions k JOIN kyc_documents d ON d.submission_id = k.id AND d.review_outcome = 'retake' AND d.superseded_at IS NULL WHERE k.store_id = s.id ORDER BY k.updated_at DESC LIMIT 1) AS part,
            pm.name AS method, ps.payout_phone AS dest, to_char(ps.automatic_at, 'HH24:MI') AS at
       FROM notifications n
       JOIN stores s ON s.id = n.store_id
       LEFT JOIN LATERAL (SELECT u.phone FROM store_members m JOIN users u ON u.id = m.user_id WHERE m.store_id = s.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) ow ON true
       LEFT JOIN store_payout_settings ps ON ps.store_id = s.id
       LEFT JOIN payment_methods pm ON pm.key = ps.payout_method_key
      WHERE n.created_at > now() - make_interval(mins => $1) AND n.type_code IN ('identity_verified', 'identity_retake')`,
    [windowMinutes()],
  );
  const PART: Record<string, string> = { id_front: 'the front of your ID', id_back: 'the back of your ID', face_video: 'your face video' };
  for (const x of n.rows) {
    const template: MessageKey = x.type_code === 'identity_verified' ? 'kycOk' : 'kycRedo';
    const dest = x.dest === null || x.method === null ? undefined : `${x.method} ${x.dest.replace(/\D/g, '').slice(-9, -6)}•••${x.dest.slice(-4)}`;
    const body = renderSms(template, { store: x.store_name, link: `${baseUrl()}/app/verify`, ...(x.part === null ? {} : { part: PART[x.part] ?? x.part }), ...(x.note === null ? {} : { reason: x.note.length > 70 ? `${x.note.slice(0, 67)}…` : x.note }), ...(dest === undefined ? {} : { payoutTo: dest }), ...(x.at === null ? {} : { payoutAt: x.at }) });
    if (await enqueue({ storeId: x.store_id, orderId: null, channel: 'sms', template, audience: 'merchant', recipient: normalisePhone(x.owner_phone), sender: 'VENDLYFY', body, key: `notification:${x.id}:merchant:sms` }, on)) added += 1;
  }

  const w = await on.query<{ id: string; store_id: string; amount: string; reason: string | null; owner_phone: string | null; currency: string; symbol: string; symbol_position: 'before' | 'after'; decimals: number; separator: string; rounding: string }>(
    `SELECT w.id, w.store_id, w.amount::text, w.failure_reason AS reason, ow.phone AS owner_phone, c.code AS currency, c.symbol, c.symbol_position, c.decimals, c.thousands_separator AS separator, c.cash_rounding::text AS rounding
       FROM withdrawals w JOIN stores s ON s.id = w.store_id JOIN currencies c ON c.code = s.selling_currency
       LEFT JOIN LATERAL (SELECT u.phone FROM store_members m JOIN users u ON u.id = m.user_id WHERE m.store_id = s.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) ow ON true
      WHERE w.status = 'failed' AND w.requested_at > now() - make_interval(mins => $1)`,
    [windowMinutes()],
  );
  for (const x of w.rows) {
    const amount = formatMoney(x.amount, { code: x.currency, symbol: x.symbol, symbolPosition: x.symbol_position, decimals: x.decimals, thousandsSeparator: x.separator, cashRounding: Number(x.rounding) } as CurrencyFormat);
    const short = x.reason === null ? undefined : (x.reason.length > 50 ? `${x.reason.slice(0, 47)}…` : x.reason);
    if (await enqueue({ storeId: x.store_id, orderId: null, channel: 'sms', template: 'payoutFail', audience: 'merchant', recipient: normalisePhone(x.owner_phone), sender: 'VENDLYFY', body: renderSms('payoutFail', { store: 'Vendlyfy', amount, link: `${baseUrl()}/app/money`, ...(short === undefined ? {} : { reason: short }) }), key: `withdrawal_failed:${x.id}:merchant:sms` }, on)) added += 1;
  }
  return added;
}

export const templateLabel = (k: string): string => (MESSAGE_LABEL as Record<string, string>)[k] ?? k;

/** What is waiting, per channel — Platform settings' Health panel reads this. */
export async function queueState(on: Queryable = db): Promise<Record<'sms' | 'email', { queued: number; oldestMinutes: number | null; configured: boolean }>> {
  const r = await on.query<{ channel: 'sms' | 'email'; n: string; oldest: string | null }>(
    `SELECT channel, count(*)::text AS n, (extract(epoch FROM now() - min(queued_at)) / 60)::text AS oldest FROM message_outbox WHERE status = 'queued' GROUP BY channel`,
  );
  const get = (c: 'sms' | 'email'): { queued: number; oldestMinutes: number | null } => {
    const row = r.rows.find((x) => x.channel === c);
    return { queued: row === undefined ? 0 : Number(row.n), oldestMinutes: row?.oldest == null ? null : Math.round(Number(row.oldest)) };
  };
  const configured = (c: 'sms' | 'email'): boolean => (c === 'sms' ? ['log', 'twilio', 'custom'] : ['log', 'sendgrid']).includes((process.env[c === 'sms' ? 'MESSAGING_SMS' : 'MESSAGING_EMAIL'] ?? 'none').trim().toLowerCase());
  return { sms: { ...get('sms'), configured: configured('sms') }, email: { ...get('email'), configured: configured('email') } };
}
