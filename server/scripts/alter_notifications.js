const { Client } = require('pg');
require('dotenv').config({ path: '/home/abdalazizi/restaurant_os/server/.env' });

async function addActionUrl() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('Connected to DB');
    
    await client.query(`
      ALTER TABLE notifications 
      ADD COLUMN IF NOT EXISTS action_url VARCHAR(255);
    `);
    console.log('action_url column added successfully');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

addActionUrl();
