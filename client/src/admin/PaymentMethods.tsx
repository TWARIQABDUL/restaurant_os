// client/src/admin/PaymentMethods.tsx — milestone 27 part B, from project/AdminPayments.dc.html.
//
// WHAT THE SCHEMA HOLDS IS EDITABLE; WHAT IT DOES NOT IS SAID, NOT DRAWN. The board's Connection panel has a credentials vault with
// rotation, a Sandbox/Production switch and a "run sandbox test payment" button, and its sidebar has a rollout setting, a merchant fee,
// a payout schedule and a second admin's finance approval. None of those is stored or acted on anywhere, so this screen shows the
// provider and webhook it does know and says the rest is not built, rather than offering controls that would save nothing.
//
// "READY TO PUBLISH" IS COMPUTED, NOT TICKED. The board's checklist has two lines a person ticks by hand ("checkout wording reviewed",
// "finance approval") — a tick nobody can check. These lines are facts about the method (is it available anywhere, can it charge in a
// currency, are the words written, is a provider and webhook named), and Publish is refused by the server until every one is true.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, TextField, Toast } from '../shared/ui/index.ts';
import { adminMoneyApi } from './adminApi.ts';
import type { MethodDetail, MethodRow } from './adminApi.ts';
import { CHECKOUT_PREVIEW_CASH, METHOD_BADGE, clock, methodMeta, readinessCount, thousands, unthousands } from './adminLines.ts';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

type Draft = { countries: string[]; limits: Record<string, { min: string; max: string }>; label: string; hint: string; incident: string };

function draftOf(d: MethodDetail): Draft {
  return {
    countries: d.countries,
    limits: Object.fromEntries(d.limits.map((l) => [l.currency, { min: thousands(l.min), max: thousands(l.max) }])),
    label: d.customerLabel,
    hint: d.customerHint,
    incident: d.incidentNote ?? '',
  };
}

type Props = { initialList?: MethodRow[]; initialDetail?: MethodDetail; initialConfirmPause?: boolean };

