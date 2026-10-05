// client/src/console/Complaints.tsx — milestone 24, from project/Complaints.dc.html.
//
// "Customers file these from their order. Reply here; escalate to Vendlyfy if you can't agree."
//
// A LIST, A THREAD, AND THE ORDER BESIDE IT. On a desktop the list is a column and the thread fills the rest; on a phone
// they are two screens, because a 360px list and a thread cannot share 390px — Main's rule: "layouts re-compose at each
// size; nothing is simply shrunk". One component tree, `lg:` doing the re-composition, and `showThread` deciding which
// half a phone is looking at.
//
// THREE RESPONSES, EACH NEEDING WORDS. The button stays disabled until the merchant has written what the customer will
// read, for the board's reason ("Tell the customer what you did") and V008's own: every one of its functions raises
// without a note. A refund is a REQUEST — "Sent to Vendlyfy as a refund request" — and nothing leaves the wallet here;
// the checkbox is only on Resolve, because that is the only response the board offers it on.
//
// A COMPLAINT THAT HAS MOVED UNDER THE SCREEN IS SHOWN AS IT NOW IS. If a colleague resolved it first, the server answers
// 409 naming where it is; the screen says so and reloads the thread, rather than leaving a form open on a complaint that
// no longer wants one.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, SkeletonCard, Toast } from '../shared/ui/index.ts';
import { complaintsApi } from './api.ts';
import type { ComplaintDetail, ComplaintListItem, ComplaintTab } from './api.ts';
import { cleanAmount } from './catalogue.ts';
import { hrefFor } from './nav.ts';
import { useShell } from './ShellProvider.tsx';
import { COMPLAINT_BADGE, RESPONSES, ageShort, canReopen, closedNote, deliveryLine, reasonLabel, timelineLine } from './supportLines.ts';
import type { ResponseKind } from './supportLines.ts';
import { clock } from './walletLines.ts';

const TABS: readonly { value: ComplaintTab; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'closed', label: 'Closed' },
];

type Props = {
  navigate: (to: string) => void;
  /** The render gate's seam: effects do not run in static markup. Console.tsx passes none. */
  initialCounts?: Record<ComplaintTab, number>;
  initialList?: ComplaintListItem[];
  initialDetail?: ComplaintDetail;
  initialKind?: ResponseKind;
  initialNote?: string;
};

