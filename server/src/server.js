require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const { setupSocketHandlers } = require('./socket/handler');

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

// Start server
server.listen(PORT, () => {
  console.log(`\n  Restaurant OS Server`);
  console.log(`  ────────────────────`);
  console.log(`  API:    http://localhost:${PORT}/api`);
  console.log(`  Health: http://localhost:${PORT}/api/health`);
  console.log(`  Mode:   ${process.env.NODE_ENV || 'development'}\n`);
});
