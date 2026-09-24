# Target Architecture — rebuilding the product on the Soko design

**Design source:** "Universal Commerce Platform" canvas, 25 artboards, version `1790181439-6136`
**Repo:** `restaurant_os` @ `master` `b5a43e5` · **Date:** 2026-09-23
**Companion:** [`00-audit.md`](00-audit.md) — the pre-migration audit. This document supersedes
parts of its plan; those points are marked **[supersedes audit]**.

---

## 1. What the design actually is

The canvas is not a reskin of the current app. It is a different product shape with the same
money engine underneath.

Four of the 25 artboards are **not screens**. They are specifications:

| Artboard | What it really is |
|---|---|
| `Main` — "Design system" | The token set and component contract. Build the UI kit from this, not from screens. |
| `Industries` — "Industry configurations" | The architectural spine, stated outright: *"Industries are configurations, not apps."* |
| `States` — "Edge cases & states" | 20 named states with exact copy. An acceptance checklist, not a page. |
| `ShoeStores` — "Three shoe stores, one platform" | Proof that one component set yields three different-looking stores. A visual regression fixture. |

Three more are **components**, not routes: `Sidebar`, `AdminSidebar`, `StorePreview`.

That leaves **18 shippable screens across 3 personas** — customer, merchant, super admin.

### The spine

> Choosing a business type at sign-up writes a config: words, attribute presets, and which
> modules are on. The merchant can change any of it later in Settings.
> — `Industries.dc.html`

Every downstream decision follows from this. There is one product engine. Industry differences
are **data**: a template holding `words`, `modules`, `attributes`, `product_flags`, and
`order_steps`. The design proves the claim by adding Pharmacy — a new business type — with no
new components: an Rx badge fills the card's existing badge slot, prescription upload reuses the
photo input from Add product, and "Pharmacist check" is one more entry in the order-steps array.

**If a component ever branches on industry name, the architecture has failed.**

---

## 2. What is being kept

The design changes what is shown and what is configurable. It does not change how money moves.
These stay, unchanged:

- Supabase Postgres, Supabase Storage
- Express 4.21, the route → service structure, Socket.io
- Custom JWT + bcrypt auth (not Supabase Auth)
- MTN MoMo integration, including the webhook that re-verifies status against MoMo's
  authenticated endpoint rather than trusting the callback payload
- The seven plpgsql functions (`reserve_stock`, `release_stock`, `credit_wallet_pending`,
  `release_eligible_orders`, `request_withdrawal`, `reverse_failed_withdrawal`,
  `approve_refund_deduct_wallet`) — they provide atomicity application code cannot
- Wallet, ledger, withdrawal and refund logic
- The service-role/anon split already in place (`server/src/config/supabase.js`); the anon key
  now does exactly one thing in the browser — PUT to a backend-issued signed upload URL

## 3. What is being replaced

- **All 40 client source files.** 7,926 LOC of JSX on the "Clean light SaaS" theme.
- **The current design direction.** `client/src/index.css` defines Inter/Outfit, `#f8fafc`
  ground, `#DC2626` accent. The new design is Bricolage Grotesque / Figtree / JetBrains Mono,
  `#F6F5F1` ground, `#17160F` ink, and **no fixed accent** — the accent is per-store and
  merchant-chosen. The ~10 screens already converted to the old direction are superseded.
- **The catalogue model.** `add_ons` cannot represent per-combination stock (see §6).
- **The order status enum.** Becomes a per-template array.

---

## 4. Layer model

```
  L5  Apps          storefront · merchant console · admin console
  L4  UI kit        components from Main.dc.html + States.dc.html
  L3  Core          theme-engine · config resolver · money · domain types   ← shared, isomorphic
  L2  Services      Express services + repositories
  L1  Data          Postgres: templates, stores, catalog, orders, money, identity
  L0  Tokens        fixed neutrals, status colors, type, spacing, radius, elevation
```

L0 and L3 are the load-bearing additions. Everything else in the design is an arrangement of them.

### L0 — Tokens

Two classes, and the distinction is enforced, not stylistic:

