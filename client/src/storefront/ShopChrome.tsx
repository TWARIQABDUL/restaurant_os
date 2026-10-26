// client/src/storefront/ShopChrome.tsx — milestone 16.
//
// The store's header, its category navigation, its banner and its store-info panel — the parts of the
// shopfront that surround the grid.
//
// ONE TREE FOR BOTH BOARDS. `Shop` is 390 and `StoreDesktop` is 1440, and they are the same store: the
// header's logo, name and open state, a search field, a category list and a cart. Main's responsive rule
// is that "layouts re-compose at each size; nothing is simply shrunk", and re-composing is what CSS
// breakpoints do — so the search field moves from under the header into it, the category rail becomes a
// left column, and the cart moves from a sticky bar to an aside. Two component trees would be two places
// to fix every copy change, and they would drift.
//
// THE OPEN STATE IS RENDERED, NOT COMPUTED. V018's store_open_state() decided it; this turns it into the
// board's own two sentences.

import type { ReactNode } from 'react';
import { useStore } from './StoreProvider.tsx';
import type { OpenState, StoreFace } from './api.ts';

/** ISO day numbers, 1 = Monday — matching V013 and V018. */
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * "Open · closes 22:00" or "Closed · opens Monday 10:00".
 *
 * The board writes the open case without a day and the closed case needs one, because "opens 10:00" on a
 * Sunday evening would read as tonight.
 */
export function openLabel(open: OpenState, today: number): string {
  if (open.isOpen) return open.closesAt === null ? 'Open' : `Open · closes ${open.closesAt}`;
  if (open.opensAt === null) return 'Closed';
  const sameDay = open.opensOn === today;
  const day = open.opensOn === null || sameDay ? '' : `${DAY_SHORT[open.opensOn] ?? ''} `;
  return `Closed · opens ${day}${open.opensAt}`;
}

/**
 * "Daily 10:00–22:00", or a line per group of days.
 *
 * GROUPED, because seven identical rows is what the desktop panel does NOT draw: it says "Daily
 * 10:00–22:00". Consecutive days with the same hours collapse into one line, which also gives
 * "Mon–Sat 10:00–19:00" for a store closed on Sunday.
 */
export function hoursLines(hours: StoreFace['hours']): string[] {
  if (hours.length === 0) return [];
  if (hours.length === 7 && hours.every((h) => h.opensAt === hours[0]?.opensAt && h.closesAt === hours[0]?.closesAt)) {
    return [`Daily ${hours[0]?.opensAt}–${hours[0]?.closesAt}`];
  }

  const lines: string[] = [];
  let run: StoreFace['hours'] = [];
  const flush = (): void => {
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) return;
    const days =
      run.length === 1
        ? DAY_SHORT[first.dayOfWeek]
        : `${DAY_SHORT[first.dayOfWeek]}–${DAY_SHORT[last.dayOfWeek]}`;
    lines.push(`${days} ${first.opensAt}–${first.closesAt}`);
    run = [];
  };

  for (const hour of hours) {
    const previous = run[run.length - 1];
    const continues =
      previous !== undefined &&
      previous.dayOfWeek + 1 === hour.dayOfWeek &&
      previous.opensAt === hour.opensAt &&
      previous.closesAt === hour.closesAt;
    if (!continues) flush();
    run.push(hour);
  }
  flush();
  return lines;
}

