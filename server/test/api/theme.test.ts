// server/test/api/theme.test.ts — milestone 13.
//
// The publish gate, and the guarantee underneath it.
//
// The compiler itself is tested in packages/core, where it lives — 535 golden cases and a
// 59,136-combination sweep. What is tested here is the part that only exists on the server:
//
//   * A palette can enter the database ONLY as the compiler's output. There is no endpoint that
//     accepts a colour for a token, so "is this the compiler's own output" is true by
//     construction rather than by comparison.
//   * V015 refuses an unreadable PUBLISHED theme independently, in SQL, by any writer.
//   * Every theme the compiler calls publishable, the database accepts. Two implementations of
//     WCAG contrast — one in TypeScript, one in plpgsql — have to agree, and this is where that
//     is checked rather than argued.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { compileTheme } from '../../src/core.ts';
import type { ThemeInputs } from '../../src/core.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { STORE, USER, cleanup, seedFixtures } from './support.ts';

let api: Api;
let owner = '';

const SLUG = 'escalation-store-a';

/** Kigali Kicks, from ShoeStores.dc.html. */
const KICKS: ThemeInputs = {
  brand: '#E4572E',
  accent: '#F4D35E',
  harmony: 'complementary',
  mood: 'light',
  shape: 'round',
  headingFont: 'sport',
  cardTreatment: 'shadow',
  hero: 'fill',
};

/** Run Rwanda, the dark one. */
const RUN: ThemeInputs = {
  brand: '#C6F432',
  accent: null,
  harmony: 'split',
  mood: 'dark',
  shape: 'soft',
  headingFont: 'modern',
  cardTreatment: 'flat',
  hero: 'fill',
};

type Presented = {
  inputs: ThemeInputs;
  colors: Record<string, string>;
  dark: boolean;
  outline: boolean;
  visibleTokens: { token: string; label: string; hex: string }[];
  checks: { label: string; ratio: number; required: number; pass: boolean; satisfiedByOutline: boolean }[];
  notes: string[];
  publishable: boolean;
  publishedAt?: string;
  storedColors?: Record<string, string>;
  matchesCompiler?: boolean;
};

async function publicTheme(): Promise<{ status: number; body: Record<string, unknown>; etag: string | null }> {
  const res = await fetch(`${api.baseUrl}/api/storefront/${SLUG}/theme`);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body, etag: res.headers.get('etag') };
}

before(async () => {
  process.env.RATE_LIMIT_DISABLED = 'true';
  await seedFixtures();
  api = await boot();
  owner = tokenFor(USER.ownerA);
});

after(async () => {
  await api.close();
  await sql(`DELETE FROM store_themes WHERE store_id = ANY($1::uuid[])`, [[STORE.a, STORE.b]]);
  await cleanup();
  await closePool();
});

