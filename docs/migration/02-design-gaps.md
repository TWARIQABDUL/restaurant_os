# Design brief — gaps between the Soko canvas and the system it has to replace

**For:** the designer
**Design source:** "Universal Commerce Platform" canvas, 25 artboards, version `1790181439-6136`
**System audited:** `restaurant_os` @ `master` — 76 endpoints, 13 screens, 18 tables
**Date:** 2026-09-23
**Companion:** [`01-target-architecture.md`](01-target-architecture.md)

> Every claim below was checked against the running code, not against notes. Where this brief
> says "today the system does X", X is in the codebase.

> **Status, 2026-09-23.** The designer answered round 1 with two new boards in canvas version
> `1790184289-4fbe`: `Auth.dc.html` and `Rider.dc.html`. **§2.1 and §2.2 are closed** (with three
> follow-ups). Every other board is byte-identical — everything else below is still open.
> The platform is named **Vendlyfy**; the canvas's "Soko" is a placeholder to be renamed.
> Round 2 is in [`03-design-round-2.md`](03-design-round-2.md).

---

## Context

We're migrating an existing, live commerce platform onto your design. Two constraints:

1. **Nothing can be lost.** The new app must do everything the current one does. Every capability
   named below is in production today.
2. **We're open to any architecture change.** If a flow is better rethought than ported, rethink
   it. We're not asking you to reproduce our current screens — we're telling you what work has to
   be possible.

Your canvas is internally coherent and the config-engine idea in `Industries.dc.html` is the right
spine. The gaps are all *around* the 18 screens, not inside them.

---

## Part 1 — Screens you already drew that can't carry the flow

These are the risky ones: the board looks finished, but the work can't be completed on it.

### 1.1 `Orders` — three missing actions

Our order lifecycle is **pending → approved → preparing → ready → assigned → delivered**, plus
**rejected**. Yours is New → Preparing → Ready → Out for delivery → Delivered.

- **Assign a named rider.** Your board has one button, "Hand to rider". Today a manager picks a
  *specific* driver from a list (drivers have names and plate numbers), and can reassign. Needed:
  rider picker, who's available, reassignment, and the state where no rider is free.
- **Confirm cash payment.** Cash orders stay **unpaid** until someone confirms the money arrived —
  a separate action from "delivered". Your board shows "Collect 9,500 RWF on delivery" but nothing
  to mark it collected, and no state for *delivered but cash not reconciled*.
- **Decline / cancel reason.** The buttons exist; the reason capture and confirm don't. You drew
  the cancelled *state* (with its refund note) but not the path into it.

### 1.2 `Orders` — the live board vs. the list

Today managers work a **kanban**: columns for Pending, Packing, Ready, Out for delivery, with
orders moving across. That's a live, glanceable work mode for someone standing in a kitchen or
stockroom. Your design replaces it with a list + detail split, which is better for looking things
up and worse for working a rush.

We'd like your opinion on this rather than a default. If the list stays, the busy-period mode needs
solving some other way.

### 1.3 `Settings` — two tabs with no panel

You drew the left nav with five items and content for three.

- **Store details:** name, logo, address, phone, opening hours per day, holiday closures,
  open/closed toggle, store URL, and SEO fields (page title, meta description, browser theme
  colour — all live today). Also the **store QR code with a download**, which exists now.
- **Staff:** list, invite, assign role, edit, reset password, remove — and a clear statement of what
  each role can see.

### 1.4 `AddProduct` — shared option groups

Options today come in two kinds:

- **Per-product** — this shirt's sizes, with stock per value. You designed this.
- **Store-wide, shared across products** — gift wrap, warranty, a standard extras set. Not designed.

Needed: a library of shared option groups, attaching one to a product, and a visible difference on
the product form between "this belongs to this product" and "this is shared — editing it changes
other products".

### 1.5 `Products` — stock is editable

Stock is edited inline from the product list today. Your board shows it as a read-only column.
Needed: the edit affordance, plus bulk restock — "Restock all" appears in `States.dc.html` with no
destination.

### 1.6 `Shop` checkout — account or guest

Both exist today: guests check out with name, phone, address and email, and registered customers
have accounts with order history. Your checkout collects details with no sign-in option and no
"remember me". Needed: the choice, and where a returning customer signs in without losing their
cart.

### 1.7 `Dashboard` — there are six analytics views, not four tiles

Today: summary, orders over time, revenue, top items, payment-method breakdown, and delivery
performance. Your board has four KPI tiles and a weekly bar chart. The rest needs the **Analytics**
screen — which is also a nav item with no board (§2.10).

