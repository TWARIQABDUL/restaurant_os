// client/src/console/Reviews.tsx — milestone 24, from project/ReviewsMerchant.dc.html.
//
// "Reviews go live straight away. You can reply publicly, or report one to Vendlyfy if it breaks the rules. You can't
// edit or remove them." — the board's sentence, and the screen has exactly two verbs because the database has exactly
// two (V009): a reply, and a report. There is no delete, no hide, no edit, and no control for them.
//
// A REPORTED REVIEW STAYS VISIBLE, AND SAYS SO: "It stays visible until they decide." The merchant is waiting on
// Vendlyfy, which is why the report button goes away and the card says what happened — a second press would only
// confirm the first, and a button that does nothing visible is one the merchant presses again.
//
// WHAT THE FIGURES ARE. "Average rating" is the last 90 days, "Needs a reply" is every live review without one (the
// number on the sidebar's badge, from the same rule), and "1–2 star this month" compares calendar months in the STORE's
// zone, because a month ends at the merchant's midnight. The by-product list shows an average only from three reviews,
// the board's own footnote: below that it shows the count, because one 5-star review is a fact and an average of it is
// a claim.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, SkeletonCard, Toast } from '../shared/ui/index.ts';
import { reviewsApi } from './api.ts';
import type { ReportReason, ReviewFilter, ReviewItem, ReviewsPage } from './api.ts';
import { relativeWhen } from './lines.ts';
import { useShell } from './ShellProvider.tsx';
import { REPORT_REASONS, lowTrend, productRating, reportReasonLabel, stars } from './supportLines.ts';

const FILTERS: readonly { value: ReviewFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'reply', label: 'Needs a reply' },
  { value: 'low', label: '1–2 stars' },
];

type Props = {
  navigate?: (to: string) => void;
  /** The render gate's seam: effects do not run in static markup. Console.tsx passes none. */
  initialPage?: ReviewsPage;
  initialEditing?: { id: string; mode: 'reply' | 'report' };
};