**Fixed.** Identical in every store, every theme. Neutrals (Ink `#17160F`, Ink2 `#3B3A33`,
Muted `#5F5C53`, Line `#E5E2DA`, Ground `#F6F5F1`, Surface `#FFFFFF`). Status colors
(success / warning / danger / info / transit, each with a fill and a text pair). Spacing on a
4-point scale. Radius: 8 chips, 10 controls, 14 cards, 20 sheets, pill badges. Elevation: 0
border, 1 menus, 2 sheets. Type ramp: Display 40/44·700, Heading 24/30·700, Title 17/24·600,
Body 15/22·400, Caption 13/18·500, Button 15/20·600, Mono 13·500.

Status colors are fixed **for a product reason**: a "Paid" badge must mean the same thing in
every store. They are not themeable and must not be reachable from the theme engine.

**Derived.** Nine tokens produced per store by the theme compiler: page, surface, text, muted,
border, primary, on-primary, accent, on-accent, plus selected-tint and hero pair.

Two hard rules from the design system artboard, both testable:
- Order state is a **filled** badge, payment state is an **outlined** badge, so both read in one
  row. Each carries a word — never color alone.
- Touch targets ≥ 44px. Prices use tabular figures.

### L3 — Core (the reason this must be TypeScript)

Three modules that the browser **and** the Express server both import. Duplicating any of them
is the single most likely source of "the preview doesn't match the live store" bugs.

**`theme-engine`.** Takes eight inputs — brand color, accent mode (auto/manual), accent,
harmony (complementary / analogous / split / mono), mood (light / warm / dark), shape
(sharp / soft / round), heading font (modern / editorial / sport / classic), card treatment
(flat / outlined / raised), hero (soft tint / bold fill). Returns the nine derived tokens, a
contrast report, and a plain-language list of what it adjusted.

It enforces WCAG as it goes: body and muted text 4.5:1 against the page, button text 4.5:1
against the button, buttons 3:1 against the page — and where a brand color is too close to the
page it gives buttons a thin outline instead of failing. `ThemeStudio.dc.html` states the
guarantee: *"Soko adjusts automatically so no store can publish something unreadable."*

**That guarantee only holds if the compiler is the only path to a published theme.** The API
must re-run the compiler server-side on publish and reject any token set that isn't its own
output. Client-side compilation is for live preview only.

**`config`.** Resolves a store's effective configuration and exposes exactly two primitives to
components: `t(key)` for vocabulary and `has(module)` for feature gates. Anything more complex
belongs in the resolver, not in a component. This is the guard rail against the config engine
degenerating into 200 scattered conditionals.

**`money`.** One formatter, driven by the platform currency table: symbol, symbol position,
decimals, thousands separator, and cash rounding. Cash rounding applies **only** to
cash-on-delivery totals, so riders don't need small change — a narrow rule in a place where
bugs cost real money. It gets property tests, not examples.

**[supersedes audit]** The audit sequenced TypeScript as phases 6–7, after the backend work.
That ordering assumed the frontend was being *converted*. It is being *rewritten*, and L3 is
shared with a JS backend. New code is TypeScript from phase 1; old JSX is not converted, it is
deleted as each screen is rebuilt. `tsc --noEmit` is its own CI gate from day one — `oxlint`
does not typecheck and `vite build` strips types without checking them.

---

## 5. The config engine

### Shape

An **industry template** (platform-owned, versioned, draft/published) carries:

- **words** — the noun map. Food: Products→Menu items, Catalog→Menu, Categories→Sections,
  Options→Extras. Fashion: →Products, Shop, Collections, Variants. Beauty: →Products, Shop,
  Brands, Shades. Grocery: →Products, Aisles, Aisles, Pack sizes. Pharmacy: →Medicines, Shop,
  Sections, Pack sizes.
- **modules** — modifiers, delivery, pickup, table ordering, scheduled orders, stock tracking,
  appointments, prescription.
- **attributes** — suggested attribute presets with their pick mode (one / several), surfaced as
  one-tap suggestions in Add product.
- **product_flags** — e.g. `prescription_required`, which existing components already know how
  to render: a badge in the card's badge slot, a required checkout step, a note on the order.
- **order_steps** — the customer timeline and the merchant's action buttons. Food: New →
  Preparing → Ready → Delivered. Fashion: New → Packed → Out for delivery → Delivered. Grocery:
  New → Picking → … Pharmacy: New → Pharmacist check → Preparing → Ready → Delivered.

A **store** picks a template at sign-up and may override any of it in Settings. The **resolver**
composes `published template version + store overrides → effective config`, server-side, once,
and serves it as a single versioned payload to both the storefront and the dashboard. The client
never composes it. Cache it with an ETag; bump on publish.

