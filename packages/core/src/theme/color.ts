// packages/core/src/theme/color.ts — milestone 13.
//
// The colour arithmetic the theme compiler is built from, transcribed from
// `project/ThemeStudio.dc.html`'s own script block. THE BOARD IS THE SPECIFICATION, not a
// sketch of one: it contains a working `makeTheme()`, and `ShoeStores.dc.html` renders three
// stores with it. Milestone 13's done-when is that those three are reproduced, so these
// functions must agree with the board's to the last rounded byte — which
// `test/fixtures/theme-golden.json` pins, 535 cases generated from the board itself.
//
// TWO PLACES WHERE THE OBVIOUS IMPROVEMENT WOULD BE A BUG:
//
//   * `luminance` uses the 0.03928 sRGB threshold. The current WCAG text says 0.04045. The
//     board uses 0.03928 (as WCAG 2.0 itself did), and the difference moves ratios in the
//     fourth decimal — enough to flip a 4.4999 nudge loop by one iteration and change a
//     published colour. Matching the board matters more than matching the erratum.
//   * `mix` interpolates in gamma-encoded sRGB, not linear light. Linear would be more
//     perceptually correct and would produce different greys for `muted`, `border` and
//     `tint` — i.e. a different palette from the one the designer approved.
//
// Both are marked rather than fixed, because the thing being built is "the palettes on the
// canvas", not "the best palettes".

/** [r, g, b], each 0–255. */
export type Rgb = readonly [number, number, number];

/** [hue 0–360, saturation 0–100, lightness 0–100]. */
export type Hsl = readonly [number, number, number];

/**
 * Parses a colour to RGB, falling back to the platform brand for anything unparseable.
 *
 * FALLS BACK RATHER THAN THROWING, exactly as the board does. A merchant mid-keystroke has
 * typed `#E45` and will type `72E` next; a compiler that threw would make the live preview
 * flicker an error instead of a colour. Validation belongs at the edge — the API rejects a
 * malformed input before it is stored — and `#1D6B47` is the platform default in tokens.css.
 */
export function toRgb(value: string | null | undefined): Rgb {
  let hex = String(value ?? '').replace('#', '');
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) hex = '1D6B47';
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/** RGB to `#RRGGBB`, upper case, clamped and rounded — the form every token is stored in. */
export function toHex(rgb: Rgb): string {
  return (
    '#' +
    rgb
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  );
}

export function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }

  return [h, s * 100, l * 100];
}

/** HSL to hex. Hue wraps; saturation and lightness are taken as given. */
export function hsl(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number): number => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number): number => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/**
 * WCAG relative luminance. See the header on the 0.03928 threshold: it is the board's, and
 * changing it to the current 0.04045 would move published colours.
 */
export function luminance(color: string): number {
  const weights = [0.2126, 0.7152, 0.0722];
  return toRgb(color)
    .map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    })
    .reduce((acc, v, i) => acc + v * (weights[i] ?? 0), 0);
}

/** WCAG contrast ratio, 1–21. Order-independent. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `t` of the way from `a` to `b`, in gamma-encoded sRGB. See the header. */
export function mix(a: string, b: string, t: number): string {
  const from = toRgb(a);
  const to = toRgb(b);
  return toHex([
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ]);
}

/** Shifts lightness by `delta` points, clamped to 0–100. Hue and saturation are kept. */
export function shiftLightness(color: string, delta: number): string {
  const [h, s, l] = rgbToHsl(toRgb(color));
  return hsl(h, s, Math.max(0, Math.min(100, l + delta)));
}

/** Whichever of `light` and `dark` reads better on `background`. Ties go to `light`. */
export function pickOn(background: string, dark: string, light: string): string {
  return contrast(background, light) >= contrast(background, dark) ? light : dark;
}
