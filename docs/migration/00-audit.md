# Pre-Migration Architecture Audit

**Repo:** `restaurant_os` (Vendly) · **Branch:** `master` @ `2d59328` · **Date:** 2026-09-10
**Scope:** read-only analysis. No source files were modified.

---

## Verdict

Three of the migration brief's four premises are **already satisfied** by this repository.
The fourth — moving database access behind a controlled backend — is not a modernization
task here. It is **the fix for a live, exploitable hole**.

---

## P0 — The database is publicly readable and writable right now

The backend authenticates to Postgres with `VITE_SUPABASE_ANON_KEY` — the *same key that
ships inside the client JavaScript bundle* (`client/src/services/supabase.js`, and
`server/src/config/supabase.js` reads the identical variable).

That key maps to the Postgres `anon` role. Verified against the live database:

| Check | Result |
|---|---|
| Public tables with RLS **disabled** | **22 of 23** |
| Tables granting `anon` full `SELECT/INSERT/UPDATE/DELETE/TRUNCATE` | **23** |
| RLS policies on application tables | **0** (only `posts` has RLS on) |
| Distinct credentials between browser and server | **0 — it is one key** |

Anyone who opens the storefront, reads the bundle, and issues one HTTP request to the
Supabase REST endpoint can read `users.password_hash`, rewrite `wallets` and `orders`, or
approve their own row in `withdrawal_requests` — without ever touching Express. Every JWT
check, role guard and tenant scope in `server/src` is advisory, not enforced.

**The fix is already in the repo.** `DATABASE_URL` is a privileged server-only connection
string and `pg@8` is already a dependency. See the plan below.

---

## Premise check

| Brief assumed | Reality | Work |
|---|---|---|
| Business logic in Supabase Edge Functions | **Zero functions exist.** `supabase/` holds 13 `.sql` files. A controlled Express backend already exists: 4,732 LOC, 14 route modules, 76 endpoints. | **None.** Brief phases 4, 13, most of 15 & 18 have no subject. |
| Migrate routing to React Router 7 | `react-router-dom@7.18.2` already installed and in use; 11 routes with params and role guards. | **None.** Data router adoption is optional. |
| Migrate frontend JS → TS | Correct. 31 files, 6,788 LOC, zero `.ts`/`.tsx`. `@types/react` already installed. | **Real.** |
| Move DB access behind backend w/ parameterized SQL | Access is physically in the backend but goes through `supabase-js` on a public key. 152 `.from()` + 8 `.rpc()` across 20 files. | **Real and urgent** — this *is* the security fix. |

---

## A. Current architecture

| Layer | Implementation |
|---|---|
| Frontend | React 19.2 + Vite 8, plain JS/JSX, Tailwind v4 (CSS-first), oxlint |
| Routing | react-router-dom 7.18.2, component routes (not data router) |
| API transport | axios; JWT from `localStorage` + `X-Tenant-Slug` header per request; global 401 → redirect |
| Backend | Express 4.21, 14 route modules, 8 services, express-validator, Socket.io 4.7 |
| Auth | Custom JWT (`jsonwebtoken`) + `bcryptjs`. **Not** Supabase Auth. |
| Multi-tenancy | `resolveTenant` middleware → `req.tenant`; scoping enforced in application code |
| DB access | supabase-js query builder on the **anon key** |
| Edge Functions | **None** |
| External | MTN MoMo, SendGrid, Supabase Storage |
| Deployment | Render: Node service (`server/`) + static site (`client/dist`), SPA rewrite |
| Tests | **None.** No runner, no script, no test files. |

**Only direct browser → Supabase call:** `uploadImage()` writes to the `blog-images` bucket,
whose policies allow unauthenticated INSERT/UPDATE/DELETE. Needs to move behind a
backend-issued signed URL.

## B. JS → TS inventory (31 files, 6,788 LOC)

| Tier | Files | LOC | Risk |
|---|---|---:|---|
| 1 Foundation | `config/brand.js`, `services/api.js`, `services/socket.js`, `services/supabase.js`, `main.jsx` | 179 | Low |
| 2 Domain types | *new* `types/*.ts` | — | Must model derived `in_stock`/`low_stock` from `withStockFlags()` |
| 3 State + guards | `AuthContext`, `CartContext`, `ProtectedRoute` | 211 | Medium — null-default contexts |
| 4 Shared components | Logo, AuthShell, TenantThemeInjector, Navbar, Categories/Options/StaffManagement | 1,041 | Low–medium |
| 5 Storefront pages | Landing, Login, Register, Home, Cart, Checkout, ProductDetail, TrackOrder, OrderTracking | 1,905 | Medium |
| 6 Dashboards | Admin (994), Manager (600), Products (625), Complaints (495), SuperAdmin (438), Delivery (131) | 3,283 | High — 48% of codebase |

