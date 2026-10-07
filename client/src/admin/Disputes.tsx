// client/src/admin/Disputes.tsx — milestone 27 part B, from project/AdminDisputes.dc.html.
//
// THE DECISION IS THE DATABASE'S, THE SCREEN'S JOB IS TO MAKE IT INFORMED. Before pressing a button the reviewer sees the thing the
// board puts beside the thread — the store's wallet — and the sentence for what pressing it will do: pay now, or approve and wait
// until the balance covers it (which also pauses the store's payouts). After pressing, what the screen says is what the server says
// happened, not what the screen hoped.
//
// A REFUND ON AN ORDER NOBODY PAID FOR IS REFUSED BY THE DATABASE (orders_refund_needs_payment), and the server hands this screen the
// sentence for why instead of a constraint name — a cash order whose cash was never confirmed has no money in any wallet to give
// back. Approve is then disabled with that sentence beside it; Reject is still available.
//
// "REOPEN" ON A CLOSED ITEM IS NOT BUILT. A complaint can be reopened by the customer or the store (V008) and that is where it
// belongs; a platform decision is final to the platform until one of them brings new information.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, Toast } from '../shared/ui/index.ts';
import { adminMoneyApi } from './adminApi.ts';
import type { DisputeDetail, DisputeItem, DisputeKind, DisputeTab } from './adminApi.ts';
import { DISPUTE_TAB_LABEL, MESSAGE_TONE, ageText, decideLabel, decisionNote, disputeBadge, rwf, walletVerdict } from './adminLines.ts';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

type Props = { initialTab?: DisputeTab; initialQueue?: { items: DisputeItem[]; counts: Record<DisputeTab, number> }; initialDetail?: DisputeDetail; initialChoice?: 'approve' | 'reject'; initialAmount?: string };

