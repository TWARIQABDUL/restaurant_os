// server/src/routes/storefrontTheme.ts — milestone 13.
//
// GET /api/storefront/:slug/theme — the published look, and how to write money.
//
// PUBLIC AND KEYED BY SLUG, for the reasons storefrontConfig.ts sets out at length: a slug is
// already in the storefront's URL, a store uuid is not, and this payload is rendered to every
// anonymous shopper.
//
// A SEPARATE PAYLOAD FROM THE CONFIG, on purpose. The two change independently — a merchant
// republishes a theme without touching their vocabulary — so one ETag over both would invalidate
// each on the other's change. The cost is that a cold page load fetches two documents, which
// milestone 16 can collapse if the storefront's own waterfall says it should; that is a decision
// to make with a real page in front of you, not now.
//
// THE CURRENCY TRAVELS WITH IT. §3: "one formatter driven by the currency table". The storefront
// needs the five formatting columns to render a single price, and they belong to the store rather
// than to the shopper — so they come with the look rather than being fetched per price.

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { badRequest, notFound, readConsistent } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import * as designs from '../repositories/designs.ts';
import * as themes from '../repositories/themes.ts';

const router = Router();

/** Same shape as stores_slug_format in V001. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

router.get(
  '/:slug/theme',
  asyncHandler(async (req, res) => {
    const slug = req.params['slug'];
    if (typeof slug !== 'string' || slug.length < 2 || slug.length > 63 || !SLUG.test(slug)) {
      throw badRequest('That is not a valid store address.', 'INVALID_SLUG');
    }

    // One consistent read: a theme and the currency it prices in, at the same moment.
    const found = await readConsistent(async (tx) => {
      const theme = await themes.findPublishedBySlug(slug, tx);
      if (theme === null) return null;
      const currency = await themes.findCurrencyBySlug(slug, tx);
      // The published layout, sections and logo — or the default. Read with the theme in the same transaction so a
      // shopfront never gets one half of a publish.
      const design = await designs.findPublishedForStore(theme.store.id, tx);
      return { ...theme, currency, design };
    }, 'GET /api/storefront/:slug/theme');

    if (found === null) throw notFound('No store at that address.', 'NO_SUCH_STORE');

    const payload = {
      store: found.store,
      // THE STORED COLOURS, NOT RECOMPILED ONES, and that is deliberate. These are what the
      // merchant published and what V015 verified readable. Recompiling on read would let a change
      // to the compiler repaint a live shopfront without anybody pressing Apply — and the merchant
      // would not have seen it. GET /api/stores/:storeId/theme reports `matchesCompiler` for
      // exactly this case, so the studio can tell them a republish is available.

      // null means "render the platform default", which tokens.css already holds. Not an error:
      // a store that has not opened the theme studio has no published theme and a working shop.
      theme:
        found.theme === null
          ? null
          : {
              inputs: found.theme.inputs,
              colors: found.theme.colors,
              dark: found.theme.dark,
              outline: found.theme.outline,
              publishedAt: found.theme.publishedAt,
            },
      currency: found.currency,
      design: found.design,
    };

    // Strong ETag over the payload, for the reason storefrontConfig.ts gives: hashing the answer
    // rather than its inputs means there is no invalidation-rule list to keep in step.
    const etag = `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');

    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string') {
      const offered = inm.split(',').map((v) => v.trim().replace(/^W\//, ''));
      if (offered.includes(etag) || offered.includes('*')) {
        res.status(304).end();
        return;
      }
    }

    res.json(payload);
  }),
);

export default router;
