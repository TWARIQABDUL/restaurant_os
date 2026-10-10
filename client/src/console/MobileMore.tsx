// client/src/console/MobileMore.tsx — milestone 28, from project/MobileMore.dc.html.
//
// THE PHONE'S FIFTH TAB: everything the five-item bar had no room for, in the board's three groups (Work, Store, Account). Its rows are
// references into the desktop sidebar (nav.ts MORE_GROUPS) — so a label, a path and who may see it are written once — and a role that
// cannot reach a screen on the desktop does not find a way to it here: a row it may not open is not shown, rather than shown failing.
//
// THE STORE CARD ("Nyama & Co. · Switch") IS THE SIDEBAR'S SWITCHER, in the phone's idiom: a button only where there is something to
// switch to, because a control that opens a list of one teaches you not to press it. "Sign out" is at the bottom, where the board
// puts it, and does what the desktop's does.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../app/api.ts';
import { Icon } from './Sidebar.tsx';
import { MORE_GROUPS, NAV_GROUPS, hrefFor, maySee } from './nav.ts';
import { useShell } from './ShellProvider.tsx';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', manager: 'Manager' };

export function MobileMore({ navigate, onOpenNotifications, initialSwitching }: { navigate: (to: string) => void; onOpenNotifications: () => void; initialSwitching?: boolean }): ReactNode {
  const { store, me, stores, badges, may } = useShell();
  const [switching, setSwitching] = useState(initialSwitching ?? false);
  const items = new Map(NAV_GROUPS.flat().map((i) => [i.id, i]));
  const others = stores.filter((m) => m.slug !== store.slug);

  const groups = MORE_GROUPS.map((g) => ({
    label: g.label,
    rows: g.rows.flatMap((r) => {
      const item = items.get(r.id);
      const needs = r.needs ?? item?.needs;
      if (needs !== undefined && !may(needs)) return [];
      if (item !== undefined && !maySee(item, me.permissions)) return [];
      const path = r.path ?? item?.path ?? '';
      const count = r.badge === 'notifications' ? badges.notifications : r.badge === undefined ? 0 : badges[r.badge];
      return [{ id: r.id, label: r.label ?? item?.label ?? r.id, icon: r.icon, path, special: r.special, count }];
    }),
  })).filter((g) => g.rows.length > 0);

  const signOut = (): void => {
    void api.delete('/api/session').catch(() => undefined).finally(() => window.location.assign('/signin'));
  };

  return (
    <div className="flex flex-col gap-3.5">
      <h1 className="m-0 font-display text-[24px]">More</h1>

      <div>
        <button
          type="button"
          aria-expanded={others.length > 0 ? switching : undefined}
          onClick={() => others.length > 0 && setSwitching(!switching)}
          className="flex w-full items-center gap-3 rounded-card border border-line bg-surface p-3 text-left"
        >
          <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-control bg-store-primary font-bold text-store-on-primary">
            {store.name.trim().charAt(0).toUpperCase()}
          </span>
          <span className="grow">
            <strong>{store.name}</strong>
            <br />
            <span className="text-caption text-muted">
              /{store.slug} · {me.role === null ? 'Staff' : (ROLE[me.role] ?? me.role)}
            </span>
          </span>
          {others.length > 0 ? <span className="text-caption font-bold text-brand">Switch</span> : null}
        </button>
        {switching ? (
          <ul className="mt-1 flex list-none flex-col gap-0.5 p-0">
            {others.map((o) => (
              <li key={o.slug}>
                <a href={hrefFor(o.slug, '')} onClick={(e) => { e.preventDefault(); navigate(hrefFor(o.slug, '')); }} className="flex min-h-12 items-center justify-between rounded-control bg-surface px-3.5 text-ink no-underline">
                  <span className="font-semibold">{o.name}</span>
                  <span className="text-caption text-muted">{ROLE[o.role ?? ''] ?? o.role}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {groups.map((g) => (
        <section key={g.label} className="flex flex-col gap-1">
          <span className="px-1 text-[12px] font-bold uppercase tracking-[0.06em] text-muted">{g.label}</span>
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            {g.rows.map((r) => {
              const inner = (
                <>
                  <Icon icon={r.icon} size={20} />
                  <span className="grow">{r.label}</span>
                  {r.count > 0 ? <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-pill bg-status-danger-fg px-1.5 text-[12px] font-bold text-white">{r.count}</span> : null}
                  <span aria-hidden="true" className="text-disabled">›</span>
                </>
              );
              const row = 'flex min-h-[52px] w-full items-center gap-3 border-0 border-b border-line-subtle bg-transparent px-3.5 text-left text-ink no-underline last:border-b-0';
              return r.special === 'notifications' ? (
                <button key={r.id} type="button" onClick={onOpenNotifications} className={row}>
                  {inner}
                </button>
              ) : (
                <a key={r.id} href={hrefFor(store.slug, r.path)} onClick={(e) => { e.preventDefault(); navigate(hrefFor(store.slug, r.path)); }} className={row}>
                  {inner}
                </a>
              );
            })}
          </div>
        </section>
      ))}

      <button type="button" onClick={signOut} className="min-h-12 border-0 bg-transparent font-semibold text-status-danger-fg">
        Sign out
      </button>
    </div>
  );
}
