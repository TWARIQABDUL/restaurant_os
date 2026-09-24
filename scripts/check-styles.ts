#!/usr/bin/env node
/**
 * The style gate — milestone 4 of docs/migration/04-implementation-plan.md.
 *
 * §2.2 is "Tailwind utilities only": no `@layer components`, no `@apply`, no
 * `:root` bridge. That is easy to agree to and easy to forget, so it is checked.
 *
 * Also checked: the boundary between the new token layer and the legacy
 * stylesheet. The legacy `src/index.css` cannot be deleted yet — 31 of the old
 * pages use 55 of its semantic classes, 542 times — so it stays until those pages
 * are rewritten in Stage D. What must hold in the meantime is that nothing new
 * reaches it, and that the new page's stylesheet contains none of it.
 *
 *   npm run check:styles                  source rules; skips built output
 *   npm run check:styles -- --require-dist  also assert on client/dist (CI, post-build)
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(REPO, 'client');
const LEGACY_CSS = path.join(CLIENT, 'src', 'index.css');

/** Directories holding NEW front-end code. Stage D adds storefront, merchant,
 *  admin and shared/ui; add them here as they land. */
const NEW_TREE = ['src/styles', 'src/gallery'];

const failures: string[] = [];
const notes: string[] = [];
const fail = (message: string) => failures.push(message);

function walk(dir: string, match: (f: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match(full)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(REPO, f);

/** Comments describe the rules; they must not trip them. A checker that flags
 *  prose about @apply is a checker someone switches off. */
const stripCssComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

// ---------------------------------------------------------------------------
// A. No @apply, anywhere.
// ---------------------------------------------------------------------------
// Repo-wide rather than scoped to the new tree, because the legacy stylesheet
// happens to contain none either — so the stricter rule costs nothing and cannot
// be worked around by putting the @apply in an older file.
for (const file of walk(path.join(CLIENT, 'src'), (f) => f.endsWith('.css'))) {
  const lines = stripCssComments(readFileSync(file, 'utf8')).split('\n');
  for (const [i, line] of lines.entries()) {
    if (/@apply\b/.test(line)) {
      fail(`${rel(file)}:${i + 1} uses @apply. Write the utilities on the element instead — §2.2.`);
    }
  }
}

// ---------------------------------------------------------------------------
// B. The new token layer holds tokens, not components.
// ---------------------------------------------------------------------------
for (const file of walk(path.join(CLIENT, 'src', 'styles'), (f) => f.endsWith('.css'))) {
  const text = stripCssComments(readFileSync(file, 'utf8'));
  if (/@layer\s+components/.test(text)) {
    fail(`${rel(file)} declares @layer components. Semantic classes are what the reset removed — §2.2.`);
  }
}

// ---------------------------------------------------------------------------
// C. Nothing new reaches the legacy stylesheet.
// ---------------------------------------------------------------------------
// Matched against an actual import, never a mention: the comments in tokens.css
// and gallery/main.tsx explain that they do NOT import the legacy sheet, and a
// rule that cannot tell those apart is worse than no rule.
const LEGACY_IMPORT = [
  /(?:^|[\s;])import\s+(?:[^'";]*\s+from\s+)?['"][^'"]*index\.css['"]/m,
  /@import\s+(?:url\()?['"][^'"]*index\.css['"]/m,
  /require\(\s*['"][^'"]*index\.css['"]\s*\)/m,
];
for (const dir of NEW_TREE) {
  const full = path.join(CLIENT, dir);
  for (const file of walk(full, (f) => /\.(ts|tsx|js|jsx|css)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    if (LEGACY_IMPORT.some((re) => re.test(text))) {
      fail(
        `${rel(file)} imports index.css — the legacy stylesheet. New code imports ` +
        `src/styles/tokens.css instead.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// D. The built gallery stylesheet must contain none of the legacy design system.
// ---------------------------------------------------------------------------
const requireDist = process.argv.includes('--require-dist');
const assets = path.join(CLIENT, 'dist', 'assets');
const galleryCss = existsSync(assets)
  ? readdirSync(assets).filter((f) => /^gallery-.*\.css$/.test(f)).map((f) => path.join(assets, f))
  : [];

if (galleryCss.length === 0) {
  const message = 'client/dist has no gallery-*.css — run `npm run build` in client/ first.';
  if (requireDist) fail(message);
  else notes.push(`skipped built-output checks: ${message}`);
} else {
  const built = galleryCss.map((f) => readFileSync(f, 'utf8')).join('\n');
  const legacy = readFileSync(LEGACY_CSS, 'utf8');

  // Every custom property the legacy @theme and :root bridge define. If none of
  // them is referenced, no legacy rule survived into this stylesheet — and this
  // stays correct as the legacy file shrinks, because the list is read from it.
  const legacyVars = [...new Set([...legacy.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))]
    .filter((v): v is string => v !== undefined);
  const newCss = readFileSync(path.join(CLIENT, 'src', 'styles', 'tokens.css'), 'utf8');
  const newVars = new Set([...newCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const legacyOnly = legacyVars.filter((v) => !newVars.has(v));
  const leaked = legacyOnly.filter((v) => built.includes(v));
  if (leaked.length > 0) {
    fail(`the built gallery stylesheet references legacy tokens: ${leaked.join(', ')}`);
  }

  // The tokens the canvas requires, by their effect rather than their name —
  // Tailwind inlines some values, so asserting on the variable name would pass
  // or fail for the wrong reason.
  const required: readonly [string, string][] = [
    ['Bricolage Grotesque', 'the display face'],
    ['Figtree', 'the body face'],
    ['JetBrains Mono', 'the mono face for codes and SKUs'],
    ['#f6f5f1', 'Ground, the page colour'],
    ['--store-bg', 'the per-store page token'],
    ['--store-on-primary', 'the per-store button-text token'],
    ['--store-tint', 'the per-store selected token'],
    ['12px 32px', 'the sheet elevation'],
  ];
  for (const [needle, what] of required) {
    if (!built.toLowerCase().includes(needle.toLowerCase())) {
      fail(`the built gallery stylesheet is missing ${what} (${needle}).`);
    }
  }

  // The token set is closed: clearing Tailwind's namespaces in @theme is what
  // makes an off-design value a build error, so check it actually took.
  for (const utility of ['red-500', 'slate-50', 'rounded-md', 'text-xs']) {
    if (new RegExp(`\\.${utility.replace('-', '\\-')}(?![a-z0-9-])`, 'i').test(built)) {
      fail(`the built gallery stylesheet still emits .${utility} — Tailwind's default namespace was not cleared.`);
    }
  }
  notes.push(`checked ${galleryCss.map((f) => path.basename(f)).join(', ')} against ${legacyOnly.length} legacy-only tokens`);
}

// ---------------------------------------------------------------------------
for (const note of notes) console.log(`  [note] ${note}`);
if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} style rule violation(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('\nStyle rules pass: no @apply, no @layer components in the token layer, no legacy CSS reachable.');
}
