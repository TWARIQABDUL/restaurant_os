// client/src/admin/adminLines.ts — milestone 27. The words and rules of the admin console, with no React in them, so the render
// gate calls them directly (lines.ts, walletLines.ts and the others give the reason).

import type { Kpi, MerchantRow, Overview, Range } from './adminApi.ts';

export const NAV: readonly { label: string; items: readonly { id: string; label: string; path: string; icon: string; built: boolean; badge?: 'merchants' | 'kyc' }[] }[] = [
  {
    label: 'Platform',
    items: [
      { id: 'overview', label: 'Overview', path: '/admin', icon: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 9h8V3h-8z', built: true },
      { id: 'merchants', label: 'Merchants', path: '/admin/merchants', icon: 'M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6', built: true, badge: 'merchants' },
      { id: 'kyc', label: 'Identity checks', path: '/admin/kyc', icon: 'M4 5h16v14H4zM9 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 16c.5-2 5.5-2 6 0M14 9h4M14 13h4', built: true, badge: 'kyc' },
      { id: 'orders', label: 'All orders', path: '/admin/orders', icon: 'M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4', built: false },
    ],
  },
  {
    label: 'Money',
    items: [
      { id: 'payments', label: 'Payment methods', path: '/admin/payments', icon: 'M2 6h20v12H2zM2 10h20M6 15h4', built: false },
      { id: 'currencies', label: 'Currencies', path: '/admin/currencies', icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 6v2M12 16v2', built: false },
      { id: 'payouts', label: 'Payouts', path: '/admin/payouts', icon: 'M12 3v12M7 10l5 5 5-5M4 21h16', built: false },
      { id: 'disputes', label: 'Refunds & disputes', path: '/admin/disputes', icon: 'M12 3l9 16H3zM12 10v4M12 17h.01', built: false },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { id: 'industries', label: 'Industry templates', path: '/admin/industries', icon: 'M4 6h16M4 12h16M4 18h10M18 16v4M16 18h4', built: false },
      { id: 'plans', label: 'Plans & fees', path: '/admin/plans', icon: 'M4 4h16v16H4zM4 9h16M9 9v11', built: false },
      { id: 'team', label: 'Admin team & roles', path: '/admin/team', icon: 'M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', built: false },
      { id: 'audit', label: 'Audit log', path: '/admin/audit', icon: 'M12 8v4l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', built: false },
      { id: 'settings', label: 'Platform settings', path: '/admin/settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12h2M3 12h2M12 3v2M12 19v2', built: false },
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