// ===========================================================================
describe('publishing a theme', () => {
  it('takes the eight inputs and returns the compiler’s own palette', async () => {
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, {
      token: owner,
      body: KICKS,
    });
    assert.equal(reply.status, 200);

    const published = (reply.body['published'] as Presented);
    const expected = compileTheme(KICKS);

    assert.deepEqual(published.colors, expected.colors);
    assert.equal(published.dark, false);
    assert.equal(published.publishable, true);
    assert.ok(published.publishedAt);

    // The nine ThemeStudio shows, with its labels.
    assert.equal(published.visibleTokens.length, 9);
    assert.deepEqual(
      published.visibleTokens.map((t) => t.label),
      ['Page', 'Cards', 'Text', 'Muted text', 'Lines', 'Buttons', 'Button text', 'Highlights', 'Selected'],
    );

    // And the six checks, in the studio's order.
    assert.deepEqual(
      published.checks.map((c) => c.label),
      ['Body text', 'Muted text', 'Button text', 'Sale badge text', 'Banner text', 'Buttons vs page'],
    );
  });

  it('IGNORES colours in the request body — the only way in is the compiler', async () => {
    // A client that sent its preview palette, or tried to smuggle an unreadable one, gets the
    // compiler's answer. This is the gate: not a comparison that could be got wrong, but an
    // endpoint with nowhere to put a colour.
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, {
      token: owner,
      body: {
        ...KICKS,
        colors: { bg: '#FFFFFF', text: '#FFFFFE', primary: '#FFFFFF', onPrimary: '#FFFFFF' },
        color_text: '#FFFFFE',
        dark: true,
        outline: true,
      },
    });
    assert.equal(reply.status, 200);

    const published = reply.body['published'] as Presented;
    assert.deepEqual(published.colors, compileTheme(KICKS).colors);
    assert.equal(published.dark, false, 'the flag came from the compiler, not the body');

    const { rows } = await sql<{ color_text: string; is_dark: boolean }>(
      `SELECT color_text, is_dark FROM store_themes WHERE store_id = $1 AND status = 'published'`,
      [STORE.a],
    );
    assert.notEqual(rows[0]?.color_text, '#FFFFFE');
    assert.equal(rows[0]?.is_dark, false);
  });

  it('stores the inputs beside the colours, so the studio can reopen them', async () => {
    const { rows } = await sql<{
      input_brand: string;
      input_accent: string | null;
      input_mood: string;
      input_hero: string;
    }>(
      `SELECT input_brand, input_accent, input_mood, input_hero
         FROM store_themes WHERE store_id = $1 AND status = 'published'`,
      [STORE.a],
    );
    assert.equal(rows[0]?.input_brand, '#E4572E');
    assert.equal(rows[0]?.input_accent, '#F4D35E');
    assert.equal(rows[0]?.input_mood, 'light');
    assert.equal(rows[0]?.input_hero, 'fill');
  });

  it('publishing again replaces it and moves published_at', async () => {
    const first = await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, {
      token: owner,
      body: KICKS,
    });
    const firstAt = (first.body['published'] as Presented).publishedAt;

    const second = await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, {
      token: owner,
      body: RUN,
    });
    const published = second.body['published'] as Presented;

    assert.equal(published.dark, true, 'the dark one is live now');
    assert.notEqual(published.publishedAt, firstAt);

    // One published row per store — V015's primary key.
    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM store_themes WHERE store_id = $1 AND status = 'published'`,
      [STORE.a],
    );
    assert.equal(rows[0]?.n, '1');
  });

  it('refuses an input outside the studio’s own controls', async () => {
    for (const bad of [
      { ...KICKS, mood: 'neon' },
      { ...KICKS, harmony: 'triadic' },
      { ...KICKS, hero: 'video' },
      { ...KICKS, shape: 'blobby' },
      { ...KICKS, cardTreatment: 'embossed' },
      { ...KICKS, headingFont: 'comic' },
    ]) {
      const reply = await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, {
        token: owner,
        body: bad,
      });
      assert.equal(reply.status, 400, JSON.stringify(bad).slice(0, 60));
    }
  });

  it('refuses a colour that is not one', async () => {
    for (const brand of ['red', '#GGGGGG', '#E45', 'E4572E', '']) {
      const reply = await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, {
        token: owner,
        body: { ...KICKS, brand },
      });
      assert.equal(reply.status, 400, brand);
    }

    const badAccent = await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, {
      token: owner,
      body: { ...KICKS, accent: 'gold' },
    });
    assert.equal(badAccent.status, 400);
  });

  it('accepts a lower-case colour and stores it upper-case', async () => {
    // V015's is_hex_color accepts upper case only, because that is what the compiler emits. The
    // studio sends what the merchant typed.
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, {
      token: owner,
      body: { ...KICKS, brand: '#e4572e', accent: '#f4d35e' },
    });
    assert.equal(reply.status, 200);

    const { rows } = await sql<{ input_brand: string; input_accent: string }>(
      `SELECT input_brand, input_accent FROM store_themes WHERE store_id = $1 AND status = 'published'`,
      [STORE.a],
    );
    assert.equal(rows[0]?.input_brand, '#E4572E');
    assert.equal(rows[0]?.input_accent, '#F4D35E');
  });
});

// ===========================================================================
describe('the database refuses an unreadable published theme by itself', () => {
  it('rejects white text on a white page, written directly', () => {
    // The route cannot produce this, which is the point: V015's guarantee must not depend on the
    // route being the only writer. Written as a raw INSERT, the way a migration or a psql prompt
    // would.
    return assert.rejects(
      () =>
        sql(
          `INSERT INTO store_themes (
               store_id, status, published_at,
               input_brand, input_accent, input_harmony, input_mood,
               input_shape, input_heading_font, input_card_treatment, input_hero,
               color_bg, color_surface, color_text, color_muted, color_border,
               color_primary, color_on_primary, color_accent, color_on_accent,
               color_tint, color_hero_bg, color_hero_text, is_dark, needs_outline
           ) VALUES ($1, 'published', now(),
               '#FFFFFF', NULL, 'complementary', 'light',
               'round', 'sport', 'shadow', 'fill',
               '#FFFFFF', '#FFFFFF', '#FFFFFE', '#FFFFFE', '#FFFFFF',
               '#FFFFFF', '#FFFFFE', '#FFFFFF', '#FFFFFE',
               '#FFFFFF', '#FFFFFF', '#FFFFFE', false, true)`,
          [STORE.b],
        ),
      (err: unknown) => {
        // 23514: a CHECK. And it names WHICH text is unreadable rather than "invalid theme".
        assert.equal((err as { code?: string }).code, '23514');
        assert.match(String((err as { constraint?: string }).constraint), /readable/);
        return true;
      },
    );
  });

  it('allows the same colours as a DRAFT, because a merchant is mid-decision', async () => {
    // V015 gates `published` only. The studio's job is to show what is wrong, not to refuse to
    // remember it.
    await sql(
      `INSERT INTO store_themes (
           store_id, status,
           input_brand, input_accent, input_harmony, input_mood,
           input_shape, input_heading_font, input_card_treatment, input_hero,
           color_bg, color_surface, color_text, color_muted, color_border,
           color_primary, color_on_primary, color_accent, color_on_accent,
           color_tint, color_hero_bg, color_hero_text, is_dark, needs_outline
       ) VALUES ($1, 'draft',
           '#FFFFFF', NULL, 'complementary', 'light',
           'round', 'sport', 'shadow', 'fill',
           '#FFFFFF', '#FFFFFF', '#FFFFFE', '#FFFFFE', '#FFFFFF',
           '#FFFFFF', '#FFFFFE', '#FFFFFF', '#FFFFFE',
           '#FFFFFF', '#FFFFFF', '#FFFFFE', false, true)`,
      [STORE.b],
    );
    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM store_themes WHERE store_id = $1 AND status = 'draft'`,
      [STORE.b],
    );
    assert.equal(rows[0]?.n, '1');
    await sql(`DELETE FROM store_themes WHERE store_id = $1`, [STORE.b]);
  });

  it('refuses a published theme that lies about needing an outline', async () => {
    const kicks = compileTheme(KICKS);
    await assert.rejects(
      () =>
        sql(
          `INSERT INTO store_themes (
               store_id, status, published_at,
               input_brand, input_accent, input_harmony, input_mood,
               input_shape, input_heading_font, input_card_treatment, input_hero,
               color_bg, color_surface, color_text, color_muted, color_border,
               color_primary, color_on_primary, color_accent, color_on_accent,
               color_tint, color_hero_bg, color_hero_text, is_dark, needs_outline
           ) VALUES ($1, 'published', now(), $2, $3, 'complementary', 'light',
               'round', 'sport', 'shadow', 'fill',
               $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, false, true)`,
          [
            STORE.b,
            kicks.inputs.brand,
            kicks.inputs.accent,
            kicks.colors.bg,
            kicks.colors.surface,
            kicks.colors.text,
            kicks.colors.muted,
            kicks.colors.border,
            kicks.colors.primary,
            kicks.colors.onPrimary,
            kicks.colors.accent,
            kicks.colors.onAccent,
            kicks.colors.tint,
            kicks.colors.heroBg,
            kicks.colors.heroText,
          ],
        ),
      (err: unknown) => {
        assert.equal((err as { constraint?: string }).constraint, 'store_themes_outline_agrees');
        return true;
      },
    );
  });

  it('SQL and TypeScript agree on every contrast the compiler produces', () => {
    // Two implementations of WCAG contrast — packages/core's and V015's plpgsql — and the whole
    // gate rests on them agreeing. Checked against the compiler's own output rather than against
    // random pairs, because those are the only pairs that matter.
    const brands = ['#E4572E', '#1D6B47', '#C6F432', '#6B3E26', '#9D174D', '#17160F', '#FFFFFF', '#000000'];
    const moods = ['light', 'warm', 'dark'] as const;
    const pairs: [string, string, number][] = [];

    for (const brand of brands) {
      for (const mood of moods) {
        const theme = compileTheme({ ...KICKS, brand, accent: null, mood });
        for (const c of theme.checks) pairs.push([c.foreground, c.background, c.ratio]);
      }
    }

    return (async () => {
      const { rows } = await sql<{ i: number; ratio: string }>(
        `SELECT i, wcag_contrast(a, b)::text AS ratio
           FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(a, b, i)`,
        [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
      );
      assert.equal(rows.length, pairs.length);

      let worst = 0;
      for (const row of rows) {
        const expected = pairs[row.i - 1]?.[2] ?? 0;
        const actual = Number(row.ratio);
        const drift = Math.abs(actual - expected) / Math.max(expected, 1e-12);
        if (drift > worst) worst = drift;
      }
      // One ulp of a double. Both use IEEE 754 pow over the same C library.
      assert.ok(worst < 1e-12, `worst relative drift ${worst.toExponential(3)}`);
    })();
  });
});

