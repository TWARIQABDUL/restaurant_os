// packages/core/src/theme/compile.ts — milestone 13.
//
// Eight inputs → twelve colours + a contrast report + a plain-language list of what it
// adjusted. §3: "The API must re-run the compiler on publish and reject any token set that is
// not its own output — otherwise ThemeStudio's promise that 'no store can publish something
// unreadable' is not true."
//
// THIS IS A TRANSCRIPTION, NOT A DESIGN. `project/ThemeStudio.dc.html` contains a working
// `makeTheme()` and `ShoeStores.dc.html` renders three stores through it; the done-when is that
// those three come out the same. So the order of operations below is the board's, including the
// parts that look accidental — and where one of those is load-bearing, it says so.
//
// WHAT WAS MEASURED, not assumed: over 59,136 combinations — a 6×6×6 RGB grid of brands plus the
// board's own eight, across three moods, four harmonies, eleven accent choices (including none,
// white, black and mid-grey) and both banner styles — every one of the five 4.5:1 text checks
// passes. The guarantee holds; it is not aspirational. The sweep is in the test suite.

import { contrast, hsl, mix, pickOn, rgbToHsl, shiftLightness, toHex, toRgb } from './color.ts';
import type { CompiledTheme, ContrastCheck, Harmony, ThemeInputs } from './types.ts';

/** The board's nudge budget. 40 steps of 2 lightness points reaches either extreme from anywhere. */
const MAX_NUDGES = 40;

/** Body, muted, button, badge and banner text. */
const TEXT_CONTRAST = 4.5;

/** A button against the page. Below this the button is outlined instead. */
const BUTTON_CONTRAST = 3;

/** Degrees of hue to rotate for each harmony. `mono` is handled separately. */
const HARMONY_OFFSET: Readonly<Record<Exclude<Harmony, 'mono'>, number>> = {
  complementary: 180,
  analogous: 40,
  split: 150,
};

/**
 * Nudges a fill until the text on it is readable, and reports it if it had to.
 *
 * `on` IS CHOSEN ONCE, BEFORE THE LOOP, AND NOT RECHOSEN — which is the board's behaviour and
 * is load-bearing. Re-picking each iteration would let the algorithm oscillate: darken the fill
 * a step, notice dark text now reads better, switch, lighten it back. Committing to the better
 * of the two and then moving the fill toward it always terminates.
 */
function fitFill(
  fill: string,
  dark: string,
  light: string,
  notes: string[],
  label: string,
): { fill: string; on: string } {
  let current = fill;
  const on = pickOn(current, dark, light);
  let nudges = 0;

  while (contrast(current, on) < TEXT_CONTRAST && nudges < MAX_NUDGES) {
    current = shiftLightness(current, on === light ? -2 : 2);
    nudges += 1;
  }

  if (nudges > 0) {
    notes.push(
      `${label}: nudged ${fill} to ${current} so ${on === light ? 'white' : 'dark'} text stays readable.`,
    );
  }

  return { fill: current, on };
}

function check(
  label: string,
  foreground: string,
  background: string,
  required: number,
  satisfiedByOutline = false,
): ContrastCheck {
  const ratio = contrast(foreground, background);
  return {
    label,
    foreground,
    background,
    ratio,
    required,
    pass: ratio >= required,
    satisfiedByOutline,
  };
}

/**
 * Compiles a theme.
 *
 * Pure and total: every input produces a theme, because a merchant typing into a colour field
 * produces a stream of half-written values and the live preview has to render each one. An
 * unparseable colour becomes the platform brand (see toRgb), not an exception.
 */
