// server/src/routes/storefrontReviews.ts — milestone 16.
//
// GET  /api/storefront/:slug/products/:productId/reviews  the rest of the list, by keyset
// POST /api/storefront/:slug/products/:productId/reviews  write one
//
// THE WRITE NEEDS AN ACCOUNT, and the board says why in the sheet itself: "Reviews come from customers
// with an account, so we can show that they really ordered." V009 turned that sentence into a
// structure — a review names the order line it is about — so the endpoint's real work is finding the
// line, and a shopper with no delivered order of this product has nothing to write about.
//
// THE CUSTOMER DOES NOT CHOOSE THE ORDER, and cannot. The body carries a rating and a sentence; the
// line comes from findReviewTarget(). If the body could name an order_item_id, the endpoint would have
// to prove the caller owns it — and that check, written here rather than in the trigger, is the kind
// that is correct until somebody adds a second endpoint. V009's trigger refuses a mismatch anyway; not
// accepting the field means the trigger can never be reached with a hostile one.
//
// POSTING TWICE IS POSTING ONCE, AND THERE ARE TWO WAYS IT HAPPENS:
//
//   CONCURRENTLY — two requests in flight together. Both find the same unreviewed line, both call
//   post_review(), and `reviews_order_item_key` lets exactly one insert; the other is handed the first
//   review instead of an error. Settled in the database, which is the only place two simultaneous
//   callers can be settled.
//
//   SEQUENTIALLY — the POST succeeded, the response was lost, the client sent it again. Nothing
//   concurrent about it, and the database cannot help: by the time the retry arrives the first review is
//   committed. This endpoint answers 200 with the review that is already there, rather than the 400 it
//   answered at first — which told somebody whose review was live that they had nothing to review. That
//   was a bug found by retrying the request by hand, and it is why findReviewTarget() returns a reviewed
//   line instead of skipping it.
//
// 200 AND NOT 201 for the second one, because nothing was created. The body is otherwise identical, so a
// client that ignores the status still shows the right thing.

import { Router } from 'express';
import type { Request } from 'express';
import { badRequest, forbidden, notFound, readConsistent } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { isUuid, requireSession, authOf } from '../middleware/authorize.ts';
import { resolveStorefront, storeOf } from '../middleware/storefront.ts';
import { bodyOf, optionalString } from '../api/validate.ts';
import * as catalogue from '../repositories/catalogue.ts';
import * as reviews from '../repositories/reviews.ts';

const router = Router();

/** What a review's text may be. Long enough for a paragraph, short of an essay nobody reads. */
const MAX_BODY = 1000;

function productIdOf(req: Request): string {
  const productId = req.params['productId'];
  if (!isUuid(productId)) throw badRequest('That is not a valid product.', 'INVALID_PRODUCT_ID');
  return productId;
}

router.get(
  '/:slug/products/:productId/reviews',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const productId = productIdOf(req);

    const rawAfter = req.query['after'];
    const rawAfterId = req.query['afterId'];
    const afterId = isUuid(rawAfterId) ? rawAfterId : null;
    if (rawAfterId !== undefined && rawAfterId !== '' && afterId === null) {
      throw badRequest('afterId must be the id from the previous page.', 'INVALID_CURSOR');
    }
    if (rawAfter !== undefined && rawAfter !== '' && typeof rawAfter !== 'string') {
      throw badRequest('after must be a timestamp.', 'INVALID_CURSOR');
    }
    const after = typeof rawAfter === 'string' && rawAfter !== '' ? rawAfter : null;
    if (Number.isNaN(Date.parse(after ?? '1970-01-01'))) {
      throw badRequest('after must be a timestamp.', 'INVALID_CURSOR');
    }
    if ((after === null) !== (afterId === null)) {
      throw badRequest('A cursor needs both after and afterId.', 'INVALID_CURSOR');
    }

    const page = await readConsistent(async (tx) => {
      // The product is checked first so that a review list cannot be read for a draft product or for
      // one belonging to another store. Without it this endpoint would be a way to read reviews of a
      // catalogue the shopper cannot see.
      const product = await catalogue.findProduct(store.id, productId, tx);
      if (product === null) return null;
      return reviews.listForProduct(
        productId,
        { limit: 20, after: after === null || afterId === null ? null : { createdAt: after, id: afterId } },
        tx,
      );
    }, 'GET /api/storefront/:slug/products/:productId/reviews');

    if (page === null) throw notFound('That product is not on sale.', 'NO_SUCH_PRODUCT');

    res.json({
      reviews: page.items.map((review) => ({
        id: review.id,
        rating: review.rating,
        body: review.body,
        author: review.authorFirstName,
        createdAt: review.createdAt,
        reply: review.reply,
      })),
      nextCursor: page.nextCursor,
    });
  }),
);

router.post(
  '/:slug/products/:productId/reviews',
  resolveStorefront(),
  // requireSession, not currentCustomer(): writing is the one thing on this shopfront that needs an
  // account, so a missing session is a 401 here rather than an anonymous visitor.
  requireSession,
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const productId = productIdOf(req);
    const { context } = authOf(req);

    // The same narrowing currentCustomer() applies, and it has to be repeated because requireSession
    // proves only that somebody is signed in. A merchant's staff session is not a customer of the shop,
    // and V009's trigger would refuse the insert anyway — this turns that 500 into a sentence.
    if (context.scope !== 'store' || context.customerStoreId !== store.id) {
      throw forbidden(
        'Reviews come from this store’s own customers, so they can be shown as real orders.',
        'NOT_A_CUSTOMER',
      );
    }

    const body = bodyOf(req.body);
    const rating = body['rating'];
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw badRequest('Choose between one and five stars.', 'INVALID_RATING');
    }
    const text = optionalString(body, 'body', { max: MAX_BODY });

    const target = await reviews.findReviewTarget(store.id, context.userId, productId);
    if (target === null) {
      // Not a 404 and not a 403: the product exists and they are allowed to review in principle. There
      // is simply no arrived order of this product behind them, which is what the sheet has to say.
      throw badRequest(
        'You can review this once an order with it has arrived.',
        'NOTHING_TO_REVIEW',
      );
    }

    // Already reviewed — the retry case. Their words are returned, not the ones just sent: V009 makes a
    // review immutable ("What the customer wrote is theirs"), so echoing the new text would show them an
    // edit that did not happen.
    const existing = target.existingReview;
    const review =
      existing === null
        ? {
            id: await reviews.post(target.orderItemId, context.userId, rating, text),
            rating,
            body: text,
            orderCode: target.orderCode,
          }
        : { id: existing.id, rating: existing.rating, body: existing.body, orderCode: target.orderCode };

    // The summary AFTER the write, so the page can replace its own — and this is where the three-review
    // rule shows itself: the second review leaves `averageRating` null and the third makes it a number,
    // without this endpoint knowing the threshold.
    const summary = await reviews.summaryFor(productId);

    res.status(existing === null ? 201 : 200).json({ review, rating: summary });
  }),
);

export default router;
