const { createClient } = require('@supabase/supabase-js');

// The backend authenticates with the SERVICE-ROLE key, never the anon key.
//
// The anon key is public by design — it ships inside the client bundle, so any
// visitor has it. It is meant to be constrained by RLS and minimal grants, and
// is not a server credential. Running the backend on it meant every JWT check
// and role guard in this codebase could be bypassed by talking to PostgREST
// directly.
//
// service_role bypasses RLS, which is exactly why it must stay server-side:
// never expose it to the client, and never give it a VITE_ prefix (Vite
// inlines any VITE_* variable into the browser bundle).
//
// The URL is not a secret. VITE_SUPABASE_URL is accepted as a fallback so
// existing deployments keep working without an env rename.
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.error('Missing SUPABASE_URL (or VITE_SUPABASE_URL) in environment variables');
  process.exit(1);
}

if (!serviceRoleKey) {
  console.error(
    '\nMissing SUPABASE_SERVICE_ROLE_KEY.\n\n' +
    '  The server must not run on the public anon key. Get the service_role key\n' +
    '  from: Supabase Dashboard → Project Settings → API, and set it in server/.env\n' +
    '  (and in your host\'s environment). Do not prefix it with VITE_.\n'
  );
  process.exit(1);
}

// Refuse to boot on a key that is not service-role. A Supabase key is a JWT
// whose payload carries its role, so this catches an anon key pasted into the
// service-role variable — a mistake that would otherwise fail silently once
// the anon key's grants are revoked.
try {
  const payload = JSON.parse(Buffer.from(serviceRoleKey.split('.')[1], 'base64').toString());
  if (payload.role && payload.role !== 'service_role') {
    console.error(
      `\nSUPABASE_SERVICE_ROLE_KEY holds a "${payload.role}" key, not a service_role key.\n` +
      '  Copy the service_role secret from Project Settings → API.\n'
    );
    process.exit(1);
  }
} catch {
  // Not a decodable JWT (self-hosted or a future key format) — let it through
  // rather than blocking boot on a format assumption.
}

// Every Supabase call is an HTTPS request, and supabase-js applies no timeout
// of its own — so when the Supabase API is unreachable (its REST service can be
// down while Postgres itself is perfectly healthy), requests hang indefinitely.
// Node's default socket has no timeout either, so they hang until the hosting
// platform's gateway gives up, which surfaces to users as a 502 and leaves the
// request occupying a worker the whole time.
//
// A bounded timeout turns that into a fast, honest failure: the route's error
// handler answers immediately, and the process stays responsive.
const REQUEST_TIMEOUT_MS = parseInt(process.env.SUPABASE_TIMEOUT_MS || '8000', 10);

// Marker carried in the error message so callers can recognise this case even
// though supabase-js hands errors back as data rather than throwing them.
const UPSTREAM_TIMEOUT_MARKER = 'SUPABASE_UPSTREAM_TIMEOUT';

function timeoutFetch(url, options = {}) {
  // Respect a caller-supplied signal if there ever is one, but always impose
  // our own ceiling on top of it.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  return fetch(url, { ...options, signal }).catch((err) => {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      const e = new Error(
        `${UPSTREAM_TIMEOUT_MARKER}: no response within ${REQUEST_TIMEOUT_MS}ms`
      );
      // postgrest-js retries a failed fetch up to three times UNLESS the error
      // looks like an abort — it checks `name === 'AbortError'` and rethrows
      // straight away. Keeping that name is what makes our timeout a real
      // ceiling instead of one that gets multiplied by the retry count.
      e.name = 'AbortError';
      e.code = 'SUPABASE_TIMEOUT';
      throw e;
    }
    throw err;
  });
}

/**
 * True when a Supabase call failed because the API never answered.
 *
 * Needed because supabase-js resolves with `{ data: null, error }` rather than
 * throwing, so a timeout arrives as an ordinary-looking query error and would
 * otherwise be misread as "no rows" — which is how an outage turns into a
 * confusing "Store not found" instead of an honest "try again".
 */
function isUpstreamTimeout(error) {
  if (!error) return false;
  if (error.code === 'SUPABASE_TIMEOUT') return true;
  return typeof error.message === 'string' && error.message.includes(UPSTREAM_TIMEOUT_MARKER);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  // No browser session to persist or refresh on a server.
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: timeoutFetch },
});

module.exports = supabase;
module.exports.isUpstreamTimeout = isUpstreamTimeout;
module.exports.UPSTREAM_TIMEOUT_MARKER = UPSTREAM_TIMEOUT_MARKER;
