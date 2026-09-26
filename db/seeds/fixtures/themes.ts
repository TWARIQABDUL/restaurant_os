// db/seeds/fixtures/themes.ts — milestone 13.
//
// The three stores whose theme inputs context.ts already recorded, now that there is somewhere to
// put them. Its note said so: "ThemeStudio and ShoeStores are milestone 13, and `store_themes`
// does not exist yet — so these are recorded here rather than inserted anywhere." V015 created it.
//
// TWO OF THE THREE ARE SHOESTORES' OWN STORES. Kigali Kicks is its first card exactly — brand
// #E4572E, accent #F4D35E, light · round · sport · raised — and Inzu Threads carries the input set
// of its second, Ikirenge Atelier: #6B3E26, analogous, warm · sharp · classic · outlined. So
// seeding these reproduces the board's palettes in a real database rather than only in a test.
//
// THE PALETTES ARE NOT WRITTEN HERE. They are compiled, by the same function the API calls on
// publish. A seed that hand-wrote twelve hex values would be a second theme engine, and the first
// thing to drift.

import { compileTheme } from '../../../packages/core/src/index.ts';
import type { CompiledTheme, ThemeInputs } from '../../../packages/core/src/index.ts';
import type { Ctx } from './context.ts';
import { STORE, THEME_INPUTS } from './context.ts';

/**
 * context.ts records seven of the eight inputs — `hero` is not among them, because it was only
 * identified as a theme input when ThemeStudio's own controls were read at milestone 13. Supplied
 * here, per store, rather than defaulted: the banner style is the one non-colour choice that
 * changes a colour, so a silent default would hide a real difference between these three.
 */
const HERO: Readonly<Record<'kicks' | 'nyama' | 'inzu', ThemeInputs['hero']>> = {
  // ShoeStores' Kigali Kicks card is `hero: 'fill'` — the bold banner.
  kicks: 'fill',
  // Nyama's own board (Shop.dc.html) shows a tinted header rather than a block of brand colour.
  nyama: 'soft',
  // Ikirenge Atelier, whose input set this is, is `hero: 'soft'`.
  inzu: 'soft',
};

const STORE_OF: Readonly<Record<'kicks' | 'nyama' | 'inzu', string>> = {
  kicks: STORE.kicks,
  nyama: STORE.nyama,
  inzu: STORE.inzu,
};

function inputsFor(key: 'kicks' | 'nyama' | 'inzu'): ThemeInputs {
  const recorded = THEME_INPUTS[key];
  return {
    brand: recorded.brand,
    // Only Kigali Kicks picked an accent; the other two let the harmony decide.
    accent: 'accent' in recorded ? recorded.accent : null,
    // context.ts records a harmony only where the merchant chose one other than the default.
    harmony: 'harmony' in recorded ? recorded.harmony : 'complementary',
    mood: recorded.mood,
    shape: recorded.shape,
    headingFont: recorded.font,
    cardTreatment: recorded.card,
    hero: HERO[key],
  };
}

const COLUMNS = `
    store_id, status, published_at,
    input_brand, input_accent, input_harmony, input_mood,
    input_shape, input_heading_font, input_card_treatment, input_hero,
    color_bg, color_surface, color_text, color_muted, color_border,
    color_primary, color_on_primary, color_accent, color_on_accent,
    color_tint, color_hero_bg, color_hero_text,
    is_dark, needs_outline`;

/** The 24 bound values for the PUBLISHED insert below, in its placeholder order. */
function publishedValues(storeId: string, theme: CompiledTheme): unknown[] {
  return [
    storeId,
    'published',
    theme.inputs.brand,
    theme.inputs.accent,
    theme.inputs.harmony,
    theme.inputs.mood,
    theme.inputs.shape,
    theme.inputs.headingFont,
    theme.inputs.cardTreatment,
    theme.inputs.hero,
    theme.colors.bg,
    theme.colors.surface,
    theme.colors.text,
    theme.colors.muted,
    theme.colors.border,
    theme.colors.primary,
    theme.colors.onPrimary,
    theme.colors.accent,
    theme.colors.onAccent,
    theme.colors.tint,
    theme.colors.heroBg,
    theme.colors.heroText,
    theme.dark,
    theme.outline,
  ];
}

export async function seedThemes(ctx: Ctx): Promise<void> {
  ctx.step('Store looks');

  for (const key of ['nyama', 'inzu', 'kicks'] as const) {
    const inputs = inputsFor(key);
    const theme = compileTheme(inputs);

    await ctx.sql(
      `INSERT INTO store_themes (${COLUMNS})
            VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
      publishedValues(STORE_OF[key], theme),
    );

    ctx.info(
      `${key.padEnd(6)} ${inputs.mood.padEnd(5)} brand ${theme.colors.primary} ` +
        `page ${theme.colors.bg} buttons ${theme.colors.primary}/${theme.colors.onPrimary} ` +
        `accent ${theme.colors.accent}${theme.outline ? ' · outlined' : ''}`,
    );
  }

  // A DRAFT THAT DIFFERS FROM WHAT IS LIVE, so ThemeStudio has the state it is built to show:
  // a merchant mid-experiment, with the published look still serving customers. Ubwiza is
  // choosing a mood; nothing of theirs is published yet, which is also a state — a store on the
  // platform default.
  const draft = compileTheme({
    brand: '#9D174D',
    accent: null,
    harmony: 'analogous',
    mood: 'warm',
    shape: 'round',
    headingFont: 'editorial',
    cardTreatment: 'shadow',
    hero: 'soft',
  });
  // Written out rather than derived from COLUMNS by a replace: a draft has no published_at, and
  // editing a column list with a string replace while editing the value list with a filter got
  // both wrong at once — it dropped the brand and left the counts mismatched.
  await ctx.sql(
    `INSERT INTO store_themes (
         store_id, status,
         input_brand, input_accent, input_harmony, input_mood,
         input_shape, input_heading_font, input_card_treatment, input_hero,
         color_bg, color_surface, color_text, color_muted, color_border,
         color_primary, color_on_primary, color_accent, color_on_accent,
         color_tint, color_hero_bg, color_hero_text,
         is_dark, needs_outline
     ) VALUES ($1, 'draft', $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
    [
      STORE.ubwiza,
      draft.inputs.brand,
      draft.inputs.accent,
      draft.inputs.harmony,
      draft.inputs.mood,
      draft.inputs.shape,
      draft.inputs.headingFont,
      draft.inputs.cardTreatment,
      draft.inputs.hero,
      draft.colors.bg,
      draft.colors.surface,
      draft.colors.text,
      draft.colors.muted,
      draft.colors.border,
      draft.colors.primary,
      draft.colors.onPrimary,
      draft.colors.accent,
      draft.colors.onAccent,
      draft.colors.tint,
      draft.colors.heroBg,
      draft.colors.heroText,
      draft.dark,
      draft.outline,
    ],
  );

  ctx.ok('three published looks, one unpublished draft, and two stores on the platform default');
}
