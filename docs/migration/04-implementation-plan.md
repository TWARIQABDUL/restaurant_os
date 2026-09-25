# Implementation plan

**Date:** 2026-09-23
**Design:** "Universal Commerce Platform" canvas, **53 artboards**, version `1790189963-a071`
**Repo:** `restaurant_os` @ `master` — 76 endpoints, 13 screens, 18 tables, 7,926 LOC client
**Supersedes:** §10 of [`01-target-architecture.md`](01-target-architecture.md), which remains the
reference for *why* the layering is what it is.
**Reads with:** [`00-audit.md`](00-audit.md) · [`02-design-gaps.md`](02-design-gaps.md) ·
[`03-design-round-2.md`](03-design-round-2.md)

**Binding decisions taken:**

1. The UI becomes the design canvas, in full.
2. TypeScript, client and server.
3. Tailwind only — no semantic CSS layer, no `@apply`.
4. All SQL optimized and indexed, with a named query justifying each index.
5. Migrations named `V000_what_it_does.sql`, tracked in the database, each running once.

---

## Part 1 — Scope

### 1.1 What changes

| | From | To |
|---|---|---|
| UI | 13 screens, one persona and a half | **53 artboards**, four personas — customer, merchant, rider, super admin |
| Language | JS/JSX, 7,926 LOC client; CommonJS server | TypeScript, strict, both sides; ESM |
| Styling | Tailwind v4 + a semantic `@layer components` + a `:root` bridge | Tailwind utilities only, runtime per-store theming |
| DB access | supabase-js on PostgREST, 25 files | `pg` repositories, parameterized, indexed |
| Migrations | 18 loose files, ~13 bespoke runners, no ledger | `db/migrations/V###_*.sql` + `schema_migrations` |
| Database | the live Supabase project, mutated in place | **a new database**, built forward; old one migrated across once and kept as rollback |
| Local dev | against the live Supabase project | Postgres container + seeded fixtures |
| Catalogue | `menu_items` + flat `add_ons` | products, option groups/values, **variant matrix** |
| Order states | 7 | 12 |
| Industry differences | hardcoded restaurant assumptions | **configuration rows** |

### 1.2 What does not change

Express · Socket.io · custom JWT + bcrypt auth · the MTN MoMo
integration including the webhook that re-verifies status rather than trusting its callback · the
seven plpgsql atomicity functions (`reserve_stock`, `release_stock`, `credit_wallet_pending`,
`release_eligible_orders`, `request_withdrawal`, `reverse_failed_withdrawal`,
`approve_refund_deduct_wallet`) · wallet, ledger, withdrawal and refund logic.

*Postgres stays as the engine, but the instance is new and plain — not Supabase (§4.2). Image
storage stays where it is until it is worth moving.*

**The money engine is not being rewritten.** It is the strongest part of the codebase.

### 1.3 The spine

> *"Industries are configurations, not apps."* — `Industries.dc.html`

A business type writes a config: **words · modules · attribute presets · product flags · order
steps**. The design proves it by adding Pharmacy with no new components — an Rx badge fills the
card's existing badge slot, prescription upload reuses the photo input from Add product, and
"Pharmacist check" is one more entry in an array.

**If a component branches on industry name, the architecture has failed.** Components get two
primitives — `t(key)` for vocabulary and `has(module)` for feature gates — and nothing else.

---

## Part 2 — Engineering standards

Each has a gate that fails the build.

### 2.1 TypeScript, client and server

**Change from the original audit**, which scoped TS to the frontend and sequenced it last. It is
now both sides and it comes first, because the repository layer, SQL row types, money types and
the theme compiler live in or across the backend. Typing them later means writing them twice.

- New code is TS from day one. **Existing client JS is deleted as it is rewritten, not converted**
  — it is being replaced against a new design, so conversion is wasted work. The server converts
  feature by feature alongside the repository layer.
- `strict: true` from the first file. No `any` in domain types. A `@ts-expect-error` carries a
  comment naming what it waits on; `@ts-ignore` is not used.
- **`tsc --noEmit` is its own CI gate.** `oxlint` does not typecheck, and `vite build` does not
  either — esbuild strips types without checking them. A green build proves nothing about types.
- **Server moves to ESM** as part of this, so `packages/core` has one output rather than a dual
  CJS/ESM build.
- **Row types are generated from the database schema** and committed. A column rename then fails
  `tsc` instead of failing at runtime inside a repository method.

**Built at milestone 3.** `tsconfig.base.json` plus four projects that extend it — the root
(`db/scripts`), `packages/core`, `server`, `client` — and `npm run typecheck` running all four.
Beyond `strict`: `noUncheckedIndexedAccess` (because `rows[0]` is usually a database result, where
"no rows" is a real case), `noUnusedLocals`, `noUnusedParameters`, and two that keep the source
inside what Node's type stripping can execute — `verbatimModuleSyntax` and `erasableSyntaxOnly`,
which reject enums, namespaces and parameter properties outright.

`allowJs: true` with **`checkJs: false`**: a new `.ts` file can import an old `.js` one during the
rewrite, without turning on hundreds of errors in code §2.1 deletes rather than converts. A file
graduates by being rewritten.

**Two guards are structural rather than conventional.** `packages/core` is compiled with
`"lib": ["ES2023"]` and `"types": []` — no DOM, no Node — so a module there that reaches for
`document` *or* for `process` fails to compile. That is §3's isomorphism requirement enforced by the
compiler. The client gets `"types": []` for the same reason in the other direction.

> **A trap worth recording.** `"types": []` alone did not hold. `vite.config.js` was in the client
> project's `include`, and Vite's own type definitions carry a reference to `@types/node` — which
> put `process` back in scope for every file in `src/`. Eight deliberate errors were probed against
> the four projects; seven failed immediately and this one passed silently until the Vite config was
> dropped from the project. It is JavaScript with `checkJs` off, so it was never being checked.

**Node 22.18+ at the root** (`engines`), because the `db:*` scripts are TypeScript executed
directly — unflagged type stripping starts there. `server` stays at 18.17: it needs only ESM and
top-level await, and its `__dirname` replacement is the portable `fileURLToPath(import.meta.url)`
rather than `import.meta.dirname`, which needs Node 20.11 and would have failed silently on an older
one, since `render.yaml` pins no Node version.

### The server's CommonJS → ESM conversion

36 files and 142 `require` calls, done with a codemod and six hand-written exceptions. Three things
worth knowing before the next one:

- **Import hoisting breaks load-order-dependent boot code.** `server.js` was `dotenv`, then
  `assertEnv()`, then `require('./app')` — and CommonJS ran them in that order. ESM evaluates every
  static import first, so `import app from './app.js'` would have loaded `config/supabase.js`, which
  reads `process.env` and calls `process.exit(1)` on a bad key, *before* `.env` was read. Only
  `dotenv/config` and `config/env.js` are static imports now; everything else is `await import()`.
  The same applied to `smoketest.js` and `test/auth.login.test.js`, both of which assign
  `process.env` before loading anything.
- **`const x = require('./m')` and `module.exports = { a, b }` convert to incompatible halves.** The
  first becomes a *default* import, the second becomes *named* exports — so `x` is `undefined` at
  runtime, silently. There were **16** of these. They were found by a script that read each module's
  actual exports and checked every relative import against them, not by reading the diff; the fix is
  `import * as x from './m.js'`, which is what `require` of an exports object always meant.
- **`server/scripts` is a CommonJS island** — its own `package.json` with `"type": "commonjs"`, one
  file instead of converting or deleting 19 retired Supabase-era runners. §4.3 retires them, but
  `run-sql.js` is still the only way to apply a hotfix to the live database before cutover, so they
  stay until milestone 30. See `server/scripts/README.md`.

**`smoketest.js` was repaired and then extended, because it is the acceptance instrument.** It had
been exiting 1 since the service_role hardening landed — it only ever set the anon key — so it was
proving nothing. It now checks **all 16 route modules** (not the 3 it sampled), then boots the app on
an ephemeral port and makes real requests. A mounted router is distinguished from an unmounted one by
the app's 404 *body*, not by status code: `/api/momo`'s only route is a POST on a subpath, so a bare
GET there legitimately falls through, and a mounted route may answer 404 for its own reasons.

### 2.2 Tailwind only

Three things leave `client/src/index.css`: the old `@theme` block (Inter/Outfit, slate,
`#dc2626`), the `@layer components` semantic classes (`.btn`, `.card`, `.badge`, `.navbar`,
`.form-*`, `.kanban-*`, `.stat-card`), and the legacy `:root` bridge (`--color-*`, `--space-*`,
`--radius-*`, `--shadow-*`, `--gradient-*`).

- **Utilities live in markup.** Repetition is factored into a React component, never a CSS class.
- **No `@apply`** — it is exactly how "fully Tailwind" becomes semantic CSS again six months
  later. Only exception: element resets in `@layer base`.
- **Two kinds of token, and this is where the rule must bend:**
  - **Fixed** — neutrals (Ink `#17160F`, Ink2 `#3B3A33`, Muted `#5F5C53`, Line `#E5E2DA`, Ground
    `#F6F5F1`, Surface `#FFFFFF`), the five status colours, the type ramp, 4-point spacing, radius
    8/10/14/20/pill, three elevations → `@theme`, built once.
  - **Per-store** — the nine tokens the theme compiler derives → **runtime CSS custom properties**
    on a root element, with theme entries referencing those variables so one class resolves per
    store. They cannot be build-time values: one bundle, thousands of stores.
- **Status colours are not themeable** and must be unreachable from the theme engine. "Paid" means
  the same thing in every store — a product rule enforced structurally.
- Arbitrary values (`bg-[#…]`) only in the theme studio preview, where the colour genuinely is
  user-chosen.
- **Gate:** CI rejects `@apply` and the `:root` bridge from milestone 4 onward.

**Built at milestone 4.** `client/src/styles/tokens.css` is the new L0 layer, every value taken from
the canvas's own token spec (`project/Main.dc.html`) and the status palette from `States.dc.html`,
with the source of each written beside it. `client/src/styles/store-theme.ts` is the runtime
plumbing. `npm run check:styles` is the gate, wired into CI after the client build so it asserts on
emitted CSS and not only on source.

**The token set is closed.** `@theme` clears Tailwind's own namespaces —
`--color-*: initial`, `--font-*`, `--text-*`, `--radius-*`, `--shadow-*` — before declaring the
design's. `bg-red-500`, `rounded-md` and `text-sm` therefore do not exist, so an off-design value is
a build error rather than a review comment. This is the same move as keeping status colours out of
the compiler: a structural guarantee instead of a remembered rule.

**`@theme inline` for the nine, and the reason is not cosmetic.** With plain `@theme`, Tailwind emits
`--color-store-surface: var(--store-surface)` on `:root` — and a custom property's value is
substituted at computed-value time *on the element where it is declared*. It would resolve against
`:root` once, descendants would inherit the resolved colour, and overriding `--store-surface` on a
subtree would do nothing. That would break `StorePreview`, which shows one store's theme inside the
merchant console, and `ThemeStudio`'s live preview. `inline` compiles the utility to
`background-color: var(--store-surface)` with no intermediate property, so the variable resolves at
the point of use and subtree overrides work. The gallery demonstrates it on a subtree.

