const { Client } = require('pg');
require('dotenv').config({ path: '../server/.env' });

async function addColumns() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('Connected to DB');
    
    // Add columns if they don't exist
    await client.query(`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS delivery_type VARCHAR(20) DEFAULT 'internal',
      ADD COLUMN IF NOT EXISTS external_rider_info JSONB;
    `);
    console.log('Columns added successfully');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

addColumns();
