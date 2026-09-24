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
- **`money`** — one formatter driven by the currency table: symbol, position, decimals, separator,
  and **cash rounding that applies only to cash-on-delivery totals**. Property tests, not examples.

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
packages/core/      theme-engine · config · money · types     milestone 3 (TS, ESM)
client/src/         shared/ui · storefront/ · merchant/ · admin/
server/src/         routes/ services/ repositories/ db/
```

**Built:** `db:up` · `db:down` · `db:reset` · `db:verify` · `db:psql` · `db:logs`.
**Later:** `db:migrate` · `db:migrate:new` · `db:migrate:status` (milestone 2) · `db:seed` (10) ·
`db:types` (5). There is no `db:baseline` — §2.4.

The root `package.json` is deliberately dependency-free until milestone 3, when workspaces land. It
needs no `npm install`.

`supabase/` is **retired, not deleted** — kept in history, referenced from `V000`'s header.

---

## Part 5 — Data model changes

### 5.1 Renamed and reshaped

| Today | Target |
|---|---|
| `tenants` | `stores` (+ industry template & pinned version, country, selling currency, lifecycle status, plan, config overrides, draft & published theme) |
| `users.role` + `UNIQUE(email, tenant_id)` | `users` (identity) + `store_members` + `platform_members` + `role_permissions` — see §5.4 |
| `menu_items` | `products` (+ draft/active, compare-at price, SKU, cover image, position, product flags) |
| `add_ons` | `option_groups` + `option_values` |
| — | **`product_variants`** — new and unavoidable |

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
| **3** | **TypeScript + ESM.** `tsconfig` strict for client, server and `packages/core`; `tsc --noEmit` in CI; server CommonJS → ESM | A deliberate type error fails CI. The server boots on ESM with every existing route still answering |
| **4** | **Tailwind reset.** Delete the old `@theme`, the `@layer components` semantic classes and the `:root` bridge. New `@theme` with the fixed tokens. Runtime CSS-variable plumbing for the nine per-store tokens | One page renders in Bricolage/Figtree on `#F6F5F1` with no legacy CSS reachable. CI rejects `@apply` |

### Stage B — Schema

Each milestone is one or more `V###_` migrations, with its indexes declared in the same file and
justified by a named query.

**Before writing `V001`, profile the old database.** A read-only pass — distinct values of
`menu_items.category` and how many are typo or casing variants of each other; how many `add_ons`
rows carry `menu_item_id` and what their stock looks like; how many emails appear in more than one
tenant; the distribution of `orders.status`; whether the four orphaned tables hold rows; whether
`wallet_ledger` actually sums to `wallets`. It costs an afternoon and it decides several schema
questions that would otherwise be guessed now and discovered at milestone 29.

| # | Milestone | Done when |
|---|---|---|
| **5** | **Identity, stores & memberships (§5.4).** `stores`, `users` (identity only), `store_members`, `platform_members`, `role_permissions` | One person holds **Owner at one store and Manager at another** — the case `Auth`'s store picker draws. `db:types` generates row types |
| **6** | **Config.** `industry_templates` (versioned, draft/published), store config overrides | The six templates from `AdminIndustries` are expressible as rows, including Pharmacy's `order_steps` and product flag |
| **7** | **Catalogue.** `products`, `categories` + join, `option_groups`, `option_values`, `product_variants`, **`carts`** (§2.5 — server-side, anonymous-session-keyed, 7-day expiry) | A fashion product with 12 size×colour variants, each carrying its own stock and SKU. A shared store-wide option group attached to two products. A cart survives a browser with storage disabled |
| **8** | **Orders & money.** `orders` (12 statuses), `order_items`, `wallets`, `wallet_ledger` with running balance, withdrawals, refunds, momo transactions — plus the seven plpgsql functions, with **`reserve_stock` rewritten against variants** | Two concurrent reservations of the last unit: exactly one wins. This is a test, not an inspection |
| **9** | **Supporting domains.** complaints, reviews + replies, notifications, audit log, payment methods, currencies, KYC, delivery zones, promotions, plans & fees, rider shifts & cash | Every table the 53 boards need exists. No board has nowhere to store its data |

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
| **High — the ETL loses or mangles data** | Free-text categories, per-product option stock and a 7→12 status mapping all need judgement, not just transformation | Idempotent, read-only against the source, rehearsed on restored copies until the reconciliation report is clean twice running |
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

**Two small things left over.** First, the **notification sound preference** — `Notifications` says
*"Sound is off for this device"*, and with no browser storage that is either a per-user-per-device
row keyed by a cookie, or per-user with the wording changed (§2.5). Second, image storage. Keep the existing Supabase bucket behind signed URLs,
or move to S3/R2. Stub the endpoint locally. Does not block `V000`.

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
4. **SMS provider** — none exists. **Blocks milestone 28.**
5. **Cutover window** — the freeze at milestone 30 stops writes on the live system for as long as
   the ETL and its report take. Rehearsal (milestone 29) tells you how long that is; the decision
   is when, and who is told. **Blocks milestone 30, not before.**

### Still owed by the designer

Not blocking, all small: the **rename sweep** (19 `Soko`, 19 `soko.rw` across 8 boards — asked
twice, not started) · `Settings` **Store details** and **Staff** panels (3 of 5 since round 1) ·
`AddProduct` **shared option groups** · `Products` **inline stock editing** · `StoreDesktop`
**option sheet and search results**.
