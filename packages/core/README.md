# `@vendlyfy/core`

L3 of the layer model (§3): code the browser **and** the Express server both import. Duplicating
any of it is the likeliest source of "the preview doesn't match the live store".

```
npm run core:test        # pure functions, no database, no server
```

## What is here

| Module | Milestone | What it is |
|---|---|---|
| `config/` | **12, done** | `published template version + store overrides → effective config`, and the two primitives `t(key)` / `has(module)` |
| `theme/` | **13, done** | eight inputs → **twelve** colours + a contrast report + a plain-language list of what it adjusted. The **only** path to a published theme |
| `money/` | **13, done** | one formatter driven by the currencies table, with cash rounding that applies only to cash-on-delivery totals. Exact decimals, never floats |

`src/generated/database.ts` is not one of these — it is written by `npm run db:types` from the
live schema and read by the server's repositories.

## Why the tsconfig looks the way it does

`tsconfig.json` compiles `src/` with `lib: ["ES2023"]` and `types: []`. No DOM, so a module that
reaches for `document` fails to compile; no Node, so one that reaches for `process` fails too.
Isomorphism is enforced by the compiler rather than by remembering.

`tsconfig.test.json` is a **second project**, not a widening of the first: a test needs
`node:test` and `node:assert`, and giving the main project those types would hand them to `src/`
as well and quietly retire the guard. Both run in `npm run typecheck`, so a `process` in `src/`
still fails — under the project where it is meant to.

## The config module, in one paragraph

Three layers, resolved server-side once: **what the merchant changed in Settings** wins over
**what the template says**, which wins over **what the platform calls the thing**. The result is
one payload the server hashes into an ETag. Components get `t(key)` for vocabulary and
`has(module)` for feature gates and nothing else — Part 8 names the risk: "A config engine
leaking into hundreds of scattered conditionals is worse than hardcoding. A third primitive is a
design smell."

Two things in it are worth knowing before you read it:

**`has()` throws on a module the platform does not have.** `V002` refuses a template naming
`stok` with a foreign key, because `has('stock')` would otherwise be false for every store on
that template, silently and for good. The same typo in a *component* is invisible to the
database — so it throws, naming the modules that do exist.

**`t(key, 'one')` derives the singular by rule, because nothing stores one.** The editor collects
the plural ("Menu items", "Sections"); `Categories` needs "Add **section**". The rule is exact
for all 32 words the eight templates ship and idempotent, but it is orthography, not knowledge:
"Clothes" becomes "Clothe". `ResolvedWord.derived` marks every value it changed. The real fix is
a second input in the editor — a designer question, recorded in Part 9 of the migration plan.

## The theme module, in one paragraph

`ThemeStudio.dc.html` contains a **working `makeTheme()`** and `ShoeStores.dc.html` renders three
stores through it, so this is a **transcription, not a design**. `compile.ts` is that function in
TypeScript, and `test/fixtures/theme-golden.json` is a frozen 535-case table generated from the
board's own code — so what the tests assert is the specification rather than a reading of it.

Three things in it are worth knowing before you change anything:

**It produces twelve colours, and ThemeStudio shows nine.** The studio's list is Page, Cards, Text,
Muted text, Lines, Buttons, Button text, Highlights, Selected, and its summary says "9 colors from
your 1 pick". Its `makeTheme` also derives the text colour for a sale badge and the two for the top
banner, and its preview uses them. They are tokens rather than something a component works out,
because §2.2 says the runtime "never derives a value".

**Two constants look like bugs and are not.** `luminance` uses the **0.03928** sRGB threshold (WCAG
2.0's; the current text says 0.04045) and `mix` interpolates in **gamma-encoded** sRGB rather than
linear light. Both match the board. Changing either would move published colours away from the
palettes the designer approved — the thing being built is "the palettes on the canvas", not "the
best palettes".

**`fitFill` chooses the text colour once, before its loop.** Re-picking each iteration lets it
oscillate: darken the fill a step, notice dark text now reads better, switch, lighten it back.

The guarantee — "no input combination publishes something unreadable" — is **swept, not sampled**:
59,136 combinations, and every one of the five 4.5:1 text checks passes.

## The money module, in one paragraph

Amounts arrive from Postgres as strings and **never become floats**. `decimal.ts` parses them to
BigInt minor units; `format.ts` renders them from the five `currencies` columns, transcribed from
`AdminCurrencies.dc.html`'s own `fmt()` and pinned against a golden table from it.

`cashDue` is a **separate function** from `formatMoney`, not a flag on it: cash rounding changes the
amount rather than its rendering, and a card total rounded by a mistyped boolean would be invisible
in review and worth a few francs on every order.

Two deliberate differences from the board, both documented in the tests: a negative amount puts the
sign **before** the symbol (`-$2.40`, where the board's concatenation would give `$-2.40` — it never
formats one, so its behaviour there is incidental), and rounding is exact rather than `toFixed`'s
binary rounding.

## Not yet resolvable by name

`server/src/core.ts` imports this package by **relative path**, and says why at length: the
legacy server still deploys from its own lockfile until cutover, so a workspace root or a `file:`
dependency would restructure `node_modules` underneath a live money system to buy a shorter
import specifier. Both become `@vendlyfy/core` at milestone 30. See §4.6.
