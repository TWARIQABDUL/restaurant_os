import { io } from 'socket.io-client';
import api from './api';

// Socket.io talks to the API host directly rather than through the same-origin
// /api rewrite, because static-site rewrites don't carry WebSocket upgrades.
// That makes it cross-site, so the session cookie isn't sent — hence the ticket
// below. Empty string means same origin, for local dev behind the Vite proxy.
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL.replace(/\/api\/?$/, '') : '');

let socket = null;

/**
 * Opens the socket for the signed-in user.
 *
 * The session cookie is httpOnly, so there's no token to hand the handshake.
 * Instead we present a 60-second ticket fetched from the API, authenticated by
 * that cookie.
 *
 * Socket.io's async `auth` callback does the fetching, which matters twice
 * over: the socket is created synchronously so `getSocket()` is never
 * transiently null, and the callback runs again on every reconnect — so a
 * dropped connection gets a fresh ticket instead of retrying with an expired
 * one.
 */
export function connectSocket() {
  if (socket?.connected) return socket;

  socket = io(SOCKET_URL, {
    auth: (cb) => {
      api.get('/auth/socket-ticket')
        .then(({ data }) => cb({ ticket: data.ticket }))
        // Not signed in, or the session expired. Connect as a guest — tracking
        // an order by code still works.
        .catch(() => cb({}));
    },
    transports: ['websocket', 'polling'],
    withCredentials: true,
  });

  socket.on('connect', () => {
    console.log('Socket connected:', socket.id);
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected');
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function getSocket() {
  return socket;
}

export default { connectSocket, disconnectSocket, getSocket };
