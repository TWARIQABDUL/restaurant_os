// client/src/rider/Rider.tsx — milestone 21, from project/Rider.dc.html.
//
// THE RIDER'S APP IS NOT THE CONSOLE'S. It reaches none of `useShell()`'s config, theme or badges —
// there is nothing here for a merchant's industry words or a store's own colours to apply to, and
// `ShellProvider.tsx`'s own comment at milestone 19 already said why riders are filtered out of the
// console's own store list: "a console with no console navigation in it is not a screen." So this is
// a second, self-contained provider-free screen, fetching its own one document the same way Orders.tsx
// (milestone 20) fetches its own list rather than reaching for a shell that was not built for it.
//
// BRAND, NOT STORE. A rider delivers for whichever store assigned them, and the app around that job —
// the switch, the buttons, the sheets — must look the same whoever that is, for the same reason the
// merchant console's own chrome is Vendlyfy's fixed colour and not the store's (tokens.css, milestone
// 19). Every `Button`/`Switch`/`Radio` below passes `tone="brand"`.
//
// THE NEW-JOB ALERT IS DERIVED, NOT PUSHED — the same architecture Console.tsx's own alert uses: poll,
// compare against what was last seen, and show a banner for an id that is new. `Rider.dc.html`'s own
// prototype times this with a fixed setTimeout because it has no server to ask; this polls the real
// list every 15 seconds instead, paused when the tab is hidden.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure, api } from '../app/api.ts';
import type { SessionResult } from '../app/api.ts';
import { formatMoney } from '../app/core.ts';
import { Alert, Button, Radio, SkeletonCard, TextField, Toast } from '../shared/ui/index.ts';
import { rider as riderApi } from './api.ts';
import type { RiderHome, RiderJob } from './api.ts';

type Props = { slug: string; navigate: (to: string) => void };

type ResolveState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'not-yours' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; storeId: string };

const FAIL_REASONS = ['Customer not answering', 'Wrong or unclear address', 'Customer refused the order', 'Something else'];
const POLL_MS = 15_000;

export function Rider({ slug, navigate }: Props): ReactNode {
  const [resolve, setResolve] = useState<ResolveState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    api
      .get<SessionResult>('/api/session')
      .then((session) => {
        if (!live) return;
        const wanted = slug.toLowerCase();
        const membership = session.memberships.find((m) => m.slug.toLowerCase() === wanted && m.role === 'rider');
        setResolve(membership === undefined ? { status: 'not-yours' } : { status: 'ready', storeId: membership.storeId });
      })
      .catch((cause: unknown) => {
        if (!live) return;
        if (cause instanceof ApiFailure && cause.status === 401) setResolve({ status: 'signed-out' });
        else setResolve({ status: 'failed', message: cause instanceof ApiFailure ? cause.message : 'Something went wrong.' });
      });
    return () => {
      live = false;
    };
  }, [slug]);

  if (resolve.status === 'loading') {
    return (
      <div className="mx-auto flex max-w-sm flex-col gap-4 p-6">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }
  if (resolve.status === 'signed-out') {
    return (
      <div className="mx-auto max-w-sm p-6">
        <Alert tone="info" headline="Please sign in again">
          <Button tone="brand" onClick={() => navigate('/signin')}>
            Sign in
          </Button>
        </Alert>
      </div>
    );
  }
  if (resolve.status === 'not-yours') {
    return (
      <div className="mx-auto max-w-sm p-6">
        <Alert tone="warn" headline={`You’re not a rider at ${slug}`}>
          <Button tone="brand" variant="secondary" onClick={() => navigate('/signin')}>
            Choose another store
          </Button>
        </Alert>
      </div>
    );
  }
  if (resolve.status === 'failed') {
    return (
      <div className="mx-auto max-w-sm p-6">
        <Alert tone="danger" headline={resolve.message} />
      </div>
    );
  }

  return <RiderApp storeId={resolve.storeId} />;
}

type Mode = null | 'cash' | 'fail';

type RiderAppProps = {
  storeId: string;
  /** The render gate's seam, same reason Orders.tsx's and CashReport.tsx's exist: no effects run in SSR. */
  initialData?: RiderHome;
  initialSelectedId?: string;
  initialView?: 'list' | 'job';
  initialMode?: Mode;
};