// ===========================================================================
describe('every theme the compiler approves, the database accepts', () => {
  it('holds across fourteen brands in every mood', async () => {
    // The two halves of the guarantee meeting. If the SQL check and the TypeScript check ever
    // disagreed at a boundary, this is what would fail — a merchant told their theme is fine and
    // then refused when they press Apply.
    // FOURTEEN BRANDS ACROSS THREE MOODS, not the compiler's full 59,136-combination space. Each
    // case here is a real HTTP request in a real transaction, and the exhaustive sweep already
    // runs in packages/core where it costs milliseconds. What this adds is the round trip: that
    // the SQL constraints accept what the TypeScript compiler approved. The brands are the ones
    // that exercise the interesting paths — the board's eight, plus black, white, mid-grey, a
    // near-page colour that forces an outline, and one that triggers the dark-mood brighten.
    const brands = [
      '#E4572E', '#1D6B47', '#1F437F', '#6B3E26', '#C6F432', '#9D174D', '#F4D35E', '#17160F',
      '#FFFFFF', '#000000', '#808080', '#FAFAFA', '#2E5AAC', '#7F7F7F',
    ];
    const refused: string[] = [];
    let attempted = 0;

    for (const brand of brands) {
      for (const mood of ['light', 'warm', 'dark'] as const) {
        // One harmony and one banner style per brand/mood: the harmony changes only the accent,
        // and the accent's own readability is what packages/core sweeps exhaustively.
        for (const harmony of ['complementary'] as const) {
          for (const hero of ['fill'] as const) {
            const inputs: ThemeInputs = { ...KICKS, brand, accent: null, harmony, mood, hero };
            const theme = compileTheme(inputs);
            attempted += 1;

            const reply = await call(api, 'POST', `/api/stores/${STORE.b}/theme/publish`, {
              token: tokenFor(USER.adminB),
              body: inputs,
            });

            if (reply.status !== 200) {
              refused.push(`${brand} ${mood} ${harmony} ${hero}: ${reply.status} ${JSON.stringify(reply.body)}`);
            } else {
              const published = reply.body['published'] as Presented;
              if (JSON.stringify(published.colors) !== JSON.stringify(theme.colors)) {
                refused.push(`${brand} ${mood} ${harmony} ${hero}: palette differs from the compiler`);
              }
            }
          }
        }
      }
    }

    assert.ok(attempted >= 40, `${attempted} themes published`);
    assert.deepEqual(refused.slice(0, 5), [], `${refused.length} of ${attempted} were refused`);
  });
});

