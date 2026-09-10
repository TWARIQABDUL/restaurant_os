import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from './AuthContext';
import { formatMoney, formatDelta, FALLBACK_CURRENCY } from '../config/money';

const TenantContext = createContext(null);

// Path segments that are app routes, not store slugs. Mirrors GLOBAL_ROUTES in
// services/api.js — the same question ("which store is this page about?") that
// the request interceptor answers for the X-Tenant-Slug header.
const GLOBAL_ROUTES = ['login', 'register', 'manager', 'admin', 'delivery', 'super-admin', 'api'];

const CACHE_KEY = 'tenantPublic';

/**
 * The public profile of the store being viewed: currency, theme, branding.
 *
 * This exists mainly so prices can be formatted correctly. Currency is a
 * store-level setting — an order carries one total, a wallet holds one balance,
 * and a MoMo charge names one currency — so every price on a page shares it, and
 * fetching it once here beats each component asking separately. Before this,
 * TenantThemeInjector and Home each made the same request independently.
 *
 * The last response is cached in localStorage so the first paint shows the right
 * currency instead of flashing a fallback and then correcting itself.
 */
export function TenantProvider({ children }) {
  const location = useLocation();
  const { user } = useAuth();

  const [tenant, setTenant] = useState(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);

  // Which store this page is about: the slug in the URL on a storefront, and
  // the signed-in user's own store on a dashboard route, which has no slug.
  const slug = useMemo(() => {
    const [first] = location.pathname.split('/').filter(Boolean);
    if (first && !GLOBAL_ROUTES.includes(first) && !first.includes('.')) return first;
    return user?.tenants?.slug || localStorage.getItem('tenantSlug') || null;
  }, [location.pathname, user?.tenants?.slug]);

  useEffect(() => {
    if (!slug) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    api.get(`/tenants/public/${slug}`)
      .then((res) => {
        const next = res.data?.tenant;
        if (cancelled || !next) return;
        setTenant(next);
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(next));
        } catch {
          // Private browsing, or storage full. The cache is a nicety.
        }
      })
      .catch(() => {
        // A bad slug or an unreachable API shouldn't blank the page. Keep
        // whatever is cached and let prices fall back to the default currency.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [slug]);

  const currency = tenant?.currency || FALLBACK_CURRENCY;

  const value = useMemo(() => ({
    tenant,
    slug,
    loading,
    currency,
    /** Format an amount in this store's currency. */
    money: (amount) => formatMoney(amount, currency),
    /** A signed price delta, e.g. an option that adds to the line. */
    delta: (amount) => formatDelta(amount, currency),
  }), [tenant, slug, loading, currency]);

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

/**
 * Store profile plus its money formatters.
 *
 * Safe outside a provider — returns the fallback currency rather than throwing,
 * so a component rendered in isolation (a test, a stray route) still shows a
 * sensible price instead of crashing the page.
 */
export function useTenant() {
  const context = useContext(TenantContext);
  if (context) return context;
  return {
    tenant: null,
    slug: null,
    loading: false,
    currency: FALLBACK_CURRENCY,
    money: (amount) => formatMoney(amount, FALLBACK_CURRENCY),
    delta: (amount) => formatDelta(amount, FALLBACK_CURRENCY),
  };
}

/** Just the formatters, for the common case. */
export function useMoney() {
  const { money, delta, currency } = useTenant();
  return { money, delta, currency };
}
