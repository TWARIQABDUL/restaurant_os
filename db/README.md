# `db/` — the new database

Everything about the **new** Vendlyfy database lives here: the local container, the
migrations that build the schema, and the seed that fills it for development.

The rewrite is built on a **brand-new database** (§4.3 of
[`../docs/migration/04-implementation-plan.md`](../docs/migration/04-implementation-plan.md)). The
live one keeps running untouched on Supabase until cutover at milestone 30, and is kept afterwards
as the rollback. Nothing in this directory touches it.

`../supabase/` is **retired, not deleted** — it is the reference for the one-off data migration
(milestone 29) and the record of what the old schema was.

---

## Read this before you run anything

**This container does not run the application yet.** `server/src` contains zero `pg` usage — all 25
query-bearing files go through supabase-js against PostgREST (§4.1). What the container serves
today is migrations, seeds and tests. The app points at it from **milestone 11**, when the
repository layer and `pg.Pool` land.

So `npm run db:up` giving you an empty database is not a bug. It is milestone 1.

---

## Commands

Run from the repository root.

| Command | What it does |
|---|---|
| `npm run db:up` | Start the container, wait for healthy, then verify. Safe to re-run. |
| `npm run db:verify` | Assert the database is reachable, authenticating, correctly versioned and correctly configured. |
| `npm run db:down` | Stop the container. **Data is kept** — the volume survives. |
| `npm run db:reset` | **Destroy the volume** and rebuild from nothing. Asks for confirmation; `-- -y` skips it. |
| `npm run db:psql` | Interactive `psql`, as the owner role, using the container's client. Nothing to install. |
| `npm run db:logs` | Follow the log. Statements over 200 ms and every lock wait land here. |

Arriving later, in their own milestones: `db:migrate`, `db:migrate:new`, `db:migrate:status`
(milestone 2), `db:seed` (milestone 10), `db:types` (milestone 5).

### First run

```
npm run db:up
```

Pulls the image, initialises the data directory, runs `bootstrap/local.sql`, then prints the checks.
A minute or two the first time, a few seconds after that.

---

## Layout

```
db/
  bootstrap/local.sql   LOCAL ONLY. Runs once, on an empty data directory.
  migrations/           V000_init.sql onward.            milestone 2
  seeds/                dev.ts + fixtures.               milestone 10
  scripts/              the db:* commands
  README.md
../docker-compose.yml   the container
```

---

## What is where, and why it matters

The split between `bootstrap/local.sql` and the migrations is the one thing in here worth
understanding, because getting it wrong produces a bug that only appears in deployment.

**`bootstrap/local.sql` is mounted at `/docker-entrypoint-initdb.d/` and run by Postgres' own
entrypoint exactly once, on an empty data directory. The deployed instance never runs it.**

So it may only contain:

1. things a managed provider does for you outside of SQL — creating the `vendlyfy_app` role
2. local diagnostics that no schema object depends on — `pg_stat_statements`

Anything the schema depends on — extensions, `CONNECT` and `USAGE` grants, default privileges for
the app role, `schema_migrations` — belongs in **`V000`**, so that every environment gets it
identically. That is milestone 2.

One consequence catches everybody once: **editing `bootstrap/local.sql` has no effect on a volume
that already exists.** Run `npm run db:reset` after changing it.

---

## The two roles

Locally and in deployment, the same split:

| Role | Purpose |
|---|---|
| `vendlyfy_owner` | Owns the schema, runs migrations. Superuser locally only because the Postgres image's `POSTGRES_USER` always is; in deployment it is the provider's ordinary owner role. |
| `vendlyfy_app` | What the application connects as. Owns nothing, runs no DDL, cannot create objects in `public`. Its table privileges come from migrations. |

```
postgresql://vendlyfy_owner:localdev@127.0.0.1:55432/vendlyfy    migrations, psql
postgresql://vendlyfy_app:localdev@127.0.0.1:55432/vendlyfy      the application
```

