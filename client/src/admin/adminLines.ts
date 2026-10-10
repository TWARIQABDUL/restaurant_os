// client/src/admin/adminLines.ts — milestone 27. The words and rules of the admin console, with no React in them, so the render
// gate calls them directly (lines.ts, walletLines.ts and the others give the reason).

import type { AdminOrder, AuditCategory, Health, OrderFilter, Plan, TeamRole, TemplateSummary, Currency, DisputeDetail, DisputeItem, Kpi, MerchantRow, MethodDetail, MethodStatus, Overview, PayoutRow, PayoutTab, Range } from './adminApi.ts';

export const NAV: readonly { label: string; items: readonly { id: string; label: string; path: string; icon: string; built: boolean; needs: readonly string[]; badge?: 'merchants' | 'kyc' | 'disputes' }[] }[] = [
  {
    label: 'Platform',
    items: [
      { id: 'overview', label: 'Overview', path: '/admin', icon: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 9h8V3h-8z', built: true, needs: ['merchants.read'] },
      { id: 'merchants', label: 'Merchants', path: '/admin/merchants', icon: 'M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6', built: true, needs: ['merchants.read'], badge: 'merchants' },
      { id: 'kyc', label: 'Identity checks', path: '/admin/kyc', icon: 'M4 5h16v14H4zM9 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 16c.5-2 5.5-2 6 0M14 9h4M14 13h4', built: true, needs: ['kyc.review'], badge: 'kyc' },
      { id: 'orders', label: 'All orders', path: '/admin/orders', icon: 'M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4', built: true, needs: ['merchants.read'] },
    ],
  },
  {
    label: 'Money',
    items: [
      { id: 'payments', label: 'Payment methods', path: '/admin/payments', icon: 'M2 6h20v12H2zM2 10h20M6 15h4', built: true, needs: ['payment_methods.manage'] },
      { id: 'currencies', label: 'Currencies', path: '/admin/currencies', icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 6v2M12 16v2', built: true, needs: ['currencies.manage'] },
      { id: 'payouts', label: 'Payouts', path: '/admin/payouts', icon: 'M12 3v12M7 10l5 5 5-5M4 21h16', built: true, needs: ['payouts.process'] },
      { id: 'disputes', label: 'Refunds & disputes', path: '/admin/disputes', icon: 'M12 3l9 16H3zM12 10v4M12 17h.01', built: true, needs: ['refunds.approve', 'disputes.resolve'], badge: 'disputes' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { id: 'industries', label: 'Industry templates', path: '/admin/industries', icon: 'M4 6h16M4 12h16M4 18h10M18 16v4M16 18h4', built: true, needs: ['templates.manage'] },
      { id: 'messages', label: 'Message templates', path: '/admin/messages', icon: 'M4 5h16v12H8l-4 3zM8 9h8M8 13h5', built: true, needs: ['platform_settings.manage'] },
      { id: 'plans', label: 'Plans & fees', path: '/admin/plans', icon: 'M4 4h16v16H4zM4 9h16M9 9v11', built: true, needs: ['plans.manage'] },
      { id: 'team', label: 'Admin team & roles', path: '/admin/team', icon: 'M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', built: true, needs: ['platform_members.create'] },
      { id: 'audit', label: 'Audit log', path: '/admin/audit', icon: 'M12 8v4l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', built: true, needs: ['audit.read'] },
      { id: 'settings', label: 'Platform settings', path: '/admin/settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12h2M3 12h2M12 3v2M12 19v2', built: true, needs: ['platform_settings.manage'] },
    ],
  },
];

export const RANGE_LABEL: Record<Range, string> = { today: 'Today', week: '7 days', month: '30 days' };
const VS: Record<Range, string> = { today: 'vs yesterday', week: 'vs the 7 days before', month: 'vs the 30 days before' };

export const KPI_LABEL: Record<Kpi['key'], string> = { sales: 'Sales (all stores)', orders: 'Orders', stores: 'Active stores', signups: 'New sign-ups', payment: 'Payment success' };

const group = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "18.4M RWF", "121K RWF", "640 RWF" — a headline, not a ledger. */
export function compactMoney(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1)}M RWF`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K RWF`;
  return `${group(n)} RWF`;
}

export function kpiValue(k: Kpi): string {
  if (k.value === null) return '—';
  if (k.key === 'sales') return compactMoney(k.value);
  if (k.key === 'payment') return `${k.value.toFixed(1)}%`;
  return group(k.value);
}

/** The line under a figure, and whether it is good news — null when there is nothing honest to compare. */
export function kpiDelta(k: Kpi, range: Range): { text: string; tone: 'up' | 'down' | 'flat' | 'warn' } {
  if (k.key === 'stores') return { text: k.note ?? '', tone: 'flat' };
  if (k.key === 'signups') return { text: k.note ?? '', tone: k.note !== null && !k.note.startsWith('0 ') ? 'warn' : 'flat' };
  if (k.value === null || k.previous === null) return { text: 'No data yet', tone: 'flat' };
  if (k.key === 'payment') {
    const d = k.value - k.previous;
    return { text: `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pts ${VS[range]}`, tone: d >= 0 ? 'up' : 'down' };
  }
  if (k.previous === 0) return { text: k.value === 0 ? 'No change' : `New ${VS[range]}`, tone: k.value === 0 ? 'flat' : 'up' };
  const pct = Math.round(((k.value - k.previous) / k.previous) * 100);
  return { text: `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}% ${VS[range]}`, tone: pct >= 0 ? 'up' : 'down' };
}

export function ageText(hours: number | null): string {
  if (hours === null) return '';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

/** Older than the board's SLA of a day is the one that turns red. */
export const overSla = (hours: number | null): boolean => hours !== null && hours >= 24;

export const QUEUE_ACTION: Record<Overview['queue'][number]['kind'], { action: string; path: string; icon: string; tone: string }> = {
  identity: { action: 'Review', path: '/admin/kyc', icon: '✓', tone: 'bg-status-info text-status-info-fg' },
  payout: { action: 'Resolve', path: '/admin/payouts', icon: '↯', tone: 'bg-status-warn text-status-warn-fg' },
  disputes: { action: 'Open', path: '/admin/disputes', icon: '⚑', tone: 'bg-status-progress text-status-progress-fg' },
  template: { action: 'Edit', path: '/admin/industries', icon: '⌂', tone: 'bg-status-neutral text-status-neutral-fg' },
};

export const PROVIDER_STATUS: Record<Overview['providers'][number]['status'], { label: string; tone: string }> = {
  operational: { label: 'Operational', tone: 'bg-status-success text-status-success-fg' },
  degraded: { label: 'Degraded', tone: 'bg-status-warn text-status-warn-fg' },
  quiet: { label: 'No traffic', tone: 'bg-status-neutral text-status-neutral-fg' },
  paused: { label: 'Paused', tone: 'bg-status-neutral text-status-neutral-fg' },
};

export const providerRate = (r: number | null): string => (r === null ? '—' : `${r.toFixed(1)}%`);

export function degradedNote(p: Overview['providers']): string | null {
  const d = p.find((x) => x.status === 'degraded');
  if (d === undefined) return null;
  return d.note ?? `${d.name} is slow.`;
}

/** "14:02" in the viewer's clock — the board's activity column. */
export const clock = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const TAB_LABEL = { pending: 'Needs review', active: 'Live', suspended: 'Suspended' } as const;

export const STATUS_BADGE: Record<MerchantRow['status'], { label: string; tone: string }> = {
  pending: { label: 'Needs review', tone: 'bg-status-info text-status-info-fg' },
  active: { label: 'Live', tone: 'bg-status-success text-status-success-fg' },
  suspended: { label: 'Suspended', tone: 'bg-status-danger text-status-danger-fg' },
};

/** What the badge on a row says: the store's status, except a live store waiting on its identity check reads as review. */
export function rowBadge(m: Pick<MerchantRow, 'status' | 'identity'>): { label: string; tone: string } {
  if (m.status === 'active' && m.identity === 'in_review') return STATUS_BADGE.pending;
  return STATUS_BADGE[m.status];
}

export const IDENTITY_LABEL: Record<MerchantRow['identity'], string> = {
  none: 'Identity not started',
  building: 'Documents being added',
  in_review: 'Waiting for review',
  redo_requested: 'A retake was asked for',
  rejected: 'Rejected',
  approved: 'Verified',
};

export const SUSPEND_REASONS: readonly { key: string; label: string }[] = [
  { key: 'docs', label: 'Documents unclear or don’t match' },
  { key: 'fraud', label: 'Suspected fraud' },
  { key: 'goods', label: 'Prohibited or counterfeit goods' },
  { key: 'complaints', label: 'Repeated customer complaints' },
];

export const joinedText = (iso: string, now: Date = new Date()): string => {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && now.getTime() - d.getTime() < 30 * 86_400_000
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
};

export const initial = (name: string): string => name.trim().charAt(0).toUpperCase() || '?';

export const KYC_RETENTION_LINE = 'ID photos are kept, encrypted. The face video is deleted automatically as soon as you decide.';

export const CHECK_ICON: Record<string, { mark: string; tone: string; note: string }> = {
  pass: { mark: '✓', tone: 'bg-status-success text-status-success-fg', note: 'text-status-success-fg' },
  warn: { mark: '!', tone: 'bg-status-warn text-status-warn-fg', note: 'text-status-warn-fg' },
  fail: { mark: '✕', tone: 'bg-status-danger text-status-danger-fg', note: 'text-status-danger-fg' },
  open: { mark: '…', tone: 'bg-status-neutral text-muted', note: 'text-muted' },
};

export const FLAG_TONE: Record<'ok' | 'warn' | 'bad', string> = { ok: 'bg-status-success text-status-success-fg', warn: 'bg-status-warn text-status-warn-fg', bad: 'bg-status-danger text-status-danger-fg' };

// ---------------------------------------------------------------------------
// Part B — payouts, refunds & disputes, currencies, payment methods
// ---------------------------------------------------------------------------

export const rwf = (n: number | string): string => `${String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} RWF`;

export const PAYOUT_TAB_LABEL: Record<PayoutTab, string> = { problem: 'Failed', held: 'Held', live: 'In progress', done: 'Completed' };

export const PAYOUT_STATUS: Record<PayoutRow['status'], { label: string; tone: string }> = {
  failed: { label: 'Failed', tone: 'bg-status-danger text-status-danger-fg' },
  held: { label: 'Held', tone: 'bg-status-warn text-status-warn-fg' },
  processing: { label: 'Processing', tone: 'bg-status-info text-status-info-fg' },
  completed: { label: 'Completed', tone: 'bg-status-success text-status-success-fg' },
  rejected: { label: 'Rejected', tone: 'bg-status-neutral text-status-neutral-fg' },
};

/** "Today 08:00", "Yesterday 11:32", "5 Oct 08:00" — the board's own column, in the viewer's clock. */
export function whenText(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x: Date): string => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  return day(d) === day(now) ? `Today ${t}` : day(d) === day(y) ? `Yesterday ${t}` : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${t}`;
}

export const DISPUTE_TAB_LABEL = { refunds: 'Refunds', disputes: 'Disputes', closed: 'Closed' } as const;

export const DISPUTE_BADGE: Record<DisputeItem['status'], { label: string; tone: string }> = {
  open: { label: 'Needs decision', tone: 'bg-status-info text-status-info-fg' },
  approved: { label: 'Refunded', tone: 'bg-status-success text-status-success-fg' },
  queued: { label: 'Approved · waiting for funds', tone: 'bg-status-warn text-status-warn-fg' },
  rejected: { label: 'Rejected', tone: 'bg-status-danger text-status-danger-fg' },
};

/** A dispute that is still open is "Escalated" on its own pile; a refund request is "Needs decision". */
export const disputeBadge = (i: Pick<DisputeItem, 'kind' | 'status'>): { label: string; tone: string } =>
  i.kind === 'dispute' && i.status === 'open' ? { label: 'Escalated', tone: 'bg-status-progress text-status-progress-fg' } : DISPUTE_BADGE[i.status];

export const MESSAGE_TONE: Record<DisputeDetail['thread'][number]['side'], string> = {
  customer: 'bg-ground',
  store: 'bg-brand-tint',
  platform: 'bg-status-progress',
  rider: 'bg-status-warn',
  system: 'bg-status-neutral',
};

/** Whether approving pays now, and the sentence under the wallet card that says so. */
export function walletVerdict(available: string | number, amount: number): { short: boolean; note: string } {
  const have = Number(available);
  if (amount > have) {
    return { short: true, note: `Not enough available: ${rwf(have)} of ${rwf(amount)}. If you approve, the refund waits and is taken as soon as the balance covers it. Payouts to the store pause until then.` };
  }
  return { short: false, note: 'Enough available to cover this now.' };
}

/** The line under the decision box — what pressing the button will do, in the board's words where they are true. */
export function decisionNote(d: Pick<DisputeDetail, 'kind' | 'store' | 'order'>, approving: boolean, amount: number, total: number): string {
  if (approving) {
    const partial = amount > 0 && amount < total ? `Partial refund: ${rwf(amount)} of ${rwf(total)}. ` : '';
    return `${partial}Deducted from ${d.store.name}’s available balance in one step and sent back to the customer’s ${d.order.payment === 'cash' ? 'cash' : 'MoMo'}. The store is told in the app.`;
  }
  return d.kind === 'dispute' ? 'The complaint closes as rejected. The customer or store can reopen it with new information.' : 'The store is told why. Nothing moves.';
}

export function decideLabel(d: Pick<DisputeDetail, 'kind'>, approving: boolean, short: boolean, amount: number): string {
  if (!approving) return d.kind === 'dispute' ? 'Reject escalation' : 'Reject request';
  return short ? 'Approve · take it when funds allow' : `Approve and refund ${amount > 0 ? rwf(amount) : ''}`.trim();
}

/** "1,000 RWF" in a currency's OWN rules — symbol, side, separator, decimals — optionally rounded as cash is. */
export function formatCurrency(n: number, c: Pick<Currency, 'symbol' | 'position' | 'separator' | 'decimals' | 'rounding'>, cash = false): string {
  let v = n;
  if (cash && c.rounding > 0) v = Math.round(v / c.rounding) * c.rounding;
  const parts = v.toFixed(c.decimals).split('.');
  parts[0] = parts[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, c.separator);
  const num = parts.join(c.separator === '.' ? ',' : '.');
  const sp = c.symbol.length > 1 ? ' ' : '';
  return c.position === 'before' ? `${c.symbol}${sp}${num}` : `${num} ${c.symbol}`;
}

/** The sample amounts the preview uses — each currency's own scale, so "1,000" is never shown in dollars. */
export const SAMPLE: Record<string, [number, number]> = { RWF: [3500, 1000], UGX: [9500, 3000], KES: [350, 100], TZS: [7000, 2500], BIF: [7500, 2500], USD: [2.4, 0.7] };

export function currencyPreview(c: Pick<Currency, 'code' | 'symbol' | 'position' | 'separator' | 'decimals' | 'rounding'>): { price: string; sub: string; del: string; total: string; cash: string } {
  const [price, del] = SAMPLE[c.code] ?? [3500, 1000];
  const total = price * 2 + del + (c.decimals ? 0.03 : 17);
  return { price: formatCurrency(price, c), sub: formatCurrency(price * 2, c), del: formatCurrency(del, c), total: formatCurrency(total, c), cash: formatCurrency(total, c, true) };
}

export const ROUNDING_LABEL = (n: number): string => (n === 0 ? 'Off' : `To ${n}`);

/** What the conversion panel says about a currency's USD rate, and in what tone. */
export function rateNote(c: Pick<Currency, 'code' | 'rateSource' | 'usdRate' | 'symbol' | 'position' | 'separator' | 'decimals' | 'rounding'>, typed: string): { text: string; tone: 'ok' | 'warn' | 'plain' } {
  if (c.code === 'USD') return { text: 'USD is the reference currency for conversion.', tone: 'plain' };
  const n = parseFloat(typed.replace(/,/g, ''));
  if (c.rateSource === 'manual' && n > 0) {
    const [price] = SAMPLE[c.code] ?? [3500, 0];
    return { text: `A ${formatCurrency(price, c)} item shows “≈ $${(price / n).toFixed(2)}” to visitors using USD.`, tone: 'ok' };
  }
  if (c.rateSource === 'manual') return { text: 'Enter a rate to preview converted prices. Until then, no converted price is shown.', tone: 'warn' };
  return { text: 'No rate feed is connected, so converted prices are not shown. Set the rate by hand to show them.', tone: 'warn' };
}

export const METHOD_BADGE: Record<MethodStatus, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'bg-status-warn text-status-warn-fg' },
  live: { label: 'Live', tone: 'bg-status-success text-status-success-fg' },
  paused: { label: 'Paused', tone: 'bg-status-danger text-status-danger-fg' },
};

export const methodMeta = (m: { countries: string[]; currencies: string[] }): string => `${m.countries.length === 0 ? 'No country' : m.countries.join(' · ')} · ${m.currencies.length === 0 ? 'no currency' : m.currencies.join(', ')}`;

export const readinessCount = (d: Pick<MethodDetail, 'readiness'>): { done: number; total: number } => ({ done: d.readiness.filter((r) => r.ok).length, total: d.readiness.length });

export const CHECKOUT_PREVIEW_CASH = { short: 'CASH', name: 'Cash on delivery' } as const;

export const thousands = (n: number | null): string => (n === null ? '' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
export const unthousands = (s: string): number | null => (s.trim() === '' ? null : Number(s.replace(/[^\d.]/g, '')));

// ---------------------------------------------------------------------------
// Part C — audit log, all orders, platform settings, admin team, plans, industry templates
// ---------------------------------------------------------------------------

/** Whether this person's permissions open a destination: any one of the listed is enough. */
export const mayOpen = (needs: readonly string[], held: readonly string[]): boolean => needs.some((n) => held.includes(n));

export const AUDIT_FILTERS: readonly { id: AuditCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'sensitive', label: 'Sensitive views' }, { id: 'money', label: 'Money' }, { id: 'store', label: 'Stores' }, { id: 'config', label: 'Settings' }, { id: 'access', label: 'Access' },
];

export const AUDIT_TYPE: Record<AuditCategory, { label: string; tone: string }> = {
  sensitive: { label: 'Sensitive view', tone: 'bg-status-danger text-status-danger-fg' },
  money: { label: 'Money', tone: 'bg-status-success text-status-success-fg' },
  store: { label: 'Store', tone: 'bg-status-info text-status-info-fg' },
  config: { label: 'Settings', tone: 'bg-status-progress text-status-progress-fg' },
  access: { label: 'Access', tone: 'bg-status-warn text-status-warn-fg' },
};

/** "Today 14:21", "Yesterday 09:30", "5 Oct 09:30" — plus seconds on hover in the screen, since the log is a record. */
export const stampText = (iso: string, now: Date = new Date()): string => whenText(iso, now);

export const ORDER_FILTERS: readonly { id: OrderFilter; label: (c: { today: number; attention: number }) => string }[] = [
  { id: 'today', label: (c) => `All today · ${c.today.toLocaleString('en-US')}` },
  { id: 'open', label: () => 'Not finished' },
  { id: 'attention', label: (c) => `Needs attention (${c.attention})` },
  { id: 'cash', label: () => 'Cash unpaid' },
];

export const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'New', tone: 'bg-status-info text-status-info-fg' },
  approved: { label: 'Accepted', tone: 'bg-status-warn text-status-warn-fg' },
  preparing: { label: 'Preparing', tone: 'bg-status-warn text-status-warn-fg' },
  ready: { label: 'Ready', tone: 'bg-status-warn text-status-warn-fg' },
  assigned: { label: 'Rider assigned', tone: 'bg-status-warn text-status-warn-fg' },
  out: { label: 'Out for delivery', tone: 'bg-status-warn text-status-warn-fg' },
  delivered: { label: 'Delivered', tone: 'bg-status-neutral text-status-neutral-fg' },
  collected: { label: 'Collected', tone: 'bg-status-neutral text-status-neutral-fg' },
  returned: { label: 'Returned to store', tone: 'bg-status-danger text-status-danger-fg' },
  closed_return: { label: 'Return closed', tone: 'bg-status-neutral text-status-neutral-fg' },
  rejected: { label: 'Rejected', tone: 'bg-status-neutral text-status-neutral-fg' },
  cancelled: { label: 'Cancelled', tone: 'bg-status-neutral text-status-neutral-fg' },
};

const METHOD_NAME: Record<string, string> = { mtn_momo: 'MoMo', airtel_money: 'Airtel', mpesa: 'M-Pesa', cash: 'Cash' };

/** "MoMo · paid", "Cash · unpaid" — the board's payment pill, from the order's two payment fields. */
export const paymentText = (o: Pick<AdminOrder, 'paymentMethod' | 'paymentStatus'>): { text: string; paid: boolean } => ({ text: `${METHOD_NAME[o.paymentMethod] ?? o.paymentMethod} · ${o.paymentStatus === 'refunded' ? 'refunded' : o.paymentStatus}`, paid: o.paymentStatus === 'paid' || o.paymentStatus === 'refunded' });

export function orderAge(minutes: number): string {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.max(1, minutes)} min`;
}

export const PAYOUT_MODE_LABEL = { automatic: 'Automatic payouts', manual: 'Manual withdrawals' } as const;

export function holdNote(minutes: number): { text: string; warn: boolean } {
  if (minutes < 15) return { text: 'Very short: returns and refunds after this come out of Available, which may already be paid out.', warn: true };
  if (minutes > 1440) return { text: 'Over a day: merchants will notice slower money. Tell them first.', warn: true };
  return { text: 'Money stays Pending this long after payment before it can be paid out. Applies to new payments only.', warn: false };
}

export const HEALTH_DOT: Record<Health['state'], { dot: string; badge: string; label: string }> = {
  ok: { dot: 'bg-status-success-fg', badge: 'bg-status-success text-status-success-fg', label: 'OK' },
  warn: { dot: 'bg-status-warn-fg', badge: 'bg-status-warn text-status-warn-fg', label: 'Check' },
  off: { dot: 'bg-disabled', badge: 'bg-status-neutral text-status-neutral-fg', label: 'Not connected' },
};

export const TEAM_ROLE_LABEL: Record<TeamRole, string> = { super_admin: 'Super admin', support: 'Support', finance: 'Finance', verification: 'Verification' };

/** A starting password to hand over once: 14 characters, no look-alikes, always a digit — the merchant console's Staff panel uses the same shape. */
export function startingPassword(random: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const letters = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const pick = (set: string): string => set.charAt(random(set.length));
  const chars = [...Array.from({ length: 12 }, () => pick(letters)), pick(digits), pick(digits)];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export const PLAN_FIELD = [
  { key: 'monthlyPrice', label: 'Monthly price', unit: 'RWF' },
  { key: 'paymentFeePercent', label: 'Fee per online payment', unit: '%' },
  { key: 'withdrawalFee', label: 'Withdrawal fee', unit: 'RWF' },
  { key: 'staffAccountLimit', label: 'Staff accounts', unit: '' },
] as const;

/** An empty field is "not decided" and saves NULL; the screen shows the same state as a word, never as 0. */
export const planValue = (v: number | null, unlimited = false): string => (v === null ? (unlimited ? 'Unlimited' : 'Not decided') : String(v));

export const parseField = (s: string): number | null => (s.trim() === '' ? null : Number(s.replace(/,/g, '')));

export const TEMPLATE_WORDS = [
  { key: 'product', label: 'Products' }, { key: 'catalog', label: 'Catalog' }, { key: 'category', label: 'Categories' }, { key: 'option', label: 'Options' },
] as const;

export const templateMeta = (t: Pick<TemplateSummary, 'stores' | 'liveVersion'>): string => (t.stores > 0 ? `${t.stores.toLocaleString('en-US')} ${t.stores === 1 ? 'store' : 'stores'}` : t.liveVersion === null ? 'Not offered yet' : 'No stores yet');

export const planSummary = (p: Pick<Plan, 'stores'>): string => `${p.stores.toLocaleString('en-US')} ${p.stores === 1 ? 'store' : 'stores'}`;

// ---------------------------------------------------------------------------
// Message templates (project/Messages.dc.html)
// ---------------------------------------------------------------------------

/** The board's three tweak stores — chosen because one is dark, one is bright and one is LIGHT, which is what proves the button text flips. */
export const SAMPLE_STORES = [
  { key: 'nyama', name: 'Nyama & Co.', mark: 'N', brand: '#1D6B47', item: 'Chicken burger' },
  { key: 'kicks', name: 'Kigali Kicks', mark: 'KK', brand: '#E4572E', item: 'Runner 01 · 42' },
  { key: 'run', name: 'Run Rwanda', mark: 'RR', brand: '#C6F432', item: 'Trail socks' },
] as const;

export const OUTBOX_STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: 'Waiting', tone: 'bg-status-warn text-status-warn-fg' },
  sent: { label: 'Sent', tone: 'bg-status-success text-status-success-fg' },
  failed: { label: 'Failed', tone: 'bg-status-danger text-status-danger-fg' },
  skipped: { label: 'Skipped', tone: 'bg-status-neutral text-status-neutral-fg' },
};