/** "Delivery 25–35 min · from 1,000 RWF · Pickup in 15 min", built from what the store actually offers. */
export function fulfilmentLine(
  face: StoreFace,
  money: (amount: string) => string,
  has: (module: string) => boolean,
): string {
  const parts: string[] = [];
  if (has('delivery') && face.delivery !== null) {
    const { etaMinMinutes, etaMaxMinutes, fromFee } = face.delivery;
    const eta = etaMinMinutes === etaMaxMinutes ? `${etaMinMinutes} min` : `${etaMinMinutes}–${etaMaxMinutes} min`;
    // "from", because the fee is the cheapest zone's and the real one depends on the address. See
    // deliverySummary() for why that is the only honest thing to say before checkout.
    parts.push(`Delivery ${eta} · from ${money(fromFee)}`);
  }
  if (has('pickup') && face.pickup !== null) {
    const minutes = face.pickup.readyMinutes;
    parts.push(minutes >= 1440 ? 'Pickup from tomorrow' : `Pickup in ${minutes} min`);
  }
  return parts.join(' · ');
}

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}): ReactNode {
  return (
    <div className="flex h-12 items-center gap-2 rounded-control border border-store-border bg-store-surface px-3.5 text-store-muted">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 min-w-0 grow border-0 bg-transparent text-body text-store-text outline-none"
      />
    </div>
  );
}

export function StoreHeader({
  onSearch,
  query,
  cartCount,
  onCart,
  onAccount,
  today,
}: {
  query: string;
  onSearch: (value: string) => void;
  cartCount: number;
  onCart: () => void;
  onAccount: () => void;
  today: number;
}): ReactNode {
  const { face, t, design } = useStore();
  const initial = face.store.name.trim().charAt(0).toUpperCase();

  return (
    <header className="border-b border-store-border bg-store-surface">
      <div className="mx-auto flex max-w-[1360px] items-center gap-3 px-4 py-3 lg:h-[76px] lg:gap-6 lg:px-10 lg:py-0">
        <div className="flex min-w-0 items-center gap-3">
          {design.logoUrl === null ? (
            <span
              aria-hidden="true"
              className="flex size-11 shrink-0 items-center justify-center rounded-control bg-store-primary font-display text-[22px] font-bold text-store-on-primary"
            >
              {initial}
            </span>
          ) : (
            // The merchant's own logo (Customize): decorative, because the store's name is right beside it.
            <img src={design.logoUrl} alt="" className="size-11 shrink-0 rounded-control object-cover" />
          )}
          <span className="flex min-w-0 flex-col">
            <h1 className="truncate font-display text-title font-bold leading-tight lg:text-heading">
              {face.store.name}
            </h1>
            <span className="flex items-center gap-1.5 text-caption text-store-muted">
              <span
                aria-hidden="true"
                className={`size-2 rounded-pill ${face.open.isOpen ? 'bg-status-success-fg' : 'bg-store-muted'}`}
              />
              {openLabel(face.open, today)}
            </span>
          </span>
        </div>

        {/* In the header on desktop, under it on mobile — the same field, mounted once. */}
        <div className="ml-auto hidden max-w-[520px] grow lg:block">
          <SearchField value={query} onChange={onSearch} placeholder={`Search ${t('catalog').toLowerCase()}`} />
        </div>

        <button
          type="button"
          onClick={onAccount}
          aria-label="Your account"
          className="ml-auto flex size-11 shrink-0 items-center justify-center rounded-control border border-store-border bg-store-surface p-0 lg:ml-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="8" r="3.5" />
            <path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onCart}
          aria-label={cartCount === 0 ? 'Cart, empty' : `Cart, ${cartCount} ${cartCount === 1 ? 'item' : 'items'}`}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-control border border-store-border bg-store-surface p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 7h12l-1 13H7L6 7z" />
            <path d="M9 7a3 3 0 0 1 6 0" />
          </svg>
          {cartCount === 0 ? null : (
            <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-pill bg-store-primary px-1.5 text-mono text-store-on-primary">
              {cartCount}
            </span>
          )}
        </button>
      </div>

      <div className="px-4 pb-3 lg:hidden">
        <SearchField value={query} onChange={onSearch} placeholder={`Search ${t('catalog').toLowerCase()}`} />
      </div>
    </header>
  );
}

