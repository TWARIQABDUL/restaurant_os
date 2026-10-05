// server/src/routes/storeTheme.ts — milestone 13.
//
// The theme studio's server side.
//
//   GET   /api/stores/:storeId/theme            the draft and what is live
//   PUT   /api/stores/:storeId/theme/draft      save a draft — anything compiles, nothing is gated
//   POST  /api/stores/:storeId/theme/publish    make it live — THE GATE
//
// THE GATE, which is §3's sentence and the whole reason publishing is a separate call: "The API
// must re-run the compiler on publish and reject any token set that is not its own output —
// otherwise ThemeStudio's promise that 'no store can publish something unreadable' is not true."
//
// So publish takes the EIGHT INPUTS and nothing else. There is no endpoint anywhere that accepts
// a colour for a token: the only way a palette enters the database is as compileTheme()'s return
// value, which makes "is this the compiler's own output" true by construction rather than by
// comparison. A client that sent its own preview colours would have them ignored, not merged.
//
// AND THE DATABASE CHECKS IT AGAIN. V015 refuses a published row whose text pairs fall below
// 4.5:1, computed in SQL from the stored colours. That is not redundancy for its own sake: this
// route is one writer, and the guarantee should not depend on it being the only one.

import { Router } from 'express';
import { badRequest, conflict, withTransaction } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, optionalString, requiredOneOf, requiredString } from '../api/validate.ts';
import { requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import {
  CARD_TREATMENTS,
  HARMONIES,
  HEADING_FONTS,
  DEFAULT_DESIGN,
  HEROES,
  HOMEPAGE_SECTIONS,
  MERCHANT_VISIBLE_TOKENS,
  MOODS,
  PRODUCT_LAYOUTS,
  SHAPES,
  compileTheme,
  failingChecks,
  isMediaPath,
  isPublishable,
} from '../core.ts';
import type { CompiledTheme, Design, ThemeInputs } from '../core.ts';
import * as designs from '../repositories/designs.ts';
import * as themes from '../repositories/themes.ts';

const router = Router({ mergeParams: true });

/**
 * The shape the compiler emits and V015 stores: #RRGGBB, upper case.
 *
 * Validated on the way IN even though the compiler's own output is always well formed, because
 * `brand` and `accent` come from a merchant's keyboard. The studio sends what they typed.
 */
const HEX = /^#[0-9A-Fa-f]{6}$/;

function readInputs(body: Record<string, unknown>): ThemeInputs {
  const brand = requiredString(body, 'brand', { max: 7 });
  if (!HEX.test(brand)) {
    throw badRequest('brand must be a colour like #E4572E.', 'INVALID_COLOR');
  }

  const accentRaw = optionalString(body, 'accent', { max: 7 });
  if (accentRaw !== null && !HEX.test(accentRaw)) {
    throw badRequest('accent must be a colour like #F4D35E, or null to let Vendlyfy pick.', 'INVALID_COLOR');
  }

  return {
    // Upper-cased here so the value stored matches what the compiler emits, and V015's
    // is_hex_color — which accepts upper case only — is satisfied by the input columns too.
    brand: brand.toUpperCase(),
    accent: accentRaw === null ? null : accentRaw.toUpperCase(),
    harmony: requiredOneOf(body, 'harmony', HARMONIES),
    mood: requiredOneOf(body, 'mood', MOODS),
    shape: requiredOneOf(body, 'shape', SHAPES),
    headingFont: requiredOneOf(body, 'headingFont', HEADING_FONTS),
    cardTreatment: requiredOneOf(body, 'cardTreatment', CARD_TREATMENTS),
    hero: requiredOneOf(body, 'hero', HEROES),
  };
}

/**
 * The design (layout, sections, logo) from a request body, or null when the request did not carry one.
 *
 * OPTIONAL, because ThemeStudio and Customize are two screens over one draft: ThemeStudio saves colours and must not
 * reset the layout Customize chose, so an absent `design` means "leave it as it is", never "back to the default".
 */
function readDesign(body: Record<string, unknown>, storeId: string): Design | null {
  const raw = body['design'];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('design must be an object.', 'INVALID_DESIGN');
  const d = raw as Record<string, unknown>;

  const sections: Design['sections'] = { ...DEFAULT_DESIGN.sections };
  const given = d['sections'];
  if (given !== undefined) {
    if (typeof given !== 'object' || given === null || Array.isArray(given)) throw badRequest('sections must be an object.', 'INVALID_DESIGN');
    for (const [key, value] of Object.entries(given)) {
      // `products` is rejected by name: the board draws it locked, and silently ignoring a client that tried to
      // switch it off would hide the mistake.
      if (!(HOMEPAGE_SECTIONS as readonly string[]).includes(key)) throw badRequest(`“${key}” is not a section you can switch.`, 'INVALID_DESIGN');
      if (typeof value !== 'boolean') throw badRequest(`${key} must be on or off.`, 'INVALID_DESIGN');
      sections[key as keyof Design['sections']] = value;
    }
  }

  const layout = requiredOneOf(d, 'productLayout', PRODUCT_LAYOUTS);
  const logo = d['logoUrl'];
  // This store's own upload, not merely one this server issued: the path carries the store id, so another store's
  // logo cannot be borrowed by guessing its URL.
  if (logo !== undefined && logo !== null && (!isMediaPath(logo) || !logo.startsWith(`/api/media/${storeId}/`))) {
    throw badRequest('That logo was not uploaded here. Upload it again.', 'INVALID_LOGO');
  }
  return { productLayout: layout, sections, logoUrl: logo === undefined ? null : (logo as string | null) };
}

/** The wire shape of a theme: what it was made from, what it produced, and how to read it. */
function present(theme: CompiledTheme): Record<string, unknown> {
  return {
    inputs: theme.inputs,
    colors: theme.colors,
    dark: theme.dark,
    outline: theme.outline,
    // The nine ThemeStudio actually shows a merchant, with its labels — so the studio renders a
    // list rather than holding one.
    visibleTokens: MERCHANT_VISIBLE_TOKENS.map(([token, label]) => ({
      token,
      label,
      hex: theme.colors[token],
    })),
    checks: theme.checks.map((c) => ({
      label: c.label,
      ratio: Number(c.ratio.toFixed(2)),
      required: c.required,
      pass: c.pass,
      satisfiedByOutline: c.satisfiedByOutline,
    })),
    notes: theme.notes,
    publishable: isPublishable(theme),
  };
}

function presentStored(stored: themes.StoredTheme | null): Record<string, unknown> | null {
  if (stored === null) return null;
  // Recompiled from the stored inputs rather than echoed from the stored colours, so the contrast
  // report and the notes come back with it — a stored row holds neither.
  //
  // It also surfaces drift. `matchesCompiler` is false when this build's compiler would produce a
  // different palette from the one on record, which is the signal that a republish is available.
  // The STOREFRONT deliberately keeps serving the stored colours until then (storefrontTheme.ts):
  // a compiler change must not repaint a live shopfront the merchant has not seen.
  const recompiled = compileTheme(stored.inputs);
  return {
    ...present(recompiled),
    storedColors: stored.colors,
    matchesCompiler: JSON.stringify(recompiled.colors) === JSON.stringify(stored.colors),
    updatedAt: stored.updatedAt,
    publishedAt: stored.publishedAt,
  };
}

/** GET …/theme — the draft and what is live. ThemeStudio opens on this. */
router.get(
  '/',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const both = await themes.findBoth(storeId);
    const design = await designs.findBoth(storeId);
    res.json({
      draft: presentStored(both.draft),
      published: presentStored(both.published),
      // Customize's half. A store that never opened it has none, and the client shows the default.
      design: { draft: design.draft, published: design.published, defaults: DEFAULT_DESIGN },
    });
  }),
);