### Why this is the first thing built

Every screen downstream reads it. The product form's suggestions, the sidebar's labels, the
order timeline, the storefront's category word, the checkout's extra steps. Building screens
first and retrofitting config is how the "one set of parts" promise gets lost.

### Acceptance

`ShoeStores.dc.html` and `Industries.dc.html` are the test: switching a store's template must
change vocabulary, navigation, the product form, and the order timeline **with zero component
changes**.

---

## 6. Data model delta

### Renamed and reshaped

| Today | Target | Why |
|---|---|---|
| `tenants` | `stores` | Plus: industry template + pinned version, country, selling currency, lifecycle status (pending / active / suspended / rejected), plan, config overrides, draft and published theme |
| `menu_items` | `products` | Plus: active/draft status, compare-at price, SKU, cover image, position, product flags |
| `add_ons` | `option_groups` + `option_values` | Today one flat table carries both the group and its values, with `menu_item_id` distinguishing per-product variants from store-wide options. The design's Add product screen builds and names groups explicitly, with a per-group pick mode. |
| — | `product_variants` | **New and unavoidable.** See below. |

**The variant gap.** Today a per-product size lives as an `add_ons` row with its own
`stock_quantity`. That can express "M has 4 left". It **cannot** express "Black/M has 4 left",
because size stock and color stock are separate rows. The design requires exactly that:
*"Size × color makes 12 variants, each with its own stock and SKU"* (`Industries.dc.html`), and
`AddProduct.dc.html` generates the combination matrix with a generated SKU and a stock field per
row. This needs a combination table. It is the largest single change to the order path, because
`reserve_stock` currently reserves against an `add_ons` row.

Cap the matrix — three groups of five values is 125 rows — and generate lazily with an explicit
limit and a clear message rather than silently producing hundreds of rows.

### New tables

| Table | Drives |
|---|---|
| `industry_templates` (versioned, draft/published) | `AdminIndustries` |
| `payment_methods` | `AdminPayments` — provider, countries, chargeable currencies, min/max per payment, checkout label and hint, credential reference, webhook, status (draft/live/paused), merchant fee, payout schedule, new-store hold |
| `store_payment_methods` | Which stores turned which on — `Settings` |
| `currencies` | `AdminCurrencies` — symbol, position, decimals, separator, cash rounding, enabled, rate source (feed/manual), manual rate |
| `kyc_submissions`, `kyc_documents`, `kyc_checks` | `KYC` + `AdminKYC` |
| `merchant_verifications` | `AdminMerchants` — the four checks: phone, national ID, business registration, payout account |
| `store_themes` | Draft + published inputs and compiled tokens |
| `store_sections` | `Customize` — homepage section order and on/off |
| `delivery_zones` | `Settings` — name, areas, fee, ETA |
| `promotions` | Promo codes and automatic promos (`SOKO10`, the free-fries rule) |
| `audit_log` | Every admin action: revealing a full ID number, suspending, impersonating, publishing a payment method |

### Kept as-is

`users`, `orders` (+ columns), `order_items`, `wallets`, `wallet_ledger`,
`withdrawal_requests`, `refund_requests`, `momo_transactions`, `complaints`, `reviews`,
`notifications`, `platform_settings`.

### Migration mechanics

- **Adopt a real migration tool first.** The audit flagged that `supabase/*.sql` ordering is
  load-bearing but implicit — `inventory.sql` creates a 2-arg `reserve_stock` that
  `option-sizes.sql` must drop and replace. Ten new tables makes that worse, not better. This is
  now a blocker, not a cleanup item.
- **Rename behind the repository layer.** `menu_items` → `products` touches 152 `.from()` call
  sites. Land the repository layer first so exactly one layer changes; use views for
  backward compatibility during the transition, then drop them.
- **Order statuses are mapped, never rewritten in place.** Existing orders carry today's
  statuses; the new per-template steps need a mapping table so history stays readable.

---

## 7. Screen map

### Customer — storefront

| Artboard | Route | Notes |
|---|---|---|
| `Shop` (390×844) | `/:store`, `/:store/p/:id`, `/:store/cart`, `/:store/checkout`, `/:store/orders/:code` | The whole mobile purchase flow: browse → option sheet → cart → checkout → payment → tracking |
| `StoreDesktop` (1440×1100) | same routes | Category rail + 3–4 col grid + persistent cart panel |
| `StorePreview` | — | Component, embedded in Customize and Theme studio |

