// packages/core/src/theme/types.ts — milestone 13.

/** Mood decides the page and card colours, and whether the theme is dark. */
export const MOODS = ['light', 'warm', 'dark'] as const;
export type Mood = (typeof MOODS)[number];

/** How the accent is derived when the merchant does not pick one. */
export const HARMONIES = ['complementary', 'analogous', 'split', 'mono'] as const;
export type Harmony = (typeof HARMONIES)[number];

/** Corner radius family. Not a colour — carried through for the UI kit (milestone 14). */
export const SHAPES = ['sharp', 'soft', 'round'] as const;
export type Shape = (typeof SHAPES)[number];

/** Heading typeface family. Also the UI kit's to map. */
export const HEADING_FONTS = ['modern', 'editorial', 'sport', 'classic'] as const;
export type HeadingFont = (typeof HEADING_FONTS)[number];

/** Product-card treatment. The UI kit's to map. */
export const CARD_TREATMENTS = ['flat', 'outlined', 'shadow'] as const;
export type CardTreatment = (typeof CARD_TREATMENTS)[number];

/**
 * The top banner. THE ONE NON-COLOUR INPUT THAT CHANGES A COLOUR: `fill` makes the banner the
 * button colour, `soft` makes it the tint (or, in a warm theme, the accent mixed into the page).
 */
export const HEROES = ['soft', 'fill'] as const;
export type Hero = (typeof HEROES)[number];

/**
 * The eight inputs a merchant chooses, from ThemeStudio's own controls.
 *
 * `accent` null means "let Vendlyfy pick" — the studio's accMode — and `harmony` then decides
 * how. A non-null accent makes harmony irrelevant, which is why the studio hides the harmony
 * picker in manual mode rather than leaving it to mean nothing.
 */
export type ThemeInputs = {
  brand: string;
  accent: string | null;
  harmony: Harmony;
  mood: Mood;
  shape: Shape;
  headingFont: HeadingFont;
  cardTreatment: CardTreatment;
  hero: Hero;
};

/**
 * The twelve colours the compiler derives.
 *
 * THE PLAN SAYS NINE, AND THE PLAN IS COUNTING WHAT THE MERCHANT SEES. ThemeStudio's own token
 * list shows nine — Page, Cards, Text, Muted text, Lines, Buttons, Button text, Highlights,
 * Selected — and its summary reads "9 colors from your 1 pick". But its `makeTheme` computes
 * three more that the preview needs and no component could safely derive for itself:
 * `onAccent` (text on a sale badge), `heroBg` and `heroText` (the top banner). They are part of
 * the compiled theme because §2.2 is explicit that the runtime "never derives a value" — the
 * client applies what the compiler produced, or it falls back to the platform default.
 */
export type CompiledColors = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  onPrimary: string;
  accent: string;
  onAccent: string;
  tint: string;
  heroBg: string;
  heroText: string;
};

/** The nine ThemeStudio shows a merchant, in its order, with its labels. */
export const MERCHANT_VISIBLE_TOKENS = [
  ['bg', 'Page'],
  ['surface', 'Cards'],
  ['text', 'Text'],
  ['muted', 'Muted text'],
  ['border', 'Lines'],
  ['primary', 'Buttons'],
  ['onPrimary', 'Button text'],
  ['accent', 'Highlights'],
  ['tint', 'Selected'],
] as const satisfies readonly (readonly [keyof CompiledColors, string])[];

/** One row of the contrast report — ThemeStudio's own six checks, in its order. */
export type ContrastCheck = {
  /** ThemeStudio's label, verbatim. */
  label: string;
  foreground: string;
  background: string;
  ratio: number;
  /** 4.5 for text, 3 for the button-against-page check. */
  required: number;
  pass: boolean;
  /**
   * Only the button-against-page check can fail and still be acceptable: a brand colour close
   * to the page colour gets an outlined button instead. Every other row failing would mean the
   * compiler did not do its job.
   */
  satisfiedByOutline: boolean;
};

export type CompiledTheme = {
  inputs: ThemeInputs;
  colors: CompiledColors;
  /** True for the dark mood. Components need it for shadows and image treatments. */
  dark: boolean;
  /** True when the button colour is within 3:1 of the page, so buttons need an outline. */
  outline: boolean;
  /** ThemeStudio's six checks. */
  checks: ContrastCheck[];
  /**
   * "A plain-language list of what it adjusted" (§3) — ThemeStudio's notes, verbatim, in the
   * order the compiler produces them. Empty when nothing needed fixing.
   */
  notes: string[];
};
