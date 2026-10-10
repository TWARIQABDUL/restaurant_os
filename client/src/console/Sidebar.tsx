// client/src/console/Sidebar.tsx — milestone 19, from project/Sidebar.dc.html and project/DashboardMobile.dc.html.
//
// ONE FILE FOR BOTH BARS. The 248px sidebar and the five-item bottom bar are the same navigation at two sizes,
// and `Main`'s rule is that "layouts re-compose at each size; nothing is simply shrunk" — so they are two
// components fed by one table (nav.ts) rather than one component with a width switch. What they must never do is
// disagree about which section is current, which is why `active` is passed to both from the shell.
//
// RADII ARE SNAPPED TO THE TOKENS. The board draws the store switcher at 12px and the nav items at 10px; the
// token layer has chip 8, control 10, card 14. Everything interactive here is `rounded-control`, which is the
// established practice in the storefront — the five radius tokens exist so that a rewrite does not accumulate
// a thirteenth value, and a 2px difference on one button is a cheaper loss than a token nobody reuses.

import type { ReactNode } from 'react';
import { api } from '../app/api.ts';
import { MOBILE_TABS, NAV_GROUPS, hrefFor, iconPath, maySee } from './nav.ts';
import type { BadgeKey, NavIcon } from './nav.ts';
import { useShell } from './ShellProvider.tsx';

