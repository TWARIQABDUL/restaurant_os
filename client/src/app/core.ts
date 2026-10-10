// client/src/app/core.ts — milestone 16.
//
// The ONE file in the client that knows where @vendlyfy/core lives, exactly mirroring
// server/src/core.ts. Everything else in client/src imports from here.
//
// WHY THE CLIENT NEEDS IT NOW. Until this milestone nothing in the browser did money: the gallery
// hand-wrote its fixtures and the auth screens have no prices. The storefront's option sheet recomputes
// a total as options are picked — "Add · 8,000 RWF" changes when Cheese is added — so the formatter has
// to be in the browser. Formatting server-side would mean a round trip per tap.
//
// AND IT IS THE SAME FORMATTER THE SERVER USES, which is the whole point of packages/core existing:
// §3 puts config, theme and money in an isomorphic layer so that "the preview doesn't match the live
// store" cannot happen. A second money formatter written in React would be exactly that bug, in the one
// place a customer is deciding whether to pay.
//
// WHY A RELATIVE PATH AND NOT THE PACKAGE NAME — the argument is server/src/core.ts's, unchanged: npm
// workspaces stay deferred while the legacy client and server deploy from their own lockfiles
// (client/vercel.json, render.yaml), and both must keep running untouched until cutover. Vite resolves
// this path at build time with no configuration at all, which is one fewer thing to get wrong than an
// alias. It is one line to change here at milestone 30.
//
// THE IMPORT IS TYPE-SAFE IN BOTH DIRECTIONS. packages/core compiles under its own tsconfig with
// `lib: ES2023` and `types: []`, so a module there that reached for `document` or `process` would fail
// ITS typecheck even though this project would accept it. That guarantee is what makes importing it into
// the browser safe, and it is enforced by `tsc -p packages/core`, not by this comment.

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
  CARD_TREATMENTS,
  DEFAULT_DESIGN,
  HARMONIES,
  HEADING_FONTS,
  HEROES,
  HOMEPAGE_SECTIONS,
  MERCHANT_VISIBLE_TOKENS,
  MOODS,
  PRODUCT_LAYOUTS,
  SHAPES,
  addDecimal,
  compileTheme,
  contrast,
  luminance,
  rgbToHsl,
  toRgb,
  failingChecks,
  isMediaPath,
  isPublishable,
  bindConfig,
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
} from '../../../packages/core/src/index.ts';

export type {
  Attribute,
  CardTreatment,
  CompiledColors,
  CompiledTheme,
  ContrastCheck,
  CurrencyFormat,
  Decimal,
  Design,
  Harmony,
  HeadingFont,
  Hero,
  Hsl,
  HomepageSection,
  Mood,
  ProductLayout,
  Shape,
  EffectiveConfig,
  FeatureGate,
  MoneyInput,
  OrderStep,
  ResolvedModule,
  ResolvedWord,
  ThemeInputs,
  Vocabulary,
  WordKey,
} from '../../../packages/core/src/index.ts';
export type { CustomerEmail, CustomerMessage, EmailColours, EmailOrder, MessageContext, MessageKey, SmsOnlyMessage } from '../../../packages/core/src/index.ts';
