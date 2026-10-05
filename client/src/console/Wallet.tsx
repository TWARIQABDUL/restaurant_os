// client/src/console/Wallet.tsx — milestone 23, from project/Wallet.dc.html.
//
// "MoMo and card payments land here. Cash stays with you and your riders." — the board's own first sentence, and the
// whole screen follows from it: two pots (Pending, Available), what rides in a rider's pocket, and the history that
// explains each.
//
// THREE THINGS THE SCREEN REFUSES TO GUESS, because it is about somebody's money:
//
//   * THE BALANCE IS THE SERVER'S. After a withdrawal the screen re-reads the wallet; it never subtracts the amount
//     locally and shows the result as a fact. The board's prototype does exactly that (`available = 184500 -
//     withdrawn`), which is right for a prototype and wrong for a page a merchant checks twice.
//   * A WITHDRAWAL'S OUTCOME IS NOT KNOWN WHEN THE BUTTON IS PRESSED. The request answers "processing" (MoMo has
//     been asked) or "failed" (MoMo said no, and the money is already back). From processing it is polled on the
//     server's real status — the page reports "Withdrawal arrived on your MoMo" only when the server says so.
//   * ONE KEY PER ATTEMPT, MADE WHEN THE SHEET OPENS. A double-tap, a retried request after a lost response and a
//     second tab all carry the same key, and the server turns them into one withdrawal. Closing and reopening the
//     sheet is a new attempt on purpose: the merchant looked at it again and chose again.
//
// THE DESTINATION IS DISPLAYED AND NEVER SENT. The number a payout goes to is in the store's settings; the request
// carries an amount and a key, so no request can redirect money. "Change" belongs to Settings (milestone 25), which
// is why the board's button is present but inert here.
//
// ADDED BECAUSE THE DATABASE REQUIRES IT AND THE BOARD DID NOT DRAW IT: a banner when approved refunds are waiting
// for funds. V008 holds payouts until they are paid ("paid before the merchant is"), so a Withdraw that fails with
// no visible reason would be the screen's fault. Its wording is the database's.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, Segmented, SkeletonCard, Toast, useDialog } from '../shared/ui/index.ts';
import { walletApi } from './api.ts';
import type { ActivityFilter, ActivityRow, Payout, RefundRow, WalletData } from './api.ts';
import { cleanAmount, trimZeros } from './catalogue.ts';
import { hrefFor } from './nav.ts';
import { useShell } from './ShellProvider.tsx';
import { FLOW_TONE, activityLine, availableNote, flowSteps, lockFor, methodName, payoutLine, pendingNote, refundLine, stamp } from './walletLines.ts';

type Tab = 'ledger' | 'withdrawals' | 'refunds';

const FILTERS: readonly { value: ActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'sale', label: 'Sales' },
  { value: 'refund', label: 'Refunds' },
  { value: 'withdrawal', label: 'Payouts' },
  { value: 'adjust', label: 'Adjustments' },
];

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'ledger', label: 'Activity' },
  { value: 'withdrawals', label: 'Withdrawals' },
  { value: 'refunds', label: 'Refunds' },
];

type PayoutCursor = { requestedAt: string; id: string } | null;
type ActivityCursor = { at: string; id: string } | null;

type Props = {
  navigate: (to: string) => void;
  /**
   * A TESTING SEAM, the same one Orders, CashReport and Products took: renderToStaticMarkup runs no effects, so
   * the first fetch never resolves in the render gate. Console.tsx passes none of these.
   */
  initialData?: WalletData;
  initialActivity?: ActivityRow[];
  initialPayouts?: Payout[];
  initialRefunds?: RefundRow[];
  initialTab?: Tab;
  initialSheet?: { amount: string };
};

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'rejected']);

