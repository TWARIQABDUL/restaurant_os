// server/src/routes/storefrontCart.ts — milestone 16.
//
// GET  /api/storefront/:slug/cart        what is in the bag
// POST /api/storefront/:slug/cart/items  put something in it
//
// PATCH  /api/storefront/:slug/cart/items/:lineId  change a quantity
// DELETE /api/storefront/:slug/cart/items/:lineId  remove a line
// PUT    /api/storefront/:slug/cart/promo          hold a code, or clear it
//
// The first two arrived with milestone 16 (the badge, the sticky bar and the option sheet are drawn on
// `Shop`'s HOME screen, so adding had to work for that milestone's own boards to work). The last three are
// milestone 17's: they are the cart SCREEN.
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
import type { Request } from 'express';
import { badRequest, notFound, withTransaction } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { isUuid } from '../middleware/authorize.ts';
import { currentCustomer, resolveStorefront, storeOf } from '../middleware/storefront.ts';
import { readShopperId, setShopperCookie } from '../auth/shopper.ts';
import { bodyOf } from '../api/validate.ts';
import * as carts from '../repositories/carts.ts';
import * as checkout from '../repositories/checkout.ts';

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

/**
 * The cart a request already has, or null.
 *
 * EVERY EDIT GOES THROUGH THIS, so a line id alone is never enough: the cart is resolved from who is asking,
 * and the line is then required to be in THAT cart. Otherwise a guessed cart_item_id would edit somebody
 * else's bag — the line ids are uuids, but "unguessable" is not an access rule.
 */
async function cartOf(req: Request, storeId: string): Promise<string | null> {
  const customerId = await currentCustomer(req, storeId);
  const sessionId = readShopperId(req);
  const owner: carts.CartOwner | null =
    customerId !== null ? { userId: customerId } : sessionId !== null ? { sessionId } : null;
  return owner === null ? null : carts.findId(storeId, owner);
}

router.patch(
  '/:slug/cart/items/:lineId',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const lineId = req.params['lineId'];
    if (!isUuid(lineId)) throw badRequest('That is not a line in your cart.', 'INVALID_LINE');

    const body = bodyOf(req.body);
    const quantity = body['quantity'];
    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 999
    ) {
      // Zero is not a quantity, it is a removal, and the board has a separate Remove button for it. Taking
      // 0 here would mean two ways to do one thing and a line that exists with nothing in it.
      throw badRequest('Choose a quantity between 1 and 999, or remove the line.', 'INVALID_QUANTITY');
    }

    const cartId = await cartOf(req, store.id);
    if (cartId === null) throw notFound('Your cart is empty.', 'NO_CART');

    const changed = await carts.setQuantity(cartId, lineId, quantity);
    if (!changed) throw notFound('That is no longer in your cart.', 'NO_SUCH_LINE');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ cart: (await carts.read(cartId)) ?? EMPTY });
  }),
);

router.delete(
  '/:slug/cart/items/:lineId',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const lineId = req.params['lineId'];
    if (!isUuid(lineId)) throw badRequest('That is not a line in your cart.', 'INVALID_LINE');

    const cartId = await cartOf(req, store.id);
    if (cartId === null) throw notFound('Your cart is empty.', 'NO_CART');

    // Removing something already gone is not an error: the board's Remove button can be tapped twice, and
    // the second tap should leave the customer looking at the cart they expected rather than at a failure.
    await carts.removeLine(cartId, lineId);

    res.setHeader('Cache-Control', 'no-store');
    res.json({ cart: (await carts.read(cartId)) ?? EMPTY });
  }),
);

/**
 * Hold a promo code on the cart, or clear it, and say what it is worth.
 *
 * THE ANSWER COMES FROM promotion_quote(), which shares its rules with the thing that will actually apply the
 * code at placement (V019). So "WELCOME10 applied · 10% off your items" is not a guess the screen makes.
 *
 * A CODE THAT DOES NOT APPLY IS STILL STORED, with `applies: false`. That sounds wrong and is not: a code
 * below its minimum becomes valid when the customer adds another item, and clearing it on the first
 * rejection would mean they have to type it again. The board's error — "That code isn't valid. Check the
 * spelling or try another." — is for `unknown_code`, which IS cleared, because a misspelling never becomes
 * valid.
 */
router.put(
  '/:slug/cart/promo',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const body = bodyOf(req.body);

    const raw = body['code'];
    if (raw !== null && typeof raw !== 'string') {
      throw badRequest('Type the code exactly as you were given it.', 'INVALID_CODE');
    }
    const code = raw === null || raw.trim() === '' ? null : raw.trim().toUpperCase();
    // Same shape as promotions.code, so a code no promotion could have is refused here rather than by a
    // constraint. 32 characters is that column's own bound.
    if (code !== null && !/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
      throw badRequest('That code isn’t valid. Check the spelling or try another.', 'UNKNOWN_CODE');
    }

    const cartId = await cartOf(req, store.id);
    if (cartId === null) throw notFound('Your cart is empty.', 'NO_CART');

    if (code === null) {
      await carts.setPromoCode(cartId, null);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ promo: null, cart: (await carts.read(cartId)) ?? EMPTY });
      return;
    }

    const quoted = await checkout.quotePromo(store.id, cartId, code);

    // A misspelling is the one outcome that is not worth keeping.
    if (quoted.status === 'unknown_code') {
      await carts.setPromoCode(cartId, null);
      throw badRequest('That code isn’t valid. Check the spelling or try another.', 'UNKNOWN_CODE');
    }

    await carts.setPromoCode(cartId, code);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      promo: { code, applies: quoted.status === 'applied', reason: quoted.status, amount: quoted.amount },
      cart: (await carts.read(cartId)) ?? EMPTY,
    });
  }),
);

export default router;