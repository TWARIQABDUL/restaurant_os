// @vendlyfy/core — the shared, isomorphic layer (L3 of §3).
//
// Nothing lives here yet. Three modules land in it, each with the milestone that
// brings it:
//
//   theme-engine   milestone 13  eight inputs → nine tokens + a contrast report.
//                                Enforces 4.5:1 for text and 3:1 for buttons, and
//                                is the ONLY path to a published theme: the API
//                                re-runs it on publish and rejects any token set
//                                that is not its own output.
//   config         milestone 12  published template version + store overrides →
//                                effective config, served once with an ETag.
//                                Exposes t(key) and has(module) — the only two
//                                primitives a component gets. A component that
//                                branches on an industry name means this failed.
//   money          milestone 13  one formatter driven by the currency table, with
//                                cash rounding that applies only to
//                                cash-on-delivery totals. Property-tested.
//
// The package is deliberately empty rather than absent: its tsconfig is what
// enforces that everything added here stays isomorphic, and it exists now so
// milestones 12 and 13 have somewhere to land without touching configuration.
//
// It is not yet consumed by client or server — see the workspace note in §4.6.

export {};