export function Wallet({ navigate, initialData, initialActivity, initialPayouts, initialRefunds, initialTab, initialSheet }: Props): ReactNode {
  const { store, money, may } = useShell();

  const [data, setData] = useState<WalletData | null>(initialData ?? null);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'ledger');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [activity, setActivity] = useState<ActivityRow[] | null>(initialActivity ?? null);
  const [activityNext, setActivityNext] = useState<ActivityCursor>(null);
  const [payouts, setPayouts] = useState<Payout[] | null>(initialPayouts ?? null);
  const [payoutsNext, setPayoutsNext] = useState<PayoutCursor>(null);
  const [refunds, setRefunds] = useState<RefundRow[] | null>(initialRefunds ?? null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ amount: string } | null>(initialSheet ?? null);
  const [toast, setToast] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const watching = useRef<string | null>(null);
  const seeded = useRef(initialData !== undefined);
  const seededActivity = useRef(initialActivity !== undefined);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((current) => (current === m ? null : current)), 3500);
  }, []);

  const loadCards = useCallback(async (): Promise<void> => {
    try {
      setData(await walletApi.load(store.id));
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : 'Your wallet could not be loaded.');
    }
  }, [store.id]);

  const loadActivity = useCallback(
    async (more: ActivityCursor): Promise<void> => {
      try {
        const page = await walletApi.activity(store.id, filter, more);
        setActivity((prev) => (more === null || prev === null ? page.activity : [...prev, ...page.activity]));
        setActivityNext(page.nextCursor);
      } catch (cause) {
        flash(cause instanceof ApiFailure ? cause.message : 'Activity could not be loaded.');
      }
    },
    [store.id, filter, flash],
  );

  const loadPayouts = useCallback(
    async (more: PayoutCursor): Promise<void> => {
      try {
        const page = await walletApi.payouts(store.id, more);
        setPayouts((prev) => (more === null || prev === null ? page.payouts : [...prev, ...page.payouts]));
        setPayoutsNext(page.nextCursor);
      } catch (cause) {
        flash(cause instanceof ApiFailure ? cause.message : 'Withdrawals could not be loaded.');
      }
    },
    [store.id, flash],
  );

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    void loadCards();
  }, [loadCards]);

  useEffect(() => {
    // The seeded first paint is not fetched over itself; a filter change is.
    if (seededActivity.current) {
      seededActivity.current = false;
      return;
    }
    void loadActivity(null);
  }, [loadActivity]);

  useEffect(() => {
    if (tab === 'withdrawals' && payouts === null) void loadPayouts(null);
    if (tab === 'refunds' && refunds === null) {
      void walletApi
        .refunds(store.id)
        .then((r) => setRefunds(r.refunds))
        .catch(() => flash('Refunds could not be loaded.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /** Follows one payout until the server says how it ended, then refreshes everything it touched. */
  const watch = useCallback(
    (id: string): void => {
      watching.current = id;
      let attempts = 0;
      const tick = (): void => {
        if (watching.current !== id) return;
        attempts += 1;
        void walletApi
          .payout(store.id, id)
          .then(({ payout }) => {
            if (TERMINAL.has(payout.status)) {
              watching.current = null;
              flash(payout.status === 'completed' ? 'Withdrawal arrived on your MoMo' : 'Withdrawal failed · money is back in Available');
              void loadCards();
              void loadActivity(null);
              void loadPayouts(null);
            } else if (attempts < 40) {
              window.setTimeout(tick, 3000);
            }
          })
          .catch(() => {
            if (attempts < 40) window.setTimeout(tick, 5000);
          });
      };
      window.setTimeout(tick, 2000);
    },
    [store.id, flash, loadCards, loadActivity, loadPayouts],
  );

  useEffect(() => () => void (watching.current = null), []);

  if (!may('wallet.read')) {
    return (
      <Alert tone="info" headline="Your role can’t see the wallet.">
        <span>Ask the owner of {store.name} to change your role.</span>
      </Alert>
    );
  }

  if (data === null) {
    return error === null ? (
      <div className="flex flex-col gap-3" aria-busy="true">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    ) : (
      <Alert tone="danger" headline={error}>
        <Button variant="secondary" onClick={() => void loadCards()}>
          Try again
        </Button>
      </Alert>
    );
  }

  const lock = lockFor(data.identity);
  const locked = lock !== null;
  const canWithdraw = may('payouts.request');
  const owed = Number(data.refundsOwed) > 0;
  const payout = data.payout;
  const tz = store.timeZone;
  const storeNow = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date());

  const changeMode = (mode: 'manual' | 'automatic'): void => {
    if (payout === null || mode === payout.mode || modeBusy) return;
    setModeBusy(true);
    walletApi
      .setMode(store.id, mode)
      .then((r) => {
        if (r.payout !== null) setData((d) => (d === null ? d : { ...d, payout: d.payout === null ? null : { ...d.payout, mode: r.payout!.mode, automaticAt: r.payout!.automaticAt } }));
        flash(mode === 'automatic' ? `Automatic payouts on · every day at ${r.payout?.automaticAt ?? '08:00'}` : 'Automatic payouts off · withdraw whenever you like');
      })
      .catch((cause: unknown) => flash(cause instanceof ApiFailure ? cause.message : 'That could not be changed.'))
      .finally(() => setModeBusy(false));
  };

  const failedRetry = (p: Payout): void => {
    const available = Number(data.available);
    const want = Number(p.amount);
    setSheet({ amount: trimZeros(String(Math.min(available, want))) });
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-[26px] lg:text-[32px]">Money</h1>
          <span className="text-caption text-muted">MoMo and card payments land here. Cash stays with you and your riders.</span>
        </div>
        <Button tone="brand" disabled={locked || !canWithdraw || payout === null} onClick={() => setSheet({ amount: '' })}>
          Withdraw
        </Button>
      </header>

      {lock === null ? null : (
        <div className="flex items-start gap-3 rounded-card border border-status-danger-fg bg-status-danger p-4 text-status-danger-fg">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span className="flex flex-col gap-0.5">
            <strong>{lock.title}</strong>
            <span className="text-body text-ink-2">{lock.body}</span>
            <span className="mt-1">
              <Button variant="secondary" onClick={() => navigate(hrefFor(store.slug, '/verify'))}>
                {data.identity === 'in_review' ? 'See where it stands' : 'Verify now'}
              </Button>
            </span>
          </span>
        </div>
      )}

      {!owed ? null : (
        <div className="flex items-start gap-3 rounded-card border border-status-warn-fg bg-status-warn p-4 text-status-warn-fg">
          <span className="flex flex-col gap-0.5">
            <strong>Payouts are paused while {money(data.refundsOwed)} in approved refunds waits for funds</strong>
            <span className="text-body text-ink-2">An approved refund waiting for funds is paid before you are. It settles as soon as the balance covers it.</span>
          </span>
        </div>
      )}

      {payout !== null ? null : (
        <Alert tone="info" headline="Add the MoMo number your payouts go to.">
          <span>Payouts need a destination in your store settings before you can withdraw.</span>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <section className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4">
          <div className="text-caption font-semibold text-muted">Available</div>
          <div className="font-display text-[30px] tabular-nums">{money(data.available)}</div>
          <div className="text-caption text-muted">
            {availableNote({
              locked,
              mode: payout?.mode ?? 'manual',
              methodKey: payout?.methodKey ?? 'mtn_momo',
              phoneMasked: payout?.phoneMasked ?? '',
              automaticAt: payout?.automaticAt ?? null,
              storeNowHHMM: storeNow,
            })}
          </div>
        </section>
        <section className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4">
          <div className="text-caption font-semibold text-muted">Pending</div>
          <div className="font-display text-[30px] tabular-nums">{money(data.pending)}</div>
          <div className="text-caption text-muted">{pendingNote(data.pendingOrders, data.nextRelease, tz, money)}</div>
        </section>
        <a
          href={hrefFor(store.slug, '/riders')}
          onClick={(e) => {
            e.preventDefault();
            navigate(hrefFor(store.slug, '/riders'));
          }}
          className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4 text-ink no-underline"
        >
          <div className="text-caption font-semibold text-muted">Cash with riders</div>
          <div className="font-display text-[30px] tabular-nums">{money(data.cashWithRiders)}</div>
          <div className="text-caption text-brand-strong">
            {data.shortfalls === 0 ? 'Nothing to settle →' : `${data.shortfalls} ${data.shortfalls === 1 ? 'shortfall' : 'shortfalls'} to settle →`}
          </div>
        </a>
      </div>

      <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-title">How your money moves</h2>
          {payout === null || !canWithdraw ? null : (
            <Segmented
              label="Payout mode"
              value={payout.mode}
              options={[
                { value: 'automatic', label: 'Automatic payouts' },
                { value: 'manual', label: 'I’ll withdraw myself' },
              ]}
              onChange={changeMode}
            />
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {flowSteps({ mode: payout?.mode ?? 'manual', locked, automaticAt: payout?.automaticAt ?? null, holdMinutes: data.holdMinutes }).map((f) => (
            <div key={f.n} className={`flex flex-col gap-1 rounded-control p-3 text-caption ${FLOW_TONE[f.tone]}`}>
              <span className="flex size-6 items-center justify-center rounded-pill bg-ink text-[12px] font-bold text-white">{f.n}</span>
              <strong className="text-body">{f.title}</strong>
              <span>{f.body}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-card border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-4 pt-1">
          <div role="tablist" className="flex gap-6">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={tab === t.value}
                onClick={() => setTab(t.value)}
                className={`-mb-px h-11 border-b-[3px] bg-transparent px-0.5 text-body font-semibold ${tab === t.value ? 'border-ink text-ink' : 'border-transparent text-muted'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="grow" />
          {tab !== 'ledger' ? null : (
            <div className="flex flex-wrap gap-1.5 pb-2">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  onClick={() => {
                    setFilter(f.value);
                    setActivity(null);
                  }}
                  className={`h-8 rounded-pill px-3 text-caption font-semibold ${filter === f.value ? 'border-0 bg-ink text-white' : 'border border-control-line bg-surface text-ink'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {tab !== 'ledger' ? null : (
          <div>
            <div className="hidden grid-cols-[130px_minmax(0,2fr)_150px_130px_130px] gap-3 bg-ground px-4 py-2.5 text-caption font-semibold text-muted lg:grid">
              <span>When</span>
              <span>What</span>
              <span>Status</span>
              <span className="text-right">Amount</span>
              <span className="text-right">Balance after</span>
            </div>
            {activity === null ? (
              <div className="p-4">
                <SkeletonCard />
              </div>
            ) : (
              activity.map((row) => {
                const l = activityLine(row, tz, money);
                return (
                  <div key={row.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 border-t border-line-subtle px-4 py-3 text-body lg:grid-cols-[130px_minmax(0,2fr)_150px_130px_130px]">
                    <span className="text-caption text-muted lg:text-body">{stamp(row.at, tz)}</span>
                    <span className="order-first col-span-2 flex min-w-0 flex-col lg:order-none lg:col-span-1">
                      <span className="font-semibold">{l.what}</span>
                      <span className="text-caption text-muted">{l.sub}</span>
                    </span>
                    <span className={`justify-self-start rounded-pill px-2.5 py-[3px] text-[12px] font-semibold ${l.chip.className}`}>{l.chip.label}</span>
                    <span className={`text-right tabular-nums font-semibold ${l.positive ? 'text-status-success-fg' : ''}`}>{l.amount}</span>
                    <span className="hidden text-right tabular-nums text-muted lg:block">{money(row.balanceAfter)}</span>
                  </div>
                );
              })
            )}
            {activity === null || activity.length > 0 ? null : (
              <p className="m-0 border-t border-line-subtle p-10 text-center text-body text-muted">
                {filter === 'all' ? 'Nothing yet. Sales, refunds and payouts appear here as they happen.' : 'Nothing of this kind yet.'}
              </p>
            )}
            {activityNext === null ? null : (
              <div className="flex justify-center border-t border-line-subtle p-3">
                <Button variant="secondary" onClick={() => void loadActivity(activityNext)}>
                  Show more
                </Button>
              </div>
            )}
          </div>
        )}

        {tab !== 'withdrawals' ? null : (
          <div>
            {payouts === null ? (
              <div className="p-4">
                <SkeletonCard />
              </div>
            ) : payouts.length === 0 ? (
              <p className="m-0 p-10 text-center text-body text-muted">No withdrawals yet.</p>
            ) : (
              payouts.map((p) => {
                const l = payoutLine(p, tz);
                return (
                  <div key={p.id} className="grid grid-cols-1 items-center gap-x-3 gap-y-1 border-t border-line-subtle px-4 py-3 text-body first:border-t-0 lg:grid-cols-[130px_minmax(0,2fr)_130px_minmax(0,2fr)]">
                    <span className="text-caption text-muted lg:text-body">{stamp(p.requestedAt, tz)}</span>
                    <span className="flex flex-col">
                      <span className="font-semibold">{l.kind}</span>
                      <span className="text-caption text-muted">
                        To {methodName(payout?.methodKey ?? 'mtn_momo')} {p.phoneMasked}
                      </span>
                    </span>
                    <span className="font-semibold tabular-nums lg:text-right">{money(p.amount)}</span>
                    <span className="flex flex-col items-start gap-1">
                      <span className={`rounded-pill px-2.5 py-[3px] text-[12px] font-semibold ${l.chip.className}`}>{l.chip.label}</span>
                      <span className="text-caption text-muted">{l.note}</span>
                      {!l.canRetry || locked || !canWithdraw ? null : (
                        <Button variant="text" tone="brand" onClick={() => failedRetry(p)}>
                          Retry
                        </Button>
                      )}
                    </span>
                  </div>
                );
              })
            )}
            {payoutsNext === null ? null : (
              <div className="flex justify-center border-t border-line-subtle p-3">
                <Button variant="secondary" onClick={() => void loadPayouts(payoutsNext)}>
                  Show more
                </Button>
              </div>
            )}
          </div>
        )}

        {tab !== 'refunds' ? null : (
          <div>
            {refunds === null ? (
              <div className="p-4">
                <SkeletonCard />
              </div>
            ) : refunds.length === 0 ? (
              <p className="m-0 p-10 text-center text-body text-muted">No refunds. When you ask Vendlyfy to refund an order, it shows up here.</p>
            ) : (
              refunds.map((r) => {
                const l = refundLine(r, tz, money);
                return (
                  <div key={r.id} className="grid grid-cols-1 items-center gap-x-3 gap-y-1 border-t border-line-subtle px-4 py-3 text-body first:border-t-0 lg:grid-cols-[90px_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,2fr)]">
                    <a
                      href={hrefFor(store.slug, '/orders')}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(hrefFor(store.slug, '/orders'));
                      }}
                      className="font-semibold"
                    >
                      #{r.orderNumber}
                    </a>
                    <span className="flex flex-col">
                      <span className="font-semibold">{l.reason}</span>
                      <span className="text-caption text-muted">Requested {stamp(r.requestedAt, tz)}</span>
                    </span>
                    <span className="font-semibold tabular-nums">{l.amount}</span>
                    <span className="flex flex-col items-start gap-1">
                      <span className={`rounded-pill px-2.5 py-[3px] text-[12px] font-semibold ${l.chip.className}`}>{l.chip.label}</span>
                      <span className="text-caption text-muted">{l.note}</span>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </section>

      {sheet === null || payout === null ? null : (
        <WithdrawSheet
          key={sheet.amount}
          open
          available={data.available}
          initialAmount={sheet.amount}
          methodName={methodName(payout.methodKey)}
          phoneMasked={payout.phoneMasked}
          onClose={() => setSheet(null)}
          onSubmit={async (amount, key) => {
            const r = await walletApi.withdraw(store.id, amount, key);
            setSheet(null);
            setTab('withdrawals');
            flash(r.status === 'failed' ? (r.failureReason ?? 'MoMo didn’t accept the transfer.') : `Withdrawal of ${money(amount)} requested`);
            void loadCards();
            void loadActivity(null);
            void loadPayouts(null);
            if (r.status === 'processing' || r.status === 'pending') watch(r.withdrawalId);
          }}
          money={money}
        />
      )}

      {toast === null ? null : (
        <div className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 lg:bottom-6">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

function WithdrawSheet({
  open,
  available,
  initialAmount,
  methodName: method,
  phoneMasked,
  onClose,
  onSubmit,
  money,
}: {
  open: boolean;
  available: string;
  initialAmount: string;
  methodName: string;
  phoneMasked: string;
  onClose: () => void;
  onSubmit: (amount: string, key: string) => Promise<void>;
  money: (v: string) => string;
}): ReactNode {
  const ref = useDialog(open);
  const [amount, setAmount] = useState(initialAmount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ONE KEY FOR THIS ATTEMPT. Made when the sheet mounts, so a double-tap sends the same one twice.
  const [key] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`));

  const n = Number(amount);
  const over = amount !== '' && n > Number(available);
  const bad = amount === '' || amount === '.' || !(n > 0) || over;

  const submit = (): void => {
    if (bad || busy) return;
    setBusy(true);
    setError(null);
    onSubmit(amount, key)
      .catch((cause: unknown) => setError(cause instanceof ApiFailure ? cause.message : 'That could not be requested. Nothing was taken from your balance.'))
      .finally(() => setBusy(false));
  };

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label="Withdraw"
      className="m-auto w-[min(440px,calc(100vw-32px))] rounded-card bg-surface p-5 text-ink backdrop:bg-ink/40"
    >
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <strong className="text-title">Withdraw to MoMo</strong>

        {error === null ? null : <Alert tone="danger" headline={error} />}

        <label className="flex flex-col gap-1.5 text-body font-semibold">
          Amount
          <span className={`flex h-11 overflow-hidden rounded-control border bg-surface ${over ? 'border-2 border-status-danger-fg' : 'border-control-line'}`}>
            <input
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(cleanAmount(e.target.value))}
              aria-invalid={over ? true : undefined}
              className="min-w-0 grow border-0 bg-transparent px-3 font-normal outline-none"
            />
            <button type="button" onClick={() => setAmount(trimZeros(available))} className="border-0 bg-status-neutral px-3 text-caption font-semibold text-ink">
              Max
            </button>
          </span>
          <span className={`text-caption font-normal ${over ? 'text-status-danger-fg' : 'text-muted'}`}>
            {over ? `That’s more than your available ${money(available)}.` : `Available: ${money(available)}`}
          </span>
        </label>

        <div className="flex items-center justify-between gap-3 rounded-control bg-ground p-3">
          <span className="text-body">
            <strong>
              {method} {phoneMasked}
            </strong>
            <br />
            <span className="text-caption text-muted">Where your payouts go</span>
          </span>
          <Button variant="secondary" type="button" disabled title="Changing the number comes with Settings">
            Change
          </Button>
        </div>

        <span className="text-caption text-muted">Usually arrives in minutes. If it fails, the money comes straight back to Available.</span>

        <div className="flex justify-end gap-2">
          <Button variant="text" tone="brand" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone="brand" type="submit" disabled={bad} busy={busy} busyLabel="Requesting…">
            Withdraw
          </Button>
        </div>
      </form>
    </dialog>
  );
}