/** Exported for the render gate, which seeds it directly rather than waiting on a fetch that never runs. */
export function RiderApp({ storeId, initialData, initialSelectedId, initialView, initialMode }: RiderAppProps): ReactNode {
  const [data, setData] = useState<RiderHome | null>(initialData ?? null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'job'>(initialView ?? 'list');
  const [tab, setTab] = useState<'todo' | 'done'>('todo');
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<Mode>(initialMode ?? null);
  const [cashAmount, setCashAmount] = useState('');
  const [failReason, setFailReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [newJob, setNewJob] = useState<RiderJob | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const seenIds = useRef<Set<string> | null>(null);

  const flash = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const load = useCallback(
    async (announceNew: boolean) => {
      try {
        const home = await riderApi.home(storeId);
        setData(home);
        setError(null);

        const todoIds = new Set(home.jobs.filter((j) => j.status === 'assigned' || j.status === 'out').map((j) => j.id));
        if (announceNew && seenIds.current !== null) {
          const fresh = home.jobs.find((j) => j.status === 'assigned' && !seenIds.current?.has(j.id));
          if (fresh !== undefined) setNewJob(fresh);
        }
        seenIds.current = todoIds;
      } catch (cause) {
        setError(cause instanceof ApiFailure ? cause.message : 'Could not load your deliveries.');
      }
    },
    [storeId],
  );

  useEffect(() => {
    void load(false);
    const tick = (): void => {
      if (document.visibilityState === 'hidden') return;
      void load(true);
    };
    const id = window.setInterval(tick, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const money = useCallback((v: string) => (data === null ? v : formatMoney(v, data.currency)), [data]);

  const openJob = useCallback((id: string) => {
    setSelectedId(id);
    setView('job');
    setMode(null);
    setChecked({});
    setCashAmount('');
    setFailReason('');
  }, []);

  const toggleAvailability = useCallback(() => {
    if (data === null) return;
    const next = data.availability !== 'available';
    setData({ ...data, availability: next ? 'available' : 'off_duty' });
    riderApi
      .setAvailability(storeId, next)
      .then((r) => {
        setData((d) => (d === null ? d : { ...d, availability: r.availability }));
        flash(next ? 'You’re available for deliveries.' : 'You’re off duty. Managers can’t assign you.');
      })
      .catch(() => setData((d) => (d === null ? d : { ...d, availability: next ? 'off_duty' : 'available' })));
  }, [data, storeId, flash]);

  if (data === null) {
    return (
      <div className="mx-auto flex max-w-sm flex-col gap-4 p-6">
        {error === null ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <Alert tone="danger" headline={error}>
            <Button tone="brand" variant="secondary" onClick={() => void load(false)}>
              Try again
            </Button>
          </Alert>
        )}
      </div>
    );
  }

  const todo = data.jobs.filter((j) => j.status === 'assigned' || j.status === 'out');
  const done = data.jobs.filter((j) => j.status === 'delivered' || j.status === 'returned');
  const current = data.jobs.find((j) => j.id === selectedId) ?? null;

  const act = async (run: () => Promise<{ ok: boolean }>, onOk: string, onNot: string): Promise<void> => {
    setBusy(true);
    try {
      const outcome = await run();
      flash(outcome.ok ? onOk : onNot);
      await load(false);
      if (outcome.ok) {
        setView('list');
        setMode(null);
      }
    } catch (cause) {
      flash(cause instanceof ApiFailure ? cause.message : 'That could not be done.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative mx-auto flex h-dvh max-w-sm flex-col overflow-hidden bg-surface text-ink">
      {view === 'list' ? (
        <RiderList
          data={data}
          tab={tab}
          setTab={setTab}
          jobs={tab === 'todo' ? todo : done}
          money={money}
          onOpen={openJob}
          onToggleAvailability={toggleAvailability}
        />
      ) : current === null ? null : (
        <JobDetail
          job={current}
          money={money}
          checked={checked}
          setChecked={setChecked}
          mode={mode}
          setMode={setMode}
          cashAmount={cashAmount}
          setCashAmount={setCashAmount}
          failReason={failReason}
          setFailReason={setFailReason}
          busy={busy}
          onBack={() => setView('list')}
          onPickedUp={() =>
            void act(() => riderApi.pickedUp(storeId, current.id), 'Picked up. The customer has been told.', 'That job already moved.')
          }
          onDelivered={() => {
            if (current.paymentMethod === 'cash') {
              setCashAmount(current.cashDue ?? current.total);
              setMode('cash');
              return;
            }
            void act(() => riderApi.delivered(storeId, current.id), `#${current.orderNumber} delivered`, 'That job already moved.');
          }}
          onConfirmCash={() =>
            void act(
              async () => {
                await riderApi.delivered(storeId, current.id);
                return riderApi.confirmCash(storeId, current.id, cashAmount);
              },
              `#${current.orderNumber} delivered · ${money(cashAmount)} cash recorded`,
              'That could not be confirmed.',
            )
          }
          onReturned={() =>
            void act(
              () => riderApi.returned(storeId, current.id, failReason),
              'The store has been told you’re bringing it back.',
              'That job already moved.',
            )
          }
        />
      )}

      {newJob === null ? null : (
        <button
          type="button"
          onClick={() => {
            openJob(newJob.id);
            setNewJob(null);
          }}
          className="absolute left-3 right-3 top-3 flex items-center gap-3 rounded-card bg-brand p-3.5 text-left text-white shadow-menu"
        >
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" />
            </svg>
          </span>
          <span className="flex flex-col">
            <strong>New delivery assigned</strong>
            <span className="text-caption opacity-90">
              #{newJob.orderNumber} · {newJob.storeName}. Tap to open.
            </span>
          </span>
        </button>
      )}

      {toast === null ? null : (
        <div className="absolute bottom-6 left-4 right-4">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

function RiderList({
  data,
  tab,
  setTab,
  jobs,
  money,
  onOpen,
  onToggleAvailability,
}: {
  data: RiderHome;
  tab: 'todo' | 'done';
  setTab: (t: 'todo' | 'done') => void;
  jobs: RiderJob[];
  money: (v: string) => string;
  onOpen: (id: string) => void;
  onToggleAvailability: () => void;
}): ReactNode {
  const available = data.availability === 'available';
  const todoCount = data.jobs.filter((j) => j.status === 'assigned' || j.status === 'out').length;
  const doneCount = data.jobs.filter((j) => j.status === 'delivered' || j.status === 'returned').length;

  return (
    <div className="flex min-h-0 grow flex-col">
      <header className="flex flex-col gap-3 bg-ink p-4 text-white">
        <div className="flex items-center gap-2.5">
          <span className="flex size-10 items-center justify-center rounded-pill bg-white/15 font-bold">
            {data.me.name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2)}
          </span>
          <span className="flex grow flex-col">
            <strong>{data.me.name}</strong>
            <span className="font-mono text-mono text-[12px] opacity-70">
              {data.me.plateNumber} · {data.storeName}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={available}
            onClick={onToggleAvailability}
            className={`flex h-9 items-center gap-2 rounded-pill py-0 pl-1.5 pr-2.5 text-[13px] font-bold ${available ? 'bg-status-success-fg' : 'bg-white/20'}`}
          >
            <span aria-hidden="true" className="size-6 rounded-pill bg-white" />
            {available ? 'Available' : 'Off duty'}
          </button>
        </div>
        <div className="flex items-center justify-between rounded-control bg-white/10 px-3 py-2.5">
          <span className="text-caption opacity-80">Cash with you</span>
          <strong className="tabular-nums">{money(data.cashHeld)}</strong>
        </div>
      </header>

      <div role="tablist" className="flex border-b border-line bg-surface">
        {(
          [
            ['todo', `To deliver (${todoCount})`],
            ['done', `Done today (${doneCount})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`h-12 flex-1 text-body font-bold ${tab === id ? 'text-ink shadow-[inset_0_-3px_0_var(--color-ink)]' : 'text-muted'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex grow flex-col gap-2.5 overflow-y-auto p-4">
        {jobs.map((j) => (
          <JobCard key={j.id} job={j} money={money} onOpen={() => onOpen(j.id)} />
        ))}
        {jobs.length === 0 ? (
          <div className="mt-10 flex flex-col items-center gap-2 text-center text-muted">
            <span className="flex size-14 items-center justify-center rounded-pill bg-line-subtle">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="17" r="3" />
                <circle cx="18" cy="17" r="3" />
                <path d="M6 17h6l3-7h3M9 10h4" />
              </svg>
            </span>
            <strong className="text-ink">
              {tab === 'done' ? 'Nothing finished yet today' : available ? 'No deliveries right now' : 'You’re off duty'}
            </strong>
            <span className="max-w-[260px] text-caption">
              {tab === 'done'
                ? 'Deliveries you complete show up here.'
                : available
                  ? 'You’re available. When a manager assigns you, your phone buzzes.'
                  : 'Switch to Available when you’re ready to take deliveries.'}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const STATUS_META: Record<RiderJob['status'], { label: string; style: string }> = {
  assigned: { label: 'Waiting at store', style: 'bg-status-warn text-status-warn-fg' },
  out: { label: 'On the way', style: 'bg-status-progress text-status-progress-fg' },
  delivered: { label: 'Delivered', style: 'bg-status-success text-status-success-fg' },
  returned: { label: 'Returned to store', style: 'bg-status-danger text-status-danger-fg' },
};

function JobCard({ job, money, onOpen }: { job: RiderJob; money: (v: string) => string; onOpen: () => void }): ReactNode {
  const meta = STATUS_META[job.status];
  return (
    <button type="button" onClick={onOpen} className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3.5 text-left">
      <span className="flex items-center justify-between">
        <span className="font-mono text-mono text-[13px]">#{job.orderNumber}</span>
        <span className={`rounded-pill px-2.5 py-[3px] text-[12px] font-bold ${meta.style}`}>{meta.label}</span>
      </span>
      <span className="text-body">
        <strong>{job.storeName}</strong> · pick up
        <br />
        <strong>{job.customer}</strong> {job.address === null ? '' : `· ${job.address.split(',')[0]}`}
      </span>
      <span
        className={`rounded-control px-2.5 py-1.5 text-[13px] font-bold ${
          job.paymentMethod === 'cash' ? 'bg-status-warn text-status-warn-fg' : 'bg-status-success text-status-success-fg'
        }`}
      >
        {job.paymentMethod === 'cash' ? `Collect ${money(job.cashDue ?? job.total)} cash` : 'Paid online · nothing to collect'}
      </span>
    </button>
  );
}

function JobDetail({
  job,
  money,
  checked,
  setChecked,
  mode,
  setMode,
  cashAmount,
  setCashAmount,
  failReason,
  setFailReason,
  busy,
  onBack,
  onPickedUp,
  onDelivered,
  onConfirmCash,
  onReturned,
}: {
  job: RiderJob;
  money: (v: string) => string;
  checked: Record<string, boolean>;
  setChecked: (c: Record<string, boolean>) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  cashAmount: string;
  setCashAmount: (a: string) => void;
  failReason: string;
  setFailReason: (r: string) => void;
  busy: boolean;
  onBack: () => void;
  onPickedUp: () => void;
  onDelivered: () => void;
  onConfirmCash: () => void;
  onReturned: () => void;
}): ReactNode {
  const atStore = job.status === 'assigned';
  const onRoad = job.status === 'out';
  const bagDone = job.lines.every((l) => checked[l.id] === true);
  const meta = STATUS_META[job.status];

  return (
    <div className="flex min-h-0 grow flex-col">
      <header className="flex h-[60px] shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <button type="button" aria-label="Back to deliveries" onClick={onBack} className="flex size-11 items-center justify-center rounded-pill">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="grow font-bold">
          Delivery <span className="font-mono text-mono font-medium">#{job.orderNumber}</span>
        </span>
        <span className={`mr-1.5 rounded-pill px-2.5 py-[3px] text-[12px] font-bold ${meta.style}`}>{meta.label}</span>
      </header>

      <div className="flex grow flex-col gap-3 overflow-y-auto p-4">
        {!atStore ? null : (
          <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-3.5">
            <span className="text-[12px] font-bold uppercase tracking-wide text-muted">1 · Pick up</span>
            <div className="flex items-center justify-between gap-2.5">
              <span>
                <strong>{job.storeName}</strong>
                <br />
                <span className="text-body text-ink-2">{job.storeAddress ?? 'Address not set'}</span>
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5 rounded-control bg-ink p-3.5 text-white">
              <span className="text-caption opacity-70">Show this at the counter</span>
              <span className="font-mono text-mono text-[28px] tracking-wide">#{job.orderNumber}</span>
            </div>
            <strong className="text-body">Check the bag</strong>
            {job.lines.map((l) => {
              const on = checked[l.id] === true;
              return (
                <button
                  key={l.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => setChecked({ ...checked, [l.id]: !on })}
                  className="flex min-h-11 items-center gap-2.5 border-t border-line-subtle text-left text-body"
                >
                  <span className={`flex size-[22px] shrink-0 items-center justify-center rounded-chip text-[13px] text-white ${on ? 'bg-brand' : 'border-[1.5px] border-control-line'}`}>
                    {on ? '✓' : ''}
                  </span>
                  {l.quantity}× {l.productName}
                  {l.variantLabel === '' ? '' : ` · ${l.variantLabel}`}
                </button>
              );
            })}
          </section>
        )}

        <section className={`flex flex-col gap-2.5 rounded-card border border-line bg-surface p-3.5 ${atStore ? 'opacity-60' : ''}`}>
          <span className="text-[12px] font-bold uppercase tracking-wide text-muted">2 · Deliver to</span>
          <div>
            <strong>{job.customer}</strong>
            <br />
            <span className="text-body text-ink-2">{job.address ?? 'No address on this order'}</span>
          </div>
        </section>

        <section className={`flex items-center justify-between rounded-card p-3.5 ${job.paymentMethod === 'cash' ? 'bg-status-warn text-status-warn-fg' : 'bg-status-success text-status-success-fg'}`}>
          <strong>{job.paymentMethod === 'cash' ? 'Collect cash' : 'Already paid'}</strong>
          <span className="text-[20px] font-extrabold tabular-nums">{money(job.total)}</span>
        </section>
      </div>

      <div className="flex flex-col gap-2 border-t border-line bg-surface p-4">
        {atStore ? (
          <Button tone="brand" onClick={onPickedUp} disabled={!bagDone} busy={busy} block>
            {bagDone ? 'I’ve picked it up' : 'Tick every item first'}
          </Button>
        ) : onRoad ? (
          <>
            <Button tone="brand" onClick={onDelivered} busy={busy} block>
              Delivered
            </Button>
            <Button tone="brand" variant="secondary" onClick={() => setMode('fail')} disabled={busy} block>
              Couldn’t deliver
            </Button>
          </>
        ) : null}
      </div>

      {mode !== 'cash' ? null : (
        <CashSheet
          total={job.total}
          amount={cashAmount}
          setAmount={setCashAmount}
          money={money}
          busy={busy}
          onConfirm={onConfirmCash}
          onClose={() => setMode(null)}
        />
      )}
      {mode !== 'fail' ? null : (
        <FailSheet reason={failReason} setReason={setFailReason} busy={busy} onConfirm={onReturned} onClose={() => setMode(null)} />
      )}
    </div>
  );
}

function Sheet({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="absolute inset-0 flex items-end bg-ink/45">
      <div role="dialog" className="flex w-full flex-col gap-3 rounded-t-sheet bg-surface p-5">
        <span aria-hidden="true" className="mx-auto h-1 w-10 rounded-pill bg-control-line" />
        {children}
      </div>
    </div>
  );
}

function CashSheet({
  total,
  amount,
  setAmount,
  money,
  busy,
  onConfirm,
  onClose,
}: {
  total: string;
  amount: string;
  setAmount: (a: string) => void;
  money: (v: string) => string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}): ReactNode {
  const num = Number(amount.replace(/[^0-9.]/g, ''));
  const diff = num - Number(total);
  return (
    <Sheet>
      <strong className="text-[20px]">Collect {money(total)} in cash</strong>
      <span className="text-body text-ink-2">The order is marked unpaid until you confirm. This goes to the store’s cash report.</span>
      <TextField label="Amount received" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
      {diff === 0 || amount === '' ? null : (
        <p className="m-0 rounded-control bg-status-warn p-2.5 text-caption text-status-warn-fg">
          {diff < 0 ? `Short by ${money(String(-diff))}.` : `That’s ${money(String(diff))} more than the order.`}
        </p>
      )}
      <Button tone="brand" onClick={onConfirm} busy={busy} block>
        Confirm cash collected
      </Button>
      <Button tone="brand" variant="text" onClick={onClose} disabled={busy} block>
        Not yet
      </Button>
    </Sheet>
  );
}

function FailSheet({
  reason,
  setReason,
  busy,
  onConfirm,
  onClose,
}: {
  reason: string;
  setReason: (r: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}): ReactNode {
  return (
    <Sheet>
      <strong className="text-[20px]">What happened?</strong>
      {FAIL_REASONS.map((r) => (
        <Radio key={r} name="fail-reason" label={r} checked={reason === r} onChange={() => setReason(r)} tone="brand" />
      ))}
      <Button tone="brand" onClick={onConfirm} disabled={reason === '' || busy} busy={busy} block>
        Take it back to the store
      </Button>
      <Button tone="brand" variant="text" onClick={onClose} disabled={busy} block>
        Keep trying
      </Button>
    </Sheet>
  );
}
