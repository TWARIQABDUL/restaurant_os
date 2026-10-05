// server/src/routes/storeReviews.ts — milestone 24.
//
//   GET  /api/stores/:storeId/reviews?filter=all|reply|low&before&beforeId   the figures, a page of reviews, by product
//   POST /api/stores/:storeId/reviews/:reviewId/reply     { body } — public, one per review, editable
//   POST /api/stores/:storeId/reviews/:reviewId/report    { reason } — to Vendlyfy, one open report per review
//
// One permission, support.write, for reading too: V026 gives it to every console role, and a permission nobody lacks
// is a row to keep in step (the convention products.write set at milestone 22).

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { authOf, isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { bodyOf, optionalTimestamp, requiredOneOf, requiredString } from '../api/validate.ts';
import { badRequest, withTransaction } from '../db/index.ts';
import * as reviews from '../repositories/merchantReviews.ts';

const router = Router({ mergeParams: true });

function reviewIdOf(raw: unknown): string {
  if (!isUuid(raw)) throw badRequest('That is not a review.', 'INVALID_REVIEW');
  return raw;
}

router.get(
  '/',
  requireStorePermission('support.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const filter = (['all', 'reply', 'low'] as const).find((f) => f === req.query['filter']) ?? 'all';
    const before = optionalTimestamp(req.query['before'], 'before');
    const beforeId = req.query['beforeId'];
    if (before !== null && !isUuid(beforeId)) throw badRequest('beforeId must go with before.', 'INVALID_CURSOR');

    const cursor = before === null || !isUuid(beforeId) ? null : { at: before, id: beforeId };
    const [overview, page, byProduct] = await Promise.all([
      cursor === null ? reviews.overview(storeId) : Promise.resolve(null),
      reviews.list(storeId, filter, cursor),
      cursor === null ? reviews.byProduct(storeId) : Promise.resolve(null),
    ]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ overview, reviews: page.items, nextCursor: page.nextCursor, byProduct, minForAverage: reviews.MIN_REVIEWS_FOR_AVERAGE });
  }),
);

router.post(
  '/:reviewId/reply',
  requireStorePermission('support.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const body = requiredString(bodyOf(req.body), 'body', { max: 1000 });
    await withTransaction((tx) => reviews.reply(storeId, reviewIdOf(req.params['reviewId']), authOf(req).context.userId, body, tx));
    res.json({ ok: true });
  }),
);

router.post(
  '/:reviewId/report',
  requireStorePermission('support.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const reason = requiredOneOf(bodyOf(req.body), 'reason', reviews.REPORT_REASONS);
    await withTransaction((tx) => reviews.report(storeId, reviewIdOf(req.params['reviewId']), authOf(req).context.userId, reason, tx));
    res.json({ ok: true });
  }),
);

export default router;
