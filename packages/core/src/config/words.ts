// packages/core/src/config/words.ts — milestone 12.
//
// The platform's own vocabulary, and the singular derivation.

import type { WordKey } from './types.ts';
import { WORD_KEYS } from './types.ts';

/**
 * What the platform calls each thing when nothing has renamed it.
 *
 * These are AdminIndustries' own left-hand labels — the editor shows "Products", "Catalog",
 * "Categories", "Options" beside the inputs a super admin types into. So they are not
 * invented defaults: they are the words the product already uses to describe the slots.
 *
 * They matter because `config_is_words` permits a SUBSET of the four keys. A template that
 * renames only `product` leaves the other three unresolved, and a half-onboarded store has
 * no template at all — Onboarding's first question is the business type, and a store must
 * still render before it is answered.
 */
export const PLATFORM_WORDS: Readonly<Record<WordKey, string>> = {
  product: 'Products',
  catalog: 'Catalog',
  category: 'Categories',
  option: 'Options',
};

/**
 * A plural → singular guess, for the form the screens need but the editor does not collect.
 *
 * WHY THIS EXISTS. AdminIndustries stores the plural, because that is what its inputs show:
 * Products → "Menu items", Categories → "Sections". Categories.dc.html then needs the
 * singular — its button reads "Add section" and its toast "Section deleted" — so something
 * has to produce one.
 *
 * WHAT IT IS EXACT FOR. All 32 words the eight templates ship, asserted one by one in
 * packages/core/test/config.test.ts. It is also idempotent: applying it to its own output
 * changes nothing, so an already-singular word passes through untouched.
 *
 * WHAT IT CANNOT DO. It is orthography, not knowledge. A merchant who renames the product
 * word to "Clothes" gets "Clothe"; "Mice" and "Children" are beyond it entirely. The right
 * fix is for the editor to collect both forms — a designer change, recorded in Part 9 of
 * the plan — and until then ResolvedWord.derived says which values were guessed, so a
 * screen or a Settings panel can show the merchant what it decided and let them correct it.
 * Guessing quietly and calling it data is the failure this comment exists to prevent.
 *
 * The rules, in order, applied to the end of the whole string — the plural word is always
 * the last one, so "Pack sizes" and "Add-ons" need no tokenising:
 */
export function singularize(word: string): string {
  const value = word.trimEnd();
  if (value.length < 3) return word;

  // Categories → Category. Accessories → Accessory. Guarded on length so "ies" alone and
  // "Pies" are left alone.
  if (/[a-z]ies$/i.test(value) && value.length > 4) {
    return value.slice(0, -3) + (value.endsWith('IES') ? 'Y' : 'y');
  }

  // Classes → Class. Boxes → Box. Finishes → Finish. Churches → Church. Buzzes → Buzz.
  //
  // ONLY these clusters, and that restriction is the whole correctness of this function.
  // A general "-es → -" rule turns "Pack sizes" into "Pack siz", because "sizes" also ends
  // in a sibilant + es — the difference is a silent e in the base, which spelling alone
  // cannot see. Single -ses, -zes and -ces therefore fall through to the -s rule below,
  // where "sizes" becomes "size" and "Services" becomes "Service".
  if (/(sses|xes|ches|shes|zzes)$/i.test(value)) {
    return value.slice(0, -2);
  }

  // Sections → Section. Extras → Extra. Add-ons → Add-on.
  //
  // The exclusions are words whose singular already ends in s: Dress, Status, Analysis.
  // Without them "Dress" would become "Dres" — and this function must be safe to apply to
  // a word that was never plural, because idempotence is what makes it safe to apply twice.
  if (/s$/i.test(value) && !/(ss|us|is)$/i.test(value)) {
    return value.slice(0, -1);
  }

  return value;
}

/** True when `singularize` leaves a word unchanged — i.e. it was already singular, or beyond it. */
export function isAlreadySingular(word: string): boolean {
  return singularize(word) === word.trimEnd();
}

/** Every word key, for iterating without importing the const array everywhere. */
export function wordKeys(): readonly WordKey[] {
  return WORD_KEYS;
}
