// client/src/admin/Currencies.tsx — milestone 27 part B, from project/AdminCurrencies.dc.html.
//
// SAVES ONE CURRENCY AT A TIME, where the board stages edits behind "Publish changes". There is no staging table (see
// repositories/adminConfig.ts for why one was not invented), so the panel has an ordinary Save: the preview shows what the edit WILL
// look like, the button writes it, and the audit log says who did.
//
// "ADD CURRENCY" IS NOT BUILT. The six currencies are seeded (V006) and a seventh is a data decision — its sample amounts, its
// rounding, which country it belongs to — not a form. The board's rate-feed option is shown for what it is: no feed is connected,
// so a currency on "Rate feed" shows no converted price until somebody sets the rate by hand.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, Toast } from '../shared/ui/index.ts';
import { adminMoneyApi } from './adminApi.ts';
import type { Currency } from './adminApi.ts';
import { ROUNDING_LABEL, currencyPreview, formatCurrency, rateNote, SAMPLE } from './adminLines.ts';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

type Draft = { symbol: string; position: 'before' | 'after'; decimals: 0 | 2; separator: ',' | ' ' | '.'; rounding: 0 | 10 | 50 | 100 | 500; rateSource: 'feed' | 'manual'; rate: string };

const draftOf = (c: Currency): Draft => ({ symbol: c.symbol, position: c.position, decimals: c.decimals, separator: c.separator, rounding: c.rounding, rateSource: c.rateSource, rate: c.usdRate === null ? '' : String(c.usdRate) });

const NOTE_TONE = { ok: 'bg-status-success text-status-success-fg', warn: 'bg-status-warn text-status-warn-fg', plain: 'bg-ground text-ink-2' } as const;

