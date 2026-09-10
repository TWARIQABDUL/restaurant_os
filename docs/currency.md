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

## Why it is pinned to the settlement currency

Currency here is **not a display label**. `momoClient` charges in
`momoConfig.currency` — the platform's settlement currency, from
`MOMO_CURRENCY`. A store displaying USD while MoMo collects RWF would quote a
customer one amount and take another.

So `PATCH /api/tenants/me/payment-settings` accepts a `currency` only if it
equals the settlement currency, and `tenantCurrency()` ignores a stored value
that does not match. A pre-existing value cannot cause a storefront to show a
price the platform cannot charge — the seeded `demo` store carried
`settings.currency = 'USD'` from before MoMo existed, and it is simply not used.

Admins see the currency, the settlement currency, and a notice if their stored
value was overridden.

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
node server/scripts/run-currency.js
```