> **The three deletions in this section could not happen yet, and that is deliberate.**
> `client/src/index.css` is loaded by `index.html` through `src/main.jsx`, and **31 of the 36 old
> pages use 55 of its semantic classes, 542 times.** Deleting the `@layer components` block would
> strip the styling from the live client on the next Vercel deploy — months before cutover, on a
> system taking money.
>
> So the new token layer arrived as **its own Vite entry** (`client/gallery.html`) that imports only
> `tokens.css`. Two documents means two CSS graphs, which is what makes "no legacy CSS reachable" a
> verifiable property of the new page rather than a hope, and it is where milestone 14's UI kit
> gallery lands. The legacy file is now headed with a do-not-add-to-this notice and goes with the
> last page that depends on it, in Stage D. `check:styles` fails if anything in the new tree imports
> it, so the boundary is enforced rather than trusted.

**The platform default theme** in `:root` is a fallback, not a source of truth — what renders where
there is no store (admin console, sign-in, the gallery) and for the instant before a store's theme
arrives. Its nine values come from the canvas's default store, brand `#1D6B47`; `tint` is
`#E4EDE9`, computed with the canvas's own published mix (12% brand, 88% white) so milestone 13's
compiler can be checked against it.

**`store-theme.ts` never derives a value and never throws.** It validates each token is `#rgb` or
`#rrggbb`, applies what it recognises, and reports what it rejected — a bad theme degrades to the
platform default rather than taking a shopfront offline. `parseStoreTheme` is the boundary for a
theme arriving as JSON, since §2.5 makes the server authoritative and that is only worth something
if the client stops trusting the shape of what it is handed. Deriving the nine from the eight inputs
stays milestone 13's job, in `packages/core`, where there is no DOM.

### 2.3 SQL: optimized and indexed

**Query rules for the repository layer**

- Parameterized always. No string interpolation into SQL, ever.
- **Explicit column lists. No `SELECT *`** — it breaks silently on a new column and defeats
  covering indexes.
- **`tenantId` is the mandatory first parameter** of every repository method touching a
  tenant-scoped table, and appears in the `WHERE` of every such query. One omission is a
  cross-tenant leak that will not announce itself.
- **Keyset pagination** for anything that grows — orders, ledger, audit log, notifications.
  `OFFSET` degrades linearly and "All orders" is where that bites.
- **`EXPLAIN (ANALYZE, BUFFERS)` before merge** on request-path queries, against seeded volumes.
  An empty table makes a sequential scan look fast.
- **No N+1.** The current `.from()` calls with embedded selects hide them behind one call.

**Index policy**

- Every migration creating a table declares its indexes in the same migration.
- **Composites lead with `tenant_id`.**
- **Partial indexes for the common filtered case** — the schema already does this well twice
  (`notifications(user_id) WHERE is_read = false`, `momo_transactions(status) WHERE status =
  'pending'`). Make it the reflex.
- **An index needs a named query.** Over-indexing taxes every write and is invisible until it isn't.
- Index every FK used in a join or cascade.
- `CONCURRENTLY` on populated production tables — which means that migration opts out of its
  transaction and says so.

**Concrete finding.** Of 48 index statements, the **newer** files get the multi-tenant composite
right (`wallet_ledger(tenant_id, created_at DESC)`, `withdrawal_requests(tenant_id, requested_at
DESC)`, `categories(tenant_id, sort_order)`). The **core** tables do not. The hottest query in the
product — the orders board, `WHERE tenant_id = $1 AND status IN (…) ORDER BY created_at DESC` — is
served by three *separate single-column* indexes.

On the new database these are not a backfill — they are how the tables are built from `V001`. The
old schema's gaps are listed because they tell you which queries matter. **Still verify each with
EXPLAIN against seeded volumes before committing to it:**

| Candidate | Serves |
|---|---|
| `orders (tenant_id, status, created_at DESC)` | orders board, desktop and mobile |
| `orders (tenant_id, created_at DESC)` | order list, dashboard recents |
| `menu_items (tenant_id, category)` | catalogue browse — `menu_items(available)` is a low-selectivity boolean index |
| `order_items (menu_item_id)` | top-items analytics, currently unindexed |

Likely redundancies to confirm from the production dump: `idx_orders_tracking` beside the `UNIQUE`
on `tracking_code`; `idx_users_email` beside `UNIQUE(email, tenant_id)`. Some indexes are declared
in two files each (`complaints`, `reviews`) — the baseline dump settles what exists.

### 2.4 Migrations

**Convention: `V000_what_it_does.sql`.**

- `V` + zero-padded number + `_` + snake_case description. Pad to a fixed width so lexicographic
  order matches numeric order — but the runner sorts **numerically anyway**, so a padding slip
  cannot silently reorder anything.
- `V000_init.sql` is extensions, shared types and grants — **not** a dump of production. There
  is no baseline; the database is greenfield (§4.3). Real changes start at `V001`.
- Numbers claimed **at merge**, never at the start of the work, or two branches take `V042`.
- One concern per file. A rename and its backfill are two migrations.
- Forward-only in production. Corrections are new migrations.
- Destructive statements get their own migration with a header comment naming what was checked.

**Ledger — `schema_migrations`:** `version` (unique — *this* enforces run-once, not the filename)
· `filename` · `checksum` · `applied_at` · `duration_ms` · `applied_by`.

**Runner — a small in-house one, in TypeScript.** Seven requirements:

1. Take a Postgres **advisory lock** for the run.
2. Parse and validate every filename; **reject duplicate versions** loudly, naming both files.
   Gaps are fine — an abandoned branch leaves one.
3. Sort **numerically**.
4. **Refuse out-of-order application** — a pending version lower than the highest applied. This is
   the classic way a branch merge corrupts a schema.
5. **Verify checksums** of applied migrations; abort on mismatch, naming the file.
6. Apply each migration **in its own transaction, writing the ledger row inside it**, so a failure
   leaves nothing half-applied or falsely recorded.
7. Support **opting out of the transaction** (header comment) for `CREATE INDEX CONCURRENTLY`,
   recording that it ran non-transactionally.

Plus a `status` mode. (A `baseline` mode — record as applied without running — is **not** needed:
the new database is greenfield, so nothing pre-exists. See §4.3.)

*Fallback:* `node-pg-migrate` — brings the ledger, transactions, locking, uses the existing `pg`,
and sorts by filename so `V###_` works. **No checksums**, so requirement 5 is lost. That is the
whole trade.

**Built at milestone 2**, in-house, all seven requirements plus `status`, `--dry-run`, `new` and an
acceptance suite of 46 checks (`npm run db:test`). Four things the section did not anticipate:

- **The ledger carries an eighth column, `transactional`**, because requirement 7 says a
  non-transactional run must be *recorded* as one. The opt-out is `-- migrate:no-transaction` on its
  own line in the file header.
- **The runner creates `schema_migrations`, not `V000`** — nothing could record `V000` as applied
  otherwise. It is excluded from the app role's privileges; the application has no business reading
  it.
- **Statements are split by a real scanner, not on `;`** — handling line and nested block comments,
  `''` doubling, backslash escapes inside `E'…'` literals, quoted identifiers, and dollar-quoted
  bodies — which every plpgsql function in §5 depends on. Splitting matters because a non-transactional migration must send its
  statements one at a time: Postgres wraps a multi-statement simple query in an implicit
  transaction, which is exactly what `CREATE INDEX CONCURRENTLY` cannot tolerate. It also buys an
  error that names the file, the line and the statement number.
- **`status` and `--dry-run` are strictly read-only** — they do not create the ledger on a database
  they were only asked to inspect.

Two guards worth naming: the runner **rejects `BEGIN`/`COMMIT` inside a migration** (it owns the
transaction, and writes the ledger row inside it), and it **refuses a non-loopback target from an
interactive terminal** without `--yes`, while a deploy — which has no TTY — is never asked.

Checksums are sha256 over CRLF-normalised content, so a checkout with different line endings does
not read as tampering, and what was hashed is what ran.

---

### 2.5 No browser storage as a source of truth

**Rule: the server is authoritative for all session and application state. Browser storage is never
the source of truth, and every screen must render correctly with it empty, blocked or unavailable.**

**Where this already stands.** The session token is **already on a cookie** — `api.js` carries only a
`legacyToken` fallback from that migration, and `AuthContext` actively removes `token`. The audit's
"JWT in localStorage" is stale. What remains is 42 `localStorage` references across 9 client files,
in five groups, and all five go:

| Group | Where | Replaced by |
|---|---|---|
| Cached `user` object | `AuthContext` | `/me`, which the server already re-reads per request |
| `tenantSlug` | `api.js`, `ProtectedRoute`, `TenantThemeInjector`, `Login`, `Register`, two dashboards | The store comes from `Host` or path, **never** from storage |
| Cart items | `CartContext` | A server-side cart (below) |
| Tenant profile cache | `TenantContext` | The config payload's ETag |
| Legacy `token` cleanup | `api.js`, `AuthContext` | Deleted outright |

Removing the `tenantSlug` cache also deletes a bug the audit found: *one mistyped URL poisons the
tenant header for every later request in that browser.* There is nothing to poison once the store
is derived from the request.

**Session cookie:** httpOnly, Secure, SameSite, with an explicit max-age for `Auth`'s "Keep me
signed in on this device". Drop the `legacyToken` fallback at cutover.

**CSRF becomes mandatory.** Cookie-borne credentials are sent automatically, so every
state-changing request needs a token or a strict same-origin check. `X-Tenant-Slug` is not CSRF
protection — it is a client-controlled value, as `middleware/auth.js` itself notes.

**Cookie scope and store isolation interact — decide them together.** A cookie set on
`.vendlyfy.com` is shared by every store, which breaks what `CustomerAccount` promises: *"This
account is only for Nyama & Co."* Host-only cookies per store subdomain preserve that isolation for
free — and they require the **API to be same-origin under each store's host**, which the current
Vercel rewrite already achieves. This is a constraint on the domain decision (Part 9), not a
separate choice.

**Two places the design assumes device-local state, which now need server homes:**

1. **The cart.** `States.dc.html`: *"You're offline — your cart is saved on this phone"* and
   *"Carts survive network loss and are kept for 7 days."* → a server-side `carts` table keyed by an
   anonymous session cookie, expiring at 7 days to match the design's own copy. Better regardless:
   the cart survives a device change, and abandoned carts become something a merchant can see. A
   local copy may still exist as a pure offline **cache** — never as the truth.
2. **The notification sound preference.** `Notifications.dc.html`: *"Sound is off for this device."*
   → either a per-user-per-device row, with the device identified by a cookie, or accept per-user
   and lose the per-device wording. A small product decision, not a technical one.

---

## Part 3 — Architecture

```
  L5  Apps       storefront · merchant console · rider · admin console
  L4  UI kit     components from Main.dc.html + States.dc.html + AdminStates.dc.html
  L3  Core       theme-engine · config resolver · money · domain types   ← shared, isomorphic, TS
  L2  Services   Express services → repositories (pg, parameterized)
  L1  Data       Postgres
  L0  Tokens     fixed neutrals, status, type, spacing, radius, elevation
```