export function Complaints({ navigate, initialCounts, initialList, initialDetail, initialKind, initialNote }: Props): ReactNode {
  const { store, me, money, may } = useShell();

  const [tab, setTab] = useState<ComplaintTab>(initialDetail === undefined || initialDetail.status === 'open' ? 'open' : initialDetail.status === 'escalated' ? 'escalated' : 'closed');
  const [counts, setCounts] = useState<Record<ComplaintTab, number> | null>(initialCounts ?? null);
  const [list, setList] = useState<ComplaintListItem[] | null>(initialList ?? null);
  const [selected, setSelected] = useState<string | null>(initialDetail?.id ?? null);
  const [detail, setDetail] = useState<ComplaintDetail | null>(initialDetail ?? null);
  const [showThread, setShowThread] = useState(initialDetail !== undefined);
  const [kind, setKind] = useState<ResponseKind>(initialKind ?? 'resolve');
  const [note, setNote] = useState(initialNote ?? '');
  const [withRefund, setWithRefund] = useState(false);
  const [refund, setRefund] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initialList !== undefined);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((current) => (current === m ? null : current)), 2800);
  }, []);

  const loadList = useCallback(
    async (which: ComplaintTab): Promise<ComplaintListItem[] | null> => {
      try {
        const r = await complaintsApi.list(store.id, which);
        setCounts(r.counts);
        setList(r.complaints);
        setError(null);
        return r.complaints;
      } catch (cause) {
        setError(cause instanceof ApiFailure ? cause.message : 'Complaints could not be loaded.');
        return null;
      }
    },
    [store.id],
  );

  const loadDetail = useCallback(
    async (id: string): Promise<void> => {
      try {
        setDetail((await complaintsApi.get(store.id, id)).complaint);
      } catch (cause) {
        flash(cause instanceof ApiFailure ? cause.message : 'That complaint could not be loaded.');
      }
    },
    [store.id, flash],
  );

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    void loadList(tab).then((items) => {
      // The first one is selected on a desktop, as the board opens with one — but a phone shows the LIST first.
      if (items !== null && items[0] !== undefined && selected === null && window.matchMedia('(min-width: 1024px)').matches) {
        setSelected(items[0].id);
        void loadDetail(items[0].id);
      }
    });
    // Only when the tab changes; selection is the merchant's own after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, loadList]);

  if (!may('support.write')) {
    return (
      <Alert tone="info" headline="Your role can’t manage complaints.">
        <span>Ask the owner of {store.name} to change your role.</span>
      </Alert>
    );
  }

  if (list === null || counts === null) {
    return error === null ? (
      <div className="flex flex-col gap-3" aria-busy="true">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    ) : (
      <Alert tone="danger" headline={error}>
        <Button variant="secondary" onClick={() => void loadList(tab)}>
          Try again
        </Button>
      </Alert>
    );
  }

  const pick = (id: string): void => {
    setSelected(id);
    setDetail(null);
    setNote('');
    setKind('resolve');
    setWithRefund(false);
    setRefund('');
    setShowThread(true);
    void loadDetail(id);
  };

  const submit = async (): Promise<void> => {
    if (detail === null || note.trim() === '' || busy) return;
    if (kind === 'resolve' && withRefund && (refund === '' || Number(refund) <= 0)) {
      flash('Enter the amount to refund, or untick the box.');
      return;
    }
    setBusy(true);
    try {
      const text = note.trim();
      const r =
        kind === 'resolve'
          ? await complaintsApi.resolve(store.id, detail.id, text, withRefund ? refund : undefined)
          : kind === 'reject'
            ? await complaintsApi.reject(store.id, detail.id, text)
            : await complaintsApi.escalate(store.id, detail.id, text);
      setDetail(r.complaint);
      setNote('');
      setWithRefund(false);
      setRefund('');
      flash(RESPONSES[kind].done);
      const to: ComplaintTab = kind === 'escalate' ? 'escalated' : 'closed';
      setTab(to);
      await loadList(to);
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.code === 'COMPLAINT_CHANGED') {
        flash(cause.message);
        await loadDetail(detail.id);
        await loadList(tab);
      } else {
        flash(cause instanceof ApiFailure ? cause.message : 'That could not be sent. Nothing was changed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const reopen = async (): Promise<void> => {
    if (detail === null || busy) return;
    setBusy(true);
    try {
      setDetail((await complaintsApi.reopen(store.id, detail.id)).complaint);
      flash('Reopened');
      setTab('open');
      await loadList('open');
    } catch (cause) {
      flash(cause instanceof ApiFailure ? cause.message : 'That could not be reopened.');
    } finally {
      setBusy(false);
    }
  };

  const response = RESPONSES[kind];
  const noNote = note.trim() === '';
  const remaining = detail === null ? 0 : Number(detail.order.total) - Number(detail.order.refunded);

  return (
    <div className="relative grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <nav aria-label="Complaints" className={`flex flex-col gap-2.5 ${showThread ? 'hidden lg:flex' : ''}`}>
        <h1 className="m-0 px-1.5 font-display text-[26px] lg:text-[28px]">Complaints</h1>
        <p className="m-0 mb-1 px-1.5 text-caption text-muted">Customers file these from their order. Reply here; escalate to Vendlyfy if you can’t agree.</p>
        <div role="tablist" className="flex rounded-control bg-status-neutral p-[3px]">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={tab === t.value}
              onClick={() => {
                setTab(t.value);
                setSelected(null);
                setDetail(null);
                setList(null);
              }}
              className={`h-9 flex-1 rounded-chip border-0 text-caption font-semibold ${tab === t.value ? 'bg-surface text-ink shadow-menu' : 'bg-transparent text-ink-2'}`}
            >
              {t.label} ({counts[t.value]})
            </button>
          ))}
        </div>

        {list.map((c) => {
          const badge = COMPLAINT_BADGE[c.status];
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={c.id === selected}
              onClick={() => pick(c.id)}
              className={`flex flex-col gap-1 rounded-card border-0 p-3 text-left ${c.id === selected ? 'bg-surface shadow-menu' : 'bg-transparent'}`}
            >
              <span className="flex justify-between">
                <span className="text-body font-bold">{reasonLabel(c.reason)}</span>
                <span className="text-[12px] text-muted">{ageShort(c.at)}</span>
              </span>
              <span className="text-caption text-ink-2">
                {c.customer} · <span className="font-mono">#{c.orderNumber}</span>
              </span>
              <span className={`self-start rounded-pill px-2 py-[2px] text-[11px] font-bold ${badge.className}`}>{badge.label}</span>
            </button>
          );
        })}
        {list.length > 0 ? null : <div className="px-2 py-6 text-center text-body text-muted">No complaints here.</div>}
      </nav>

      <main className={`${showThread ? '' : 'hidden lg:block'}`}>
        {detail === null ? (
          selected === null ? (
            <div className="hidden p-10 text-center text-body text-muted lg:block">Choose a complaint to read it.</div>
          ) : (
            <SkeletonCard />
          )
        ) : (
          <div className="flex flex-col gap-3.5">
            <button type="button" onClick={() => setShowThread(false)} className="self-start border-0 bg-transparent p-0 text-caption font-semibold text-brand-strong lg:hidden">
              ← All complaints
            </button>

            <header className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2 className="m-0 font-display text-[24px] lg:text-[26px]">{reasonLabel(detail.reason)}</h2>
                  <span className={`rounded-pill px-2.5 py-[3px] text-[12px] font-bold ${COMPLAINT_BADGE[detail.status].className}`}>{COMPLAINT_BADGE[detail.status].label}</span>
                </div>
                <span className="text-caption text-muted">
                  <span className="font-mono">{detail.reference}</span> · {detail.customer.name}
                  {detail.customer.phone === null ? '' : ` · ${detail.customer.phone}`} · filed {ageShort(detail.at)} ago
                </span>
              </div>
              <a
                href={hrefFor(store.slug, '/orders')}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(hrefFor(store.slug, '/orders'));
                }}
                className="flex h-10 items-center rounded-control border border-control-line bg-surface px-3.5 text-body font-semibold text-ink no-underline"
              >
                Order #{detail.order.number}
              </a>
            </header>

            <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div className="flex flex-col gap-3.5">
                <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
                  <strong className="text-caption text-muted">What the customer said</strong>
                  <p className="m-0 text-[16px]">“{detail.text}”</p>
                  {detail.evidence.length === 0 ? null : (
                    <div className="flex flex-wrap gap-2">
                      {detail.evidence.map((e) =>
                        e.url === null ? (
                          <span key={e.id} className="flex h-[90px] w-[120px] items-center justify-center rounded-control bg-status-neutral px-2 text-center text-[12px] text-ink-2">
                            {e.label}
                          </span>
                        ) : (
                          <img key={e.id} src={e.url} alt={e.label} className="h-[90px] w-[120px] rounded-control object-cover" />
                        ),
                      )}
                    </div>
                  )}
                </section>

                {detail.status !== 'open' ? null : (
                  <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
                    <div role="radiogroup" aria-label="Response" className="flex rounded-control bg-status-neutral p-[3px]">
                      {(Object.keys(RESPONSES) as ResponseKind[]).map((k) => (
                        <button
                          key={k}
                          type="button"
                          role="radio"
                          aria-checked={kind === k}
                          onClick={() => setKind(k)}
                          className={`h-[38px] flex-1 rounded-chip border-0 text-caption font-semibold ${kind === k ? 'bg-surface text-ink shadow-menu' : 'bg-transparent text-ink-2'}`}
                        >
                          {RESPONSES[k].label}
                        </button>
                      ))}
                    </div>
                    <span className="text-caption text-ink-2">{response.help}</span>
                    <textarea
                      rows={3}
                      value={note}
                      maxLength={1000}
                      onChange={(e) => setNote(e.target.value)}
                      aria-label={response.placeholder}
                      placeholder={response.placeholder}
                      className="resize-none rounded-control border border-control-line p-2.5 text-body"
                    />
                    {kind !== 'resolve' ? null : (
                      <div className="flex flex-col gap-2">
                        <label className="flex min-h-8 items-center gap-2.5 text-body">
                          <input type="checkbox" checked={withRefund} onChange={(e) => setWithRefund(e.target.checked)} className="size-5 accent-brand" />
                          Also refund part of the order
                        </label>
                        {!withRefund ? null : (
                          <label className="flex flex-wrap items-center gap-2.5 text-caption font-semibold">
                            Amount
                            <span className="flex h-10 w-[200px] overflow-hidden rounded-control border border-control-line bg-surface">
                              <input inputMode="decimal" value={refund} onChange={(e) => setRefund(cleanAmount(e.target.value))} className="min-w-0 grow border-0 bg-transparent px-2.5 font-normal outline-none" />
                              <span className="flex items-center bg-status-neutral px-2.5 font-normal">{store.currency.code}</span>
                            </span>
                            <span className="font-medium text-muted">Sent to Vendlyfy as a refund request{remaining > 0 ? ` · up to ${money(remaining.toFixed(2))}` : ''}</span>
                          </label>
                        )}
                      </div>
                    )}
                    <Button tone={kind === 'reject' ? 'store' : 'brand'} variant={kind === 'reject' ? 'danger' : 'primary'} block disabled={noNote} busy={busy} busyLabel="Sending…" onClick={() => void submit()}>
                      {response.submit}
                    </Button>
                  </section>
                )}

                {detail.status === 'open' ? null : (
                  <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
                    <span className="text-body">{closedNote(detail.status)}</span>
                    {detail.pendingRefund === null ? null : (
                      <span className="text-caption text-muted">Refund request of {money(detail.pendingRefund)} is waiting for Vendlyfy.</span>
                    )}
                    {!canReopen(detail.status) ? null : (
                      <Button variant="secondary" disabled={busy} onClick={() => void reopen()}>
                        Reopen
                      </Button>
                    )}
                  </section>
                )}
              </div>

              <div className="flex flex-col gap-3.5">
                <section className="flex flex-col gap-1.5 rounded-card border border-line bg-surface p-4 text-body">
                  <strong className="text-caption text-muted">Order #{detail.order.number}</strong>
                  {detail.order.items.map((i, n) => (
                    <div key={n} className="flex justify-between gap-2">
                      <span>{i.label}</span>
                      <span className="tabular-nums">{money(i.amount)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between border-t border-line-subtle pt-1.5 font-bold">
                    <span>Total</span>
                    <span className="tabular-nums">{money(detail.order.total)}</span>
                  </div>
                  <span className="text-caption text-muted">{deliveryLine(detail.order, (iso) => clock(iso, store.timeZone))}</span>
                </section>

                <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
                  <strong className="text-caption text-muted">Timeline</strong>
                  {detail.timeline.map((t, i) => (
                    <div key={i} className="flex gap-2.5 text-caption">
                      <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-pill ${i === detail.timeline.length - 1 ? 'bg-brand' : 'bg-control-line'}`} />
                      <span className="flex flex-col">
                        <span className="font-semibold">{timelineLine(t, me.name)}</span>
                        <span className="text-muted">{new Date(t.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: store.timeZone })}</span>
                      </span>
                    </div>
                  ))}
                </section>
              </div>
            </div>
          </div>
        )}
      </main>

      {toast === null ? null : (
        <div className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 lg:bottom-6">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
