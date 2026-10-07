// client/src/admin/Payouts.tsx — milestone 27 part B, from project/AdminPayouts.dc.html.
//
// FOUR PILES, AND ONE OF THEM IS NOT A LIST OF PAYOUTS. Failed, In progress and Completed are withdrawals. Held is the stores whose
// money cannot leave right now and why (repositories/adminPayouts.ts) — nothing was attempted, so there is no row to list, and the
// pile is computed from the same three conditions the payout gate refuses on.
//
// THERE IS NO "REJECT" on a failed payout, where the board has one. A failed transfer's money is already back in the store's
// Available balance, put there in the transaction that recorded the failure; a button promising to "return money to the store's
// balance" would be promising a thing that already happened. What an admin can do is Retry, which asks for a new transfer.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, Toast } from '../shared/ui/index.ts';
import { adminMoneyApi } from './adminApi.ts';
import type { PayoutTab, PayoutsPage } from './adminApi.ts';
import { PAYOUT_STATUS, PAYOUT_TAB_LABEL, rwf, whenText } from './adminLines.ts';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

export function Payouts({ initial, initialTab }: { initial?: PayoutsPage; initialTab?: PayoutTab }): ReactNode {
  const [tab, setTab] = useState<PayoutTab>(initialTab ?? 'problem');
  const [data, setData] = useState<PayoutsPage | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initial !== undefined);

  const load = useCallback(async (t: PayoutTab): Promise<void> => {
    try {
      setData(await adminMoneyApi.payouts(t));
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'Payouts could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    void load(tab);
  }, [load, tab]);

  const flash = (m: string): void => {
    setToast(m);
    window.setTimeout(() => setToast((c) => (c === m ? null : c)), 3000);
  };

  const retry = async (id: string, store: string): Promise<void> => {
    setBusy(id);
    try {
      await adminMoneyApi.retry(id);
      flash(`Retry sent for ${store}`);
      await load(tab);
    } catch (cause) {
      setError(reason(cause, 'That payout could not be retried.'));
    } finally {
      setBusy(null);
    }
  };

  const k = data?.kpis;

  return (
    <div className="flex flex-col gap-3.5">
      <header>
        <h1 className="m-0 font-display text-[28px]">Payouts</h1>
        <span className="text-caption text-muted">Automatic runs and manual withdrawals, across every store.</span>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { l: 'Today’s automatic run', v: k === undefined ? '—' : rwf(k.runTotal), d: k === undefined ? '' : `${k.runStores} ${k.runStores === 1 ? 'store' : 'stores'} paid`, tone: 'text-muted' },
          { l: 'Failed', v: k === undefined ? '—' : String(k.failed), d: 'Needs a retry', tone: 'text-status-danger-fg' },
          { l: 'Held', v: k === undefined ? '—' : String(k.held), d: 'Unverified, suspended or owed refunds', tone: 'text-status-warn-fg' },
          { l: 'Hold period', v: k === undefined ? '—' : `${k.holdMinutes} min`, d: 'after payment · set by the server', tone: 'text-muted' },
        ].map((x) => (
          <div key={x.l} className="rounded-card border border-line bg-surface px-4 py-3.5">
            <div className="text-caption font-semibold text-muted">{x.l}</div>
            <div className="font-display text-[24px] font-bold tabular-nums">{x.v}</div>
            <div className={`text-[12px] ${x.tone}`}>{x.d}</div>
          </div>
        ))}
      </div>

      <div role="tablist" className="flex gap-1 border-b border-line">
        {(['problem', 'held', 'live', 'done'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`h-11 border-b-[3px] px-3.5 text-body font-bold ${tab === t ? 'border-ink text-ink' : 'border-transparent text-muted'}`}>
            {PAYOUT_TAB_LABEL[t]}
            {data !== null && t !== 'done' ? ` (${data.counts[t]})` : ''}
          </button>
        ))}
      </div>

      {error === null ? null : (
        <Alert tone="danger" headline={error}>
          <Button variant="secondary" onClick={() => void load(tab)}>
            Try again
          </Button>
        </Alert>
      )}

      <section className="overflow-hidden rounded-card border border-line bg-surface">
        {data === null ? (
          <div className="p-10 text-center text-muted" aria-busy="true">
            Loading…
          </div>
        ) : data.rows.length === 0 ? (
          <div className="p-10 text-center text-muted">Nothing here.</div>
        ) : (
          data.rows.map((w) => {
            const st = PAYOUT_STATUS[w.status];
            return (
              <div key={`${w.kind}-${w.id}`} className="grid grid-cols-1 items-center gap-2 border-t border-line-subtle px-4 py-3 first:border-t-0 lg:grid-cols-[110px_minmax(0,1.3fr)_120px_120px_minmax(0,2fr)_110px] lg:gap-3">
                <span className="text-caption text-muted">{whenText(w.at)}</span>
                <span className="flex min-w-0 flex-col">
                  <strong className="truncate">{w.store}</strong>
                  <span className="truncate text-[12px] text-muted">
                    {w.kind} · {w.destination}
                  </span>
                </span>
                <span className="font-bold tabular-nums">{rwf(w.amount)}</span>
                <span className={`justify-self-start rounded-pill px-2 py-0.5 text-[12px] font-bold ${st.tone}`}>{st.label}</span>
                <span className="text-caption text-ink-2">{w.note}</span>
                <span className="flex justify-end">
                  {w.canRetry ? (
                    <Button tone="brand" busy={busy === w.id} busyLabel="Retrying…" onClick={() => void retry(w.id, w.store)}>
                      Retry
                    </Button>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
      </section>

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
