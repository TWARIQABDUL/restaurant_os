/**
 * Runtime plumbing for the nine per-store tokens — milestone 4.
 *
 * The fixed tokens live in tokens.css and are compiled at build time. These twelve
 * cannot be: there is one bundle and thousands of stores, so they are CSS custom
 * properties written onto an element at runtime. This module is the only thing
 * that writes them.
 *
 * WHERE THIS DOES NOT LIVE: packages/core. That package is compiled with no DOM
 * lib precisely so it stays isomorphic, and this touches the DOM. The theme
 * *compiler* — eight inputs to these nine values, with contrast enforcement — is
 * core's job at milestone 13. This file only applies what the compiler produced,
 * and it must never derive a value of its own: the API re-runs the compiler on
 * publish and rejects any token set that is not its own output, which is what
 * makes ThemeStudio's promise that no store can publish something unreadable
 * true.
 *
 * Applying to an element rather than only to :root is required by the design:
 * StorePreview shows one store's theme inside the merchant console, and
 * ThemeStudio shows a live preview — both are subtrees themed differently from
 * the page around them. tokens.css uses `@theme inline` so that works; see the
 * comment there.
 */

/**
 * The twelve, in the order the theme compiler emits them.
 *
 * NINE OF THEM ARE WHAT THEMESTUDIO SHOWS a merchant — its own list, its own labels, and its
 * summary reads "9 colors from your 1 pick". The last three are ones its makeTheme() also
 * derives and its preview also uses: the text colour for a sale badge, and the two for the top
 * banner. They arrived at milestone 13, when the compiler was transcribed from the board.
 *
 * They belong here rather than being worked out by a component for the reason the header gives:
 * this file must never derive a value, and a component computing its own badge text colour is a
 * second theme engine.
 */
export const STORE_TOKEN_NAMES = [
  'bg',
  'surface',
  'text',
  'muted',
  'border',
  'primary',
  'onPrimary',
  'accent',
  'tint',
  'onAccent',
  'heroBg',
  'heroText',
] as const;

export type StoreTokenName = (typeof STORE_TOKEN_NAMES)[number];

/** A complete, compiled theme. Partial themes are not a thing: a published theme
 *  always carries all twelve, and half of one would render as a mix of two stores. */
export type StoreTheme = Readonly<Record<StoreTokenName, string>>;

/** Token name to the custom property tokens.css reads. */
const CSS_VARIABLE: Readonly<Record<StoreTokenName, string>> = {
  bg: '--store-bg',
  surface: '--store-surface',
  text: '--store-text',
  muted: '--store-muted',
  border: '--store-border',
  primary: '--store-primary',
  onPrimary: '--store-on-primary',
  accent: '--store-accent',
  tint: '--store-tint',
  onAccent: '--store-on-accent',
  heroBg: '--store-hero-bg',
  heroText: '--store-hero-text',
};

/** #rgb or #rrggbb. The compiler emits hex; anything else is a bug upstream, and
 *  a value with a brace or a semicolon in it has no business reaching a
 *  stylesheet even though setProperty cannot be escaped out of. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export type ThemeRejection = { readonly token: StoreTokenName; readonly value: unknown; readonly reason: string };

export type ApplyResult = {
  readonly applied: readonly StoreTokenName[];
  readonly rejected: readonly ThemeRejection[];
};

/**
 * Write a compiled theme onto `target`.
 *
 * Never throws, and never applies a value it does not recognise. A bad theme must
 * degrade to the platform default in tokens.css, not take a store's shopfront
 * offline — so a rejected token is left unset and reported, and the caller
 * decides whether that is worth surfacing.
 */
export function applyStoreTheme(
  theme: StoreTheme,
  target: HTMLElement = document.documentElement,
): ApplyResult {
  const applied: StoreTokenName[] = [];
  const rejected: ThemeRejection[] = [];

  for (const token of STORE_TOKEN_NAMES) {
    const value = theme[token];
    if (typeof value !== 'string' || !HEX.test(value)) {
      rejected.push({ token, value, reason: 'not a #rgb or #rrggbb colour' });
      continue;
    }
    target.style.setProperty(CSS_VARIABLE[token], value);
    applied.push(token);
  }

  return { applied, rejected };
}

/** Remove the overrides, falling back to the platform default in tokens.css. */
export function clearStoreTheme(target: HTMLElement = document.documentElement): void {
  for (const token of STORE_TOKEN_NAMES) {
    target.style.removeProperty(CSS_VARIABLE[token]);
  }
}

/**
 * What is actually in effect on `target`, resolved through the cascade — so this
 * returns the platform default where nothing has been applied, which is what
 * makes it useful for a test or a bug report rather than just an echo.
 */
export function readStoreTheme(target: HTMLElement = document.documentElement): StoreTheme {
  const computed = getComputedStyle(target);
  const out: Record<StoreTokenName, string> = {
    bg: '', surface: '', text: '', muted: '', border: '',
    primary: '', onPrimary: '', accent: '', tint: '',
    onAccent: '', heroBg: '', heroText: '',
  };
  for (const token of STORE_TOKEN_NAMES) {
    out[token] = computed.getPropertyValue(CSS_VARIABLE[token]).trim();
  }
  return out;
}

export type ParseResult =
  | { readonly ok: true; readonly theme: StoreTheme }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * The boundary. A theme arrives as JSON from the API, which means it arrives as
 * `unknown` — §2.5 makes the server authoritative, and that is only worth
 * anything if the client stops trusting the shape of what it is handed.
 */
