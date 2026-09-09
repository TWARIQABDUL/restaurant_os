require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Applies the "general commerce" upgrade batch, in order:
//   1. generalize-catalogue.sql — drop the food-only option-category CHECK
//   2. categories.sql           — managed categories + option scoping
//   3. inventory.sql            — stock tracking + reserve/release functions
//
// Every file is written to be safely re-runnable, and each runs in its own
// transaction here, so a failure rolls that file back cleanly.

const FILES = [
  ['generalize-catalogue.sql', 'Catalogue generalisation'],
  ['categories.sql', 'Categories & option scoping'],
  ['inventory.sql', 'Inventory'],
  ['option-sizes.sql', 'Single-choice options + option stock'],
  ['product-variants.sql', 'Per-product variants'],
];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('\n❌ DATABASE_URL is missing in server/.env');
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

  try {
    for (const [file, label] of FILES) {
      const full = path.resolve(__dirname, '../../supabase', file);
      if (!fs.existsSync(full)) throw new Error(`Not found: ${full}`);
      process.stdout.write(`⏳ ${label} (${file}) … `);
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(full, 'utf8'));
        await client.query('COMMIT');
        console.log('✅');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('❌ rolled back');
        throw err;
      }
    }
    console.log('\n🎉 All migrations applied. The database is ready.');
  } catch (err) {
    console.error('\n❌', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
