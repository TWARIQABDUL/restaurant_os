import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Two entries, deliberately.
  //
  // index.html is the live app: it loads src/main.jsx, which imports
  // src/index.css — the legacy stylesheet whose 84 semantic classes 31 of the old
  // pages still depend on (542 uses). It is deleted page by page through Stage D.
  //
  // gallery.html loads ONLY src/styles/tokens.css, the new L0 token layer. Two
  // documents means two CSS graphs, which is what makes "no legacy CSS reachable"
  // a property of the new page rather than a hope. The UI kit gallery lands in it
  // at milestone 14.
  //
  // Paths are relative so they resolve against Vite's `root` on any host, rather
  // than through import.meta.dirname, which needs Node 20.11 and would tie the
  // build to a version nothing here pins.
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        gallery: 'gallery.html',
      },
    },
  },

  server: {
    // Mirror production: the API is reached at /api on this origin, so the
    // session cookie is first-party in dev too. Without this the browser would
    // treat localhost:5000 as a separate origin and the cookie behaviour here
    // wouldn't match what ships.
    proxy: {
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
