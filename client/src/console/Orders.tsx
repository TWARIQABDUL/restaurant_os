// client/src/console/Orders.tsx — milestone 20, from project/Orders.dc.html and project/MobileOrders.dc.html.
//
// ONE TREE, TWO COMPOSITIONS, the same rule Dashboard.tsx (milestone 19) drew from Main: "layouts re-compose
// at each size; nothing is simply shrunk." The desktop board's six columns become a single scrollable tab strip
// on a phone, and the right-hand drawer becomes a full-screen takeover — same data, same actions, one component.
//
// EVERY MUTATION GOES THROUGH act(), which is one function for the same reason storeOrders.ts's routes all
// answer `{ ok, status }`: thirteen bespoke success paths would be thirteen chances for the toast, the refetch
// and the busy flag to disagree with each other. A transition that answers `ok: false` is not an error — it is
// "somebody else already did this" — and the toast says so instead of throwing.
//
// THE COLUMNS AND THE PROGRESS BAR ARE THIS SCREEN'S OWN VOCABULARY, not the config engine's. V002's
// `orderSteps` is per-industry wording for the CUSTOMER's tracking timeline (`repositories/orders.ts`'s header:
// "Services calls its first step 'Booked' where Food calls it 'New'") — food's own template has only four
// positions (new/preparing/ready/delivered) because that is what a CUSTOMER needs to see. A merchant running
// the kitchen needs the OPERATIONAL states in between — accepted, assigned, out for delivery — regardless of
// industry, which is exactly what `Orders.dc.html`'s own fixed six-step bar draws. Reading `t()`/`has()` for
// this screen's labels would be reaching for the wrong vocabulary.
//
// THE LIST IS "WHAT STILL NEEDS SOMEBODY", not every order the store has ever taken — `repositories/orders.ts`'s
// `list()` already scopes it to open orders plus today's closed ones, so this screen groups and searches the
// rows it is given rather than asking the server six separate questions.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import {
  Alert,
  Button,
  Radio,
  SelectField,
  Segmented,
  SkeletonCard,
  Switch,
  TextField,
  Toast,
  useDialog,
} from '../shared/ui/index.ts';
import type { StatusTone } from '../shared/ui/index.ts';
import { orders as ordersApi } from './api.ts';
import type { OrderDetail, OrderListItem, OrderStatus, RefundReasonCode, RiderOption } from './api.ts';
import { ExportOrders } from './ExportOrders.tsx';
import { ageLabel, relativeWhen } from './lines.ts';
import { printHtml, receiptHtml } from './printables.ts';
import { useShell } from './ShellProvider.tsx';

type Props = {
  navigate: (to: string) => void;
  /**
   * A TESTING SEAM, not a feature: `renderToStaticMarkup` runs no effects (the same fact `NotificationsPanel`'s
   * header at milestone 19 relies on), so `list()`'s fetch never resolves in the render gate. Dashboard sidesteps
   * this by taking its whole payload as a prop; Orders can't do that as cleanly — it owns a list, a selected
   * detail, a rider picker and four side panels, not one payload — so these three let render.tsx seed a state
   * directly instead of waiting on a network call that will never come. Console.tsx passes none of them.
   */
  initialOrders?: OrderListItem[];
  initialDetail?: OrderDetail;
  initialMode?: Mode;
};

// ---------------------------------------------------------------------------
// The board's own fixed vocabulary — see the header on why this is not the config engine's
// ---------------------------------------------------------------------------

