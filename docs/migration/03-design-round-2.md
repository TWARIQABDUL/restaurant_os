# Design brief, round 2 — naming fix + what's still open

**For:** the designer
**Canvas:** version `1790184289-4fbe`, 27 artboards
**Follows:** [`02-design-gaps.md`](02-design-gaps.md) — round 1. Section numbers below refer to it.
**Date:** 2026-09-23

---

## 0. First: the platform is called **Vendlyfy**

The canvas uses **Soko** throughout. That was never the product name — please rename everything.
It's mechanical but touches 14 boards, so here is the exact checklist.

### Rename

| What | Count | Boards |
|---|---:|---|
| The word **Soko** (platform name, "Soko team", "Soko adjusts…", "New to Soko?") | 21 | `Auth` 10 · `AdminMerchants` 9 · `AdminPayments` 6 · `ThemeStudio` 6 · `KYC` 4 · `Onboarding` 4 · `Shop` 3 · `Sidebar` 3 · `Main` 2 · `AdminKYC` `AdminOverview` `AdminSidebar` `ShoeStores` `States` 1 each |
| Platform **logo mark "S"** → "V" | 5 | `Main` (lowercase `s`) · `Auth` · `Onboarding` · `Sidebar` · `AdminSidebar` |
| Store URL suffix **`.soko.rw`** → `[DOMAIN — we'll confirm]` | 14 | `nyama.soko.rw` ×3 · `inzu.soko.rw` ×3 · `kigalikicks.soko.rw` ×2 · bare `.soko.rw` ×3 · `ubwiza` `kigalitech` `isokofresh` `deals4u` ×1 each |
| Webhook host **`api.soko.rw`** | 5 | `AdminPayments` |
| Admin email **`grace@soko.rw`** | 1 | `Auth` |
| Promo codes **`SOKO10`** / **`SOKO100`** | 4 | `Shop` · `States` |

### Do **not** rename

**`Isoko Fresh`** is a *merchant* in the demo data (`AdminMerchants`, `AdminOverview`,
`isokofresh.soko.rw`). It happens to contain the letters "soko". Leave the merchant name alone —
only the domain suffix on it changes.

> We'll confirm the exact domain separately. Use a clear placeholder until then rather than
> guessing.

---

## 1. What landed — thank you, and two follow-ups

`Auth.dc.html` and `Rider.dc.html` close §2.1 and §2.2 of round 1. Both are better than what we
asked for.

Two specific things worth saying:

- **The store picker is exactly right.** Showing stores only *after* the password matches — "so
  nobody can find out where an email is registered" — is the same model our sign-in already uses,
  and it's an account-enumeration defence we didn't ask for. Keep it.
- **The rider cash reconciliation** (amount received, "Short by 2,000 RWF. Your manager will see
  the difference.") is better than the "confirm cash collected" we specified.

### Follow-up A — `Rider` depends on an `Orders` change that doesn't exist

The rider's handover step says *"Staff tap 'Hand to Eric' on their screen."* There is no such
control on `Orders.dc.html`, which still has a single generic "Hand to rider" button and no rider
picker. **These two boards need to land together** — see §2 below.

### Follow-up B — customer sign-in is deferred, not solved

`Auth` says *"Customers sign in on the store itself, at checkout or from the account icon."* That's
a sensible split, but neither the checkout sign-in nor the account icon exists on any board. It
leaves round 1 §1.6 (guest vs account at checkout) and §2.7 (customer account) open, and now
coupled to this decision.

### Follow-up C — three states the rider app invented

`Rider` introduces three things our system has no room for. We're not asking you to change the
rider app — it's right. We're asking for the **merchant-side counterpart** of each:

1. **"Returned to store."** A new terminal outcome for an order. Who closes it? What happens to the
   stock, and to a prepaid customer's money?
2. **"Cash with you."** A running cash float per rider, and a short/over difference that the board
   says reaches the manager's **cash report**. That report doesn't exist. Where does a manager
   reconcile a rider's cash at end of day?
3. **Availability and assignment.** The rider toggles Available / Off duty — *"Managers can't assign
   you"*. The manager's side of that (who's on duty, who's carrying how much, who to assign) is the
   rider picker in §2.

---

## 2. Round 2 scope, in priority order

### 2.1 `Orders` — three missing actions **(blocks your own Rider board)**

Our lifecycle is pending → approved → preparing → ready → assigned → delivered, plus rejected —
and now **returned**.

- **Assign a named rider.** Not "hand to rider" generically: pick a specific person. Show who's
  available, who's already carrying how many jobs, and their cash float. Allow reassignment. Design
  the state where nobody is free.
- **Confirm cash payment.** Cash orders stay unpaid until the money is confirmed — separate from
  "delivered". Include the state where the rider banked a short amount.
- **Decline / cancel reason.** The buttons exist; the reason capture and confirm don't.

### 2.2 Merchant money — the deepest hole (round 1 §2.3)

`Settings` currently reduces all of this to one sentence about 08:00 payouts. Underneath it:

- Two balances — **pending** (held until an order clears, default 60 minutes after delivery) and
  **available**. The split is user-visible and needs explaining in plain language.
- A **ledger** of every credit and debit.
- **Withdrawal requests** with five statuses: pending, processing, completed, **failed** (with a
  reason), rejected.
- **Automatic and manual** settlement modes.
- The **payouts-locked** state for an unverified merchant — your `KYC` board promises "payouts
  unlock once you're verified" and never shows the locked side.
- Plus the **rider cash report** from Follow-up C.

### 2.3 Refunds — both sides (round 1 §2.4)

Merchant requests a refund with a reason → super admin approves or rejects → the amount leaves the
merchant's wallet. **Partial refunds are supported.**

### 2.4 Complaints and disputes — six actions (round 1 §2.5)

File → resolve with notes / reject → escalate to the platform with a reason → super admin approves
a refund or rejects the escalation → anyone can reopen. Your `AdminSidebar` shows "Disputes (4)"
with nothing behind it, and merchants have no complaints surface at all.

### 2.5 Customer sign-in and account (Follow-up B, round 1 §1.6 + §2.7)

Sign in at checkout without losing the cart · register · order history · reorder · saved address ·
the account icon you referenced.

---

## 3. Still queued for round 3

Not needed yet, but so you can see the whole shape:

- `Settings` → **Store details** and **Staff** panels (round 1 §1.3)
- **Analytics** screen — six views exist today, the dashboard shows four tiles (§1.7)
- Merchant nav items with no board: Categories, Inventory, Customers, Payments, the mobile **More**
  tab (§2.10)
- Admin screens named in your sidebar: All orders, Payouts, Plans & fees, Admin team & roles, Audit
  log, Platform settings (§2.9)
- `AddProduct` shared option groups (§1.4) · `Products` inline stock edit (§1.5)
- Coverage gaps: mobile merchant screens, admin states, error pages, suspended-store storefront,
  desktop option sheet, desktop search results, product detail decision, merchant-side KYC outcomes
  (round 1 Part 3)
- Cross-cutting: email + SMS templates, print artefacts, roles, console dark mode, language
  (round 1 Part 4)

---

## 4. One thing that hasn't changed

Everything above should stay **one design that reads differently per industry**, never a new screen
per industry. Your `Industries` board makes that argument better than we can — it applies to the
money screens and the rider handover just as much as to product cards.