### 1.8 `AdminMerchants` — admins also *create* stores

Today a super admin provisions a store directly: store name, URL slug, owner name, owner email,
selling currency — then can activate or suspend it. Your board only handles merchants who signed
themselves up and need verifying. Needed: the create-store form, or an explicit decision that
admin-created stores go away.

---

## Part 2 — Whole areas with no design

Ordered by how badly they block us.

### 2.1 Authentication — nothing is reachable without it · ✅ DELIVERED (`Auth.dc.html`)

Zero occurrences of "log in", "sign in" or "password" across all 25 boards. `Onboarding` creates a
store; there's no way back into it.

Needed: sign in · register (customer) · forgot password · reset password · admin-triggered staff
password reset · session expired.

One wrinkle: **the same email can exist in more than one store**, so sign-in may need a store
context — please design for that rather than assuming one email = one account.

### 2.2 Rider app — a whole persona · ✅ DELIVERED (`Rider.dc.html`)

Today a rider signs in, sees the orders assigned to them, sees the delivery address and customer
phone, and marks them delivered. Riders carry a plate number. "Hand to rider" and "Out for
delivery" appear all over your merchant screens; the rider has no surface at all.

Needed, mobile-first: assigned jobs list · job detail with address and a call button · mark picked
up · mark delivered · confirm cash collected · empty state · the handover moment with the merchant.

### 2.3 Merchant money — the largest gap

Your `Settings` says only *"Payouts go to MTN MoMo 078 ••• 4412 every morning at 08:00."*
Underneath that sentence is:

- A wallet with **two balances**: **pending** (held until an order clears — default 60 minutes
  after delivery) and **available**. This split is user-visible and confusing if unexplained.
- A **full ledger** of every credit and debit against the wallet.
- **Withdrawal requests** to a MoMo number, with statuses pending / processing / completed /
  **failed** (carrying a failure reason) / rejected.
- Two settlement modes, **automatic and manual**, set per store.

Needed: wallet overview that explains pending vs available in plain language · ledger with filters ·
request-withdrawal flow · withdrawal history including failures · and what a merchant sees when
payouts are **held because they aren't KYC-verified yet**. Your `KYC` board promises "payouts unlock
once you're verified"; that locked state is undrawn.

### 2.4 Refunds — two sides, neither drawn

A merchant requests a refund on an order with a reason → a super admin approves or rejects → on
approval the amount is deducted from the merchant's wallet atomically. **Partial refunds are
supported** (an amount is stored).

Needed: merchant request form and status · admin refund queue with approve/reject and reason · how
a partial refund reads on the order.

### 2.5 Complaints and disputes — a six-action state machine

Your `AdminSidebar` has "Disputes (4)" and nothing behind it. Merchants have no complaints surface
at all. Today:

A complaint is filed against an order with an issue type and a description. A store admin can
**resolve** it with notes, or **reject** it. They can **escalate** it to the platform with a reason.
The super admin can then **approve a refund** on the escalation, or **reject the escalation**.
Anyone can **reopen** a closed one.

Needed: file a complaint (customer) · complaints inbox (merchant) · escalation composer · platform
dispute queue (admin) · resolved / rejected / reopened states.

### 2.6 Notifications — nothing, anywhere

Today: a bell in the navbar with an unread count, a notification list, mark-all-read, and each
notification carries an icon and a link to the thing it's about. The server pushes seven real-time
events: new order, approved, ready, rejected, delivered, new delivery, delivery assigned.

Needed: bell and unread badge · notification list · empty state · and the **new-order alert** on the
merchant dashboard. Your `Orders` board says "New orders appear here with a sound alert" and nothing
designs that moment.

### 2.7 Customer account

Registered customers have an order history page today. Your `Shop` tracks a single order by its code
and stops there.

Needed: order history · reorder · saved address · profile.

### 2.8 Reviews

A signed-in customer leaves a 1–5 star rating and a comment on a product. Your cards show ★ 4.6 and
★ 4.8 with nothing behind them.

Needed: write a review · review list on a product · the rule for displaying an average (including
too-few-reviews) · merchant moderation, or an explicit decision that there is none.

### 2.9 Platform admin screens named in your own sidebar

**All orders · Payouts · Plans & fees · Admin team & roles · Audit log · Platform settings.**

Two of these aren't optional. **Platform settings** today controls which currencies stores may price
in, the default settlement mode, and the hold period before funds clear. And **Audit log** is
required by your own `AdminKYC` board, which states that revealing a full ID number is recorded.

### 2.10 Merchant nav items with no board

**Categories · Inventory · Customers · Payments · Analytics**, plus the **More** tab in the mobile
bottom bar.

