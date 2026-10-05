// client/src/console/ShellProvider.tsx — milestone 19.
//
// The merchant console's context: the store, the person, the words, the money formatter and the sidebar's
// badges. Modelled on storefront/StoreProvider.tsx, and the differences are the two that matter.
//
// FIRST, IT RESOLVES A SLUG TO A STORE ID THROUGH GET /api/session. The console's URL is `/app/:store`, so the
// store comes from the URL as §2.5 requires — "never from a remembered slug" — and the API takes a uuid,
// because the guard on /api/stores/:storeId reads the membership for the id it is mounted under. The
// memberships list is the only bridge between the two, and it is also the authorisation check that matters
// here: a slug the signed-in person has no membership of is not "not found", it is not theirs.
//
// SECOND, THE STORE'S THEME LANDS ON THE CONSOLE, BUT THE CONSOLE'S CHROME DOES NOT USE IT. The theme is
// applied to the shell element so `bg-store-*` resolves to this store inside it, which is what the sidebar's
// store mark and (later) StorePreview and the catalogue cards want. Everything that is Vendlyfy's own frame —
// the ground, the cards, the nav, the badges — is drawn from the fixed platform tokens, so switching to a blue
// store recolours the mark and nothing else. That is the Sidebar board's own behaviour: its component takes the
// store as a prop and only the mark changes.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure, api } from '../app/api.ts';
import type { Membership, SessionResult } from '../app/api.ts';
import { bindConfig, formatMoney } from '../app/core.ts';
import type { Attribute, CurrencyFormat, EffectiveConfig, FeatureGate, MoneyInput, Vocabulary } from '../app/core.ts';
import { applyStoreTheme, parseStoreTheme } from '../styles/store-theme.ts';
import { shell } from './api.ts';
import type { ConsoleMe, ConsoleStore, ShellBadges, ShellData } from './api.ts';

export type ShellContextValue = {
  store: ConsoleStore;
  me: ConsoleMe;
  /**
   * Every store this person works at, from the session — which is what the sidebar's "Switch store" needs.
   * Kept here because the session read already happened to resolve the slug, so the switcher costs nothing.
   */
  stores: readonly Membership[];
  /** The config engine's two primitives. A component never branches on an industry name. */
  t: Vocabulary;
  has: FeatureGate;
  /**
   * The template's suggested option groups — AddProduct's "Suggested: Material · Fit" chips. Data, like the
   * words: the Food template suggests Spice level and Extras, Fashion suggests Size and Colour.
   */
  attributes: readonly Attribute[];
  /** "Food & drinks" — what Categories' subtitle says its word is called in. Null for a store with no template yet. */
  templateName: string | null;
  currency: CurrencyFormat;
  money: (amount: MoneyInput) => string;
  badges: ShellBadges;
  /** Whether this role may do something. The sidebar hides what it answers false to. */
  may: (permission: string) => boolean;
  /** Re-reads the badges after something that changes them — accepting an order, reading the inbox. */
  refreshBadges: () => void;
  /** Lets a screen correct one badge without a round trip, for the count it just changed itself. */
  setBadges: (next: ShellBadges) => void;
  /**
   * The store's whole resolved configuration, and the way to replace it. Settings → Features switches modules and the
   * business type, and the sidebar, the vocabulary and every `has()` gate must follow in the same breath — not on the
   * next page load — so the screen hands the server's answer back here.
   */
  config: EffectiveConfig;
  setConfig: (config: EffectiveConfig) => void;
};

/** Exported for the render gate, which mounts console screens with a fixed store rather than a live one. */
export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (value === null) throw new Error('useShell() outside a ShellProvider');
  return value;
}

export type ShellState =
  | { status: 'loading' }
  | { status: 'ready' }
  /** Signed in, but not at this store. A different answer from a failure, and a different screen. */
  | { status: 'not-yours'; slug: string }
  | { status: 'signed-out' }
  | { status: 'failed'; error: ApiFailure };

type Props = {
  slug: string;
  children: ReactNode;
  fallback: (state: ShellState, retry: () => void) => ReactNode;
};

export function ShellProvider({ slug, children, fallback }: Props): ReactNode {
  const [state, setState] = useState<ShellState>({ status: 'loading' });
  const [data, setData] = useState<ShellData | null>(null);
  const [memberships, setMemberships] = useState<readonly Membership[]>([]);
  const [badges, setBadges] = useState<ShellBadges | null>(null);
  const [attempt, setAttempt] = useState(0);
  const themeHost = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;

    async function load(): Promise<void> {
      setState({ status: 'loading' });
      try {
        const session = await api.get<SessionResult>('/api/session');
        if (!live) return;

        const wanted = slug.toLowerCase();
        const membership = session.memberships.find((m) => m.slug.toLowerCase() === wanted);
        if (membership === undefined) {
          setState({ status: 'not-yours', slug });
          return;
        }

        const loaded = await shell.load(membership.storeId);
        if (!live) return;

        // Riders have their own app at /rider; a console with no console navigation in it is not a screen.
        setMemberships(session.memberships.filter((m) => m.role !== 'rider'));
        setData(loaded);
        setBadges(loaded.badges);

        // A theme that fails to parse leaves the platform default in place rather than taking the console
        // offline — store-theme.ts's own rule, and the reason applyStoreTheme never throws.
        if (loaded.theme !== null && themeHost.current !== null) {
          const parsed = parseStoreTheme(loaded.theme.colors);
          if (parsed.ok) applyStoreTheme(parsed.theme, themeHost.current);
        }

        setState({ status: 'ready' });
      } catch (error) {
        if (!live) return;
        if (error instanceof ApiFailure && error.status === 401) {
          setState({ status: 'signed-out' });
          return;
        }
        setState({
          status: 'failed',
          error:
            error instanceof ApiFailure
              ? error
              : new ApiFailure({ status: 0, code: 'UNKNOWN', message: 'Something went wrong.' }),
        });
      }
    }

    void load();
    return () => {
      live = false;
    };
  }, [slug, attempt]);

  const storeId = data?.store.id;

  const refreshBadges = useCallback(() => {
    if (storeId === undefined) return;
    // Silent on failure: a stale badge is not worth an error message, and the next load corrects it.
    void shell
      .load(storeId)
      .then((fresh) => setBadges(fresh.badges))
      .catch(() => undefined);
  }, [storeId]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const value = useMemo<ShellContextValue | null>(() => {
    if (data === null || badges === null) return null;
    const bound = bindConfig(data.config);
    const currency = data.store.currency;
    const permissions = data.me.permissions;
    return {
      store: data.store,
      me: data.me,
      stores: memberships,
      t: bound.t,
      has: bound.has,
      attributes: data.config.attributes,
      templateName: data.config.template?.name ?? null,
      currency,
      money: (amount: MoneyInput) => formatMoney(amount, currency),
      badges,
      may: (permission: string) => permissions.includes(permission),
      refreshBadges,
      setBadges,
      config: data.config,
      setConfig: (config: EffectiveConfig) => setData((prev) => (prev === null ? prev : { ...prev, config })),
    };
  }, [data, badges, memberships, refreshBadges]);

  return (
    // The store's theme lands on THIS element, so `bg-store-*` inside the console is this store's. The console's
    // own surfaces use the fixed tokens, which is why `bg-ground` here and not `bg-store-bg`.
    <div ref={themeHost} className="min-h-dvh bg-ground text-ink">
      {value === null || state.status !== 'ready' ? (
        fallback(state, retry)
      ) : (
        <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
      )}
    </div>
  );
}