**L0 and L3 are the load-bearing additions.** Everything else is an arrangement of them.

**`packages/core`** holds three modules the browser *and* the Express server both import.
Duplicating any of them is the likeliest source of "the preview doesn't match the live store":

- **`theme-engine`** — eight inputs (brand, accent mode, accent, harmony, mood, shape, heading
  font, card treatment, hero) → nine tokens + a contrast report + a plain-language list of what it
  adjusted. Enforces 4.5:1 for text, 3:1 for buttons, and outlines a button whose colour is too
  close to the page. **The API must re-run the compiler on publish and reject any token set that
  is not its own output** — otherwise `ThemeStudio`'s promise that "no store can publish something
  unreadable" is not true.
- **`config`** — resolves `published template version + store overrides → effective config`,
  server-side, once, served as one versioned payload with an ETag. Exposes `t(key)` and
  `has(module)`.

  > **The schema behind it landed at milestone 6** (`V002`). Five things to know before writing the
  > resolver:
  >
  > **There are eight templates, not six.** This plan said six; `AdminIndustries.dc.html` has food,
  > fashion, beauty, electronics, grocery, pharmacy, furniture and services.
  >
  > **A published version is immutable, and that is what makes pinning mean anything.** A store pins
  > `(template_id, version)` — if v4 could change, a store pinned to v4 is pinned to nothing. Triggers
  > refuse any update or delete of a published version, refuse changes to its module and flag sets, and
  > refuse a publish that also rewrites the payload: publishing records a decision, it does not make
  > one. A store may only pin a published version.
  >
  > **Modules and product flags are tables, not strings in jsonb.** A template naming module `stok`
  > would make `has('stock')` false for every store on it, silently and for good; a foreign key makes
  > that unrepresentable. Words, attributes and order steps stay jsonb, validated by `IMMUTABLE`
  > functions called from `CHECK` constraints — which is how a nested shape is validated at the column
  > rather than in whichever writer remembers to.
  >
  > **An order step carries both a key and a label.** Services' first step is `booked` labelled
  > "Booked" where food's is `new` labelled "New", and they are the same state. Milestone 8 decides how
  > these keys relate to `orders.status`; pharmacy's `pharmacist_check` is the case proving the status
  > vocabulary cannot simply be fixed.
  >
  > **The templates ship in the migration, not in a seed**, because a database with no industry
  > templates cannot onboard a merchant — Onboarding's first question is the business type. Reference
  > data the product does not work without belongs with the schema; dev fixtures belong in `db/seeds`.
  >
  > **Two boards disagree, and it is recorded rather than resolved.** `Industries.dc.html`'s
  > illustrative JSON and cards mention modules the editor does not offer — `expiry_dates`,
  > `table_ordering` (the editor calls it `table`), `variants`, `stock_per_variant`, `reviews`,
  > `brands`, `specs_table`, `warranty`, `serial_numbers`. Seeding a module with no code behind it
  > would make `has()` true for a feature that does not exist, which is worse than the gap, so the
  > registry holds the editor's eight and the rest is a designer question, noted at the foot of `V002`.
- **`money`** — one formatter driven by the currency table: symbol, position, decimals, separator,
  and **cash rounding that applies only to cash-on-delivery totals**. Property tests, not examples.

  > **The money schema landed at milestone 8** (`V005`). Six things it is built on:
  >
  > **Two pots, and every internal movement writes both sides.** `pending` and `available`, neither
  > ever negative. A release debits `pending` and credits `available` as two rows sharing a
  > `transfer_id`, checked at commit to sum to zero. **This is the exact bug the old database had** —
  > it credited `available` and never debited `pending`, so the pending sum became "the total ever
  > held" and the pots could not be reconciled by summing (profile §7.2). Money crossing the platform
  > boundary writes one row that must name its `counterparty`, so no entry is anonymous.
  >
  > **The ledger is a chain, not a bag.** `sequence` is monotonic per (store, pot) and `balance_after`
  > must equal the previous entry's plus this amount — enforced on INSERT, so a hand-written row cannot
  > break it either. A missing or reordered entry is therefore detectable rather than merely unlikely.
  >
  > **A wallet balance cannot be set directly.** The balances are a cache of the ledger, written only
  > by the ledger's own trigger; a direct `UPDATE` is refused by checking `pg_trigger_depth()`. The
  > only way to change what a store is owed is to write an entry explaining it.
  >
  > **Three independent layers of idempotency** on every money path, any one sufficient: a single-shot
  > claim (`UPDATE … WHERE status = 'pending' RETURNING`), a ledger idempotency key unique per store,
  > and a uniqueness constraint on the outcome — at most one *successful* collection per order, and at
  > most one in flight, so a second charge is unrepresentable rather than avoided by discipline.
  >
  > **A refund leaves the pot the money is actually in**, decided from the order's settlement state
  > rather than guessed. That is the other half of the old database's ±100: its refund function chose
  > the label with a single CASE and named the pot the money had not left. Tested both ways — before
  > release it comes out of `pending`, after release out of `available`.
  >
  > **The escrow sweep no longer clamps.** The old `release_eligible_orders` used
  > `LEAST(net, pending_balance)` as "belt and braces", which turned an inconsistency into a silent
  > correction — one order released 200 more than it held and the next absorbed it. Here, if `pending`
  > cannot cover a release, `wallet_post` raises and the sweep fails loudly. That is the only useful
  > behaviour.
  >
  > **Cash writes no ledger entry at all.** With cash on delivery the merchant already has the money;
  > the wallet tracks what the *platform* holds. Crediting it would invent a balance that cannot be
  > withdrawn. A shortfall is recorded on the order — `total 12,500, received 10,000, short 2,500` —
  > and the platform's commission on a cash order is plans & fees, at milestone 9.
  >
  > Two custom SQLSTATEs let the application tell a user's problem from a bug: **`VLSTK`** insufficient
  > stock, **`VLFND`** insufficient funds. And `reserve_stock` locks variants in a **single global
  > order**, because two orders containing the same two variants in opposite orders would otherwise
  > deadlock.

**One Vite app, three route trees** (`storefront/`, `merchant/`, `admin/`) plus `shared/ui`,
code-split. Rejected: three separate deployables — not justified at this team size, and the
current Render setup (one Node service + one static site) works.

---

## Part 4 — Infrastructure

### 4.1 The blocking fact

**`server/src` contains zero `pg` usage.** All 25 query-bearing files go through supabase-js
against PostgREST; `pg` appears only in `scripts/`.

A bare Postgres container **cannot run the app today.** It runs migrations, seeds and tests
immediately; the app points at it once the repository layer lands. Say this to whoever runs
`docker compose up` first.

*The only shortcut* is the Supabase CLI local stack — ~6 containers, and it pins you to Supabase's
migration conventions you have just decided against. **Not recommended.**

### 4.2 Plain Postgres — what leaves the schema

**Decision: plain Postgres, in a container locally and as a managed instance in deployment. Not a
Supabase project.**

The old schema's SQL falls into three classes, and two of them now simply do not get written:

| Class | Examples | Occurrences in the old schema | In the new schema |
|---|---|---|---|
| **A · portable app schema** | tables, indexes, constraints, the 7 plpgsql functions | most | **Kept** — rewritten with correct names and indexes |
| **B · Supabase role grants** | `GRANT`/`REVOKE … TO anon, authenticated, service_role` | `anon` 33 · `authenticated` 20 · `service_role` 8 | **Gone.** Ordinary grants to one application role |
| **C · Supabase Storage** | `storage.buckets`, `storage.objects`, `auth.role()` | 16 · 2 · 2 | **Gone.** Storage is not a database concern |

That removes 61 role-grant statements, ~20 storage-policy statements, two RLS enables and two
policies from the schema. `uuid-ossp` stays (or `gen_random_uuid()` from `pgcrypto`, which is
built in from PG13 and avoids the extension entirely — decide once in `V000`).

**What this buys beyond a smaller schema:**

- The local container is an **exact match** for deployment, not an approximation. No stub roles, no
  fake `storage` schema, no "works locally, fails in production" class of bug.
- The bootstrap file shrinks to extensions only.
- The Supabase connection-limit problem the audit flagged disappears — `pg.Pool` sizing becomes an
  ordinary decision against a known instance.

**What still needs an answer, separately: image storage.** The client currently uploads to a
Supabase Storage bucket through a backend-issued signed URL. That is the one remaining Supabase
dependency, and it is not a database concern. Two options, both fine: keep the existing Supabase
project purely as an image bucket, or move to S3/R2. **Locally, stub the upload endpoint** — it is
a few lines and it keeps the container honest. Either way, do not let it block `V000`.

### 4.3 Greenfield schema — the new system gets its own database

**Decision: the new system is built on a brand-new database.** The live one is not migrated in
place. This removes the worst risk in the original plan — renaming `menu_items` → `products` under
152 call sites on a database holding live merchant balances — and replaces it with a risk that can
be rehearsed as many times as you like: a one-off data migration (§5.5).

What follows from it:

- **There is no baseline.** `V000_init.sql` is extensions and shared types; the schema is built
  forward by `V001` onward, one feature area per migration, with correct names and correct indexes
  from the first line.
- **No `--baseline` mode is needed** on the runner. `status` still is.
- **The four orphaned TypeORM-era tables never exist** — `addon_groups`, `addon_items`,
  `menu_item_addon_groups`, `posts` simply do not come across. Whether they hold anything becomes a
  question for the ETL, not a schema decision carried forward forever.
- **`menu_items.category` free text never exists.** Categories are a real table with a join from
  the start.
- **The index policy in §2.3 applies from the first migration** rather than as a late backfill. It
  is just how the tables are built.

**The production dump is still needed — as a reference, not a baseline.** You need
`pg_dump --schema-only` and the row counts to write the ETL and to prove nothing was lost. The
ordering hazard in the old files is now historical rather than operational:

> `inventory.sql:57` creates `reserve_stock(UUID, JSONB)` — two arguments.
> `option-sizes.sql:30-34` drops it and creates `reserve_stock(UUID, TEXT, JSONB)` — three.
> We know the three-argument version won only because stock reservation works in production. That
> is inference, not a record — which is exactly why the new database gets a ledger.

**Retire the old runners** — delete ~13 `run-*.js` and `run-sql.js`. `verify-lockdown.js` and
`verify-storage-lockdown.js` were audits of the Supabase anon key; they retire with it, though they
stay relevant to the old database until it is decommissioned. Keep `provision-momo-keys.js`.

**Migrations against the new database are automated on deploy from the start**, because until
cutover it holds no live money. Build the habit while the stakes are zero.

### 4.4 Container — built, milestone 1

`docker-compose.yml` + `db/`. See [`../../db/README.md`](../../db/README.md) for the operational
detail; what matters at plan level:

**Pinned to Postgres 17**, Debian-based rather than Alpine — musl and glibc collate text
differently, which changes `ORDER BY` results and index behaviour against a glibc managed instance.
**The deployed instance must be 17 too**; `db:verify` asserts the running server matches the pin,
which is the local half of that promise only.

Non-default host port **55432**, bound to `127.0.0.1` — a mistyped `DATABASE_URL` then fails to
connect instead of reaching something real, and the bind address matters because `"55432:5432"`
alone publishes on `0.0.0.0` and Docker's rules sit in front of firewalld. (Port 5432 on the
development machine was already taken by another Postgres, which is the case this guards.)

