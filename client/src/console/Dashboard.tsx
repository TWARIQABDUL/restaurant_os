// client/src/console/Dashboard.tsx — milestone 19, from project/Dashboard.dc.html and project/DashboardMobile.dc.html.
//
// ONE TREE, TWO COMPOSITIONS. `Main`'s responsive rule is that "layouts re-compose at each size; nothing is
// simply shrunk", and the two boards are exactly that: the same eight facts, arranged differently. So this is
// one component whose sections carry the breakpoint, not two screens sharing a fetch.
//
// WHAT EACH SIZE KEEPS, and the boards decided all of it:
//
//   both       the greeting, the four figures, the orders waiting on somebody
//   desktop    the open/paused banner with its switch, the week's bars, the recent-orders table, the header's
//              two actions
//   phone      the store's mark beside the greeting, a 2×2 grid, and ONE low-stock warning naming the product —
//              because a merchant on a phone needs the worst thing rather than all of them
//
// THE MONEY IS SIMPLY ABSENT FOR A MANAGER. The route omits `sales` and `week` for a role without
// `wallet.read`, so this renders three cards instead of four and no chart. It does not grey anything out or
// explain itself: §5.4's point is that a role is a set of permissions rather than a set of excuses, and a
// manager's dashboard is a complete dashboard of the things they do.

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { dashboard as dashboardApi } from './api.ts';
import type { ConsoleOrder, DashboardData } from './api.ts';
import { dateline, greeting, relativeWhen } from './lines.ts';
import { useShell } from './ShellProvider.tsx';
import { OrderStatusBadge } from '../shared/ui/index.ts';
import type { StatusTone } from '../shared/ui/index.ts';

type Props = {
  data: DashboardData;
  /** Replaces the whole payload after the pause switch, which changes what the banner says. */
  onChanged: (next: DashboardData) => void;
};

// NO `navigate` PROP YET, AND THAT IS THE POINT. Three of the board's cards link into Orders and Products, which
// arrive at milestones 20 and 22. A link to a route that does not exist would fall through the router's catch-all
// and land a merchant on the sign-in page, so until those screens exist the cards are cards. Each of those
// milestones passes a navigate() down and its own card becomes a link — see StatCard.

// The card and its figure at both sizes. 22px on the phone board, 30px on the desktop one — one element with a
// breakpoint rather than two elements and a `hidden`, so the number exists once in the markup.
const CARD = 'flex flex-col gap-0.5 rounded-card border border-line bg-surface p-3.5 lg:gap-1.5 lg:p-5';
const FIGURE = 'font-display text-[22px] font-bold tabular-nums lg:text-[30px]';