// ===========================================================================
describe('drafts', () => {
  it('saves without being gated, and reports what is wrong', async () => {
    // A brand the same colour as the page: the button check fails, the theme is still
    // publishable, and the note says what the merchant will see.
    const reply = await call(api, 'PUT', `/api/stores/${STORE.a}/theme/draft`, {
      token: owner,
      body: { ...KICKS, brand: '#FAFAFA', accent: null, hero: 'soft' },
    });
    assert.equal(reply.status, 200);

    const draft = reply.body['draft'] as Presented;
    assert.equal(draft.outline, true);
    assert.equal(draft.publishable, true);
    assert.ok(draft.notes.some((n) => n.includes('thin outline')));

    const buttonCheck = draft.checks.find((c) => c.label === 'Buttons vs page');
    assert.equal(buttonCheck?.pass, false);
    assert.equal(buttonCheck?.satisfiedByOutline, true);
  });

  it('is one per store, replaced each time', async () => {
    await call(api, 'PUT', `/api/stores/${STORE.a}/theme/draft`, { token: owner, body: RUN });
    const { rows } = await sql<{ n: string; mood: string }>(
      `SELECT count(*)::text AS n, max(input_mood) AS mood
         FROM store_themes WHERE store_id = $1 AND status = 'draft'`,
      [STORE.a],
    );
    assert.equal(rows[0]?.n, '1');
    assert.equal(rows[0]?.mood, 'dark');
  });

  it('GET returns the draft and what is live, both recompiled from their inputs', async () => {
    await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, { token: owner, body: KICKS });
    await call(api, 'PUT', `/api/stores/${STORE.a}/theme/draft`, { token: owner, body: RUN });

    const reply = await call(api, 'GET', `/api/stores/${STORE.a}/theme`, { token: owner });
    assert.equal(reply.status, 200);

    const draft = reply.body['draft'] as Presented;
    const published = reply.body['published'] as Presented;

    assert.equal(draft.inputs.mood, 'dark');
    assert.equal(published.inputs.mood, 'light');
    // What was stored and what recompiling the inputs gives must be the same thing. A drift would
    // mean a shopfront rendering colours the compiler no longer produces.
    assert.equal(draft.matchesCompiler, true);
    assert.equal(published.matchesCompiler, true);
    assert.deepEqual(published.storedColors, compileTheme(KICKS).colors);
  });
});

