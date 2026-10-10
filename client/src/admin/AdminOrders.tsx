// client/src/admin/AdminOrders.tsx — milestone 27 part C, from project/AdminOrders.dc.html.
//
// READ-ONLY, AS THE BOARD SAYS: "Every store, read-only. Act through refunds, disputes or the store itself." There is no order endpoint
// on the admin side that writes, and none is drawn.
//
// "NEEDS ATTENTION" IS A SENTENCE COMPUTED FROM THE ORDER (repositories/adminOps.ts), shown beside the status: "No reply in 22 min",
// "Cash not confirmed", "In dispute". It is not a stored flag, so it cannot be stale — the moment the store replies, the flag is gone.
//
// "Export CSV" is not built, for the reason Audit log's is not: a file of every order with a customer's phone number is a bulk
// disclosure that should be its own decision.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button } from '../shared/ui/index.ts';
import { adminOpsApi } from './adminApi.ts';
import type { AdminOrder, OrderFilter } from './adminApi.ts';
import { ORDER_FILTERS, ORDER_STATUS, orderAge, paymentText, rwf } from './adminLines.ts';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

type Page = { rows: AdminOrder[]; hasMore: boolean; counts: { today: number; attention: number } };

export function AdminOrders({ initial, initialFilter }: { initial?: Page; initialFilter?: OrderFilter }): ReactNode {
  const [filter, setFilter] = useState<OrderFilter>(initialFilter ?? 'today');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seeded = useRef(initial !== undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      setPage(await adminOpsApi.orders({ filter, q, before: null }));
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'Orders could not be loaded.'));
    }
  }, [filter, q]);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    const id = window.setTimeout(() => void load(), q === '' ? 0 : 300);
    return () => window.clearTimeout(id);
  }, [load, q]);

  const more = async (): Promise<void> => {
    if (page === null || page.rows.length === 0) return;
    setBusy(true);
    try {
      const next = await adminOpsApi.orders({ filter, q, before: page.rows[page.rows.length - 1]!.cursor });
      setPage({ ...next, rows: [...page.rows, ...next.rows] });
    } catch (cause) {
      setError(reason(cause, 'More orders could not be loaded.'));
    } finally {
      setBusy(false);
    }
  };

  const counts = page?.counts ?? { today: 0, attention: 0 };

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 grow">
          <h1 className="m-0 font-display text-[28px]">All orders</h1>
          <span className="text-caption text-muted">Every store, read-only. Act through refunds, disputes or the store itself.</span>
        </div>
        <label className="flex h-11 w-[300px] max-w-full items-center gap-2 rounded-control border border-control-line bg-surface px-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="text-muted">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input aria-label="Search orders" placeholder="Order number, customer or store" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 grow border-0 bg-transparent text-body outline-none" />
        </label>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {ORDER_FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} className={`h-9 rounded-pill px-3.5 text-caption font-bold ${filter === f.id ? 'border border-ink bg-ink text-white' : 'border border-control-line bg-surface text-ink'}`}>
            {f.label(counts)}
          </button>
        ))}
      </div>

      {error === null ? null : <Alert tone="danger" headline={error} />}

      <section className="overflow-x-auto rounded-card border border-line bg-surface">
        <div className="hidden min-w-[860px] grid-cols-[90px_minmax(0,1.2fr)_minmax(0,1.1fr)_120px_140px_minmax(0,1.5fr)_70px] gap-3 bg-ground px-4 py-2.5 text-[12px] font-semibold text-muted md:grid">
          <span>Order</span>
          <span>Store</span>
          <span>Customer</span>
          <span>Total</span>
          <span>Payment</span>
          <span>Status</span>
          <span>Age</span>
        </div>
        {page === null ? <div className="p-12 text-center text-muted">Loading…</div> : null}
        {page !== null && page.rows.length === 0 ? <div className="p-12 text-center text-muted">No orders match. Try another filter or search.</div> : null}
        {page?.rows.map((o) => {
          const pay = paymentText(o);
          const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: 'bg-status-neutral text-status-neutral-fg' };
          return (
            <div key={o.id} className="grid min-w-[860px] grid-cols-[90px_minmax(0,1.2fr)_minmax(0,1.1fr)_120px_140px_minmax(0,1.5fr)_70px] items-center gap-3 border-t border-line-subtle px-4 py-3 text-body">
              <span className="font-mono text-[13px]">#{o.number}</span>
              <span className="truncate font-semibold">{o.store}</span>
              <span className="truncate">{o.customer}</span>
              <span className="font-semibold tabular-nums">{rwf(o.total)}</span>
              <span className={`justify-self-start rounded-pill px-2 py-0.5 text-[12px] font-bold ${pay.paid ? 'bg-status-success text-status-success-fg' : 'bg-status-warn text-status-warn-fg'}`}>{pay.text}</span>
              <span className="flex flex-wrap items-center gap-1.5">
                <span className={`rounded-pill px-2 py-0.5 text-[12px] font-bold ${st.tone}`}>{st.label}</span>
                {o.flag === null ? null : <span className="text-[12px] font-bold text-status-danger-fg">{o.flag}</span>}
              </span>
              <span className="text-caption text-muted">{orderAge(o.ageMinutes)}</span>
            </div>
          );
        })}
        {page?.hasMore ? (
          <div className="border-t border-line-subtle p-3 text-center">
            <Button variant="text" tone="brand" busy={busy} busyLabel="Loading…" onClick={() => void more()}>
              Older orders
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
