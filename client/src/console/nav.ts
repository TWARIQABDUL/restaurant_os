// client/src/console/nav.ts — milestone 19, from project/Sidebar.dc.html.
//
// THE NAVIGATION IS DATA, and the board's own component is why: it maps over `GROUPS`, a list of
// `[id, label, href, badge]` tuples, and renders each item one of two ways — a link, or a plain button for an
// item with nowhere to go. Transcribing it as fourteen hand-written <a> tags would lose the separators, the
// badge rule and the two variants, and the next person to add a screen would have to find all three.
//
// WHAT `built` IS FOR. The console arrives over milestones 19 to 27, one section at a time, and until a
// section exists a link to it goes nowhere. The board already has the affordance: its component draws an item
// with no href as a plain, unlinked row. So `built: false` renders exactly that, which is honest — the item is
// where it will be, and it does not pretend to open. Each later milestone flips one flag, and when the last
// one lands every item is a link and this field can go.
//
// THE PERMISSION ON AN ITEM IS A QUESTION, NEVER A ROLE NAME. §5.4: "a component asks whether a role may do
// something; it never contains the list." So Money asks for `wallet.read` rather than testing for owner —
// which is what makes Auth's promise to a manager ("you can't see payouts, the wallet or store settings") a
// property of the permission rows rather than of this file.

/** The icon paths, exactly as the board's ICONS map has them. */
const ICONS = {
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  orders: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  products: 'M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10',
  categories: 'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
  inventory: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  customers:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  store: 'M4 10v10h16V10M3 10l2-6h14l2 6M3 10h18M9 20v-6h6v6',
  complaints: 'M4 5h16v11H9l-5 4zM12 8v3M12 13.5h.01',
  money: 'M3 7h18v12H3zM16 13h2M3 7l2-3h14l2 3',
  riders: 'M6 17a3 3 0 1 0 0 .01M18 17a3 3 0 1 0 0 .01M6 17h6l3-7h3M9 10h4',
  reviews: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  analytics: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  more: '',
} as const;

export type NavIcon = keyof typeof ICONS;

export function iconPath(icon: NavIcon): string {
  return ICONS[icon];
}

/** Which count, if any, sits on the right of an item. Keyed to the shell's badges. */
export type BadgeKey = 'orders' | 'complaints' | 'reviews';

export type NavItem = {
  id: string;
  label: string;
  icon: NavIcon;
  /** Appended to /app/:store. Empty string is the dashboard itself. */
  path: string;
  /** False until the milestone that builds it lands; renders as the board's plain, unlinked row. */
  built: boolean;
  badge?: BadgeKey;
  /** Hidden outright for a role without it. Absent means every console role sees it. */
  needs?: string;
  /** The milestone that builds it, so the reason an item is plain is written down rather than guessed. */
  milestone: number;
};

/**
 * The five groups, in the board's order. The separator above every group but the first is the board's
 * `border-top` on `grp.sep`, so the grouping is drawn rather than implied by spacing.
 */
export const NAV_GROUPS: readonly (readonly NavItem[])[] = [
  [{ id: 'dashboard', label: 'Dashboard', icon: 'dashboard', path: '', built: true, milestone: 19 }],
  [
    { id: 'orders', label: 'Orders', icon: 'orders', path: '/orders', built: true, badge: 'orders', milestone: 20 },
    {
      id: 'complaints',
      label: 'Complaints',
      icon: 'complaints',
      path: '/complaints',
      built: false,
      badge: 'complaints',
      milestone: 24,
    },
    { id: 'products', label: 'Products', icon: 'products', path: '/products', built: false, milestone: 22 },
    { id: 'reviews', label: 'Reviews', icon: 'reviews', path: '/reviews', built: false, badge: 'reviews', milestone: 24 },
    { id: 'categories', label: 'Categories', icon: 'categories', path: '/categories', built: false, milestone: 22 },
    // The board points Inventory at the same screen as Products, because it is a view of it rather than a
    // place of its own. `Products`'s inline stock edit is one of the boards still outstanding (Part 9), so
    // this stays plain until there is a design to build.
    { id: 'inventory', label: 'Inventory', icon: 'inventory', path: '/products/stock', built: false, milestone: 22 },
    { id: 'customers', label: 'Customers', icon: 'customers', path: '/customers', built: false, milestone: 24 },
  ],
  [
    { id: 'money', label: 'Money', icon: 'money', path: '/money', built: false, needs: 'wallet.read', milestone: 23 },
    {
      id: 'riders',
      label: 'Riders & cash',
      icon: 'riders',
      path: '/riders',
      built: true,
      needs: 'orders.assign_rider',
      milestone: 21,
    },
  ],
  [
    {
      id: 'store-design',
      label: 'Store design',
      icon: 'store',
      path: '/store-design',
      built: false,
      needs: 'settings.write',
      milestone: 25,
    },
    // Analytics is revenue over time, so it asks the same question Money does.
    {
      id: 'analytics',
      label: 'Analytics',
      icon: 'analytics',
      path: '/analytics',
      built: false,
      needs: 'wallet.read',
      milestone: 24,
    },
  ],
  [
    {
      id: 'settings',
      label: 'Settings',
      icon: 'settings',
      path: '/settings',
      built: false,
      needs: 'settings.write',
      milestone: 25,
    },
  ],
];

/**
 * `DashboardMobile`'s bottom bar: five items, and the fifth is "More" rather than a section.
 *
 * NOT DERIVED FROM NAV_GROUPS, deliberately. The board picked these five — Home, Orders, Products, Store,
 * More — and a phone's bar is a different editorial decision from a desktop sidebar, not a truncation of it.
 * Main's rule is that "layouts re-compose at each size; nothing is simply shrunk", and taking the first five
 * of the sidebar would be shrinking.
 */
export const MOBILE_TABS: readonly { id: string; label: string; icon: NavIcon; path: string; built: boolean; badge?: BadgeKey }[] = [
  { id: 'dashboard', label: 'Home', icon: 'dashboard', path: '', built: true },
  { id: 'orders', label: 'Orders', icon: 'orders', path: '/orders', built: true, badge: 'orders' },
  { id: 'products', label: 'Products', icon: 'products', path: '/products', built: false },
  { id: 'store-design', label: 'Store', icon: 'store', path: '/store-design', built: false },
  { id: 'more', label: 'More', icon: 'more', path: '/more', built: false },
];

/** Whether this role may see an item at all. An item it cannot reach is not shown, rather than shown failing. */
export function maySee(item: { needs?: string }, permissions: readonly string[]): boolean {
  return item.needs === undefined || permissions.includes(item.needs);
}

/** The console path for an item, with the store's slug in front of it. */
export function hrefFor(slug: string, path: string): string {
  return `/app/${encodeURIComponent(slug)}${path}`;
}

/**
 * V010 stores a notification's destination as `/app/orders` — a route template with the store left out,
 * because a notification belongs to a store that the reader is already inside. This puts the slug back.
 */
export function consoleHref(slug: string, route: string): string {
  const suffix = route.startsWith('/app/') ? route.slice('/app'.length) : route;
  return hrefFor(slug, suffix);
}
