// packages/core/src/messages/index.ts — milestone 28, from project/Messages.dc.html: "Emails and SMS, in each store's colours".
//
// THE TEMPLATES AS PURE FUNCTIONS. A message is words plus a few facts (an order number, a total, a rider's name) and — for the email — the
// store's brand colour; nothing here sends anything or reads a database. That is what lets the server render the real thing, the admin
// console preview it, and the tests prove every SMS fits one message for the sample data, from the same code.
//
// THE EMAIL'S BUTTON FOLLOWS THE BRAND, AND KEEPS ITS TEXT READABLE: "button text flips to dark when the colour is light". Whichever of
// near-black and white contrasts better with the brand colour is the text colour — the board's own rule (`cr(c, dark) > cr(c, white)`),
// computed with the same `contrast()` the theme engine uses, so a lime store and a green store both get a button you can read.
//
// SMS IS PLAIN TEXT: "it carries the store name, not its colours. Links are short and go to the store's own tracking page." One SMS is
// 160 characters; a longer message is split in two and billed as two, so `smsFit` reports it and the sample data in the tests keeps every
// template inside one.

import { contrast } from '../theme/color.ts';

export const CUSTOMER_MESSAGES = ['confirm', 'approved', 'ready', 'assigned', 'delivered', 'rejected'] as const;
export const SMS_ONLY_MESSAGES = ['kycRedo', 'kycOk', 'payoutFail', 'riderJob', 'newOrder'] as const;
export type CustomerMessage = (typeof CUSTOMER_MESSAGES)[number];
export type SmsOnlyMessage = (typeof SMS_ONLY_MESSAGES)[number];
export type MessageKey = CustomerMessage | SmsOnlyMessage;

export const SMS_LIMIT = 160;

export type MessageContext = {
  /** The store's name — what customers know it by. "Vendlyfy" for the platform's own messages. */
  store: string;
  number?: string | number;
  /** Already formatted for the store's currency: "9,000 RWF". */
  total?: string;
  customer?: string;
  /** The short tracking link. Left as the literal `[LINK]` in templates; the sender substitutes the real one. */
  link?: string;
  eta?: string;
  rider?: string;
  plate?: string;
  riderPhone?: string;
  /** Cash the rider collects, formatted. Present only for cash on delivery. */
  cashDue?: string;
  deliveredAt?: string;
  reason?: string;
  /** Identity messages. */
  part?: string;
  payoutTo?: string;
  payoutAt?: string;
  amount?: string;
  area?: string;
  paid?: boolean;
};

export type CustomerEmail = { subject: string; head: string; body: string; cta: string; payLabel: string };

const LINK = (c: MessageContext): string => c.link ?? '[LINK]';
const n = (c: MessageContext): string => String(c.number ?? '');
const who = (c: MessageContext): string => c.customer ?? 'there';

type CustomerTemplate = { label: string; head: (c: MessageContext) => string; body: (c: MessageContext) => string; cta: string; sms: (c: MessageContext) => string };

