// client/src/console/supportLines.ts — milestone 24, from project/Complaints.dc.html, ReviewsMerchant.dc.html and
// Customers.dc.html.
//
// THE WORDS OF SUPPORT, with no React in them, for the reason lines.ts and walletLines.ts give: the render gate can call
// these directly, and a rule that lives in JSX is only tested by whatever markup happens to be scraped.

import { methodName } from './walletLines.ts';
import type { ComplaintDetail, ComplaintStatus, TimelineEvent } from './api.ts';

// ---------------------------------------------------------------------------
// Complaints
// ---------------------------------------------------------------------------

const REASONS: Record<string, string> = {
  item_missing: 'Missing item',
  wrong_item: 'Wrong item',
  quality_problem: 'Quality problem',
  arrived_late: 'Late delivery',
  other: 'Something else',
};

export const reasonLabel = (code: string): string => REASONS[code] ?? code;

/** The board's BADGE map. `escalated` is the merchant WAITING, which is why it is not the amber of "needs you". */
export const COMPLAINT_BADGE: Record<ComplaintStatus, { label: string; className: string }> = {
  open: { label: 'Needs a reply', className: 'bg-status-warn text-status-warn-fg' },
  escalated: { label: 'With Vendlyfy', className: 'bg-status-progress text-status-progress-fg' },
  resolved: { label: 'Resolved', className: 'bg-status-success text-status-success-fg' },
  rejected: { label: 'Rejected', className: 'bg-status-danger text-status-danger-fg' },
};