/**
 * PUT …/theme/draft — save a draft.
 *
 * A DRAFT IS NOT GATED, deliberately. The merchant is mid-decision, and V015 lets a draft hold
 * anything for the same reason: the studio's job is to show them what is wrong, not to refuse to
 * remember it. The response carries the contrast report so it can.
 */
router.put(
  '/draft',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const inputs = readInputs(bodyOf(req.body));
    const theme = compileTheme(inputs);

    const design = readDesign(bodyOf(req.body), storeId);
    await withTransaction(
      async (tx) => {
        await themes.saveDraft(storeId, theme, tx);
        if (design !== null) await designs.saveDraft(storeId, design, tx);
      },
      { label: 'PUT /api/stores/:storeId/theme/draft' },
    );

    res.json({ draft: present(theme) });
  }),
);

/**
 * POST …/theme/publish — make it live.
 *
 * Takes the eight inputs, not a palette. Compiles them. Refuses if the result is not publishable,
 * which can only happen for a reason the compiler could not fix — and then says which text is
 * unreadable rather than "invalid theme".
 *
 * The draft is left in place: ThemeStudio's Apply does not clear the editor, and a merchant who
 * publishes and then keeps tweaking should still be tweaking what they published.
 */
router.post(
  '/publish',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const inputs = readInputs(bodyOf(req.body));
    const theme = compileTheme(inputs);

    // Reachable only if the compiler cannot make a readable palette from these inputs. The sweep
    // in packages/core says that has no known case — so this is the branch that would tell us
    // one had been found, rather than publishing it.
    if (!isPublishable(theme)) {
      const failing = failingChecks(theme)
        .map((c) => `${c.label} is ${c.ratio.toFixed(1)}:1, needs ${c.required}:1`)
        .join('; ');
      throw conflict(
        `That combination cannot be made readable: ${failing}. Try a different brand colour or mood.`,
        'UNREADABLE_THEME',
      );
    }

    const sent = readDesign(bodyOf(req.body), storeId);

    const publishedAt = await withTransaction(
      async (tx) => {
        // Both rows in one transaction: the draft is what the merchant will reopen, and it must
        // not be able to end up describing something other than what went live.
        await themes.saveDraft(storeId, theme, tx);

        // THE DESIGN GOES LIVE WITH THE PALETTE, in the same transaction, so a store never has a new colour scheme
        // with the old layout. Sent explicitly it is taken as given; absent, it is the draft's (what Customize saved),
        // and failing that the default — never "whatever happens to be published".
        const design = sent ?? (await designs.findBoth(storeId, tx)).draft ?? DEFAULT_DESIGN;
        await designs.saveDraft(storeId, design, tx);
        await designs.publish(storeId, design, tx);

        return themes.publish(storeId, theme, tx);
      },
      { label: 'POST /api/stores/:storeId/theme/publish' },
    );

    res.json({ published: { ...present(theme), publishedAt } });
  }),
);

/**
 * DELETE …/theme/published — revert to the platform default.
 *
 * §2.2: a store with no theme renders the platform default in tokens.css, and "a bad theme must
 * degrade to the platform default, not take a store's shopfront offline". Removing the published
 * row is how a merchant gets back there; the draft survives, so their work is not thrown away.
 */
router.delete(
  '/published',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const removed = await withTransaction(async (tx) => {
      const { rowCount } = await tx.query(
        `DELETE FROM store_themes WHERE store_id = $1 AND status = 'published'`,
        [storeId],
      );
      await designs.revertPublished(storeId, tx);
      return rowCount !== null && rowCount > 0;
    }, { label: 'DELETE /api/stores/:storeId/theme/published' });

    // Idempotent: a repeat of a revert that worked is not an error.
    res.json({ reverted: removed });
  }),
);

export default router;
