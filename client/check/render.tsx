// client/check/render.tsx — milestone 14's render gate.
//
// `tsc` proves the types and `vite build` proves the JSX compiles and the imports resolve. Neither
// proves a component RUNS. This renders every part of the kit and all 28 states to static HTML and
// asserts on the result, so a component that throws on first render — a bad hook order, an index into
// an empty array — fails the build instead of the gallery.
//
// Built by Vite in SSR mode (`npm run ui:check` in client/) so it uses the same transform the app
// does. renderToStaticMarkup runs no effects, which is why the overlays below render closed: that is
// their correct initial state, and it is the state a first paint has to get right.

import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { ALL_STATES, ADMIN_STATES, PRODUCT_STATES } from '../src/shared/states/index.tsx';
import { ComponentSheet } from '../src/gallery/ComponentSheet.tsx';
import { AdminStateSheet, ProductStateSheet } from '../src/gallery/StateSheet.tsx';
import { TokenSheet } from '../src/gallery/TokenSheet.tsx';

const problems: string[] = [];
let checks = 0;

function expect(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) problems.push(message);
}

function render(what: string, node: ReactNode): string {
  try {
    const html = renderToStaticMarkup(node);
    checks += 1;
    if (html.length === 0) problems.push(`${what} rendered nothing`);
    return html;
  } catch (error) {
    problems.push(`${what} threw: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

// --- the counts the boards fix -------------------------------------------------
expect(PRODUCT_STATES.length === 20, `States.dc.html draws 20; found ${PRODUCT_STATES.length}`);
expect(ADMIN_STATES.length === 8, `AdminStates.dc.html draws 8; found ${ADMIN_STATES.length}`);
expect(ALL_STATES.length === 28, `expected 28 states in total; found ${ALL_STATES.length}`);
expect(
  PRODUCT_STATES.filter((s) => s.side === 'customer').length === 16,
  'States.dc.html has 16 customer states',
);
expect(
  PRODUCT_STATES.filter((s) => s.side === 'merchant').length === 4,
  'States.dc.html has 4 merchant states',
);

// --- every state renders, and says something ----------------------------------
for (const state of ALL_STATES) {
  const html = render(`state "${state.name}" (${state.where})`, state.render());
  // A state card with no text is the failure mode that would otherwise look fine: the pattern is
  // "headline, one line of reason, at most two actions", and all of it is text.
  const text = html.replace(/<[^>]+>/g, '').trim();
  expect(text.length > 20, `state "${state.name}" rendered almost no text`);
}

// --- no duplicate names within a board ----------------------------------------
for (const [label, list] of [
  ['States.dc.html', PRODUCT_STATES],
  ['AdminStates.dc.html', ADMIN_STATES],
] as const) {
  const names = list.map((s) => s.name);
  expect(new Set(names).size === names.length, `${label} has a duplicate state name`);
}

// --- the sheets render --------------------------------------------------------
const sheets = [
  ['TokenSheet', <TokenSheet />],
  ['ComponentSheet', <ComponentSheet />],
  ['ProductStateSheet', <ProductStateSheet />],
  ['AdminStateSheet', <AdminStateSheet />],
] as const;

let allHtml = '';
/** Everything except the token sheet — see the hex assertion below for why it is excluded. */
let kitHtml = '';
for (const [name, node] of sheets) {
  const html = render(name, node);
  allHtml += html;
  if (name !== 'TokenSheet') kitHtml += html;
}

/**
 * The rendered text, with tags removed and the entities React escapes decoded.
 *
 * Asserting phrases against raw markup fails on "Nyama & Co." — React writes `&amp;` — and chasing
 * that with an escaped literal in the test would mean the test agreed with the escaping rather than
 * with the board.
 */
const visibleText = allHtml
  .replace(/<[^>]+>/g, ' ')
  .replaceAll('&amp;', '&')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&#x27;', "'")
  .replace(/\s+/g, ' ');

// --- the copy is the boards', not a paraphrase --------------------------------
//
// A handful of sentences that only appear if the wording was carried across. States.dc.html's whole
// argument is that the wording IS the design, so a rewrite of these is a regression.
for (const phrase of [
  'You weren’t charged.',
  'Your cart is saved on this phone.',
  'Nothing was changed.',
  'The store’s wallet wasn’t charged.',
  'Nyama & Co. is getting ready',
  'Add a street, building or landmark the rider can find.',
]) {
  expect(visibleText.includes(phrase), `the boards' wording is missing: ${phrase}`);
}

// --- §2.2: the kit carries no colour of its own --------------------------------
//
// Utilities live in markup and every colour comes from a token, so a hex in the kit's output is a
// value that escaped the token layer. Two exceptions, both deliberate:
//
//   * THE TOKEN SHEET IS EXCLUDED. Its whole purpose is to print the palette — swatches and their
//     hex labels — so asserting it holds no hex would be asserting it does not work.
//   * PRODUCT TILES. The boards draw a per-product placeholder tint behind an initial where there is
//     no photograph. That is data about a product, not a theme token, so the values are allowed by
//     name rather than by pattern — a list that has to be edited to add one, which is the point.
const ALLOWED_TILE_HEX = [
  '#F3E3CF', '#8A5A2B', '#DCE3EC', '#36506E', '#EFEDE7', '#A8A499', '#D5DCE6', '#E8E0D0',
  // The toast's undo, which Main.dc.html sets as a light green on ink. A token would be a token used
  // once; it is noted here instead so it cannot spread.
  '#BFE3CD',
];
const hexes = [...kitHtml.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => m[0]);
const stray = [...new Set(hexes)].filter((h) => !ALLOWED_TILE_HEX.includes(h.toUpperCase()));
expect(stray.length === 0, `hex colours in the kit's markup that are not product tiles: ${stray.join(' ')}`);

// --- accessibility basics the boards depend on --------------------------------
expect(allHtml.includes('role="radiogroup"'), 'the segmented control is a radiogroup');
expect(allHtml.includes('role="switch"'), 'the switch is a switch');
expect(allHtml.includes('aria-invalid="true"'), 'a field in error sets aria-invalid');
expect(allHtml.includes('role="progressbar"'), 'the setup checklist reports progress');
expect(allHtml.includes('aria-disabled="true"'), 'a sold-out option is announced as disabled');
expect(allHtml.includes('<dialog'), 'the overlays are dialog elements');

// --- report -------------------------------------------------------------------
if (problems.length > 0) {
  console.error(`\nUI render check FAILED — ${problems.length} of ${checks}:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`UI render check passed: ${checks} assertions over ${ALL_STATES.length} states and 4 sheets.`);