export function Currencies({ initial, initialSelected }: { initial?: Currency[]; initialSelected?: string }): ReactNode {
  const [list, setList] = useState<Currency[] | null>(initial ?? null);
  const [sel, setSel] = useState<string>(initialSelected ?? 'RWF');
  const [draft, setDraft] = useState<Draft | null>(initial === undefined ? null : draftOf(initial.find((c) => c.code === (initialSelected ?? 'RWF')) ?? initial[0]!));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initial !== undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await adminMoneyApi.currencies();
      setList(r.currencies);
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'Currencies could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (seeded.current) return;
    void load();
  }, [load]);

  const cur = list?.find((c) => c.code === sel) ?? null;
  useEffect(() => {
    if (cur !== null && !seeded.current) setDraft(draftOf(cur));
    seeded.current = false;
    // Reset the draft when a different currency is chosen or the list reloads, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, list]);

  const flash = (m: string): void => {
    setToast(m);
    window.setTimeout(() => setToast((c) => (c === m ? null : c)), 3000);
  };

  const apply = async (what: string, patch: Parameters<typeof adminMoneyApi.saveCurrency>[1], done: string): Promise<void> => {
    if (cur === null) return;
    setBusy(what);
    setError(null);
    try {
      const saved = await adminMoneyApi.saveCurrency(cur.code, patch);
      setList((l) => (l === null ? l : l.map((c) => (c.code === saved.code ? saved : c))));
      flash(done);
    } catch (cause) {
      setError(reason(cause, 'That could not be saved.'));
    } finally {
      setBusy(null);
    }
  };

  const dirty = cur !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(cur));
  const shown = cur !== null && draft !== null ? { ...cur, symbol: draft.symbol, position: draft.position, decimals: draft.decimals, separator: draft.separator, rounding: draft.rounding, rateSource: draft.rateSource } : null;
  const pv = shown === null ? null : currencyPreview(shown);
  const note = shown === null || draft === null ? null : rateNote(shown, draft.rate);

  const save = (): void => {
    if (cur === null || draft === null) return;
    const rate = draft.rate.trim() === '' ? null : parseFloat(draft.rate.replace(/,/g, ''));
    const patch: Parameters<typeof adminMoneyApi.saveCurrency>[1] = { symbol: draft.symbol, position: draft.position, decimals: draft.decimals, separator: draft.separator, rounding: draft.rounding, rateSource: draft.rateSource };
    if (rate !== (cur.usdRate ?? null)) patch.usdRate = rate;
    void apply('save', patch, `${cur.code} saved · live on every store`);
  };

  const seg = (on: boolean): string => (on ? 'bg-surface [box-shadow:0_1px_2px_rgb(23_22_15/.12)]' : 'text-ink-2');

  return (
    <div className="flex flex-col gap-5 xl:flex-row xl:gap-0">
      <div className="flex min-w-0 grow flex-col gap-4 xl:pr-7">
        <header>
          <h1 className="m-0 font-display text-[28px]">Currencies</h1>
          <p className="m-0 mt-0.5 text-body text-muted">How money is shown, rounded and converted across every store.</p>
        </header>

        {error === null ? null : <Alert tone="danger" headline={error} />}

        <section className="overflow-x-auto rounded-card border border-line bg-surface">
          <div className="hidden min-w-[760px] grid-cols-[minmax(0,1.6fr)_130px_90px_110px_minmax(0,1.3fr)_70px] gap-3 bg-ground px-4 py-2.5 text-[12px] font-semibold text-muted md:grid">
            <span>Currency</span>
            <span>Example</span>
            <span>Decimals</span>
            <span>Cash rounding</span>
            <span>Used by</span>
            <span>Enabled</span>
          </div>
          {list === null ? <div className="p-10 text-center text-muted">Loading…</div> : null}
          {list?.map((c) => (
            <div key={c.code} className={`grid min-w-[760px] grid-cols-[minmax(0,1.6fr)_130px_90px_110px_minmax(0,1.3fr)_70px] items-center gap-3 border-t border-line-subtle px-4 py-3 ${c.code === sel ? 'bg-brand-wash [box-shadow:inset_3px_0_0_var(--color-brand)]' : ''}`}>
              <button type="button" aria-pressed={c.code === sel} onClick={() => setSel(c.code)} className="flex items-center gap-2.5 border-0 bg-transparent p-0 text-left">
                <span className="rounded-chip bg-status-neutral px-2 py-1 font-mono text-[12px] font-bold">{c.code}</span>
                <span className="flex flex-col">
                  <span className="font-semibold">{c.name}</span>
                  <span className="text-[12px] text-muted">{c.tag}</span>
                </span>
              </button>
              <span className="font-semibold tabular-nums">{formatCurrency((SAMPLE[c.code] ?? [3500, 0])[0], c)}</span>
              <span>{c.decimals === 0 ? 'None' : '2'}</span>
              <span>{ROUNDING_LABEL(c.rounding)}</span>
              <span className="text-caption text-ink-2">{c.usage}</span>
              <button
                type="button"
                role="switch"
                aria-checked={c.enabled}
                aria-label={`Enable ${c.code}`}
                disabled={c.lockedReason !== null || busy !== null}
                title={c.lockedReason ?? undefined}
                onClick={() => { setSel(c.code); void apply(`toggle-${c.code}`, { enabled: !c.enabled }, `${c.code} ${c.enabled ? 'switched off' : 'switched on'}`); }}
                className={`flex h-6 w-10 rounded-pill border-0 p-[3px] ${c.enabled ? 'justify-end bg-brand' : 'justify-start bg-control-line'} ${c.lockedReason !== null ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <span className="size-[18px] rounded-pill bg-surface" />
              </button>
            </div>
          ))}
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          {[
            ['Stores sell in one currency', 'Each store’s selling currency is set by its country at sign-up. Changing it later needs admin approval.'],
            ['Customers can see converted prices', 'Shown as “≈ $2.40” next to the real price once a rate is set. The charge is always in the store’s currency.'],
            ['Merchants are paid in their currency', 'No conversion happens on payouts. Payment methods list which currencies they can charge in.'],
          ].map(([h, b]) => (
            <div key={h} className="flex flex-col gap-1 rounded-card border border-line bg-surface p-3.5">
              <strong>{h}</strong>
              <span className="text-caption text-muted">{b}</span>
            </div>
          ))}
        </section>
      </div>

      <aside aria-label="Currency settings" className="flex shrink-0 flex-col gap-4 rounded-card border border-line bg-surface p-5 xl:w-[340px] xl:self-start xl:rounded-none xl:border-y-0 xl:border-r-0 xl:border-l xl:bg-transparent xl:pl-6">
        {cur === null || draft === null || pv === null || note === null ? (
          <p className="m-0 py-10 text-center text-muted">Select a currency.</p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="rounded-chip bg-status-neutral px-2.5 py-1.5 font-mono text-[14px] font-bold">{cur.code}</span>
              <div>
                <h2 className="m-0 text-[20px]">{cur.name}</h2>
                <span className="text-caption text-muted">{cur.tag}</span>
              </div>
            </div>

            <section className="flex flex-col gap-3">
              <h3 className="m-0 text-body">Display</h3>
              <label className="flex flex-col gap-1 text-caption font-semibold">
                Symbol
                <input value={draft.symbol} maxLength={8} onChange={(e) => setDraft({ ...draft, symbol: e.target.value })} className="h-11 rounded-control border border-control-line bg-surface px-3 text-body font-normal" />
              </label>
              <div className="flex flex-col gap-1 text-caption font-semibold">
                Symbol position
                <div role="radiogroup" aria-label="Symbol position" className="flex rounded-control bg-status-neutral p-[3px]">
                  {(['before', 'after'] as const).map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={draft.position === p} onClick={() => setDraft({ ...draft, position: p })} className={`h-9 grow rounded-chip border-0 bg-transparent text-caption font-semibold ${seg(draft.position === p)}`}>
                      {p === 'before' ? `Before · ${draft.symbol} 100` : `After · 100 ${draft.symbol}`}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col gap-1 text-caption font-semibold">
                  Decimals
                  <select value={draft.decimals} onChange={(e) => setDraft({ ...draft, decimals: Number(e.target.value) as 0 | 2 })} className="h-11 rounded-control border border-control-line bg-surface px-2 text-body font-normal">
                    <option value={0}>0</option>
                    <option value={2}>2</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-caption font-semibold">
                  Separator
                  <select value={draft.separator} onChange={(e) => setDraft({ ...draft, separator: e.target.value as Draft['separator'] })} className="h-11 rounded-control border border-control-line bg-surface px-2 text-body font-normal">
                    <option value=",">Comma 1,000</option>
                    <option value=" ">Space 1 000</option>
                    <option value=".">Dot 1.000</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-caption font-semibold">
                  Cash rounding
                  <select value={draft.rounding} onChange={(e) => setDraft({ ...draft, rounding: Number(e.target.value) as Draft['rounding'] })} className="h-11 rounded-control border border-control-line bg-surface px-2 text-body font-normal">
                    {[0, 10, 50, 100, 500].map((n) => (
                      <option key={n} value={n}>
                        {ROUNDING_LABEL(n)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <span className="text-caption text-muted">Cash rounding applies only to cash-on-delivery totals, so riders don’t need small change.</span>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-body">Preview</h3>
              <div className="flex flex-col gap-2 rounded-card bg-ground p-3.5 text-body">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-control bg-status-neutral font-bold">C</span>
                  <div className="flex grow flex-col">
                    <span>Chicken burger</span>
                    <span className="font-bold tabular-nums">{pv.price}</span>
                  </div>
                </div>
                {[['Subtotal', pv.sub], ['Delivery', pv.del], ['Total', pv.total], ['Cash due', pv.cash]].map(([k, v]) => (
                  <div key={k} className={`flex justify-between border-t border-line-subtle pt-1.5 ${k === 'Total' || k === 'Cash due' ? 'font-bold' : 'text-ink-2'}`}>
                    <span>{k}</span>
                    <span className="tabular-nums">{v}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="flex flex-col gap-2.5">
              <h3 className="m-0 text-body">Conversion for display</h3>
              <div role="radiogroup" aria-label="Rate source" className="flex rounded-control bg-status-neutral p-[3px]">
                {([['feed', 'Rate feed'], ['manual', 'Set manually']] as const).map(([id, label]) => (
                  <button key={id} type="button" role="radio" aria-checked={draft.rateSource === id} onClick={() => setDraft({ ...draft, rateSource: id })} className={`h-9 grow rounded-chip border-0 bg-transparent text-caption font-semibold ${seg(draft.rateSource === id)}`}>
                    {label}
                  </button>
                ))}
              </div>
              {draft.rateSource === 'manual' && cur.code !== 'USD' ? (
                <label className="flex flex-col gap-1 text-caption font-semibold">
                  1 USD equals
                  <span className="flex h-11 items-center overflow-hidden rounded-control border border-control-line bg-surface">
                    <input inputMode="decimal" value={draft.rate} placeholder="e.g. 1,450" onChange={(e) => setDraft({ ...draft, rate: e.target.value })} className="min-w-0 grow border-0 bg-transparent px-3 text-body font-normal outline-none" />
                    <span className="bg-ground px-3 py-3 text-muted">{cur.code}</span>
                  </span>
                </label>
              ) : null}
              <div className={`rounded-control p-2.5 text-caption ${NOTE_TONE[note.tone]}`}>{note.text}</div>
            </section>

            {cur.lockedReason === null ? null : <span className="text-caption text-muted">Can’t be switched off: {cur.lockedReason}</span>}
            <Button tone="brand" disabled={!dirty} busy={busy === 'save'} busyLabel="Saving…" onClick={save}>
              Save {cur.code}
            </Button>
          </>
        )}
      </aside>

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
