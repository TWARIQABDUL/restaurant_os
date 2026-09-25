// server/src/routes/storefrontConfig.ts — milestone 12.
//
// GET /api/storefront/:slug/config — "one versioned payload with an ETag" (§3).
//
// THE ONE CALL milestone 12's done-when names. Switch a store's template and this answer
// changes: different words, different feature gates, a different order timeline, one request.
//
// KEYED BY SLUG, AND UNAUTHENTICATED, and both halves are deliberate:
//
//   * A slug is already public — it is in the storefront's URL. A store uuid is not, and
//     milestone 11 went to some trouble to make store existence unobservable through the
//     console: a store you are not a member of and a store that does not exist answer
//     identically. An unauthenticated endpoint keyed by uuid would hand that back.
//   * The payload is vocabulary and feature gates, which are rendered to every anonymous
//     shopper who opens the shop. There is nothing here to authenticate for. The merchant
//     console reads the SAME endpoint — it has the slug from GET /api/session — so there is
//     one resolution path for the storefront and the console rather than two that can drift.
//
// IT SERVES A SUSPENDED STORE. Refusing one is the storefront's job (milestone 16), not the
// config's: milestone 11 decided a suspended store stays visible to its own staff so they can
// see why, and their console needs its vocabulary to render the explanation.

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { badRequest, notFound, readConsistent } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { resolveConfig } from '../core.ts';
import type { EffectiveConfig } from '../core.ts';
import * as configRepo from '../repositories/config.ts';

const router = Router();

// Same shape as stores_slug_format in V001, so a malformed slug is a 400 that says so rather
// than a lookup that cannot match.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type ConfigPayload = {
  store: configRepo.ConfigStore;
  config: EffectiveConfig;
};

/**
 * A strong ETag over the payload itself.
 *
 * Hashing the ANSWER rather than its inputs is what makes it correct by construction: the
 * resolver is pure (asserted in packages/core's tests), so identical bytes mean an identical
 * answer, and there is no list of "things that should invalidate the cache" to keep in step
 * with the resolution rules. A new template version, a repin, an edited override, a migration
 * that adds a module — each changes the bytes, and none of them has to be remembered here.
 */
function etagFor(payload: ConfigPayload): string {
  return `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}"`;
}

router.get(
  '/:slug/config',
  asyncHandler(async (req, res) => {
    const slug = req.params['slug'];
    if (typeof slug !== 'string' || slug.length < 2 || slug.length > 63 || !SLUG.test(slug)) {
      throw badRequest('That is not a valid store address.', 'INVALID_SLUG');
    }

    // One consistent read: the pin and the version it points at must come from the same
    // moment, or a rollout running alongside this can hand back one version's words with
    // another's modules.
    const found = await readConsistent(
      (tx) => configRepo.inputsBySlug(slug, tx),
      'GET /api/storefront/:slug/config',
    );

    if (found === null) throw notFound('No store at that address.', 'NO_SUCH_STORE');

    const payload: ConfigPayload = {
      store: found.store,
      config: resolveConfig(found.inputs),
    };

    const etag = etagFor(payload);
    res.setHeader('ETag', etag);

    // no-cache means "revalidate before reusing", NOT "do not store" — so a client keeps the
    // payload and spends one conditional request to learn it is still good. Whether a CDN may
    // hold it is a deployment decision (the domain question in Part 9 is still open), so this
    // deliberately does not say `public`.
    res.setHeader('Cache-Control', 'no-cache');

    // If-None-Match may carry a list, and a weak comparison is correct for a GET.
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
