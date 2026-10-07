// client/src/admin/Merchants.tsx — milestone 27, from project/AdminMerchants.dc.html.
//
// THE BOARD'S "APPROVE AND GO LIVE" IS "REVIEW IDENTITY" HERE, and the reason is in repositories/admin.ts: a store is live the
// moment it is created (Onboarding says so), so what a platform admin approves is WHO owns it — the decision that unlocks
// payouts. The buttons that need the ID photos ("Approve", "Request new documents", "Reject") live in Identity checks, where
// the photos are; this panel hands over to it with the case already open. Suspending and reinstating are done here.
//
// "VIEW AS MERCHANT" IS NOT BUILT. The board promises "Read-only. The session is logged and the owner is notified." — an
// impersonation session with its own audit and notification. Nothing like it exists, and a link that only opened the merchant's
// page under the admin's own (refused) permissions would be worse than none. "Open store" is the storefront.
//
// THE LIST IS A SEARCH, NOT AN EXPORT: the board's "Export CSV" is not built either, for the reason Customers' is (a CSV of
// every merchant's owner and phone is a bulk disclosure that deserves its own audit entry and its own decision).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, TextField, Toast } from '../shared/ui/index.ts';
import { adminApi } from './adminApi.ts';
import type { MerchantDetail, MerchantList, MerchantTab } from './adminApi.ts';
import { IDENTITY_LABEL, SUSPEND_REASONS, TAB_LABEL, compactMoney, initial, joinedText, rowBadge } from './adminLines.ts';
import { useAdmin } from './Admin.tsx';

const DOT: Record<'ok' | 'warn' | 'wait', { mark: string; tone: string; note: string }> = {
  ok: { mark: '✓', tone: 'bg-status-success text-status-success-fg', note: 'text-muted' },
  warn: { mark: '!', tone: 'bg-status-warn text-status-warn-fg', note: 'font-semibold text-status-warn-fg' },
  wait: { mark: '…', tone: 'bg-status-neutral text-muted', note: 'text-muted' },
};

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

type Props = {
  initialList?: MerchantList;
  initialDetail?: MerchantDetail;
  initialTab?: MerchantTab;
  initialConfirm?: 'suspend';
  initialQuery?: string;
};