// ===========================================================================
describe('the storefront reads the published theme', () => {
  it('serves it with the store’s currency, unauthenticated', async () => {
    await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, { token: owner, body: KICKS });

    const seen = await publicTheme();
    assert.equal(seen.status, 200);
    assert.ok(seen.etag);

    const theme = seen.body['theme'] as { colors: Record<string, string>; dark: boolean };
    assert.deepEqual(theme.colors, compileTheme(KICKS).colors);
    assert.equal(theme.dark, false);

    // §3: "one formatter driven by the currency table". The five columns travel with the look.
    const currency = seen.body['currency'] as Record<string, unknown>;
    assert.equal(currency['code'], 'RWF');
    assert.equal(currency['symbol'], 'RWF');
    assert.equal(currency['symbolPosition'], 'after');
    assert.equal(currency['decimals'], 0);
    // A NUMBER, not the '50.00' node-postgres returns for numeric — the formatter's roundToStep
    // refuses a string, which is how this cast came to be here.
    assert.equal(currency['cashRounding'], 50);
    assert.equal(typeof currency['cashRounding'], 'number');
  });

  it('answers 304 for an unchanged theme and 200 after a republish', async () => {
    const first = await publicTheme();
    assert.ok(first.etag);

    const unchanged = await fetch(`${api.baseUrl}/api/storefront/${SLUG}/theme`, {
      headers: { 'If-None-Match': first.etag },
    });
    assert.equal(unchanged.status, 304);

    await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, { token: owner, body: RUN });

    const stale = await fetch(`${api.baseUrl}/api/storefront/${SLUG}/theme`, {
      headers: { 'If-None-Match': first.etag },
    });
    assert.equal(stale.status, 200);
    await stale.text();
  });

  it('serves null for a store with no published theme, not an error', async () => {
    // §2.2: "a bad theme must degrade to the platform default, not take a store's shopfront
    // offline." A store that has never opened the studio is the same case.
    const reverted = await call(api, 'DELETE', `/api/stores/${STORE.a}/theme/published`, {
      token: owner,
    });
    assert.equal(reverted.status, 200);
    assert.equal(reverted.body['reverted'], true);

    const seen = await publicTheme();
    assert.equal(seen.status, 200);
    assert.equal(seen.body['theme'], null);
    // The currency is still there — a store with no theme still prices things.
    assert.ok(seen.body['currency']);

    // Idempotent.
    const again = await call(api, 'DELETE', `/api/stores/${STORE.a}/theme/published`, { token: owner });
    assert.equal(again.body['reverted'], false);
  });

  it('keeps the draft when the published theme is reverted', async () => {
    const { rows } = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM store_themes WHERE store_id = $1 AND status = 'draft'`,
      [STORE.a],
    );
    assert.equal(rows[0]?.n, '1', 'their work is not thrown away');
  });

  it('404s an address with no store', async () => {
    const res = await fetch(`${api.baseUrl}/api/storefront/no-such-store/theme`);
    assert.equal(res.status, 404);
    await res.text();
  });
});

// ===========================================================================
describe('who may change the look', () => {
  it('a manager cannot publish, save a draft, or read the studio', async () => {
    const manager = tokenFor(USER.managerA);

    // No body on the GET: fetch refuses one, and the guard runs before any body is read anyway.
    const read = await call(api, 'GET', `/api/stores/${STORE.a}/theme`, { token: manager });
    assert.equal(read.status, 403);

    const revert = await call(api, 'DELETE', `/api/stores/${STORE.a}/theme/published`, {
      token: manager,
    });
    assert.equal(revert.status, 403);

    for (const [method, path] of [
      ['PUT', `/api/stores/${STORE.a}/theme/draft`],
      ['POST', `/api/stores/${STORE.a}/theme/publish`],
    ] as const) {
      const reply = await call(api, method, path, { token: manager, body: KICKS });
      assert.equal(reply.status, 403, `${method} ${path}`);
    }
  });

  it('an admin of another store cannot publish here', async () => {
    const reply = await call(api, 'POST', `/api/stores/${STORE.a}/theme/publish`, {
      token: tokenFor(USER.adminB),
      body: KICKS,
    });
    assert.equal(reply.status, 403);
  });

  it('but anyone may read the published look', async () => {
    const seen = await publicTheme();
    assert.equal(seen.status, 200);
  });
});