export function PromoBanner({ title, subtitle }: { title: string | null; subtitle: string | null }): ReactNode {
  if (title === null && subtitle === null) return null;
  return (
    <section className="flex flex-col gap-1.5 rounded-card bg-store-hero-bg p-5 text-store-hero-text lg:flex-row lg:items-center lg:justify-between lg:p-8">
      <div className="flex flex-col gap-1.5">
        <span className="text-mono uppercase tracking-[0.06em]">This week</span>
        {title === null ? null : (
          <h2 className="font-display text-heading leading-tight lg:text-display">{title}</h2>
        )}
        {subtitle === null ? null : <p className="text-body">{subtitle}</p>}
      </div>
    </section>
  );
}

export function CategoryNav({
  categories,
  active,
  onPick,
  allLabel,
  totalCount,
}: {
  categories: StoreFace['categories'];
  active: string | null;
  onPick: (id: string | null) => void;
  allLabel: string;
  totalCount: number | null;
}): ReactNode {
  const entries: { id: string | null; name: string; count: number | null }[] = [
    { id: null, name: allLabel, count: totalCount },
    ...categories.map((c) => ({ id: c.id as string | null, name: c.name, count: c.productCount })),
  ];

  return (
    <>
      {/* Mobile: a scrolling rail of pills. */}
      <nav aria-label={`${allLabel} categories`} className="flex gap-2 overflow-x-auto px-4 py-3 lg:hidden">
        {entries.map((entry) => {
          const on = entry.id === active;
          return (
            <button
              key={entry.id ?? 'all'}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(entry.id)}
              className={`h-11 shrink-0 whitespace-nowrap rounded-pill px-4 text-body font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                on
                  ? 'border border-ink bg-ink text-white'
                  : 'border border-store-border bg-store-surface text-store-text'
              }`}
            >
              {entry.name}
            </button>
          );
        })}
      </nav>

      {/* Desktop: a column, with counts. */}
      <nav aria-label={`${allLabel} categories`} className="hidden flex-col gap-0.5 lg:flex">
        <span className="px-3 pb-2 text-caption font-bold uppercase tracking-[0.06em] text-store-muted">
          {allLabel}
        </span>
        {entries.map((entry) => {
          const on = entry.id === active;
          return (
            <button
              key={entry.id ?? 'all'}
              type="button"
              aria-current={on ? 'true' : undefined}
              onClick={() => onPick(entry.id)}
              className={`flex h-11 items-center justify-between rounded-control px-3 text-body font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                on ? 'bg-ink text-white' : 'text-store-text'
              }`}
            >
              {entry.name}
              {entry.count === null ? null : (
                <span className={`font-medium ${on ? 'text-white' : 'text-store-muted'}`}>{entry.count}</span>
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}

/** The desktop store-info panel. Absent on mobile, where the header's one line carries it. */
export function StoreInfo(): ReactNode {
  const { face, money, has } = useStore();
  const lines = hoursLines(face.hours);
  const fulfilment = fulfilmentLine(face, money, has);

  return (
    <div className="mt-6 hidden flex-col gap-1.5 rounded-card border border-store-border bg-store-surface p-3.5 text-body lg:flex">
      <strong>Store info</strong>
      {face.pickup === null ? null : <span className="text-store-muted">{face.pickup.address}</span>}
      {lines.map((line) => (
        <span key={line} className="text-store-muted">
          {line}
        </span>
      ))}
      {fulfilment === '' ? null : <span className="text-store-muted">{fulfilment}</span>}
      {face.store.phone === null ? null : (
        <a href={`tel:${face.store.phone.replace(/[^+0-9]/g, '')}`} className="font-semibold text-store-primary">
          {face.store.phone}
        </a>
      )}
      {face.hours.length === 0 ? null : (
        <span className="sr-only">
          {face.hours.map((h) => `${DAY_NAMES[h.dayOfWeek]} ${h.opensAt} to ${h.closesAt}`).join('. ')}
        </span>
      )}
    </div>
  );
}