export function Dashboard({ data, onChanged }: Props): ReactNode {
  const { store, me, t, has, money } = useShell();
  const { counts, sales, week } = data;

  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);

  const togglePause = useCallback(() => {
    setPausing(true);
    setPauseError(null);
    dashboardApi
      .setAccepting(store.id, !counts.acceptingOrders)
      .then((result) => onChanged({ ...data, counts: { ...counts, acceptingOrders: result.acceptingOrders } }))
      .catch((cause: unknown) =>
        setPauseError(cause instanceof ApiFailure ? cause.message : 'That could not be changed. Try again.'),
      )
      .finally(() => setPausing(false));
  }, [store.id, counts, data, onChanged]);

  const firstName = me.name.trim().split(/\s+/)[0] ?? me.name;
  const hello = `${greeting(store.timeZone)}, ${firstName}`;

  // "Accepting delivery and pickup orders until 22:00" — which words appear depends on what the store offers,
  // asked of the config engine rather than assumed.
  const ways = [has('delivery') ? 'delivery' : null, has('pickup') ? 'pickup' : null].filter(
    (w): w is string => w !== null,
  );
  const openLine =
    !counts.acceptingOrders
      ? 'New orders are paused. Your store page still shows your ' + t('catalog').toLowerCase() + '.'
      : counts.isOpen
        ? `Accepting ${ways.length === 0 ? '' : `${ways.join(' and ')} `}orders${counts.closesAt === null ? '' : ` until ${counts.closesAt}`}`
        : 'Closed right now — your opening hours decide this';

  const openHeadline = !counts.acceptingOrders
    ? 'New orders are paused'
    : counts.isOpen
      ? 'Your store is open'
      : 'Your store is closed';

  const waiting = counts.ordersWaiting;
  const lowStock = counts.lowStockVariants;

  return (
    <div className="flex flex-col gap-3.5 lg:gap-6">
      {/* --- the greeting ------------------------------------------------- */}
      <div className="flex items-end justify-between gap-6">
        <div className="flex items-center gap-2.5">
          {/* The phone board leads with the store's mark; the desktop one has the sidebar for that. */}
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-control bg-store-accent font-display font-bold text-store-on-accent lg:hidden"
          >
            {store.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <p className="m-0 text-caption text-muted">
              <span className="lg:hidden">
                {store.name} · {counts.isOpen ? 'Open' : 'Closed'}
              </span>
              <span className="hidden lg:inline">{dateline(counts.localDate, store.timeZone)}</span>
            </p>
            <h1 className="m-0 mt-0.5 font-display text-[22px] leading-tight lg:text-[32px]">{hello}</h1>
          </div>
        </div>
        <div className="hidden gap-2.5 lg:flex">
          <a
            href={`/${encodeURIComponent(store.slug)}`}
            className="flex h-11 items-center rounded-control border border-control-line bg-surface px-4.5 font-semibold text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            View store
          </a>
          {/* Add product waits for milestone 22, which builds AddProduct. nav.ts explains why an unbuilt
              destination is drawn rather than linked. */}
          <span
            aria-disabled="true"
            title="Coming with the Products screens"
            className="flex h-11 items-center gap-2 rounded-control bg-line-subtle px-4.5 font-semibold text-disabled"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add {t('product', 'one').toLowerCase()}
          </span>
        </div>
      </div>

      {/* --- open, and the pause switch ----------------------------------- */}
      <section className="hidden items-center gap-3.5 rounded-card border border-line bg-surface px-4.5 py-3.5 lg:flex">
        <span
          aria-hidden="true"
          className={`size-2.5 rounded-pill ${
            counts.acceptingOrders && counts.isOpen ? 'bg-status-success-fg' : 'bg-status-warn-fg'
          }`}
        />
        <span className="grow">
          <strong>{openHeadline}</strong> <span className="text-muted">· {openLine}</span>
        </span>
        {pauseError === null ? null : <span className="text-caption text-status-danger-fg">{pauseError}</span>}
        <button
          type="button"
          onClick={togglePause}
          disabled={pausing}
          className="h-10 rounded-control border border-control-line bg-surface px-3.5 text-caption font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-60"
        >
          {counts.acceptingOrders ? 'Pause new orders' : 'Start taking orders'}
        </button>
      </section>

      {/* --- the figures -------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-4">
        {sales === null ? null : (
          <StatCard
            label="Sales today"
            figure={money(sales.salesToday)}
            note={<Change percent={sales.changePercent} localDate={counts.localDate} timeZone={store.timeZone} />}
          />
        )}

        <StatCard
          label="Orders today"
          figure={String(counts.ordersToday)}
          note={
            <span className={waiting === 0 ? 'text-[13px] text-muted' : 'text-[13px] font-semibold text-status-warn-fg'}>
              {waiting === 0 ? 'Nothing waiting' : `${waiting} waiting for you →`}
            </span>
          }
        />

        <StatCard
          label={t('product')}
          figure={String(counts.productsActive)}
          note={
            <span className="text-[13px] text-muted">
              {counts.productsDraft === 0 ? 'All visible' : `${counts.productsDraft} drafts not yet visible`}
            </span>
          }
        />

        <StatCard
          label="Low stock"
          figure={String(lowStock)}
          danger={lowStock > 0}
          note={
            <span
              className={lowStock === 0 ? 'text-[13px] text-muted' : 'text-[13px] font-semibold text-status-danger-fg'}
            >
              {lowStock === 0 ? 'Nothing running out' : 'Restock before tonight →'}
            </span>
          }
        />
      </div>

      {/* --- what needs somebody, and the week --------------------------- */}
      <div className={`grid gap-4 ${week === null ? '' : 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'}`}>
        <NeedsAttention orders={data.needsAttention} timeZone={store.timeZone} money={money} />
        {week === null ? null : <SalesWeek week={week} money={money} localDate={counts.localDate} />}
      </div>

      {/* --- the phone's one warning ------------------------------------- */}
      {data.lowestStock === null ? null : (
        <section className="flex items-center gap-3 rounded-card bg-status-danger p-3.5 text-status-danger-fg lg:hidden">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16v.5" />
          </svg>
          <span className="text-caption">
            <strong>{data.lowestStock.productName}</strong> has {data.lowestStock.left} left.
          </span>
        </section>
      )}

      {/* --- recent orders ----------------------------------------------- */}
      <RecentOrders rows={data.recent} timeZone={store.timeZone} money={money} />
    </div>
  );
}

