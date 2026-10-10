// client/src/console/ExportOrders.tsx — milestone 28, from project/PrintExports.dc.html ("Export orders").
//
// THE BOARD'S THREE STEPS ARE TWO HERE. It draws Setup → "Preparing 540 rows…" with a progress bar → Ready, with "We'll email it to you
// if it takes more than a minute". The file is built in one request (repositories/orderExport.ts caps it where that stays true), so
// there is no progress to show and no email to send: pressing Export starts the download, and the dialog says what it just did.
//
// "ABOUT 540 ROWS" IS A REAL NUMBER from the server's count endpoint, refreshed when the period changes, so the estimate is a fact and
// the warning for a period too big for one file appears BEFORE a click, not after a failed download.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure, api } from '../app/api.ts';
import { Alert, Button } from '../shared/ui/index.ts';
import { useDialog } from '../shared/ui/index.ts';

export const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Last 7 days' },
  { id: 'month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
] as const;
export type PeriodId = (typeof PERIODS)[number]['id'];

export const COLUMNS = [
  { id: 'items', label: 'Items and options' },
  { id: 'customer', label: 'Customer name' },
  { id: 'phone', label: 'Customer phone' },
  { id: 'payment', label: 'Payment method and status' },
  { id: 'rider', label: 'Rider and delivery times' },
] as const;
export type ColumnId = (typeof COLUMNS)[number]['id'];

export const MAX_ROWS = 20_000;

export function exportUrl(storeId: string, range: PeriodId, cols: readonly ColumnId[], count = false): string {
  const q = new URLSearchParams({ range, cols: cols.join(',') });
  if (count) q.set('count', '1');
  return `/api/stores/${storeId}/exports/orders?${q.toString()}`;
}

export function estimate(rows: number | null): string {
  if (rows === null) return 'Counting…';
  if (rows > MAX_ROWS) return `${rows.toLocaleString('en-US')} orders is more than one file holds. Choose a shorter period.`;
  return `${rows === 0 ? 'No orders' : `About ${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}`}. Opens in Excel or Google Sheets.`;
}

type Props = { storeId: string; open: boolean; onClose: () => void; initialRows?: number; initialCols?: ColumnId[]; initialDone?: boolean };

export function ExportOrders({ storeId, open, onClose, initialRows, initialCols, initialDone }: Props): ReactNode {
  const ref = useDialog(open);
  const [range, setRange] = useState<PeriodId>('week');
  const [cols, setCols] = useState<ColumnId[]>(initialCols ?? ['items', 'customer', 'payment']);
  const [rows, setRows] = useState<number | null>(initialRows ?? null);
  const [done, setDone] = useState(initialDone ?? false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || initialRows !== undefined) return;
    let live = true;
    setRows(null);
    void api.get<{ rows: number }>(exportUrl(storeId, range, cols, true)).then((r) => live && setRows(r.rows)).catch((c: unknown) => live && setError(c instanceof ApiFailure ? c.message : 'The size of that file could not be worked out.'));
    return () => {
      live = false;
    };
    // The count depends on the period only; the columns change the file's width, not its length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, range, storeId]);

  const withPhone = cols.includes('phone');
  const tooBig = rows !== null && rows > MAX_ROWS;

  return (
    <dialog
      ref={ref}
      aria-label="Export orders"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      className="m-auto w-[min(440px,calc(100vw-32px))] rounded-card bg-surface p-5 text-ink backdrop:bg-ink/40"
    >
      <div className="flex flex-col gap-3.5">
        <strong className="text-title">Export orders</strong>
        {error === null ? null : <Alert tone="danger" headline={error} />}
        {done ? (
          <>
            <div className="rounded-control bg-status-success p-3 text-body text-status-success-fg">Your download has started. Look in your downloads for the file.</div>
            {withPhone ? <span className="text-caption text-muted">Phone numbers are included, so this file is personal data. It’s logged who downloaded it.</span> : null}
            <div className="flex justify-end gap-2">
              <Button variant="text" tone="brand" onClick={() => setDone(false)}>
                Export something else
              </Button>
              <Button tone="brand" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 text-caption font-semibold">
              Period
              <div role="radiogroup" aria-label="Period" className="flex rounded-control bg-status-neutral p-[3px]">
                {PERIODS.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={range === p.id} onClick={() => setRange(p.id)} className={`h-10 grow rounded-chip border-0 bg-transparent text-caption font-semibold ${range === p.id ? 'bg-surface [box-shadow:0_1px_2px_rgb(23_22_15/.12)]' : 'text-ink-2'}`}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-caption font-semibold">Include</span>
              {COLUMNS.map((c) => {
                const on = cols.includes(c.id);
                return (
                  <button key={c.id} type="button" role="checkbox" aria-checked={on} onClick={() => setCols(on ? cols.filter((x) => x !== c.id) : [...cols, c.id])} className="flex min-h-11 items-center gap-2.5 rounded-control border-0 bg-transparent px-1 text-left text-body">
                    <span aria-hidden="true" className={`flex size-5 items-center justify-center rounded-chip text-[12px] font-extrabold ${on ? 'bg-brand text-white' : 'border-[1.5px] border-control-line'}`}>
                      {on ? '✓' : ''}
                    </span>
                    {c.label}
                  </button>
                );
              })}
            </div>
            <span className={`text-caption ${tooBig ? 'font-semibold text-status-danger-fg' : 'text-muted'}`}>{estimate(rows)}</span>
            {withPhone ? <span className="text-caption text-muted">Phone numbers are personal data. Downloading this file is logged.</span> : null}
            <div className="flex justify-end gap-2">
              <Button variant="text" tone="brand" onClick={onClose}>
                Cancel
              </Button>
              <Button
                tone="brand"
                disabled={tooBig || rows === null}
                onClick={() => {
                  window.location.assign(exportUrl(storeId, range, cols));
                  setDone(true);
                }}
              >
                Export CSV
              </Button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