Named volume `vendlyfy_pgdata`, destroyed only by `db:reset`. `pg_isready -h 127.0.0.1` healthcheck
— over TCP, so `--wait` cannot return on a server clients cannot reach. A long `start_period`
because first-run `initdb` measured ~110s on a Docker Desktop VM; that costs nothing on later
starts. `--data-checksums`, `timezone=UTC`, and `pg_stat_statements` + `track_io_timing` so §2.3's
`EXPLAIN (ANALYZE, BUFFERS)` requirement is measurable rather than aspirational.

**One correction to this section as written.** The bootstrap is **not** "extensions only". The
deployed instance never runs `/docker-entrypoint-initdb.d/`, so an extension that lives only there
is missing in deployment — `V001` would pass locally and fail on deploy. The split that holds:

| In `db/bootstrap/local.sql` | In `V000` |
|---|---|
| Creating the `vendlyfy_app` role — what a managed provider does for you outside SQL | The extensions the schema needs |
| `pg_stat_statements` — a measuring instrument no schema object depends on | `CONNECT`, `USAGE`, default privileges for the app role |
| | `schema_migrations` |

Two roles, locally and deployed: **`vendlyfy_owner`** owns the schema and runs migrations;
**`vendlyfy_app`** is what the application connects as, owns nothing, runs no DDL, and cannot create
objects in `public`. Locally both passwords are `localdev`; `db:verify` logs in as **both roles over
TCP**, so drift between `docker-compose.yml`, the bootstrap and `server/.env.example` fails
verification instead of surfacing at milestone 11.

Because the deployed database is now also plain Postgres, **the container is an exact match for
it** — same engine, same extensions, same roles. That is the main practical win of §4.2.

### 4.5 Seed

**A TypeScript program, not `.sql`** — it must hash passwords, create orders across every status,
and stay idempotent.

**Guardrails before any write**, in the style of `server/src/config/env.js`: refuse on
`NODE_ENV=production`; refuse unless the `DATABASE_URL` host is loopback or `SEED_ALLOW_REMOTE=true`
names the host; print the target before writing. Idempotent by truncating an explicit table list,
not `ON CONFLICT`.

**Fixtures: the design's own demo data** — Nyama & Co. (food, `#1D6B47`), Inzu Threads (fashion),
Kigali Kicks (theme studio), Ubwiza Beauty and Kigali Tech Hub pending verification, Deals4U
suspended; riders Eric Mugisha, Claude Habineza, Olivier Nzeyimana with their plates. A developer's
local screen then matches the artboard they are building from.

**Coverage:** two industries · orders in all 12 statuses · a wallet with pending and available
balances, one ledger entry of each type, one failed withdrawal · riders on and off duty, one
carrying cash, one with a shortfall · complaints open/escalated/resolved/rejected · merchants
pending/active/suspended · KYC submitted/approved/redo · products with variants and a shared option
group · **enough volume that a sequential scan is visibly slower than an index scan.**

### 4.6 Layout and scripts

```
docker-compose.yml                                          done, milestone 1
package.json        root, private — carries the db:* scripts done, milestone 1
db/
  scripts/          the db:* commands                        done, milestone 1
  README.md                                                  done, milestone 1
  bootstrap/local.sql   LOCAL ONLY — roles + diagnostics,     done, milestone 1
                        never anything the schema depends on
  migrations/       V000_init.sql, V001_…                    milestone 2
  seeds/            dev.ts + fixtures/                       milestone 10
packages/core/      theme-engine · config · money · types     skeleton done, milestone 3
  src/index.ts      empty; names what lands and when          fills at 12 and 13
client/src/styles/   tokens.css (L0) · store-theme.ts (the nine) done, milestone 4
client/gallery.html  second Vite entry; UI kit gallery at 14     done, milestone 4
client/src/index.css LEGACY, fenced off; deleted with the last   Stage D
                     page that uses it (542 uses in 31 files)
db/migrations/       V000_init · V001_identity_stores…          V001 done, milestone 5
db/scripts/          gen-types.ts · test-schema.sh · test.sh     done, milestone 5
packages/core/src/generated/database.ts  committed row types    regenerated by db:types
scripts/             check-styles.ts — the §2.2 gate            done, milestone 4
tsconfig.base.json  shared strictness, four projects extend it done, milestone 3
.github/workflows/  ci.yml — types · database · server · client done, milestone 3
client/src/         shared/ui · storefront/ · merchant/ · admin/
server/src/         routes/ services/ repositories/ db/       ESM as of milestone 3
server/scripts/     retired CommonJS runners, own package.json until milestone 30
```

**`npm` workspaces are deferred to milestone 12, not milestone 3.** They would make
`@vendlyfy/core` resolvable by name from `client/` and `server/` — and nothing imports it until
milestone 12, so there is nothing to resolve yet. Against that: the old client and server deploy
from their own directories, each with its own lockfile (`client/vercel.json`, `render.yaml` with
`rootDir: server`), and both must keep running untouched until cutover. Restructuring `node_modules`
underneath a live money system months before anything needs it buys nothing. `packages/core`'s
`tsconfig` exists now, which is the part milestone 3 was actually for.

**Built:** `db:up` · `db:down` · `db:reset` · `db:verify` · `db:psql` · `db:logs`.
**Later:** `db:migrate` · `db:migrate:new` · `db:migrate:status` (milestone 2) · `db:seed` (10) ·
`db:types` (5). There is no `db:baseline` — §2.4.

The root `package.json` is deliberately dependency-free until milestone 3, when workspaces land. It
needs no `npm install`.

`supabase/` is **retired, not deleted** — kept in history, referenced from `V000`'s header.

---

## Part 5 — Data model changes

### 5.1 Renamed and reshaped

> **The old `wallet_ledger` is single-entry, and the ETL cannot recompute a running balance from
> it.** Two structural facts, read off the function bodies in the profile's §10:
> `request_withdrawal` stores `-p_amount` while `approve_refund_deduct_wallet` stores a **positive**
> amount for what is also a deduction — so direction is carried in the sign for some entry types and
> implied by `entry_type` for others; and `release_eligible_orders` moves money from pending to
> available while writing **one** row, credited to `available`, with nothing debiting `pending`. The
> pending sum is therefore the total ever held, not a balance.
>
> Interpreting each entry type into a signed movement on a named pot, one store's pots drift by
> **+100 and −100**. The total is intact; the *attribution* is wrong, and the likely cause is
> `approve_refund_deduct_wallet` choosing `balance_type` with a single CASE and writing one row even
> when a refund spans both pots. **This needs an explanation before cutover** — a drift the ETL
> carries across is one the new ledger inherits and can never account for.
>
> Also: `wallets.currency` is **`EUR`**, the MoMo *sandbox* currency, on RWF-sized amounts. A label
> to correct in the ETL, not a conversion to perform.

**The ±100, traced (2026-09-24). No money is missing.** The wallet's own figures are self-consistent:
28,000 held across four orders, 300 refunded, 27,800 released, 20,900 withdrawn → available 6,800 and
pending 0, which is exactly what `wallets` holds. What is wrong is that **the ledger is not a faithful
record of it.** Two rows misstate what happened, and both come from the versions of these functions
that `supabase/refund-hardening.sql` replaced:

1. **The pot label is wrong on one refund.** Order `9d176a3f` had `settlement_status =
   'not_applicable'`, so nothing was escrowed and the 100 correctly came out of **available**. The
   row says `balance_type = 'pending'`. The current function would label it correctly — its
   `CASE WHEN v_from_pending >= v_refund_amount` evaluates `0 >= 100` as false — so this row predates
   the hardening.
2. **A partial refund was released in full, and the excess was silently absorbed.** Order `dedf7b91`
   was refunded 200 and then released its whole 7,000, because the old release function did not
   subtract `refunded_amount`. The 200 over-release then came out of the *next* order's release:
   `f2400290` is marked `released` but only **6,800** of its 7,000 ever reached available, clamped by
   `LEAST(v_net, pending_balance)` — the "belt and braces" line, which turned an inconsistency into a
   quiet correction rather than an error.

**Consequence for milestone 29: the new ledger cannot be built by replaying these rows.** Two of
fifteen misstate the movement. Seed the new ledger with an **opening balance** taken from `wallets`
(which is correct) and carry the old rows across as history only, clearly marked as pre-cutover and
not summable. Recomputing a running balance from them would bake both errors in permanently.

> **A live bug found on the way, still present.** `approve_refund_deduct_wallet` never checks
> `payment_status`. It decides how much is escrowed from `settlement_status` alone, so a refund
> approved against an order the system records as **`unpaid`** deducts from the merchant's
> `available` balance — which is exactly what happened to order `9d176a3f` (total 7,000,
> `payment_status = 'unpaid'`, refunded 100). The merchant was charged for money the system has no
> record of them receiving. It needs an admin to approve a refund, so it is not customer-reachable,
> but it turns a support mistake into a real debit. **Fix it in the old code** — it is a few lines and
> the old system runs until milestone 30 — **and make the new `refunds` table's approval path check
> that the order was paid** (milestone 8).

| Today | Target |
|---|---|
| `tenants` | `stores` (+ industry template & pinned version, country, selling currency, lifecycle status, plan, config overrides, draft & published theme) |
| `users.role` + `UNIQUE(email, tenant_id)` | `users` (identity) + `store_members` + `platform_members` + `role_permissions` — see §5.4 |
| `menu_items` | `products` (+ draft/active, compare-at price, SKU, cover image, position, product flags) |
| `add_ons` | `option_groups` + `option_values` |
| — | **`product_variants`** — new and unavoidable |

> **Built at milestone 7** (`V003`). Four decisions, the first of which was not what it looked like:
>
> **Variants are the cartesian product of the "pick one" groups, and only those.** A "pick several"
> group is not a dimension: Extras on a burger (Cheese +500, Fries +1,000) are chosen per line at
> checkout and priced per selection. `AddProduct.dc.html` computes it that way — `attrs.filter(a =>
> a.mode === 'one')` — and guessing otherwise would have multiplied every burger's matrix by its
> add-ons and split their stock across the copies. A constraint refuses a variant built over a
> multi-select group, naming that specific mistake.
>
> **Every product has at least one variant**, including one with no options at all, which gets a
> single `is_default` row. The UI draws "one stock number" or "stock for each", but underneath it is
> one shape — because milestone 8's `reserve_stock` has to decrement exactly one row atomically, and
> stock living in two places would mean two code paths through the riskiest function in the rewrite.
>
> **Matrix integrity is checked at COMMIT**, by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger,
> because a variant is inserted before its values and a per-statement check would see every matrix
> half-built. Five rules: no group the product does not offer; no multi-select group; exactly one
> value per single-select group; no duplicate combination; and stock tracking all-or-nothing across a
> product's variants.
>
> **Tenancy is declarative, not remembered.** Every table carries `store_id`, and every join between
> two of them carries it and composite-foreign-keys it — the `UNIQUE (id, scope)` pattern from V001
> applied to `store_id`. §2.3 warns that one missing tenant predicate is "a cross-tenant leak that
> will not announce itself"; this makes attaching one store's option group to another store's product
> unrepresentable rather than merely unlikely.
>
> **No `scope` column on `option_groups`.** A shared group is one attached to several products; how a
> group is managed is a UI question and the Options panel in `AddProduct` is still undesigned, so a
> column encoding that distinction now would be a guess.
>
> **The cart stores no prices.** `States.dc.html`: "Prices are re-checked at checkout; any change is
> shown before paying." A price copied into the cart is a second source of truth that goes stale in
> silence.

