const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');
const fs = require('fs');

// Closes storage writes to the public anon key. See supabase/lockdown-storage.sql.
//
// ⚠️  Order matters: deploy the API (routes/uploads.js) and the client that
// uses it FIRST. Between running this and that deploy landing, image upload is
// broken — reads are unaffected, so existing images keep rendering throughout.
//
// Why this runs statement-by-statement rather than sending the file as one
// query:
//
//   DROP POLICY needs an ACCESS EXCLUSIVE lock on storage.objects. This
//   database has lock_timeout = 0 (wait forever) and statement_timeout = 2min,
//   so a single busy moment means the DROP queues behind whatever holds the
//   table, burns the full two minutes, and the whole file is cancelled — a
//   multi-statement query runs in one implicit transaction, so everything
//   rolls back and nothing is applied.
//
//   Each statement is therefore sent on its own, with a short lock_timeout so
//   it fails fast instead of queuing, and retried a few times. Progress is kept
//   between statements, and the file is written to be re-runnable.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('\n❌ Error: DATABASE_URL is missing in your .env file.');
  process.exit(1);
}

const LOCK_TIMEOUT = '5s';
const STATEMENT_TIMEOUT = '120s';
const MAX_ATTEMPTS = 6;
const RETRY_DELAY_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Split on semicolons at the top level only, so the DO $$ ... $$ blocks (which
 * contain their own semicolons) stay intact.
 */
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;

  // A semicolon only ends a statement when it is plain SQL text. Skip over the
  // four places one can legitimately appear: line comments, block comments,
  // string literals, quoted identifiers, and dollar-quoted bodies.
  while (i < sql.length) {
    const rest = sql.slice(i);

    // -- line comment, through end of line
    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? sql.length : nl + 1;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // /* block comment */ (Postgres nests these)
    if (rest.startsWith('/*')) {
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.startsWith('/*', j)) { depth++; j += 2; }
        else if (sql.startsWith('*/', j)) { depth--; j += 2; if (depth === 0) break; }
        else j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }

    // $tag$ ... $tag$ dollar-quoted body
    const dollar = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const stop = close === -1 ? sql.length : close + tag.length;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // 'string literal' or "quoted identifier", doubling the quote to escape
    if (rest[0] === "'" || rest[0] === '"') {
      const q = rest[0];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === q) {
          if (sql[j + 1] === q) { j += 2; continue; }  // '' escape
          j++;
          break;
        }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }

    if (sql[i] === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      i++;
      continue;
    }

    buf += sql[i];
    i++;
  }

  if (buf.trim()) out.push(buf.trim());

  // Drop fragments that are only comments/whitespace.
  return out.filter((s) => s.split('\n').some((l) => {
    const t = l.trim();
    return t && !t.startsWith('--');
  }));
}

/** First meaningful line, for progress output. */
function label(stmt) {
  const line = stmt.split('\n').find((l) => l.trim() && !l.trim().startsWith('--')) || stmt;
  return line.trim().slice(0, 78);
}

async function main() {
  const client = new Client({ connectionString });
  console.log('🔌 Connecting to Supabase database...');
  await client.connect();

  await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
  await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
  console.log(`   lock_timeout=${LOCK_TIMEOUT} statement_timeout=${STATEMENT_TIMEOUT}\n`);

  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/lockdown-storage.sql'), 'utf8');
  const statements = splitStatements(sql);
  console.log(`⏳ Applying ${statements.length} statements...\n`);

  let failed = 0;

  for (const [i, stmt] of statements.entries()) {
    const tag = `[${String(i + 1).padStart(2)}/${statements.length}]`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await client.query(stmt);
        console.log(`${tag} ✅ ${label(stmt)}`);
        break;
      } catch (err) {
        const isLock = err.code === '55P03' || err.code === '57014' ||
                       /lock timeout|statement timeout/i.test(err.message);

        if (isLock && attempt < MAX_ATTEMPTS) {
          console.log(`${tag} ⏳ ${label(stmt)}`);
          console.log(`      locked by another session, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${RETRY_DELAY_MS / 1000}s...`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        failed++;
        console.error(`${tag} ❌ ${label(stmt)}`);
        console.error(`      ${err.message}`);
        if (isLock) {
          console.error('      Still locked after every retry. Something is holding storage.objects —');
          console.error('      an open transaction, or a long-running query. Check with:');
          console.error("        SELECT pid, state, query FROM pg_stat_activity WHERE query ILIKE '%storage.objects%';");
        }
        break;
      }
    }
  }

  await client.end();

  if (failed > 0) {
    console.error(`\n❌ ${failed} statement(s) did not apply. This file is safe to re-run.`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ Storage writes are now closed to anon. Uploads go through /api/uploads/image-url.');
    console.log('   Verify with: node scripts/verify-storage-lockdown.js');
  }
}

main().catch((err) => {
  console.error('\n❌ Migration failed:', err.message);
  process.exitCode = 1;
});