const STATUS_META: Readonly<Record<OrderStatus, { label: string; tone: StatusTone }>> = {
  pending: { label: 'New', tone: 'info' },
  approved: { label: 'Accepted', tone: 'success' },
  preparing: { label: 'Preparing', tone: 'warn' },
  ready: { label: 'Ready', tone: 'success' },
  assigned: { label: 'Rider coming to collect', tone: 'progress' },
  out: { label: 'Out for delivery', tone: 'progress' },
  delivered: { label: 'Delivered', tone: 'neutral' },
  collected: { label: 'Collected', tone: 'neutral' },
  returned: { label: 'Returned to store', tone: 'danger' },
  closed_return: { label: 'Closed · returned', tone: 'neutral' },
  rejected: { label: 'Declined', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

/**
 * A full class string per tone, never built by interpolation — `check:styles` (milestone 14) asserts every
 * token-derived utility was actually EMITTED, which means Tailwind must see it as a literal in the source.
 * `bg-status-${tone}` would build, typecheck and render unstyled, which is the exact failure mode that gate
 * exists for. `Badge.tsx`'s own `FILLED`/`OUTLINED` records are the same fix for the same reason.
 */
const TONE_CHIP: Readonly<Record<StatusTone, string>> = {
  neutral: 'bg-status-neutral text-status-neutral-fg',
  info: 'bg-status-info text-status-info-fg',
  warn: 'bg-status-warn text-status-warn-fg',
  progress: 'bg-status-progress text-status-progress-fg',
  success: 'bg-status-success text-status-success-fg',
  danger: 'bg-status-danger text-status-danger-fg',
};

/** Exported for the render gate: the board's status vocabulary, pinned directly rather than scraped from markup. */
export function statusMeta(o: Pick<OrderListItem, 'status' | 'paymentMethod' | 'cashConfirmed'>): { label: string; tone: StatusTone } {
  if (o.status === 'delivered' && o.paymentMethod === 'cash' && !o.cashConfirmed) {
    return { label: 'Delivered · cash unconfirmed', tone: 'warn' };
  }
  return STATUS_META[o.status];
}

/** The board's six columns. A column is a set of statuses, not one — "With rider" is two. */
const COLUMNS: readonly { id: string; label: string; match: (o: OrderListItem) => boolean }[] = [
  { id: 'new', label: 'New', match: (o) => o.status === 'pending' },
  { id: 'preparing', label: 'Preparing', match: (o) => o.status === 'approved' || o.status === 'preparing' },
  { id: 'ready', label: 'Ready', match: (o) => o.status === 'ready' },
  { id: 'rider', label: 'With rider', match: (o) => o.status === 'assigned' || o.status === 'out' },
  {
    id: 'closing',
    label: 'Needs closing',
    match: (o) => o.status === 'returned' || (o.status === 'delivered' && o.paymentMethod === 'cash' && !o.cashConfirmed),
  },
  {
    id: 'done',
    label: 'Done today',
    match: (o) =>
      o.status === 'collected' ||
      o.status === 'closed_return' ||
      o.status === 'rejected' ||
      o.status === 'cancelled' ||
      (o.status === 'delivered' && (o.paymentMethod !== 'cash' || o.cashConfirmed)),
  },
];

/** The drawer's progress bar — six fixed positions, unlike the four-or-five the config engine gives a customer. */
const STEPS = ['New', 'Accepted', 'Preparing', 'Ready', 'With rider', 'Delivered'] as const;
const STEP_INDEX: Readonly<Record<OrderStatus, number>> = {
  pending: 0,
  approved: 1,
  preparing: 2,
  ready: 3,
  assigned: 4,
  out: 4,
  delivered: 5,
  collected: 5,
  returned: 4,
  closed_return: 4,
  rejected: 0,
  cancelled: 0,
};
const STEP_BAD: ReadonlySet<OrderStatus> = new Set(['rejected', 'cancelled', 'returned', 'closed_return']);

const DECLINE_REASONS = ['An item is out of stock', 'We’re closing soon', 'We don’t deliver to that area', 'Too busy right now'];
const CANCEL_REASONS = ['Customer asked to cancel', 'An item ran out while preparing', 'Couldn’t reach the customer', 'Something else'];

const REFUND_REASONS: readonly { value: RefundReasonCode; label: string }[] = [
  { value: 'item_missing', label: 'Item missing from the order' },
  { value: 'wrong_item', label: 'Wrong item sent' },
  { value: 'quality_problem', label: 'Quality problem' },
  { value: 'arrived_late', label: 'Arrived very late' },
  { value: 'other', label: 'Other' },
];

/** Exported for the render gate: which of the six columns an order sits in. */
export function columnOf(o: OrderListItem): number {
  const i = COLUMNS.findIndex((c) => c.match(o));
  return i === -1 ? COLUMNS.length - 1 : i;
}

export const COLUMN_LABELS: readonly string[] = COLUMNS.map((c) => c.label);

const CHIP = 'inline-flex items-center rounded-pill px-2 py-[2px] text-[11px] font-bold';

function match(o: OrderListItem, q: string): boolean {
  if (q === '') return true;
  const hay = `${o.orderNumber} ${o.customer} ${o.phone ?? ''}`.toLowerCase();
  return hay.includes(q);
}

type Mode = null | 'decline' | 'cancel' | 'pick' | 'refund' | 'cash';

export function Orders({ navigate, initialOrders, initialDetail, initialMode }: Props): ReactNode {
  const { store, currency, money, may, refreshBadges } = useShell();
  void navigate; // reserved: every action stays on this screen today, nothing here leaves it yet.

  const [view, setView] = useState<'board' | 'list'>('board');
  // The phone-width board shows one status at a time (a tab strip, not every column stacked vertically) —
  // COLUMNS[0] is 'new', the status a merchant opens this screen to see first.
  const [activeColumn, setActiveColumn] = useState<string>(COLUMNS[0]?.id ?? '');
  const [q, setQ] = useState('');
  const [list, setList] = useState<OrderListItem[] | null>(initialOrders ?? null);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(initialDetail?.id ?? null);
  const [detail, setDetail] = useState<OrderDetail | null>(initialDetail ?? null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>(initialMode ?? null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [restock, setRestock] = useState(false);
  const [riders, setRiders] = useState<RiderOption[] | null>(null);
  const [ridersError, setRidersError] = useState<string | null>(null);

  const [refundMode, setRefundMode] = useState<'full' | 'partial'>('full');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState<RefundReasonCode | ''>('');
  const [refundNote, setRefundNote] = useState('');

  const [cashAmount, setCashAmount] = useState('');

  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const flash = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const loadList = useCallback(async (): Promise<void> => {
    try {
      const page = await ordersApi.list(store.id);
      setList(page.orders);
      setListError(null);
    } catch (cause) {
      setListError(cause instanceof ApiFailure ? cause.message : 'Orders could not be loaded.');
    }
  }, [store.id]);

  // Initial load, then a background refresh every 20s — a phone at the counter should not need a manual
  // reload to see what a second screen just did. Paused while the tab is hidden, the same rule Console.tsx's
  // own polling follows.
  useEffect(() => {
    void loadList();
    const tick = (): void => {
      if (document.visibilityState === 'hidden') return;
      void loadList();
    };
    const id = window.setInterval(tick, 20_000);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void loadList();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadList]);

  const loadDetail = useCallback(
    async (id: string): Promise<void> => {
      try {
        const { order } = await ordersApi.get(store.id, id);
        setDetail(order);
        setDetailError(null);
      } catch (cause) {
        setDetailError(cause instanceof ApiFailure ? cause.message : 'That order could not be opened.');
      }
    },
    [store.id],
  );

  const openOrder = useCallback(
    (id: string) => {
      setSelectedId(id);
      setDetail(null);
      setDetailError(null);
      setMode(null);
      setReason('');
      setNote('');
      setRestock(false);
      setRefundMode('full');
      setRefundAmount('');
      setRefundReason('');
      setRefundNote('');
      setCashAmount('');
      void loadDetail(id);
    },
    [loadDetail],
  );

  const closeDrawer = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
    setMode(null);
  }, []);

  const openPicker = useCallback(() => {
    setMode('pick');
    setRidersError(null);
    setRiders(null);
    ordersApi
      .riders(store.id)
      .then((page) => setRiders(page.riders))
      .catch((cause: unknown) =>
        setRidersError(cause instanceof ApiFailure ? cause.message : 'Riders could not be loaded.'),
      );
  }, [store.id]);

  /** Every mutation's shape: run it, refresh what changed, say what happened. */
  const act = useCallback(
    async (run: () => Promise<{ ok: boolean }>, onOk: string, onAlready: string): Promise<void> => {
      setBusy(true);
      try {
        const outcome = await run();
        flash(outcome.ok ? onOk : onAlready);
        if (selectedId !== null) await loadDetail(selectedId);
        await loadList();
        refreshBadges();
      } catch (cause) {
        flash(cause instanceof ApiFailure ? cause.message : 'That could not be done. Try again.');
      } finally {
        setBusy(false);
      }
    },
    [selectedId, loadDetail, loadList, refreshBadges, flash],
  );

  if (list === null && listError === null) {
    return (
      <div className="flex flex-col gap-3">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }
  if (list === null) {
    return (
      <Alert tone="danger" headline={listError ?? 'Orders could not be loaded.'}>
        <Button variant="secondary" onClick={() => void loadList()}>
          Try again
        </Button>
      </Alert>
    );
  }

  const qLower = q.trim().toLowerCase();
  const filtered = list.filter((o) => match(o, qLower));
  const columns = COLUMNS.map((c) => ({ ...c, rows: filtered.filter(c.match) }));
  const rows = [...filtered].sort((a, b) => b.placedAt.localeCompare(a.placedAt));

  return (
    <div className="flex flex-col gap-3.5 lg:gap-4">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="grow">
          <h1 className="m-0 font-display text-[22px] lg:text-[28px]">Orders</h1>
          <p className="m-0 text-caption text-muted">Updates every 20 seconds</p>
        </div>
        <TextField
          label="Search"
          placeholder="Order number, name or phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button variant="secondary" onClick={() => setExporting(true)}>
          Export CSV
        </Button>
        <div className="lg:w-[220px]">
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'board', label: 'Board' },
              { value: 'list', label: 'List' },
            ]}
          />
        </div>
      </header>

      {view === 'board' ? (
        <>
          {/* Phone: one status at a time via a tab strip, instead of scrolling past every column stacked. */}
          <div className="sm:hidden">
            <div role="tablist" aria-label="Order status" className="flex gap-2 overflow-x-auto pb-2.5">
              {columns.map((c) => {
                const on = c.id === activeColumn;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setActiveColumn(c.id)}
                    className={`flex h-11 shrink-0 items-center gap-1.5 rounded-pill border px-3.5 text-[13px] font-semibold ${
                      on ? 'border-store-primary bg-store-primary text-store-on-primary' : 'border-control-line bg-surface text-ink-2'
                    }`}
                  >
                    {c.label}
                    <span className={on ? 'text-[12px] font-bold' : 'text-[12px] font-bold text-muted'}>{c.rows.length}</span>
                  </button>
                );
              })}
            </div>
            {(() => {
              const active = columns.find((c) => c.id === activeColumn) ?? columns[0];
              if (active === undefined) return null;
              return (
                <section className="flex min-h-[160px] flex-col gap-2 rounded-card bg-status-neutral p-2">
                  <div className="flex flex-col gap-2">
                    {active.rows.map((o) => (
                      <OrderCard key={o.id} order={o} money={money} onOpen={() => openOrder(o.id)} />
                    ))}
                    {active.rows.length === 0 ? <p className="px-1 text-[12px] text-muted">Nothing here</p> : null}
                  </div>
                </section>
              );
            })()}
          </div>

          {/* Tablet and up: every status column side by side. */}
          <div className="hidden gap-2.5 overflow-x-auto pb-2 sm:grid sm:grid-cols-2 lg:grid-cols-6">
            {columns.map((c) => (
              <section key={c.id} className="flex min-h-[160px] flex-col gap-2 rounded-card bg-status-neutral p-2">
                <div className="flex items-center gap-1.5 px-1 pb-1">
                  <strong className="grow text-[13px]">{c.label}</strong>
                  <span className="text-[12px] font-bold text-muted">{c.rows.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {c.rows.map((o) => (
                    <OrderCard key={o.id} order={o} money={money} onOpen={() => openOrder(o.id)} />
                  ))}
                  {c.rows.length === 0 ? <p className="px-1 text-[12px] text-muted">Nothing here</p> : null}
                </div>
              </section>
            ))}
          </div>
        </>
      ) : (
        <div className="overflow-auto rounded-card border border-line bg-surface">
          <div className="grid grid-cols-[80px_minmax(0,1.4fr)_minmax(0,1fr)_100px_130px_minmax(0,1.2fr)_70px] gap-2.5 border-b border-line bg-status-neutral px-3.5 py-2.5 text-[12px] font-semibold text-muted">
            <span>Order</span>
            <span>Customer</span>
            <span>Fulfilment</span>
            <span>Total</span>
            <span>Payment</span>
            <span>Status</span>
            <span>Age</span>
          </div>
          {rows.map((o) => {
            const meta = statusMeta(o);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => openOrder(o.id)}
                className="grid w-full grid-cols-[80px_minmax(0,1.4fr)_minmax(0,1fr)_100px_130px_minmax(0,1.2fr)_70px] items-center gap-2.5 border-b border-line-subtle px-3.5 py-2.5 text-left text-body"
              >
                <span className="font-mono text-mono">#{o.orderNumber}</span>
                <span className="truncate font-semibold">{o.customer}</span>
                <span className="text-caption text-ink-2">{o.fulfilment === 'pickup' ? 'Pickup' : 'Delivery'}</span>
                <span className="font-semibold tabular-nums">{money(o.total)}</span>
                <span className={`${CHIP} justify-self-start ${payChip(o).style}`}>{payChip(o).label}</span>
                <span className={`${CHIP} justify-self-start ${TONE_CHIP[meta.tone]}`}>
                  {meta.label}
                </span>
                <span className="text-caption text-muted">{ageLabel(o.ageMinutes)}</span>
              </button>
            );
          })}
          {rows.length === 0 ? <p className="px-3.5 py-6 text-center text-caption text-muted">Nothing here</p> : null}
        </div>
      )}

      {selectedId === null ? null : (
        <OrderDrawer
          detail={detail}
          error={detailError}
          onClose={closeDrawer}
          onRetry={() => void loadDetail(selectedId)}
          busy={busy}
          mode={mode}
          setMode={setMode}
          reason={reason}
          setReason={setReason}
          note={note}
          setNote={setNote}
          restock={restock}
          setRestock={setRestock}
          riders={riders}
          ridersError={ridersError}
          refundMode={refundMode}
          setRefundMode={setRefundMode}
          refundAmount={refundAmount}
          setRefundAmount={setRefundAmount}
          refundReason={refundReason}
          setRefundReason={setRefundReason}
          refundNote={refundNote}
          setRefundNote={setRefundNote}
          cashAmount={cashAmount}
          setCashAmount={setCashAmount}
          may={may}
          money={money}
          currency={currency}
          openPicker={openPicker}
          onAccept={() =>
            void act(
              async () => {
                const r = await ordersApi.accept(store.id, selectedId);
                return { ok: r.accepted };
              },
              `#${detail?.orderNumber} accepted · customer notified`,
              'Already accepted.',
            )
          }
          onDecline={() =>
            void act(
              () => ordersApi.decline(store.id, selectedId, reason, note || undefined),
              `#${detail?.orderNumber} declined`,
              'That order was already decided.',
            )
          }
          onCancel={() =>
            void act(
              () => ordersApi.cancel(store.id, selectedId, reason, note || undefined),
              `#${detail?.orderNumber} cancelled`,
              'That order can no longer be cancelled.',
            )
          }
          onStartPreparing={() =>
            void act(
              () => ordersApi.startPreparing(store.id, selectedId),
              `Preparing #${detail?.orderNumber}`,
              'That order is not waiting to be started.',
            )
          }
          onMarkReady={() =>
            void act(
              () => ordersApi.markReady(store.id, selectedId),
              `#${detail?.orderNumber} is ready`,
              'That order is not being prepared.',
            )
          }
          onAssignRider={(riderId) =>
            void act(
              () => ordersApi.assignRider(store.id, selectedId, riderId),
              'Rider assigned · their phone is buzzing',
              'That order cannot take a rider right now.',
            )
          }
          onPickedUp={() =>
            void act(
              () => ordersApi.markPickedUp(store.id, selectedId),
              `Handed to the rider`,
              'That order has not been assigned to a rider.',
            )
          }
          onDelivered={() =>
            void act(
              () => ordersApi.markDelivered(store.id, selectedId),
              `#${detail?.orderNumber} marked delivered`,
              'That order is not out for delivery.',
            )
          }
          onCollected={() =>
            void act(
              () => ordersApi.markCollected(store.id, selectedId),
              `#${detail?.orderNumber} collected`,
              'That order is not ready for collection.',
            )
          }
          onConfirmCash={(amount) =>
            void act(
              () => ordersApi.confirmCash(store.id, selectedId, amount),
              'Cash confirmed',
              'There is nothing to confirm.',
            )
          }
          onCloseReturn={() =>
            void act(
              () => ordersApi.closeReturn(store.id, selectedId, restock),
              `#${detail?.orderNumber} closed`,
              'That order is not a return waiting to be closed.',
            )
          }
          onRetryDelivery={() =>
            void act(
              () => ordersApi.retryDelivery(store.id, selectedId),
              'Back in Ready · assign a rider',
              'That order is not a return waiting to be retried.',
            )
          }
          onSendRefund={() =>
            void act(
              async () => {
                if (refundReason === '') throw new ApiFailure({ status: 0, code: 'MISSING', message: 'Choose a reason.' });
                const amount = refundMode === 'full' ? (detail?.total ?? '0') : refundAmount;
                await ordersApi.requestRefund(store.id, selectedId, amount, refundReason, refundNote || undefined);
                return { ok: true };
              },
              'Refund request sent to Vendlyfy',
              'That could not be sent.',
            )
          }
          onPrint={() => {
            if (detail === null) return;
            // The store's CLOCK and CONTACT on the paper, not the printing device's: a counter tablet set to another zone still prints the right time.
            printHtml(
              receiptHtml({
                store: { name: store.name, address: store.address, phone: store.phone, slug: store.slug },
                host: window.location.host,
                order: { number: detail.orderNumber, placedAt: detail.placedAt, fulfilment: detail.fulfilment, customer: detail.customer, address: detail.address, lines: detail.lines, total: detail.total, paymentMethod: detail.paymentMethod, paymentStatus: detail.paymentStatus, riderName: detail.riderName },
                timeZone: store.timeZone,
                currencyCode: currency.code,
              }),
            );
          }}
        />
      )}

      <ExportOrders storeId={store.id} open={exporting} onClose={() => setExporting(false)} />

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

