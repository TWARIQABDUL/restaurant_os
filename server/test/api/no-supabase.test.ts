// server/test/api/no-supabase.test.ts — milestone 11.
//
// Milestone 11's done-when, first clause: "The server boots against the local container
// with NO SUPABASE-JS IN THE PATH."
//
// Asserted by walking the import graph from the entrypoint rather than by grepping the
// directory, because the claim is about what the running process loads. A supabase
// import in a file nobody reaches is not in the path; one three modules deep in
// something the app does reach is, and a grep of src/ cannot tell those apart — the
// legacy app and its sixteen routers are still there and still import it.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '../..');
const ENTRYPOINT = path.join(SERVER_ROOT, 'src/api/server.ts');

const FORBIDDEN = ['@supabase/supabase-js', '@supabase/'];

/**
 * Every `import`/`export … from` specifier in a module, plus dynamic `import()`.
 *
 * A regex rather than a parser: these files are the ones this milestone wrote, they are
 * plain ESM, and a dependency on a TypeScript AST to prove an architectural property is
 * a dependency that can itself drift. The dynamic-import case is included because it is
 * the one way a module could reach supabase without a static import — so if a later
 * change tries it, this catches it.
 */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^;'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?[^;'"]*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push(specifier);
    }
  }
  return found;
}

/** Node's own resolution, narrowed to what these files use: explicit relative paths. */
async function resolveLocal(fromFile: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith('.')) return null;

  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];

  // TypeScript's NodeNext rewriting: './m.js' in a .ts file may mean './m.ts'.
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);

  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

type Graph = { files: string[]; bare: Map<string, string[]> };

async function walk(entry: string): Promise<Graph> {
  const seen = new Set<string>();
  const bare = new Map<string, string[]>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    const source = await readFile(file, 'utf8');

    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith('.')) {
        const resolved = await resolveLocal(file, specifier);
        assert.ok(
          resolved !== null,
          `${path.relative(SERVER_ROOT, file)} imports '${specifier}', which does not resolve to a file`,
        );
        queue.push(resolved);
      } else if (!specifier.startsWith('node:')) {
        const importers = bare.get(specifier) ?? [];
        importers.push(path.relative(SERVER_ROOT, file));
        bare.set(specifier, importers);
      }
    }
  }

  return { files: [...seen], bare };
}

describe('the new server has no supabase-js in its path', () => {
  it('nothing reachable from src/api/server.ts imports it', async () => {
    const graph = await walk(ENTRYPOINT);

    const offenders: string[] = [];
    for (const [specifier, importers] of graph.bare) {
      if (FORBIDDEN.some((f) => specifier === f || specifier.startsWith(f))) {
        offenders.push(`${specifier} ← ${importers.join(', ')}`);
      }
    }

    assert.deepEqual(offenders, [], `supabase reached from the new entrypoint:\n  ${offenders.join('\n  ')}`);

    // And the graph is not trivially small — a walk that resolved nothing would also
    // find no supabase.
    assert.ok(
      graph.files.length >= 15,
      `expected the graph to cover the new stack; it found ${graph.files.length} files`,
    );
  });

  it('nothing reachable from it imports config/supabase.js either', async () => {
    const graph = await walk(ENTRYPOINT);
    const offenders = graph.files.filter((f) => f.endsWith(path.join('config', 'supabase.js')));
    assert.deepEqual(offenders, []);
  });

  it('the legacy app still does — which is why this is a graph walk and not a grep', async () => {
    // If this ever stops being true, the legacy server has already been retired and
    // this test has done its job.
    const legacy = await walk(path.join(SERVER_ROOT, 'src/app.js'));
    const usesSupabase = [...legacy.bare.keys()].some((k) => k.startsWith('@supabase/'));
    assert.equal(usesSupabase, true, 'server/src/app.js is expected to still be on supabase-js');
  });

  it('the new stack reaches pg', async () => {
    const graph = await walk(ENTRYPOINT);
    assert.ok(graph.bare.has('pg'), 'it talks to Postgres directly');
  });
});
