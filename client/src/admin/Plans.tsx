// client/src/admin/Plans.tsx — milestone 27 part C, from project/AdminPlans.dc.html.
//
// "NOT DECIDED" IS A STATE. The board prints `[PRICE]` and `[FEE] %` because finance has not confirmed them, and the database holds
// the same fact as NULL. An empty field here saves NULL and displays as "Not decided" — it is never 0, which anything that later
// charges by these columns would read as "free". Nothing charges by them today.
//
// WHAT THE BOARD HAS THAT THIS DOES NOT, and says so on the page rather than leaving a dead control:
//   * per-plan feature switches (custom domain, analytics beyond 30 days, CSV export …) — no plan_features table exists and nothing
//     enforces a plan's limits, so a switch would be a label on nothing;
//   * "Saving notifies the N stores on this plan … after [NOTICE PERIOD]" — the notice period is the board's own open question, and
//     stores are not notified automatically yet, so the warning says the opposite of what the board's does: tell them first;
//   * "+ New plan" — a plan is a pricing decision, and the staff limit and fees only mean something once something enforces them.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, TextField, Toast } from '../shared/ui/index.ts';
import { adminOpsApi } from './adminApi.ts';
import type { Plan } from './adminApi.ts';
import { PLAN_FIELD, parseField, planSummary, planValue } from './adminLines.ts';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

type Draft = { monthlyPrice: string; paymentFeePercent: string; withdrawalFee: string; staffAccountLimit: string };
const draftOf = (p: Plan): Draft => ({ monthlyPrice: p.monthlyPrice === null ? '' : String(p.monthlyPrice), paymentFeePercent: p.paymentFeePercent === null ? '' : String(p.paymentFeePercent), withdrawalFee: p.withdrawalFee === null ? '' : String(p.withdrawalFee), staffAccountLimit: p.staffAccountLimit === null ? '' : String(p.staffAccountLimit) });

export function Plans({ initial, initialEditing }: { initial?: Plan[]; initialEditing?: string }): ReactNode {
  const [plans, setPlans] = useState<Plan[] | null>(initial ?? null);
  const [editing, setEditing] = useState<string | null>(initialEditing ?? null);
  const [draft, setDraft] = useState<Draft | null>(initialEditing === undefined || initial === undefined ? null : draftOf(initial.find((p) => p.key === initialEditing)!));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initial !== undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      setPlans((await adminOpsApi.plans()).plans);
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'Plans could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (seeded.current) return;
    void load();
  }, [load]);

  const start = (p: Plan): void => {
    setEditing(editing === p.key ? null : p.key);
    setDraft(draftOf(p));
    setError(null);
  };

  const save = async (p: Plan): Promise<void> => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await adminOpsApi.savePlan(p.key, { monthlyPrice: parseField(draft.monthlyPrice), paymentFeePercent: parseField(draft.paymentFeePercent), withdrawalFee: parseField(draft.withdrawalFee), staffAccountLimit: parseField(draft.staffAccountLimit) });
      setPlans((l) => (l === null ? l : l.map((x) => (x.key === saved.key ? saved : x))));
      setEditing(null);
      setToast(`${p.name} saved · logged`);
      window.setTimeout(() => setToast(null), 3000);
    } catch (cause) {
      setError(reason(cause, 'That plan could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="m-0 font-display text-[28px]">Plans &amp; fees</h1>
        <span className="text-caption text-muted">What each store pays and what it gets. A field left empty means finance hasn’t decided it yet.</span>
      </header>

      {error === null ? null : <Alert tone="danger" headline={error} />}

      <div className="grid gap-4 lg:grid-cols-2">
        {plans === null ? <p className="text-muted">Loading…</p> : null}
        {plans?.map((p) => {
          const on = editing === p.key && draft !== null;
          return (
            <section key={p.key} className={`flex flex-col gap-3 rounded-card bg-surface p-5 ${on ? 'border-2 border-brand' : 'border border-line'}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="m-0 font-display text-[22px]">{p.name}</h2>
                  <span className="text-caption text-muted">
                    {planSummary(p)}
                    {p.isDefault ? ' · the plan new stores start on' : ''}
                  </span>
                </div>
                <Button variant="secondary" onClick={() => start(p)}>
                  {on ? 'Cancel' : 'Edit'}
                </Button>
              </div>

              {on ? (
                <div className="grid grid-cols-2 gap-3">
                  {PLAN_FIELD.map((f) => (
                    <TextField key={f.key} label={f.unit === '' ? f.label : `${f.label} (${f.unit === 'RWF' ? p.currency : f.unit})`} inputMode="decimal" placeholder="Not decided" value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} hint={f.key === 'staffAccountLimit' ? 'Empty is unlimited.' : undefined} />
                  ))}
                </div>
              ) : (
                <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2.5">
                  {PLAN_FIELD.map((f) => {
                    const v = p[f.key];
                    return (
                      <div key={f.key} className="flex flex-col">
                        <dt className="text-[12px] font-semibold text-muted">{f.label}</dt>
                        <dd className={`m-0 font-semibold ${v === null && f.key !== 'staffAccountLimit' ? 'text-disabled' : ''}`}>
                          {planValue(v, f.key === 'staffAccountLimit')}
                          {v !== null && f.unit !== '' ? ` ${f.unit === 'RWF' ? p.currency : f.unit}` : ''}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}

              {on ? (
                <div className="flex flex-col gap-2 rounded-control bg-status-warn p-3 text-caption text-status-warn-fg">
                  <span>
                    {planSummary(p)} are on this plan. <strong>They are not told automatically.</strong> Let them know before a price or a fee changes — nothing charges by these figures yet, so a change here is recorded, not billed.
                  </span>
                  <div>
                    <Button tone="brand" busy={busy} busyLabel="Saving…" onClick={() => void save(p)}>
                      Save {p.name}
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      <section className="rounded-card border border-line bg-surface p-4 text-body text-ink-2">
        <strong className="text-ink">Not built yet:</strong> per-plan features (custom domain, analytics history, CSV export), notifying the stores on a plan, and adding a plan. Nothing in the product enforces a plan’s limits today, so a switch for one would change nothing.
      </section>

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
