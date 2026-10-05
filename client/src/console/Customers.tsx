// client/src/console/Customers.tsx — milestone 24, from project/Customers.dc.html.
//
// "Everyone who ordered, with or without an account. Guests are matched by phone number."
//
// A CUSTOMER IS A PERSON, NOT A ROW, and the server does the matching (V026's customer_key): one row for somebody who
// ordered as a guest and later made an account, one for three spellings of one number. This screen only reads that.
//
// THE PILL COUNTS ARE THE WHOLE STORE'S. "All · 1,240" does not shrink while a search is typed — the same decision
// Products' tabs made, for the same reason: a count that moved with the search would stop answering "how many regulars
// do I have?".
//
// THE PRIVATE NOTE SAVES WHEN YOU LEAVE THE FIELD, and says "Saved". A staff-only note ("Allergic to peanuts") that a
// merchant types and then taps away from must not be lost; one that needed a Save button is one they forget to press.
// It is NEVER shown to the customer — there is no route that returns it to a storefront.
//
// "CALL" IS A tel: LINK to the number the orders carried, and "Export CSV" is a plain link: the browser sends the session
// cookie and saves the file, so nothing here handles the data twice.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, SkeletonRow } from '../shared/ui/index.ts';
import { customersApi } from './api.ts';
import type { CustomerDetail, CustomerList, CustomerSegment } from './api.ts';
import { hrefFor } from './nav.ts';
import { relativeWhen } from './lines.ts';
import { useShell } from './ShellProvider.tsx';
import { SEGMENTS, TYPE_BADGE, initials, typeSentence } from './supportLines.ts';
import { stamp } from './walletLines.ts';

type Props = {
  navigate: (to: string) => void;
  /** The render gate's seam: effects do not run in static markup. Console.tsx passes none. */
  initialList?: CustomerList;
  initialDetail?: CustomerDetail;
};

