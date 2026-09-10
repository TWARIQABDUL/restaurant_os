const jwt = require('jsonwebtoken');

// The session token lives in an httpOnly cookie, so a stolen-by-XSS token is no
// longer possible — script on the page cannot read it. During the migration the
// Authorization header is still accepted (see readToken) so already-signed-in
// users aren't logged out by the deploy; that fallback can be removed once
// traffic has moved over.

const COOKIE_NAME = 'session';

/** '24h' | '30m' | '90s' | '7d' → seconds. Falls back to 24h. */
function ttlSeconds() {
  const raw = String(process.env.JWT_EXPIRES_IN || '24h').trim();
  const m = /^(\d+)\s*([smhd])?$/.exec(raw);
  if (!m) return 24 * 60 * 60;
  const n = parseInt(m[1], 10);
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's'];
}

function cookieOptions() {
  return {
    httpOnly: true,
    // The browser reaches the API through a same-origin rewrite (/api/* on the
    // client site proxies to this service), so a plain Lax cookie is delivered
    // on every request without needing SameSite=None — which Safari blocks and
    // Chrome is retiring.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ttlSeconds() * 1000,
  };
}

/** Signs a session token, sets it as an httpOnly cookie, and returns it. */
function issueSession(res, user) {
  const token = jwt.sign(
    { userId: user.id, tenantId: user.tenant_id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: ttlSeconds() }
  );
  res.cookie(COOKIE_NAME, token, cookieOptions());
  return token;
}

function clearSession(res) {
  // maxAge must be absent for the clear to match the original cookie.
  const { maxAge, ...opts } = cookieOptions();
  res.clearCookie(COOKIE_NAME, opts);
}

/**
 * The request's bearer token: cookie first, Authorization header second.
 *
 * The header path exists only so clients holding a pre-migration token keep
 * working. Remove it — and this comment — once none are left.
 */
function readToken(req) {
  const fromCookie = req.cookies?.[COOKIE_NAME];
  if (fromCookie) return fromCookie;

  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);

  return null;
}

// ── Socket tickets ─────────────────────────────────────────────────────────
// Render's static-site rewrites don't proxy WebSockets, so Socket.io connects
// straight to the API host — which is cross-site, so the session cookie is not
// sent. Instead the client asks an authenticated endpoint for a short-lived
// ticket and hands that to the handshake. The window is small enough that a
// leaked ticket is near-worthless, and it is never a session token: `typ`
// separates the two so neither can be used where the other is expected.

const SOCKET_TICKET_TTL_SECONDS = 60;

function issueSocketTicket(user) {
  return jwt.sign(
    { userId: user.id, tenantId: user.tenant_id, role: user.role, typ: 'socket' },
    process.env.JWT_SECRET,
    { expiresIn: SOCKET_TICKET_TTL_SECONDS }
  );
}

module.exports = {
  COOKIE_NAME,
  issueSession,
  clearSession,
  readToken,
  issueSocketTicket,
  SOCKET_TICKET_TTL_SECONDS,
};
