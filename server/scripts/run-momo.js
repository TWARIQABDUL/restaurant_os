require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('\n❌ Error: DATABASE_URL is missing in your .env file.');
  process.exit(1);
}

const client = new Client({
  connectionString,
});

async function main() {
  console.log('🔌 Connecting to Supabase database...');
  
  try {
    await client.connect();
    console.log('✅ Connected successfully!');
    
    const fullPath = path.resolve(__dirname, '../../supabase/momo.sql');
    console.log(`\n📄 Reading MoMo Wallet Schema from ${fullPath}...`);
    
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const sql = fs.readFileSync(fullPath, 'utf8');
    
    console.log(`⏳ Executing MoMo Wallet Schema...`);
    await client.query(sql);
    console.log(`✅ MoMo Wallet Schema executed successfully!`);
    
  } catch (err) {
    console.error('\n❌ Error:', err.message);
  } finally {
    await client.end();
  }
}

main();
