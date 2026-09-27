// server/src/repositories/themes.ts — milestone 13.
//
// A store's draft and published look. Twelve colour columns and eight input columns, which is
// verbose to read and exactly what makes V015's constraints able to name what is wrong.
//
// THE REPOSITORY DOES NOT COMPILE ANYTHING. It stores what it is handed and reads back what is
// stored. The re-run gate — that the colours are the compiler's own output for the inputs beside
// them — is the route's, because it needs packages/core, and the route is where it is tested.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';
import type { CompiledTheme, ThemeInputs } from '../core.ts';

export type ThemeStatus = 'draft' | 'published';

/** A stored theme: the inputs, the colours, the two flags, and when it went live. */
export type StoredTheme = {
  status: ThemeStatus;
  inputs: ThemeInputs;
  colors: CompiledTheme['colors'];
  dark: boolean;
  outline: boolean;
  updatedAt: Date;
  publishedAt: Date | null;
};

type ThemeRow = {
  status: ThemeStatus;
  input_brand: string;
  input_accent: string | null;
  input_harmony: ThemeInputs['harmony'];
  input_mood: ThemeInputs['mood'];
  input_shape: ThemeInputs['shape'];
  input_heading_font: ThemeInputs['headingFont'];
  input_card_treatment: ThemeInputs['cardTreatment'];
  input_hero: ThemeInputs['hero'];
  color_bg: string;
  color_surface: string;
  color_text: string;
  color_muted: string;
  color_border: string;
  color_primary: string;
  color_on_primary: string;
  color_accent: string;
  color_on_accent: string;
  color_tint: string;
  color_hero_bg: string;
  color_hero_text: string;
  is_dark: boolean;
  needs_outline: boolean;
  updated_at: Date;
  published_at: Date | null;
};

const COLUMNS = `
    status,
    input_brand, input_accent, input_harmony, input_mood,
    input_shape, input_heading_font, input_card_treatment, input_hero,
    color_bg, color_surface, color_text, color_muted, color_border,
    color_primary, color_on_primary, color_accent, color_on_accent,
    color_tint, color_hero_bg, color_hero_text,
    is_dark, needs_outline, updated_at, published_at`;

