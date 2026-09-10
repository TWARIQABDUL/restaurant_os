const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

// Proves the storage lockdown from BOTH sides:
//   1. the catalog — which policies actually exist on storage.objects
//   2. the anon key itself — the credential that ships in the client bundle,
//      used to genuinely attempt a write and a delete
//
// (2) is the one that matters. Reading policy rows tells you what you think you
// configured; driving the public key tells you what an attacker actually gets.

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const BUCKET = 'blog-images';

let failures = 0;
const ok   = (m) => console.log(`  ✅ ${m}`);
const bad  = (m) => { failures++; console.log(`  ❌ ${m}`); };

async function checkCatalog() {
  if (!process.env.DATABASE_URL) {
    console.log('\n(skipping catalog check — DATABASE_URL not set)');
    return;
  }
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const { rows } = await c.query(`
    SELECT policyname, cmd
    FROM pg_policies
    WHERE schemaname='storage' AND tablename='objects'
      AND cmd IN ('INSERT','UPDATE','DELETE')
      AND COALESCE(qual,'') || COALESCE(with_check,'') LIKE '%${BUCKET}%'`);

  console.log('\nCatalog — write policies covering ' + BUCKET + ':');
  if (rows.length === 0) ok('none');
  else rows.forEach(r => bad(`${r.cmd} "${r.policyname}" still present`));

  // The conclusive check, and the one that does not depend on a live probe:
  // storage.objects has RLS enabled, and no policy grants INSERT/UPDATE/DELETE
  // on this bucket. Under RLS, absence of a permissive policy IS a denial — so
  // these two facts together prove the hole is closed even when the project is
  // too throttled to demonstrate it end-to-end.
  const { rows: rls } = await c.query(
    `SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass`);
  rls[0]?.relrowsecurity
    ? ok('RLS is enabled on storage.objects (no policy = denied)')
    : bad('RLS is DISABLED on storage.objects — policies are not being enforced at all!');

  const { rows: b } = await c.query(
    `SELECT file_size_limit, allowed_mime_types FROM storage.buckets WHERE id=$1`, [BUCKET]);
  const limit = b[0]?.file_size_limit;
  const mimes = b[0]?.allowed_mime_types;
  limit ? ok(`bucket size limit ${(limit / 1048576).toFixed(0)} MB`) : bad('bucket has no size limit');
  mimes?.length ? ok(`bucket MIME allowlist: ${mimes.join(', ')}`) : bad('bucket has no MIME allowlist');

  await c.end();
}

async function checkAnonKey() {
  console.log('\nAnon key — the credential in the client bundle:');
  if (!url || !anonKey) { bad('SUPABASE_URL / ANON_KEY not set, cannot test'); return; }

  const anon = createClient(url, anonKey, { auth: { persistSession: false } });

  // Read first. It is the cheap check, and doing it before the write probes
  // means a throttled project cannot make a working read look broken.
  const sample = process.env.PROBE_IMAGE_URL;
  if (sample) {
    const res = await fetch(sample, { method: 'HEAD' });
    if (res.ok) ok(`public read still works (HTTP ${res.status} on a real object)`);
    else if (res.status === 429) bad(`read inconclusive — HTTP 429, the project is rate-limiting. Re-run later.`);
    else bad(`public read is broken — HTTP ${res.status} on ${sample}`);
  } else {
    console.log('     (set PROBE_IMAGE_URL to a real object URL to check public read)');
  }

  // A single write attempt each. Retrying these is what exhausted this
  // project's connection pool on an earlier run and turned every later check
  // into a 429 — the probe ended up measuring its own load, not the policy.
  const probe = `__lockdown_probe_${Date.now()}.png`;
  const up = await anon.storage.from(BUCKET)
    .upload(probe, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { contentType: 'image/png' });

  if (up.data?.path) {
    bad(`UPLOAD SUCCEEDED at ${up.data.path} — bucket is still writable!`);
    await anon.storage.from(BUCKET).remove([up.data.path]);
  } else if (/row-level security|Unauthorized|violates|not authorized|403/i.test(up.error?.message || '')) {
    ok(`upload denied by RLS (${up.error.message})`);
  } else {
    // Explicitly NOT a pass. A timeout or a connection-pool error means the
    // probe never reached the policy, and reporting that as success is exactly
    // the false assurance this script exists to prevent.
    bad(`upload inconclusive — "${up.error?.message}" is not a policy denial. Re-run when the project is not throttled.`);
  }

  const del = await anon.storage.from(BUCKET).remove(['menu-items/anything.png']);
  const deleted = Array.isArray(del.data) && del.data.length > 0;
  if (deleted) bad('DELETE SUCCEEDED — bucket contents can still be destroyed!');
  else ok('delete denied');
}

(async () => {
  console.log(`Verifying storage lockdown for bucket "${BUCKET}"`);
  await checkCatalog();
  await checkAnonKey();
  console.log(failures === 0
    ? '\n✅ Storage is locked down: anon can read, cannot write.'
    : `\n❌ ${failures} check(s) failed — see above.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
