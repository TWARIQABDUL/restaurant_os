// server/src/routes/storefrontCatalogue.ts — milestone 16.
//
// GET /api/storefront/:slug/products            the grid, filtered and searched, by keyset
// GET /api/storefront/:slug/products/:productId one product, with its choices and its variants
//
// KEYSET, NOT OFFSET, on a catalogue — §2.3 asks for it on "every growing list", and milestone 11
// measured what the difference costs on real volumes: 26 buffers against 1,038 for the same page. A
// grocery store's aisle is exactly the growing list that argument is about.
//
// THE RATING COMES FROM THE SAME REQUEST as the products, in a second query rather than a join. V009
// put the three-review rule in `product_rating_summary`, and the view groups over every product — so
// it is asked once for the page's ids rather than joined per row, and the page's shape decides how much
// work it is.

import { Router } from 'express';
import { badRequest, notFound, readConsistent } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { isUuid } from '../middleware/authorize.ts';
import { currentCustomer, resolveStorefront, storeOf } from '../middleware/storefront.ts';
import { optionalPositiveInt } from '../api/validate.ts';
import * as catalogue from '../repositories/catalogue.ts';
import * as reviews from '../repositories/reviews.ts';

const router = Router();

/** The longest search term worth running. Beyond this it is not a search, it is a payload. */
const MAX_QUERY = 80;

router.get(
  '/:slug/products',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);

    const rawCategory = req.query['category'];
    if (rawCategory !== undefined && rawCategory !== '' && !isUuid(rawCategory)) {
      throw badRequest('That is not a valid section.', 'INVALID_CATEGORY');
    }

    const rawQuery = req.query['q'];
    if (rawQuery !== undefined && typeof rawQuery !== 'string') {
      throw badRequest('Search for one thing at a time.', 'INVALID_QUERY');
    }
    if (typeof rawQuery === 'string' && rawQuery.length > MAX_QUERY) {
      throw badRequest(`A search can be at most ${MAX_QUERY} characters.`, 'QUERY_TOO_LONG');
    }

    const limit = optionalPositiveInt(req.query['limit'], 'limit');

    // BOTH HALVES OF THE CURSOR OR NEITHER, the same rule storeWallet.ts states: an id without its
    // position would silently page from the start, which reads as duplicated products rather than as a
    // bad request.
    const afterPosition = optionalPositiveInt(req.query['afterPosition'], 'afterPosition');
    const rawAfterId = req.query['afterId'];
    const afterId = isUuid(rawAfterId) ? rawAfterId : null;
    if (rawAfterId !== undefined && rawAfterId !== '' && afterId === null) {
      throw badRequest('afterId must be the id from the previous page.', 'INVALID_CURSOR');
    }
    if ((afterId === null) !== (afterPosition === null)) {
      throw badRequest('A cursor needs both afterPosition and afterId.', 'INVALID_CURSOR');
    }

    // One consistent read: the page and its ratings. Without it a review posted between the two
    // queries can leave a card showing a count that does not match its own stars.
    const page = await readConsistent(async (tx) => {
      const products = await catalogue.listProducts(
        store.id,
        {
          categoryId: isUuid(rawCategory) ? rawCategory : null,
          q: typeof rawQuery === 'string' ? rawQuery : null,
          ...(limit === null ? {} : { limit }),
          after:
            afterPosition === null || afterId === null
              ? null
              : { position: afterPosition, id: afterId },
        },
        tx,
      );
      const ratings = await reviews.summariesFor(
        products.items.map((p) => p.id),
        tx,
      );
      return { products, ratings };
    }, 'GET /api/storefront/:slug/products');

    // A catalogue changes when a merchant edits it, which is not on a shopper's clock — but it also
    // carries stock, which is. Revalidate rather than reuse blindly.
    res.setHeader('Cache-Control', 'no-cache');

    res.json({
      products: page.products.items.map((product) => ({
        ...product,
        rating: page.ratings.get(product.id) ?? null,
      })),
      nextCursor: page.products.nextCursor,
    });
  }),
);

/**
 * One product.
 *
 * `canReview` IS ANSWERED HERE, not when the sheet opens, because `ReviewsCustomer` draws three
 * different things behind "Write a review" — a sign-in prompt, the rating form, or nothing to review —
 * and deciding which after the tap means the sheet opens on the wrong one and corrects itself.
 *
 * FOR AN ANONYMOUS VISITOR IT IS `needsSignIn`, which is the board's own state: "Reviews come from
 * customers with an account, so we can show that they really ordered."
 */
router.get(
  '/:slug/products/:productId',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const productId = req.params['productId'];
    if (!isUuid(productId)) {
      throw badRequest('That is not a valid product.', 'INVALID_PRODUCT_ID');
    }

    // Outside the consistent read: it is an identity question, not part of the product's snapshot.
    const customerId = await currentCustomer(req, store.id);

    const view = await readConsistent(async (tx) => {
      const product = await catalogue.findProduct(store.id, productId, tx);
      if (product === null) return null;
      const rating = await reviews.summaryFor(productId, tx);
      const firstPage = await reviews.listForProduct(productId, { limit: 10 }, tx);
      const target =
        customerId === null
          ? null
          : await reviews.findReviewTarget(store.id, customerId, productId, tx);
      return { product, rating, firstPage, target };
    }, 'GET /api/storefront/:slug/products/:productId');

    // The same answer as a product belonging to another store, and as one still in draft: a storefront
    // that distinguished them would let anybody walk a merchant's unpublished catalogue by id.
    if (view === null) throw notFound('That product is not on sale.', 'NO_SUCH_PRODUCT');

    res.setHeader('Cache-Control', 'no-cache');

    res.json({
      product: view.product,
      rating: view.rating,
      reviews: view.firstPage.items.map((review) => ({
        id: review.id,
        rating: review.rating,
        body: review.body,
        author: review.authorFirstName,
        createdAt: review.createdAt,
        reply: review.reply,
      })),
      nextCursor: view.firstPage.nextCursor,
      // FOUR STATES, because the sheet has four things to be: a sign-in prompt, the rating form, their
      // own review, or a sentence saying there is nothing of this to review. `alreadyReviewed` is the
      // one that carries an id, so the page can scroll to what they wrote instead of offering the form
      // again. V009 allows a second review of a SECOND order of the same product, which is why this is a
      // property of the line rather than of the product.
      write:
        customerId === null
          ? { can: false, reason: 'needsSignIn' as const }
          : view.target === null
            ? { can: false, reason: 'nothingToReview' as const }
            : view.target.existingReview !== null
              ? {
                  can: false,
                  reason: 'alreadyReviewed' as const,
                  reviewId: view.target.existingReview.id,
                }
              : { can: true, orderCode: view.target.orderCode },
    });
  }),
);

export default router;