export function parseStoreTheme(value: unknown): ParseResult {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, errors: ['theme is not an object'] };
  }
  const source = value as Record<string, unknown>;
  const errors: string[] = [];
  const draft: Record<StoreTokenName, string> = {
    bg: '', surface: '', text: '', muted: '', border: '',
    primary: '', onPrimary: '', accent: '', tint: '',
    onAccent: '', heroBg: '', heroText: '',
  };

  for (const token of STORE_TOKEN_NAMES) {
    const candidate = source[token];
    if (candidate === undefined) {
      errors.push(`${token} is missing`);
    } else if (typeof candidate !== 'string' || !HEX.test(candidate)) {
      errors.push(`${token} is not a #rgb or #rrggbb colour`);
    } else {
      draft[token] = candidate;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, theme: draft };
}

// ---------------------------------------------------------------------------
// The store's LOOK — shape, heading font, card treatment. Milestone 25.
// ---------------------------------------------------------------------------
//
// The palette (above) is colour; this is everything else ThemeStudio's inputs say. §2.2: the runtime never derives a
// value — so these are TABLES, transcribed from StorePreview.dc.html's own SHAPES and FONTS maps, and what a store
// chose is a key into them. A merchant's input never reaches a stylesheet as text; only a table value does.
//
// SET ON THE SUBTREE, NEVER ON :root, and never in the console. tokens.css defines `rounded-card`, `rounded-pill`,
// `font-display` and the rest as `var(--store-…, <platform default>)`, so where nothing sets these the console is
// exactly what it was — and the storefront and the studio's preview, which do, are the only places that change.

import type { CardTreatment, HeadingFont, Shape } from '../app/core.ts';

type Radii = { chip: string; control: string; card: string; pill: string };

// Board: sharp 2/2/2, soft card 14 · button 10 · chip 8, round card 24 · button and chip fully round. `control` is a
// BUTTON's radius on the board; it is also what a field uses here, so round is 22px — a pill at the kit's 44px height,
// without turning every text field into a capsule it was never drawn as.
const SHAPE: Readonly<Record<Shape, Radii>> = {
  sharp: { chip: '2px', control: '2px', card: '2px', pill: '2px' },
  soft: { chip: '8px', control: '10px', card: '14px', pill: '8px' },
  round: { chip: '999px', control: '22px', card: '24px', pill: '999px' },
};

type Face = { family: string; style: string; transform: string };

const FONT: Readonly<Record<HeadingFont, Face>> = {
  modern: { family: "'Bricolage Grotesque', 'Figtree', sans-serif", style: 'normal', transform: 'none' },
  editorial: { family: "'Fraunces', Georgia, serif", style: 'normal', transform: 'none' },
  sport: { family: "'Archivo', 'Figtree', sans-serif", style: 'italic', transform: 'uppercase' },
  classic: { family: "'DM Serif Display', Georgia, serif", style: 'normal', transform: 'none' },
};

export type StoreLookInputs = { shape: Shape; headingFont: HeadingFont; cardTreatment: CardTreatment };

/** The custom properties a look sets, as a plain object — usable as a React `style` (SSR-safe) or via setProperty. */
export function storeLookVariables(look: StoreLookInputs, dark: boolean): Record<string, string> {
  const r = SHAPE[look.shape];
  const f = FONT[look.headingFont];
  // Card treatment: raised has a shadow and no edge; outlined has the store's border and no shadow; flat has neither
  // and sits on a surface nudged toward the tint. `color-mix` rather than a computed hex: the theme engine owns colours.
  const card: Record<CardTreatment, Record<string, string>> = {
    shadow: { '--store-card-edge': 'transparent', '--store-card-bg': 'var(--store-surface)', '--store-card-shadow': `0 8px 20px rgb(0 0 0 / ${dark ? '0.45' : '0.10'})` },
    outlined: { '--store-card-edge': 'var(--store-border)', '--store-card-bg': 'var(--store-surface)', '--store-card-shadow': 'none' },
    flat: { '--store-card-edge': 'transparent', '--store-card-bg': 'color-mix(in srgb, var(--store-surface) 50%, var(--store-tint))', '--store-card-shadow': 'none' },
  };
  return {
    '--store-radius-chip': r.chip,
    '--store-radius-control': r.control,
    '--store-radius-card': r.card,
    '--store-radius-pill': r.pill,
    '--store-font-display': f.family,
    '--store-heading-style': f.style,
    '--store-heading-transform': f.transform,
    ...card[look.cardTreatment],
  };
}

export function applyStoreLook(look: StoreLookInputs, dark: boolean, target: HTMLElement): void {
  for (const [name, value] of Object.entries(storeLookVariables(look, dark))) target.style.setProperty(name, value);
}

export function clearStoreLook(look: StoreLookInputs, target: HTMLElement): void {
  for (const name of Object.keys(storeLookVariables(look, false))) target.style.removeProperty(name);
}

/** The palette as a `style` object, for a preview that must render without an effect. Same values as applyStoreTheme. */
export function storeThemeVariables(theme: StoreTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of STORE_TOKEN_NAMES) {
    const value = theme[token];
    if (typeof value === 'string' && HEX.test(value)) out[CSS_VARIABLE[token]] = value;
  }
  return out;
}
