// packages/core/src/config/index.ts — milestone 12.

export { bindConfig } from './access.ts';
export type { FeatureGate, Vocabulary } from './access.ts';
export { resolveConfig } from './resolve.ts';
export { PLATFORM_WORDS, isAlreadySingular, singularize, wordKeys } from './words.ts';
export { WORD_KEYS } from './types.ts';
export type {
  Attribute,
  AttributePick,
  ConfigInputs,
  ConfigOverrides,
  ConfigSource,
  ConfigTemplate,
  EffectiveConfig,
  ModuleDefinition,
  OrderStep,
  ResolvedModule,
  ResolvedWord,
  WordForm,
  WordKey,
} from './types.ts';
