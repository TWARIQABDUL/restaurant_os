// client/src/console/analyticsLines.ts — milestone 24, from project/Analytics.dc.html.
//
// THE FIGURES UNDER EACH TAB, as sentences and tiles, with no React in them. The server returns numbers; the board's
// words ("+12% vs previous 14 days", "Busiest hours: 12:00–13:00", "1.4% of revenue") are this file's.
//
// A PERCENTAGE IS A RATIO OF DECIMAL STRINGS TURNED INTO ONE NUMBER AT THE LAST STEP. Money arrives as strings and is
// never summed here as floats for display; the ratios below are the only arithmetic, and they are shown rounded.

import type { AnalyticsRange, DeliveryAnalytics, ItemsAnalytics, OrdersAnalytics, PaymentsAnalytics, RevenueData } from './api.ts';

export type Tile = { label: string; value: string; sub: string; tone: 'good' | 'quiet' | 'bad' | 'warn' };

/** "+12% vs previous 14 days" / "−8% …" / "" when there is nothing before it to compare with. */
export function delta(current: number, previous: number, days: number): { text: string; tone: Tile['tone'] } {
  if (previous <= 0) return { text: current > 0 ? 'Nothing to compare with yet' : '', tone: 'quiet' };
  const pct = Math.round((100 * (current - previous)) / previous);
  const text = `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}% vs previous ${days} days`;
  return { text, tone: pct > 0 ? 'good' : pct < 0 ? 'bad' : 'quiet' };
}

export const TONE_CLASS: Record<Tile['tone'], string> = {
  good: 'text-status-success-fg',
  quiet: 'text-muted',
  bad: 'text-status-danger-fg',
  warn: 'text-status-warn-fg',
};

/** "6.8M RWF" headline, from a decimal string. The board writes big figures compactly; the table below is exact. */
export function compact(amount: string, code: string): string {
  const n = Number(amount);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M ${code}`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}K ${code}`;
  return `${Math.round(n).toLocaleString('en-US')} ${code}`;
}

const pct = (n: number | null): string => (n === null ? '—' : `${n}%`);
const mins = (n: number | null): string => (n === null ? '—' : `${Math.round(n)} min`);

export function summaryTiles(d: RevenueData, days: AnalyticsRange, code: string, money: (v: string) => string): Tile[] {
  const rev = delta(Number(d.revenue), Number(d.previousRevenue), days);
  const ord = delta(d.orders, d.previousOrders, days);
  const avg = d.orders === 0 ? null : Number(d.revenue) / d.orders;
  return [
    { label: 'Revenue', value: compact(d.revenue, code), sub: rev.text, tone: rev.tone },
    { label: 'Orders', value: d.orders.toLocaleString('en-US'), sub: ord.text.replace(/ vs previous \d+ days/, ''), tone: ord.tone },
    { label: 'Average order', value: avg === null ? '—' : money(avg.toFixed(2)), sub: '', tone: 'quiet' },
    { label: 'Repeat customers', value: pct(d.repeatShare), sub: 'of orders came from returning customers', tone: 'quiet' },
  ];
}

export function revenueTiles(d: RevenueData, days: AnalyticsRange, code: string, money: (v: string) => string): Tile[] {
  const rev = delta(Number(d.revenue), Number(d.previousRevenue), days);
  const refunded = Number(d.revenue) === 0 ? null : Math.round((1000 * Number(d.refunded)) / Number(d.revenue)) / 10;
  return [
    { label: 'Revenue', value: compact(d.revenue, code), sub: rev.text.replace(/ vs previous \d+ days/, ''), tone: rev.tone },
    { label: 'Refunded', value: money(d.refunded), sub: refunded === null ? '' : `${refunded}% of revenue`, tone: 'quiet' },
    { label: 'Pending now', value: money(d.pendingNow), sub: 'Clears within the hour', tone: 'quiet' },
    { label: 'Paid out', value: compact(d.paidOut, code), sub: `${d.automaticPayouts} automatic ${d.automaticPayouts === 1 ? 'payout' : 'payouts'}`, tone: 'quiet' },
  ];
}

export function ordersTiles(d: OrdersAnalytics, days: AnalyticsRange): Tile[] {
  const t = delta(d.total, d.previousTotal, days);
  return [
    { label: 'Orders', value: d.total.toLocaleString('en-US'), sub: t.text.replace(/ vs previous \d+ days/, ''), tone: t.tone },
    { label: 'Delivery / pickup', value: d.deliveryShare === null ? '—' : `${d.deliveryShare}% / ${100 - d.deliveryShare}%`, sub: '', tone: 'quiet' },
    { label: 'Declined or cancelled', value: String(d.turnedAway), sub: d.topReason === null ? '' : `Most common: ${d.topReason}`, tone: 'quiet' },
    { label: 'Accept time', value: mins(d.acceptMinutes), sub: 'median, from order to Accept', tone: 'quiet' },
  ];
}

