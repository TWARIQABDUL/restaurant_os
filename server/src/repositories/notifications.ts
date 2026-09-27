// server/src/repositories/notifications.ts — milestone 19.
//
// The bell in the sidebar and the panel behind it. V010 built all of this; nothing here decides anything.
//
// WHAT V010 ALREADY SETTLED, so that this file does not re-litigate it:
//
//   * WHO SEES A NOTIFICATION is the type's business, not a query's. `notification_is_for()` reads the audience
//     off `notification_types`, so a notification addressed to store staff reaches the roles that type names —
//     and a manager who cannot read the wallet does not get told about a payout.
//   * UNREAD IS TWO THINGS AT ONCE: an individual read row, and a per-person watermark from "Mark all as read".
//     One function owns that, so the bell's count and the panel's list cannot disagree about it.
//   * THE CURSOR IS THE WHOLE SORT KEY, (created_at, id), because six notifications written by one transaction
//     share its now() exactly and a timestamp-only cursor steps over five of them.
//   * SOUND IS PER DEVICE, identified by a server-issued cookie — which is the only way to honour
//     `Notifications`' own wording ("Sound is off for this device") with no browser storage (§2.5). A merchant
//     can leave the chime on at the counter tablet and off on their own phone.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';

/** V010's five tones, which map onto the UI kit's status tones. */
export type NotificationTone = 'info' | 'good' | 'bad' | 'attention' | 'progress';

export type InboxItem = {
  id: string;
  type: string;
  tone: NotificationTone;
  /** The merchant-console path this notification is about: /app/orders, /app/money, … */
  route: string;
  payload: Record<string, unknown>;
  orderId: string | null;
  complaintId: string | null;
  reviewId: string | null;
  withdrawalId: string | null;
  unread: boolean;
  createdAt: Date;
};

export type InboxCursor = { createdAt: string; id: string };

export async function inbox(
  userId: string,
  storeId: string,
  options: { limit?: number; before?: InboxCursor | null; unreadOnly?: boolean } = {},
  on: Queryable = db,
): Promise<{ items: InboxItem[]; nextCursor: InboxCursor | null }> {
  const limit = Math.min(Math.max(1, options.limit ?? 20), 50);
  const before = options.before ?? null;

  // One more than asked for, to know whether there is another page without counting a growing table.
  const { rows } = await on.query<{
    notification_id: string;
    type_code: string;
    tone: NotificationTone;
    route: string;
    payload: Record<string, unknown> | null;
    order_id: string | null;
    complaint_id: string | null;
    review_id: string | null;
    withdrawal_id: string | null;
    is_unread: boolean;
    created_at: Date;
  }>(
    `SELECT notification_id, type_code, tone, route, payload,
            order_id, complaint_id, review_id, withdrawal_id, is_unread, created_at
       FROM notification_inbox($1, $2, $3, $4, $5, $6)`,
    [userId, storeId, before?.createdAt ?? null, before?.id ?? null, limit + 1, options.unreadOnly ?? false],
  );

  const items: InboxItem[] = rows.slice(0, limit).map((r) => ({
    id: r.notification_id,
    type: r.type_code,
    tone: r.tone,
    route: r.route,
    payload: r.payload ?? {},
    orderId: r.order_id,
    complaintId: r.complaint_id,
    reviewId: r.review_id,
    withdrawalId: r.withdrawal_id,
    unread: r.is_unread,
    createdAt: r.created_at,
  }));

  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? { createdAt: last.createdAt.toISOString(), id: last.id }
      : null;

  return { items, nextCursor };
}

