require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// To run this script, you will need your Supabase Database Connection String.
// You can find it in Supabase Dashboard -> Project Settings -> Database -> Connection string -> URI
// Add it to your server/.env file as: DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@...
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('\n❌ Error: DATABASE_URL is missing in your .env file.');
  console.error('Please add your Supabase connection string (URI) to your .env file.');
  console.error('Example: DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.xxxx.supabase.co:5432/postgres\n');
  process.exit(1);
}

const client = new Client({
  connectionString,
});

async function runSqlFile(filePath, label) {
  try {
    const fullPath = path.resolve(__dirname, '../../supabase', filePath);
    console.log(`\n📄 Reading ${label} from ${fullPath}...`);
    
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const sql = fs.readFileSync(fullPath, 'utf8');
    
    console.log(`⏳ Executing ${label}...`);
    await client.query(sql);
    console.log(`✅ ${label} executed successfully!`);
    
  } catch (error) {
    console.error(`\n❌ Error executing ${label}:`, error.message);
    process.exit(1);
  }
}

async function main() {
  console.log('🔌 Connecting to Supabase database...');
  
  try {
    await client.connect();
    console.log('✅ Connected successfully!');
    
    // 1. Run Schema
    await runSqlFile('schema.sql', 'Database Schema');
    
    // 2. Run Seed Data
    await runSqlFile('seed.sql', 'Seed Data');
    
    console.log('\n🎉 All SQL scripts executed successfully! Your database is ready.');
    
  } catch (err) {
    console.error('\n❌ Connection error:', err.message);
  } finally {
    await client.end();
  }
}

main();
