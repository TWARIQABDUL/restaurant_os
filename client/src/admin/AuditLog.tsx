// client/src/admin/AuditLog.tsx — milestone 27 part C, from project/AdminAudit.dc.html.
//
// "ENTRIES CAN'T BE EDITED OR DELETED, INCLUDING BY SUPER ADMINS" is true (V011's trigger, and a hash chain behind it), so the screen
// can prove it instead of asserting it: "Verify the log" asks the database to walk the chain and reports what it found. It is a button
// and not a banner because the walk reads the whole log, and a page that did that on every load would get slower every day.
//
// "EXPORT CSV" IS NOT BUILT. The log names people, stores and IP addresses; exporting it is a bulk disclosure that should itself be an
// audit entry with a reason, which is a design the board does not draw.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button } from '../shared/ui/index.ts';
import { adminOpsApi } from './adminApi.ts';
import type { AuditCategory, AuditRow } from './adminApi.ts';
import { AUDIT_FILTERS, AUDIT_TYPE, stampText } from './adminLines.ts';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

type Props = { initial?: { rows: AuditRow[]; hasMore: boolean }; initialOpen?: number; initialVerified?: { ok: boolean; entries: number; breaks: number } };

export function AuditLog({ initial, initialOpen, initialVerified }: Props): ReactNode {
  const [filter, setFilter] = useState<AuditCategory | 'all'>('all');
  const [rows, setRows] = useState<AuditRow[] | null>(initial?.rows ?? null);
  const [hasMore, setHasMore] = useState(initial?.hasMore ?? false);
  const [open, setOpen] = useState<number | null>(initialOpen ?? null);
  const [verified, setVerified] = useState<{ ok: boolean; entries: number; breaks: number } | null>(initialVerified ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef(initial !== undefined);

  const load = useCallback(async (f: AuditCategory | 'all'): Promise<void> => {
    try {
      const r = await adminOpsApi.audit(f === 'all' ? null : f, null);
      setRows(r.rows);
      setHasMore(r.hasMore);
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'The audit log could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    void load(filter);
  }, [load, filter]);

  const more = async (): Promise<void> => {
    if (rows === null || rows.length === 0) return;
    setBusy('more');
    try {
      const r = await adminOpsApi.audit(filter === 'all' ? null : filter, rows[rows.length - 1]!.sequence);
      setRows([...rows, ...r.rows]);
      setHasMore(r.hasMore);
    } catch (cause) {
      setError(reason(cause, 'More entries could not be loaded.'));
    } finally {
      setBusy(null);
    }
  };

  const verify = async (): Promise<void> => {
    setBusy('verify');
    try {
      setVerified(await adminOpsApi.verifyAudit());
    } catch (cause) {
      setError(reason(cause, 'The log could not be checked.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 grow">
          <h1 className="m-0 font-display text-[28px]">Audit log</h1>
          <span className="text-caption text-muted">Every admin action and every sensitive view. Entries can’t be edited or deleted, including by super admins.</span>
        </div>
        <Button variant="secondary" busy={busy === 'verify'} busyLabel="Checking…" onClick={() => void verify()}>
          Verify the log
        </Button>
      </header>

      {verified === null ? null : verified.ok ? (
        <Alert tone="success" headline={`The log is intact — ${verified.entries.toLocaleString('en-US')} entries, each one hashed into the next.`} />
      ) : (
        <Alert tone="danger" headline={`The log has been tampered with: ${verified.breaks} broken ${verified.breaks === 1 ? 'link' : 'links'} in ${verified.entries.toLocaleString('en-US')} entries.`} />
      )}

      <div className="flex flex-wrap gap-1.5">
        {AUDIT_FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} className={`h-9 rounded-pill px-3.5 text-caption font-bold ${filter === f.id ? 'border border-ink bg-ink text-white' : 'border border-control-line bg-surface text-ink'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {error === null ? null : <Alert tone="danger" headline={error} />}

      <section className="overflow-hidden rounded-card border border-line bg-surface">
        <div className="hidden grid-cols-[130px_190px_150px_minmax(0,1fr)_160px] gap-3 bg-ground px-4 py-2.5 text-[12px] font-semibold text-muted lg:grid">
          <span>When</span>
          <span>Who</span>
          <span>Type</span>
          <span>What</span>
          <span>Store</span>
        </div>
        {rows === null ? <div className="p-10 text-center text-muted">Loading…</div> : null}
        {rows !== null && rows.length === 0 ? <div className="p-10 text-center text-muted">Nothing recorded for this view.</div> : null}
        {rows?.map((r) => {
          const t = AUDIT_TYPE[r.category];
          const isOpen = open === r.sequence;
          return (
            <div key={r.sequence} className="border-t border-line-subtle first:border-t-0">
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.sequence)} className="grid w-full grid-cols-1 items-center gap-1 border-0 bg-surface px-4 py-3 text-left lg:grid-cols-[130px_190px_150px_minmax(0,1fr)_160px] lg:gap-3">
                <span className="font-mono text-[12px] text-muted" title={new Date(r.at).toLocaleString('en-GB')}>
                  {stampText(r.at)}
                </span>
                <span className="font-semibold">{r.who}</span>
                <span className={`justify-self-start rounded-pill px-2 py-0.5 text-[12px] font-bold ${t.tone}`}>{t.label}</span>
                <span>{r.what}</span>
                <span className="text-ink-2">{r.store ?? '—'}</span>
              </button>
              {isOpen ? (
                <div className="mx-4 mb-3 rounded-control bg-ground p-3 font-mono text-[12px] text-ink-2">
                  {r.detail.length === 0 ? <span>No further detail.</span> : r.detail.map((d, i) => <div key={i}>{d}</div>)}
                  <div className="mt-1.5 text-muted">Entry #{r.sequence}{r.role === null ? '' : ` · ${r.role}`}</div>
                </div>
              ) : null}
            </div>
          );
        })}
        {hasMore ? (
          <div className="border-t border-line-subtle p-3 text-center">
            <Button variant="text" tone="brand" busy={busy === 'more'} busyLabel="Loading…" onClick={() => void more()}>
              Older entries
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
