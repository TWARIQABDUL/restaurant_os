// packages/core/src/config/resolve.ts — milestone 12.
//
// `published template version + store overrides → effective config`, in one pure function.
//
// SERVER-SIDE, ONCE. §3: "resolves ... server-side, once, served as one versioned payload
// with an ETag." The browser receives the answer, not the inputs — otherwise the resolution
// rule lives in two places and the storefront and the console can disagree about what a
// store calls its categories.
//
// THREE LAYERS, and the order is the product's: what the merchant changed in Settings wins
// over what the template says, which wins over what the platform calls the thing. The
// Industries board states the merchant half outright: "The merchant can change any of it
// later in Settings."

import type {
  ConfigInputs,
  EffectiveConfig,
  ResolvedModule,
  ResolvedWord,
  WordKey,
} from './types.ts';
import { WORD_KEYS } from './types.ts';
import { PLATFORM_WORDS, isAlreadySingular, singularize } from './words.ts';

/** A word's value and where it came from, resolved through the three layers. */
function resolveWord(
  key: WordKey,
  template: ConfigInputs['template'],
  overrides: ConfigInputs['overrides'],
): ResolvedWord {
  const fromStore = overrides.words?.[key];
  const fromTemplate = template?.words[key];

  // A blank override is not an override. V002's config_is_words already refuses an empty
  // string at the column, so this is belt to that braces — but a resolver that treated ''
  // as a rename would blank a word everywhere it appears.
  const many =
    fromStore !== undefined && fromStore.trim() !== ''
      ? fromStore
      : fromTemplate !== undefined && fromTemplate.trim() !== ''
        ? fromTemplate
        : PLATFORM_WORDS[key];

  const source =
    fromStore !== undefined && fromStore.trim() !== ''
      ? 'store'
      : fromTemplate !== undefined && fromTemplate.trim() !== ''
        ? 'template'
        : 'platform';

  // `derived` is not "was a rule used" — a rule is always used, so that would be a constant.
  // It is "did the rule CHANGE anything", which is the signal a Settings panel needs: only the
  // words the rule transformed are guesses worth showing a merchant to confirm. "Menu" derives
  // to "Menu" and needs no confirmation; "Sections" deriving to "Section" is a decision.
  return { many, one: singularize(many), source, derived: !isAlreadySingular(many) };
}

/**
 * Every module in the registry, resolved.
 *
 * ABSENCE IN THE TEMPLATE IS OFF, which is V002's own rule ("Modules on by default, from the
 * editor's toggles. Absence is off"). An override is explicitly true or false, so a merchant
 * can switch a module OFF that their template switched on — which is what makes "the merchant
 * can change any of it later in Settings" true in both directions.
 *
 * THE REGISTRY IS THE KEY SET, not the template's list and not the overrides'. That is what
 * gives has() a closed world: every module the platform implements appears here with a
 * boolean, so has() answering false always means "off", never "I have never heard of it".
 */
function resolveModules(inputs: ConfigInputs): Record<string, ResolvedModule> {
  const enabledByTemplate = new Set(inputs.template?.modules ?? []);
  const result: Record<string, ResolvedModule> = {};

  for (const definition of inputs.registry) {
    const override = inputs.overrides.modules?.[definition.key];
    const fromTemplate = enabledByTemplate.has(definition.key);

    result[definition.key] =
      override === undefined
        ? { enabled: fromTemplate, source: fromTemplate ? 'template' : 'platform', label: definition.label }
        : { enabled: override, source: 'store', label: definition.label };
  }

  return result;
}

/**
 * Resolves one store's configuration.
 *
 * Pure: same inputs, same output, no clock and no I/O. That is what lets the server hash the
 * result into an ETag and trust the hash.
 */
export function resolveConfig(inputs: ConfigInputs): EffectiveConfig {
  const words = {} as Record<WordKey, ResolvedWord>;
  for (const key of WORD_KEYS) {
    words[key] = resolveWord(key, inputs.template, inputs.overrides);
  }

  return {
    template:
      inputs.template === null
        ? null
        : {
            key: inputs.template.key,
            name: inputs.template.name,
            accentColor: inputs.template.accentColor,
            version: inputs.template.version,
          },
    words,
    modules: resolveModules(inputs),
    // Copied rather than aliased: the caller owns the result and must not be able to mutate
    // the inputs through it, which matters because the inputs are cached on the server.
    attributes: [...(inputs.template?.attributes ?? [])].map((a) => ({ ...a })),
    orderSteps: [...(inputs.template?.orderSteps ?? [])].map((s) => ({ ...s })),
    productFlags: [...(inputs.template?.productFlags ?? [])],
  };
}
