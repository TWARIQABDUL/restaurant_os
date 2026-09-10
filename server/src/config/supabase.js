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

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  // No browser session to persist or refresh on a server.
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = supabase;
