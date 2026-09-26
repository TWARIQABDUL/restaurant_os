// packages/core/test/theme.test.ts — milestone 13.
//
// Milestone 13's done-when has three clauses, and the first two are here:
//
//   "The three stores in ShoeStores reproduced from three input sets."
//   "No input combination publishes something unreadable."
//
// The first is checked against a FROZEN GOLDEN TABLE generated from the board's own
// `makeTheme()` — 535 cases, not three — so what is asserted is the specification rather than
// my reading of it. The second is swept, not sampled.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  HARMONIES,
  MOODS,
  compileTheme,
  contrast,
  failingChecks,
  isPublishable,
  mix,
  toHex,
  toRgb,
} from '../src/index.ts';
import type { CompiledColors, Harmony, Hero, Mood, ThemeInputs } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

type GoldenCase = {
  label: string;
  input: { brand: string; accent: string | null; harmony: Harmony | null; mood: Mood; hero: Hero };
  expected: CompiledColors & { dark: boolean; outline: boolean; notes: string[] };
};

const golden = JSON.parse(
  readFileSync(path.join(HERE, 'fixtures/theme-golden.json'), 'utf8'),
) as { generatedFrom: string; cases: GoldenCase[] };

/**
 * The golden file records only the five inputs that affect colour. The other three — shape,
 * heading font, card treatment — are carried through the compiler untouched, which
 * `describe('the non-colour inputs')` below asserts separately.
 */
function inputsOf(c: GoldenCase): ThemeInputs {
  return {
    brand: c.input.brand,
    accent: c.input.accent,
    // The board treats a missing harmony as complementary, and the golden file stores null for
    // the manual-accent cases where harmony is genuinely irrelevant.
    harmony: c.input.harmony ?? 'complementary',
    mood: c.input.mood,
    shape: 'round',
    headingFont: 'sport',
    cardTreatment: 'shadow',
    hero: c.input.hero,
  };
}

const COLOR_KEYS: (keyof CompiledColors)[] = [
  'bg',
  'surface',
  'text',
  'muted',
  'border',
  'primary',
  'onPrimary',
  'accent',
  'onAccent',
  'tint',
  'heroBg',
  'heroText',
];