Both passwords are `localdev`, local and worthless. They appear in `docker-compose.yml`,
`bootstrap/local.sql` and the commented block in `server/.env.example` — and `db:verify` logs in as
**both roles over TCP**, so if those copies ever drift, verification fails immediately instead of
the drift surfacing at milestone 11.

---

## The Postgres version

**Pinned to major version 17**, in `docker-compose.yml`.

> **This must equal the deployed instance's major version.** Pick both together and move both in one
> commit. A container one major ahead of production is a class of bug that only shows up after
> deploy — and `db:verify` asserts the running server matches the pin, which is the local half of
> that promise only.

The image is **Debian-based on purpose, not Alpine**: musl and glibc collate text differently, which
changes `ORDER BY` results and index behaviour against a glibc-based managed instance.

If the major version is ever bumped, note that the data directory path inside the official image
changed after 17 — the volume mount in `docker-compose.yml` is version-dependent, and a bump means
a `db:reset`, not an in-place upgrade.

---

## Why plain Postgres and not the Supabase stack

The Supabase CLI local stack is about six containers and pins you to Supabase's migration
conventions, which §2.4 deliberately replaces. Plain Postgres makes the container an **exact match**
for the deployed instance — same engine, same extensions, same role split — with no stub roles and
no fake `storage` schema. That removes 61 role-grant statements, ~20 storage-policy statements, two
RLS enables and two policies from the schema (§4.2).

The one Supabase dependency that remains is **image storage**, which is not a database concern.
Locally the upload endpoint is stubbed; the decision between keeping the bucket and moving to S3/R2
is open (Part 9) and does not block anything here.

---

## Container choices, and the reason for each

| Choice | Reason |
|---|---|
| Host port **55432**, not 5432 | A mistyped `DATABASE_URL` fails to connect instead of reaching something real. On this machine 5432 is already taken by another Postgres. |
| Bound to **`127.0.0.1`** | `"55432:5432"` alone publishes on `0.0.0.0`, and Docker's rules sit in front of firewalld — that would put the database on the LAN. |
| Project name **`vendlyfy`**, volume **`vendlyfy_pgdata`** | Fixed names, so the volume survives the checkout directory being renamed (this repo is still called `restaurant_os`). |
| Healthcheck via **`pg_isready -h 127.0.0.1`** | Checks the TCP listener, not just the unix socket, so `--wait` cannot return on a server clients can't reach. |
| **`--data-checksums`** | On by default at most managed providers, so on here too. `initdb`-time only, so it needs a `db:reset` to apply. |
| **`timezone=UTC`**, `log_timezone=UTC` | Determinism for money and timestamps. |
| **`pg_stat_statements`**, `track_io_timing` | §2.3 requires `EXPLAIN (ANALYZE, BUFFERS)` against seeded volumes before a request-path query merges. This is what measures it. |
| **`log_min_duration_statement=200`**, `log_lock_waits` | Slow queries and lock contention show up in `db:logs` without reconfiguring anything. Log size is capped so it can't fill the disk. |
| **`shm_size: 256mb`** | Parallel queries and large sorts otherwise fail on the default 64 MB. |

---

## Troubleshooting

**`nothing accepting TCP on 127.0.0.1:55432`, but the container is healthy.** The port publish is
broken, or Docker's port forwarder didn't start. `npm run db:down && npm run db:up`.

**`something is already listening on 127.0.0.1:55432`.** Another copy of this container from a
different checkout, or an unrelated service. `docker ps` will say.

**The app role cannot log in.** `bootstrap/local.sql` runs only on an empty data directory. If you
added or changed it after the volume existed: `npm run db:reset -- -y`.

**`db:reset` refuses in CI.** By design — it requires `-y` or `DB_RESET_YES=1` rather than assuming
consent, because the same command pointed somewhere real only needs to happen once.