**Toolchain gaps:** no `tsconfig.json`; no `typecheck` script. **oxlint does not typecheck, and
`vite build` does not either** (esbuild strips types) — `tsc --noEmit` must be its own gate.

## C. Supabase Function inventory

Empty by verification: no `supabase/functions/`, no `deno.json`, no `functions.invoke` anywhere.

The closest analogue is 8 plpgsql functions called via `.rpc()`. These are **correct design, not
debt** — they provide atomicity application code cannot:

- `reserve_stock` / `release_stock` — conditional UPDATE + ROW_COUNT so two shoppers racing for the last unit can't both win
- `credit_wallet_pending` / `release_eligible_orders` — balance + ledger move together
- `request_withdrawal` / `reverse_failed_withdrawal` — debit + request atomically
- `approve_refund_deduct_wallet` — approval + debit in one transaction

They get *called* differently after migration (`SELECT reserve_stock($1,$2,$3)` via `pg`), but
their bodies do not change. Pulling this into Node would be a regression.

## D. Database inventory (23 tables, 8 functions, 0 triggers)

- **Tenancy/identity:** `tenants`, `users`
- **Catalogue:** `menu_items`, `add_ons`, `categories`, `menu_item_addons`
- **Orders:** `orders`, `order_items`, `order_item_addons`
- **Money:** `wallets`, `wallet_ledger`, `withdrawal_requests`, `refund_requests`, `momo_transactions`
- **Support:** `reviews`, `complaints`, `notifications`, `delivery_assignments`, `delivery_persons`
- **Orphaned (TypeORM-era):** `addon_groups`, `addon_items`, `menu_item_addon_groups`, `posts` — *do not drop during this migration*

**No migration framework.** Ordering is load-bearing but implicit: `inventory.sql` creates a
2-arg `reserve_stock` that `option-sizes.sql` must drop and replace with the 3-arg version. A
fresh DB rebuilt in the wrong order silently gets a different schema.

## E. Routing inventory (11 routes — all URLs must survive)

`/` · `/login` · `/register` · `/:tenantSlug` · `/:tenantSlug/menu/:id` · `/:tenantSlug/cart` ·
`/:tenantSlug/checkout` · `/:tenantSlug/track` · `/:tenantSlug/orders` (auth) · `/manager`
(manager,admin) · `/admin` (admin) · `/delivery` (delivery) · `/super-admin` (super_admin)

**No `*` / 404 route.** Worse: `api.js` treats any unrecognised first path segment as a tenant
slug and *writes it to `localStorage`* — one typo'd URL poisons the tenant header for every
later request in that browser.

## F. Authentication inventory

| Concern | Behaviour | Assessment |
|---|---|---|
| Login | bcrypt compare → signed JWT | Sound |
| Storage | `localStorage` | XSS-readable; contained decision, not a blocker |
| Validation | `jwt.verify` + DB re-read of user each request | Good — role changes take effect immediately |
| Refresh | **None** | Gap — expiry logs users out mid-session |
| Logout | Clears localStorage; token valid until expiry | No revocation |
| Authorization | `authorize(...roles)`, `superAdminOnly` | **Bypassable** — not a flaw in the guard; the anon key routes around Express |
| Socket.io | JWT in handshake; unauthenticated connections allowed through for guest tracking | Intentional; room joins gated on `socket.userId` |

**Recommendation: keep this system.** It is coherent. Swapping in Supabase Auth mid-migration
adds identity risk for no architectural gain and the brief does not require it.

**Credit where due:** `momoWebhook.js` deliberately refuses to trust its callback payload and
re-verifies status with MoMo's authenticated endpoint. That is the right call — preserve it.

## G. Dependency map

| Feature | Path today | `.from()` |
|---|---|---:|
| Browse & buy | Home/ProductDetail → api.js → /api/menu → supabase-js → menu_items+add_ons | 13 |
| Place order | Checkout → /api/orders → price re-fetch → rpc(reserve_stock) → orders → Socket.io | 21 |
| Payments | momoClient → MTN → /api/momo/callback → walletService → rpc(credit_wallet_pending) | 32 |
| Catalogue admin | ProductsManagement → /api/menu/manage + /categories + /addons → syncVariants | 25 |
| Platform admin | SuperAdminDashboard → /api/tenants (no tenant scoping) | 22 |
| Image upload | **browser → Supabase Storage directly** (bypasses backend) | — |

## H. Target architecture

