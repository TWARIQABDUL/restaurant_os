// @vendlyfy/core — the shared, isomorphic layer (L3 of §3).
//
// Three modules live here, each with the milestone that brings it:
//
//   config         milestone 12  DONE. published template version + store overrides →
//                                effective config, resolved server-side and served once
//                                with an ETag. Exposes t(key) and has(module) — the only two
//                                primitives a component gets. A component that branches on
//                                an industry name means this failed.
//   theme-engine   milestone 13  eight inputs → nine tokens + a contrast report. Enforces
//                                4.5:1 for text and 3:1 for buttons, and is the ONLY path to
//                                a published theme: the API re-runs it on publish and rejects
//                                any token set that is not its own output.
//   money          milestone 13  one formatter driven by the currency table, with cash
//                                rounding that applies only to cash-on-delivery totals.
//                                Property-tested.
//
// The package's tsconfig is what keeps everything here isomorphic: lib ES2023 and types []
// mean a module reaching for `document` OR for `process` fails to compile.
//
// NOT YET RESOLVABLE BY NAME. server/src/core.ts imports this package by relative path and
// says why; npm workspaces stay deferred while the legacy server is still deploying from its
// own lockfile. See §4.6 and the note in that file.

export {
  PLATFORM_WORDS,
  WORD_KEYS,
  bindConfig,
  isAlreadySingular,
  resolveConfig,
  singularize,
  wordKeys,
} from './config/index.ts';

export type {
  Attribute,
  AttributePick,
  ConfigInputs,
  ConfigOverrides,
  ConfigSource,
  ConfigTemplate,
  EffectiveConfig,
  FeatureGate,
  ModuleDefinition,
  OrderStep,
  ResolvedModule,
  ResolvedWord,
  Vocabulary,
  WordForm,
  WordKey,
} from './config/index.ts';