export function Icon({ icon, size = 20 }: { icon: NavIcon; size?: number }): ReactNode {
  const path = iconPath(icon);
  if (path === '') {
    // "More" has no outline in the board — it is three dots, drawn as circles.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <circle cx="19" cy="12" r="1.5" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

/** The green pill on Orders, Complaints and Reviews. Absent at zero — see nav.ts on why a badge must clear. */
function NavBadge({ count }: { count: number }): ReactNode {
  if (count <= 0) return null;
  return (
    <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-pill bg-brand px-1.5 text-caption text-white">
      {count}
    </span>
  );
}

type Props = {
  /** The nav id of the screen being shown, so exactly one item carries aria-current. */
  active: string;
  unread: number;
  onOpenNotifications: () => void;
  navigate: (to: string) => void;
};

/**
 * The store's public address, under its name in the switcher.
 *
 * THE BOARD WRITES `nyama.[DOMAIN]` — a placeholder, because whether a store gets a subdomain or a path is one
 * of Part 9's open questions. So this renders what is true today: the path the storefront is actually served
 * at, on the host the console is on. When the question is settled this function changes and nothing else does.
 */
function publicAddress(slug: string): string {
  const host = typeof window === 'undefined' ? '' : window.location.host;
  return host === '' ? `/${slug}` : `${host}/${slug}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p !== '');
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  return `${first.slice(0, 1)}${last.slice(0, 1)}`.toUpperCase();
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  rider: 'Rider',
};

export function Sidebar({ active, unread, onOpenNotifications, navigate }: Props): ReactNode {
  const { store, me, stores, badges } = useShell();

  const counts: Readonly<Record<BadgeKey, number>> = {
    orders: badges.orders,
    complaints: badges.complaints,
    reviews: badges.reviews,
  };

  return (
    <nav
      aria-label="Merchant navigation"
      className="hidden w-[248px] shrink-0 flex-col border-r border-line bg-surface px-3 py-5 lg:flex"
    >
      <div className="flex items-center gap-2.5 px-2 pb-4">
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-chip bg-ink font-display text-[16px] font-bold text-ground"
        >
          V
        </span>
        <span className="font-display text-[20px] font-bold">Vendlyfy</span>
        <button
          type="button"
          onClick={onOpenNotifications}
          aria-label={unread === 0 ? 'Notifications' : `Notifications, ${unread} unread`}
          className="relative ml-auto flex size-10 items-center justify-center rounded-pill text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <Icon icon="bell" />
          {unread === 0 ? null : (
            <span className="absolute right-[3px] top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-status-danger-fg px-[5px] text-[11px] font-bold text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </div>

      <StoreSwitcher
        name={store.name}
        address={publicAddress(store.slug)}
        mark={store.name.slice(0, 1).toUpperCase()}
        others={stores.filter((s) => s.slug.toLowerCase() !== store.slug.toLowerCase())}
        navigate={navigate}
      />

      {NAV_GROUPS.map((group, index) => {
        const visible = group.filter((item) => maySee(item, me.permissions));
        if (visible.length === 0) return null;
        return (
          <div
            key={index}
            className={`flex flex-col gap-0.5 py-1.5 ${index === 0 ? '' : 'border-t border-line-subtle'}`}
          >
            {visible.map((item) => {
              const current = item.id === active;
              const shared = 'flex h-11 items-center gap-3 rounded-control px-3 text-caption font-semibold';
              const badge = item.badge === undefined ? null : <NavBadge count={counts[item.badge]} />;

              // The board's own two variants: a link where there is somewhere to go, and a plain row where
              // there is not. See nav.ts on `built`.
              return item.built ? (
                <a
                  key={item.id}
                  href={hrefFor(store.slug, item.path)}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(hrefFor(store.slug, item.path));
                  }}
                  aria-current={current ? 'page' : undefined}
                  className={`${shared} no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                    current ? 'bg-brand-tint text-brand-strong' : 'text-ink-2'
                  }`}
                >
                  <Icon icon={item.icon} />
                  <span className="grow">{item.label}</span>
                  {badge}
                </a>
              ) : (
                <span
                  key={item.id}
                  aria-disabled="true"
                  title={`Coming with the ${item.label} screen`}
                  className={`${shared} text-disabled`}
                >
                  <Icon icon={item.icon} />
                  <span className="grow">{item.label}</span>
                  {badge}
                </span>
              );
            })}
          </div>
        );
      })}

      <div className="mt-auto flex flex-col gap-3">
        {/* "View your store" is a real link out of the console and into the shopfront, so it is a plain
            anchor: the storefront is a different app at cutover and may not share this router. */}
        <a
          href={`/${encodeURIComponent(store.slug)}`}
          className="flex h-11 items-center justify-center gap-2 rounded-control border border-control-line text-caption font-semibold text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          View your store
        </a>
        <div className="flex items-center gap-2.5 px-2">
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-pill bg-line-subtle text-[13px] font-bold"
          >
            {initials(me.name)}
          </span>
          <span className="flex flex-col">
            <span className="text-caption font-semibold">{me.name}</span>
            <span className="text-[12px] text-muted">{me.role === null ? 'Staff' : ROLE_LABELS[me.role] ?? me.role}</span>
          </span>
        </div>
        {/* DELETE /api/session clears the cookie; it is unauthenticated on purpose, so an expired session can still clean
            itself up. A full navigation, not a router push: nothing from this person's session should survive in memory. */}
        <button
          type="button"
          onClick={() => {
            void api.delete('/api/session').catch(() => undefined).finally(() => window.location.assign('/signin'));
          }}
          className="flex h-10 items-center justify-center rounded-control text-caption font-semibold text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}

/**
 * "Switch store".
 *
 * A BUTTON ONLY WHERE THERE IS SOMETHING TO SWITCH TO. Most merchants have one store, and a control that opens
 * a list of one is a control that teaches you not to press it. With several, each is a link to `/app/<slug>` —
 * switching store IS navigation here, because the console's store comes from the URL.
 */
function StoreSwitcher({
  name,
  address,
  mark,
  others,
  navigate,
}: {
  name: string;
  address: string;
  mark: string;
  others: readonly { slug: string; name: string }[];
  navigate: (to: string) => void;
}): ReactNode {
  const face = (
    <>
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-chip bg-store-accent font-display font-bold text-store-on-accent"
      >
        {mark}
      </span>
      <span className="flex min-w-0 grow flex-col text-left">
        <span className="truncate text-caption font-semibold">{name}</span>
        <span className="truncate text-[12px] text-muted">{address}</span>
      </span>
    </>
  );

  const shell = 'mb-3 flex h-14 items-center gap-2.5 rounded-control border border-line bg-ground px-2.5';

  if (others.length === 0) {
    return <div className={shell}>{face}</div>;
  }

  return (
    <details className="mb-3">
      <summary
        aria-label="Switch store"
        className={`${shell} mb-0 cursor-pointer list-none marker:content-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink`}
      >
        {face}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 10l4-4 4 4M8 14l4 4 4-4" />
        </svg>
      </summary>
      <ul className="mt-1 flex list-none flex-col gap-0.5 p-0">
        {others.map((other) => (
          <li key={other.slug}>
            <a
              href={hrefFor(other.slug, '')}
              onClick={(event) => {
                event.preventDefault();
                navigate(hrefFor(other.slug, ''));
              }}
              className="flex h-10 items-center rounded-control px-3 text-caption font-semibold text-ink-2 no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {other.name}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * `DashboardMobile`'s bottom bar. Five items, 76px tall with 12px of padding under it for the home indicator.
 *
 * FIXED, NOT STICKY: the board draws it pinned to the bottom of a 844px frame with the content scrolling
 * behind. The main region carries the matching bottom padding so the last card is reachable.
 */
export function MobileTabs({ active, navigate }: { active: string; navigate: (to: string) => void }): ReactNode {
  const { store, badges } = useShell();
  const counts: Readonly<Record<BadgeKey, number>> = {
    orders: badges.orders,
    complaints: badges.complaints,
    reviews: badges.reviews,
  };

  return (
    <nav
      aria-label="Merchant"
      className="fixed inset-x-0 bottom-0 z-10 grid h-[76px] grid-cols-5 border-t border-line bg-surface pb-3 lg:hidden"
    >
      {MOBILE_TABS.map((tab) => {
        const current = tab.id === active;
        const shared = 'relative flex flex-col items-center justify-center gap-0.5 text-[11px]';
        const badge = tab.badge === undefined ? 0 : counts[tab.badge];
        const inner = (
          <>
            <Icon icon={tab.icon} size={22} />
            {tab.label}
            {badge <= 0 ? null : (
              <span className="absolute left-1/2 top-2 ml-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-brand px-1 text-[11px] text-white">
                {badge}
              </span>
            )}
          </>
        );

        return tab.built ? (
          <a
            key={tab.id}
            href={hrefFor(store.slug, tab.path)}
            onClick={(event) => {
              event.preventDefault();
              navigate(hrefFor(store.slug, tab.path));
            }}
            aria-current={current ? 'page' : undefined}
            className={`${shared} no-underline ${current ? 'font-bold text-brand-strong' : 'font-semibold text-ink-2'}`}
          >
            {inner}
          </a>
        ) : (
          <span key={tab.id} aria-disabled="true" className={`${shared} font-semibold text-disabled`}>
            {inner}
          </span>
        );
      })}
    </nav>
  );
}
