// client/src/admin/Overview.tsx — milestone 27, from project/AdminOverview.dc.html.
//
// EVERY FIGURE ON THIS PAGE IS A QUERY SOMEBODY CAN RE-RUN (repositories/admin.ts), and three things the board draws are
// deliberately absent because nothing in the system produces them: a "flagged payment" (nothing flags payments), a Cards row
// and an SMS row in Payment providers (no card processor, no SMS until milestone 28). A row that always says "Operational"
// because it is not measured is exactly what an overview exists not to be.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button } from '../shared/ui/index.ts';
import { adminApi } from './adminApi.ts';
import type { Overview as OverviewData, Range } from './adminApi.ts';
import { KPI_LABEL, PROVIDER_STATUS, QUEUE_ACTION, RANGE_LABEL, ageText, clock, compactMoney, degradedNote, kpiDelta, kpiValue, overSla, providerRate } from './adminLines.ts';
import { useAdmin } from './Admin.tsx';

const DELTA: Record<'up' | 'down' | 'flat' | 'warn', string> = { up: 'text-status-success-fg', down: 'text-status-danger-fg', flat: 'text-muted', warn: 'text-status-warn-fg' };

export function Overview({ initial, initialRange }: { initial?: OverviewData; initialRange?: Range }): ReactNode {
  const { navigate } = useAdmin();
  const [range, setRange] = useState<Range>(initialRange ?? 'today');
  const [data, setData] = useState<OverviewData | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef(initial !== undefined);

  const load = useCallback(async (r: Range): Promise<void> => {
    try {
      setData(await adminApi.overview(r));
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : 'The overview could not be loaded.');
    }
  }, []);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    void load(range);
  }, [load, range]);

  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="m-0 font-display text-[30px]">Platform overview</h1>
          <p className="m-0 mt-0.5 text-body text-muted">All stores, all industries · {today}</p>
        </div>
        <div className="flex items-center gap-2.5">
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              const q = new FormData(e.currentTarget).get('q');
              navigate(`/admin/merchants${typeof q === 'string' && q.trim() !== '' ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
            }}
            className="flex h-11 w-[280px] max-w-full items-center gap-2 rounded-control border border-control-line bg-surface px-3"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="text-muted">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4-4" />
            </svg>
            <input name="q" aria-label="Search stores" placeholder="Search stores, owners, phone numbers" className="min-w-0 grow border-0 bg-transparent text-body outline-none" />
          </form>
          <div role="radiogroup" aria-label="Date range" className="flex rounded-control bg-status-neutral p-[3px]">
            {(['today', 'week', 'month'] as const).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={range === r} onClick={() => setRange(r)} className={`h-[38px] rounded-chip px-3.5 text-body font-semibold ${range === r ? 'bg-surface text-ink [box-shadow:0_1px_2px_rgb(23_22_15/.12)]' : 'text-ink-2'}`}>
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error !== null ? (
        <Alert tone="danger" headline={error}>
          <Button variant="secondary" onClick={() => void load(range)}>
            Try again
          </Button>
        </Alert>
      ) : data === null ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-[104px] animate-pulse rounded-card bg-status-neutral" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {data.kpis.map((k) => {
              const d = kpiDelta(k, data.range);
              return (
                <div key={k.key} className="rounded-card border border-line bg-surface p-4">
                  <div className="text-caption font-semibold text-muted">{KPI_LABEL[k.key]}</div>
                  <div className="mt-1 font-display text-[28px] font-bold tabular-nums">{kpiValue(k)}</div>
                  <div className={`mt-0.5 text-caption font-semibold ${DELTA[d.tone]}`}>{d.text}</div>
                </div>
              );
            })}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="rounded-card border border-line bg-surface p-5 lg:col-span-2">
              <div className="flex items-baseline justify-between">
                <h2 className="m-0 text-[18px]">Needs review</h2>
                <span className="text-caption text-muted">Oldest first · SLA 24 h</span>
              </div>
              <div className="mt-2">
                {data.queue.length === 0 ? <p className="m-0 border-t border-line-subtle py-6 text-center text-muted">All caught up.</p> : null}
                {data.queue.map((q) => {
                  const a = QUEUE_ACTION[q.kind];
                  const built = q.kind === 'identity';
                  return (
                    <div key={q.kind} className="flex items-center gap-3.5 border-t border-line-subtle py-3">
                      <span aria-hidden="true" className={`flex size-9 shrink-0 items-center justify-center rounded-control font-bold ${a.tone}`}>
                        {a.icon}
                      </span>
                      <span className="flex min-w-0 grow flex-col">
                        <span className="font-semibold">{q.title}</span>
                        <span className="truncate text-caption text-muted">{q.sub}</span>
                      </span>
                      <span className={`text-caption font-semibold ${overSla(q.ageHours) ? 'text-status-danger-fg' : 'text-muted'}`}>{ageText(q.ageHours)}</span>
                      {built ? (
                        <Button variant="secondary" onClick={() => navigate(a.path)}>
                          {a.action}
                        </Button>
                      ) : (
                        <span className="rounded-control border border-line px-3.5 py-2 text-caption font-semibold text-disabled" title="That screen isn’t built yet">
                          {a.action}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-card border border-line bg-surface p-5">
              <h2 className="m-0 text-[18px]">Payment providers</h2>
              <p className="m-0 mb-2 mt-0.5 text-caption text-muted">Collections that finished, last hour</p>
              {data.providers.map((p) => {
                const st = PROVIDER_STATUS[p.status];
                return (
                  <div key={p.key} className="flex items-center gap-2.5 border-t border-line-subtle py-2.5">
                    <span aria-hidden="true" className="flex h-[26px] w-10 items-center justify-center rounded-chip bg-status-neutral text-[10px] font-extrabold text-status-neutral-fg">
                      {p.short}
                    </span>
                    <span className="grow text-body font-semibold">{p.name}</span>
                    <span className="text-body font-bold tabular-nums">{providerRate(p.rate)}</span>
                    <span className={`rounded-pill px-2 py-[3px] text-[12px] font-bold ${st.tone}`}>{st.label}</span>
                  </div>
                );
              })}
              {degradedNote(data.providers) === null ? null : (
                <div className="mt-2.5 rounded-control bg-status-warn p-2.5 text-caption text-status-warn-fg">
                  <strong>{degradedNote(data.providers)}</strong> Checkout shows customers a “may take longer” note automatically.
                </div>
              )}
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="rounded-card border border-line bg-surface p-5">
              <h2 className="m-0 text-[18px]">Sales by industry</h2>
              <p className="m-0 mb-2.5 mt-0.5 text-caption text-muted">Share of {compactMoney(data.industries.reduce((a, i) => a + i.amount, 0))} in this period</p>
              {data.industries.length === 0 ? <p className="m-0 text-muted">No paid orders yet.</p> : null}
              {data.industries.map((i) => (
                <div key={i.name} className="flex items-center gap-2.5 py-[5px] text-body">
                  <span className="w-24 shrink-0 truncate">{i.name}</span>
                  <span className="h-2.5 grow overflow-hidden rounded-pill bg-status-neutral">
                    <span className="block h-2.5 rounded-pill bg-brand" style={{ width: `${Math.max(2, Math.round(i.share * 100))}%` }} />
                  </span>
                  <span className="w-10 text-right font-semibold tabular-nums">{Math.round(i.share * 100)}%</span>
                </div>
              ))}
            </section>
            <section className="rounded-card border border-line bg-surface p-5 lg:col-span-2">
              <div className="flex items-baseline justify-between">
                <h2 className="m-0 text-[18px]">Recent admin activity</h2>
                <span className="text-caption text-disabled" title="The audit log screen isn’t built yet">
                  Full audit log
                </span>
              </div>
              <div className="mt-2">
                {data.activity.length === 0 ? <p className="m-0 border-t border-line-subtle py-6 text-center text-muted">Nothing recorded yet.</p> : null}
                {data.activity.map((a, i) => (
                  <div key={`${a.at}-${i}`} className="grid grid-cols-[56px_150px_minmax(0,1fr)] gap-3 border-t border-line-subtle py-2.5 text-body">
                    <span className="font-mono text-[12px] text-muted">{clock(a.at)}</span>
                    <span className="truncate font-semibold">{a.who}</span>
                    <span className="text-ink-2">{a.what}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
