const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

/**
 * Set up Socket.io event handlers.
 */
function setupSocketHandlers(io) {
  io.use(async (socket, next) => {
    try {
      // `ticket` is the current path: a 60s credential fetched from
      // /api/auth/socket-ticket, because the httpOnly session cookie can't be
      // read by the browser and isn't sent to this host anyway. `token` is the
      // pre-migration path — clients still holding a localStorage token — and
      // can be dropped once those are gone.
      const credential = socket.handshake.auth?.ticket || socket.handshake.auth?.token;
      if (credential) {
        const decoded = jwt.verify(credential, process.env.JWT_SECRET);

        // Role and tenant come from the row, never from the token's claims.
        // A socket outlives the request that opened it, so trusting the claims
        // meant a demoted or deleted staff member kept receiving their old
        // tenant's live order feed until the token expired — up to
        // JWT_EXPIRES_IN, 24h by default. This is the same DB re-read the HTTP
        // path does in middleware/auth.js, and for the same reason.
        const { data: user } = await supabase
          .from('users')
          .select('id, tenant_id, role')
          .eq('id', decoded.userId)
          .single();

        if (user) {
          socket.userId = user.id;
          socket.tenantId = user.tenant_id;
          socket.userRole = user.role;
        }
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

    // Guests can join a tracking room.
    //
    // Nothing is emitted to these rooms today, but the join used to accept any
    // string from an unauthenticated socket — so the first time someone adds an
    // emit here, it would have leaked to anyone who guessed a code. Verify the
    // code actually exists before joining, and normalise it so the room name
    // matches what a publisher would use.
    socket.on('trackOrder', async (trackingCode) => {
      const code = String(trackingCode || '').trim().toUpperCase();
      if (!/^ORD-[A-Z0-9]{6}$/.test(code)) return;

      const { data: order } = await supabase
        .from('orders')
        .select('id')
        .eq('tracking_code', code)
        .maybeSingle();

      if (order) socket.join(`tracking:${code}`);
    });

    socket.on('disconnect', () => {
      // console.log(`Socket disconnected: ${socket.id}`);
    });
  });
}

module.exports = { setupSocketHandlers };