function payChip(o: Pick<OrderListItem, 'paymentMethod' | 'paymentStatus' | 'cashConfirmed'>): { label: string; style: string } {
  if (o.paymentMethod === 'cash') {
    return o.cashConfirmed
      ? { label: 'Cash · paid', style: 'bg-status-success text-status-success-fg' }
      : { label: 'Cash · unpaid', style: 'bg-status-warn text-status-warn-fg' };
  }
  return { label: 'Paid', style: 'bg-status-success text-status-success-fg' };
}

function OrderCard({
  order,
  money,
  onOpen,
}: {
  order: OrderListItem;
  money: (v: string) => string;
  onOpen: () => void;
}): ReactNode {
  const pay = payChip(order);
  const isNew = order.status === 'pending';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex flex-col gap-1.5 rounded-control bg-surface p-2.5 text-left ${isNew && order.ageMinutes > 3 ? 'shadow-[inset_3px_0_0_var(--color-status-info-fg)]' : ''}`}
    >
      <span className="flex items-center justify-between">
        <span className="font-mono text-[13px] text-mono">#{order.orderNumber}</span>
        <span className={`text-[12px] font-semibold ${isNew && order.ageMinutes > 3 ? 'text-status-danger-fg' : 'text-muted'}`}>
          {isNew && order.ageMinutes > 3 ? `Overdue · ${ageLabel(order.ageMinutes)}` : ageLabel(order.ageMinutes)}
        </span>
      </span>
      <span className="truncate text-[14px] font-semibold">{order.customer}</span>
      <span className="text-[12px] text-muted">{order.itemSummary} · {money(order.total)}</span>
      <span className="flex flex-wrap gap-1">
        <span className={`${CHIP} ${pay.style}`}>{pay.label}</span>
        <span className={`${CHIP} bg-status-neutral text-ink-2`}>{order.fulfilment === 'pickup' ? 'Pickup' : 'Delivery'}</span>
        {order.riderName === null ? null : <span className={`${CHIP} bg-status-progress text-status-progress-fg`}>{order.riderName.split(' ')[0]}</span>}
        {order.hasLiveRefund ? <span className={`${CHIP} bg-status-info text-status-info-fg`}>Refund requested</span> : null}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The drawer — desktop right panel, full-screen on a phone. One markup, one breakpoint.
// ---------------------------------------------------------------------------

type DrawerProps = {
  detail: OrderDetail | null;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  busy: boolean;
  mode: Mode;
  setMode: (m: Mode) => void;
  reason: string;
  setReason: (r: string) => void;
  note: string;
  setNote: (n: string) => void;
  restock: boolean;
  setRestock: (r: boolean) => void;
  riders: RiderOption[] | null;
  ridersError: string | null;
  refundMode: 'full' | 'partial';
  setRefundMode: (m: 'full' | 'partial') => void;
  refundAmount: string;
  setRefundAmount: (a: string) => void;
  refundReason: RefundReasonCode | '';
  setRefundReason: (r: RefundReasonCode | '') => void;
  refundNote: string;
  setRefundNote: (n: string) => void;
  cashAmount: string;
  setCashAmount: (a: string) => void;
  may: (permission: string) => boolean;
  money: (v: string) => string;
  currency: { code: string };
  openPicker: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onCancel: () => void;
  onStartPreparing: () => void;
  onMarkReady: () => void;
  onAssignRider: (riderId: string) => void;
  onPickedUp: () => void;
  onDelivered: () => void;
  onCollected: () => void;
  onConfirmCash: (amount: string) => void;
  onCloseReturn: () => void;
  onRetryDelivery: () => void;
  onSendRefund: () => void;
  onPrint: () => void;
};

function OrderDrawer(props: DrawerProps): ReactNode {
  const { detail, error, onClose, onRetry, busy, mode, setMode } = props;
  const ref = useDialog(true);

  return (
    <dialog
      ref={ref}
      aria-label="Order detail"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-0 max-h-none max-w-none border-0 bg-transparent p-0 backdrop:bg-ink/40 open:fixed open:inset-0 open:flex open:items-stretch open:justify-end"
    >
      <section className="flex h-full w-full flex-col overflow-hidden border-l border-line bg-surface lg:w-[460px]">
        {detail === null ? (
          <div className="flex grow flex-col gap-4 p-5">
            <div className="flex justify-end">
              <CloseX onClose={onClose} />
            </div>
            {error === null ? (
              <>
                <SkeletonCard />
                <SkeletonCard />
              </>
            ) : (
              <Alert tone="danger" headline={error}>
                <Button variant="secondary" onClick={onRetry}>
                  Try again
                </Button>
              </Alert>
            )}
          </div>
        ) : (
          <>
            <header className="flex items-start gap-2.5 border-b border-line px-5 py-4">
              <div className="grow">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[17px] text-mono">#{detail.orderNumber}</span>
                  <StatusBadge meta={statusMeta(detail)} />
                </div>
                <span className="text-caption text-muted">
                  {detail.customer}
                  {detail.phone === null ? '' : ` · ${detail.phone}`} · {detail.fulfilment === 'pickup' ? 'Pickup' : 'Delivery'}
                </span>
              </div>
              <Button variant="text" tone="brand" onClick={props.onPrint}>
                Print receipt
              </Button>
              <CloseX onClose={onClose} />
            </header>

            <div className="flex grow flex-col gap-3.5 overflow-y-auto px-5 py-4">
              <StepsBar status={detail.status} />

              <Banner detail={detail} />

              <section className="flex flex-col gap-1 rounded-control border border-line-subtle p-3">
                {detail.lines.map((l) => (
                  <div key={l.id} className="flex justify-between text-body">
                    <span>
                      {l.quantity}× {l.productName}
                      {l.variantLabel === '' ? '' : ` · ${l.variantLabel}`}
                    </span>
                    <span className="tabular-nums">{props.money(l.lineTotal)}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t border-line-subtle pt-1.5 font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{props.money(detail.total)}</span>
                </div>
                <div className="flex items-center justify-between text-caption">
                  <span className="text-muted">Payment</span>
                  <span className={`${CHIP} ${payChip(detail).style}`}>{payChip(detail).label}</span>
                </div>
                {detail.address === null ? null : <p className="m-0 mt-1 text-caption">{detail.address}</p>}
              </section>

              {mode !== 'pick' ? null : (
                <RiderPanel
                  riders={props.riders}
                  error={props.ridersError}
                  current={detail.riderId}
                  onPick={props.onAssignRider}
                  onCancel={() => setMode(null)}
                  busy={busy}
                />
              )}

              {mode !== 'decline' && mode !== 'cancel' ? null : (
                <ReasonPanel
                  isDecline={mode === 'decline'}
                  reason={props.reason}
                  setReason={props.setReason}
                  note={props.note}
                  setNote={props.setNote}
                  onCancel={() => setMode(null)}
                  onConfirm={mode === 'decline' ? props.onDecline : props.onCancel}
                  busy={busy}
                />
              )}

              {mode !== 'cash' ? null : (
                <CashPanel
                  due={detail.cashDue ?? detail.total}
                  amount={props.cashAmount}
                  setAmount={props.setCashAmount}
                  onCancel={() => setMode(null)}
                  onConfirm={() => props.onConfirmCash(props.cashAmount)}
                  money={props.money}
                  busy={busy}
                />
              )}

              {mode !== 'refund' ? null : (
                <RefundPanel
                  total={detail.total}
                  mode={props.refundMode}
                  setMode={props.setRefundMode}
                  amount={props.refundAmount}
                  setAmount={props.setRefundAmount}
                  reason={props.refundReason}
                  setReason={props.setRefundReason}
                  note={props.refundNote}
                  setNote={props.setRefundNote}
                  onCancel={() => setMode(null)}
                  onConfirm={props.onSendRefund}
                  money={props.money}
                  busy={busy}
                />
              )}

              {detail.status !== 'returned' ? null : (
                <ReturnPanel
                  restock={props.restock}
                  setRestock={props.setRestock}
                  paymentMethod={detail.paymentMethod}
                  total={detail.total}
                  money={props.money}
                />
              )}

              {detail.riderName === null || (detail.status !== 'assigned' && detail.status !== 'out') ? null : (
                <p className="m-0 rounded-control bg-status-neutral p-2.5 text-caption">
                  {detail.riderName} is {detail.status === 'assigned' ? 'coming to collect it' : 'on the way with it'}.
                </p>
              )}

              {detail.hasLiveRefund ? (
                <p className="m-0 rounded-control bg-status-info p-2.5 text-caption text-status-info-fg">
                  A refund request is waiting for Vendlyfy.
                </p>
              ) : null}

              <section className="flex flex-col gap-1">
                <strong className="text-caption text-muted">History</strong>
                {detail.events.map((e, i) => (
                  <div key={i} className="flex gap-2.5 text-caption">
                    <span className="w-11 shrink-0 font-mono text-mono text-muted">
                      {relativeWhen(e.at, 'UTC').replace(' ago', '')}
                    </span>
                    <span>
                      {e.note ?? `${STATUS_META[e.toStatus]?.label ?? e.toStatus}${e.reason === null ? '' : ` · ${e.reason}`}`}
                      {e.actorName === null ? '' : ` · ${e.actorName}`}
                    </span>
                  </div>
                ))}
              </section>
            </div>

            {mode !== null ? null : (
              <footer className="flex flex-col gap-2 border-t border-line px-5 py-3.5">
                <Actions {...props} may={props.may} />
              </footer>
            )}
          </>
        )}
      </section>
    </dialog>
  );
}

function CloseX({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={onClose}
      className="flex size-9 shrink-0 items-center justify-center rounded-pill bg-status-neutral"
    >
      ✕
    </button>
  );
}

function StatusBadge({ meta }: { meta: { label: string; tone: StatusTone } }): ReactNode {
  return <span className={`${CHIP} ${TONE_CHIP[meta.tone]}`}>{meta.label}</span>;
}

function StepsBar({ status }: { status: OrderStatus }): ReactNode {
  const idx = STEP_INDEX[status];
  const bad = STEP_BAD.has(status);
  return (
    <div className="flex gap-1">
      {STEPS.map((label, i) => (
        <span key={label} className="flex flex-1 flex-col gap-1">
          <span
            className={`h-1 rounded-pill ${i < idx ? 'bg-brand' : i === idx ? (bad ? 'bg-status-danger-fg' : 'bg-brand') : 'bg-line'}`}
          />
          <span className="text-[10px] font-semibold text-muted">{label}</span>
        </span>
      ))}
    </div>
  );
}

function Banner({ detail }: { detail: OrderDetail }): ReactNode {
  if (detail.status === 'pending' && detail.ageMinutes > 3) {
    return (
      <Alert tone="danger" headline={`Overdue · waiting ${ageLabel(detail.ageMinutes)}.`}>
        The customer sees “waiting for the store” until you accept.
      </Alert>
    );
  }
  if (detail.status === 'ready' && detail.fulfilment === 'delivery' && detail.riderId === null) {
    return <Alert tone="warn" headline="Ready with no rider assigned yet." />;
  }
  if (detail.status === 'returned') {
    const last = detail.events.at(-1);
    return (
      <Alert tone="danger" headline="Brought back to the store.">
        {last?.reason ?? last?.note ?? ''}
      </Alert>
    );
  }
  if (detail.status === 'rejected' || detail.status === 'cancelled') {
    const last = detail.events.at(-1);
    return (
      <Alert tone="danger" headline={detail.status === 'rejected' ? 'Declined.' : 'Cancelled.'}>
        {last?.reason ?? ''}
      </Alert>
    );
  }
  return null;
}

function ReasonPanel({
  isDecline,
  reason,
  setReason,
  note,
  setNote,
  onCancel,
  onConfirm,
  busy,
}: {
  isDecline: boolean;
  reason: string;
  setReason: (r: string) => void;
  note: string;
  setNote: (n: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}): ReactNode {
  const options = isDecline ? DECLINE_REASONS : CANCEL_REASONS;
  return (
    <section className="flex flex-col gap-2 rounded-control border border-status-danger-fg bg-surface p-3">
      <strong className="text-caption">{isDecline ? 'Why are you declining?' : 'Why are you cancelling?'}</strong>
      {options.map((r) => (
        <Radio key={r} name="order-reason" label={r} checked={reason === r} onChange={() => setReason(r)} tone="brand" />
      ))}
      <TextField label="Message to the customer (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Keep order
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={reason === '' || busy} busy={busy}>
          {isDecline ? 'Decline order' : 'Cancel order'}
        </Button>
      </div>
    </section>
  );
}

function RiderPanel({
  riders,
  error,
  current,
  onPick,
  onCancel,
  busy,
}: {
  riders: RiderOption[] | null;
  error: string | null;
  current: string | null;
  onPick: (id: string) => void;
  onCancel: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <section className="flex flex-col gap-2 rounded-control border border-line p-3">
      <strong className="text-caption">{current === null ? 'Who’s taking it?' : 'Reassign to someone else'}</strong>
      {error !== null ? <Alert tone="danger" headline={error} /> : null}
      {riders === null && error === null ? <SkeletonCard /> : null}
      {riders?.map((r) => {
        const off = r.availability === 'off_duty';
        return (
          <button
            key={r.id}
            type="button"
            disabled={off || busy}
            onClick={() => onPick(r.id)}
            className={`flex items-center gap-2.5 rounded-control p-2 text-left ${off ? 'opacity-50' : ''} ${current === r.id ? 'border-2 border-brand' : 'border border-control-line'}`}
          >
            <span className="grow">
              <strong className="block text-[14px]">{r.name}</strong>
              <span className="text-caption text-muted">
                {off ? 'Off duty' : r.activeJobs === 0 ? 'No jobs' : `${r.activeJobs} job${r.activeJobs > 1 ? 's' : ''} already`}
                {r.cashCarried === '0.00' || r.cashCarried === '0' ? '' : ` · carrying cash`}
              </span>
            </span>
            <span className={`${CHIP} ${off ? 'bg-status-neutral text-muted' : 'bg-status-success text-status-success-fg'}`}>
              {off ? 'Off duty' : 'Available'}
            </span>
          </button>
        );
      })}
      {riders !== null && riders.length === 0 ? <p className="text-caption text-muted">No riders at this store yet.</p> : null}
      <Button variant="text" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </section>
  );
}

function CashPanel({
  due,
  amount,
  setAmount,
  onCancel,
  onConfirm,
  money,
  busy,
}: {
  due: string;
  amount: string;
  setAmount: (a: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  money: (v: string) => string;
  busy: boolean;
}): ReactNode {
  const value = amount === '' ? due : amount;
  const invalid = !/^\d+(\.\d{1,2})?$/.test(value) || Number(value) < 0;
  return (
    <section className="flex flex-col gap-2 rounded-control bg-status-warn p-3 text-status-warn-fg">
      <strong className="text-caption">Confirm cash received</strong>
      <TextField
        label="Amount received"
        inputMode="numeric"
        value={amount === '' ? due : amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <span className="text-caption">Order total is {money(due)}.</span>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button tone="brand" onClick={onConfirm} disabled={invalid || busy} busy={busy}>
          Confirm {money(value)} received
        </Button>
      </div>
    </section>
  );
}

function RefundPanel({
  total,
  mode,
  setMode,
  amount,
  setAmount,
  reason,
  setReason,
  note,
  setNote,
  onCancel,
  onConfirm,
  money,
  busy,
}: {
  total: string;
  mode: 'full' | 'partial';
  setMode: (m: 'full' | 'partial') => void;
  amount: string;
  setAmount: (a: string) => void;
  reason: RefundReasonCode | '';
  setReason: (r: RefundReasonCode | '') => void;
  note: string;
  setNote: (n: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  money: (v: string) => string;
  busy: boolean;
}): ReactNode {
  const amountNum = mode === 'full' ? Number(total) : Number(amount.replace(/[^0-9.]/g, ''));
  const invalid =
    reason === '' ||
    (reason === 'other' && note.trim() === '') ||
    !Number.isFinite(amountNum) ||
    amountNum <= 0 ||
    amountNum > Number(total);

  return (
    <section className="flex flex-col gap-2 rounded-control border border-line p-3">
      <strong className="text-caption">Request a refund</strong>
      <Segmented
        label="Amount"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'full', label: `Full · ${money(total)}` },
          { value: 'partial', label: 'Part of it' },
        ]}
      />
      {mode !== 'partial' ? null : (
        <TextField label="Amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
      )}
      <SelectField
        label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value as RefundReasonCode | '')}
      >
        <option value="">Choose a reason</option>
        {REFUND_REASONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </SelectField>
      {reason !== 'other' ? null : (
        <TextField label="What happened" value={note} onChange={(e) => setNote(e.target.value)} />
      )}
      <span className="text-caption text-ink-2">
        Vendlyfy reviews refund requests. If approved, the amount leaves your balance and goes back to the customer.
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button tone="brand" onClick={onConfirm} disabled={invalid || busy} busy={busy}>
          Send request
        </Button>
      </div>
    </section>
  );
}

function ReturnPanel({
  restock,
  setRestock,
  paymentMethod,
  total,
  money,
}: {
  restock: boolean;
  setRestock: (r: boolean) => void;
  paymentMethod: string;
  total: string;
  money: (v: string) => string;
}): ReactNode {
  return (
    <section className="flex flex-col gap-2 rounded-control border border-line p-3">
      <strong className="text-caption">Receive it back</strong>
      <Switch label="Put items back in stock" checked={restock} onChange={setRestock} tone="brand" labelPosition="before" />
      <span className="text-caption text-muted">
        Off by default for Food &amp; drinks, since cooked food can’t be resold.
      </span>
      <p className="m-0 rounded-control bg-status-neutral p-2 text-caption">
        {paymentMethod === 'cash'
          ? 'Cash order: no money changed hands, so there’s nothing to refund.'
          : `Paid online: closing this refunds ${money(total)} to the customer automatically.`}
      </p>
    </section>
  );
}

function Actions(props: DrawerProps): ReactNode {
  const d = props.detail;
  if (d === null) return null;
  const may = props.may;

  const secondaryBusy = props.busy;

  switch (d.status) {
    case 'pending':
      return (
        <>
          <Button tone="brand" onClick={props.onAccept} busy={secondaryBusy}>
            Accept order
          </Button>
          <Button variant="secondary" onClick={() => props.setMode('decline')} disabled={secondaryBusy}>
            Decline
          </Button>
        </>
      );
    case 'approved':
      return (
        <>
          <Button tone="brand" onClick={props.onStartPreparing} busy={secondaryBusy}>
            Start preparing
          </Button>
          <Button variant="secondary" onClick={() => props.setMode('cancel')} disabled={secondaryBusy}>
            Cancel order
          </Button>
        </>
      );
    case 'preparing':
      return (
        <>
          <Button tone="brand" onClick={props.onMarkReady} busy={secondaryBusy}>
            Mark ready
          </Button>
          <Button variant="secondary" onClick={() => props.setMode('cancel')} disabled={secondaryBusy}>
            Cancel order
          </Button>
        </>
      );
    case 'ready':
      if (d.fulfilment === 'pickup') {
        return (
          <Button tone="brand" onClick={props.onCollected} busy={secondaryBusy}>
            {d.paymentMethod === 'cash' ? `Collected · ${props.money(d.cashDue ?? d.total)} cash received` : 'Mark collected'}
          </Button>
        );
      }
      return may('orders.assign_rider') ? (
        <Button tone="brand" onClick={props.openPicker} disabled={secondaryBusy}>
          Assign a rider
        </Button>
      ) : null;
    case 'assigned':
      return (
        <>
          <Button tone="brand" onClick={props.onPickedUp} busy={secondaryBusy}>
            Hand to {d.riderName?.split(' ')[0] ?? 'the rider'}
          </Button>
          {may('orders.assign_rider') ? (
            <Button variant="secondary" onClick={props.openPicker} disabled={secondaryBusy}>
              Reassign
            </Button>
          ) : null}
        </>
      );
    case 'out':
      return (
        <Button variant="secondary" onClick={props.onDelivered} busy={secondaryBusy}>
          Mark delivered for the rider
        </Button>
      );
    case 'delivered':
      if (d.paymentMethod === 'cash' && !d.cashConfirmed) {
        return (
          <Button tone="brand" onClick={() => props.setMode('cash')} disabled={secondaryBusy}>
            Confirm cash received
          </Button>
        );
      }
      return d.hasLiveRefund ? null : (
        <Button variant="secondary" onClick={() => props.setMode('refund')} disabled={secondaryBusy}>
          Request a refund
        </Button>
      );
    case 'returned':
      return (
        <>
          <Button tone="brand" onClick={props.onCloseReturn} busy={secondaryBusy}>
            Close as returned
          </Button>
          <Button variant="secondary" onClick={props.onRetryDelivery} disabled={secondaryBusy}>
            Try delivery again
          </Button>
        </>
      );
    default:
      return null;
  }
}
