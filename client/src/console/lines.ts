// client/src/console/lines.ts — milestone 19, from project/Notifications.dc.html.
//
// THE SENTENCES. V010 is explicit that the database stores "The values the sentence needs — order number,
// amount, a name. Never the sentence: that is the industry template's, and it changes when a store changes
// template." This is where the values become the sentence.
//
// WHICH IS WHY EVERY LINE IS BUILT FROM THE TYPE'S `required_payload_keys` AND NOTHING ELSE. V010 checks those
// keys on every write, so a notification "cannot render blank" — and a composer reaching for a key the type
// does not require would reintroduce exactly that. Where the board's fixture shows more than the payload
// carries, the extra clause is dropped rather than invented: its `#1024 delivered` row reads "Jean-Paul N. ·
// paid by MoMo", and `order_delivered` requires order_number and customer_name, so the payment method is not
// ours to print. Guessing it would put a wrong word in front of a merchant, which is worse than a short line.
//
// THE UNKNOWN TYPE IS A LINE, NOT A CRASH. A notification written by a migration this build has never heard of
// still has a tone and a destination, and a panel that threw on it would lose every row after it.

import { formatMoney } from '../app/core.ts';
import type { CurrencyFormat } from '../app/core.ts';
import type { Notification, NotificationTone } from './api.ts';

/** The board's IC map, unchanged. */
const ICONS = {
  order: 'M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6',
  ok: 'M20 6L9 17l-5-5',
  no: 'M6 6l12 12M18 6L6 18',
  bike: 'M6 17a3 3 0 1 0 0 .01M18 17a3 3 0 1 0 0 .01M6 17h6l3-7h3',
  money: 'M3 7h18v12H3zM16 13h2',
  flag: 'M4 21V4h13l-2 4 2 4H4',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  id: 'M4 5h16v14H4zM9 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14 9h4M14 13h4',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
} as const;

type IconName = keyof typeof ICONS;

/**
 * V010's five tones onto the kit's status pairs.
 *
 * ALL FIVE ARE EXACT MATCHES for the board's own values — its TONE map is #E7EEF9/#1F437F for blue,
 * #E4F2E9/#1A7443 for green, #FCE9E7/#B42318 for red, #EDE9F6/#4B3A83 for violet, #FBF0DD/#7A4600 for amber,
 * which are tokens.css's status-info, -success, -danger, -progress and -warn. So the panel needs no colour of
 * its own: the database says which tone, and the token layer says what that looks like.
 */
const TONES: Readonly<Record<NotificationTone, string>> = {
  info: 'bg-status-info text-status-info-fg',
  good: 'bg-status-success text-status-success-fg',
  bad: 'bg-status-danger text-status-danger-fg',
  attention: 'bg-status-warn text-status-warn-fg',
  progress: 'bg-status-progress text-status-progress-fg',
};

export function toneClasses(tone: NotificationTone): string {
  return TONES[tone] ?? TONES.info;
}

/** V005 and V008's five reason codes, with the wording the customer chose from. Shared with the storefront. */
const COMPLAINT_REASONS: Readonly<Record<string, string>> = {
  item_missing: 'Missing item',
  wrong_item: 'Wrong item',
  quality_problem: 'Quality problem',
  arrived_late: 'Arrived late',
  other: 'Something else',
};

