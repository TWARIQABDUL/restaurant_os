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
| `theme-engine/` | 13 | eight inputs → nine tokens + a contrast report. The **only** path to a published theme: the API re-runs it on publish and rejects any token set that is not its own output |
| `money/` | 13 | one formatter driven by the currencies table, with cash rounding that applies only to cash-on-delivery totals |

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

## Not yet resolvable by name

`server/src/core.ts` imports this package by **relative path**, and says why at length: the
legacy server still deploys from its own lockfile until cutover, so a workspace root or a `file:`
dependency would restructure `node_modules` underneath a live money system to buy a shorter
import specifier. Both become `@vendlyfy/core` at milestone 30. See §4.6.