export function Merchants({ initialList, initialDetail, initialTab, initialConfirm, initialQuery }: Props): ReactNode {
  const { navigate, refreshBadges } = useAdmin();
  const [tab, setTab] = useState<MerchantTab>(initialTab ?? 'pending');
  const [q, setQ] = useState(initialQuery ?? (typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('q') ?? '')));
  const [industry, setIndustry] = useState('');
  const [plan, setPlan] = useState('');
  const [list, setList] = useState<MerchantList | null>(initialList ?? null);
  const [selected, setSelected] = useState<string | null>(initialDetail?.id ?? null);
  const [detail, setDetail] = useState<MerchantDetail | null>(initialDetail ?? null);
  const [confirm, setConfirm] = useState<'suspend' | null>(initialConfirm ?? null);
  const [why, setWhy] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initialList !== undefined);

  const flash = (m: string): void => {
    setToast(m);
    window.setTimeout(() => setToast((c) => (c === m ? null : c)), 3000);
  };

  const loadList = useCallback(async (): Promise<void> => {
    try {
      const r = await adminApi.merchants({ tab, q, industry, plan });
      setList(r);
      setError(null);
      setSelected((cur) => (cur !== null && r.rows.some((x) => x.id === cur) ? cur : (r.rows[0]?.id ?? null)));
    } catch (cause) {
      setError(reason(cause, 'Merchants could not be loaded.'));
    }
  }, [tab, q, industry, plan]);

  // Typing is not a request per letter.
  useEffect(() => {
    if (seeded.current) return;
    const id = window.setTimeout(() => void loadList(), q === '' ? 0 : 300);
    return () => window.clearTimeout(id);
  }, [loadList, q]);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    if (selected === null) return setDetail(null);
    let live = true;
    setConfirm(null);
    void adminApi.merchant(selected).then((d) => live && setDetail(d)).catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [selected]);

  const suspend = async (): Promise<void> => {
    if (detail === null || why === '') return;
    setBusy(true);
    try {
      setDetail(await adminApi.suspend(detail.id, why, note));
      flash(`${detail.name} suspended · logged to the audit log`);
      setConfirm(null);
      setWhy('');
      setNote('');
      void loadList();
      refreshBadges();
    } catch (cause) {
      setError(reason(cause, 'That store could not be suspended.'));
    } finally {
      setBusy(false);
    }
  };

  const reinstate = async (): Promise<void> => {
    if (detail === null) return;
    setBusy(true);
    try {
      setDetail(await adminApi.reinstate(detail.id));
      flash(`${detail.name} reinstated`);
      void loadList();
    } catch (cause) {
      setError(reason(cause, 'That store could not be reinstated.'));
    } finally {
      setBusy(false);
    }
  };

  const counts = list?.counts ?? { pending: 0, active: 0, suspended: 0 };

  return (
    <div className="flex flex-col gap-4 xl:flex-row xl:gap-0">
      <div className="flex min-w-0 grow flex-col gap-3.5 xl:pr-7">
        <header>
          <h1 className="m-0 font-display text-[28px]">Merchants</h1>
          <p className="m-0 mt-0.5 text-body text-muted">Verify new owners, support existing stores, act on problems.</p>
        </header>

        <div role="tablist" className="flex gap-1 border-b border-line">
          {(['pending', 'active', 'suspended'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setSelected(null); }} className={`flex h-11 items-center gap-2 border-b-2 px-3.5 text-body font-bold ${tab === t ? 'border-ink text-ink' : 'border-transparent text-muted'}`}>
              {TAB_LABEL[t]}
              <span className="rounded-pill bg-status-neutral px-2 py-px text-[12px] font-bold text-status-neutral-fg tabular-nums">{counts[t].toLocaleString('en-US')}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2.5">
          <label className="flex h-11 min-w-[220px] grow items-center gap-2 rounded-control border border-control-line bg-surface px-3">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="text-muted">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4-4" />
            </svg>
            <input aria-label="Search merchants" placeholder="Store name, owner or phone" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 grow border-0 bg-transparent text-body outline-none" />
          </label>
          <select aria-label="Industry" value={industry} onChange={(e) => setIndustry(e.target.value)} className="h-11 rounded-control border border-control-line bg-surface px-2.5 text-body">
            <option value="">All industries</option>
            {(list?.filters.industries ?? []).map((i) => (
              <option key={i.key} value={i.key}>
                {i.name}
              </option>
            ))}
          </select>
          <select aria-label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)} className="h-11 rounded-control border border-control-line bg-surface px-2.5 text-body">
            <option value="">All plans</option>
            {(list?.filters.plans ?? []).map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {error === null ? null : <Alert tone="danger" headline={error} />}

        <section className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1fr)_110px_110px] gap-3 bg-ground px-4 py-2.5 text-[12px] font-semibold text-muted md:grid">
            <span>Store</span>
            <span>Owner</span>
            <span>Industry</span>
            <span>Sales · 30d</span>
            <span>Status</span>
          </div>
          {list === null ? (
            <div className="p-10 text-center text-muted" aria-busy="true">
              Loading…
            </div>
          ) : list.rows.length === 0 ? (
            <div className="flex flex-col items-center gap-1 p-12 text-center text-muted">
              <strong className="text-ink">Nothing here</strong>
              No merchants match this view.
            </div>
          ) : (
            list.rows.map((m) => {
              const b = rowBadge(m);
              return (
                <button key={m.id} type="button" aria-pressed={m.id === selected} onClick={() => setSelected(m.id)} className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-0 border-t border-line-subtle px-4 py-3 text-left md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1fr)_110px_110px] ${m.id === selected ? 'bg-brand-wash [box-shadow:inset_3px_0_0_var(--color-brand)]' : 'bg-surface'}`}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-control bg-status-neutral font-bold text-ink-2">
                      {initial(m.name)}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-semibold">{m.name}</span>
                      <span className="truncate text-[12px] text-muted">/{m.slug}</span>
                    </span>
                  </span>
                  <span className="hidden min-w-0 flex-col md:flex">
                    <span className="truncate">{m.owner?.name ?? '—'}</span>
                    <span className="truncate text-[12px] text-muted">{m.owner?.phone ?? ''}</span>
                  </span>
                  <span className="hidden truncate md:block">{m.industry ?? 'Other'}</span>
                  <span className="hidden font-semibold tabular-nums md:block">{m.sales30 === 0 ? '—' : compactMoney(m.sales30)}</span>
                  <span className={`justify-self-start rounded-pill px-2 py-[3px] text-[12px] font-bold ${b.tone}`}>{b.label}</span>
                </button>
              );
            })
          )}
        </section>
      </div>

      <aside aria-label="Merchant detail" className="shrink-0 rounded-card border border-line bg-surface p-5 xl:w-[360px] xl:self-start xl:rounded-none xl:border-y-0 xl:border-r-0 xl:border-l xl:bg-transparent xl:pl-6">
        {detail === null ? (
          <p className="m-0 py-10 text-center text-muted">Select a merchant to see details.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-control bg-status-neutral text-[18px] font-bold text-ink-2">
                {initial(detail.name)}
              </span>
              <div className="min-w-0 grow">
                <h2 className="m-0 truncate text-[20px]">{detail.name}</h2>
                <span className="text-caption text-muted">
                  /{detail.slug} · joined {joinedText(detail.createdAt)}
                </span>
              </div>
              <span className={`rounded-pill px-2 py-[3px] text-[12px] font-bold ${rowBadge(detail).tone}`}>{rowBadge(detail).label}</span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                ['Sales · 30d', detail.sales30 === 0 ? '—' : compactMoney(detail.sales30)],
                ['Orders', detail.orders.toLocaleString('en-US')],
                ['Disputes', detail.openDisputes === 0 ? '0' : `${detail.openDisputes} open`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-control bg-ground p-2.5">
                  <div className="text-[12px] text-muted">{k}</div>
                  <div className="font-display text-[18px] font-bold tabular-nums">{v}</div>
                </div>
              ))}
            </div>

            <section>
              <h3 className="m-0 mb-1.5 text-body">Verification</h3>
              {detail.checks.map((c) => (
                <div key={c.key} className="flex items-center gap-2.5 border-t border-line-subtle py-2 text-body">
                  <span aria-hidden="true" className={`flex size-[22px] shrink-0 items-center justify-center rounded-pill text-[12px] font-extrabold ${DOT[c.state].tone}`}>
                    {DOT[c.state].mark}
                  </span>
                  <span className="grow">{c.label}</span>
                  <span className={`text-caption ${DOT[c.state].note}`}>{c.note}</span>
                </div>
              ))}
            </section>

            <section>
              <h3 className="m-0 mb-1.5 text-body">Owner &amp; plan</h3>
              <dl className="m-0 grid grid-cols-[84px_minmax(0,1fr)] gap-y-1.5 text-body">
                <dt className="text-muted">Owner</dt>
                <dd className="m-0">{detail.owner === null ? '—' : `${detail.owner.name}${detail.owner.phone === null ? '' : ` · ${detail.owner.phone}`}`}</dd>
                <dt className="text-muted">Industry</dt>
                <dd className="m-0">{detail.industry === null ? 'None chosen' : `${detail.industry} template`}</dd>
                <dt className="text-muted">Plan</dt>
                <dd className="m-0">{detail.plan ?? '—'}</dd>
                <dt className="text-muted">Payouts</dt>
                <dd className="m-0">{detail.payout}</dd>
              </dl>
            </section>

            {confirm === 'suspend' ? (
              <section className="flex flex-col gap-2.5 rounded-card border border-status-danger-fg bg-status-danger p-3.5 text-status-danger-fg">
                <strong>Suspend {detail.name}?</strong>
                <span className="text-caption">The storefront goes offline immediately and payouts are held until you reinstate it. Open orders are not cancelled — handle those from the store’s own side.</span>
                <label className="flex flex-col gap-1 text-caption font-semibold text-ink">
                  Reason
                  <select value={why} onChange={(e) => setWhy(e.target.value)} className="h-11 rounded-control border border-control-line bg-surface px-2.5 text-body font-normal">
                    <option value="">Choose a reason</option>
                    {SUSPEND_REASONS.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <TextField label="Internal note" hint="Visible to admins only." value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => { setConfirm(null); setWhy(''); }}>
                    Keep as is
                  </Button>
                  <Button busy={busy} busyLabel="Suspending…" disabled={why === ''} onClick={() => void suspend()}>
                    Suspend store
                  </Button>
                </div>
              </section>
            ) : detail.status === 'suspended' ? (
              <div className="flex flex-col gap-2.5">
                <div className="rounded-control bg-status-danger p-3 text-body text-status-danger-fg">
                  <strong>Suspended:</strong> {detail.suspension?.reason ?? 'policy review'}
                  {detail.suspension === null ? null : <span className="block text-caption">by {detail.suspension.by}</span>}
                  <span className="mt-1 block text-caption">The storefront shows “temporarily unavailable” and payouts are held.</span>
                </div>
                <Button variant="secondary" busy={busy} busyLabel="Reinstating…" onClick={() => void reinstate()}>
                  Reinstate store
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {detail.identityCaseId !== null ? (
                  <Button tone="brand" block onClick={() => navigate(`/admin/kyc?case=${detail.identityCaseId}`)}>
                    Review identity
                  </Button>
                ) : (
                  <span className="text-caption text-muted">Identity: {IDENTITY_LABEL[detail.identity]}.</span>
                )}
                <a href={`/${detail.slug}`} target="_blank" rel="noreferrer" className="flex h-11 items-center justify-center rounded-control border border-control-line font-semibold text-ink no-underline">
                  Open store
                </a>
                <Button variant="text" block onClick={() => setConfirm('suspend')}>
                  Suspend store
                </Button>
              </div>
            )}
          </div>
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

