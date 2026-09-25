# The new API — milestone 11

`server/src/api/server.ts` is the server the rewrite is being built on: Express, `pg`,
and nothing between a request and Postgres.

```
npm run db:up            # the container, from the repository root
npm run db:migrate
npm run db:seed          # optional, but it is the fixture set to develop against
cd server && npm run api:dev
```

It listens on `API_PORT` (5100 by default) so it can run beside the legacy server on
5000.

## Why there are two servers

`server/src/app.js` and its sixteen routers are on supabase-js and still serving
production. They keep running, untouched, until cutover (milestone 30). That app cannot
be the one this milestone delivers, because `config/supabase.js` refuses to start without
a `service_role` key — so "boots against the local container with no supabase-js in the
path" is not a state it can be in.

So Stage D moves features onto this app one at a time, "feature by feature alongside the
repository layer" (§2.1). At cutover the legacy app and its routers are deleted and this
becomes the only one. Nothing needs renaming when that happens.

`test/api/no-supabase.test.ts` walks the import graph from `src/api/server.ts` and fails
if supabase-js is reachable from it. It is a graph walk rather than a grep of `src/`
precisely because the legacy files are still there.

## The layers

| Path | What it is |
|---|---|
| `db/pool.ts` | the `pg.Pool`, boot-time configuration checks, the `SELECT *` refusal, the slow-query log |
| `db/tx.ts` | `withTransaction()`, `readConsistent()`, savepoint nesting, retry on 40001/40P01 |
| `db/errors.ts` | SQLSTATE → HTTP, and the only place that decides whether a message may leave the process |
| `db/rows.ts` | the one file that knows where `packages/core`'s generated row types live |
| `repositories/` | all the SQL. Parameterized, explicit column lists, `storeId` first |
| `middleware/authorize.ts` | the membership-aware guard |
| `routes/` | HTTP shape only. No SQL, no permission lists |
| `api/app.ts` | mounts the routers; `REQUIRED_PERMISSIONS` is checked against the database at boot |

A repository method takes an optional `Queryable`. The pool and a transaction both
satisfy it, so `repo.find(storeId, id)` and `repo.find(storeId, id, tx)` are the same
method — there is no second code path for "inside a transaction".

## What it will and will not do

Present and complete:

- `GET /api/health` — pings the database, 503 when it cannot
- `GET /api/session` — the person, their memberships across stores, the role→permission map
- `GET|POST /api/stores/:storeId/members`, `DELETE …/members/:userId`
- `GET /api/stores/:storeId/wallet` · `/payouts` · `/settings` — reads

Deliberately absent, with the milestone that owns it:

- signing in, the cookie session, CSRF, the staff invite — **15**
- requesting a payout, the ledger, the Wallet board — **23**
- writing settings, transferring ownership — **25**
- everything `/api/admin/*` — **27**

There are no stubs. An endpoint here is complete for what it claims, or it is not here.

## Five things that are decisions, not accidents

**The store comes from the path.** `/api/stores/:storeId/...`, never from
`X-Tenant-Slug`, and there is no fallback to "the first active store" — both of which the
old `resolveTenant()` did. A caller may name any store they like; naming one they do not
work at is what produces the 403.

**Nothing about authorization is in the token.** It carries a user id and `typ: session`.
Role and store are re-read from the database on every request, which is what makes
revoking a membership deny the *next request* rather than the next login (§5.4's fourth
escalation test). It also means a token from the legacy server cannot authenticate here:
it has no `typ`.

**There is no `super_admin` bypass.** V001 gave the platform team explicit permissions
"rather than as a wildcard", and those are *platform* permissions — `kyc.review`,
`payouts.process`. A store-scoped route asks for a *store* permission, so a super_admin
gets 403 from `/api/stores/:id/wallet` and reaches that store through `/api/admin/*` with
its own permission and its own audit entry. `test/api/guard.test.ts` asserts it, so it
cannot be mistaken for an oversight later.

**Routes check permissions, never roles.** `requireStorePermission('wallet.read')`, not
`authorize('owner', 'admin')`. `guard.test.ts` proves the guard reads rows by granting
`manager` `wallet.read` for the length of one test and watching the same request succeed.

**Amounts are strings.** `numeric` arrives as a string from `pg` and stays one. The
formatter is `packages/core`'s at milestone 13, driven by the currencies table.

## Tests

```
npm run api:test                                  # from the repository root
npm run api:test -- test/api/guard.test.ts        # one file
```

The runner (`scripts/api-test.sh`) supplies the connection string from
`docker-compose.yml`, so no test file holds a copy of it, and connects as the *app* role
— a fixture written with DDL rights would be testing something the app cannot do.
`--test-concurrency=1` because the suites share one database and one set of fixture ids.

| File | What it pins down |
|---|---|
| `no-supabase.test.ts` | the import graph from the entrypoint |
| `boot.test.ts` | the five refusals, by spawning the entrypoint |
| `transactions.test.ts` | commit, rollback, retry, savepoint nesting, read-only, `SELECT *`, and that 300 transactions leak no connections |
| `authorization.test.ts` | §5.4's four escalation tests |
| `guard.test.ts` | bad tokens, deleted accounts, no super_admin bypass, customers |
| `members.test.ts` | delegated creation, and that a refusal leaves nothing behind |
| `payouts.test.ts` | the keyset cursor across rows with identical timestamps |
