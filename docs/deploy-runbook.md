# Security fix deployment — order of operations

> **Pushing the code alone does not close these findings, and one ordering
> mistake makes a money bug worse than it was.** Read this section before
> deploying.

## Why `git push` is not enough

**SEC-01, the worst finding, is not in the repo.** The open storage policies
live in the database. Until `run-lockdown-storage.js` runs against Supabase,
anyone on the internet can still delete every product image in every store. The
code change only alters *how your client uploads*; it does not revoke anyone's
access.

**Deploying the code before the refund migration makes SEC-03 worse, not
better.** `walletService.approveRefund` no longer does a status pre-check,
because that check was the racy half of the bug — the RPC is now supposed to
claim the row instead. If the code ships while the old function is still in the
database, there is *no* guard on either side, and the double-refund race gets
easier to hit than it is today. Run `run-refund-hardening.js` in the same
maintenance window, and prefer running it **before** the API rolls.

**The API will refuse to boot until you set environment variables.** That is
deliberate (see below), but it means an unprepared push takes the service down
rather than deploying quietly.

## 1. Set environment variables first

The API now refuses to boot on a config that would fail silently
(`server/src/config/env.js`).

| Variable | Requirement |
| --- | --- |
| `JWT_SECRET` | ≥32 chars, not the template placeholder. `openssl rand -base64 48` |
| `CLIENT_URL` | Required in production (Socket.io CORS origin) |
| `MOMO_ENVIRONMENT` | No longer hardcoded in `render.yaml` — set per environment |
| `MOMO_BASE_URL` | `https://proxy.momoapi.mtn.com` for live |
| `MOMO_TARGET_ENVIRONMENT` | `mtnrwanda` for live |
| `MOMO_CURRENCY` | `RWF` for live |
| `MOMO_ALLOW_SANDBOX` | `true` **only** for staging/soak deployments |

`render.yaml` used to hardcode `MOMO_ENVIRONMENT: sandbox` alongside
`NODE_ENV: production`, so your current deployment is almost certainly running
against the sandbox. Those four MoMo variables are now `sync: false`, which
means **they are unset until you fill them in**, and the boot check will stop
the service.

That is the intended behaviour: the sandbox answers `SUCCESSFUL` without moving
any money, so a production deployment pointed at it collects nothing while
looking healthy. You have two valid ways forward:

- **Going live:** set the four MoMo variables to the live values above.
- **Still testing:** set `MOMO_ALLOW_SANDBOX=true`. The service boots and keeps
  using the sandbox, but the choice is now written down in your dashboard
  instead of being an accident.

## 2. Deploy the API and client

```
# server
npm install      # helmet, express-rate-limit, qs override
npm start

# client
npm install && npm run build
```

Both must be live before step 3.

## 3. Run the SQL migrations, in this order

```
cd server
node scripts/run-refund-hardening.js    # run at or BEFORE the API roll
node scripts/run-lockdown-storage.js    # ONLY after step 2 is live
```

**If `run-lockdown-storage.js` reports a statement timeout**, that is lock
contention, not a broken migration. `DROP POLICY` needs an ACCESS EXCLUSIVE lock
on `storage.objects`, and this database runs `lock_timeout = 0` with
`statement_timeout = 2min`, so a single busy moment queues the DROP until it is
cancelled — and because a multi-statement query runs in one implicit
transaction, the whole file rolls back. The runner now sends each statement
separately with `lock_timeout = 5s` and retries, and the file is re-runnable, so
just run it again.

`run-refund-hardening.js` is backward-compatible: the new function works with
the old application code, so running it first is safe and closes the window
described at the top of this file.

`run-lockdown-storage.js` closes storage writes to the public anon key. Between
running it and the new client being live, image **upload** stops working. Image
**reads** are unaffected throughout, so existing storefronts keep rendering.

## 4. Verify

```
node scripts/verify-lockdown.js            # database grants
node scripts/verify-storage-lockdown.js    # storage, driven with the real anon key
curl -sI https://<api-host>/api/health | grep -i 'content-security-policy\|strict-transport\|ratelimit'
```

`verify-storage-lockdown.js` reports a timeout or rate-limit as **inconclusive**
rather than as a pass. If you see that, the Supabase project is throttling —
wait a few minutes and re-run rather than treating it as a green light.

Then check by hand:

- Upload a product image as an admin — should succeed via `/api/uploads/image-url`.
- Attempt an anonymous storage write with the anon key — should be denied.
- Log in as `super_admin` from a storefront URL that is not their own tenant.
- Track a guest order with the wrong phone — should return the same 404 as an
  unknown tracking code.

## Two buckets belong to another app — read `docs/storage-findings.md`

This Supabase project is shared. The `documents` and `opportunities` buckets
belong to a different application and carry the same kind of no-role-check
policies that SEC-01 described: anyone with that project's anon key can upload
to either, and everything in `documents` is world-readable. They were left
untouched on purpose — changing them would break that app's uploads. They need
the same fix, coordinated with whoever owns it.

## Still open — product decisions, not code

- **Tenant signup is still unauthenticated.** It is now rate-limited (3/hour/IP)
  and blocks reserved slugs, but there is no email verification. Until there is,
  anyone can create a tenant and reach the tenant-authored SEO and theme fields.
  Those fields are now escaped and validated, so this is spam exposure rather
  than injection — but verification is the real fix.
- **Password minimum is still 6 characters** across register, register-tenant
  and create-staff.
- **Analytics still aggregate in Node**, pulling every matching order into
  memory. Fine at launch volume; move to SQL views before it isn't.
