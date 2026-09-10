require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Applies supabase/lockdown-anon.sql — revokes anon/authenticated access to
// schema public and enables RLS on every table.
//
// This is a one-way door for the anon key: once it runs, anything still
// talking to the database with that key stops working. So the script refuses
// to proceed unless the backend has already been switched to the service-role
// key, and it makes you confirm.
//
// Order of operations:
//   1. Set SUPABASE_SERVICE_ROLE_KEY in server/.env AND in Render
//   2. Deploy / restart the API, smoke-test it
//   3. node scripts/run-lockdown.js
//   4. node scripts/verify-lockdown.js

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('\n❌ DATABASE_URL is missing in server/.env');
  process.exit(1);
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(`
❌ SUPABASE_SERVICE_ROLE_KEY is not set.

   The backend is still authenticating with the public anon key. Running the
   lockdown now would revoke that key's access and take the whole API down.

   Get the key from: Supabase Dashboard → Project Settings → API → service_role
   Add it to server/.env (and to Render), restart the API, confirm it works —
   then run this again.
`);
  process.exit(1);
}

const confirmed = process.argv.includes('--yes');
if (!confirmed) {
  console.log(`
⚠️  This revokes all anon/authenticated access to schema public and enables
   RLS on every table. Anything still using the anon key will break.

   Confirm the API is deployed and working on the service-role key first.

   Re-run with:  node scripts/run-lockdown.js --yes
`);
  process.exit(1);
}

const client = new Client({
  connectionString,
  // Supabase needs SSL and presents a cert this client has no CA for.
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log('🔌 Connecting to database…');
  await client.connect();
  console.log('✅ Connected\n');

  const full = path.resolve(__dirname, '../../supabase/lockdown-anon.sql');
  if (!fs.existsSync(full)) {
    console.error(`❌ Not found: ${full}`);
    process.exitCode = 1;
    return client.end();
  }

  // Log NOTICEs from the SQL's self-check so the counts are visible.
  client.on('notice', (n) => console.log(`   ${n.message}`));

  try {
    process.stdout.write('⏳ Applying lockdown-anon.sql …\n');
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(full, 'utf8'));
      await client.query('COMMIT');
      console.log('\n🔒 Lockdown applied. The public anon key can no longer reach your tables.');
      console.log('   Next: node scripts/verify-lockdown.js');
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('❌ rolled back — nothing changed');
      throw err;
    }
  } catch (err) {
    console.error('\n❌', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
