// packages/core/src/config/types.ts — milestone 12.
//
// The shapes the config resolver reads and writes. They mirror V002's tables exactly,
// because the resolver's whole job is to turn those rows into one answer:
//
//   industry_template_versions          → ConfigTemplate
//   industry_template_version_modules   → ConfigTemplate.modules
//   stores.config_overrides             → ConfigOverrides
//   modules                             → ModuleDefinition[]
//
// No DOM and no Node here — packages/core compiles with lib: ES2023 and types: [], so a
// module that reaches for `document` or `process` fails to compile (§3). That is not
// decoration: this file's output is serialised by the server and read by the browser, and
// "the preview doesn't match the live store" is what duplicating it would cause.

/**
 * The four words a template may rename, and the only four. A fifth is a platform
 * capability change, so it is a migration rather than data — `config_is_words` in V002
 * enforces the same list at the column.
 */
export const WORD_KEYS = ['product', 'catalog', 'category', 'option'] as const;
export type WordKey = (typeof WORD_KEYS)[number];

/**
 * `many` is what the editor stores — AdminIndustries' inputs are labelled Products,
 * Catalog, Categories, Options and a super admin types "Menu items", "Sections". `one` is
 * derived, because the screens need it: Categories' button reads "Add section", not "Add
 * sections". See singularize() for what that derivation can and cannot do.
 */
export type WordForm = 'many' | 'one';

/** Where a resolved value came from. Settings and AdminIndustries both need to show this. */
export type ConfigSource = 'store' | 'template' | 'platform';

/** How many of an option group's values a customer picks. V002's config_is_attributes. */
export type AttributePick = 'one' | 'several';

/** A one-tap suggestion in Add product. `priced` is food's "Extras + 500". */
export type Attribute = {
  name: string;
  pick: AttributePick;
  priced?: boolean;
};

/**
 * A step in the order timeline.
 *
 * TWO FIELDS, NOT ONE, and V002 says why: "the key is what code and history refer to while
 * the label is per-industry wording — Services calls its first step 'Booked' where Food
 * calls it 'New', and both mean the same state."
 */
export type OrderStep = {
  key: string;
  label: string;
};

/** One row of the `modules` table: a feature gate the platform actually implements. */
export type ModuleDefinition = {
  key: string;
  label: string;
  description: string;
};

/** A template version, flattened. Null for a store that has not chosen a business type yet. */
export type ConfigTemplate = {
  key: string;
  name: string;
  /** AdminIndustries' dot colour. Template metadata — a store's accent is its own (13). */
  accentColor: string;
  version: number;
  words: Partial<Record<WordKey, string>>;
  attributes: readonly Attribute[];
  orderSteps: readonly OrderStep[];
  /** Module keys this version switches ON. Absence is off. */
  modules: readonly string[];
  productFlags: readonly string[];
};

/**
 * What this merchant changed in Settings. Only these two sections exist, and V002's
 * stores_assert_valid_overrides refuses any other — an override of a section or a module
 * that does not exist would be ignored silently forever.
 */
export type ConfigOverrides = {
  words?: Partial<Record<WordKey, string>>;
  modules?: Readonly<Record<string, boolean>>;
};

export type ConfigInputs = {
  /** Every module the platform offers, from the `modules` table. The closed world for has(). */
  registry: readonly ModuleDefinition[];
  template: ConfigTemplate | null;
  overrides: ConfigOverrides;
};

export type ResolvedWord = {
  /** The plural the editor stores, or the platform's own label as a fallback. */
  many: string;
  /** Derived from `many` unless a future editor collects it. See `derived`. */
  one: string;
  source: ConfigSource;
  /**
   * True when `one` was guessed from `many` by rule rather than entered. Exact for all 32
   * words the eight templates ship; a merchant override can defeat it ("Clothes" becomes
   * "Clothe"), which is why this flag exists rather than being assumed away.
   */
  derived: boolean;
};

export type ResolvedModule = {
  enabled: boolean;
  source: ConfigSource;
  label: string;
};

/**
 * One store's effective configuration — the whole answer, resolved server-side once and
 * served as one payload. `t()` and `has()` read nothing else.
 */
export type EffectiveConfig = {
  template: { key: string; name: string; accentColor: string; version: number } | null;
  /** All four keys, always present. A screen never has to handle a missing word. */
  words: Record<WordKey, ResolvedWord>;
  /** Every module in the registry, always present, so has() has a closed world to check. */
  modules: Record<string, ResolvedModule>;
  attributes: Attribute[];
  orderSteps: OrderStep[];
  productFlags: string[];
};
