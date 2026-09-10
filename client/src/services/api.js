import axios from 'axios';

// Same-origin by default: '/backend' is proxied to the API — by the Vite dev
// server locally, by a rewrite in vercel.json in production. That keeps the
// session cookie first-party, so a plain SameSite=Lax cookie is sent on every
// request and no CORS preflight is involved.
//
// The prefix is '/backend' rather than '/api' because this Vercel project
// already serves its own functions under /api (sitemap, robots, seo).
const API_URL = import.meta.env.VITE_API_URL || '/backend';

const api = axios.create({
  baseURL: API_URL,
  // Send the httpOnly session cookie.
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

const GLOBAL_ROUTES = ['login', 'register', 'manager', 'admin', 'delivery', 'super-admin'];

/** The slug of the store the signed-in user actually belongs to, if any. */
function ownStoreSlug() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')?.tenants?.slug || null;
  } catch {
    return null;
  }
}

/**
 * Which store this request is about.
 *
 * On a storefront URL (/:tenantSlug/...) the path wins and is remembered, so
 * that dashboards — which live on global routes with no slug in the URL — know
 * which store to ask about.
 *
 * A remembered slug is only ever a hint. Any path segment can land here,
 * including a typo or a 404, so the server is the authority: see the response
 * interceptor below, which clears a slug the server rejects. Without that, one
 * bad URL used to poison every later request, login included.
 */
function resolveTenantSlug() {
  const [first] = window.location.pathname.split('/').filter(Boolean);

  if (first && !GLOBAL_ROUTES.includes(first) && !first.includes('.')) {
    localStorage.setItem('tenantSlug', first);
    return first;
  }

  // Prefer the signed-in user's own store over a remembered slug — it can't be
  // poisoned, and it's the right answer on every dashboard route.
  return ownStoreSlug() || localStorage.getItem('tenantSlug') || 'demo';
}

api.interceptors.request.use((config) => {
  // The session normally travels as an httpOnly cookie, which script can't
  // read — that's the point. This only covers users who were signed in before
  // the cookie migration and still hold a localStorage token; it keeps them
  // logged in until it expires. Remove once those have aged out.
  const legacyToken = localStorage.getItem('token');
  if (legacyToken) {
    config.headers.Authorization = `Bearer ${legacyToken}`;
  }

  config.headers['X-Tenant-Slug'] = resolveTenantSlug();

  return config;
});

// Handle 401 responses globally
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;

    // The server rejected the store we named. A remembered slug is a guess —
    // it can come from a mistyped URL — so drop it rather than letting it
    // wedge every later request (this used to make login impossible until the
    // user cleared their site data). The signed-in user's own store is picked
    // up again on the next request.
    if (status === 404 && error.response?.data?.error === 'Store not found') {
      localStorage.removeItem('tenantSlug');
    }
    if (status === 403 && error.response?.data?.error === 'Not authorized for this store') {
      localStorage.removeItem('tenantSlug');
    }

    if (status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      // Don't redirect if already on login/register page
      if (!window.location.pathname.includes('/login') && !window.location.pathname.includes('/register')) {
        const currentPath = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/login?redirect=${currentPath}`;
      }
    }
    return Promise.reject(error);
  }
);

export default api;
