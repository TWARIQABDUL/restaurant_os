// client/src/storefront/StoreProvider.tsx — milestone 16.
//
// Everything the shopfront's screens need about the store they are in: its name and hours, its published
// look, its industry's words, its money format, and the cart.
//
// THREE REQUESTS ON FIRST PAINT, in parallel — the face, the theme and the config. They are three
// documents because they change on three different clocks (storefrontStore.ts explains why folding them
// into one would throw away the theme's cache every morning), and fetching them together rather than in
// a waterfall is what keeps that from costing anything.
//
// THE CART IS A FOURTH, AND IT IS NOT AWAITED WITH THEM. A shopper sees the menu before they see their
// bag, so the page paints on three and fills the badge when the fourth lands. That ordering is the
// difference between a shop that appears instantly and one that waits on a cart most visitors do not
// have.
//
// NO STORAGE. Not localStorage, not sessionStorage, not a module-level cache. §2.5 makes the server
// authoritative, and the cart in particular must be the server's answer: a remembered count that
// disagrees with the cart is how a shopper gets to checkout expecting a different total.
//
// THE THEME IS APPLIED TO A DIV, NOT TO :root, because store-theme.ts was built that way for
// StorePreview and ThemeStudio — subtrees themed differently from the page around them. The shopfront
// uses the same mechanism as the preview, which is what makes the preview trustworthy.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure, api } from '../app/api.ts';
import { bindConfig, formatMoney } from '../app/core.ts';
import type { CurrencyFormat, EffectiveConfig, FeatureGate, MoneyInput, Vocabulary } from '../app/core.ts';
import { applyStoreTheme, parseStoreTheme } from '../styles/store-theme.ts';
import { storefront } from './api.ts';
import type { CartData, StoreFace } from './api.ts';

/** RWF, as V006 has it. The fallback for the instant before the theme lands, never a stored value. */
const DEFAULT_CURRENCY: CurrencyFormat = {
  code: 'RWF',
  symbol: 'RWF',
  symbolPosition: 'after',
  decimals: 0,
  thousandsSeparator: ',',
  cashRounding: 0,
};

export type StoreContextValue = {
  face: StoreFace;
  currency: CurrencyFormat;
  /** The config engine's two primitives. A component never branches on an industry name. */
  t: Vocabulary;
  has: FeatureGate;
  money: (amount: MoneyInput) => string;
  cart: CartData;
  /** Replaces the cart with what the server says it is — called after every write. */
  setCart: (cart: CartData) => void;
  refreshCart: () => void;
};

/**
 * Exported so the render gate can mount a storefront component with a fixed store rather than a live one.
 *
 * A component that needs a store is otherwise unrenderable without a network, and "does the option sheet
 * throw on first paint" is exactly what the gate exists to answer. Nothing in the app imports this: the
 * app uses StoreProvider, which is the only thing that fetches.
 */
export const StoreContext = createContext<StoreContextValue | null>(null);

export function useStore(): StoreContextValue {
  const value = useContext(StoreContext);
  // Throws rather than returning a default, for the reason authOf() does on the server: a component
  // rendered outside the provider would otherwise silently show another store's vocabulary.
  if (value === null) throw new Error('useStore() outside a StoreProvider');
  return value;
}

const EMPTY_CART: CartData = { id: null, lines: [], itemCount: 0, subtotal: '0.00', expiresAt: null };

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'failed'; error: ApiFailure };

type Props = {
  slug: string;
  children: ReactNode;
  /** Rendered instead of the children while the three documents are in flight, or when they fail. */
  fallback: (state: LoadState, retry: () => void) => ReactNode;
};

export function StoreProvider({ slug, children, fallback }: Props): ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [face, setFace] = useState<StoreFace | null>(null);
  const [currency, setCurrency] = useState<CurrencyFormat>(DEFAULT_CURRENCY);
  const [config, setConfig] = useState<EffectiveConfig | null>(null);
  const [cart, setCart] = useState<CartData>(EMPTY_CART);
  const [attempt, setAttempt] = useState(0);

  const themeHost = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;

    async function load(): Promise<void> {
      setState({ status: 'loading' });
      try {
        // In parallel: none of the three depends on another.
        const [faceResult, themeResult, configResult] = await Promise.all([
          storefront.face(slug),
          storefront.theme(slug),
          api.get<{ config: EffectiveConfig }>(`/api/storefront/${encodeURIComponent(slug)}/config`),
        ]);
        if (!live) return;

        setFace(faceResult);
        setCurrency(themeResult.currency ?? DEFAULT_CURRENCY);
        setConfig(configResult.config);

        // A theme that fails to parse leaves the platform default in place rather than taking the shop
        // offline — store-theme.ts's own rule, and the reason applyStoreTheme never throws.
        if (themeResult.theme !== null && themeHost.current !== null) {
          const parsed = parseStoreTheme(themeResult.theme.colors);
          if (parsed.ok) applyStoreTheme(parsed.theme, themeHost.current);
        }

        setState({ status: 'ready' });
      } catch (error) {
        if (!live) return;
        setState({
          status: 'failed',
          error: error instanceof ApiFailure ? error : new ApiFailure({ status: 0, code: 'UNKNOWN', message: 'Something went wrong.' }),
        });
      }
    }

    void load();
    return () => {
      live = false;
    };
  }, [slug, attempt]);

  // The cart, separately and not blocking the paint. A failure here is silent on purpose: a shopper who
  // cannot load a cart they may not have should still see the shop, and the next add will tell them.
  useEffect(() => {
    let live = true;
    void storefront
      .cart(slug)
      .then((result) => {
        if (live) setCart(result.cart);
      })
      .catch(() => {
        /* no cart to show; the badge stays empty */
      });
    return () => {
      live = false;
    };
  }, [slug, attempt]);

  const refreshCart = useCallback(() => {
    void storefront
      .cart(slug)
      .then((result) => setCart(result.cart))
      .catch(() => {
        /* as above */
      });
  }, [slug]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const value = useMemo<StoreContextValue | null>(() => {
    if (face === null || config === null) return null;
    const bound = bindConfig(config);
    return {
      face,
      currency,
      t: bound.t,
      has: bound.has,
      money: (amount: MoneyInput) => formatMoney(amount, currency),
      cart,
      setCart,
      refreshCart,
    };
  }, [face, config, currency, cart, refreshCart]);

  return (
    // The theme lands on THIS element. bg-store-bg and the rest resolve against it, so the whole
    // shopfront is inside the store's palette and nothing outside it is affected.
    <div ref={themeHost} className="min-h-dvh bg-store-bg text-store-text">
      {value === null || state.status !== 'ready' ? (
        fallback(state, retry)
      ) : (
        <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
      )}
    </div>
  );
}
