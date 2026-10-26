import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
/**
 * Serve the NEW app for every unknown path, instead of the legacy one.
 *
 * WHY THIS NEEDS A SWITCH AT ALL. The two apps claim the same URLs on purpose: legacy App.jsx routes
 * `/:tenantSlug`, `/:tenantSlug/cart` and `/:tenantSlug/checkout`, and the new app routes `/:store`,
 * `/:store/cart` and `/:store/checkout` — because at cutover app.html REPLACES index.html and takes those
 * paths over. So a dev server cannot decide between them by looking at the path; something has to say which
 * app is being worked on.
 *
 * Vite's default SPA fallback points at index.html, which is the legacy app, so without this a cold load of
 * /nyama lands on the old storefront. `npm run dev:app` flips the fallback; `npm run dev` is untouched and
 * still serves the legacy app exactly as it did.
 *
 * DEV ONLY. It disappears at cutover along with index.html, and it is not part of any build.
 */
function serveNewApp() {
  return {
    name: 'vendlyfy-serve-new-app',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? '/';
        // Anything with an extension is a real file; /api, /backend and /socket.io are proxied; /@vite and
        // /src are Vite's own. Everything else is a route, and routes belong to the new app now.
        const isRoute =
          !/\.[a-z0-9]+(\?|$)/i.test(url) &&
          !url.startsWith('/api') &&
          !url.startsWith('/backend') &&
          !url.startsWith('/socket.io') &&
          !url.startsWith('/@') &&
          !url.startsWith('/src') &&
          !url.startsWith('/node_modules');
        if (isRoute) req.url = '/app.html';
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(process.env.VENDLYFY_APP === '1' ? [serveNewApp()] : [])],

  // index.html DROPPED FROM THE PRODUCTION BUILD at milestone 30's cutover, exactly as this
  // comment always said it would ("the new app... replaces index.html at cutover"). It still
  // exists on disk for `npm run dev` (VENDLYFY_APP unset) to serve the legacy app locally, but it
  // is no longer part of `rollupOptions.input` — Vercel's routing gives a literal file at the build
  // root priority over vercel.json's rewrites, so as long as index.html was EMITTED, "/" resolved
  // to it directly and skipped the /app.html rewrite entirely, no matter how the rewrite was
  // written. With no built index.html, "/" has no matching file and falls through to the rewrite
  // like every other path.
  //
  // gallery.html loads ONLY src/styles/tokens.css, the new L0 token layer — kept, since nothing
  // about it is affected by the cutover.
  //
  // Paths are relative so they resolve against Vite's `root` on any host, rather
  // than through import.meta.dirname, which needs Node 20.11 and would tie the
  // build to a version nothing here pins.
  build: {
    rollupOptions: {
      input: {
        gallery: 'gallery.html',
        app: 'app.html',
      },
    },
  },

  server: {
    // Mirror production: the API is reached at /api on this origin, so the
    // session cookie is first-party in dev too. Without this the browser would
    // treat localhost:5000 as a separate origin and the cookie behaviour here
    // wouldn't match what ships.
    proxy: {
      // The NEW server (milestone 11's server/src/api), which listens on API_PORT 5100 so it can run
      // beside the legacy one. Mounted at /api because that is the path it serves and the path the new
      // client calls — which also makes the session cookie first-party in dev, as §2.5 requires: the
      // cookie is host-only on the store's own host in production, and a cross-origin dev setup would
      // exercise cookie behaviour that never ships.
      '/api': {
        target: 'http://localhost:5100',
        changeOrigin: true,
      },
      // Matches the vercel.json rewrite: /backend/* here maps to /api/* on the
      // API server. Kept identical so cookie behaviour in dev matches what ships.
      '/backend': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/backend/, '/api'),
      },
      '/socket.io': {
        target: 'http://localhost:5000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