---

## Part 3 — Coverage gaps inside what you did design

1. **Mobile merchant screens.** Only `Dashboard` has one. `Main.dc.html` states the rules ("tables
   become cards with the same fields in the same order"), but the two hardest — the **Add product
   variant matrix** and **Theme studio** at 390px — are undrawn.
2. **Admin states.** `States.dc.html` filters to Customer and Merchant only. No admin empty,
   loading, error or permission-denied states.
3. **Error pages.** No 404, no 500, no store-not-found — and no **suspended-store storefront**.
   `AdminMerchants` can suspend a store; customers then see *what*?
4. **Desktop option picker.** `Main` specifies a centred sheet at tablet width. `StoreDesktop` has
   "Choose" buttons and no sheet.
5. **Desktop search results** and empty search (mobile has "No matches for X").
6. **Product detail.** Your option sheet carries option groups and a quantity stepper only — no
   description, no photo gallery, no reviews. Today there's a full product page at its own URL and
   it's indexed for search; dropping it has a real SEO cost. If it's deliberate, please say so
   explicitly.
7. **Merchant-side KYC outcomes.** `AdminKYC` can approve, reject, or request a redo, each sending
   an SMS. The merchant only ever sees "Sent. We'll check within 24 hours."

---

## Part 4 — Cross-cutting

- **Transactional messages.** Six HTML emails exist today: order confirmation, approved, ready,
  delivered, rejected, delivery assigned. Your design promises SMS at least six times and designs
  neither email nor SMS. Both need templates in the new visual language, and they must work with a
  **per-store brand colour** — the same constraint your theme engine already solves.
- **Print artefacts:** order receipt (your `Orders` board has a "Print receipt" button), store QR
  poster (exists today with a download), CSV export confirmation (`AdminMerchants` has "Export CSV").
- **Roles.** Today: super admin · store admin · manager · rider · customer. Your design shows
  "Owner" and "Super admin" only. Manager and rider are unrepresented, and the Staff screen needs to
  make each role's permissions legible.
- **Dark mode for the console.** Your theme studio offers a dark *storefront* mood. Whether the
  merchant dashboard and admin console have one is unanswered.
- **Language.** English only. If Kinyarwanda or French are coming, the per-industry `words` system
  you invented is the right hook — but string length and plurals need deciding now, not later.
- **Multi-store owners.** `Sidebar.dc.html` takes a store parameter with two stores defined (nyama,
  inzu), but no switcher control is drawn. Today one user belongs to one store. If that's changing,
  the switcher and the "which store am I in" cue are missing.

---

## Part 5 — Two asks about how you deliver it

1. **Hold the line on configuration.** Everything above should be one design that reads differently
   per industry, never a new screen per industry. Your `Industries` board argues this better than we
   could — please apply it to the new work too.
2. **Priority order:** authentication → rider app → merchant money → complaints & refunds → the
   empty nav items → coverage gaps. Nothing ships without the first. The middle three are where
   money and trust live.

---

## Appendix — what was checked

| Area | Source of truth |
|---|---|
| Order lifecycle | `orders.status` CHECK constraint; `orders.js` routes `approve`, `reject`, `payment`, `preparing`, `ready`, `assign`, `delivered`, `refund-request` |
| Rider | `delivery.js` (`/drivers`, `/my-orders`); `users.plate_number`; `DeliveryDashboard.jsx` |
| Wallet & payouts | `wallets` (available/pending), `wallet_ledger`, `withdrawal_requests` (5 statuses + failure reason), `settlementScheduler.js`, `platform_settings.default_hold_minutes` |
| Refunds | `refund_requests` (4 statuses, `amount`), `refunds.js`, `approve_refund_deduct_wallet` |
| Complaints | `complaints` (+ `is_escalated`, `escalation_reason`, `refunded_amount`); `complaints.js` 6 actions |
| Notifications | `notifications` table; `notifications.js`; `socket/handler.js` (7 emitted events) |
| Reviews | `reviews` (rating 1–5 + comment, customer required); `reviews.js` |
| Analytics | `analytics.js` — `/summary`, `/orders`, `/revenue`, `/top-items`, `/payments`, `/delivery` |
| Store admin | `tenants.js` — provision, toggle, `/me/theme`, `/me/seo-settings`, `/me/payment-settings`, staff password reset |
| Platform | `platform.js` — settings (allowed currencies, settlement mode, hold minutes), health |
| Emails | `server/src/templates/` — 6 HTML templates |
| Roles | `users.role` CHECK — `super_admin`, `admin`, `manager`, `delivery`, `customer` |
