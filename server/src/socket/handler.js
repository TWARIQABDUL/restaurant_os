const jwt = require('jsonwebtoken');

/**
 * Set up Socket.io event handlers.
 */
function setupSocketHandlers(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.userId;
        socket.tenantId = decoded.tenantId;
        socket.userRole = decoded.role;
      }
      next();
    } catch {
      // Allow connection even without auth (for guests tracking orders)
      next();
    }
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Authenticated users join their personal room
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);

      // Join role-based rooms for the tenant
      if (socket.tenantId) {
        if (socket.userRole === 'manager') {
          socket.join(`tenant:${socket.tenantId}:managers`);
        }
        if (socket.userRole === 'admin') {
          socket.join(`tenant:${socket.tenantId}:admins`);
        }
      }
    }

    // Guests can join a tracking room
    socket.on('trackOrder', (trackingCode) => {
      if (trackingCode) {
        socket.join(`tracking:${trackingCode}`);
      }
    });

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
}

module.exports = { setupSocketHandlers };
