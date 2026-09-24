# Retired one-off scripts

**These are CommonJS, and stay CommonJS.** `server/` became ESM at milestone 3; the
`package.json` beside this file is the only thing in the directory that matters — Node resolves a
file's module system from the nearest `package.json`, so every `.js` here keeps running unchanged
with no conversion and no risk.

They are the old Supabase-era tooling: `run-*.js` applied a hand-written `.sql` file from
`../../supabase/`, and the `create_*` / `alter_*` scripts were one-off DDL. All of that is replaced
by the migration runner in [`../../db/`](../../db/), which has a ledger, checksums, ordering and
transactions — none of which these have.

## Why they are still here

§4.3 of the implementation plan retires them. They are kept until **cutover (milestone 30)** for one
narrow reason: until then the live system still runs on the old Supabase database, and `run-sql.js`
is the only tool that can apply a hotfix to it. Deleting that capability months before the database
is decommissioned would be trading a real operational ability for tidiness.

`verify-lockdown.js` and `verify-storage-lockdown.js` audit the Supabase anon-key lockdown. They
retire with the anon key, which also means at cutover.

`provision-momo-keys.js` is **not** retired — it provisions MTN MoMo API users and keys, which the
new system needs too. It moves to the new tooling when the payments work lands.

## Do not add to this directory

Anything new belongs in `db/migrations/` (schema) or as a TypeScript script under `db/scripts/`.