export function compileTheme(inputs: ThemeInputs): CompiledTheme {
  const notes: string[] = [];

  const brand = toHex(toRgb(inputs.brand));
  const [hue, saturation] = rgbToHsl(toRgb(brand));

  // --- the page -----------------------------------------------------------------
  //
  // Light tints the page with a washed-out trace of the brand hue; warm ignores the brand hue
  // entirely and uses a fixed paper-like amber; dark keeps the hue but caps saturation so a
  // vivid brand does not make the whole page glow.
  let bg: string;
  let surface: string;
  let text: string;
  let isDark = false;

  if (inputs.mood === 'dark') {
    bg = hsl(hue, Math.min(saturation, 22), 8);
    surface = hsl(hue, Math.min(saturation, 20), 13);
    text = hsl(hue, 12, 94);
    isDark = true;
  } else if (inputs.mood === 'warm') {
    bg = hsl(38, 40, 94);
    surface = hsl(40, 45, 98);
    text = hsl(25, 25, 13);
  } else {
    bg = hsl(hue, Math.min(saturation, 30) * 0.6, 97);
    surface = '#FFFFFF';
    text = hsl(hue, 18, 11);
  }

  // The two candidates for text on a coloured fill. `dark` is not pure black: it carries the
  // brand hue, which is what keeps a themed store from looking like a default one.
  const light = '#FFFFFF';
  const dark = hsl(hue, 18, 10);

  // --- buttons ------------------------------------------------------------------
  const fitted = fitFill(brand, dark, light, notes, 'Buttons');
  let primary = fitted.fill;
  let onPrimary = fitted.on;

  // On a dark page a dark brand disappears. Brighten it until it separates from the page, then
  // re-pick the text — brightening can flip which of white and dark reads better on it.
  if (isDark && contrast(primary, bg) < BUTTON_CONTRAST) {
    let nudges = 0;
    while (contrast(primary, bg) < BUTTON_CONTRAST && nudges < MAX_NUDGES) {
      primary = shiftLightness(primary, 3);
      nudges += 1;
    }
    onPrimary = pickOn(primary, dark, light);
    notes.push('Buttons: brightened to stand out on the dark background.');
  }

  // --- the accent ---------------------------------------------------------------
  let rawAccent: string;
  if (inputs.accent !== null && inputs.accent !== '') {
    rawAccent = toHex(toRgb(inputs.accent));
  } else if (inputs.harmony === 'mono') {
    // Same hue, pushed 24 points of lightness away from the brand so the two are told apart.
    const brandLightness = rgbToHsl(toRgb(brand))[2];
    rawAccent = hsl(
      hue,
      Math.max(saturation, 50),
      brandLightness > 45 ? brandLightness - 24 : brandLightness + 24,
    );
  } else {
    // Rotated hue at a fixed mid lightness, so the accent is vivid whatever the brand's own
    // lightness is. The saturation floor of 55 stops a near-grey brand producing a near-grey
    // accent; the ceiling of 80 stops a fully saturated one producing something fluorescent.
    const offset = HARMONY_OFFSET[inputs.harmony] ?? HARMONY_OFFSET.complementary;
    rawAccent = hsl(hue + offset, Math.max(55, Math.min(saturation, 80)), 48);
  }

  const fittedAccent = fitFill(rawAccent, dark, light, notes, 'Sale badges');
  const accent = fittedAccent.fill;
  const onAccent = fittedAccent.on;

  // --- the greys ----------------------------------------------------------------
  //
  // Muted text starts 45% of the way from the body text toward the page and is walked back
  // toward the text colour until it is readable. At k = 0 it IS the text colour, which passes,
  // so this terminates whatever the mood.
  let k = 0.45;
  let muted = mix(text, bg, k);
  while (contrast(muted, bg) < TEXT_CONTRAST && k > 0) {
    k -= 0.05;
    muted = mix(text, bg, k);
  }

  const border = mix(text, bg, isDark ? 0.8 : 0.86);
  const tint = mix(primary, bg, isDark ? 0.78 : 0.86);

  // --- the banner ---------------------------------------------------------------
  let heroBg: string;
  let heroText: string;
  if (inputs.hero === 'fill') {
    heroBg = primary;
    heroText = onPrimary;
  } else if (inputs.mood === 'warm') {
    heroBg = mix(accent, bg, 0.8);
    heroText = text;
  } else {
    heroBg = tint;
    heroText = text;
  }
  // A single fallback rather than a loop, which is the board's. The sweep in the test suite is
  // what says that is enough: across 59,136 combinations the banner check never fails.
  if (contrast(heroBg, heroText) < TEXT_CONTRAST) {
    heroText = pickOn(heroBg, dark, light);
  }

  // --- the report ---------------------------------------------------------------
  const outline = contrast(primary, bg) < BUTTON_CONTRAST;
  if (outline) {
    notes.push('Buttons: your color is close to the page color, so buttons get a thin outline.');
  }

  const colors = {
    bg,
    surface,
    text,
    muted,
    border,
    primary,
    onPrimary,
    accent,
    onAccent,
    tint,
    heroBg,
    heroText,
  };

  return {
    inputs,
    colors,
    dark: isDark,
    outline,
    // ThemeStudio's six checks, its labels, its order.
    checks: [
      check('Body text', text, bg, TEXT_CONTRAST),
      check('Muted text', muted, bg, TEXT_CONTRAST),
      check('Button text', onPrimary, primary, TEXT_CONTRAST),
      check('Sale badge text', onAccent, accent, TEXT_CONTRAST),
      check('Banner text', heroText, heroBg, TEXT_CONTRAST),
      check('Buttons vs page', primary, bg, BUTTON_CONTRAST, outline),
    ],
    notes,
  };
}

/**
 * Is this theme safe to publish?
 *
 * The gate §3 demands. A theme is publishable when every text check passes; the button-against-
 * page check may fail, because that is the case the outline exists for and the compiler has
 * already recorded it.
 */
export function isPublishable(theme: CompiledTheme): boolean {
  return theme.checks.every((c) => c.pass || c.satisfiedByOutline);
}

/** The checks that failed and are not excused by an outline. Empty for a publishable theme. */
export function failingChecks(theme: CompiledTheme): ContrastCheck[] {
  return theme.checks.filter((c) => !c.pass && !c.satisfiedByOutline);
}
