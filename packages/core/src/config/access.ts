// packages/core/src/config/access.ts — milestone 12.
//
// The two primitives, and there are deliberately only two.
//
// §1.3: "If a component branches on industry name, the architecture has failed. Components
// get two primitives — t(key) for vocabulary and has(module) for feature gates — and nothing
// else." Part 8 names the risk they exist to contain: "A config engine leaking into hundreds
// of scattered conditionals is worse than hardcoding ... A third primitive is a design smell."
//
// So `t` takes an optional FORM rather than there being a second vocabulary function, and
// there is no t('template.name'): a screen that needs the template's name reads
// config.template.name, which is data, not vocabulary.

import type { EffectiveConfig, WordForm, WordKey } from './types.ts';
import { WORD_KEYS } from './types.ts';

export type Vocabulary = (key: WordKey, form?: WordForm) => string;
export type FeatureGate = (module: string) => boolean;

/**
 * BOTH PRIMITIVES THROW ON AN UNKNOWN KEY, and that is the most important decision in this
 * file.
 *
 * V002 refuses a template naming module `stok` with a foreign key, because otherwise
 * `has('stock')` is false for every store on that template, silently and for good. The same
 * mistake made in a COMPONENT — `has('stok')` — is invisible to the database: the key set is
 * closed, the module is simply not in it, and returning false would hide a feature from
 * every store while looking exactly like a feature that is switched off.
 *
 * A thrown error surfaces on the first render, in development, naming the typo. It is the
 * same reasoning as assertPermissionsExist() at boot in milestone 11: a misspelt string that
 * answers "no" is worse than one that answers loudly.
 */
export function bindConfig(config: EffectiveConfig): { t: Vocabulary; has: FeatureGate } {
  const t: Vocabulary = (key, form = 'many') => {
    const word = config.words[key];
    if (word === undefined) {
      // Unreachable through the type system; reachable from untyped JS during the rewrite.
      throw new Error(
        `t(${JSON.stringify(key)}) — not a word this platform renames. The four are: ${WORD_KEYS.join(', ')}.`,
      );
    }
    return form === 'one' ? word.one : word.many;
  };

  const has: FeatureGate = (module) => {
    const resolved = config.modules[module];
    if (resolved === undefined) {
      throw new Error(
        `has(${JSON.stringify(module)}) — no such module. Known: ${Object.keys(config.modules).sort().join(', ')}. ` +
          'A module the platform does not implement would answer false forever, which reads as "switched off" rather than "misspelt".',
      );
    }
    return resolved.enabled;
  };

  return { t, has };
}
