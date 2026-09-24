// Load order is load-bearing in this file, which is why the imports below look
// unusual.
//
// This used to be four requires in sequence, and CommonJS ran them in source
// order: dotenv, then assertEnv(), then the app. ESM hoists every static import
// above the module body, so a static `import app from './app.js'` would evaluate
// app.js — and config/supabase.js underneath it, which reads process.env and
// calls process.exit(1) on a missing or wrong-role key — BEFORE dotenv had read
// .env and before assertEnv() could give its own, better diagnosis.
//
// So only these two are static. Everything else is imported dynamically, after
// the environment is loaded and checked. The top-level await is the guarantee.
import 'dotenv/config';
import { assertEnv } from './config/env.js';

// Before anything else: refuse to boot on a config that would fail silently.
assertEnv();

const { createServer } = await import('node:http');
const { Server } = await import('socket.io');
const { default: app } = await import('./app.js');
const { setupSocketHandlers } = await import('./socket/handler.js');
const settlementScheduler = await import('./services/settlementScheduler.js');

const PORT = process.env.PORT || 5000;

// Create HTTP server
const server = createServer(app);

// Attach Socket.io
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Make io accessible to routes via app
app.set('io', io);

// Set up socket handlers
setupSocketHandlers(io);

// Settlement scheduler: reconciles pending MoMo transactions and releases
// escrowed order funds once their hold window elapses. Safe to run even
// if MoMo env vars aren't configured yet — it just won't find anything to
// reconcile (no mobile_money orders will exist without collection creds).
settlementScheduler.start();

// Start server
server.listen(PORT, () => {
  console.log(`\n  Restaurant OS Server`);
  console.log(`  ────────────────────`);
  console.log(`  API:    http://localhost:${PORT}/api`);
  console.log(`  Health: http://localhost:${PORT}/api/health`);
  console.log(`  Mode:   ${process.env.NODE_ENV || 'development'}\n`);
});