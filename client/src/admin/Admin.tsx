// client/src/admin/Admin.tsx — milestone 27, the frame from project/AdminSidebar.dc.html.
//
// THE VENDLYFY TEAM'S CONSOLE. A different app from the merchant console in everything but the kit: its own session check
// (GET /api/admin/me answers only for somebody on the platform team), its own navigation, and no store in the URL — a
// platform admin acts ON stores, they are not a member of any.
//
// THE SIDEBAR LINKS ONLY WHAT EXISTS. The board draws thirteen destinations; this milestone builds the first three. The rest
// are present, greyed, and say which screen they wait for — the same rule nav.ts applies to the merchant sidebar, so nobody
// clicks into a blank page.
//
// A 403 FROM /me IS NOT "SIGNED OUT". Somebody signed in as a store owner who types /admin sees why they cannot be here and a
// way back to their own console, rather than being bounced to a sign-in they have already done.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure, api } from '../app/api.ts';
import { Alert, Button, Spinner } from '../shared/ui/index.ts';
import { adminApi, adminMoneyApi } from './adminApi.ts';
import type { Me } from './adminApi.ts';
import { NAV, initial } from './adminLines.ts';

export type AdminView = 'overview' | 'merchants' | 'kyc' | 'payouts' | 'disputes' | 'currencies' | 'payments' | 'soon';

type AdminContextValue = {
  me: Me;
  navigate: (to: string) => void;
  badges: { merchants: number; kyc: number; disputes: number };
  refreshBadges: () => void;
};

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const v = useContext(AdminContext);
  if (v === null) throw new Error('useAdmin() outside Admin');
  return v;
}

type Props = {
  view: AdminView;
  /** The sidebar item to highlight; for `soon` it is the unbuilt destination's id. */
  active: string;
  navigate: (to: string) => void;
  children: (me: Me) => ReactNode;
  /** The render gate's seam: effects do not run in static markup. */
  initialMe?: Me;
  initialBadges?: { merchants: number; kyc: number; disputes?: number };
};