> **Orders landed at milestone 8's first half** (`V004`). What it establishes, and one question it
> settles:
>
> **The twelve statuses are `Orders.dc.html`'s own**, not a guess: `pending approved preparing ready
> assigned out delivered collected returned closed_return rejected cancelled`. Five are terminal —
> `delivered collected rejected cancelled closed_return` — and they are terminal *because no
> transition leaves them* in `order_status_transitions`, which is data rather than a code branch.
>
> **`orders.status` is the platform machine; a template's `order_steps` are presentation.** That
> resolves the question milestone 6 left open. The money and lifecycle logic must not depend on
> industry vocabulary, so the status vocabulary is fixed at twelve; Pharmacy's `pharmacist_check` is a
> *label* on the timeline, most plausibly over `approved`. **The mapping from step keys to statuses is
> still open** and belongs with the config resolver (milestone 12) or the Orders screen (milestone 20)
> — it is presentation, so it can wait, but it cannot be forgotten.
>
> **The arithmetic is unforgeable.** `total_amount` is `GENERATED ALWAYS AS (subtotal + delivery −
> discount)` and `line_total_amount` as `((unit_price + options) × quantity)`, so neither can be set
> to a number somebody chose. Deferred constraints then check that an order **has at least one line**,
> that its subtotal **equals the sum of those lines**, and that a line's `options_amount` equals the
> sum of its captured option deltas. There is no path to an order whose total disagrees with what it
> contains.
>
> **A retried checkout cannot charge twice.** `idempotency_key`, unique per store, one per checkout
> attempt from the client. The second request collides instead of placing a second order.
>
> **What was charged is captured, not looked up.** `order_items` stores the product name, the price
> and each option's label and delta as they were. Renaming a product tomorrow does not rewrite what
> someone paid yesterday, and the variant cannot be deleted out from under an order.
>
> **Every state change is recorded** in append-only `order_events` with who and why — the table a
> short cash payment or a refund is argued from. The reason lists are the board's: four decline
> reasons, four cancel reasons, five refund reasons.

**The variant gap.** Today a size is an `add_ons` row with its own stock: that expresses "M has 4
left" but **not** "Black/M has 4 left", because size and colour stock are separate rows. The design
requires per-combination stock and SKU. This changes the atomic path — `reserve_stock` currently
reserves against an `add_ons` row. **Change that plpgsql function alone, first, under test, never
during a UI phase.** Cap the matrix and generate lazily with a clear message.

### 5.2 New tables

`industry_templates` (versioned, draft/published) · `payment_methods` · `store_payment_methods` ·
`currencies` · `kyc_submissions` / `kyc_documents` / `kyc_checks` · `merchant_verifications` ·
`store_themes` · `store_sections` · `delivery_zones` · `promotions` · `audit_log` · `plans_fees` ·
`rider_shifts` / `rider_cash` · `review_replies` · `product_categories` (join) · **`store_members`**
· **`platform_members`** · **`role_permissions`** (§5.4) · **`carts`** (§2.5).

**What this list got wrong, now that it is built (V001–V013).** Three entries turned out not to be
tables, and one turned out to be five:

- **`merchant_verifications` does not exist.** Whether a store is verified is `store_is_verified()`,
  derived from an approved `kyc_submissions` row. A flag beside the submissions would be a second
  truth, and the first time one was set by hand the two would disagree about whether a merchant may be
  paid.
- **`plans_fees` is two tables**, `plans` and `plan_features` with `plan_feature_grants` between them,
  because `AdminPlans` grants features per plan and prices them separately.
- **`rider_shifts` is not a table either.** `CashReport` does not draw a shift; it draws a *day* that
  is a running account of several hand-ins, so `rider_cash_handovers` and `rider_cash_settlements`
  replaced it, with `rider_profiles` holding what is true of a rider.
- **`promotions` needed a second table nobody listed**, and it is the more important of the two:
  `order_discounts`. Without it `orders.discount_amount` stays a number a client can send.
- **Added, from boards this list did not reach:** `complaints` / `complaint_events` /
  `complaint_evidence` · `reviews` / `review_reports` · `notification_types` / `notifications` /
  `notification_reads` / `notification_inbox_state` / `notification_devices` ·
  `kyc_extracted_fields` · the four `*_status_transitions` tables that hold each state machine as
  data.

### 5.3 Deltas the design rounds produced

1. **Order statuses 7 → 12** — adds `out`, `returned`, `closedReturn`, `cancelled` (distinct from
   `rejected`), `collected`. Existing orders are **mapped, never rewritten in place**.
2. **`restock_on_return`** — a template key. `Orders.dc.html`: *"Off by default for Food & drinks,
   since cooked food can't be resold. Fashion and electronics templates turn it on by default."*
3. **Cash gap outcomes** — carry over · record as a discount on the order · write off. Three
   different money outcomes; two touch order totals.
4. **A fifth refund state** — "approved, waiting for funds", when the refund exceeds the store's
   available balance.
5. **`wallet_ledger` needs a running balance**, which it does not store, and two more
   `entry_type` values (dispute adjustment; pending-balance reversal for a returned order).
6. **Reviews** — merchant reply (no such column), purchase verification for the "Ordered here"
   badge, and the display rule that hides an average below three reviews.
7. **Categories become many-to-many** — *"Products can sit in more than one section."* Today
   `menu_items.category` is free-text `VARCHAR(100)` that does not even reference the `categories`
   table. Good news: `categories` already has `sort_order` and `is_active`, which is exactly the
   reorder and show/hide the board draws.
8. **Notifications are partly a broadcast** — the new-order alert *"shows on every signed-in screen
   at this store"*, while `notifications` is per `user_id`. Plus a per-device sound preference.
9. **Rider fields** — availability (no such column; `users` has `plate_number` only), cash float,
   and a `picked` state between assigned and out.
10. **No SMS provider exists.** `Messages.dc.html` designs eleven SMS templates with sender IDs and
    short links. SendGrid covers email; SMS is an unmade vendor decision.

---

### 5.4 Roles, memberships and delegated user creation

**The model**

| Scope | Role | Can |
|---|---|---|
| **Platform** | `super_admin` | Everything, every store. Creates stores and platform team members |
| **Platform** | other team roles (`AdminTeam` implies support / finance / reviewer) | Scoped slices of the admin console, each recorded in the audit log |
| **Store** | `owner` / `admin` | Full control of **their own** store, including money and settings. **Creates managers, riders and other admins within that store** |
| **Store** | `manager` | Per `Auth`'s invite screen, verbatim: *"accept and update orders, assign riders, edit products and stock"* — and *"can't see payouts, the wallet or store settings"* |
| **Store** | `rider` | Their own deliveries only |
| **Store** | `customer` | Shops at that store |

**Role moves off the user and onto a membership.** Today `users.role` is a column with
`UNIQUE(email, tenant_id)` — one user row per person per store, role baked in. `Auth`'s store picker
requires one person to be **Owner at Nyama & Co. *and* Manager at Inzu Threads**; the board's own
data says exactly that. A single `tenant_id` on a user cannot express it, and neither can a single
`role`.

- `users` — identity only: email, phone, password hash.
- `store_members (user_id, store_id, role)` — staff. Many stores per person.
- `platform_members (user_id, role)` — the Vendlyfy team.

**Customers stay scoped to one store**, because `CustomerAccount` says so: *"This account is only
for Nyama & Co. Other stores on Vendlyfy ask separately."* Two coherent ways to express it — one
`users` table with a scope discriminator and a partial unique index (unique email for platform-scope
identities, unique `(email, store_id)` for store-scoped customers), or separate tables for staff
identities and customer identities. **Recommendation: one table with the discriminator**, because it
keeps one sign-in path, one password reset and one lockout policy, which is what `Auth` draws.

**Consequence for the tenant guard.** `middleware/auth.js` currently rejects when
`user.tenant_id !== req.tenant.id`, with `super_admin` exempt. With memberships that becomes: *does
this user hold a membership in the store this request names, and does that membership's role permit
this action?* The per-request DB re-read stays — it is what makes a revoked role take effect
immediately, and that property is worth keeping.

**Delegated creation, enforced server-side**

Today `POST /api/auth/create-staff` is `authorize('admin')` with `role IN ('manager','delivery')`,
deriving the store from `req.user.tenant_id`. The shape is right; it needs re-scoping to
memberships and widening so an admin can also create another admin.

The rules, and they are authorization checks on the endpoint, **not UI affordances**:

- A store admin may create members **only in a store where they hold `owner`/`admin`**.
- A store admin may grant **only store roles**, never a platform role.
- A manager may create nobody.
- Only `super_admin` creates stores and platform team members.

**Four escalation tests that must exist**, because each of these is a silent takeover if it passes:

1. A store admin cannot create a `super_admin` or any platform role.
2. A store admin cannot add a member to a store they do not belong to.
3. A manager cannot reach payout, wallet or store-settings endpoints — **verified against the
   endpoint, not against whether the nav item is hidden**.
4. Revoking a membership denies the next request, not the next login.

**Permissions are data, not code branches.** `Auth`'s invite screen renders a role's permissions in
prose, and `AdminTeam` is an entire board about roles. Both need a `role_permissions` mapping to
read from — the same discipline as the config engine. A component asks whether a role may do
something; it never contains the list.

**Built at milestone 5** — `V001_identity_stores_and_memberships.sql`, five tables, 59 schema tests.
Four decisions worth keeping:

- **A store-scoped customer cannot be given staff privileges, declaratively.** `users` carries
  `UNIQUE (id, scope)`; `store_members` carries `user_scope text CHECK (user_scope = 'platform')` and
  a composite `FOREIGN KEY (user_id, user_scope) REFERENCES users (id, scope)`. So the guarantee holds
  against *any* writer — a repository, a later migration, somebody at a psql prompt — rather than only
  against code that remembers. No trigger, no application check. `platform_members` does the same.
- **Customers are not rows in `store_members`.** A customer is `users.scope = 'store'` with a
  `store_id`. Putting them in the membership table as well would mean two places to look for one
  fact, and `store_members.role` excludes `'customer'` so it cannot happen by accident.
- **One email may have several accounts** — one platform identity plus one customer account per
  store, each with its own password — enforced by two partial unique indexes rather than one. This is
  not laxity: it is the behaviour `server/test/auth.login.test.js` pins down, and the reason it exists
  is that scoping the sign-in lookup wrongly once locked real users out of production. A third,
  non-unique index on `lower(email)` serves the global sign-in, which names no store and therefore
  cannot use either partial index — Postgres only uses a partial index when the query implies its
  predicate.
- **Reserved slugs are refused at the column.** A store slugged `api`, `admin` or `checkout` would
  shadow the application's own routes, since tenant resolution is path-first today and the slug
  becomes a subdomain label if the domain decision goes that way.

**What the schema enforces, and what it cannot.** Of §5.4's four escalation tests, the first is now
structurally hard — platform roles live in a different table, and `store_members.role` cannot hold
one — and the third has its data in `role_permissions`. The other two are about *who is asking*,
which a constraint cannot see: adding a member to a store you do not belong to, and a revoked
membership denying the next request, are endpoint checks and land with the authorization guard at
milestone 11. The tests for all four belong there.

A `role_permissions` row with a typo'd role is refused too, because the failure it would otherwise
cause is silent: the guard finds no permissions for the real role, and a manager who can do nothing
looks like a UI bug rather than a data error.

### 5.5 The one-off data migration

Because the new system gets its own database (§4.3), moving the existing data is a **separate,
rehearsable program** rather than a series of in-place schema changes. This is the single biggest
addition the greenfield decision makes to the plan, and the single biggest thing it de-risks.

**Properties it must have**

- **Idempotent and repeatable.** Run it against a restored copy as many times as you like. It
  truncates the target and rebuilds, so a partial run is never a state you have to reason about.
- **Read-only against the source.** The old database is never written to. It stays intact as the
  rollback.
- **Reconciled, not assumed.** It ends by producing a report that is checked, not skimmed.

**The mappings that carry real risk**

| Source | Target | Risk |
|---|---|---|
| `tenants` | `stores` | New required columns — industry template, country, currency, status, plan — have no source value. Every default is a product decision, not a technical one |
| `users` (one row per person **per store**, role on the row) | `users` + `store_members` + `platform_members` | **The same email in two stores is two rows today and must become one identity with two memberships** — but only where it is genuinely the same person. Password hashes may differ between those rows. Needs a reviewed rule, not an automatic merge |
| `menu_items.category` (free text) | `categories` rows + `product_categories` join | Free text means typos and casing variants are distinct "categories". Needs a normalisation pass someone reviews by eye |
| `add_ons` with `menu_item_id` set | `option_groups` + `option_values` + `product_variants` | Per-product sizes carry their own stock today. They become a single-group variant matrix. **This is the hardest mapping** |
| `orders.status` (7 values) | 12 values | A mapping table, decided once and written down. `assigned` splits into `assigned`/`out`; there is no source for `returned` or `collected` |
| `wallets` + `wallet_ledger` | same, plus a **running balance** | The balance column must be backfilled by accumulating the ledger per store in `created_at` order |
| orphaned TypeORM tables | **nothing** | Check whether they hold rows, record the answer, do not carry them |

**The reconciliation report — the acceptance test for cutover**

Run against source and target, compared line by line:

- Row counts per table.
- **Sum of `wallets.available_balance` and `pending_balance`, source vs target.**
- **Sum of the ledger, and whether it equals the balances** — in *both* databases. If the old one
  does not reconcile, you have found a pre-existing bug, and you find it during a rehearsal rather
  than after cutover.
- Sum of `orders.total_amount`, and counts per status through the mapping.
- Count of withdrawal and refund requests per status.
- Spot-check: the ten largest orders, byte for byte.

**Cutover**

Rehearse on a restored copy until the report is clean twice in a row. Then: freeze writes on the
old system, run the ETL, run the report, switch DNS. **Keep the old database.** Do not drop it for
at least one full settlement cycle — it is the rollback, and it is also the only way to answer a
merchant who disputes a balance in week one.

---

## Part 6 — Board map

**53 boards.** Four are specifications rather than screens, four are components, and the rest are
routes.

### Specifications — build *from*, not *to*

| Board | Becomes |
|---|---|
| `Main` | the token set and component contract |
| `Industries` | the config engine's specification |
| `States` | 20 customer/merchant states, final copy — an acceptance checklist |
| `AdminStates` | admin empty/loading/error/permission |
| `ShoeStores` | the theme engine's regression fixture |
| `Messages` | email + SMS template system |
| `PrintExports` | receipt · QR poster · CSV |

### Components

`Sidebar` · `AdminSidebar` · `StorePreview`

### Customer — storefront

| Board | Route |
|---|---|
| `Shop` (390) | `/:store`, `/:store/cart`, `/:store/checkout`, `/:store/orders/:code` |
| `StoreDesktop` (1440) | same routes, desktop composition |
| `ReviewsCustomer` | `/:store/p/:id` — **the product page**, with description, reviews and write flow |
| `CustomerAccount` | `/:store/account` — sign-in at checkout, guest, orders, reorder, addresses, complaints |
| `ErrorPages` | 404 · 500 · store-not-found · suspended |

### Merchant

| Board | Route |
|---|---|
| `Onboarding` | `/start` |
| `Auth` | `/signin` — shared across all personas |
| `KYC` · `KYCOutcomes` | `/verify` |
| `Dashboard` · `DashboardMobile` | `/app` |
| `Orders` · `MobileOrders` | `/app/orders` — board + list, rider picker, cash, returns |
| `Products` | `/app/products` |
| `AddProduct` · `MobileAddProduct` | `/app/products/new`, `/:id` |
| `Categories` | `/app/categories` |
| `Customers` | `/app/customers` |
| `Complaints` | `/app/complaints` |
| `ReviewsMerchant` | `/app/reviews` |
| `Wallet` | `/app/money` |
| `CashReport` | `/app/riders` |
| `Analytics` | `/app/analytics` |
| `Customize` | `/app/store-design` |
| `ThemeStudio` · `MobileTheme` | `/app/store-design/theme` |
| `Settings` | `/app/settings` |
| `Notifications` | shell overlay + new-order alert |
| `MobileMore` | `/app/more` |

### Rider

| Board | Route |
|---|---|
| `Rider` | `/rider` — jobs, detail, pickup, delivery, cash, couldn't-deliver |

### Super admin

`AdminOverview` `/admin` · `AdminMerchants` · `AdminKYC` · `AdminOrders` · `AdminPayments` ·
`AdminCurrencies` · `AdminPayouts` · `AdminDisputes` · `AdminIndustries` · `AdminPlans` ·
`AdminTeam` · `AdminAudit` · `AdminSettings`

### Responsive rules (from `Main`, not invented)

- **< 600** — 2-column products, sticky cart bar, options and payment in bottom sheets,
  single-column checkout, merchant nav becomes a 5-item bottom bar, tables become cards with the
  same fields in the same order.
- **600–1023** — 3-column products, centred sheet for options, sidebar collapses to a 64px icon
  rail, order detail as a drawer over the list.
- **1024+** — full 248px sidebar, split list/detail, bulk actions.

Overlays: **sheets** for choices on mobile · **drawers** for detail on desktop · **modals only to
confirm something destructive.**

---

## Part 7 — Milestones

Built one at a time, in order. Each is small enough to finish and verify, and each **done-when** is
a demonstrable fact, not a status.

Because the new system has its own database (§4.3), **milestones 1–27 carry no risk to the live
system** — it keeps running untouched on the old database throughout. All the risk is concentrated
in 28–30, where it can be rehearsed.

### Stage A — Ground

| # | Milestone | Done when |
|---|---|---|
| **1** ✅ | **Postgres container.** Done 2026-09-24. PG 17 pinned, `127.0.0.1:55432`, named volume, TCP healthcheck, bootstrap limited to roles + diagnostics (§4.4) | **Met.** `db:reset` rebuilt from nothing in 2m17s and `db:verify --expect-empty` passed: reachable from the host, both roles authenticating over TCP, version matching the pin, UTC, checksums on, app role unprivileged, zero tables |
| **2** ✅ | **Migration runner + ledger.** Done 2026-09-24. `db/scripts/migrate.ts` (TypeScript, run directly by Node — no build step), `schema_migrations`, `V000_init`, and `db:test` | **Met.** `npm run db:test` — **46 checks, all passing**, in a throwaway database: duplicate version, out-of-order version and edited checksum each rejected with the offending filenames, plus a missing file, an off-convention name, an empty file, self-managed transactions, `V2` applying before `V10`, rollback leaving nothing behind, the `no-transaction` opt-out, a dollar-quoted body surviving the splitter, and a blocked second run. `V000` applied once, recorded, and re-running is a no-op |
| **3** ✅ | **TypeScript + ESM.** Done 2026-09-24. `tsconfig.base.json` + four projects, `npm run typecheck`, `.github/workflows/ci.yml` (4 jobs), server CJS → ESM (36 files, 142 requires), `packages/core` skeleton | **Met, both halves.** *Type error:* eight deliberate errors probed across the four projects — plain mismatches, an enum under `erasableSyntaxOnly`, an unused local, `document` and `process` in `packages/core`, `process` in the client — all now fail their project's typecheck. *Server on ESM:* `node src/server.js` boots and `GET /api/health` answers 200; all 16 route modules load with **86 routes registered**; 14 routers answer on their own GET routes and the 2 with no GET route are verified at module level; the retired CommonJS scripts still parse and four of them were run against the live database unchanged. Every CI job was run locally and passes. **The integration suite was then run against the real database by hand: 10 tests, 10 pass** — so the conversion is verified against production data, not only wiring |
| **4** ✅ | **Tailwind reset.** Done 2026-09-24. `styles/tokens.css` (closed token set, fixed tokens from the canvas), `styles/store-theme.ts` (runtime plumbing for the nine), `gallery.html` as a second Vite entry, `npm run check:styles` in CI. The legacy stylesheet is **retained and fenced off**, not deleted — see §2.2 | **Met.** *One page:* `gallery.html` builds to its own stylesheet, renders in Bricolage/Figtree on `#F6F5F1`, and **43 of 43** token-derived utilities it uses were emitted. *No legacy CSS reachable:* **0 of the 17 legacy token variables** and none of the 84 legacy semantic classes appear in it — the three colliding names (`container`, `grid`, `text-muted`) were verified to be Tailwind's own utilities with different bodies. *CI rejects `@apply`:* four deliberate violations probed — `@apply`, `@layer components`, and a JS and a CSS import of the legacy sheet — all four caught. The legacy stylesheet still carries its classes, so the live client is untouched |

