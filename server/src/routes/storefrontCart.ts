// server/src/routes/storefrontCart.ts — milestone 16.
//
// GET  /api/storefront/:slug/cart        what is in the bag
// POST /api/storefront/:slug/cart/items  put something in it
//
// MILESTONE 16 OWNS ADDING, MILESTONE 17 OWNS THE CART SCREEN. The split follows the boards rather than
// the tables: the cart badge, the sticky "View cart · 2 items · 9,500" bar and the option sheet's "Add ·
// 8,000 RWF" are all drawn on `Shop`'s HOME screen, so without them this milestone's own boards have a
// dead button. Editing a quantity, removing a line, the coupon field and checkout are the cart SCREEN,
// and they arrive with it.
//
// THE READ IS SAFE TO CALL WITH NOTHING. A shopper who has never added anything has no cart and no
// cookie, and this answers with an empty one rather than creating a row to describe emptiness. That is
// what keeps a crawler from filling the table.
//
// THE WRITE IS WHERE THE COOKIE IS BORN. See auth/shopper.ts: nothing is set while somebody browses.
//
// A SIGNED-IN CUSTOMER'S CART FOLLOWS THE ACCOUNT, an anonymous one follows the cookie, and this
// endpoint does not merge them. Signing in halfway through shopping is milestone 17's problem, at
// checkout, where `CustomerAccount` draws it — and it is a real one: the anonymous cart's lines have to
// move onto the account's cart without double-counting what is in both. Doing it here, on every add,
// would run that merge on every tap.

import { Router } from 'express';
import { badRequest } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { withTransaction } from '../db/index.ts';
import { isUuid } from '../middleware/authorize.ts';
import { currentCustomer, resolveStorefront, storeOf } from '../middleware/storefront.ts';
import { readShopperId, setShopperCookie } from '../auth/shopper.ts';
import { bodyOf } from '../api/validate.ts';
import * as carts from '../repositories/carts.ts';

const router = Router();

/** How many extras one line may carry. More than this is not a burger. */
const MAX_OPTIONS = 20;

const EMPTY = { id: null, lines: [], itemCount: 0, subtotal: '0.00', expiresAt: null };

router.get(
  '/:slug/cart',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const customerId = await currentCustomer(req, store.id);
    const sessionId = readShopperId(req);

    const owner: carts.CartOwner | null =
      customerId !== null ? { userId: customerId } : sessionId !== null ? { sessionId } : null;

    // No owner at all means no cart can exist. Answering without a query is not an optimisation, it is
    // the correct answer: there is nothing to look up.
    if (owner === null) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ cart: EMPTY });
      return;
    }

    const cartId = await carts.findId(store.id, owner);
    const cart = cartId === null ? null : await carts.read(cartId);

    // A cart is per-shopper and changes on their own taps. It must never be held by a shared cache.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ cart: cart ?? EMPTY });
  }),
);

router.post(
  '/:slug/cart/items',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const body = bodyOf(req.body);

    const variantId = body['variantId'];
    if (!isUuid(variantId)) {
      throw badRequest('Choose what you want to add.', 'INVALID_VARIANT');
    }

    const rawQuantity = body['quantity'] ?? 1;
    if (
      typeof rawQuantity !== 'number' ||
      !Number.isInteger(rawQuantity) ||
      rawQuantity < 1 ||
      rawQuantity > 999
    ) {
      throw badRequest('Choose a quantity between 1 and 999.', 'INVALID_QUANTITY');
    }

    const rawOptions = body['optionValueIds'] ?? [];
    if (!Array.isArray(rawOptions) || rawOptions.length > MAX_OPTIONS) {
      throw badRequest('Those extras are not valid.', 'INVALID_OPTIONS');
    }
    const optionValueIds = rawOptions.filter((value): value is string => isUuid(value));
    if (optionValueIds.length !== rawOptions.length) {
      throw badRequest('Those extras are not valid.', 'INVALID_OPTIONS');
    }

    const customerId = await currentCustomer(req, store.id);
    // An anonymous shopper who has no cookie yet gets an id now. Generated before the transaction so
    // that the value in the cookie and the value in the row cannot differ.
    const sessionId = customerId === null ? (readShopperId(req) ?? carts.newSessionId()) : null;
    const owner: carts.CartOwner =
      customerId !== null ? { userId: customerId } : { sessionId: sessionId as string };

    // ONE TRANSACTION for find-or-create plus the add, so a failed add cannot leave an empty cart row
    // behind and a shopper cannot end up with a cookie pointing at a cart that was rolled back.
    //
    // add_to_cart() is where the atomicity that matters lives — see V018. This transaction is about the
    // pair of statements, not about the merge.
    const cart = await withTransaction(async (tx) => {
      const cartId = await carts.findOrCreateId(store.id, owner, tx);
      const added = await carts.addItem(cartId, variantId, optionValueIds, rawQuantity, tx);
      const read = await carts.read(cartId, tx);
      return { added, read };
    });

    // Set AFTER the commit. Handing out a cookie for a cart that did not survive its transaction would
    // point a shopper at nothing for seven days.
    if (sessionId !== null) setShopperCookie(res, sessionId);

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      line: { id: cart.added.cartItemId, quantity: cart.added.quantity, created: cart.added.created },
      cart: cart.read ?? EMPTY,
    });
  }),
);

export default router;
