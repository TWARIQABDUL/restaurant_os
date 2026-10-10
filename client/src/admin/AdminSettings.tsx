// client/src/admin/AdminSettings.tsx — milestone 27 part C, from project/AdminSettings.dc.html.
//
// THREE DEFAULTS, EACH ONE READ WHERE IT IS USED (repositories/platformSettings.ts): how a new store is paid out, how long money is
// held, when automatic payouts run. Changing the hold period changes what every merchant's wallet says on its next load, which is why
// the note under it is blunt about applying to NEW payments only.
//
// THE BOARD'S "CURRENCIES STORES MAY SELL IN" CHIPS ARE NOT HERE. They are the Currencies screen's enable switches under another name —
// two places to change one fact, which then disagree — so this page links to Currencies instead.
//
// THE HEALTH PANEL SHOWS WHAT IS MEASURED. Payment providers and the payout scheduler come from data the system writes; the SMS gateway
// and email are "not connected" because they are not, rather than green because a panel looked empty without them.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, Toast } from '../shared/ui/index.ts';
import { adminOpsApi } from './adminApi.ts';
import type { PlatformSettings, SettingsPage } from './adminApi.ts';
import { HEALTH_DOT, PAYOUT_MODE_LABEL, holdNote } from './adminLines.ts';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

export function AdminSettings({ initial, navigate }: { initial?: SettingsPage; navigate?: (to: string) => void }): ReactNode {
  const [page, setPage] = useState<SettingsPage | null>(initial ?? null);
  const [draft, setDraft] = useState<PlatformSettings | null>(initial?.settings ?? null);
  const [hold, setHold] = useState(initial === undefined ? '' : String(initial.settings.holdMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initial !== undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const p = await adminOpsApi.settings();
      setPage(p);
      setDraft(p.settings);
      setHold(String(p.settings.holdMinutes));
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'Settings could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (seeded.current) return;
    void load();
  }, [load]);

  const holdNum = parseInt(hold, 10);
  const merged: PlatformSettings | null = draft === null ? null : { ...draft, holdMinutes: Number.isNaN(holdNum) ? 0 : holdNum };
  const dirty = page !== null && merged !== null && JSON.stringify(merged) !== JSON.stringify(page.settings);
  const note = holdNote(Number.isNaN(holdNum) ? 0 : holdNum);
  const outOfRange = page !== null && (Number.isNaN(holdNum) || holdNum < page.limits.holdMin || holdNum > page.limits.holdMax);

  const save = async (): Promise<void> => {
    if (merged === null || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const p = await adminOpsApi.saveSettings(merged);
      setPage(p);
      setDraft(p.settings);
      setHold(String(p.settings.holdMinutes));
      setToast('Saved · recorded in the audit log');
      window.setTimeout(() => setToast(null), 3000);
    } catch (cause) {
      setError(reason(cause, 'That could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 grow">
          <h1 className="m-0 font-display text-[28px]">Platform settings</h1>
          <span className="text-caption text-muted">Defaults for every store. Changes are logged and only super admins can save.</span>
        </div>
        {dirty ? <span className="rounded-pill bg-status-warn px-2.5 py-1 text-caption font-bold text-status-warn-fg">Unsaved changes</span> : null}
        <Button tone="brand" disabled={!dirty || outOfRange} busy={busy} busyLabel="Saving…" onClick={() => void save()}>
          Save changes
        </Button>
      </header>

      {error === null ? null : <Alert tone="danger" headline={error} />}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5">
          <h2 className="m-0 text-[16px]">Money defaults</h2>
          {merged === null ? <p className="m-0 text-muted">Loading…</p> : (
            <>
              <div className="flex flex-col gap-1.5 text-body font-semibold">
                Default payout mode for new stores
                <div role="radiogroup" aria-label="Default payout mode" className="flex rounded-control bg-status-neutral p-[3px]">
                  {(['automatic', 'manual'] as const).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={merged.payoutModeDefault === m} onClick={() => setDraft({ ...merged, payoutModeDefault: m })} className={`h-10 grow rounded-chip border-0 bg-transparent text-caption font-semibold ${merged.payoutModeDefault === m ? 'bg-surface [box-shadow:0_1px_2px_rgb(23_22_15/.12)]' : 'text-ink-2'}`}>
                      {PAYOUT_MODE_LABEL[m]}
                    </button>
                  ))}
                </div>
                <span className="text-caption font-normal text-muted">Applies when a store first adds its payout number. An owner can change their own at any time.</span>
              </div>
              <label className="flex flex-col gap-1.5 text-body font-semibold">
                Hold period after payment
                <span className="flex h-11 w-[220px] overflow-hidden rounded-control border border-control-line bg-surface">
                  <input inputMode="numeric" value={hold} onChange={(e) => setHold(e.target.value.replace(/\D/g, ''))} className="min-w-0 grow border-0 bg-transparent px-3 font-normal outline-none" />
                  <span className="flex items-center bg-status-neutral px-3 font-medium">minutes</span>
                </span>
                <span className={`text-caption font-normal ${note.warn || outOfRange ? 'text-status-danger-fg' : 'text-muted'}`}>{outOfRange && page !== null ? `Between ${page.limits.holdMin} minutes and 7 days.` : note.text}</span>
              </label>
              <label className="flex flex-col gap-1.5 text-body font-semibold">
                Automatic payout time
                <input type="time" value={merged.automaticPayoutAt} onChange={(e) => setDraft({ ...merged, automaticPayoutAt: e.target.value })} className="h-11 w-[220px] rounded-control border border-control-line bg-surface px-3 font-normal" />
                <span className="text-caption font-normal text-muted">In each store’s own clock. Stores already on automatic keep the time they have.</span>
              </label>
              <div className="rounded-control bg-ground p-3 text-caption text-ink-2">
                Which currencies stores may sell in is set in{' '}
                <a href="/admin/currencies" onClick={(e) => { if (navigate !== undefined) { e.preventDefault(); navigate('/admin/currencies'); } }} className="font-semibold">
                  Currencies
                </a>
                , where their formats and rates live.
              </div>
            </>
          )}
        </section>

        <section className="flex flex-col gap-1 rounded-card border border-line bg-surface p-5">
          <div className="mb-1.5 flex items-center justify-between">
            <h2 className="m-0 text-[16px]">Health</h2>
            <span className="text-[12px] text-muted">Read when this page opens</span>
          </div>
          {page === null ? <p className="m-0 text-muted">Loading…</p> : null}
          {page?.health.map((h) => {
            const d = HEALTH_DOT[h.state];
            return (
              <div key={h.name} className="flex items-center gap-2.5 border-t border-line-subtle py-2.5 text-body">
                <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-pill ${d.dot}`} />
                <span className="grow">{h.name}</span>
                <span className="text-caption text-muted">{h.detail}</span>
                <span className={`rounded-pill px-2 py-0.5 text-[12px] font-bold ${d.badge}`}>{d.label}</span>
              </div>
            );
          })}
        </section>
      </div>

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