/** The number on the bell. */
export async function unreadCount(userId: string, storeId: string, on: Queryable = db): Promise<number> {
  const { rows } = await on.query<{ n: string }>(
    `SELECT unread_notification_count($1, $2)::text AS n`,
    [userId, storeId],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * Mark one read.
 *
 * V010 RAISES for a notification that is not in this person's inbox, rather than returning false — "Reading
 * something addressed to somebody else is not a read; it is a bug worth hearing about." The route turns that
 * into a 404 so a guessed id says nothing.
 */
export async function markRead(
  notificationId: string,
  userId: string,
  on: Queryable = db,
): Promise<void> {
  await on.query(`SELECT mark_notification_read($1, $2)`, [notificationId, userId]);
}

/** Mark all read, at one store. Monotonic: a second click cannot un-read anything. */
export async function markAllRead(userId: string, storeId: string, on: Queryable = db): Promise<Date> {
  const { rows } = await on.query<{ at: Date }>(
    `SELECT mark_all_notifications_read($1, $2) AS at`,
    [userId, storeId],
  );
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('mark_all_notifications_read returned nothing');
  return at;
}

/** Whether the chime is on for THIS device. Absent means on, which is V010's column default. */
export async function deviceSound(
  deviceToken: string,
  userId: string,
  on: Queryable = db,
): Promise<boolean> {
  const { rows } = await on.query<{ sound_enabled: boolean }>(
    `SELECT sound_enabled FROM notification_devices WHERE device_token = $1 AND user_id = $2`,
    [deviceToken, userId],
  );
  return rows[0]?.sound_enabled ?? true;
}

/**
 * Turn the chime on or off for one device.
 *
 * V010 REFUSES A TOKEN BELONGING TO SOMEBODY ELSE, "so a stolen cookie cannot be reassigned by using it" — which
 * also means the first call for a new device has to create the row, and it does, via its own upsert.
 */
export async function setDeviceSound(
  deviceToken: string,
  userId: string,
  enabled: boolean,
  on: Queryable = db,
): Promise<void> {
  await on.query(`SELECT set_device_sound($1, $2, $3)`, [deviceToken, userId, enabled]);
}

/**
 * The order the new-order alert is about, if one is waiting.
 *
 * `Notifications` draws an alertdialog over whatever the merchant was doing: "New order #1034 · 8,500 RWF …
 * Chime repeats every 20 seconds until someone accepts or opens it. Shows on every signed-in screen at this
 * store." THE LAST SENTENCE IS THE SPECIFICATION: the alert is not per-session state, it is a fact about the
 * store — the oldest order nobody has accepted yet. So it is derived from `orders`, and every signed-in screen
 * that asks gets the same answer, which is what makes "shows on every screen" true without any coordination
 * between them.
 */
export async function pendingAlert(
  storeId: string,
  on: Queryable = db,
): Promise<{
  orderId: string;
  orderNumber: number;
  trackingCode: string;
  customer: string;
  total: string;
  fulfilment: string;
  paymentMethod: string;
  paymentStatus: string;
  deliveryAddress: string | null;
  placedAt: Date;
} | null> {
  const { rows } = await on.query<{
    id: string;
    order_number: number;
    tracking_code: string;
    customer: string;
    total_amount: string;
    fulfilment_type: string;
    payment_method: string;
    payment_status: string;
    delivery_address: string | null;
    placed_at: Date;
  }>(
    `SELECT o.id, o.order_number, o.tracking_code,
            COALESCE(o.guest_name, u.name, 'A customer') AS customer,
            o.total_amount::text, o.fulfilment_type, o.payment_method, o.payment_status,
            o.delivery_address, o.placed_at
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_user_id
      WHERE o.store_id = $1 AND o.status = 'pending'
      -- Oldest first: the alert is about the order that has been waiting longest, not the newest one.
      ORDER BY o.placed_at, o.id
      LIMIT 1`,
    [storeId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        orderId: row.id,
        orderNumber: row.order_number,
        trackingCode: row.tracking_code,
        customer: row.customer,
        total: row.total_amount,
        fulfilment: row.fulfilment_type,
        paymentMethod: row.payment_method,
        paymentStatus: row.payment_status,
        deliveryAddress: row.delivery_address,
        placedAt: row.placed_at,
      };
}
