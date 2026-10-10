// @vendlyfy/core — the shared, isomorphic layer (L3 of §3).
//
// Three modules live here, each with the milestone that brings it:
//
//   config         milestone 12  DONE. published template version + store overrides →
//                                effective config, resolved server-side and served once
//                                with an ETag. Exposes t(key) and has(module) — the only two
//                                primitives a component gets. A component that branches on
//                                an industry name means this failed.
//   theme          milestone 13  DONE. eight inputs → twelve colours + a contrast report +
//                                a plain-language list of what it adjusted. Transcribed from
//                                ThemeStudio.dc.html, which contains a working makeTheme(), and
//                                pinned against a 535-case golden table generated from it. The
//                                ONLY path to a published theme: the API re-runs it on publish
//                                and rejects any token set that is not its own output.
//   money          milestone 13  DONE. one formatter driven by the currencies table, with cash
//                                rounding that applies only to cash-on-delivery totals. Exact
//                                decimal arithmetic on BigInt minor units — amounts arrive from
//                                Postgres as strings and never become floats. Property-tested,
//                                and pinned against a golden table from AdminCurrencies.dc.html.
//
// The package's tsconfig is what keeps everything here isomorphic: lib ES2023 and types []
// mean a module reaching for `document` OR for `process` fails to compile.
//
// NOT YET RESOLVABLE BY NAME. server/src/core.ts imports this package by relative path and
// says why; npm workspaces stay deferred while the legacy server is still deploying from its
// own lockfile. See §4.6 and the note in that file.

export {
  addDecimal,
  cashDue,
  compareDecimal,
  formatCashDue,
  formatMoney,
  isZero,
  multiplyDecimal,
  parseDecimal,
  rescale,
  roundToStep,
  sumDecimals,
  toDecimalString,
} from './money/index.ts';

export type { CurrencyFormat, Decimal, MoneyInput } from './money/index.ts';

export {
  CARD_TREATMENTS,
  HARMONIES,
  HEADING_FONTS,
  HEROES,
  MERCHANT_VISIBLE_TOKENS,
  MOODS,
  SHAPES,
  DEFAULT_DESIGN,
  HOMEPAGE_SECTIONS,
  PRODUCT_LAYOUTS,
  compileTheme,
  contrast,
  failingChecks,
  hsl,
  isMediaPath,
  isPublishable,
  luminance,
  mix,
  pickOn,
  rgbToHsl,
  shiftLightness,
  toHex,
  toRgb,
} from './theme/index.ts';

export type {
  CardTreatment,
  CompiledColors,
  CompiledTheme,
  ContrastCheck,
  Design,
  Harmony,
  HeadingFont,
  Hero,
  HomepageSection,
  ProductLayout,
  Hsl,
  Mood,
  Rgb,
  Shape,
  ThemeInputs,
} from './theme/index.ts';

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

// Milestone 28: the email and SMS templates (project/Messages.dc.html) — pure, so the server renders the real message and the admin console previews the same one.
export {
  CUSTOMER_MESSAGES,
  CUSTOMER_TEMPLATES,
  MESSAGE_LABEL,
  SMS_LIMIT,
  SMS_ONLY_MESSAGES,
  SMS_TEMPLATES,
  emailColours,
  isCustomerMessage,
  renderCustomerEmail,
  renderEmailHtml,
  renderSms,
  sampleContext,
  senderId,
  smsFit,
} from './messages/index.ts';
export type { CustomerEmail, CustomerMessage, EmailColours, EmailOrder, MessageContext, MessageKey, SmsOnlyMessage } from './messages/index.ts';
