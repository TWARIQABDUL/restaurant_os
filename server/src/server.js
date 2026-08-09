require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const { setupSocketHandlers } = require('./socket/handler');
const settlementScheduler = require('./services/settlementScheduler');

const PORT = process.env.PORT || 5000;

// Create HTTP server
const server = http.createServer(app);

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