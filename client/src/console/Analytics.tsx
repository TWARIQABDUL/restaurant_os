// client/src/console/Analytics.tsx — milestone 24, from project/Analytics.dc.html.
//
// SIX TABS, ONE REQUEST EACH. The board shows one at a time and each is its own set of aggregates, so a tab is loaded when
// it is opened — not all six on arrival, five of which the merchant did not ask for.
//
// THE CHART IS DIVS, NOT A LIBRARY, as the board draws it: stacked bars whose heights are percentages of the tallest day.
// Every colour is a design token (the render gate forbids a hex outside tokens.css), so a method's colour is chosen by a
// lookup into the kit's own palette — and the bar's `title` and the table beneath carry the exact figure, because a bar
// is for shape and a number is for reading.
//
// THE PERIOD AND ITS COMPARISON ARE THE SERVER'S. "+12% vs previous 14 days" is this fortnight against the one before it,
// both ending on a day boundary in the STORE's zone; this screen formats what it is told.
//
// SAID ON SCREEN WHERE A DEFINITION IS NOT OBVIOUS: delivery's "on time" is measured against the store's slowest zone, and
// the tab says so — a number with an invisible definition is the one a merchant argues with.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, Segmented, SkeletonCard } from '../shared/ui/index.ts';
import { analyticsApi } from './api.ts';
import type { AnalyticsPayload, AnalyticsRange, AnalyticsTab } from './api.ts';
import { TONE_CLASS, barClass, chartTitle, deliveryTiles, formatDay, itemsTiles, onTimeTone, ordersNote, ordersTiles, paymentsTiles, revenueNote, revenueTiles, summaryTiles } from './analyticsLines.ts';
import type { Tile } from './analyticsLines.ts';
import { useShell } from './ShellProvider.tsx';

const TABS: readonly { value: AnalyticsTab; label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'orders', label: 'Orders over time' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'items', label: 'Top items' },
  { value: 'payments', label: 'Payment methods' },
  { value: 'delivery', label: 'Delivery performance' },
];

const RANGES: readonly { value: `${AnalyticsRange}`; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
];

type Loaded = AnalyticsPayload & { range: number; from: string; to: string };

type Props = {
  /** The render gate's seam: effects do not run in static markup. Console.tsx passes none. */
  initial?: Loaded;
  initialTab?: AnalyticsTab;
  initialRange?: AnalyticsRange;
};

