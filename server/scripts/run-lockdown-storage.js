const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');
const fs = require('fs');

// Closes storage writes to the public anon key. See supabase/lockdown-storage.sql.
//
// ⚠️  Order matters: deploy the API (routes/uploads.js) and the client that
// uses it FIRST. Between running this and that deploy landing, image upload is
// broken — reads are unaffected, so existing images keep rendering throughout.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('\n❌ Error: DATABASE_URL is missing in your .env file.');
  process.exit(1);
}

const client = new Client({ connectionString });

async function main() {
  console.log('🔌 Connecting to Supabase database...');
  try {
    await client.connect();
    const fullPath = path.resolve(__dirname, '../../supabase/lockdown-storage.sql');
    const sql = fs.readFileSync(fullPath, 'utf8');

    console.log('⏳ Revoking public write access to storage...');
    await client.query(sql);
    console.log('✅ Storage writes are now closed to anon. Uploads go through /api/uploads/image-url.');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
main();
