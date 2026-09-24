# `@vendlyfy/core`

The isomorphic layer — L3 of the layer model in
[`../../docs/migration/01-target-architecture.md`](../../docs/migration/01-target-architecture.md).
Code in here runs **unchanged in the browser and in the Express server**.

Empty today by design. `src/index.ts` names the three modules that land here and the milestone that
brings each: `theme-engine` and `money` at 13, `config` at 12.

## The one rule

`tsconfig.json` gives this package `"lib": ["ES2023"]` and `"types": []` — no DOM, no Node. A module
that reaches for `document` or for `process` **fails to compile**. That is deliberate: §3 of the
implementation plan names duplicating any of this between client and server as the likeliest source
of "the preview doesn't match the live store", and the compiler is a better guard than a convention.

## Not yet wired to the apps

Nothing imports it, so nothing needs to resolve it yet. `npm` workspaces — which would make
`@vendlyfy/core` resolvable from `client/` and `server/` by name — are deferred until milestone 12,
when the first consumer exists. The reason is narrow: the old client and server deploy from their own
directories (`client/vercel.json`, `render.yaml` with `rootDir: server`, each with its own
lockfile), and they must keep running untouched until cutover at milestone 30. Restructuring
`node_modules` underneath a live money system, months before anything needs it, buys nothing.