export function Disputes({ initialTab, initialQueue, initialDetail, initialChoice, initialAmount }: Props): ReactNode {
  const [tab, setTab] = useState<DisputeTab>(initialTab ?? 'refunds');
  const [queue, setQueue] = useState(initialQueue ?? null);
  const [sel, setSel] = useState<{ kind: DisputeKind; id: string } | null>(initialDetail === undefined ? null : { kind: initialDetail.kind, id: initialDetail.id });
  const [detail, setDetail] = useState<DisputeDetail | null>(initialDetail ?? null);
  const [choice, setChoice] = useState<'approve' | 'reject'>(initialChoice ?? 'approve');
  const [amount, setAmount] = useState(initialAmount ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initialQueue !== undefined);

  const flash = (m: string): void => {
    setToast(m);
    window.setTimeout(() => setToast((c) => (c === m ? null : c)), 3200);
  };

  const loadQueue = useCallback(async (t: DisputeTab): Promise<void> => {
    try {
      const q = await adminMoneyApi.disputes(t);
      setQueue(q);
      setError(null);
      setSel((cur) => (cur !== null && q.items.some((i) => i.id === cur.id) ? cur : (q.items[0] === undefined ? null : { kind: q.items[0].kind, id: q.items[0].id })));
    } catch (cause) {
      setError(reason(cause, 'The queue could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (seeded.current) return;
    void loadQueue(tab);
  }, [loadQueue, tab]);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    setNote('');
    setAmount('');
    setChoice('approve');
    if (sel === null) return setDetail(null);
    let live = true;
    void adminMoneyApi.dispute(sel.kind, sel.id).then((d) => live && setDetail(d)).catch((cause: unknown) => live && setError(reason(cause, 'That item could not be loaded.')));
    return () => {
      live = false;
    };
  }, [sel]);

  const total = detail === null ? 0 : Number(detail.maxRefund);
  const amountNum = detail === null ? 0 : amount === '' ? Number(detail.requested) : parseInt(amount.replace(/\D/g, ''), 10) || 0;
  const approving = choice === 'approve';
  const verdict = detail === null ? null : walletVerdict(detail.wallet.available, amountNum);
  const blocked = detail === null || note.trim() === '' || (approving && (amountNum <= 0 || amountNum > total || detail.refundBlocked !== null));

  const decide = async (): Promise<void> => {
    if (detail === null || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const done = await adminMoneyApi.decide(detail.kind, detail.id, { outcome: choice, note: note.trim(), ...(approving ? { amount: String(amountNum) } : {}) });
      setDetail(done);
      flash(approving ? (done.status === 'queued' ? 'Approved · refund queued until funds allow' : `Refunded ${rwf(amountNum)} · the store is told`) : 'Rejected · the store is told');
      setNote('');
      await loadQueue(tab);
    } catch (cause) {
      setError(reason(cause, 'That decision did not go through.'));
    } finally {
      setBusy(false);
    }
  };

  const seg = (on: boolean): string => (on ? 'bg-surface [box-shadow:0_1px_2px_rgb(23_22_15/.12)]' : 'text-ink-2');
  const counts = queue?.counts ?? { refunds: 0, disputes: 0, closed: 0 };

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:gap-7">
      <nav aria-label="Queue" className="flex shrink-0 flex-col gap-2 lg:w-[320px]">
        <h1 className="m-0 font-display text-[26px]">Refunds &amp; disputes</h1>
        <div role="tablist" className="flex rounded-control bg-status-neutral p-[3px]">
          {(['refunds', 'disputes', 'closed'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setSel(null); }} className={`h-9 grow rounded-chip border-0 bg-transparent text-caption font-bold ${seg(tab === t)}`}>
              {DISPUTE_TAB_LABEL[t]} ({counts[t]})
            </button>
          ))}
        </div>
        {queue === null ? <p className="m-0 text-muted">Loading…</p> : null}
        {queue?.items.map((q) => {
          const b = disputeBadge(q);
          const on = sel !== null && sel.id === q.id;
          return (
            <button key={`${q.kind}-${q.id}`} type="button" aria-pressed={on} onClick={() => setSel({ kind: q.kind, id: q.id })} className={`flex flex-col gap-1 rounded-card p-3 text-left ${on ? 'border border-line bg-surface [box-shadow:0_0_0_1px_var(--color-line)]' : 'border border-transparent bg-transparent'}`}>
              <span className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{q.title}</span>
                <span className="text-caption text-muted">{ageText(q.ageHours)}</span>
              </span>
              <span className="text-caption text-muted">
                {q.store} · <span className="font-mono">#{q.order}</span>
              </span>
              <span className={`self-start rounded-pill px-2 py-0.5 text-[12px] font-bold ${b.tone}`}>{b.label}</span>
            </button>
          );
        })}
        {queue !== null && queue.items.length === 0 ? <div className="rounded-card border border-line bg-surface p-6 text-center text-muted">All caught up.</div> : null}
      </nav>

      <div className="min-w-0 grow">
        {error === null ? null : <Alert tone="danger" headline={error} />}
        {detail === null ? null : (
          <div className="flex flex-col gap-4">
            <header>
              <div className="flex items-center gap-2.5">
                <h2 className="m-0 text-[22px]">{detail.title}</h2>
                <span className={`rounded-pill px-2 py-[3px] text-[12px] font-bold ${disputeBadge(detail).tone}`}>{disputeBadge(detail).label}</span>
              </div>
              <span className="text-caption text-muted">
                {detail.store.name} · order <span className="font-mono">#{detail.order.number}</span> · {detail.customer} · {detail.kind === 'refund' ? 'refund requested by the store' : 'complaint escalated by the store'}
              </span>
            </header>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
              <div className="flex flex-col gap-4">
                <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
                  <strong>{detail.kind === 'refund' ? 'Store’s request' : 'Complaint thread'}</strong>
                  {detail.thread.map((m, i) => (
                    <div key={`${m.at}-${i}`} className={`flex flex-col gap-0.5 rounded-control p-3 ${MESSAGE_TONE[m.side]}`}>
                      <span className="text-[12px] font-semibold text-muted">
                        {m.who} · <span className="font-mono">{new Date(m.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                      </span>
                      <span>{m.text}</span>
                    </div>
                  ))}
                  {detail.evidence.length === 0 ? null : (
                    <div className="flex flex-wrap gap-2">
                      {detail.evidence.map((e) => (
                        <span key={`${e.side}-${e.label}`} className="rounded-pill bg-status-neutral px-2.5 py-1 text-[12px] font-semibold text-status-neutral-fg">
                          {e.label}
                        </span>
                      ))}
                    </div>
                  )}
                </section>

                {detail.status === 'open' ? (
                  <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
                    <strong>Decision</strong>
                    <div role="radiogroup" aria-label="Decision" className="flex rounded-control bg-status-neutral p-[3px]">
                      {([['approve', detail.kind === 'dispute' ? 'Refund the customer' : 'Approve refund'], ['reject', detail.kind === 'dispute' ? 'Reject the escalation' : 'Reject request']] as const).map(([id, label]) => (
                        <button key={id} type="button" role="radio" aria-checked={choice === id} onClick={() => setChoice(id)} className={`h-10 grow rounded-chip border-0 bg-transparent text-body font-semibold ${seg(choice === id)}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {detail.refundBlocked !== null && approving ? <Alert tone="warn" headline="This can’t be refunded.">{detail.refundBlocked}</Alert> : null}
                    {approving ? (
                      <label className="flex flex-col gap-1 text-caption font-semibold">
                        Refund amount <span className="font-normal text-muted">(up to {rwf(total)})</span>
                        <span className="flex h-11 items-center overflow-hidden rounded-control border border-control-line bg-surface">
                          <input inputMode="numeric" value={amount === '' ? String(Math.round(Number(detail.requested))) : amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} className="min-w-0 grow border-0 bg-transparent px-3 text-body font-normal outline-none" />
                          <span className="bg-ground px-3 py-3 text-muted">RWF</span>
                        </span>
                      </label>
                    ) : null}
                    <textarea aria-label="Reason" rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={approving ? 'Reason, shared with the store' : 'Why? Shared with the store'} className="rounded-control border border-control-line bg-surface p-2.5 text-body" />
                    <span className="text-caption text-muted">{decisionNote(detail, approving, amountNum, total)}</span>
                    <div>
                      <Button tone={approving ? 'brand' : 'store'} variant={approving ? 'primary' : 'secondary'} busy={busy} busyLabel="Deciding…" disabled={blocked} onClick={() => void decide()}>
                        {decideLabel(detail, approving, verdict?.short ?? false, amountNum)}
                      </Button>
                    </div>
                  </section>
                ) : detail.closedNote === null ? null : (
                  <section className="rounded-card border border-line bg-surface p-4 text-body text-ink-2">{detail.closedNote}</section>
                )}
              </div>

              <div className="flex flex-col gap-4">
                <section className="flex flex-col gap-1.5 rounded-card border border-line bg-surface p-4">
                  <strong>Store wallet</strong>
                  <div className="flex justify-between">
                    <span>Available</span>
                    <strong className="tabular-nums">{rwf(detail.wallet.available)}</strong>
                  </div>
                  <div className="flex justify-between text-ink-2">
                    <span>Pending</span>
                    <span className="tabular-nums">{rwf(detail.wallet.pending)}</span>
                  </div>
                  {verdict === null || detail.status !== 'open' ? null : (
                    <div className={`rounded-control p-2.5 text-caption ${verdict.short && approving ? 'bg-status-warn text-status-warn-fg' : 'bg-status-success text-status-success-fg'}`}>{verdict.note}</div>
                  )}
                </section>
                <section className="flex flex-col gap-1.5 rounded-card border border-line bg-surface p-4">
                  <strong>Order #{detail.order.number}</strong>
                  {detail.order.items.map((i) => (
                    <div key={i.label} className="flex justify-between gap-2 text-body text-ink-2">
                      <span>{i.label}</span>
                      <span className="tabular-nums">{rwf(i.amount)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between border-t border-line-subtle pt-1.5 font-bold">
                    <span>Paid</span>
                    <span className="tabular-nums">{rwf(detail.order.total)}</span>
                  </div>
                  {Number(detail.order.refunded) > 0 ? <span className="text-caption text-muted">{rwf(detail.order.refunded)} already refunded.</span> : null}
                  <span className="text-caption text-muted">{detail.order.line}</span>
                </section>
                <section className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4">
                  <strong>Store history</strong>
                  <span className="text-body text-ink-2">{detail.history}</span>
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