### Merchant

| Artboard | Route |
|---|---|
| `Onboarding` | `/start` — 4 steps: business + industry, look and feel, first product, ready |
| `KYC` | `/verify` — ID capture then automatic 5-second face video |
| `Dashboard` / `DashboardMobile` | `/app` — one route, two layouts |
| `Orders` | `/app/orders` — split list/detail on desktop, drawer on tablet |
| `Products` | `/app/products` |
| `AddProduct` | `/app/products/new`, `/app/products/:id` |
| `Customize` | `/app/store-design` |
| `ThemeStudio` | `/app/store-design/theme` |
| `Settings` | `/app/settings` — features, delivery and pickup, payments, store details, staff |
| `Sidebar` | — component |

### Super admin

| Artboard | Route |
|---|---|
| `AdminOverview` | `/admin` |
| `AdminMerchants` | `/admin/merchants` |
| `AdminKYC` | `/admin/identity` |
| `AdminPayments` | `/admin/payment-methods` |
| `AdminCurrencies` | `/admin/currencies` |
| `AdminIndustries` | `/admin/industries` |
| `AdminSidebar` | — component |

### Responsive rules (from `Main.dc.html`, not invented)

- **Mobile, under 600:** 2-column products, sticky cart bar, options and payment in bottom
  sheets, single-column checkout. Merchant nav becomes a 5-item bottom bar. Tables become cards
  with the same fields in the same order.
- **Tablet, 600–1023:** 3-column products, centered sheet for options. Sidebar collapses to a
  64px icon rail; order detail opens as a drawer over the list.
- **Desktop, 1024+:** full 248px sidebar, split list/detail, bulk actions in tables.

Overlay rules: sheets for choices on mobile, drawers for detail on desktop, modals **only** to
confirm something destructive.

---

## 8. What the design does not cover

This is the part most likely to be missed. "Match the design 100%" covers 18 screens. The
product is larger than that. These exist in code or in the design's own navigation, with **no
artboard**:

**Named in the merchant sidebar, no design:** Categories, Inventory (links to Products),
Customers, Payments, Analytics.

**Named in the admin sidebar, no design:** All orders, Payouts, Disputes, Plans & fees, Admin
team & roles, Audit log, Platform settings.

**In the current codebase, no design:** Login, Register, password reset, the delivery rider
dashboard, complaints management, reviews, refund requests, wallet and withdrawals, staff
management.

**Decision:** build these from the design system, not from the old CSS. They are the last phase,
and the phase is not optional — until it lands, two visual languages ship side by side.

---

## 9. Application structure

**One Vite app, three route trees, plus a shared core package.**

```
packages/core/        theme-engine · config resolver · money · domain types
                      built to both ESM (Vite) and CJS (Express)
client/src/
  shared/ui/          the design-system kit
  shared/tokens/
  storefront/
  merchant/
  admin/
server/src/
  routes/ services/ repositories/ db/
```

Rejected: a full monorepo with three separate apps. Three deployables, three build pipelines and
three sets of shared-dependency wiring is not justified at this team size, and the current Render
setup (one Node service + one static site) already works. Code-split the three route trees
instead — the admin console never loads in a customer's browser either way.

Not rejected but required: `packages/core` must be a real package with a dual build, because
`server/` is CommonJS and `client/` is ESM. The alternative — copying the theme compiler into
both — guarantees drift.

---

## 10. Delivery sequence

Phases 1–4 ship nothing a customer sees. That is deliberate and is the main risk to manage
(§11). Each gate is a go/no-go.