// ===========================================================================
describe('the golden table — the board is the specification', () => {
  it('has the shape and provenance it claims', () => {
    assert.match(golden.generatedFrom, /ThemeStudio\.dc\.html/);
    assert.ok(golden.cases.length >= 500, `${golden.cases.length} cases`);
  });

  it('reproduces every one of the 535 cases exactly', () => {
    const mismatches: string[] = [];

    for (const c of golden.cases) {
      const actual = compileTheme(inputsOf(c));

      for (const key of COLOR_KEYS) {
        if (actual.colors[key] !== c.expected[key]) {
          mismatches.push(
            `${c.label} ${JSON.stringify(c.input)} — ${key}: got ${actual.colors[key]}, want ${c.expected[key]}`,
          );
        }
      }
      if (actual.dark !== c.expected.dark) mismatches.push(`${c.label} — dark`);
      if (actual.outline !== c.expected.outline) mismatches.push(`${c.label} — outline`);
      if (JSON.stringify(actual.notes) !== JSON.stringify(c.expected.notes)) {
        mismatches.push(
          `${c.label} ${JSON.stringify(c.input)} — notes: got ${JSON.stringify(actual.notes)}, want ${JSON.stringify(c.expected.notes)}`,
        );
      }
    }

    assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} mismatches`);
  });

  it('covers the paths that would otherwise be untested', () => {
    // A golden table that never exercises the nudge loops or the dark-mood brighten would pass
    // for an implementation that omitted them.
    const withNotes = golden.cases.filter((c) => c.expected.notes.length > 0);
    const outlined = golden.cases.filter((c) => c.expected.outline);
    const dark = golden.cases.filter((c) => c.expected.dark);
    const nudged = golden.cases.filter((c) => c.expected.notes.some((n) => n.includes('nudged')));
    const brightened = golden.cases.filter((c) =>
      c.expected.notes.some((n) => n.includes('brightened')),
    );

    assert.ok(withNotes.length > 100, `${withNotes.length} cases produce notes`);
    assert.ok(outlined.length > 50, `${outlined.length} outlined`);
    assert.ok(dark.length > 50, `${dark.length} dark`);
    assert.ok(nudged.length > 10, `${nudged.length} nudged a fill`);
    assert.ok(brightened.length > 10, `${brightened.length} brightened on dark`);
  });
});

// ===========================================================================
describe('the three stores in ShoeStores', () => {
  // Spelled out rather than only read from the table, because this IS the done-when and it
  // should be readable as such.
  const THREE: { name: string; inputs: ThemeInputs; expect: Partial<CompiledColors> }[] = [
    {
      name: 'Kigali Kicks — street sneakers, light · round · sport · raised',
      inputs: {
        brand: '#E4572E',
        accent: '#F4D35E',
        harmony: 'complementary',
        mood: 'light',
        shape: 'round',
        headingFont: 'sport',
        cardTreatment: 'shadow',
        hero: 'fill',
      },
      expect: { bg: '#F9F7F6', surface: '#FFFFFF', primary: '#E4572E', accent: '#F4D35E', tint: '#F6E1DA' },
    },
    {
      name: 'Ikirenge Atelier — handmade leather, warm · sharp · classic · outlined',
      inputs: {
        brand: '#6B3E26',
        accent: null,
        harmony: 'analogous',
        mood: 'warm',
        shape: 'sharp',
        headingFont: 'classic',
        cardTreatment: 'outlined',
        hero: 'soft',
      },
      expect: { bg: '#F6F1EA', surface: '#FCFBF8', primary: '#6B3E26', accent: '#BCBE37', heroBg: '#EAE7C6' },
    },
    {
      name: 'Run Rwanda — running gear, dark · soft · modern · flat',
      inputs: {
        brand: '#C6F432',
        accent: null,
        harmony: 'split',
        mood: 'dark',
        shape: 'soft',
        headingFont: 'modern',
        cardTreatment: 'flat',
        hero: 'fill',
      },
      expect: { bg: '#171910', surface: '#25281B', primary: '#C6F432', accent: '#184CDC', tint: '#3E4917' },
    },
  ];

  for (const store of THREE) {
    it(store.name, () => {
      const theme = compileTheme(store.inputs);
      for (const [key, value] of Object.entries(store.expect)) {
        assert.equal(theme.colors[key as keyof CompiledColors], value, key);
      }
      assert.equal(isPublishable(theme), true);
      assert.deepEqual(failingChecks(theme), []);
    });
  }

  it('produces three palettes that are nothing alike', () => {
    // The board's headline: "Three shoe stores. Same parts. Nothing alike."
    const palettes = THREE.map((s) => JSON.stringify(compileTheme(s.inputs).colors));
    assert.equal(new Set(palettes).size, 3);
  });

  it("Kigali Kicks' buttons use DARK text, which is the interesting one", () => {
    // Orange #E4572E is too light for white text at 4.5:1, so the compiler picks the dark
    // candidate — without nudging the brand colour at all. The merchant keeps the orange they
    // chose. ShoeStores says the same thing about Run Rwanda's lime in prose.
    const kicks = compileTheme(THREE[0]!.inputs);
    assert.equal(kicks.colors.primary, '#E4572E', 'the brand colour is untouched');
    assert.notEqual(kicks.colors.onPrimary, '#FFFFFF');
    assert.ok(contrast(kicks.colors.onPrimary, kicks.colors.primary) >= 4.5);
    assert.deepEqual(kicks.notes, [], 'and nothing had to be adjusted, so there is nothing to report');

    const run = compileTheme(THREE[2]!.inputs);
    assert.notEqual(run.colors.onPrimary, '#FFFFFF', 'lime is too light for white text too');
    assert.ok(contrast(run.colors.onPrimary, run.colors.primary) >= 4.5);
  });
});

// ===========================================================================
describe('no input combination publishes something unreadable', () => {
  it('holds across a 6x6x6 brand grid times every other choice', () => {
    // 59,136 combinations. Swept rather than sampled, because the claim is universal.
    const accents: (string | null)[] = [
      null,
      '#F4D35E',
      '#2EC4B6',
      '#FF6B6B',
      '#7B61FF',
      '#F28C28',
      '#1F437F',
      '#E8C7A0',
      '#FFFFFF',
      '#000000',
      '#808080',
    ];
    const brands: string[] = [];
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) brands.push(toHex([r, g, b]));
      }
    }
    for (const extra of ['#E4572E', '#1D6B47', '#1F437F', '#6B3E26', '#C6F432', '#9D174D', '#F4D35E', '#17160F']) {
      if (!brands.includes(extra)) brands.push(extra);
    }

    let swept = 0;
    const failures: string[] = [];

    for (const brand of brands) {
      for (const mood of MOODS) {
        for (const harmony of HARMONIES) {
          for (const accent of accents) {
            for (const hero of ['soft', 'fill'] as Hero[]) {
              const theme = compileTheme({
                brand,
                accent,
                harmony,
                mood,
                shape: 'round',
                headingFont: 'sport',
                cardTreatment: 'shadow',
                hero,
              });
              swept += 1;
              if (!isPublishable(theme)) {
                failures.push(
                  `${brand} ${mood} ${harmony} ${accent ?? 'auto'} ${hero}: ` +
                    failingChecks(theme)
                      .map((c) => `${c.label} ${c.ratio.toFixed(2)}:1`)
                      .join(', '),
                );
              }
            }
          }
        }
      }
    }

    assert.ok(swept > 50_000, `${swept} combinations`);
    assert.deepEqual(failures.slice(0, 10), [], `${failures.length} unreadable themes out of ${swept}`);
  });

  it('never lands on the 3:1 outline boundary, which is what keeps two implementations agreeing', () => {
    // V015 enforces `needs_outline = (contrast(primary, bg) < 3.0)` in SQL. Two implementations of
    // WCAG contrast — this one and the plpgsql one — agree to about one ulp (3.6e-16 measured), so
    // a theme landing within that of exactly 3.0 would have the database refuse what the compiler
    // approved: an intermittent failure on a merchant pressing Apply.
    //
    // It does not happen, and the reason is that colours are 8-bit: contrast ratios are quantised,
    // and the nearest any compiled theme gets to 3.0 is ~9e-4 — nine orders of magnitude of slack.
    // The dark-mood brighten loop is what makes this worth asserting rather than assuming, because
    // it stops the moment the ratio reaches 3 and therefore lands deliberately near the boundary.
    const brands: string[] = [];
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) brands.push(toHex([r, g, b]));
      }
    }

    let closest = Number.POSITIVE_INFINITY;
    let at = '';
    for (const brand of brands) {
      for (const mood of MOODS) {
        for (const harmony of HARMONIES) {
          for (const hero of ['soft', 'fill'] as Hero[]) {
            const theme = compileTheme({
              brand,
              accent: null,
              harmony,
              mood,
              shape: 'round',
              headingFont: 'sport',
              cardTreatment: 'shadow',
              hero,
            });
            const distance = Math.abs(contrast(theme.colors.primary, theme.colors.bg) - 3);
            if (distance < closest) {
              closest = distance;
              at = `${brand} ${mood} ${harmony} ${hero}`;
            }
          }
        }
      }
    }

    assert.ok(closest > 1e-9, `closest approach ${closest.toExponential(3)} at ${at}`);
  });

  it('holds for the degenerate colours a merchant can actually type', () => {
    for (const brand of ['#FFFFFF', '#000000', '#FFF', '#000', '#808080', 'not a colour', '', '#GGGGGG']) {
      for (const mood of MOODS) {
        const theme = compileTheme({
          brand,
          accent: null,
          harmony: 'complementary',
          mood,
          shape: 'round',
          headingFont: 'sport',
          cardTreatment: 'shadow',
          hero: 'fill',
        });
        assert.equal(isPublishable(theme), true, `${brand} / ${mood}`);
      }
    }
  });

  it('never throws, for any input, because a live preview renders every keystroke', () => {
    // '#E45' on the way to '#E4572E' must render, not error.
    for (const partial of ['#', '#E', '#E4', '#E45', '#E457', '#E4572', '#E4572E']) {
      assert.doesNotThrow(() =>
        compileTheme({
          brand: partial,
          accent: partial,
          harmony: 'mono',
          mood: 'light',
          shape: 'round',
          headingFont: 'sport',
          cardTreatment: 'shadow',
          hero: 'fill',
        }),
      );
    }
  });

  it('is deterministic — the same inputs compile to the same theme', () => {
    const inputs: ThemeInputs = {
      brand: '#9D174D',
      accent: null,
      harmony: 'split',
      mood: 'warm',
      shape: 'soft',
      headingFont: 'editorial',
      cardTreatment: 'flat',
      hero: 'soft',
    };
    assert.equal(JSON.stringify(compileTheme(inputs)), JSON.stringify(compileTheme(inputs)));
  });
});

// ===========================================================================
describe('the contrast report', () => {
  it('is ThemeStudio’s six checks, with its labels and its order', () => {
    const theme = compileTheme({
      brand: '#E4572E',
      accent: '#F4D35E',
      harmony: 'complementary',
      mood: 'light',
      shape: 'round',
      headingFont: 'sport',
      cardTreatment: 'shadow',
      hero: 'fill',
    });

    assert.deepEqual(
      theme.checks.map((c) => c.label),
      ['Body text', 'Muted text', 'Button text', 'Sale badge text', 'Banner text', 'Buttons vs page'],
    );
    assert.deepEqual(
      theme.checks.map((c) => c.required),
      [4.5, 4.5, 4.5, 4.5, 4.5, 3],
    );
  });

  it('excuses only the button-against-page check with an outline', () => {
    // A brand close to the page colour. The button check fails, the theme is still publishable,
    // and the note says what the merchant will see.
    const theme = compileTheme({
      brand: '#FAFAFA',
      accent: null,
      harmony: 'complementary',
      mood: 'light',
      shape: 'round',
      headingFont: 'sport',
      cardTreatment: 'shadow',
      hero: 'soft',
    });

    const buttonVsPage = theme.checks.find((c) => c.label === 'Buttons vs page');
    assert.ok(buttonVsPage);
    assert.equal(buttonVsPage.pass, false);
    assert.equal(buttonVsPage.satisfiedByOutline, true);
    assert.equal(theme.outline, true);
    assert.equal(isPublishable(theme), true);
    assert.ok(theme.notes.some((n) => n.includes('thin outline')));

    // And every text check still passes.
    for (const c of theme.checks.filter((x) => x.required === 4.5)) {
      assert.equal(c.pass, true, c.label);
    }
  });

  it('reports what it adjusted, in plain language, or says nothing', () => {
    const adjusted = compileTheme({
      brand: '#2E5AAC',
      accent: null,
      harmony: 'complementary',
      mood: 'dark',
      shape: 'round',
      headingFont: 'sport',
      cardTreatment: 'shadow',
      hero: 'fill',
    });
    assert.ok(adjusted.notes.length > 0);
    for (const note of adjusted.notes) {
      // A note is a sentence for a merchant, not a token name.
      assert.match(note, /^(Buttons|Sale badges): /);
      assert.match(note, /\.$/);
    }
  });
});

// ===========================================================================
describe('the non-colour inputs', () => {
  it('are carried through untouched and change no colour', () => {
    // shape, heading font and card treatment are the UI kit's to map (milestone 14). The
    // compiler must not quietly depend on them.
    const base: ThemeInputs = {
      brand: '#1D6B47',
      accent: null,
      harmony: 'complementary',
      mood: 'light',
      shape: 'sharp',
      headingFont: 'modern',
      cardTreatment: 'flat',
      hero: 'fill',
    };
    const reference = JSON.stringify(compileTheme(base).colors);

    for (const shape of ['sharp', 'soft', 'round'] as const) {
      for (const headingFont of ['modern', 'editorial', 'sport', 'classic'] as const) {
        for (const cardTreatment of ['flat', 'outlined', 'shadow'] as const) {
          const theme = compileTheme({ ...base, shape, headingFont, cardTreatment });
          assert.equal(JSON.stringify(theme.colors), reference);
          assert.equal(theme.inputs.shape, shape);
          assert.equal(theme.inputs.headingFont, headingFont);
          assert.equal(theme.inputs.cardTreatment, cardTreatment);
        }
      }
    }
  });

  it('hero is the one that does change a colour', () => {
    const base: ThemeInputs = {
      brand: '#1D6B47',
      accent: null,
      harmony: 'complementary',
      mood: 'light',
      shape: 'round',
      headingFont: 'sport',
      cardTreatment: 'shadow',
      hero: 'fill',
    };
    const fill = compileTheme({ ...base, hero: 'fill' });
    const soft = compileTheme({ ...base, hero: 'soft' });

    assert.equal(fill.colors.heroBg, fill.colors.primary);
    assert.equal(soft.colors.heroBg, soft.colors.tint);
    assert.notEqual(fill.colors.heroBg, soft.colors.heroBg);
  });
});

// ===========================================================================
describe('the platform default, which tokens.css already ships', () => {
  it('reproduces the tint the canvas published', () => {
    // §2.2: the platform default's tint is "#E4EDE9, computed with the canvas's own published
    // mix (12% brand, 88% white) so milestone 13's compiler can be checked against it."
    assert.equal(mix('#1D6B47', '#FFFFFF', 0.88), '#E4EDE9');
  });

  it('compiles the platform brand to a readable light theme', () => {
    const theme = compileTheme({
      brand: '#1D6B47',
      accent: null,
      harmony: 'complementary',
      mood: 'light',
      shape: 'soft',
      headingFont: 'modern',
      cardTreatment: 'flat',
      hero: 'soft',
    });
    assert.equal(theme.colors.surface, '#FFFFFF');
    assert.equal(theme.colors.primary, '#1D6B47', 'the brand needs no nudging');
    assert.equal(theme.colors.onPrimary, '#FFFFFF');
    assert.equal(isPublishable(theme), true);
  });
});

// ===========================================================================
describe('the colour arithmetic', () => {
  it('parses what a merchant types, and falls back rather than throwing', () => {
    assert.deepEqual(toRgb('#E4572E'), [228, 87, 46]);
    assert.deepEqual(toRgb('E4572E'), [228, 87, 46]);
    assert.deepEqual(toRgb('#abc'), [170, 187, 204]);
    // Anything unparseable becomes the platform brand — see the note in color.ts.
    assert.deepEqual(toRgb('nonsense'), toRgb('#1D6B47'));
    assert.deepEqual(toRgb(null), toRgb('#1D6B47'));
  });

  it('round-trips hex through rgb', () => {
    for (const hex of ['#000000', '#FFFFFF', '#E4572E', '#1D6B47', '#C6F432']) {
      assert.equal(toHex(toRgb(hex)), hex);
    }
  });

  it('computes the contrast ratios WCAG defines', () => {
    assert.equal(Math.round(contrast('#FFFFFF', '#000000') * 100) / 100, 21);
    assert.equal(contrast('#FFFFFF', '#FFFFFF'), 1);
    // Order does not matter.
    assert.equal(contrast('#E4572E', '#FFFFFF'), contrast('#FFFFFF', '#E4572E'));
  });

  it('mixes at both ends and in the middle', () => {
    assert.equal(mix('#000000', '#FFFFFF', 0), '#000000');
    assert.equal(mix('#000000', '#FFFFFF', 1), '#FFFFFF');
    assert.equal(mix('#000000', '#FFFFFF', 0.5), '#808080');
  });
});