| Layer | Today | Target |
|---|---|---|
| Frontend language | JS/JSX | **TS/TSX**, `tsc --noEmit` in CI |
| Router | RR7 component routes | RR7 — *unchanged* |
| API client | untyped axios | typed client over the same instance |
| Backend | Express, routes hold logic + queries | Express — *same framework*; routes → services → repositories |
| **DB driver** | **supabase-js on anon key** | **`pg.Pool` on `DATABASE_URL`**, parameterized SQL in repositories |
| Transactions | plpgsql only | plpgsql (kept) + `withTransaction()` |
| Anon key role | server + client credential | **signed Storage uploads only**; revoked from all app tables |
| Observability | `console.log` (incl. one printing every tenant slug) | structured request-scoped logging |
| Tests | none | Node test runner + supertest; Vitest client-side |

**Deliberately unchanged:** Supabase Postgres, Supabase Storage, custom JWT, Express,
Socket.io, every URL, every pixel of UI.

## I. Migration plan (resequenced — security before TypeScript)

1. **Close the hole (P0).** Add `server/src/db/pool.js` on `DATABASE_URL`. Revoke `anon` grants
   per table group — *only after* every query touching that table runs through `pg`. Start with
   `users`, `wallets`, `wallet_ledger`, `withdrawal_requests`, `momo_transactions`.
   *Gate: anon key proven unable to read `users`; all endpoints green.*
2. **Test harness before rewriting queries.** Zero tests, 152 queries to rewrite.
   Characterization tests recording today's responses make the rewrite verifiable.
   *Gate: money + order paths have response-shape coverage.*
3. **Repository layer, feature by feature.** Hardest first: wallet → orders → auth/tenants →
   menu/addons/categories → rest. plpgsql functions are called, not rewritten.
   *Gate: per feature — tests pass, then that table's grants are revoked.*
4. **Storage upload behind the backend.** Signed upload URL; tighten bucket policies. Last thing
   holding the anon key in the client bundle.
5. **Hardening pass.** Ordered migration table; structured logging + request ids (delete the
   tenant-slug `console.log`); rate limits on `/api/auth` and the MoMo callback; `helmet`;
   move server secrets out of `client/.env`; un-ignore `.env.example`.
6. **TypeScript foundation.** `tsconfig.json` with `allowJs`; `typecheck` script in the build
   gate. Domain types written against now-stable API contracts — which is why this follows the
   backend work rather than preceding it.
7. **Incremental JS → TS, tiers 1→6.** Strictness ratchets per tier. No `@ts-ignore` shortcuts.
   *Gate: per tier — typecheck, lint, build clean; UI visually unchanged.*
8. **Cleanup and final audit.** Remove `@supabase/supabase-js` from the server. Confirm no
   `.from()` outside repositories. Re-run the RLS/grants audit.

## J. Risks

| Risk | Why it bites here | Mitigation |
|---|---|---|
| **High** — revoking grants too early | Revoke before the last `supabase-js` caller is migrated → 500s in production | Grep the table name across `server/src` before each revoke; revoke *after* the gate |
| **High** — silent SQL behaviour drift | supabase-js has non-obvious semantics: `.single()` errors on 0 rows, embedded selects become implicit joins, `.or()` needs quoting | Characterization tests first; treat response shape as the contract |
| **High** — money paths | `walletService` is 464 LOC / 32 queries and least forgiving | Migrate first, under test. Never touch plpgsql bodies. |
| **Medium** — connection limits | Supabase caps direct connections; naive `pg.Pool` on Render can exhaust them where PostgREST pooled centrally | Bounded pool; use pooler port; verify under load |
| **Medium** — tenant scoping moves into SQL | Every `.eq('tenant_id', …)` becomes a hand-written `WHERE`. One omission = cross-tenant leak. | `tenantId` mandatory first param on every repository method; isolation test |
| **Medium** — dashboard TS migration | 3,283 LOC, six files, no tests, most intricate state | Last tier, one file at a time, visual comparison |
| **Low** — rebuilding schema | Implicit file order → fresh DB gets 2-arg `reserve_stock` | Ordered migration table (phase 5) |

## K. Open questions

1. **Is this database serving real users right now?** Changes phase 1 from a task into an
   incident. If real sellers and money are on it: revoke grants today under close watch and
   rotate credentials afterwards — the anon key has been public in every deployed bundle.
2. **Should the backend migrate to TypeScript too?** The brief says frontend only, but the
   backend is where the repository layer and SQL contracts land, and it handles money.
   *Recommendation: yes, after the frontend* — typing it later means writing it twice.
3. **Do the four orphaned tables hold anything?** Not dropping them either way, but empty vs.
   populated determines cleanup vs. data.
4. **Is the RR7 data router actually wanted?** Optional refactor, real churn, no behaviour
   change. *Recommendation: skip, or defer until after TypeScript.*
