# The data migration — runbook (milestone 29)

What it is: `db/etl/` — a one-off, rehearsable program that moves the old Supabase data into the new Postgres and
ends with a reconciliation report. Plan §5.5 is the spec; this is how to operate it.

## The three properties

| Property | How it is enforced |
|---|---|
| **Read-only against the source** | One `REPEATABLE READ READ ONLY` transaction for the whole run; a canary write is attempted first and must be refused by the server. The source can also be a restored *copy*, which is what rehearsals use. |
| **Repeatable** | The target is written in **one transaction** — a failure leaves it untouched. It must be a *freshly migrated, empty* database; a target that already holds stores or migrated rows is refused. Rehearse by creating a new database each time (`etl-rehearse.sh` does). It does not truncate, because `legacy_rows`, the audit log and the ledger are append-only by design. |
| **Reconciled, not assumed** | Every judgement is a *decision* in the report; every row with no home is archived in `legacy_rows` with its reason; an unknown value (a payment method, a role, a status) **stops the run** instead of being guessed. |

## Commands

```bash
npm run etl:rehearse                  # synthetic old DB → fresh new DB → report on screen
npm run etl:rehearse -- --out r.md    # …and write the report
npm run etl:rehearse -- --keep        # leave both databases to look at (vendlyfy_etl_old / vendlyfy_etl_new)
bash db/scripts/test-etl.sh           # the acceptance suite (also run by `npm run db:test`)
```

The **real** rehearsal — run it before any cutover discussion:

1. Take a dump of the live Supabase database and restore it into a **scratch** database (never point the migration at the
   live one for a rehearsal: the dump contains personal data and belongs on a machine you control).
2. Create an empty target and migrate it: `DATABASE_URL=<target-owner-url> npm run db:migrate`.
3. `SOURCE_DATABASE_URL=<scratch> TARGET_DATABASE_URL=<target-owner-url> node db/etl/run.ts --out report.md`
4. Read the report. **Clean** means no `FAIL`; `explained` lines are expected findings, each with its reason.
5. Do it again on a *second* restore into a *second* target. The plan's bar for cutover is **clean twice in a row**.

Exit codes: `0` clean · `1` the report has a FAIL · `2` the run stopped (unmapped data, a non-empty target, a bad URL).

## What is decided (and where to change it)

All in code, each also printed as a **decision** in the report so a person reviews it:

| Decision | Where |
|---|---|
| Every store: Rwanda, RWF, plan `starter`, template `food`; `active=false` → `suspended` | `steps/identity.ts` |
| Staff merge by email (earliest password wins, conflicts listed); customers stay per store; first admin = owner | `steps/identity.ts` |
| Open hours: none existed, so every store is created open all day | `steps/identity.ts` |
| Order status map (7→12): identity; `assigned` stays `assigned` | `steps/orders.ts` |
| Totals: any gap between the old total and its items becomes a derived delivery fee / manual discount, so Σ is exact | `steps/orders.ts` |
| Add-on quantities that do not spread evenly split the line (units sold are preserved) | `steps/orders.ts` |
| Add-ons → shared option groups; sizes → private "pick one" groups + a variant per value; stock moves with them | `steps/catalogue.ts` |
| The wallet **opens at the old wallet's balance**; the old ledger is archived, never replayed (plan §5.1) | `steps/money.ts` |
| Refund on an unpaid order (the §5.1 bug) is archived, not carried | `steps/money.ts` |
| Mobile-money refund payouts are archived (the new schema ties disbursements to withdrawals) | `steps/money.ts` |
| Notifications, `posts`, any TypeORM-era leftovers: archived | `steps/support.ts` |

## Things that cannot be carried, and what to do about them at cutover

* **Customers' links.** Slugs may change (listed), tracking codes are replaced (the old one sits beside the new in
  `legacy_rows`), and every URL path is new. Anyone holding an old tracking link needs support to look it up.
* **Images** are not copied: product photos keep their old Supabase URLs, and store logos (which the new schema only
  accepts from its own media storage) are archived. Copy them when production storage is chosen (open decision).
* **Shared size stock** is copied into each product that used it — those products can now sell the same units twice.
  Review the `shared-stock-copied` lines before cutover.
* **Passwords** travel as hashes, so nobody resets unless the report lists a conflict.
* **Identity checks**: no migrated store is verified, so **payouts stay locked until each owner completes the new
  identity check**. Tell merchants before cutover.
* **Pending mobile-money collections** and **in-flight withdrawals** at the freeze moment: let them settle in the old
  system first (the freeze window is milestone 30's to define).

## What `explained` means

Exactly two findings are expected, both from plan §5.1, and the report refuses to call anything else "explained":

1. **The old ledger does not equal the old wallets** by an equal-and-opposite ±100 between pots (the total is intact).
   It must be exactly that pattern; any one-sided difference is a `FAIL`.
2. **A refund recorded against an unpaid order**: the merchant was debited for money never received. Finance decides
   whether to credit it back.

## The real rehearsal (2026-10-20) found two things, both now fixed

Run against the live Supabase data (via the project's connection pooler, session mode — the direct `db.<ref>.supabase.co`
host is IPv6-only and unreachable from a network without IPv6 egress):

1. **`orders.refunded_amount` is dead in the old app.** It reads `0.00` on every single order in production, including
   orders with a genuinely completed refund — nothing in the old code ever writes to it. `db/etl/steps/orders.ts` now
   derives "how much was refunded" from `refund_requests` (summing `status IN ('approved','completed')`, same rule
   `money.ts`'s `refunds()` uses) instead of trusting that column; `report.ts`'s "Σ refunded_amount" check was changed
   to compare against the same derived figure on the old side, not the dead column. Decision recorded as
   `orders/refunded-amount-derived`.
2. **Every migrated timestamp loses sub-millisecond precision.** `node-postgres` parses `timestamptz` into a JS `Date`,
   which is millisecond-resolution, so any microseconds on `created_at`/`updated_at`/`paid_at` are silently dropped on
   the way through. Harmless for an order's placed time, and not worth threading raw timestamp strings through every
   step to preserve microseconds nobody needs — so the spot check in `report.ts` now compares instants truncated to
   the millisecond instead of exact equality.

Both are now covered by the rehearsal and by `db/scripts/test-etl.sh`'s 45 synthetic checks (still green). The
synthetic fixture never exercised either bug: it doesn't generate a completed refund whose order survives with
`refunded_amount` unset, and its timestamps happen not to carry sub-millisecond noise. **Any future real rehearsal
should still be read end-to-end, not just checked for exit code 0** — this is exactly the kind of thing a synthetic
fixture can't surface.