export function Reviews({ initialPage, initialEditing }: Props = {}): ReactNode {
  const { store, may } = useShell();

  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [page, setPage] = useState<ReviewsPage | null>(initialPage ?? null);
  const [rows, setRows] = useState<ReviewItem[]>(initialPage?.reviews ?? []);
  const [next, setNext] = useState(initialPage?.nextCursor ?? null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; mode: 'reply' | 'report' } | null>(initialEditing ?? null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initialPage !== undefined);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((current) => (current === m ? null : current)), 2800);
  }, []);

  const load = useCallback(
    async (more: { at: string; id: string } | null): Promise<void> => {
      try {
        const result = await reviewsApi.load(store.id, filter, more);
        if (more === null) setPage(result);
        setRows((prev) => (more === null ? result.reviews : [...prev, ...result.reviews]));
        setNext(result.nextCursor);
        setError(null);
      } catch (cause) {
        setError(cause instanceof ApiFailure ? cause.message : 'Reviews could not be loaded.');
      }
    },
    [store.id, filter],
  );

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    void load(null);
  }, [load]);

  if (!may('support.write')) {
    return (
      <Alert tone="info" headline="Your role can’t manage reviews.">
        <span>Ask the owner of {store.name} to change your role.</span>
      </Alert>
    );
  }

  if (page === null) {
    return error === null ? (
      <div className="flex flex-col gap-3" aria-busy="true">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    ) : (
      <Alert tone="danger" headline={error}>
        <Button variant="secondary" onClick={() => void load(null)}>
          Try again
        </Button>
      </Alert>
    );
  }

  const o = page.overview;
  const kpis = [
    { label: 'Average rating', value: o?.averageRating == null ? '—' : `★ ${o.averageRating}`, sub: `Last 90 days · ${o?.last90Days ?? 0} reviews` },
    { label: 'Needs a reply', value: String(o?.needsReply ?? 0), sub: 'Replies show under the review' },
    { label: '1–2 star this month', value: String(o?.lowThisMonth ?? 0), sub: lowTrend(o?.lowThisMonth ?? 0, o?.lowLastMonth ?? 0) },
    { label: 'Reported, under review', value: String(o?.reportedOpen ?? 0), sub: 'Vendlyfy decides' },
  ];

  const act = async (run: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true);
    try {
      await run();
      flash(done);
      setEditing(null);
      setDraft('');
      await load(null);
    } catch (cause) {
      flash(cause instanceof ApiFailure ? cause.message : 'That could not be done.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="m-0 font-display text-[26px] lg:text-[28px]">Reviews</h1>
        <span className="text-caption text-muted">
          Reviews go live straight away. You can reply publicly, or report one to Vendlyfy if it breaks the rules. You can’t edit or remove them.
        </span>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-card border border-line bg-surface px-4 py-3.5">
            <div className="text-caption font-semibold text-muted">{k.label}</div>
            <div className="font-display text-[26px] font-bold">{k.value}</div>
            <div className="text-[12px] text-muted">{k.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]">
        <section className="flex flex-col gap-2.5">
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => {
                  setFilter(f.value);
                  setEditing(null);
                }}
                className={`h-9 rounded-pill px-3.5 text-caption font-bold ${filter === f.value ? 'border border-ink bg-ink text-white' : 'border border-control-line bg-surface text-ink'}`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {rows.map((r) => {
            const mine = editing?.id === r.id;
            return (
              <article key={r.id} className="flex flex-col gap-2 rounded-card border border-line bg-surface px-4 py-3.5">
                <div className="flex flex-wrap justify-between gap-2 text-caption">
                  <span>
                    <strong className="text-body">{r.product}</strong> · {r.customer} · <span className="font-mono">#{r.orderNumber}</span>
                  </span>
                  <span className="text-muted">{relativeWhen(r.at, store.timeZone)}</span>
                </div>
                <span className="tracking-wide text-status-warn-fg" aria-label={`${r.rating} out of 5 stars`}>
                  {stars(r.rating)}
                </span>
                {r.body === null ? null : <p className="m-0 text-body">{r.body}</p>}
                {r.reply === null ? null : (
                  <div className="rounded-control bg-ground px-2.5 py-2 text-caption">
                    <strong>Your reply:</strong> {r.reply}
                  </div>
                )}
                {r.reported === null ? null : (
                  <div className="rounded-control bg-status-progress px-2.5 py-2 text-caption text-status-progress-fg">
                    Reported: {reportReasonLabel(r.reported.reason)}. Vendlyfy will review it. It stays visible until they decide.
                  </div>
                )}

                {mine && editing.mode === 'reply' ? (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (draft.trim() === '' || busy) return;
                      void act(() => reviewsApi.reply(store.id, r.id, draft), 'Reply posted');
                    }}
                  >
                    <textarea
                      rows={2}
                      aria-label="Public reply"
                      value={draft}
                      maxLength={1000}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="Public reply, shown under the review"
                      className="resize-none rounded-control border border-control-line p-2.5 text-body"
                    />
                    <div className="flex gap-2">
                      <Button tone="brand" type="submit" disabled={draft.trim() === ''} busy={busy} busyLabel="Posting…">
                        Post reply
                      </Button>
                      <Button variant="text" tone="brand" type="button" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : null}

                {mine && editing.mode === 'report' ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-caption font-semibold">Why?</span>
                    {REPORT_REASONS.map((x) => (
                      <button
                        key={x.code}
                        type="button"
                        disabled={busy}
                        onClick={() => void act(() => reviewsApi.report(store.id, r.id, x.code as ReportReason), 'Reported to Vendlyfy')}
                        className="h-[34px] rounded-pill border border-control-line bg-surface px-3 text-caption font-semibold"
                      >
                        {x.label}
                      </button>
                    ))}
                    <button type="button" onClick={() => setEditing(null)} className="h-[34px] border-0 bg-transparent text-caption font-semibold">
                      Cancel
                    </button>
                  </div>
                ) : null}

                {mine ? null : (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEditing({ id: r.id, mode: 'reply' });
                        setDraft(r.reply ?? '');
                      }}
                    >
                      {r.reply === null ? 'Reply' : 'Edit reply'}
                    </Button>
                    {r.reported !== null ? null : (
                      <Button variant="text" onClick={() => setEditing({ id: r.id, mode: 'report' })}>
                        Report
                      </Button>
                    )}
                  </div>
                )}
              </article>
            );
          })}

          {rows.length > 0 ? null : (
            <p className="m-0 rounded-card border border-line bg-surface p-10 text-center text-body text-muted">
              {filter === 'all' ? 'No reviews yet. Customers can review what they’ve had delivered.' : filter === 'reply' ? 'Nothing waiting for a reply.' : 'No 1–2 star reviews.'}
            </p>
          )}

          {next === null ? null : (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => void load(next)}>
                Show more
              </Button>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4">
          <h2 className="m-0 mb-1.5 text-title">By product</h2>
          {(page.byProduct ?? []).map((p) => {
            const r = productRating(p);
            return (
              <div key={p.id} className="flex justify-between border-t border-line-subtle py-2 text-body">
                <span>{p.name}</span>
                <span className={r.rated ? 'font-bold' : 'text-muted'}>{r.text}</span>
              </div>
            );
          })}
          <span className="mt-1.5 text-[12px] text-muted">
            Stores show an average only after {page.minForAverage} reviews. Until then customers see the count.
          </span>
        </section>
      </div>

      {toast === null ? null : (
        <div className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 lg:bottom-6">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