/** A person's first name. The board writes "Eric picked up #1026" where the payload holds "Eric Habimana". */
function firstName(value: unknown): string {
  const whole = typeof value === 'string' ? value.trim() : '';
  if (whole === '') return 'Somebody';
  return whole.split(/\s+/)[0] ?? whole;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function orderRef(payload: Record<string, unknown>): string {
  const n = payload['order_number'];
  return typeof n === 'number' ? `#${n}` : typeof n === 'string' ? `#${n}` : 'an order';
}

export type NotificationLine = {
  title: string;
  /** The second line. Empty where the payload has nothing more to say, and the panel then omits it. */
  sub: string;
  icon: string;
  tone: string;
};

/**
 * One notification as two lines and an icon.
 *
 * `money` is the store's formatter, passed in rather than imported, so an amount is written the way the rest
 * of the console writes amounts — §3's "one formatter driven by the currency table".
 */
export function notificationLine(n: Notification, currency: CurrencyFormat): NotificationLine {
  const p = n.payload;
  // Wrapped, because parseDecimal() throws on anything that is not a decimal and a payload is data: one
  // notification written with '8,500' in it must not take the whole panel down with it.
  const money = (value: unknown): string => {
    try {
      return formatMoney(typeof value === 'number' ? String(value) : text(value, '0'), currency);
    } catch {
      return text(value, '—');
    }
  };

  const line = (title: string, sub: string, icon: IconName): NotificationLine => ({
    title,
    sub,
    icon: ICONS[icon],
    tone: toneClasses(n.tone),
  });

  switch (n.type) {
    case 'order_placed':
      return line(
        `New order ${orderRef(p)} · ${money(p['total_amount'])}`,
        `${text(p['customer_name'], 'A customer')} · waiting for you to accept`,
        'order',
      );

    case 'order_picked_up':
      // "On the way to Kacyiru" on the board; the type requires no address, so the destination is not named.
      return line(`${firstName(p['rider_name'])} picked up ${orderRef(p)}`, 'On the way to the customer', 'bike');

    case 'order_delivered':
      return line(`${orderRef(p)} delivered`, text(p['customer_name'], 'A customer'), 'ok');

    case 'order_declined':
      return line(
        `${orderRef(p)} declined by ${firstName(p['actor_name'])}`,
        text(p['reason'], 'No reason given'),
        'no',
      );

    case 'complaint_filed': {
      const reason = text(p['reason']);
      const label = COMPLAINT_REASONS[reason] ?? reason;
      const who = text(p['customer_name'], 'A customer');
      return line(`New complaint on ${orderRef(p)}`, label === '' ? who : `${label} · ${who}`, 'flag');
    }

    case 'review_posted': {
      const rating = p['rating'];
      const stars = typeof rating === 'number' ? `${rating}★` : '';
      const product = text(p['product_name'], 'a product');
      // The board quotes the review. `comment` is not a required key — a rating with no words is a review, and
      // the product page has copy for it — so the quote appears only when there is one.
      const comment = text(p['comment']);
      return line(
        stars === '' ? `New review on ${product}` : `New ${stars} review on ${product}`,
        comment === '' ? 'No comment, just a rating.' : `“${comment}”`,
        'star',
      );
    }

    case 'payout_sent':
      return line(
        `Payout sent · ${money(p['amount'])}`,
        `To ${text(p['destination'], 'your account')}`,
        'money',
      );

    case 'identity_verified':
      return line('Identity verified', 'Payouts are unlocked', 'id');

    default:
      // A type this build does not know. The code is readable enough to act on — `order_returned` reads as
      // "Order returned" — and the row still leads somewhere, because the route came from the database.
      return line(
        n.type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        '',
        'bell',
      );
  }
}

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

/**
 * "2 min ago", "2 h ago", "Today 08:00", "Yesterday" — the board's own four shapes, in the STORE's time zone.
 *
 * THE ZONE MATTERS FOR THE WORD "TODAY" and for nothing else here: an elapsed count is the same everywhere, but
 * whether 23:30 was today depends on whose midnight you mean, and V021 settled that it is the store's.
 */
export function relativeWhen(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const minutes = Math.floor((now.getTime() - at.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 6) return `${hours} h ago`;

  const day = (d: Date): string => localParts(d, timeZone).date;
  const clock = localParts(at, timeZone).time;
  if (day(at) === day(now)) return `Today ${clock}`;

  const yesterday = new Date(now.getTime() - 86_400_000);
  if (day(at) === day(yesterday)) return 'Yesterday';

  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(at);
}

/** A date and a clock time in one zone. Both from Intl, so no arithmetic here assumes an offset. */
function localParts(at: Date, timeZone: string): { date: string; time: string } {
  try {
    return {
      date: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(at),
      time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(at),
    };
  } catch {
    // An unknown zone would throw. V021 validates `stores.time_zone` against pg_timezone_names on write, so
    // this is unreachable through the app — and falling back to the viewer's own zone is better than a blank.
    return {
      date: new Intl.DateTimeFormat('en-CA').format(at),
      time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(at),
    };
  }
}

/** "Tuesday, 23 September" — the dashboard's own dateline, from the store's local date. */
export function dateline(localDate: string, timeZone: string): string {
  // Parsed at noon UTC: a bare '2026-09-27' is midnight UTC, which is the day before in any western zone, and
  // this string is the store's day rather than an instant.
  const at = new Date(`${localDate}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return '';

  // COMPOSED FROM TWO FORMATS RATHER THAN ONE, because the board writes "Tuesday, 23 September" and en-GB's
  // combined format has no comma in it — it gives "Tuesday 27 September". The comma is the design's, so it is
  // put there rather than accepted from the locale.
  const options: Intl.DateTimeFormatOptions[] = [{ weekday: 'long' }, { day: 'numeric', month: 'long' }];
  try {
    const [weekday, date] = options.map((o) => new Intl.DateTimeFormat('en-GB', { ...o, timeZone }).format(at));
    return `${weekday}, ${date}`;
  } catch {
    const [weekday, date] = options.map((o) => new Intl.DateTimeFormat('en-GB', o).format(at));
    return `${weekday}, ${date}`;
  }
}

/** "Good morning" / "Good afternoon" / "Good evening", by the clock in the shop. */
export function greeting(timeZone: string, now: Date = new Date()): string {
  const hour = Number(localParts(now, timeZone).time.slice(0, 2));
  if (!Number.isFinite(hour)) return 'Hello';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The alert's "0:07", counting up. */
export function waitingClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
