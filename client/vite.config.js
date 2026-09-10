import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