/** "+12% vs last Tuesday" — the day named, because "vs last week" makes a merchant count back themselves. */
function Change({
  percent,
  localDate,
  timeZone,
}: {
  percent: number | null;
  localDate: string;
  timeZone: string;
}): ReactNode {
  // Null where last week has nothing to compare against. The route returns null rather than "+100%", and a
  // screen must render that as silence: see repositories/dashboard.ts.
  if (percent === null) return <span className="text-[13px] text-muted">No figure for last week</span>;

  const at = new Date(`${localDate}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 7);
  let weekday = 'last week';
  try {
    weekday = `last ${new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(at)}`;
  } catch {
    /* an unknown zone; the generic wording is still true */
  }

  const up = percent >= 0;
  return (
    <span className={`text-[13px] font-semibold ${up ? 'text-status-success-fg' : 'text-status-danger-fg'}`}>
      {up ? '+' : '−'}
      {Math.abs(percent)}% vs {weekday}
    </span>
  );
}

/**
 * One figure.
 *
 * `href` IS OPTIONAL BECAUSE THE SCREEN BEHIND IT MAY NOT EXIST YET. Three of the board's four cards are links
 * into Orders and Products, which arrive at milestones 20 and 22; until then the card is a card. Passing the
 * destination anyway means those milestones delete a prop rather than rewrite the call — and `built` is not a
 * second flag here for the same reason: a card with somewhere to go is a card with an href.
 */
function StatCard({
  label,
  figure,
  note,
  danger = false,
  href,
  navigate,
}: {
  label: string;
  figure: string;
  note: ReactNode;
  danger?: boolean;
  href?: string;
  navigate?: (to: string) => void;
}): ReactNode {
  const body = (
    <>
      <span className="text-caption text-muted">{label}</span>
      <span className={`${FIGURE} ${danger ? 'text-status-danger-fg' : ''}`}>{figure}</span>
      {note}
    </>
  );

  // BUILT SCREENS ONLY. NAV_GROUPS holds whether a section exists; rather than read it twice, a card becomes a
  // link the moment its milestone passes a navigate() in.
  return href === undefined || navigate === undefined ? (
    <div className={CARD}>{body}</div>
  ) : (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
      className={`${CARD} text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink`}
    >
      {body}
    </a>
  );
}

/**
 * "Needs your attention" on the desktop board; "New orders" on the phone's.
 *
 * SAME ROWS, DIFFERENT DENSITY — the desktop row carries the payment chip and a Review button, the phone's
 * carries the total and gets out of the way. One list, because they are the same list.
 */
function NeedsAttention({
  orders,
  timeZone,
  money,
}: {
  orders: readonly ConsoleOrder[];
  timeZone: string;
  money: (value: string) => string;
}): ReactNode {
  return (
    <section className="flex flex-col rounded-card border border-line bg-surface p-3.5 lg:p-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="m-0 text-title lg:text-[18px]">
          <span className="lg:hidden">New orders</span>
          <span className="hidden lg:inline">Needs your attention</span>
        </h2>
      </div>

      {orders.length === 0 ? (
        <p className="py-6 text-center text-caption text-muted">
          Nothing waiting. New orders appear here the moment they arrive.
        </p>
      ) : (
        orders.map((order) => (
          <div
            key={order.id}
            className="flex items-center gap-3 border-t border-line-subtle py-3 lg:gap-3.5"
          >
            <span className="hidden w-[60px] font-mono text-mono lg:inline">#{order.orderNumber}</span>
            <span className="flex min-w-0 grow flex-col">
              <span className="truncate font-semibold">
                <span className="lg:hidden">#{order.orderNumber} · </span>
                {order.customer}
              </span>
              <span className="text-[13px] text-muted">
                {order.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'} · {order.itemCount} items ·{' '}
                {relativeWhen(order.placedAt, timeZone)}
              </span>
            </span>
            <span className="w-[110px] text-right font-semibold tabular-nums">{money(order.total)}</span>
            <span
              className={`hidden shrink-0 rounded-pill px-2.5 py-[3px] text-[12px] font-semibold lg:inline ${
                order.paymentStatus === 'paid'
                  ? 'bg-status-success text-status-success-fg'
                  : 'bg-status-warn text-status-warn-fg'
              }`}
            >
              {order.paymentStatus === 'paid' ? 'Paid' : 'Cash on delivery'}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * "Sales this week" — seven bars, Monday to Sunday, with today's solid.
 *
 * THE BARS ARE PROPORTIONS OF THE BEST DAY, not of a round number, which is what makes a quiet week still
 * readable. A week with no sales at all draws seven baselines rather than dividing by zero.
 */
function SalesWeek({
  week,
  money,
  localDate,
}: {
  week: readonly { day: string; dayOfWeek: number; sales: string }[];
  money: (value: string) => string;
  localDate: string;
}): ReactNode {
  const values = week.map((d) => Number(d.sales));
  const max = Math.max(...values, 0);
  const total = values.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <section className="hidden flex-col rounded-card border border-line bg-surface p-5 lg:flex">
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 text-[18px]">Sales this week</h2>
        <span className="font-bold tabular-nums">{money(total.toFixed(2))}</span>
      </div>
      <div
        aria-label="Daily sales, Monday to Sunday"
        className="grid min-h-[180px] grow grid-cols-7 items-end gap-2.5 pt-5"
      >
        {week.map((day, index) => {
          const value = Number(day.sales);
          const today = day.day === localDate;
          // A day with sales always draws something: a 1px sliver reads as "a little", where nothing reads as
          // "closed", and those are different facts about a shop.
          const height = max <= 0 || !Number.isFinite(value) ? 0 : Math.max(2, Math.round((value / max) * 140));
          return (
            <div key={day.day} className="flex h-full flex-col items-center justify-end gap-1.5">
              <span className="text-[11px] tabular-nums text-muted">
                {value >= 1000 ? `${Math.round(value / 1000)}k` : value > 0 ? String(Math.round(value)) : ''}
              </span>
              <span
                className={`w-full rounded-t-chip ${today ? 'bg-brand' : 'bg-brand-muted'}`}
                style={{ height: `${height}px` }}
              />
              <span className={`text-[12px] ${today ? 'font-bold text-ink' : 'text-muted'}`}>
                {labels[index] ?? ''}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * V004's twelve statuses in the words a merchant reads, with `Main`'s six tones.
 *
 * NOT THE CONFIG ENGINE'S `orderSteps`, and the distinction is the one milestone 17 settled: order_steps is the
 * CUSTOMER's timeline — four labels per industry, matched by position — where this table is the merchant's
 * state machine, which has twelve states and is the same in every industry. A shop that renames "Ready" to
 * "Ready to collect" on its tracking page still has one `ready` status here.
 */
const STATUS: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  pending: { label: 'New', tone: 'info' },
  approved: { label: 'Accepted', tone: 'info' },
  preparing: { label: 'Preparing', tone: 'warn' },
  ready: { label: 'Ready', tone: 'success' },
  assigned: { label: 'Rider assigned', tone: 'progress' },
  out: { label: 'Out for delivery', tone: 'progress' },
  delivered: { label: 'Delivered', tone: 'neutral' },
  collected: { label: 'Collected', tone: 'neutral' },
  returned: { label: 'Returned', tone: 'danger' },
  closed_return: { label: 'Return closed', tone: 'neutral' },
  rejected: { label: 'Declined', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

function RecentOrders({
  rows,
  timeZone,
  money,
}: {
  rows: readonly (ConsoleOrder & { status: string })[];
  timeZone: string;
  money: (value: string) => string;
}): ReactNode {
  return (
    <section className="hidden rounded-card border border-line bg-surface px-5 pb-2 pt-5 lg:block">
      <h2 className="m-0 mb-2 text-[18px]">Recent orders</h2>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-caption text-muted">No orders yet.</p>
      ) : (
        <table className="w-full border-collapse text-caption">
          <caption className="sr-only">The most recent orders at this store</caption>
          <thead>
            <tr className="text-left text-muted">
              <th className="py-2.5 font-semibold">Order</th>
              <th className="font-semibold">Customer</th>
              <th className="font-semibold">Fulfilment</th>
              <th className="text-right font-semibold">Total</th>
              <th className="pl-6 font-semibold">Status</th>
              <th className="text-right font-semibold">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const status = STATUS[row.status] ?? { label: row.status, tone: 'neutral' as StatusTone };
              return (
                <tr key={row.id} className="border-t border-line-subtle">
                  <td className="py-3 font-mono">#{row.orderNumber}</td>
                  <td>{row.customer}</td>
                  <td className="text-muted">{row.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'}</td>
                  <td className="text-right font-semibold tabular-nums">{money(row.total)}</td>
                  <td className="pl-6">
                    <OrderStatusBadge label={status.label} tone={status.tone} />
                  </td>
                  <td className="text-right text-muted">{relativeWhen(row.placedAt, timeZone)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
