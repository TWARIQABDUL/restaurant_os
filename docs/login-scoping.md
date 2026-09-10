# Sign-in

## The principle

**Authentication resolves an identity, so it must not depend on ambient state.**

Not a slug remembered in `localStorage` from browsing some other storefront, not
a cached user object, not a hardcoded default. Any of those can name the wrong
store, and a lookup *filtered* by the wrong store rejects a correct password.

So: the email is looked up across the platform and the **password** decides
which account it is. A store, when the request names one, is a **preference for
disambiguating between matches** — never a filter that can exclude the right
account.

## What went wrong

SEC-04 found that login ignored the tenant entirely: it fetched every account
with that email and bcrypt-compared each. The remedy applied was a tenant
filter. That was the wrong remedy, and it caused a production lockout.

The client had a fallback chain ending in a hardcoded `'demo'`. The `/login`
page has no slug in its URL, so every global sign-in claimed to be a demo-store
sign-in, and the server scoped the lookup to demo.

It was sharper than "wrong store", because the same address can legitimately
exist in several stores — `UNIQUE` is on `(email, tenant_id)`, not on email:

```
tariqazizibabu@gmail.com  →  demo          role=customer
tariqazizibabu@gmail.com  →  burger-bros   role=admin
```

The scoped lookup did not miss. It **found the wrong one of two accounts** and
compared an admin password against a customer record.

The first attempt at a fix only removed the `'demo'` default, so it helped a
browser with *empty* storage and nobody else — anyone who had ever loaded a
storefront still had a slug remembered, still sent it, and was still locked out.
That is what made the root cause clear: the problem was never which default was
chosen, it was that identity resolution consulted mutable client state at all.

## Was the tenant filter protecting anything?

No — and this is the part worth being honest about. Filtering by store appeared
to stop one storefront being used to test credentials against another. It never
did: `/login` is public, so anyone holding valid credentials could always test
them there regardless of what a storefront allowed.

What actually bounds abuse on this route:

- the rate limiter from SEC-06 — 10 failed attempts per 15 minutes per IP
- `LIMIT 10` on candidates, so one address cannot turn a single attempt into an
  unbounded number of bcrypt comparisons (this *was* a real finding in SEC-04)
- a fixed dummy-hash comparison when nothing matches, so timing does not reveal
  which addresses are registered
- one identical error for wrong-password and no-such-account

## Which account, when several match

If the same email and password verify in more than one store:

1. the store named by the request, if one of the matches is in it
2. otherwise the most privileged: `super_admin` > `admin` > `manager` >
   `delivery` > `customer`

Someone signing in to run a store is the common case, and landing on a customer
account by accident is the better failure of the two.

## Client

`urlTenantSlug()` returns the store named by the URL itself, with nothing
remembered folded in. `IDENTITY_ROUTES` (currently `/auth/login`) use that and
only that; every other request may use the best-known store.

This is defence in depth, not the fix. **The server no longer depends on it** —
deploying the server alone resolves the lockout, even against the currently
deployed client.

## Tests

`server/test/auth.login.test.js`, run with `npm test`.

Ten integration tests covering the outage shape directly: the same email in two
stores, signed in with and without a store named, with the right store named,
with the *wrong* store named. Plus the rejection paths — wrong password, unknown
email, no hash in the response, httpOnly cookie, malformed input.

They were verified to actually catch the bug: reintroducing the tenant filter
fails *"signs in even when a DIFFERENT store is named — the outage case"* and
*"the same email in another store signs in with ITS password"*, and passes
everything else. A suite that stays green through the regression it was written
for is worse than no suite.

Rate limiting is disabled during tests via `RATE_LIMIT_DISABLED=true` — an
explicit variable rather than a `NODE_ENV` sniff, so it cannot become true by
accident in a deployment.

The tests create and delete rows prefixed `login_test_` against whatever
database the server env points at. Point them at a scratch project if you have
one.