export function Analytics({ initial, initialTab, initialRange }: Props = {}): ReactNode {
  const { store, money, may } = useShell();

  const [tab, setTab] = useState<AnalyticsTab>(initialTab ?? 'summary');
  const [range, setRange] = useState<AnalyticsRange>(initialRange ?? 14);
  const [data, setData] = useState<Loaded | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef(initial !== undefined);
  const code = store.currency.code;

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await analyticsApi.load(store.id, tab, range));
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : 'Analytics could not be loaded.');
    }
  }, [store.id, tab, range]);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    setData(null);
    void load();
  }, [load]);

  if (!may('wallet.read')) {
    return (
      <Alert tone="info" headline="Your role can’t see analytics.">
        <span>Revenue is for owners and admins. Ask the owner of {store.name} to change your role.</span>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 grow font-display text-[26px] lg:text-[28px]">Analytics</h1>
        <Segmented label="Period" value={`${range}` as `${AnalyticsRange}`} options={RANGES} onChange={(v) => setRange(Number(v) as AnalyticsRange)} />
        <a
          href={analyticsApi.exportUrl(store.id, tab, range)}
          download
          className="flex h-11 items-center rounded-control border border-control-line bg-surface px-3.5 text-body font-semibold text-ink no-underline"
        >
          Export CSV
        </a>
      </header>

      <div role="tablist" className="flex gap-6 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
            className={`-mb-px h-11 shrink-0 border-b-[3px] bg-transparent px-0.5 text-body font-semibold ${tab === t.value ? 'border-ink text-ink' : 'border-transparent text-muted'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {data === null ? (
        error === null ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : (
          <Alert tone="danger" headline={error}>
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </Alert>
        )
      ) : (
        <Body data={data} days={range} code={code} money={money} />
      )}
    </div>
  );
}

function Body({ data, days, code, money }: { data: Loaded; days: AnalyticsRange; code: string; money: (v: string) => string }): ReactNode {
  let tiles: Tile[] = [];
  let chart: ReactNode = null;
  let table: ReactNode = null;

  if (data.tab === 'summary' || data.tab === 'revenue') {
    const d = data.data;
    tiles = data.tab === 'summary' ? summaryTiles(d, days, code, money) : revenueTiles(d, days, code, money);
    const totals = d.dates.map((day) => Object.values(d.byDay[day] ?? {}).reduce((a, c) => a + Number(c), 0));
    const max = Math.max(1, ...totals);
    const used = d.methods.filter((m) => d.dates.some((day) => d.byDay[day]?.[m.key] !== undefined));
    chart = (
      <Chart
        title={chartTitle('revenue', d.dates)}
        note={revenueNote(d)}
        legend={used.map((m) => ({ name: m.kind === 'offline' ? `${m.name} (confirmed)` : m.name, bar: barClass(m.key) }))}
        bars={d.dates.map((day, i) => ({
          day,
          tip: `${formatDay(day)} · ${money(totals[i]!.toFixed(2))}`,
          segs: used.map((m) => ({ pct: (Number(d.byDay[day]?.[m.key] ?? 0) / max) * 100, bar: barClass(m.key) })),
        }))}
      />
    );
  } else if (data.tab === 'orders') {
    const d = data.data;
    tiles = ordersTiles(d, days);
    const max = Math.max(1, ...d.dates.map((day) => d.perDay[day] ?? 0));
    chart = (
      <Chart
        title={chartTitle('orders', d.dates)}
        note={ordersNote(d)}
        legend={[{ name: 'Orders', bar: 'bg-brand' }]}
        bars={d.dates.map((day) => ({ day, tip: `${formatDay(day)} · ${d.perDay[day] ?? 0} orders`, segs: [{ pct: ((d.perDay[day] ?? 0) / max) * 100, bar: 'bg-brand' }] }))}
      />
    );
  } else if (data.tab === 'items') {
    const d = data.data;
    tiles = itemsTiles(d);
    const max = Math.max(1, ...d.items.map((i) => Number(i.revenue)));
    table = (
      <Table
        head={['#', 'Item', 'Share of revenue', 'Sold', 'Revenue']}
        empty="No orders in this period."
        rows={d.items.map((i, n) => ({ key: i.name, cells: [String(n + 1), i.name, null, `${i.sold} sold`, money(i.revenue)], pct: (Number(i.revenue) / max) * 100, bar: 'bg-brand' }))}
      />
    );
  } else if (data.tab === 'payments') {
    const d = data.data;
    tiles = paymentsTiles(d, money);
    const max = Math.max(1, ...d.methods.map((m) => m.orders));
    table = (
      <Table
        head={['#', 'Method', 'Share of orders', 'Success', 'Revenue']}
        empty="No orders in this period."
        rows={d.methods.map((m, n) => ({
          key: m.key,
          cells: [String(n + 1), m.name, null, m.successRate === null ? '—' : `${m.successRate}% success`, money(m.revenue)],
          pct: (m.orders / max) * 100,
          bar: barClass(m.key),
        }))}
      />
    );
  } else if (data.tab === 'delivery') {
    const d = data.data;
    tiles = deliveryTiles(d);
    const max = 100;
    table = (
      <>
        <Table
          head={['#', 'Rider', 'On-time share', 'Deliveries', 'Avg. time']}
          empty="No deliveries in this period."
          rows={d.riders.map((r, n) => {
            const tone = onTimeTone(r.onTimeShare);
            return {
              key: r.id,
              cells: [String(n + 1), r.name, null, `${r.deliveries} deliveries`, `${r.avgMinutes === null ? '—' : `${r.avgMinutes} min`} · ${r.onTimeShare === null ? '—' : `${r.onTimeShare}%`} on time`],
              pct: ((r.onTimeShare ?? 0) / max) * 100,
              bar: tone === 'good' ? 'bg-brand' : tone === 'warn' ? 'bg-status-warn-fg' : tone === 'bad' ? 'bg-status-danger-fg' : 'bg-control-line',
              alarm: tone === 'bad',
            };
          })}
        />
        <p className="m-0 text-caption text-muted">
          {d.etaMaxMinutes === null
            ? 'On-time share needs a delivery zone with an ETA to measure against.'
            : `On time means delivered within ${d.etaMaxMinutes} minutes of the order — your slowest delivery zone’s ETA. Average time is from pickup to the door.`}
        </p>
      </>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-card border border-line bg-surface px-4 py-3.5">
            <div className="text-caption font-semibold text-muted">{t.label}</div>
            <div className="font-display text-[24px] font-bold tabular-nums">{t.value}</div>
            <div className={`text-[12px] ${TONE_CLASS[t.tone]}`}>{t.sub}</div>
          </div>
        ))}
      </div>
      {chart}
      {table}
    </>
  );
}

type Bar = { day: string; tip: string; segs: { pct: number; bar: string }[] };

function Chart({ title, note, legend, bars }: { title: string; note: string; legend: { name: string; bar: string }[]; bars: Bar[] }): ReactNode {
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-title">{title}</h2>
        <div className="flex flex-wrap gap-3 text-caption text-ink-2">
          {legend.map((l) => (
            <span key={l.name} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`size-2.5 rounded-chip ${l.bar}`} />
              {l.name}
            </span>
          ))}
        </div>
      </div>
      <div role="img" aria-label={title} className="flex h-[220px] items-end gap-1.5 border-b border-line-subtle">
        {bars.map((b) => (
          <div key={b.day} title={b.tip} className="flex h-full min-w-0 flex-1 flex-col justify-end">
            {b.segs.map((s, i) => (
              <span key={i} className={`block w-full ${s.bar}`} style={{ height: `${s.pct}%` }} />
            ))}
          </div>
        ))}
      </div>
      <div className="flex gap-1.5 text-[11px] text-muted">
        {bars.map((b, i) => (
          <span key={b.day} className="min-w-0 flex-1 truncate text-center">
            {bars.length > 14 && i % 2 === 1 ? '' : formatDay(b.day).split(' ')[0]}
          </span>
        ))}
      </div>
      <span className="text-caption text-muted">{note}</span>
    </section>
  );
}

type TableRow = { key: string; cells: (string | null)[]; pct: number; bar: string; alarm?: boolean };

/** The board's table: rank, name, a bar for the share, then two figures. The null cell is where the bar goes. */
function Table({ head, rows, empty }: { head: string[]; rows: TableRow[]; empty: string }): ReactNode {
  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="hidden grid-cols-[32px_minmax(0,1.4fr)_minmax(0,1.6fr)_130px_minmax(0,1.2fr)] gap-3 bg-ground px-4 py-2.5 text-[12px] font-semibold text-muted lg:grid">
        {head.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-line-subtle px-4 py-3 text-body first:border-t-0 lg:grid-cols-[32px_minmax(0,1.4fr)_minmax(0,1.6fr)_130px_minmax(0,1.2fr)]">
          <span className="text-muted">{r.cells[0]}</span>
          <span className="font-semibold">{r.cells[1]}</span>
          <span className="col-span-3 order-last h-2 overflow-hidden rounded-pill bg-status-neutral lg:order-none lg:col-span-1">
            <span className={`block h-full rounded-pill ${r.bar}`} style={{ width: `${Math.max(2, r.pct)}%` }} />
          </span>
          <span className="hidden text-ink-2 lg:block">{r.cells[3]}</span>
          <span className={`tabular-nums lg:text-left ${r.alarm === true ? 'font-semibold text-status-danger-fg' : 'font-semibold'}`}>{r.cells[4]}</span>
        </div>
      ))}
      {rows.length > 0 ? null : <p className="m-0 p-10 text-center text-body text-muted">{empty}</p>}
    </section>
  );
}
