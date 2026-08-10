require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;

const client = new Client({
  connectionString,
});

async function main() {
  console.log('🔌 Connecting to Supabase database...');
  try {
    await client.connect();
    
    const fullPath = path.resolve(__dirname, '../../supabase/escalate.sql');
    const sql = fs.readFileSync(fullPath, 'utf8');
    
    console.log(`⏳ Executing escalate migration...`);
    await client.query(sql);
    console.log(`✅ Migration executed successfully!`);
    
  } catch (err) {
    console.error('\n❌ Connection error:', err.message);
  } finally {
    await client.end();
  }
}

main();
