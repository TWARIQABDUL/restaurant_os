# Development fixtures

```
npm run db:seed                  the fixtures plus 30,000 generated orders (~3 min)
npm run db:seed -- --orders=0     the fixtures only (~4 s), for a fast loop
npm run db:seed -- --dry-run      run every check, write nothing
npm run db:seed -- --yes          skip the confirmation prompt
```

Every account's password is **`vendlyfy-dev`**. Sign in as `owner@nyama.example`,
`manager@nyama.example`, `eric@nyama.example` (rider), `sandrine@example.com`
(customer) or `grace@vendlyfy.example` (the platform team).

## What is in it

Six stores, one in each state `AdminMerchants` draws:

| Store | State | Why it exists |
|---|---|---|
| Nyama & Co. | active, verified | the demo store nearly every board is drawn against |
| Inzu Threads | active, verified | the second industry, and the 12-variant linen tee |
| Kigali Kicks | active, verified | `ShoeStores`' first palette — milestone 13 themes it |
| Ubwiza Beauty | pending | identity check still being read |
| Kigali Tech Hub | pending | a retake asked for: the blurry ID back |
| Deals4U | suspended | counterfeit goods, per the audit log's own example |

Coverage, which is §4.5's list:

- **Orders in all twelve statuses**, each *walked* through `order_status_transitions`
  rather than inserted in place, so every timeline is a real one.
- **A wallet with money in both pots**, one ledger entry of each of the seven types,
  and a payout that failed and was reversed.
- **Refunds** approved, rejected, and **queued** — approved but unpayable, which
  holds Inzu Threads' payouts until its balance covers it.
- **Riders** on and off duty, one carrying a cash debt into the next shift, one day
  that balanced and one short by 1,000.
- **Complaints** open, escalated, resolved and rejected.
- **Reviews** with merchant replies, one hidden by Vendlyfy after a report, and one
  report still open.
- **Identity checks** approved, submitted and redo-requested.
- **Promo codes** live, expired and already spent, plus two automatic offers.
- **Enough volume** that a sequential scan is visibly slower than an index scan.

## The ids are fixed

A bookmarked `/app/orders/55555555-…` survives the next `db:seed`. The prefix says
what kind of thing it is — `1111…` stores, `2222…` people, `3333…` catalogue,
`5555…` orders, `7777…` support, `aaaa…` generated volume — so an id in a log line
is readable without a lookup. `db/seeds/fixtures/context.ts` holds all of them.

## The guardrails

This is the only program here that destroys rows on purpose, so it refuses six ways:

1. `NODE_ENV=production`, with no override.
2. A non-loopback host, unless `SEED_ALLOW_REMOTE` **names that host** — naming it
   rather than setting a boolean means an authorisation cannot outlive the host it
   was granted for.
3. A database holding the old system's tables, because a loopback address can still
   be a tunnel.
4. A schema with migrations pending, because seeding one produces errors that look
   like seed bugs.
5. No confirmation and no terminal to ask at.
6. `TRUNCATE` **without** `CASCADE`, so a table missing from the list is an error
   from Postgres rather than a silent half-wipe.

Guardrail 6 earned itself on the first run: it found that
`industry_template_versions.created_by` references `users`, which is why `users` and
`stores` are cleared by `DELETE` and everything else by `TRUNCATE`. See the note in
`dev.ts`.

## The phase order is the schema's

Three phases sit where they do because the database refused them the other way round,
and each refusal was the right one:

- **KYC before money**, because `request_withdrawal()` refuses an unverified store.
- **Promotions before orders**, so a code exists — but the *applying* comes after,
  because `orders.discount_amount` must equal the `order_discounts` rows behind it.
- **Support last**, because a complaint names an order and a review names an order
  *line*.

## What it deliberately does not do

- **No themes.** `store_themes` does not exist until milestone 13. The three
  `ShoeStores` input sets are recorded in `context.ts` as `THEME_INPUTS`, ready for
  that milestone's done-when, and inserted nowhere.
- **No money on the generated orders.** Thirty thousand ledger chains would take
  minutes and prove nothing the hand-written money fixtures have not already proved
  on six rows.
- **No carts.** The cart is a server-issued session cookie's row; seeding one would
  be seeding a session nobody holds.