| # | Phase | Gate |
|---|---|---|
| 0 | **Decide** (§12). Adopt a migration tool. Stop further work on the old theme. | The six open decisions are answered in writing |
| 1 | **Tokens + UI kit** from `Main` and `States`. TypeScript from here on. | Every component rendered in a local gallery, matching the artboard at 1440 and 390. All 20 states from `States.dc.html` exist as components |
| 2 | **Config engine** — templates, resolver, `t()` / `has()` | Switching a store's template changes vocabulary, nav, product form and order timeline with zero component changes |
| 3 | **Theme engine** — compiler, draft/publish, server-side contrast gate | The three stores in `ShoeStores.dc.html` reproduced from three input sets. No publishable input combination fails contrast |
| 4 | **Catalog** — products, option groups/values, variant matrix, Add product, Products | Fashion: 12 size×color variants, each with its own stock and SKU. Food: priced extras on the line total. Existing orders unaffected |
| 5 | **Storefront** — Shop, StoreDesktop, tracking | Purchase completes end to end against MoMo sandbox. Every customer state in `States.dc.html` is reachable |
| 6 | **Merchant console** — Dashboard, Orders, Store design, Settings | Order state machine driven by config `order_steps`, including a template with a non-default step |
| 7 | **Platform admin + money** — Overview, Merchants, Payments, Currencies, Industries | A payment method goes draft→live through its five-item checklist and appears at checkout. Changing a currency's format changes every price everywhere |
| 8 | **KYC** — capture + admin review + retention | Liveness capture works on real devices. Retention job deletes media after the configured period. Audit log records every ID reveal |
| 9 | **Undesigned surfaces** (§8) rebuilt on the kit | No file imports the old theme. The "Clean light SaaS" block is deleted from `index.css` |

---

## 11. Risks

| Risk | Why it bites here | Mitigation |
|---|---|---|
| **High — long invisible stretch** | Phases 1–4 produce no user-visible change while the live store keeps selling | Build the new route trees behind a flag alongside the old app; cut over per persona, not all at once |
| **High — variant matrix vs `reserve_stock`** | Stock reservation currently targets an `add_ons` row; per-combination stock changes the atomic path that prevents two shoppers winning the last unit | Change the plpgsql function under test, first, alone. Never touch it during a UI phase |
| **High — theme drift** | If preview and published compile in different places they will diverge, and the divergence is invisible until a merchant complains | One compiler package. Server re-runs it at publish and rejects anything that isn't its own output |
| **High — KYC is biometric data** | Face video plus national ID number. Retention, encryption at rest, restricted access, and a lawful basis are obligations, not features. The design leaves `[RETENTION PERIOD]` as a placeholder | Answer the retention and provider questions before phase 8 starts, not during it |
| **Medium — config over-abstraction** | A config engine that leaks into hundreds of scattered conditionals is worse than hardcoding | Components get `t()` and `has()` and nothing else. Review any third primitive as a design smell |
| **Medium — cash rounding** | Rounding that applies to cash totals but not card totals is exactly the kind of rule that produces a two-franc discrepancy nobody notices for a month | Single formatter, property tests over generated amounts |
| **Medium — migration ordering** | Already implicit and load-bearing; ten new tables makes a fresh-database rebuild materially riskier | Migration tool in phase 0, before any new table |
| **Medium — multi-country scope** | Five countries and six currencies in the admin design is a large surface for a platform live in one market | Model it fully, enable Rwanda and RWF only (§12.3) |

---

## 12. Open decisions — answer before phase 0 closes

1. **Product name.** The design says **Soko** throughout — logo, sidebar, `soko.rw`, onboarding
   copy. The code says **Vendly** (`client/src/config/brand.js`). One of them is wrong. This
   affects the brand config, SEO, email templates, and domains.

2. **Subdomain or path.** The design shows `nyama.soko.rw`. The app serves `/:tenantSlug`, and
   the audit notes every existing URL must survive. *Recommendation:* keep path-based as
   canonical, add host→slug resolution in the tenant middleware as an alias. Wildcard DNS and
   TLS on Render is real ops cost for a cosmetic gain.

3. **Is multi-country real now?** `AdminPayments` covers five countries and `AdminCurrencies`
   six currencies, two of them explicitly "not launched". *Recommendation:* build the data model
   for all of it, ship Rwanda and RWF only. The cost is in the provider integrations, not the
   tables.

4. **KYC: retention period and verification provider.** The design shows automatic checks —
   document authenticity, liveness, face match against the ID photo, duplicate detection. Those
   are a vendor, not something to build. Which vendor, and how long is media kept?

5. **Does the rider app survive?** `DeliveryDashboard.jsx` exists; the design has no rider
   persona at all, though "Out for delivery" and "Hand to rider" appear in the merchant flow.

6. **Cutover strategy.** Flagged parallel route tree (recommended, §11) or a single cutover.

---

## 13. One-line summary

Build the tokens, then the config engine, then the theme engine — then the screens, which are
mostly arrangements of the first three. Keep the money engine untouched. Everything the design
shows as an industry difference is a row in a table, never a branch in a component.
