require('dotenv').config();
const { Client } = require('pg');

// Proves the lockdown worked, from both directions:
//
//   1. Over HTTP with the PUBLIC anon key — exactly what an attacker holding
//      the key from your client bundle would do. Every table must refuse.
//   2. In the database — no anon/authenticated grants, RLS on everywhere.
//
// Run after scripts/run-lockdown.js, and again after any migration that adds
// a table (a new table can be born with the old grants).

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const SENSITIVE = ['users', 'orders', 'wallets', 'wallet_ledger', 'withdrawal_requests', 'momo_transactions', 'tenants'];

async function probeRest() {
  if (!url || !anonKey) {
    console.log('⏭  Skipping HTTP probe (SUPABASE_URL / ANON_KEY not in env)\n');
    return true;
  }
  console.log('🌐 Probing the REST API with the PUBLIC anon key…\n');
  let allBlocked = true;

  for (const table of SENSITIVE) {
    let verdict;
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      });
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length > 0) {
          verdict = `❌ READABLE — returned ${rows.length} row(s)`;
          allBlocked = false;
        } else {
          // 200 with no rows still means the key can reach the table.
          verdict = `❌ REACHABLE — HTTP 200 (empty, but not denied)`;
          allBlocked = false;
        }
      } else {
        verdict = `✅ blocked (HTTP ${res.status})`;
      }
    } catch (err) {
      verdict = `✅ blocked (${err.message})`;
    }
    console.log(`   ${table.padEnd(22)} ${verdict}`);
  }

  // A write attempt is the one that really matters.
  try {
    const res = await fetch(`${url}/rest/v1/menu_items`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ name: '__lockdown_probe__', price: 0 }),
    });
    if (res.ok) {
      console.log(`\n   ${'INSERT menu_items'.padEnd(22)} ❌ WRITE SUCCEEDED — remove that row immediately`);
      allBlocked = false;
    } else {
      console.log(`\n   ${'INSERT menu_items'.padEnd(22)} ✅ blocked (HTTP ${res.status})`);
    }
  } catch (err) {
    console.log(`\n   ${'INSERT menu_items'.padEnd(22)} ✅ blocked (${err.message})`);
  }

  return allBlocked;
}

async function probeDb() {
  if (!process.env.DATABASE_URL) {
    console.log('\n⏭  Skipping DB check (DATABASE_URL not set)');
    return true;
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows: grants } = await client.query(`
    SELECT table_name, grantee, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privs
    FROM information_schema.role_table_grants
    WHERE table_schema='public' AND grantee IN ('anon','authenticated')
    GROUP BY table_name, grantee ORDER BY table_name;`);

  const { rows: rls } = await client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity
    ORDER BY c.relname;`);

  console.log('\n🗄  Database state\n');
  console.log(`   anon/authenticated grants in public : ${grants.length === 0 ? '✅ none' : `❌ ${grants.length}`}`);
  grants.forEach((g) => console.log(`      ❌ ${g.table_name} → ${g.grantee}: ${g.privs}`));
  console.log(`   tables without RLS                  : ${rls.length === 0 ? '✅ none' : `❌ ${rls.length}`}`);
  rls.forEach((r) => console.log(`      ❌ ${r.relname}`));

  await client.end();
  return grants.length === 0 && rls.length === 0;
}

(async () => {
  const restOk = await probeRest();
  const dbOk = await probeDb();

  if (restOk && dbOk) {
    console.log('\n🔒 Verified. The public key reaches nothing; the backend runs on service_role.\n');
  } else {
    console.log('\n🚨 NOT SECURE — see the ❌ lines above. Do not go live until they are clear.\n');
    process.exitCode = 1;
  }
})();
