const jwt = require('jsonwebtoken');

/**
 * Set up Socket.io event handlers.
 */
function setupSocketHandlers(io) {
  io.use((socket, next) => {
    try {
      // `ticket` is the current path: a 60s credential fetched from
      // /api/auth/socket-ticket, because the httpOnly session cookie can't be
      // read by the browser and isn't sent to this host anyway. `token` is the
      // pre-migration path — clients still holding a localStorage token — and
      // can be dropped once those are gone.
      const credential = socket.handshake.auth?.ticket || socket.handshake.auth?.token;
      if (credential) {
        const decoded = jwt.verify(credential, process.env.JWT_SECRET);
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
    // console.log(`Socket connected: ${socket.id}`);

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
      // console.log(`Socket disconnected: ${socket.id}`);
    });
  });
}

module.exports = { setupSocketHandlers };
