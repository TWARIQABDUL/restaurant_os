# `vercel.json` notes

Vercel validates `vercel.json` against a strict schema and rejects unknown keys,
including a `_comment` field inside a rewrite — that is what caused
`rewrites[0] should NOT have additional property _comment`. JSON has no comment
syntax, so the explanations live here instead.

## `/backend/:path*` → the Render API

Proxy the Render API onto this origin so the session cookie is first-party. vercel.app and onrender.com are both on the Public Suffix List, so a cookie set directly by the API would be third-party — Safari blocks those and Chrome is retiring them. Proxied here, the browser only ever talks to this domain. NOTE: /api/* is already taken by this project's own Vercel functions (sitemap, robots, seo), hence the separate /backend prefix. This rule is first so nothing below can claim it.

## Why the rewrite must stay first

The `/(.*)` catch-all at the bottom sends everything to `index.html`. Any rule
below it never matches, so `/backend/*` has to be declared above it.

## `/:slug` → `/api/seo`

Only for crawler user-agents (see the `has` block). Human visitors fall through
to the SPA. That handler escapes every tenant-controlled value it renders — see
the comment block at the top of `api/seo.js`.

## Headers

The `headers` block sets CSP, HSTS, `nosniff`, `frame-ancestors` and
Referrer-Policy. The CSP deliberately allows `fonts.googleapis.com`
(stylesheet) and `fonts.gstatic.com` (font files), because `index.html` loads
Inter and Outfit from Google Fonts. Removing those two sources renders the app
in a fallback face.