### Stage B — Schema

Each milestone is one or more `V###_` migrations, with its indexes declared in the same file and
justified by a named query.

**The profiling pass is done ✅ (2026-09-24).** `npm run db:profile` →
[`05-old-database-profile.md`](05-old-database-profile.md). Read-only, inside one REPEATABLE READ
snapshot, and it aborts unless the server first refuses a write.

**What it changed.** Read the report before `V001`; these are the findings that move decisions:

- **The database is tiny.** 24 tables, 3 stores, **29 orders, 13 users, 14 products**, largest table
  80 rows. Real money has moved (23 momo transactions, 4 withdrawals), so it is live — but the ETL
  at milestone 29 is moving hundreds of rows, not millions. That is the single biggest change to the
  risk picture in Part 8.
- **Categories are clean.** 5 distinct values, **zero** case or whitespace variants of one another,
  and **zero** products whose category text fails to match a row in the `categories` table that
  already exists. The free-text→table migration §5.1 worried about is mechanical.
- **There are no per-product variants at all.** All 13 `add_ons` rows are shared store-wide;
  `menu_item_id` exists in production and is **unused**. Options are attached to products through
  **`menu_item_addons`** (80 rows, `PRIMARY KEY (menu_item_id, add_on_id)`) — that is the table
  §5.1's `option_groups` mapping actually has to read, and it is not mentioned there. So
  `product_variants` is purely forward-looking: no variant data to reshape, and the risk in Part 8
  reduces to getting the new `reserve_stock` right.