export function Admin({ active, navigate, children, initialMe, initialBadges }: Props): ReactNode {
  const [me, setMe] = useState<Me | null>(initialMe ?? null);
  const [state, setState] = useState<'loading' | 'ready' | 'refused' | 'failed'>(initialMe === undefined ? 'loading' : 'ready');
  const [badges, setBadges] = useState<{ merchants: number; kyc: number; disputes: number }>({ merchants: 0, kyc: 0, disputes: 0, ...initialBadges });

  const refreshBadges = useCallback((): void => {
    void Promise.all([adminApi.queue(), adminApi.merchants({ tab: 'pending', q: '', industry: '', plan: '' }), adminMoneyApi.disputes('refunds').catch(() => null)])
      .then(([q, m, d]) => setBadges({ kyc: q.queue.length, merchants: m.counts.pending, disputes: d === null ? 0 : d.counts.refunds + d.counts.disputes }))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (initialMe !== undefined) return;
    let live = true;
    void adminApi
      .me()
      .then((m) => {
        if (!live) return;
        setMe(m);
        setState('ready');
        refreshBadges();
      })
      .catch((cause: unknown) => {
        if (!live) return;
        if (cause instanceof ApiFailure && cause.status === 401) return navigate('/signin');
        setState(cause instanceof ApiFailure && cause.status === 403 ? 'refused' : 'failed');
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AdminContextValue | null>(() => (me === null ? null : { me, navigate, badges, refreshBadges }), [me, navigate, badges, refreshBadges]);

  if (state === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ground" aria-busy="true">
        <Spinner />
      </div>
    );
  }
  if (state === 'refused' || state === 'failed' || value === null || me === null) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-[440px] flex-col justify-center gap-4 bg-ground px-5 text-ink">
        <h1 className="m-0 font-display text-[28px] leading-tight">{state === 'refused' ? 'This is the Vendlyfy team’s console' : 'The console could not be opened'}</h1>
        <p className="m-0 text-ink-2">{state === 'refused' ? 'Your account isn’t on the team. If you run a store, your own console is where you want to be.' : 'Check your connection and try again.'}</p>
        <Button tone="brand" onClick={() => navigate(state === 'refused' ? '/signin' : '/admin')}>
          {state === 'refused' ? 'Go to sign in' : 'Try again'}
        </Button>
      </div>
    );
  }

  const signOut = (): void => {
    void api.delete('/api/session').catch(() => undefined).finally(() => window.location.assign('/signin'));
  };

  return (
    <AdminContext.Provider value={value}>
      <div className="flex min-h-dvh flex-col bg-ground text-ink lg:flex-row">
        <nav aria-label="Admin navigation" className="flex shrink-0 flex-col gap-1 bg-ink px-3 py-4 text-on-ink-muted lg:sticky lg:top-0 lg:h-dvh lg:w-[248px] lg:overflow-y-auto lg:py-5">
          <div className="flex items-center gap-2.5 px-2 pb-3">
            <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-chip bg-ground font-display text-[16px] font-bold text-ink">
              V
            </span>
            <span className="font-display text-[20px] font-bold text-white">Vendlyfy</span>
            <span className="ml-auto rounded-pill bg-on-ink-timer px-2 py-[3px] text-[11px] font-bold uppercase tracking-[0.06em] text-ink">Admin</span>
          </div>
          <div className="mx-1 mb-2 flex items-center gap-2 rounded-control bg-ink-raised px-2.5 py-2 text-[12px]">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-pill bg-brand-muted" />
            Production · Rwanda
          </div>
          <div className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {NAV.map((group) => (
              <div key={group.label} className="flex shrink-0 gap-1 border-ink-raised py-1 lg:flex-col lg:border-t lg:py-2">
                <span className="px-3 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-disabled max-lg:hidden">{group.label}</span>
                {group.items.map((item) => {
                  const current = item.id === active;
                  const badge = item.badge === undefined ? 0 : badges[item.badge];
                  const row = `flex h-10 shrink-0 items-center gap-3 rounded-control px-3 text-[14px] font-semibold no-underline ${current ? 'bg-ink-raised text-white' : item.built ? 'text-on-ink-muted' : 'text-disabled'}`;
                  const inner = (
                    <>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d={item.icon} />
                      </svg>
                      <span className="grow whitespace-nowrap">{item.label}</span>
                      {badge > 0 ? <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-pill bg-on-ink-timer px-1.5 text-[12px] font-bold text-ink">{badge}</span> : null}
                    </>
                  );
                  return item.built ? (
                    <a key={item.id} href={item.path} aria-current={current ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(item.path); }} className={row}>
                      {inner}
                    </a>
                  ) : (
                    <span key={item.id} aria-disabled="true" title="Not built yet" className={row}>
                      {inner}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-auto flex items-center gap-2.5 border-t border-ink-raised px-2 pt-3 max-lg:hidden">
            <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-pill bg-ink-raised text-[13px] font-bold text-white">
              {initial(me.name)}
            </span>
            <span className="flex min-w-0 grow flex-col">
              <span className="truncate text-[14px] font-semibold text-white">{me.name}</span>
              <span className="text-[12px]">{me.role === 'super_admin' ? 'Super admin' : (me.role ?? 'Team')}</span>
            </span>
            <button type="button" onClick={signOut} className="rounded-control px-2 py-1 text-[12px] font-semibold text-on-ink-muted">
              Sign out
            </button>
          </div>
        </nav>
        <main className="min-w-0 grow px-4 py-6 lg:px-9 lg:py-7">{children(me)}</main>
      </div>
    </AdminContext.Provider>
  );
}

export function SoonPage({ label }: { label: string }): ReactNode {
  return (
    <div className="flex max-w-[560px] flex-col gap-3">
      <h1 className="m-0 font-display text-[28px]">{label}</h1>
      <Alert tone="info" headline="This screen isn’t built yet.">
        <span>It’s drawn, and it’s next in the admin console’s build. Everything in the sidebar that isn’t greyed out works.</span>
      </Alert>
    </div>
  );
}
