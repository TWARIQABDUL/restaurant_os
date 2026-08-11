const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');
const fs = require('fs');

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
    const fullPath = path.resolve(__dirname, '../../supabase/refund.sql');
    const sql = fs.readFileSync(fullPath, 'utf8');
    
    console.log(`⏳ Executing refund migration...`);
    await client.query(sql);
    console.log(`✅ Migration executed successfully!`);
  } catch (err) {
    console.error('\n❌ Connection error:', err.message);
  } finally {
    await client.end();
  }
}
main();