- **A size is already a shared option.** `add_ons.category` has **no CHECK constraint** any more, and
  two rows carry `category = 'size'` — store-wide, so one stock number across every product that
  shows it. That is exactly the bug the design fixes, present in production.
- **Six orphaned tables, not four.** `addon_groups`, `addon_items`, `menu_item_addon_groups` are
  empty; **`posts` holds 2 rows**; and `delivery_persons` and `delivery_assignments` appear in **no**
  `supabase/*.sql` file at all and are also empty. §4.3's list is short by two.
- **One email in two stores, holding `admin + customer`.** So §5.4's membership model migrates a real
  row, and the case `Auth`'s store picker draws exists in production today.
- **Only 4 of the 7 order statuses are in use** — pending 15, assigned 8, approved 5, delivered 1.
  No `rejected`, `ready` or `preparing` rows exist, so the 7→12 mapping has four live values to map.
  `orders` also already carries a `settlement_status` column with its own 4-value CHECK, which §5.1
  does not mention.
- **The ledger cannot be reconciled by summing, and there is a real ±100 misattribution.** See below.

| # | Milestone | Done when |
|---|---|---|
| **5** ✅ | **Identity, stores & memberships (§5.4).** Done 2026-09-24. `V001`, five tables, `db/scripts/gen-types.ts`, `db/scripts/test-schema.sh` | **Met.** *The store-picker case:* one person holds `owner@nyama-and-co` **and** `manager@inzu-threads`, and the picker's own query returns both. *Row types:* `packages/core/src/generated/database.ts`, committed, with CHECK constraints emitted as union types and `numeric`/`bigint` as `string` — `npm run db:types -- --check` regenerates in CI and fails on any drift, so a column rename cannot merge beside stale types. **105 checks pass** across two suites (59 schema, 46 runner), including every scope rule, both uniqueness rules, one person's two roles in two stores, and the escalations the schema itself refuses |
| **6** ✅ | **Config.** Done 2026-09-24. `V002`, six tables + `stores` columns, two validator functions, four triggers, and the templates shipped as data | **Met.** *The templates are rows* — **eight, not six** (see §3): every word map, attribute preset, module set and order flow from `AdminIndustries`, asserted against the board rather than against fixtures. *Pharmacy:* `new → pharmacist_check → preparing → ready → delivered`, the `rx` module, and the `prescription_required` flag — and it ships as a **draft**, as the board draws it, so no store can pin it. **55 config checks** pass, plus 105 from the earlier suites |
| **7** ✅ | **Catalogue.** Done 2026-09-24. `V003`, ten tables, a deferred matrix-integrity constraint, and the server-side cart | **Met, all three.** *Twelve variants:* 4 sizes × 3 colours, each its own row with its own stock and SKU, built the way the app will — variant and values in one transaction, checked at commit. Black/M reads back as one row with stock of its own. *Shared group:* one `option_groups` row attached to two products through the join — **no copy**, so editing Cheese reaches both. *Cart:* keyed only by a server-issued session cookie, reads back whole from that id with nothing client-side, kept 7 days, and carries **no price columns at all** (asserted against `information_schema`). **50 catalogue checks** pass, 210 across four suites |
| **8** ✅ | **Orders & money.** Done 2026-09-25, in two migrations because one file of this would not be reviewable and §2.4 asks for one concern each. `V004` orders (46 checks), `V005` money and the money functions (94 checks) | **Met, and then some.** The done-when asked for two concurrent reservations of the last unit; it was run with **ten** — one won, nine were told it was gone, stock landed on exactly zero and never went negative. Two more real races: the **same webhook delivered ten times at once** produced exactly one credit, and **ten reviewers approving one refund** produced exactly one debit. Every internal transfer writes both sides; the ledger's sequence is an unbroken run and every `balance_after` follows its predecessor; a wallet balance cannot be set by hand; and after a full lifecycle — paid, released, withdrawn, reversed, partially then fully refunded, plus a short cash payment — **the ledger still sums to the balances** |
| **9** ✅ | **Supporting domains.** Eleven of them, so delivered in eight migrations. **`V006`** (59 checks) currencies, countries, payment methods, plans & fees · **`V007`** (54) delivery zones, pickup, payout settings, riders, rider cash · **`V008`** (147) complaints & disputes · **`V009`** (75) reviews & replies · **`V010`** (79) notifications · **`V011`** (58) the audit log · **`V012`** (93) KYC · **`V013`** (92) promotions. All 2026-09-25. **1,009 checks across fourteen suites**, every one green from an empty database | **Met, and three of the eight found something the earlier milestones had left open.** *V006:* the six currencies with their exact formatting from `AdminCurrencies`, five countries, four payment methods, Starter and Growth — seeded, so a fresh database can onboard a merchant — and `stores.country`, `stores.selling_currency`, `stores.plan_key`, `wallets.currency`, `orders.currency` and `orders.payment_method` became references rather than bare text. *V007:* an area belongs to exactly **one** delivery zone per store, an order's rider must be a rider **of that store** by composite key, a day is a running account of multiple hand-ins, a shortfall must be accounted for by one of the board's three outcomes, and **a day cannot be closed while the rider still has cash orders out**. *V008:* the complaint thread is **chained** — a status that moved without an event, an event that starts where the last one did not end, and a complaint with no events are all refused at commit — and it delivers §5.3's **fifth refund state**: `queued` is decided-but-unpaid, writes no ledger entry, **pauses the store's payouts** (`VLHLD`), and settles in one payment as soon as the balance covers it. Ten reviewers deciding one escalation produced one refund and one ledger entry. *V009:* `reviews` is **insert-only for everybody** — the merchant's reply is a separate table precisely so the review table need not be updatable — "Ordered here" is a composite key into `order_items` rather than a badge, and the no-average-below-three rule lives in one view that both screens read. *V010:* a store broadcast has **no addressee** and is filtered by its type's roles, so **a manager cannot see a payout** and the unread count agrees with the list for every role; "mark all as read" is a watermark, not two hundred rows; and the per-device sound preference is a server-issued cookie, which **answers the first of Part 9's two small things**. *V011:* the audit log is **hash-chained**, and the suite proves it the only way it can be proved — it disables the append-only trigger, edits an entry, deletes another and forges a third, and `verify_audit_chain()` reports every one. *V012:* **no plaintext ID number column exists anywhere**, asserted against `information_schema`; the number is encrypted with a key that is not in the database, masked for review, and fingerprinted for duplicate detection; **the reveal and its audit entry are one call**, so the number cannot be read unrecorded; and verification gates **payouts and nothing else**. *V013:* `orders.discount_amount` has been a plain column since V004 and now **must equal the rows behind it** — a checkout that posts a discount with nothing behind it no longer commits — which also gives CashReport's second gap outcome a home. Ten checkouts claiming a code limited to one use produced exactly one redemption |

### Stage C — Platform

| # | Milestone | Done when |
|---|---|---|
| **10** | **Seed.** TS program, guardrails, the design's fixtures, full status coverage, enough volume for EXPLAIN | `db:reset` gives a database where every screen has data, and a sequential scan is visibly slower than an index scan |
| **11** | **`pg.Pool` + repository layer + authorization.** Connection, transaction helper, the first repositories (stores, users, memberships), and the membership-aware guard replacing `user.tenant_id !== req.tenant.id` | The server boots against the local container with no supabase-js in the path, and **all four escalation tests in §5.4 pass** |
| **12** | **Core: config resolver.** `t(key)`, `has(module)`, the versioned payload with an ETag | Switching a store's template changes vocabulary and feature gates through one API call |
| **13** | **Core: theme engine + money.** The compiler, contrast enforcement, draft/publish, server-side re-run gate; the currency formatter with cash rounding | The three stores in `ShoeStores` reproduced from three input sets. No input combination publishes something unreadable. Cash rounding property-tested |
| **14** | **UI kit.** Every component from `Main`, `States`, `AdminStates`, in a local gallery | The gallery matches the artboards at 1440 and 390. All 20 states exist as components |

### Stage D — Apps

Each of these is: the boards, their routes, their repositories, their endpoints.

| # | Milestone | Boards |
|---|---|---|
| **15** | **Auth** — all four personas, httpOnly cookie session, CSRF, store picker across memberships, staff invite. **No browser storage** (§2.5) | `Auth` |
| **16** | **Storefront: browse** | `Shop` (home), `StoreDesktop`, `ReviewsCustomer` (product page) |
| **17** | **Storefront: checkout** | `Shop` (cart → checkout → pending/success/failed → tracking) |
| **18** | **Customer account** | `CustomerAccount`, customer-side reviews |
| **19** | **Merchant shell** | `Sidebar`, `Dashboard`, `DashboardMobile`, `Notifications` |
| **20** | **Orders** | `Orders` — board + list, rider picker, cash confirmation, returns |
| **21** | **Rider** | `Rider`, `CashReport` — they must land together |
| **22** | **Catalogue screens** | `Products`, `AddProduct`, `Categories` |
| **23** | **Money** | `Wallet` |
| **24** | **Support & insight** | `Complaints`, `ReviewsMerchant`, `Customers`, `Analytics` |
| **25** | **Store design & staff** | `Customize`, `ThemeStudio`, `Settings` — including the **Staff** panel where a store admin creates managers and riders (§5.4). *Still undesigned — see Part 9* |
| **26** | **Onboarding & KYC** | `Onboarding`, `KYC`, `KYCOutcomes` |
| **27** | **Admin console** | the 13 `Admin*` boards, including `AdminTeam` (platform roles) |
| **28** | **Mobile & messaging** | `MobileOrders`, `MobileAddProduct`, `MobileTheme`, `MobileMore`, `Messages`, `PrintExports`, `ErrorPages` |

### Stage E — Cutover

| # | Milestone | Done when |
|---|---|---|
| **29** | **ETL + reconciliation report** (§5.5), run against a restored copy | The report is clean **twice in a row** on separate restores. Ledger sums equal wallet balances in both databases |
| **30** | **Cutover.** Freeze writes, run the ETL, run the report, switch DNS | Old database retained, untouched, for at least one settlement cycle |
| **31** | **Hardening.** Keyset pagination on every growing list, EXPLAIN review on real post-cutover volumes, final audit | No `.from()` outside repositories. No `SELECT *`. No file imports the old theme |

### What can run in parallel

Stage A is strictly sequential. After milestone 4, **Stage B (schema) and milestone 14 (UI kit) are
independent** and can run side by side — one is SQL, the other is React. Stage C's 12 and 13 need 11
for their API, but 14 does not need any of them.

Within Stage D, 15 comes first; after that, 16–18 (customer) and 19–25 (merchant) are largely
independent. 21 must not ship before 20 — the rider's handover assumes the merchant's rider picker.

## Part 8 — Risks