export const CUSTOMER_TEMPLATES: Record<CustomerMessage, CustomerTemplate> = {
  confirm: {
    label: 'Order received',
    head: () => 'We got your order',
    body: (c) => `Thanks, ${who(c)}. ${c.store} will confirm it shortly. You’ll hear from us at every step.`,
    cta: 'Track your order',
    sms: (c) => `${c.store}: we got order #${n(c)} (${c.total ?? ''}). We’ll text when it’s accepted. Track: ${LINK(c)}`,
  },
  approved: {
    label: 'Order accepted',
    head: () => 'Your order is being prepared',
    body: (c) => `${c.store} accepted order #${n(c)} and is preparing it now.${c.eta === undefined ? '' : ` Usual time: ${c.eta}.`}`,
    cta: 'Track your order',
    sms: (c) => `${c.store}: order #${n(c)} accepted and being prepared. Track: ${LINK(c)}`,
  },
  ready: {
    label: 'Ready',
    head: () => 'Your order is ready',
    body: (c) => `Order #${n(c)} is packed. A rider will collect it shortly, or it’s ready for you to pick up.`,
    cta: 'Track your order',
    sms: (c) => `${c.store}: order #${n(c)} is ready. Track: ${LINK(c)}`,
  },
  assigned: {
    label: 'Rider on the way',
    head: (c) => `${c.rider ?? 'A rider'} is bringing your order`,
    body: (c) => `${c.rider ?? 'A rider'}${c.plate === undefined ? '' : ` (${c.plate})`} has your order and is on the way. Keep your phone nearby.${c.cashDue === undefined ? '' : ` Cash to pay: ${c.cashDue}.`}`,
    cta: 'Track your order',
    sms: (c) => `${c.store}: ${c.rider ?? 'a rider'}${c.plate === undefined ? '' : ` (${c.plate})`} is on the way with #${n(c)}.${c.cashDue === undefined ? '' : ` Pay ${c.cashDue} cash.`}${c.riderPhone === undefined ? '' : ` Call: ${c.riderPhone}`}`,
  },
  delivered: {
    label: 'Delivered',
    head: () => 'Delivered. Enjoy!',
    body: (c) => `Order #${n(c)} was delivered${c.deliveredAt === undefined ? '' : ` at ${c.deliveredAt}`}. Something not right? Tell ${c.store} from your order page.`,
    cta: 'Rate your order',
    sms: (c) => `${c.store}: #${n(c)} delivered. Something wrong? Tell us: ${LINK(c)}`,
  },
  rejected: {
    label: 'Declined',
    head: () => 'We couldn’t take your order',
    body: (c) => `${c.store} couldn’t take order #${n(c)}${c.reason === undefined ? '' : `: ${c.reason}`}.${c.paid === true ? ` Your ${c.total ?? ''} payment has been refunded.` : ''}`,
    cta: 'See the menu',
    sms: (c) => `${c.store} couldn’t take order #${n(c)}${c.reason === undefined ? '' : ` (${c.reason})`}.${c.paid === true ? ` ${c.total ?? ''} refunded.` : ''}`,
  },
};

type SmsTemplate = { label: string; audience: string; sms: (c: MessageContext) => string };

export const SMS_TEMPLATES: Record<SmsOnlyMessage, SmsTemplate> = {
  kycRedo: { label: 'ID photo needed again', audience: 'merchant', sms: (c) => `Vendlyfy: please retake ${c.part ?? 'a photo of your ID'}.${c.reason === undefined ? '' : ` ${c.reason}`} Open the app: ${LINK(c)}` },
  kycOk: { label: 'Identity verified', audience: 'merchant', sms: (c) => `Vendlyfy: you’re verified.${c.payoutTo === undefined ? '' : ` Payouts to ${c.payoutTo} start${c.payoutAt === undefined ? '' : ` tomorrow at ${c.payoutAt}`}.`}` },
  payoutFail: { label: 'Payout failed', audience: 'merchant', sms: (c) => `Vendlyfy: payout of ${c.amount ?? ''} failed${c.reason === undefined ? '' : ` (${c.reason})`}. Money is back in your balance. Fix: ${LINK(c)}` },
  riderJob: { label: 'New delivery (rider)', audience: 'rider', sms: (c) => `Vendlyfy: new delivery #${n(c)} from ${c.store}${c.area === undefined ? '' : ` to ${c.area}`}.${c.cashDue === undefined ? '' : ` Collect ${c.cashDue} cash.`} Open app.` },
  newOrder: { label: 'New order (merchant)', audience: 'merchant', sms: (c) => `Vendlyfy: new order #${n(c)} · ${c.total ?? ''}${c.paid === true ? ' paid' : ''}. Accept in the app: ${LINK(c)}` },
};

export const MESSAGE_LABEL: Record<MessageKey, string> = {
  ...(Object.fromEntries(CUSTOMER_MESSAGES.map((k) => [k, CUSTOMER_TEMPLATES[k].label])) as Record<CustomerMessage, string>),
  ...(Object.fromEntries(SMS_ONLY_MESSAGES.map((k) => [k, SMS_TEMPLATES[k].label])) as Record<SmsOnlyMessage, string>),
};

export const isCustomerMessage = (k: MessageKey): k is CustomerMessage => (CUSTOMER_MESSAGES as readonly string[]).includes(k);

export function renderSms(key: MessageKey, c: MessageContext): string {
  return isCustomerMessage(key) ? CUSTOMER_TEMPLATES[key].sms(c) : SMS_TEMPLATES[key].sms(c);
}

export function renderCustomerEmail(key: CustomerMessage, c: MessageContext): CustomerEmail {
  const t = CUSTOMER_TEMPLATES[key];
  return { subject: `${t.head(c)} · #${n(c)}`, head: t.head(c), body: t.body(c), cta: t.cta, payLabel: c.cashDue !== undefined ? 'cash on delivery' : 'MTN MoMo' };
}