/** "2 h", "5 h", "2 d" — the list's own short age, and the header's "filed 2 h ago". */
export function ageShort(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export type ResponseKind = 'resolve' | 'reject' | 'escalate';

/** The three responses and exactly the board's sentences for each. */
export const RESPONSES: Record<ResponseKind, { label: string; help: string; placeholder: string; submit: string; done: string }> = {
  resolve: {
    label: 'Resolve',
    help: 'Tell the customer what you did. They can reopen it if they’re not happy.',
    placeholder: 'What did you do? e.g. “Sorry, we’ll send the salad now.”',
    submit: 'Send and resolve',
    done: 'Resolved · customer notified',
  },
  reject: {
    label: 'Reject',
    help: 'Explain why. The customer sees your reason and can reopen it.',
    placeholder: 'Why are you rejecting it?',
    submit: 'Reject complaint',
    done: 'Rejected · customer notified',
  },
  escalate: {
    label: 'Escalate',
    help: 'Ask Vendlyfy to decide. They see the whole thread, rider notes and photos, and can refund from your wallet.',
    placeholder: 'What should Vendlyfy look at?',
    submit: 'Escalate to Vendlyfy',
    done: 'Escalated · Vendlyfy will review',
  },
};

/** The card under the thread once the merchant has nothing to do. Empty while it is open. */
export function closedNote(status: ComplaintStatus): string {
  switch (status) {
    case 'escalated':
      return 'Vendlyfy is reviewing this. You and the customer will both get the decision. If they refund, it comes out of your available balance.';
    case 'resolved':
      return 'Resolved. The customer, you or Vendlyfy can still reopen it.';
    case 'rejected':
      return 'Rejected. The customer can reopen it, and either of you can then escalate to Vendlyfy.';
    case 'open':
      return '';
  }
}

export const canReopen = (status: ComplaintStatus): boolean => status === 'resolved' || status === 'rejected';

/**
 * One timeline row, worded the board's way: "You rejected: “…”", "Customer reopened it", "Complaint filed by customer".
 * The WORDS come from who did it (`side`), not from the event type alone, because one type is two sentences — a reopen
 * by the customer and a reopen by the store. "You" is only for the signed-in person; a colleague is named.
 */
export function timelineLine(e: TimelineEvent, me: string): string {
  const who = e.side === 'store' ? (e.actor === null || e.actor === me ? 'You' : e.actor) : e.side === 'customer' ? 'Customer' : e.side === 'platform' ? 'Vendlyfy' : e.side === 'rider' ? 'The rider' : 'The system';
  const quote = e.note === null ? '' : `: “${e.note}”`;
  switch (e.type) {
    case 'filed':
      return `Complaint filed by ${e.side === 'customer' ? 'customer' : who.toLowerCase()}`;
    case 'resolved':
      return `${who} resolved${quote}`;
    case 'rejected':
      return `${who} rejected${quote}`;
    case 'escalated':
      return `${who} escalated to Vendlyfy${quote}`;
    case 'reopened':
      return who === 'You' ? 'Reopened by you' : `${who} reopened it`;
    case 'refund_requested':
      return e.note === null ? `${who} asked Vendlyfy for a refund` : `Refund request sent to Vendlyfy: “${e.note}”`;
    case 'platform_refunded':
      return `Vendlyfy refunded the customer${quote}`;
    case 'platform_rejected':
      return `Vendlyfy declined the refund${quote}`;
    default:
      return `${who} added a note${quote}`;
  }
}

/** "Delivered by Claude H. at 14:02 · paid by MoMo" — the order card's last line. */
export function deliveryLine(o: ComplaintDetail['order'], clock: (iso: string) => string): string {
  const paid = `paid by ${methodName(o.paymentMethod)}`;
  if (o.deliveredAt === null) return o.fulfilment === 'pickup' ? `Pickup · ${paid}` : `Not delivered · ${paid}`;
  const rider = o.fulfilment === 'delivery' && o.riderName !== null ? ` by ${shortRider(o.riderName)}` : '';
  return `${o.fulfilment === 'pickup' ? 'Collected' : 'Delivered'}${rider} at ${clock(o.deliveredAt)} · ${paid}`;
}

/** "Claude Habineza" -> "Claude H." */
export function shortRider(name: string): string {
  const p = name.trim().split(/\s+/);
  return p.length < 2 ? name : `${p[0]} ${p[p.length - 1]!.charAt(0)}.`;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/** ★★★★☆ — the board's own, with the empty ones drawn so the row is always five stars wide. */
export const stars = (n: number): string => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

export const REPORT_REASONS: readonly { code: 'abusive' | 'personal_info' | 'not_a_customer' | 'spam'; label: string }[] = [
  { code: 'abusive', label: 'Abusive or hateful' },
  { code: 'personal_info', label: 'Shares personal info' },
  { code: 'not_a_customer', label: 'Not a real customer' },
  { code: 'spam', label: 'Spam' },
];

export const reportReasonLabel = (code: string): string => REPORT_REASONS.find((r) => r.code === code)?.label.toLowerCase() ?? code;

/** "Down from 7 last month" — which direction is the board's to say, and it says it in words. */
export function lowTrend(thisMonth: number, lastMonth: number): string {
  if (thisMonth < lastMonth) return `Down from ${lastMonth} last month`;
  if (thisMonth > lastMonth) return `Up from ${lastMonth} last month`;
  return `Same as last month`;
}

/** "★ 4.6 (58)" with three or more reviews, "2 reviews" below that, "No reviews" with none. The board's footnote is the rule. */
export function productRating(p: { count: number; average: string | null }): { text: string; rated: boolean } {
  if (p.count === 0) return { text: 'No reviews', rated: false };
  if (p.average === null) return { text: `${p.count} ${p.count === 1 ? 'review' : 'reviews'}`, rated: false };
  return { text: `★ ${p.average} (${p.count})`, rated: true };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const initials = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .map((p) => p.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

export const TYPE_BADGE = {
  account: { label: 'Account', className: 'bg-brand-tint text-brand-strong' },
  guest: { label: 'Guest', className: 'bg-status-neutral text-status-neutral-fg' },
} as const;

export const SEGMENTS: readonly { value: 'all' | 'regular' | 'account' | 'guest'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'regular', label: 'Regulars (5+ orders)' },
  { value: 'account', label: 'With account' },
  { value: 'guest', label: 'Guests' },
];

export const typeSentence = (account: boolean): string => (account ? 'has an account' : 'guest, matched by phone');