export function Customers({ navigate, initialList, initialDetail }: Props): ReactNode {
  const { store, money, may } = useShell();

  const [segment, setSegment] = useState<CustomerSegment>('all');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<CustomerList | null>(initialList ?? null);
  const [selected, setSelected] = useState<string | null>(initialDetail?.key ?? null);
  const [detail, setDetail] = useState<CustomerDetail | null>(initialDetail ?? null);
  const [note, setNote] = useState(initialDetail?.note ?? '');
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(initialDetail !== undefined);
  const seeded = useRef(initialList !== undefined);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQ(typed.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await customersApi.list(store.id, segment, q, page);
      setList(r);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : 'Customers could not be loaded.');
    }
  }, [store.id, segment, q, page]);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    void load();
  }, [load]);

  const open = useCallback(
    async (key: string): Promise<void> => {
      setSelected(key);
      setDetail(null);
      setShowDetail(true);
      try {
        const { customer } = await customersApi.get(store.id, key);
        setDetail(customer);
        setNote(customer.note ?? '');
        setNoteState('idle');
      } catch (cause) {
        setError(cause instanceof ApiFailure ? cause.message : 'That customer could not be loaded.');
      }
    },
    [store.id],
  );

  if (!may('customers.read')) {
    return (
      <Alert tone="info" headline="Your role can’t see customers.">
        <span>Ask the owner of {store.name} to change your role.</span>
      </Alert>
    );
  }

  if (list === null) {
    return error === null ? (
      <div className="flex flex-col gap-3" aria-busy="true">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    ) : (
      <Alert tone="danger" headline={error}>
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </Alert>
    );
  }

  const saveNote = (): void => {
    if (detail === null || (detail.note ?? '') === note.trim()) return;
    setNoteState('saving');
    customersApi
      .setNote(store.id, detail.key, note)
      .then((r) => {
        setDetail((d) => (d === null ? d : { ...d, note: r.note }));
        setNoteState('saved');
      })
      .catch(() => setNoteState('failed'));
  };

  const from = list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1;
  const to = Math.min(list.total, from + list.rows.length - 1);
  const lastPage = Math.max(1, Math.ceil(list.total / list.pageSize));

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-center gap-3.5">
        <div className="min-w-60 grow">
          <h1 className="m-0 font-display text-[26px] lg:text-[28px]">Customers</h1>
          <span className="text-caption text-muted">Everyone who ordered, with or without an account. Guests are matched by phone number.</span>
        </div>
        <label className="flex h-11 w-full items-center gap-2 rounded-control border border-control-line bg-surface px-3 lg:w-[300px]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="text-muted">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input aria-label="Search customers" placeholder="Name or phone" value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 grow border-0 bg-transparent text-body outline-none" />
        </label>
        <a
          href={customersApi.exportUrl(store.id)}
          download
          className="flex h-11 items-center rounded-control border border-control-line bg-surface px-3.5 text-body font-semibold text-ink no-underline"
        >
          Export CSV
        </a>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {SEGMENTS.map((s) => (
          <button
            key={s.value}
            type="button"
            aria-pressed={segment === s.value}
            onClick={() => {
              setSegment(s.value);
              setPage(1);
            }}
            className={`h-9 rounded-pill px-3.5 text-caption font-bold ${segment === s.value ? 'border border-ink bg-ink text-white' : 'border border-control-line bg-surface text-ink'}`}
          >
            {s.label} · {list.counts[s.value].toLocaleString('en-US')}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className={`overflow-hidden rounded-card border border-line bg-surface ${showDetail ? 'hidden lg:block' : ''}`}>
          <div className="hidden grid-cols-[minmax(0,1.5fr)_130px_80px_130px_120px_100px] gap-3 bg-ground px-4 py-2.5 text-[12px] font-semibold text-muted lg:grid">
            <span>Customer</span>
            <span>Phone</span>
            <span>Orders</span>
            <span>Spent</span>
            <span>Last order</span>
            <span>Type</span>
          </div>
          {list.rows.map((c) => {
            const badge = c.account ? TYPE_BADGE.account : TYPE_BADGE.guest;
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={c.key === selected}
                onClick={() => void open(c.key)}
                className={`grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 border-0 border-t border-line-subtle px-4 py-3 text-left text-body lg:grid-cols-[minmax(0,1.5fr)_130px_80px_130px_120px_100px] ${c.key === selected ? 'bg-brand-tint' : 'bg-surface'}`}
              >
                <span className="font-semibold">{c.name}</span>
                <span className={`justify-self-end rounded-pill px-2.5 py-[2px] text-[12px] font-bold lg:order-last lg:justify-self-start ${badge.className}`}>{badge.label}</span>
                <span className="text-ink-2 lg:order-none">{c.phone ?? '—'}</span>
                <span className="hidden lg:block">{c.orders}</span>
                <span className="hidden font-semibold tabular-nums lg:block">{money(c.spent)}</span>
                <span className="hidden text-muted lg:block">{relativeWhen(c.lastOrderAt, store.timeZone)}</span>
                <span className="col-span-2 text-caption text-muted lg:hidden">
                  {c.orders} {c.orders === 1 ? 'order' : 'orders'} · {money(c.spent)} · {relativeWhen(c.lastOrderAt, store.timeZone)}
                </span>
              </button>
            );
          })}
          {list.rows.length > 0 ? null : <p className="m-0 p-10 text-center text-body text-muted">{q === '' ? 'Nobody has ordered yet.' : 'No customer matches that.'}</p>}
          <div className="flex items-center justify-between border-t border-line-subtle px-4 py-3 text-body text-muted">
            <span>{list.total === 0 ? 'Nothing to show' : `Showing ${from}–${to} of ${list.total.toLocaleString('en-US')}`}</span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={list.page <= 1} onClick={() => setPage(list.page - 1)}>
                Previous
              </Button>
              <Button variant="secondary" disabled={list.page >= lastPage} onClick={() => setPage(list.page + 1)}>
                Next
              </Button>
            </div>
          </div>
        </section>

        <aside className={`flex flex-col gap-3 rounded-card border border-line bg-surface p-4 ${showDetail ? '' : 'hidden lg:flex'}`}>
          {detail === null ? (
            selected === null ? (
              <p className="m-0 p-6 text-center text-body text-muted">Choose a customer to see their orders.</p>
            ) : (
              <SkeletonRow />
            )
          ) : (
            <>
              <button type="button" onClick={() => setShowDetail(false)} className="self-start border-0 bg-transparent p-0 text-caption font-semibold text-brand-strong lg:hidden">
                ← All customers
              </button>
              <div className="flex items-center gap-3">
                <span className="flex size-12 items-center justify-center rounded-pill bg-brand-tint font-bold text-brand-strong">{initials(detail.name)}</span>
                <span>
                  <strong className="text-[18px]">{detail.name}</strong>
                  <br />
                  <span className="text-caption text-muted">
                    {detail.phone ?? 'No number'} · {typeSentence(detail.account)}
                  </span>
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Orders" value={String(detail.orders)} />
                <Stat label="Spent" value={money(detail.spent)} />
                <Stat label="Complaints" value={String(detail.complaints)} />
              </div>
              <div className="text-body">
                <strong className="text-caption text-muted">Usual address</strong>
                <br />
                {detail.usualAddress ?? 'Pickup'}
              </div>
              <div className="flex flex-col gap-1">
                <strong className="text-caption text-muted">Recent orders</strong>
                {detail.recent.map((h) => (
                  <a
                    key={h.id}
                    href={hrefFor(store.slug, '/orders')}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(hrefFor(store.slug, '/orders'));
                    }}
                    className="flex justify-between border-t border-line-subtle py-2 text-body text-ink no-underline"
                  >
                    <span>
                      <span className="font-mono text-caption">#{h.number}</span> · {stamp(h.at, store.timeZone)}
                    </span>
                    <span className="tabular-nums">{money(h.total)}</span>
                  </a>
                ))}
              </div>
              {!may('customers.write') ? null : (
                <label className="flex flex-col gap-1 text-caption font-semibold text-muted">
                  Private note (staff only)
                  <textarea
                    rows={2}
                    value={note}
                    maxLength={500}
                    onChange={(e) => {
                      setNote(e.target.value);
                      setNoteState('idle');
                    }}
                    onBlur={saveNote}
                    placeholder="e.g. Allergic to peanuts"
                    className="resize-none rounded-control border border-control-line p-2.5 text-body font-normal text-ink"
                  />
                  <span aria-live="polite" className="font-normal">
                    {noteState === 'saving' ? 'Saving…' : noteState === 'saved' ? 'Saved' : noteState === 'failed' ? 'Could not save that note.' : ''}
                  </span>
                </label>
              )}
              {detail.phone === null ? null : (
                <a href={`tel:${detail.phone.replace(/[^\d+]/g, '')}`} className="flex h-11 items-center justify-center rounded-control border border-control-line font-semibold text-ink no-underline">
                  Call {detail.name.split(/\s+/)[0]}
                </a>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="rounded-control bg-ground p-2.5">
      <div className="text-[12px] text-muted">{label}</div>
      <strong className="text-body">{value}</strong>
    </div>
  );
}