export function smsFit(text: string): { count: number; fits: boolean; parts: number } {
  const count = [...text].length;
  return { count, fits: count <= SMS_LIMIT, parts: Math.max(1, Math.ceil(count / SMS_LIMIT)) };
}

/**
 * The sender name on an SMS: "NYAMA & CO." → "NYAMACO". Letters only, uppercase, at most eleven — the alphanumeric sender ID a phone
 * will display. A name with no letters (a store called "24/7") falls back to the platform's own.
 */
export function senderId(storeName: string): string {
  const id = storeName.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 11);
  return id.length >= 3 ? id : 'VENDLYFY';
}

export type EmailColours = { band: string; onBand: string; button: string; onButton: string };

const INK = '#17160F';
const WHITE = '#FFFFFF';

/** The brand colour for the band and the button, and the text colour on it: dark when that reads better than white, white otherwise. */
export function emailColours(brand: string): EmailColours {
  const on = contrast(brand, INK) > contrast(brand, WHITE) ? INK : WHITE;
  return { band: brand, onBand: on, button: brand, onButton: on };
}

const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type EmailOrder = { number: string | number; placedAt: string; lines: { quantity: number; name: string; amount: string }[]; delivery: string | null; total: string };

/**
 * A complete email as HTML with inline styles (email clients ignore stylesheets), in the store's colours. Every interpolated value is
 * escaped: a customer's name and a product's name are typed by strangers.
 */
export function renderEmailHtml(email: CustomerEmail, store: { name: string; mark: string; phone: string | null; brand: string }, order: EmailOrder, link: string): string {
  const c = emailColours(store.brand);
  const lines = order.lines.map((l) => `<tr><td style="padding:2px 0">${l.quantity}× ${esc(l.name)}</td><td style="padding:2px 0;text-align:right">${esc(l.amount)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><body style="margin:0;background:#F6F5F1;font-family:Figtree,Arial,sans-serif;color:#17160F">
<div style="max-width:600px;margin:0 auto;background:#FFFFFF">
<div style="padding:22px 28px;background:${esc(c.band)};color:${esc(c.onBand)}"><strong style="font-size:18px">${esc(store.mark)} &nbsp;${esc(store.name)}</strong></div>
<div style="padding:26px 28px">
<h1 style="margin:0 0 12px;font-size:26px;line-height:1.15">${esc(email.head)}</h1>
<p style="margin:0 0 16px;font-size:15px;color:#3B3A33">${esc(email.body)}</p>
<table style="width:100%;border:1px solid #E5E2DA;border-radius:10px;padding:12px 14px;font-size:14px;border-collapse:collapse"><tr><td colspan="2" style="color:#5F5C53;font-size:12px">Order #${esc(String(order.number))} · ${esc(order.placedAt)}</td></tr>${lines}${order.delivery === null ? '' : `<tr><td>Delivery</td><td style="text-align:right">${esc(order.delivery)}</td></tr>`}<tr><td style="border-top:1px solid #EFEDE7;padding-top:6px;font-weight:700">Total · ${esc(email.payLabel)}</td><td style="border-top:1px solid #EFEDE7;padding-top:6px;text-align:right;font-weight:700">${esc(order.total)}</td></tr></table>
<p style="margin:20px 0"><a href="${esc(link)}" style="display:inline-block;padding:14px 22px;border-radius:10px;background:${esc(c.button)};color:${esc(c.onButton)};font-weight:700;text-decoration:none">${esc(email.cta)}</a></p>
<p style="margin:0;font-size:13px;color:#5F5C53">Questions? Reply to this email${store.phone === null ? '' : ` or call ${esc(store.name)} on ${esc(store.phone)}`}.</p>
</div>
<div style="padding:14px 28px;background:#F6F5F1;font-size:11px;color:#5F5C53">You got this because you ordered from ${esc(store.name)}. Order emails can’t be turned off. Sent via Vendlyfy.</div>
</div></body></html>`;
}

/** Sample facts for every template — the board's own order #1026 — so the preview, the tests and the docs all talk about the same order. */
export function sampleContext(store: string): MessageContext {
  return { store, number: 1026, total: '9,000 RWF', customer: 'Grace', link: 'vndl.fy/k3x9', eta: '25–35 min', rider: 'Eric', plate: 'RAD 482 K', riderPhone: '078 455 9012', cashDue: '9,000 RWF', deliveredAt: '14:31', reason: 'an item is out of stock', paid: true, part: 'the back of your ID', payoutTo: 'MoMo 078•••4412', payoutAt: '08:00', amount: '41,000 RWF', area: 'Kacyiru' };
}