| Risk | Why it bites here | Mitigation |
|---|---|---|
| **High — long invisible stretch** | Phases 0–11 produce no user-visible change while the store keeps selling | Accepted deliberately: the old system runs untouched on the old database. The trade is a single cutover event instead of continuous risk |
| **High — variant matrix vs `reserve_stock`** | Reservation targets an `add_ons` row; per-combination stock changes the atomic path preventing two shoppers winning the last unit | Change the plpgsql function alone, first, under test. Never during a UI phase |
| **High — theme drift** | Preview and published compiled in different places diverge invisibly until a merchant complains | One compiler package; server re-runs it at publish and rejects anything that is not its own output |
| ~~High~~ **Medium — the ETL loses or mangles data** | Free-text categories, per-product option stock and a 7→12 status mapping all need judgement, not just transformation | **Downgraded by the profiling pass:** 3 stores, 29 orders, 14 products; categories have zero spelling variants; there are zero per-product variants to reshape; four live statuses to map. Still idempotent, still read-only against the source, still rehearsed until the reconciliation report is clean twice running — but the surface is small enough to verify by reading it |
| **High — the old ledger does not reconcile, today** | One store's pending and available pots drift by +100 and −100 against what the ledger implies, and the ledger is single-entry so it cannot be summed at all | Found before cutover rather than after (profile §7). Explain the ±100 before the ETL runs; decide whether the new ledger opens with a balance or with interpreted history |
| **High — money doesn't reconcile after migration** | Balances and ledger could already disagree in the old database | The report sums the ledger against the balances in **both** databases. A pre-existing discrepancy is found during rehearsal, not after cutover |
| **High — seed pointed at production** | It truncates | Loopback-only default, explicit opt-in, target printed before any write |
| **High — indexes chosen without evidence** | A wrong index taxes every write forever and is invisible until it isn't | EXPLAIN on seeded volumes before committing; each index justified by a named query. On the new database this is cheap — the tables are empty |
| **High — privilege escalation through delegated user creation** | A store admin who can grant a platform role, or add a member to another store, owns the platform | The four tests in §5.4, run in CI. Authorization checked at the endpoint, never by hiding UI |
| **High — CSRF once the session is a cookie** | Cookie credentials are sent automatically; `X-Tenant-Slug` is client-controlled and is not protection | Token or strict same-origin check on every state-changing request, added in milestone 15 |
| **Medium — cookie scope breaks store isolation** | A `.vendlyfy.com` cookie is shared by every store, contradicting `CustomerAccount` | Host-only cookies per store host, with the API same-origin under each. Decide with the domain question |
| **High — KYC is biometric data** | Face video plus national ID number. Retention, encryption at rest, restricted access and a lawful basis are obligations | Answer retention and vendor before phase 10 starts, not during |
| **Medium — config over-abstraction** | A config engine leaking into hundreds of scattered conditionals is worse than hardcoding | Components get `t()` and `has()` only. A third primitive is a design smell |
| **Medium — cash rounding** | Applies to cash totals but not card totals — exactly the rule that produces a discrepancy nobody notices for a month | Single formatter, property tests over generated amounts |
| **Medium — out-of-order migrations** | Two branches claim numbers and merge in the other order | Runner requirement 4; numbers claimed at merge |
| **Medium — the app can't use the container yet** | Zero `pg` in `server/src` | Expected and stated. Container serves migrations, seeds and tests until the repository layer lands |
| **Medium — cutover has no rollback if the old DB is dropped** | It is the only copy of pre-cutover truth | Keep it, untouched, for at least one settlement cycle |
| **Medium — `@apply` creep** | "Fully Tailwind" quietly becomes semantic CSS again | CI check |
| **Medium — Postgres version mismatch** | Differences surface only in deployment | **Container pinned to 17; the deployed instance must be 17.** `db:verify` asserts the running server matches the pin, so local drift is caught — nothing yet checks the deployed side, so that stays a discipline, not a control |
| **Low — orphaned tables** | `addon_groups`, `addon_items`, `menu_item_addon_groups`, `posts` | Resolved by the greenfield decision: they simply never exist. Check whether they hold rows during the ETL and record the answer |

---

## Part 9 — Open decisions

Answered: **the platform is Vendlyfy** (the canvas's "Soko" is a placeholder; the code's "Vendly"
is also wrong) · **the rider app stays** · **TypeScript both sides** · **Tailwind only** ·
**`V000_` migrations**.

**Newly answered:** the new system gets its **own database**; the live one is migrated across once
(§5.5) and kept as the rollback.

**Also answered:** **plain Postgres**, container locally and a managed instance deployed — not a
Supabase project (§4.2). That removes 61 role-grant and ~20 storage-policy statements from the
schema and makes the container an exact match for deployment.

**Answered at milestone 1:** **Postgres 17**, Debian-based, for the container — and therefore for
the deployed instance, which must match. Confirm 17 is available on the target host before
milestone 2 writes anything; a change after that is a `db:reset`, not an upgrade.

**One small thing left over.** Image storage: keep the existing Supabase bucket behind signed URLs,
or move to S3/R2. Stub the endpoint locally. Does not block `V000` — but it is no longer only about
product photos, because `kyc_documents` and `complaint_evidence` both point into the same store and
one of them holds biometric data.

**Answered at milestone 9 (V010): the notification sound preference is per device.** `Notifications`
says *"Sound is off for this device"*, and `notification_devices` takes it literally — one row per
device, identified by a server-issued httpOnly cookie, which is the only way to honour the wording
with no browser storage (§2.5). A person can leave the chime on at the counter tablet and off on their
own phone, which is the case the wording exists for.

**Newly open, from milestone 9's first part:**

- **Plan prices and fees.** `AdminPlans` says "Prices and fees are placeholders until finance confirms
  them", so `plans.monthly_price`, `payment_fee_percent` and `withdrawal_fee` are **NULL** — not zero,
  because zero is a price and NULL is "not decided". Nothing can be billed from a figure nobody
  agreed. Blocks billing, not any schema.
- **The notice period for a price change.** The same board says price and fee changes take effect after
  `[NOTICE PERIOD]` while feature changes apply immediately. That needs effective-dated prices, which
  cannot be designed until the period is a number.
- **`plan_features.delivery_and_riders` overlaps the industry module `delivery`.** One is commercial,
  one is by business type, and they gate the same capability. The effective answer is presumably "the
  module is on AND the plan grants it", but no board says so — **milestone 12's resolver has to decide
  it deliberately** rather than inherit it from the schema.
- **No card processor.** `Settings` offers "Cards · Visa and Mastercard" for a merchant to connect, and
  `AdminPayments` — the list of providers the platform integrates with — has none. **No `cards` row is
  seeded**, because a `payment_methods` row with a placeholder provider would assert an integration
  that does not exist, and `orders_payment_method_usable` would then pass an order nothing can charge.
  Choosing a processor is an open decision; adding it later is one INSERT plus its country and
  currency rows.
- **Where provider credentials live.** `store_payment_methods` records *that* a store connected a
  method, never the keys — secrets in an ordinary table are readable by every repository method, every
  backup and every support query. A secrets manager, or encrypted columns with the key outside the
  database, is a decision for the payments work.
- **Delivery zones: named areas or a radius?** `Settings`, which is the editor, has named areas and
  that is what is implemented. `States` tells a customer "this store delivers within 8 km of
  Kimihurura", which is a radius. Treated as approximate prose for now; if it is meant literally it is
  a new column and a map.
- **Where the KYC encryption key lives.** `kyc_submissions` holds the ID number as `bytea` with an
  `encryption_key_id` naming which key encrypted it, and **the key is deliberately not in the
  database** — the same decision as provider credentials above, and the same reasoning. Adding a
  pgcrypto call with the key in a settings table would be worse than plaintext, because it would look
  solved. **Blocks milestone 26**, together with the vendor and the retention period.
- **Re-verifying an expired document.** `kyc_submissions` records `document_expires_on` and no board
  says what happens the day it passes — whether the approval lapses, whether payouts stop, how much
  notice a merchant gets. `submit_kyc()` therefore refuses a verified store outright rather than
  quietly opening a second case beside the approved one, which would leave `store_is_verified()` true
  throughout and mean nothing.
- **Whether two automatic promotions should stack.** `order_discounts` permits several rows, the
  subtotal caps their sum and one promotion cannot apply twice, so the total can never go wrong. But
  whether a store *wants* both its lunch offer and its weekly percentage to apply at once is
  commercial, and no board answers it.
- **Free delivery is not a promotion type**, because no board offers one and because it would have to
  reach `delivery_fee_amount` rather than `discount_amount` — Shop is explicit that a discount is
  "10% off your items". When it is wanted it is a fourth `discount_type` and a change to one
  constraint, not a manual discount dressed up as one.
- **Payment webhook hosts** are `example.invalid` until the domain question below is answered.
  Deliberate: RFC 2606 guarantees it can never resolve, so a half-configured deployment fails loudly
  instead of posting a payment confirmation to somebody else's server.

Still open, and all five block something:

1. **Domain name, and subdomain vs path routing.** `[DOMAIN]` appears on 8 boards and inside
   `Onboarding`'s core interaction. Today the tenant comes from the first path segment
   (`api.js` → `X-Tenant-Slug` → `tenant.js`); the design assumes `store.[DOMAIN]`, resolved from
   the `Host` header. *Recommendation:* **subdomain canonical, path kept as a permanent alias** —
   resolve `Host` first, fall back to the path. Old URLs keep working, per-store account isolation
   comes free from origin-scoped `localStorage` (which `CustomerAccount` specifies), and you can
   ship path-only and enable subdomains when wildcard DNS and TLS are ready, without touching
   application code twice. **Blocks milestone 15** — cookie scope and store isolation are the same
   decision (§2.5), so this is needed for auth, not just for the storefront.
2. **Multi-country scope** — five countries and six currencies are designed, two marked "not
   launched". *Recommendation:* model all of it, enable Rwanda and RWF only. **Blocks milestone 27.**
3. **KYC vendor and retention period** — automatic document authenticity, liveness, face match and
   duplicate detection are a vendor, not something to build. `AdminKYC` leaves
   `[RETENTION PERIOD]` as a placeholder; that is a legal decision. **Blocks milestone 26.**
   *As of V012 both are ready to receive an answer and neither is guessed:* `kyc_checks` records the
   six outcomes the board lists and keeps the vendor's own report whole in `vendor_result`, so
   adopting a vendor is a mapping rather than a migration; and `purge_expired_kyc_documents()` acts on
   `kyc_documents.retain_until`, which is NULL on every row, so the sweep does nothing at all until
   somebody sets a period. Retention also interacts with the audit chain: pruning entries means the
   chain no longer starts at 1, which is why `verify_audit_chain()` takes a starting point.
4. **SMS provider** — none exists. **Blocks milestone 28.**
5. **Cutover window** — the freeze at milestone 30 stops writes on the live system for as long as
   the ETL and its report take. Rehearsal (milestone 29) tells you how long that is; the decision
   is when, and who is told. **Blocks milestone 30, not before.**

### Still owed by the designer

Not blocking, all small: the **rename sweep** (19 `Soko`, 19 `soko.rw` across 8 boards — asked
twice, not started) · `Settings` **Store details** and **Staff** panels (3 of 5 since round 1) ·
`AddProduct` **shared option groups** · `Products` **inline stock editing** · `StoreDesktop`
**option sheet and search results**.