function fromRow(row: ThemeRow): StoredTheme {
  return {
    status: row.status,
    inputs: {
      brand: row.input_brand,
      accent: row.input_accent,
      harmony: row.input_harmony,
      mood: row.input_mood,
      shape: row.input_shape,
      headingFont: row.input_heading_font,
      cardTreatment: row.input_card_treatment,
      hero: row.input_hero,
    },
    colors: {
      bg: row.color_bg,
      surface: row.color_surface,
      text: row.color_text,
      muted: row.color_muted,
      border: row.color_border,
      primary: row.color_primary,
      onPrimary: row.color_on_primary,
      accent: row.color_accent,
      onAccent: row.color_on_accent,
      tint: row.color_tint,
      heroBg: row.color_hero_bg,
      heroText: row.color_hero_text,
    },
    dark: row.is_dark,
    outline: row.needs_outline,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

/** The values of a compiled theme, in the order the upsert below binds them. */
function toValues(theme: CompiledTheme): unknown[] {
  return [
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

export async function findByStatus(
  storeId: string,
  status: ThemeStatus,
  on: Queryable = db,
): Promise<StoredTheme | null> {
  const { rows } = await on.query<ThemeRow>(
    `SELECT ${COLUMNS} FROM store_themes WHERE store_id = $1 AND status = $2`,
    [storeId, status],
  );
  const row = rows[0];
  return row === undefined ? null : fromRow(row);
}

/** Both rows in one read, for the studio, which shows the draft against what is live. */
export async function findBoth(
  storeId: string,
  on: Queryable = db,
): Promise<{ draft: StoredTheme | null; published: StoredTheme | null }> {
  const { rows } = await on.query<ThemeRow>(
    `SELECT ${COLUMNS} FROM store_themes WHERE store_id = $1`,
    [storeId],
  );
  const themes = rows.map(fromRow);
  return {
    draft: themes.find((t) => t.status === 'draft') ?? null,
    published: themes.find((t) => t.status === 'published') ?? null,
  };
}

/**
 * The published theme for a slug — the storefront's read. One statement, one index.
 *
 * The column list is written out rather than built from COLUMNS with a replace: aliasing twenty
 * columns by regular expression is the kind of cleverness that silently drops one.
 */
export async function findPublishedBySlug(
  slug: string,
  on: Queryable = db,
): Promise<{ store: { id: string; slug: string; name: string }; theme: StoredTheme | null } | null> {
  const { rows } = await on.query<
    Partial<ThemeRow> & { store_id: string; store_slug: string; store_name: string }
  >(
    `SELECT s.id   AS store_id,
            s.slug AS store_slug,
            s.name AS store_name,
            t.status,
            t.input_brand, t.input_accent, t.input_harmony, t.input_mood,
            t.input_shape, t.input_heading_font, t.input_card_treatment, t.input_hero,
            t.color_bg, t.color_surface, t.color_text, t.color_muted, t.color_border,
            t.color_primary, t.color_on_primary, t.color_accent, t.color_on_accent,
            t.color_tint, t.color_hero_bg, t.color_hero_text,
            t.is_dark, t.needs_outline, t.updated_at, t.published_at
       FROM stores s
       LEFT JOIN store_themes t ON t.store_id = s.id AND t.status = 'published'
      WHERE s.slug = lower($1)`,
    [slug],
  );
  const row = rows[0];
  if (row === undefined) return null;

  return {
    store: { id: row.store_id, slug: row.store_slug, name: row.store_name },
    // A store with no published theme renders the platform default — tokens.css already holds
    // it, and §2.2 says a missing theme must degrade rather than take a shopfront offline. The
    // LEFT JOIN leaves every t.* column null, so `status` is the one to test.
    theme: row.status === undefined || row.status === null ? null : fromRow(row as ThemeRow),
  };
}

/**
 * Writes the draft, replacing whatever was there.
 *
 * A draft is a scratchpad: ThemeStudio edits "the" draft and V015's primary key allows exactly
 * one per store, so this is an upsert rather than an insert.
 */
export async function saveDraft(storeId: string, theme: CompiledTheme, tx: Queryable): Promise<void> {
  await tx.query(
    `INSERT INTO store_themes (
         store_id, status,
         input_brand, input_accent, input_harmony, input_mood,
         input_shape, input_heading_font, input_card_treatment, input_hero,
         color_bg, color_surface, color_text, color_muted, color_border,
         color_primary, color_on_primary, color_accent, color_on_accent,
         color_tint, color_hero_bg, color_hero_text,
         is_dark, needs_outline
     ) VALUES ($1, 'draft', $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     ON CONFLICT (store_id, status) DO UPDATE SET
         input_brand = EXCLUDED.input_brand,
         input_accent = EXCLUDED.input_accent,
         input_harmony = EXCLUDED.input_harmony,
         input_mood = EXCLUDED.input_mood,
         input_shape = EXCLUDED.input_shape,
         input_heading_font = EXCLUDED.input_heading_font,
         input_card_treatment = EXCLUDED.input_card_treatment,
         input_hero = EXCLUDED.input_hero,
         color_bg = EXCLUDED.color_bg,
         color_surface = EXCLUDED.color_surface,
         color_text = EXCLUDED.color_text,
         color_muted = EXCLUDED.color_muted,
         color_border = EXCLUDED.color_border,
         color_primary = EXCLUDED.color_primary,
         color_on_primary = EXCLUDED.color_on_primary,
         color_accent = EXCLUDED.color_accent,
         color_on_accent = EXCLUDED.color_on_accent,
         color_tint = EXCLUDED.color_tint,
         color_hero_bg = EXCLUDED.color_hero_bg,
         color_hero_text = EXCLUDED.color_hero_text,
         is_dark = EXCLUDED.is_dark,
         needs_outline = EXCLUDED.needs_outline`,
    [storeId, ...toValues(theme)],
  );
}

/**
 * Publishes a compiled theme.
 *
 * `published_at` moves every time, because ThemeStudio's button says the new look is live and
 * "when did this store's look change" should answer the last time it did.
 *
 * V015's five readability constraints fire here if the colours are unreadable. They should never
 * fire, because the route compiled them — which is the point: the database's refusal is the
 * backstop for a writer that did not.
 */
export async function publish(storeId: string, theme: CompiledTheme, tx: Queryable): Promise<Date> {
  const { rows } = await tx.query<{ published_at: Date }>(
    `INSERT INTO store_themes (
         store_id, status, published_at,
         input_brand, input_accent, input_harmony, input_mood,
         input_shape, input_heading_font, input_card_treatment, input_hero,
         color_bg, color_surface, color_text, color_muted, color_border,
         color_primary, color_on_primary, color_accent, color_on_accent,
         color_tint, color_hero_bg, color_hero_text,
         is_dark, needs_outline
     ) VALUES ($1, 'published', now(), $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     ON CONFLICT (store_id, status) DO UPDATE SET
         published_at = now(),
         input_brand = EXCLUDED.input_brand,
         input_accent = EXCLUDED.input_accent,
         input_harmony = EXCLUDED.input_harmony,
         input_mood = EXCLUDED.input_mood,
         input_shape = EXCLUDED.input_shape,
         input_heading_font = EXCLUDED.input_heading_font,
         input_card_treatment = EXCLUDED.input_card_treatment,
         input_hero = EXCLUDED.input_hero,
         color_bg = EXCLUDED.color_bg,
         color_surface = EXCLUDED.color_surface,
         color_text = EXCLUDED.color_text,
         color_muted = EXCLUDED.color_muted,
         color_border = EXCLUDED.color_border,
         color_primary = EXCLUDED.color_primary,
         color_on_primary = EXCLUDED.color_on_primary,
         color_accent = EXCLUDED.color_accent,
         color_on_accent = EXCLUDED.color_on_accent,
         color_tint = EXCLUDED.color_tint,
         color_hero_bg = EXCLUDED.color_hero_bg,
         color_hero_text = EXCLUDED.color_hero_text,
         is_dark = EXCLUDED.is_dark,
         needs_outline = EXCLUDED.needs_outline
     RETURNING published_at`,
    [storeId, ...toValues(theme)],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('publishing a theme returned no row');
  return row.published_at;
}

/** The currencies row a store sells in, for the money formatter. */
export type StoreCurrency = {
  code: string;
  symbol: string;
  symbolPosition: 'before' | 'after';
  decimals: number;
  thousandsSeparator: string;
  cashRounding: number;
};

/**
 * The store's selling currency, formatted-ready.
 *
 * §3: "one formatter driven by the currency table". This is the read that drives it, so no screen
 * has to carry its own idea of how RWF is written.
 */
/**
 * The same, by store id — for the merchant console, which knows the uuid.
 *
 * A SECOND FUNCTION RATHER THAN A SECOND BRANCH, which is the rule config.ts already follows for
 * inputsBySlug/inputsByStoreId. One function taking "either a slug or an id" has to decide which it was
 * given, and a uuid that happens to be a valid slug is exactly the input that decides wrong.
 */
export async function findCurrencyByStoreId(
  storeId: string,
  on: Queryable = db,
): Promise<StoreCurrency | null> {
  const { rows } = await on.query<StoreCurrency>(
    // The cast on cash_rounding is load-bearing for the same reason as below.
    `SELECT c.code,
            c.symbol,
            c.symbol_position      AS "symbolPosition",
            c.decimals,
            c.thousands_separator  AS "thousandsSeparator",
            c.cash_rounding::int   AS "cashRounding"
       FROM stores s
       JOIN currencies c ON c.code = s.selling_currency
      WHERE s.id = $1`,
    [storeId],
  );
  return rows[0] ?? null;
}

export async function findCurrencyBySlug(
  slug: string,
  on: Queryable = db,
): Promise<StoreCurrency | null> {
  const { rows } = await on.query<StoreCurrency>(
    // cash_rounding is numeric(12,2), and node-postgres returns numeric as a STRING — so
    // without the cast this arrives as '50.00' and roundToStep refuses it as "not a whole number
    // of units". V006 constrains the column to 0, 10, 50, 100 or 500, all integers, so the cast
    // is lossless. Everything else here is already text or smallint.
    `SELECT c.code,
            c.symbol,
            c.symbol_position      AS "symbolPosition",
            c.decimals,
            c.thousands_separator  AS "thousandsSeparator",
            c.cash_rounding::int   AS "cashRounding"
       FROM stores s
       JOIN currencies c ON c.code = s.selling_currency
      WHERE s.slug = lower($1)`,
    [slug],
  );
  return rows[0] ?? null;
}
