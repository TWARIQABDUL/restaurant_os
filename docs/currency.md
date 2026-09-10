# Currency

## Why it is per-store, not per-product

The money path only ever handles one currency at a time:

- an order carries a single `total_amount NUMERIC(12,2)` with no currency column
- a tenant has one wallet row with one balance
- a MoMo `requestToPay` names exactly one currency

Per-product currency would mean FX rates on every cart total, a wallet per
currency per tenant, and refunds that have to decide which rate to reverse at.
Nothing in the product needs that: one store is one seller with one payout
account in one country.

## Who decides which currencies exist

Super admin, in **Platform → Platform settings**. The list lives in
`platform_settings.allowed_currencies` and is the source of truth: a store picks
from it and cannot type anything else.

It is enforced at every boundary where money moves, not just on the settings
form — a currency removed from the platform cannot keep taking money through a
stale tenant setting:

| Boundary | Check |
| --- | --- |
| Store settings save | Currency must be in the allowlist |
| Storefront (`/tenants/public/:slug`) | Unsupported currency falls back; mobile money is filtered out of the advertised methods |
| Checkout (`POST /api/orders`) | Store currency re-checked; mobile money refused unless it is the settlement currency; the method must be one the store accepts |
| Withdrawal (`POST /api/wallet/withdraw`) | Refuses if the store or wallet is denominated in anything but the settlement currency |

The settlement currency can never be removed from the allowlist, and removing a
currency a store is actively priced in returns a `409` naming those stores
rather than stranding them.

## Why the settlement currency is not a setting

Currency here is **not a display label**. `momoClient` charges in
`momoConfig.currency` — the platform's settlement currency, from
`MOMO_CURRENCY`. A store displaying USD while MoMo collects RWF would quote a
customer one amount and take another.

So a store may price in **any allowed currency**, but mobile money only works in
the settlement currency. A store that switches to a non-settleable currency has
mobile money turned off automatically, with the reason returned in the save
response — and the save is refused outright if that would leave it with no way
to take payment at all.

Cash on delivery and bank transfer are unaffected in any currency: no settlement
is involved.

`tenantCurrency()` ignores a stored value the platform no longer allows, so a
pre-existing setting cannot cause a storefront to quote in an unsupported
currency. Admins see a notice when that has happened.

## ⚠️ Changing `MOMO_CURRENCY` does not convert prices

`MOMO_CURRENCY` is currently **EUR**, because `MOMO_ENVIRONMENT=sandbox` and the
MoMo sandbox only ever settles in EUR. When you go live in Rwanda you will set
`MOMO_CURRENCY=RWF`, and **every price in every store will immediately be
displayed and charged as RWF — the stored numbers are not converted.**

A product priced `10` means €10 today and becomes 10 RWF the moment you switch.
Before flipping that variable, re-price catalogues in the new currency, or
migrate `menu_items.price` and `add_ons.price` by the rate you intend.

This is the one place where the strict rule does not protect you: it guarantees
the *label* matches what you can collect, not that the *numbers* were meant for
that currency.

## Formatting

`client/src/config/money.js` wraps `Intl.NumberFormat`. Use it via the hook:

```jsx
const { money, delta } = useMoney();
money(1500)       // "RF 1,500"  in RWF  ·  "€1,500.00" in EUR
delta(500)        // "+RF 500"   ·  "" when the amount is zero
```

Do not reintroduce `${value.toFixed(2)}`. Two hardcoded decimals is wrong for
**RWF, JPY and UGX, which have no minor unit** — "1000.00 RWF" reads as a
different amount to the person paying it. `Intl` gets the symbol, its placement
and the decimal count right per currency.

The store's currency comes from `TenantProvider`
(`client/src/context/TenantContext.jsx`), which fetches
`/tenants/public/:slug` once and caches it. `TenantThemeInjector` and `Home`
previously made that same request separately; both now read the context.

## Wallet currency

`wallets.currency` was created with `DEFAULT 'EUR'` and `credit_wallet_pending`
never set it, so a wallet could be labelled EUR while holding something else.
`supabase/currency.sql` passes the currency at credit time and backfills
existing wallets from their transactions — skipping any tenant whose
transactions span more than one currency, which needs a human.

Apply with:

```
node server/scripts/run-platform-settings.js   # allowed currencies, defaults
node server/scripts/run-currency.js            # wallet currency labelling
```

### After the new build is fully deployed

`currency.sql` left the old 3-argument `credit_wallet_pending` in place so the
migration could run before the server rolled out. Postgres treats it as a
separate function, not a replacement, so it survives — still carrying the `EUR`
default. Once every instance is on the new build:

```
node server/scripts/run-currency-cleanup.js
```

## Platform revenue is grouped by currency

`GET /api/tenants/analytics` no longer sums `total_amount` across every store.
With more than one currency in play, adding 1,000 KES to 1,000 EUR produces a
number that is not an amount of anything. The headline total and the trend chart
cover the settlement currency only; everything else is returned in
`revenueByCurrency` and shown beneath the chart, so a store priced in another
currency is not silently missing from the platform's numbers.