export function itemsTiles(d: ItemsAnalytics): Tile[] {
  return [
    { label: 'Items sold', value: d.itemsSold.toLocaleString('en-US'), sub: '', tone: 'quiet' },
    { label: 'Best seller', value: d.bestSeller ?? '—', sub: 'by quantity', tone: 'quiet' },
    { label: 'Top earner', value: d.topEarner ?? '—', sub: 'by revenue', tone: 'quiet' },
    // The board's "Ran out most" needs a history of stock-outs nothing records; this is what IS known.
    { label: 'Out of stock now', value: String(d.outOfStockNow), sub: d.outOfStockNow === 0 ? 'Everything you track has stock' : 'products you track with nothing left', tone: d.outOfStockNow === 0 ? 'quiet' : 'bad' },
  ];
}

export function paymentsTiles(d: PaymentsAnalytics, money: (v: string) => string): Tile[] {
  return [
    { label: 'Paid online', value: d.paidOnlineShare === null ? '—' : `${d.paidOnlineShare}%`, sub: 'MoMo, Airtel and card', tone: 'quiet' },
    { label: 'Failed payments', value: String(d.failedPayments), sub: `Customers retried ${d.retriedAfterFailure} of them`, tone: 'quiet' },
    {
      label: 'Cash unconfirmed',
      value: `${d.cashUnconfirmed.orders} ${d.cashUnconfirmed.orders === 1 ? 'order' : 'orders'}`,
      sub: d.cashUnconfirmed.orders === 0 ? 'Nothing waiting' : `${money(d.cashUnconfirmed.amount)} · see Riders & cash`,
      tone: d.cashUnconfirmed.orders === 0 ? 'quiet' : 'bad',
    },
    { label: 'Refunds', value: String(d.refunds.count), sub: money(d.refunds.amount), tone: 'quiet' },
  ];
}

export function deliveryTiles(d: DeliveryAnalytics): Tile[] {
  return [
    { label: 'Order to door', value: mins(d.orderToDoorMinutes), sub: 'median', tone: 'quiet' },
    { label: 'Prep time', value: mins(d.prepMinutes), sub: 'Accept to Ready', tone: 'quiet' },
    { label: 'Waiting for a rider', value: mins(d.waitingForRiderMinutes), sub: 'Ready to picked up', tone: 'warn' },
    { label: 'Returned to store', value: String(d.returned), sub: d.topReturnReason === null ? '' : `Most common: ${d.topReturnReason}`, tone: d.returned === 0 ? 'quiet' : 'bad' },
  ];
}

/** What fills the table's bar for a rider: the board's own thresholds — green from 90, amber from 85, red below. */
export function onTimeTone(share: number | null): 'good' | 'warn' | 'bad' | 'none' {
  if (share === null) return 'none';
  return share >= 90 ? 'good' : share >= 85 ? 'warn' : 'bad';
}

/** The chart note under each bar chart, composed from the data rather than written once and left to go stale. */
export function revenueNote(d: RevenueData): string {
  const totals = d.dates.map((day) => Object.values(d.byDay[day] ?? {}).reduce((a, c) => a + Number(c), 0));
  const best = totals.indexOf(Math.max(...totals));
  const peak = totals[best] ?? 0;
  const parts: string[] = [];
  if (peak > 0) parts.push(`Busiest day: ${formatDay(d.dates[best]!)}.`);
  parts.push('Today is partial. Cash counts once it’s confirmed on the order.');
  return parts.join(' ');
}

export function ordersNote(d: OrdersAnalytics): string {
  const parts: string[] = [];
  if (d.busiestHour !== null) parts.push(`Busiest hour: ${String(d.busiestHour).padStart(2, '0')}:00–${String((d.busiestHour + 1) % 24).padStart(2, '0')}:00.`);
  const away = d.total + d.turnedAway === 0 ? 0 : Math.round((100 * d.turnedAway) / (d.total + d.turnedAway));
  parts.push(`${away}% of orders were declined or cancelled.`);
  return parts.join(' ');
}

/** "10 Sep" from a 'YYYY-MM-DD' — the axis label, read as the store's own date and never shifted by the viewer's zone. */
export function formatDay(day: string): string {
  const [, m, d] = day.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d)} ${months[Number(m) - 1] ?? ''}`;
}

export function chartTitle(tab: 'summary' | 'revenue' | 'orders', dates: string[]): string {
  const span = `${formatDay(dates[0]!)}–${formatDay(dates[dates.length - 1]!)}`;
  return tab === 'orders' ? `Orders per day, ${span}` : `Revenue per day, ${span}`;
}

/** Which token each method's bar uses. Closed to the kit's own colours — the gate forbids a hex outside the tokens. */
export const METHOD_BAR: Record<string, string> = {
  mtn_momo: 'bg-brand',
  cash: 'bg-status-warn-fg',
  airtel_money: 'bg-status-danger-fg',
  mpesa: 'bg-status-progress-fg',
  card: 'bg-status-info-fg',
};

export const barClass = (key: string): string => METHOD_BAR[key] ?? 'bg-ink-2';
