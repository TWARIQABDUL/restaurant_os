#!/usr/bin/env node
/**
 * The hardening gate — milestone 31 of docs/migration/04-implementation-plan.md.
 *
 * The plan's bars for the new code, made executable so they stay true:
 *
 *   1. No `.from()` outside repositories — the old data layer was supabase-js, `supabase.from('table')` anywhere. The new server
 *      has no such import and no such call; this fails the build if one appears.
 *   2. No `SELECT *` — the pool refuses it at run time; this catches it before anything runs, including in files the tests
 *      do not reach.
 *   3. No OFFSET paging except where it has been measured and accepted. A growing list pages by keyset (§2.3); a new OFFSET must
 *      be added to ACCEPTED below, WITH the measurement that justifies it.
 *
 *   npm run check:bars
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const NEW_SERVER = path.join(REPO, 'server', 'src');

/** The old (JavaScript) server is the live system until cutover; the bars apply to the rewrite, which is TypeScript. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** OFFSET uses that were MEASURED and accepted (milestone 31, against the 30,019-order seed). Anything else fails. */
const ACCEPTED: Record<string, string> = {
  'repositories/products.ts':
    'the merchant product list: 17 products in the seed store; page 1 of every sort costs 3.5–5 ms. A catalogue is hundreds, not millions, and the board shows page numbers.',
  'repositories/merchantCustomers.ts':
    'the customer list: its cost is the per-request aggregation of the store’s orders (≈200 ms at 21,445 orders, identical on page 1 and page 200), not the OFFSET; keyset would change nothing measurable. Revisit with a summary table if a store passes ~100k orders.',
};

const problems: string[] = [];
for (const file of walk(NEW_SERVER)) {
  const rel = path.relative(NEW_SERVER, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    const trimmed = line.trim();
    const inComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
    if (/from ['"]@supabase\//.test(line) || /\bsupabase\.from\(/.test(code) || /\bsupabase\b.*\.from\(['"`]/.test(code)) {
      problems.push(`${rel}:${i + 1}  a supabase-js call — the rewrite talks to Postgres through repositories only`);
    }
    if (!inComment && /\bSELECT\s+\*/i.test(code) && !rel.startsWith('db/pool.ts')) {
      problems.push(`${rel}:${i + 1}  SELECT * — name the columns (§2.3)`);
    }
    if (!inComment && /\bOFFSET\b/.test(code) && /LIMIT/i.test(code + (lines[i - 1] ?? '')) && ACCEPTED[rel] === undefined) {
      problems.push(`${rel}:${i + 1}  OFFSET paging — page by keyset, or measure it and add it to ACCEPTED in scripts/check-bars.ts`);
    }
  });
}

// An ACCEPTED entry for a file that no longer uses OFFSET is stale, and stale exceptions are how a bar erodes.
for (const rel of Object.keys(ACCEPTED)) {
  const text = readFileSync(path.join(NEW_SERVER, rel), 'utf8');
  if (!/\bOFFSET\b/.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) problems.push(`${rel}  is in ACCEPTED but no longer uses OFFSET — remove it`);
}

if (problems.length > 0) {
  console.error(`The hardening bars are broken (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Hardening bars hold: no supabase-js, no SELECT *, OFFSET only where measured (${Object.keys(ACCEPTED).length} accepted).`);
