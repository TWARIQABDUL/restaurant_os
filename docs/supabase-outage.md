# Supabase API outage — 10 Sep 2026

> **Confirmed as a Supabase platform incident.** Their status page, 15:26 UTC:
> *"Unresponsive Projects — We are aware of Nano projects becoming unresponsive
> after a period of time, typically hours. We are investigating."*
>
> That matches what we measured exactly: an idle, healthy Postgres with the API
> layer wedged in front of it. Nothing in this repo caused it and nothing in this
> repo can fix it. The notes below are kept because the failure **will recur
> until Supabase ships a fix**, and because the diagnosis is worth being able to
> repeat quickly.
>
> Two practical consequences:
>
> - **A project restart is relief, not a cure.** "After a period of time,
>   typically hours" means it comes back. Expect to restart again.
> - **Nano is the affected tier.** If you cannot absorb repeated multi-hour
>   outages, moving the project's compute up one size takes you off the tier the
>   incident names. That is a cost decision, not a security one.

## Symptom

`POST /backend/auth/login` returns **502 Bad Gateway** from Vercel.

## It is not the code, the deploy, or the migrations

| Component | State |
| --- | --- |
| Render API `/api/health` | **200**, sub-second — the service is up |
| Render API `/api/menu`, `/api/auth/login` | hang until the gateway gives up → 502 |
| Postgres instance | **healthy** — 13/60 connections, no locks, nothing idle-in-transaction |
| Dashboard metrics | CPU 9%, memory 59%, disk 14%, **0 slow queries** |

The only routes that fail are the ones that talk to Supabase. Everything else
answers instantly.

## What is actually down

Supabase's API services for this project, tested individually:

```
/rest/v1/                  no response at all
/auth/v1/health            no response at all
/storage/v1/bucket         HTTP 544
/realtime/v1/api/tenants   HTTP 401   ← alive
```

Realtime answers, so the project is not paused and the gateway is running.
PostgREST and GoTrue are not serving, and Storage is erroring. Postgres itself
is reachable and idle — a direct `psql` connection on port 5432 works and shows
a healthy, quiet instance.

`PEAK CONNECTIONS` reading `--` on the dashboard is consistent with this: the
metrics collector is not reporting either. That is a degraded project, not an
overloaded one.

## What to do

1. **Restart the project.** Dashboard → Settings → General → *Restart project*.
   This restarts PostgREST, GoTrue and Storage. It is the standard fix for
   wedged API containers and does not touch your data.
2. **Look for a project banner** — free-tier restriction, over-quota, or a
   pending migration notice.
3. **Check <https://status.supabase.com>** for a regional incident.
4. If a restart does not fix it, open a support ticket. The useful details:
   - Project ref `oehbtgdogizqxziwwtef`
   - PostgREST and GoTrue return no response; Storage returns 544; Realtime is fine
   - Postgres itself is healthy and directly reachable on 5432
   - Started around 10 Sep 2026, ~15:00 UTC

## The code change made because of this

The API had **no timeout** on Supabase calls. During an outage every request
hung until Render's gateway gave up, which is what turned an upstream outage
into a 502 — with each hung request occupying a worker the whole time.

`server/src/config/supabase.js` now installs a bounded `fetch`
(`SUPABASE_TIMEOUT_MS`, default 8s), and the tenant middleware and global error
handler answer **503 with `Retry-After: 30`** and a readable message.

Two details that made this harder than it looks, both worth remembering:

- **supabase-js does not throw on a network failure** — it resolves with
  `{ data: null, error }`. So the timeout arrived as an ordinary query error and
  `resolveTenant` read it as "no rows", returning **404 Store not found** for a
  store that exists. `isUpstreamTimeout()` exists to tell those apart.
- **postgrest-js retries a failed fetch three times** unless the error is named
  `AbortError`. The first version of the timeout wrapper renamed the error, so an
  8s ceiling silently became ~15s of retries. Preserving `name = 'AbortError'`
  is what makes the timeout a real ceiling.

Verified against an unroutable host: `/api/menu` and `/api/auth/login` both
return 503 in ~3s instead of hanging.