export function PaymentMethods({ initialList, initialDetail, initialConfirmPause }: Props): ReactNode {
  const [list, setList] = useState<MethodRow[] | null>(initialList ?? null);
  const [sel, setSel] = useState<string | null>(initialDetail?.key ?? null);
  const [detail, setDetail] = useState<MethodDetail | null>(initialDetail ?? null);
  const [draft, setDraft] = useState<Draft | null>(initialDetail === undefined ? null : draftOf(initialDetail));
  const [confirmPause, setConfirmPause] = useState(initialConfirmPause ?? false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initialList !== undefined);

  const flash = (m: string): void => {
    setToast(m);
    window.setTimeout(() => setToast((c) => (c === m ? null : c)), 3000);
  };

  const loadList = useCallback(async (): Promise<void> => {
    try {
      const r = await adminMoneyApi.methods();
      setList(r.methods);
      setSel((cur) => cur ?? r.methods.find((m) => m.status === 'draft')?.key ?? r.methods[0]?.key ?? null);
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'Payment methods could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (seeded.current) return;
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    setConfirmPause(false);
    if (sel === null) return setDetail(null);
    let live = true;
    void adminMoneyApi.method(sel).then((d) => {
      if (!live) return;
      setDetail(d);
      setDraft(draftOf(d));
    }).catch((cause: unknown) => live && setError(reason(cause, 'That method could not be loaded.')));
    return () => {
      live = false;
    };
  }, [sel]);

  const adopt = (d: MethodDetail): void => {
    setDetail(d);
    setDraft(draftOf(d));
    setList((l) => (l === null ? l : l.map((m) => (m.key === d.key ? { key: d.key, name: d.name, short: d.short, kind: d.kind, status: d.status, countries: d.countries, currencies: d.currencies } : m))));
  };

  const run = async (what: string, fn: () => Promise<MethodDetail>, done: string): Promise<void> => {
    setBusy(what);
    setError(null);
    try {
      adopt(await fn());
      flash(done);
    } catch (cause) {
      setError(reason(cause, 'That did not go through.'));
    } finally {
      setBusy(null);
      setConfirmPause(false);
    }
  };

  const dirty = detail !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(detail));

  const save = (): void => {
    if (detail === null || draft === null) return;
    const currencies = detail.catalogue.currencies.filter((c) => draft.limits[c.code] !== undefined).map((c) => ({ code: c.code, min: unthousands(draft.limits[c.code]!.min), max: unthousands(draft.limits[c.code]!.max) }));
    void run('save', () => adminMoneyApi.saveMethod(detail.key, { countries: draft.countries, currencies, customerLabel: draft.label, customerHint: draft.hint, incidentNote: draft.incident.trim() === '' ? null : draft.incident }), `${detail.name} saved`);
  };

  const toggleCountry = (code: string): void => {
    if (draft === null) return;
    setDraft({ ...draft, countries: draft.countries.includes(code) ? draft.countries.filter((c) => c !== code) : [...draft.countries, code] });
  };
  const toggleCurrency = (code: string): void => {
    if (draft === null) return;
    const next = { ...draft.limits };
    if (next[code] === undefined) next[code] = { min: '', max: '' };
    else delete next[code];
    setDraft({ ...draft, limits: next });
  };

  const badge = detail === null ? null : METHOD_BADGE[detail.status];
  const ready = detail === null ? null : readinessCount(detail);

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:gap-7">
      <nav aria-label="Payment methods" className="flex shrink-0 flex-col gap-1.5 lg:w-[300px]">
        <h1 className="m-0 font-display text-[26px]">Payment methods</h1>
        <p className="m-0 mb-2 text-body text-muted">What customers can pay with, where, and in which currency.</p>
        {list === null ? <p className="m-0 text-muted">Loading…</p> : null}
        {list?.map((m) => {
          const b = METHOD_BADGE[m.status];
          const on = m.key === sel;
          return (
            <button key={m.key} type="button" aria-pressed={on} onClick={() => setSel(m.key)} className={`flex items-center gap-2.5 rounded-card p-2.5 text-left ${on ? 'border border-line bg-surface [box-shadow:0_0_0_1px_var(--color-line)]' : 'border border-transparent bg-transparent'}`}>
              <span aria-hidden="true" className="flex h-8 w-12 shrink-0 items-center justify-center rounded-chip bg-status-neutral text-[10px] font-extrabold text-status-neutral-fg">
                {m.short}
              </span>
              <span className="flex min-w-0 grow flex-col">
                <span className="font-semibold">{m.name}</span>
                <span className="truncate text-[12px] text-muted">{methodMeta(m)}</span>
              </span>
              <span className={`rounded-pill px-2 py-0.5 text-[12px] font-bold ${b.tone}`}>{b.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 grow">
        {error === null ? null : <Alert tone="danger" headline={error} />}
        {detail === null || draft === null || badge === null || ready === null ? null : (
          <div className="flex flex-col gap-4">
            <header className="flex items-center gap-3">
              <span aria-hidden="true" className="flex h-11 w-16 items-center justify-center rounded-control bg-status-neutral text-[12px] font-extrabold text-status-neutral-fg">
                {detail.short}
              </span>
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="m-0 text-[22px]">{detail.name}</h2>
                  <span className={`rounded-pill px-2 py-[3px] text-[12px] font-bold ${badge.tone}`}>{badge.label}</span>
                </div>
                <span className="text-caption text-muted">{detail.provider ?? 'Built in · no provider'}</span>
              </div>
            </header>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
              <div className="flex flex-col gap-4">
                <section className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4">
                  <h3 className="m-0 text-body">Where it’s available</h3>
                  <div>
                    <div className="mb-1.5 text-caption font-semibold text-muted">Countries</div>
                    <div className="flex flex-wrap gap-2">
                      {detail.catalogue.countries.map((c) => {
                        const on = draft.countries.includes(c.code);
                        return (
                          <button key={c.code} type="button" aria-pressed={on} disabled={!c.enabled} onClick={() => toggleCountry(c.code)} className={`h-10 rounded-control px-3.5 text-body font-semibold ${!c.enabled ? 'cursor-not-allowed border border-dashed border-control-line bg-surface text-disabled' : on ? 'border-2 border-brand bg-brand-tint' : 'border border-control-line bg-surface'}`}>
                            {c.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1.5 text-caption font-semibold text-muted">Currencies it can charge in, with limits</div>
                    <div className="flex flex-wrap gap-2">
                      {detail.catalogue.currencies.map((c) => {
                        const on = draft.limits[c.code] !== undefined;
                        return (
                          <button key={c.code} type="button" aria-pressed={on} disabled={!c.enabled} onClick={() => toggleCurrency(c.code)} className={`h-10 rounded-control px-3.5 text-body font-semibold ${!c.enabled ? 'cursor-not-allowed border border-dashed border-control-line bg-surface text-disabled' : on ? 'border-2 border-brand bg-brand-tint' : 'border border-control-line bg-surface'}`}>
                            {c.code}
                          </button>
                        );
                      })}
                    </div>
                    <span className="mt-1.5 block text-caption text-muted">Greyed-out currencies aren’t turned on yet. Turn them on in Currencies.</span>
                    <div className="mt-2.5 flex flex-col gap-2">
                      {Object.entries(draft.limits).map(([code, l]) => (
                        <div key={code} className="grid grid-cols-[48px_1fr_1fr] items-end gap-2.5">
                          <span className="pb-3 font-mono text-[12px] font-bold">{code}</span>
                          <TextField label="Minimum per payment" inputMode="numeric" value={l.min} onChange={(e) => setDraft({ ...draft, limits: { ...draft.limits, [code]: { ...l, min: thousands(unthousands(e.target.value)) } } })} />
                          <TextField label="Maximum per payment" inputMode="numeric" value={l.max} onChange={(e) => setDraft({ ...draft, limits: { ...draft.limits, [code]: { ...l, max: thousands(unthousands(e.target.value)) } } })} />
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="grid gap-4 rounded-card border border-line bg-surface p-4 md:grid-cols-2">
                  <div className="flex flex-col gap-2.5">
                    <h3 className="m-0 text-body">At checkout</h3>
                    <TextField label="Name customers see" value={draft.label} maxLength={60} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
                    <TextField label="Hint under the name" value={draft.hint} maxLength={120} onChange={(e) => setDraft({ ...draft, hint: e.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-caption font-semibold text-muted">Preview</span>
                    <div className="flex flex-col gap-2 rounded-card bg-ground p-3">
                      <div className="flex items-center gap-2.5 rounded-control border-2 border-brand bg-surface p-2.5">
                        <span aria-hidden="true" className="flex h-7 w-11 items-center justify-center rounded-chip bg-status-neutral text-[10px] font-extrabold">
                          {detail.short}
                        </span>
                        <span className="flex grow flex-col">
                          <span className="font-semibold">{draft.label}</span>
                          <span className="text-caption text-muted">{draft.hint}</span>
                        </span>
                        <span aria-hidden="true" className="size-4 rounded-pill border-[5px] border-brand" />
                      </div>
                      <div className="flex items-center gap-2.5 rounded-control border border-control-line bg-surface p-2.5">
                        <span aria-hidden="true" className="flex h-7 w-11 items-center justify-center rounded-chip bg-brand-tint text-[10px] font-extrabold text-brand-strong">
                          {CHECKOUT_PREVIEW_CASH.short}
                        </span>
                        <span className="font-semibold">{CHECKOUT_PREVIEW_CASH.name}</span>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
                  <h3 className="m-0 text-body">Connection</h3>
                  <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-y-1.5 text-body">
                    <dt className="text-muted">Provider</dt>
                    <dd className="m-0">{detail.provider ?? 'Built in — none needed'}</dd>
                    <dt className="text-muted">Webhook</dt>
                    <dd className="m-0 break-all font-mono text-[13px]">{detail.webhook ?? 'Not needed'}</dd>
                  </dl>
                  <span className="text-caption text-muted">Credentials, the sandbox/production switch and test payments aren’t managed here yet — the provider’s keys live in the server’s environment.</span>
                  <TextField label="Incident note" hint="Shown to customers at checkout while a provider is struggling. Leave empty when everything is fine." value={draft.incident} maxLength={200} onChange={(e) => setDraft({ ...draft, incident: e.target.value })} />
                </section>

                <div>
                  <Button tone="brand" disabled={!dirty} busy={busy === 'save'} busyLabel="Saving…" onClick={save}>
                    Save changes
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                {detail.status === 'draft' ? (
                  <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
                    <h3 className="m-0 text-body">Ready to publish?</h3>
                    <span className="text-caption text-muted">
                      {ready.done} of {ready.total} done
                    </span>
                    <span className="h-1.5 overflow-hidden rounded-pill bg-status-neutral">
                      <span className="block h-1.5 rounded-pill bg-brand" style={{ width: `${(ready.done / ready.total) * 100}%` }} />
                    </span>
                    {detail.readiness.map((r) => (
                      <div key={r.key} className="flex items-start gap-2.5">
                        <span aria-hidden="true" className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-chip text-[12px] font-extrabold ${r.ok ? 'bg-brand text-white' : 'border-[1.5px] border-control-line'}`}>
                          {r.ok ? '✓' : ''}
                        </span>
                        <span className="flex flex-col">
                          <span className="font-semibold">{r.label}</span>
                          <span className="text-caption text-muted">{r.sub}</span>
                        </span>
                      </div>
                    ))}
                    <Button tone="brand" disabled={ready.done !== ready.total || dirty} busy={busy === 'publish'} busyLabel="Publishing…" onClick={() => void run('publish', () => adminMoneyApi.setMethodStatus(detail.key, 'publish'), `${detail.name} is live`)}>
                      {ready.done === ready.total ? `Publish ${detail.name}` : `Publish · ${ready.total - ready.done} step${ready.total - ready.done === 1 ? '' : 's'} left`}
                    </Button>
                    <span className="text-caption text-muted">{dirty ? 'Save your changes first.' : 'Nothing changes for customers until a store connects it.'}</span>
                  </section>
                ) : null}

                {detail.status === 'live' ? (
                  <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
                    <h3 className="m-0 text-body">Health</h3>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-control bg-ground p-2.5">
                        <div className="text-[12px] text-muted">Success, 1 h</div>
                        <div className="font-display text-[20px] font-bold tabular-nums">{detail.health.rate === null ? '—' : `${detail.health.rate.toFixed(1)}%`}</div>
                      </div>
                      <div className="rounded-control bg-ground p-2.5">
                        <div className="text-[12px] text-muted">Stores using</div>
                        <div className="font-display text-[20px] font-bold tabular-nums">{detail.stores.toLocaleString('en-US')}</div>
                      </div>
                    </div>
                    {detail.incidentNote === null ? null : <div className="rounded-control bg-status-warn p-2.5 text-caption text-status-warn-fg">{detail.incidentNote}</div>}
                    {confirmPause ? (
                      <div className="flex flex-col gap-2 rounded-control bg-status-danger p-3 text-status-danger-fg">
                        <strong>Pause {detail.name} everywhere?</strong>
                        <span className="text-caption">It disappears from every checkout at once. Payments already in progress still complete.</span>
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" onClick={() => setConfirmPause(false)}>
                            Cancel
                          </Button>
                          <Button busy={busy === 'pause'} busyLabel="Pausing…" onClick={() => void run('pause', () => adminMoneyApi.setMethodStatus(detail.key, 'pause'), `${detail.name} paused on all checkouts`)}>
                            Pause now
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button variant="secondary" onClick={() => setConfirmPause(true)}>
                        Pause this method
                      </Button>
                    )}
                  </section>
                ) : null}

                {detail.status === 'paused' ? (
                  <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
                    <h3 className="m-0 text-body">Paused</h3>
                    <span className="text-caption text-muted">Hidden from all checkouts. Stores see it as unavailable in their payment settings.</span>
                    <Button tone="brand" busy={busy === 'resume'} busyLabel="Turning on…" onClick={() => void run('resume', () => adminMoneyApi.setMethodStatus(detail.key, 'resume'), `${detail.name} is back on`)}>
                      Turn back on
                    </Button>
                  </section>
                ) : null}

                <section className="flex flex-col gap-1.5 rounded-card border border-line bg-surface p-4">
                  <h3 className="m-0 text-body">History</h3>
                  {detail.history.length === 0 ? <span className="text-caption text-muted">No changes recorded yet.</span> : null}
                  {detail.history.map((h) => (
                    <div key={`${h.at}-${h.what}`} className="grid grid-cols-[56px_minmax(0,1fr)] gap-2 text-caption">
                      <span className="font-mono text-muted">{clock(h.at)}</span>
                      <span>
                        {h.what} <span className="text-muted">· {h.who}</span>
                      </span>
                    </div>
                  ))}
                </section>
              </div>
            </div>
          </div>
        )}
      </div>

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
