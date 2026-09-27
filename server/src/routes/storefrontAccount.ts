// server/src/routes/storefrontAccount.ts — milestone 18, from project/CustomerAccount.dc.html.
//
//   GET    /:slug/account                      who they are, their orders, their complaints, their addresses
//   POST   /:slug/account                      create one, at this store only
//   POST   /:slug/account/claim-order          a guest keeps the order they just placed
//   POST   /:slug/cart/claim                   sign-in mid-checkout: the cart comes with them
//   POST   /:slug/account/addresses            save one
//   PUT    /:slug/account/addresses/:id/default
//   DELETE /:slug/account/addresses/:id
//   POST   /:slug/orders/:code/reorder         "Order this again"
//   POST   /:slug/orders/:code/complaints      "Something wrong? Tell the store"
//   POST   /:slug/account/complaints/:id/reopen
//
// ONE ACCOUNT PER STORE, WHICH IS THE POINT RATHER THAN A LIMITATION. The board says it twice — "This
// account is only for Nyama & Co. Other stores on Vendlyfy ask separately" — and V001 made it structural:
// `scope = 'store'` with a store_id, and email unique WITHIN that store. So the same email can hold a
// customer account at three shops and a staff identity besides, each with its own password. §5.4 records why
// that shape exists at all: "scoping the sign-in lookup wrongly once locked real users out of production."
//
// REGISTERING DOES NOT SIGN ANYBODY IN FOR FREE. It creates the account and then issues a session the same
// way POST /api/session does, because the alternative — returning success and making the client sign in again
// with the password it just chose — is two round trips and a worse failure mode if the second one fails.

import { Router } from 'express';
import type { Request } from 'express';
import { badRequest, conflict, forbidden, notFound, withTransaction } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { authOf, isUuid, requireSession } from '../middleware/authorize.ts';
import { currentCustomer, resolveStorefront, storeOf } from '../middleware/storefront.ts';
import { readShopperId, clearShopperCookie } from '../auth/shopper.ts';
import { setSessionCookie, signSessionToken } from '../auth/sessionToken.ts';
import { checkPassword } from '../auth/password.ts';
import { bodyOf, optionalString, requiredEmail, requiredString } from '../api/validate.ts';
import * as carts from '../repositories/carts.ts';
import * as customers from '../repositories/customers.ts';
import * as orders from '../repositories/orders.ts';
import * as users from '../repositories/users.ts';

const router = Router();

/**
 * The shape a tracking code may have.
 *
 * MATCHING V004'S COLUMN, not place_order()'s output, and the difference is the point. place_order() generates
 * 32 hex characters, but `orders_tracking_code_format` allows 12 to 64 — and the seeded orders use
 * `trk_…`, as will every order the ETL brings across at milestone 29 from a system with its own format.
 * Validating the generator's shape here made every order that predates V019 unreachable through the
 * storefront, which a test on a delivered seeded order found immediately.
 *
 * It is still worth checking: the code goes into a URL and a database lookup, and a bounded character set is
 * one less thing for either to be surprised by. It is not what makes the code safe — 32 random characters is.
 */
const TRACKING_CODE = /^[A-Za-z0-9_-]{12,64}$/;

/**
 * The board's three password rules, milestone 15's implementation.
 *
 * A customer's password is held to the same bar as a merchant's, because it protects a saved address and an
 * order history. checkPassword() returns all three rules with a pass flag — the shape the live checklist on
 * the screen needs — so this reports the FIRST one that failed, which is the sentence to show.
 */
function assertPasswordIsStrong(
  password: string,
  storeName: string,
  email: string,
  phone: string | null,
): void {
  const failed = checkPassword(password, {
    storeName,
    email,
    ...(phone === null ? {} : { phone }),
  }).find((rule) => !rule.passed);
  if (failed !== undefined) throw badRequest(failed.label, 'WEAK_PASSWORD');
}

/** The signed-in customer of this store, or a 401. Everything below the account's front door needs one. */
async function customerOf(req: Request, storeId: string): Promise<string> {
  const customerId = await currentCustomer(req, storeId);
  if (customerId === null) {
    throw forbidden('Sign in to see your account.', 'NOT_A_CUSTOMER');
  }
  return customerId;
}

// ---------------------------------------------------------------------------
router.get(
  '/:slug/account',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const customerId = await customerOf(req, store.id);

    // Sequential rather than Promise.all: milestone 11 found that concurrent queries on one client produce
    // unhandled rejections the moment a transaction aborts, and this reads four things.
    const profile = await customers.profile(store.id, customerId);
    if (profile === null) throw forbidden('Sign in to see your account.', 'NOT_A_CUSTOMER');

    const orderPage = await customers.orders(customerId, { limit: 20 });
    const complaints = await customers.complaints(store.id, customerId);
    const addresses = await customers.addresses(customerId);

    res.setHeader('Cache-Control', 'no-store');
    res.json({ customer: profile, orders: orderPage.items, nextCursor: orderPage.nextCursor, complaints, addresses });
  }),
);

/**
 * Create an account at this store.
 *
 * AN EMAIL ALREADY REGISTERED HERE IS A 409 AND NOT A SIGN-IN, which is milestone 11's decision applied to
 * customers: attaching to an existing identity would hand the caller somebody else's saved addresses and order
 * history on the strength of knowing their email. The board's own answer is the other button — "I have an
 * account" — so the client has somewhere to go.
 */
router.post(
  '/:slug/account',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const body = bodyOf(req.body);

    const name = requiredString(body, 'name', { min: 2, max: 120 });
    const email = requiredEmail(body);
    const password = requiredString(body, 'password', { max: 200 });
    const phone = optionalString(body, 'phone', { max: 32 });

    assertPasswordIsStrong(password, store.name, email, phone);

    const created = await withTransaction(async (tx) => {
      const existing = await users.findCustomerByEmail(store.id, email, tx);
      if (existing !== null) {
        throw conflict(
          'There is already an account with that email at this store. Sign in instead.',
          'ACCOUNT_EXISTS',
        );
      }
      return users.createCustomer(store.id, { name, email, phone, password }, tx);
    });

    // Signed in immediately, on the password they just chose. `remembered: false` — a session cookie, because
    // nobody asked to be remembered on a shared phone at a shop counter.
    setSessionCookie(res, signSessionToken(created.id, { sessionVersion: 1 }), { remembered: false });

    // And the cart comes with them, which is the whole promise of signing in at checkout.
    const sessionId = readShopperId(req);
    let merged = { cartId: null as string | null, linesMoved: 0, quantityMerged: 0 };
    if (sessionId !== null) {
      merged = await customers.claimCart(store.id, created.id, sessionId);
      clearShopperCookie(res);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      customer: { id: created.id, name, email, phone },
      cart: merged.cartId === null ? null : await carts.read(merged.cartId),
    });
  }),
);

/**
 * The cart follows a customer who signs in halfway through checkout.
 *
 * "Your cart (3 items) stays exactly as it is." Called after POST /api/session succeeds, because the session
 * route knows nothing about carts and should not: it is the one endpoint every persona shares, and a
 * storefront concern inside it would run for merchant staff and the Vendlyfy team too.
 *
 * IDEMPOTENT. Called twice, the second call finds no anonymous cart and reports nothing moved.
 */
router.post(
  '/:slug/cart/claim',
  resolveStorefront(),
  requireSession,
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const { context } = authOf(req);

    if (context.scope !== 'store' || context.customerStoreId !== store.id) {
      throw forbidden('That account does not shop at this store.', 'NOT_A_CUSTOMER');
    }

    const sessionId = readShopperId(req);
    if (sessionId === null) {
      // Nothing anonymous to bring. Not an error: they may have signed in before adding anything.
      const cartId = await carts.findId(store.id, { userId: context.userId });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ cart: cartId === null ? null : await carts.read(cartId), merged: { lines: 0, quantities: 0 } });
      return;
    }

    const merged = await customers.claimCart(store.id, context.userId, sessionId);
    // The cookie is cleared because the cart it pointed at is gone — the account's is theirs now.
    clearShopperCookie(res);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      cart: merged.cartId === null ? null : await carts.read(merged.cartId),
      merged: { lines: merged.linesMoved, quantities: merged.quantityMerged },
    });
  }),
);

/**
 * "Add a password and this order, your address and phone are saved to an account."
 *
 * THE TRACKING CODE IS THE PROOF. A guest has no session, so the only thing distinguishing them from a
 * stranger is the 32-character code they were just given. Without requiring it, this endpoint would let
 * anybody claim any guest order by guessing an id.
 */
router.post(
  '/:slug/account/claim-order',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const body = bodyOf(req.body);

    const code = requiredString(body, 'trackingCode', { min: 12, max: 64 });
    if (!TRACKING_CODE.test(code)) throw notFound('No order with that reference.', 'NO_SUCH_ORDER');

    const order = await orders.findByTrackingCode(store.id, code);
    if (order === null) throw notFound('No order with that reference.', 'NO_SUCH_ORDER');

    const name = requiredString(body, 'name', { min: 2, max: 120 });
    const email = requiredEmail(body);
    const password = requiredString(body, 'password', { max: 200 });
    const phone = optionalString(body, 'phone', { max: 32 });

    assertPasswordIsStrong(password, store.name, email, phone);

    const created = await withTransaction(async (tx) => {
      const existing = await users.findCustomerByEmail(store.id, email, tx);
      if (existing !== null) {
        throw conflict(
          'There is already an account with that email at this store. Sign in instead.',
          'ACCOUNT_EXISTS',
        );
      }
      const account = await users.createCustomer(store.id, { name, email, phone, password }, tx);
      // Both in one transaction: an account without its order is the offer half-kept.
      await customers.claimGuestOrder(order.id, account.id, 'Home', tx);
      return account;
    });

    setSessionCookie(res, signSessionToken(created.id, { sessionVersion: 1 }), { remembered: false });

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ customer: { id: created.id, name, email, phone }, claimed: order.orderNumber });
  }),
);

// ---------------------------------------------------------------------------
router.post(
  '/:slug/account/addresses',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const customerId = await customerOf(req, store.id);
    const body = bodyOf(req.body);

    const label = requiredString(body, 'label', { min: 1, max: 40 });
    const address = requiredString(body, 'address', { min: 4, max: 500 });

    const saved = await customers.addAddress(customerId, label, address).catch((error: unknown) => {
      // The unique index on (user_id, lower(label)) is what refuses a second "Home". Translated here because
      // "that name is taken" is the useful sentence and a constraint name is not.
      if (error instanceof Error && error.message.includes('customer_addresses_user_label_key')) {
        throw conflict('You already have an address called that.', 'LABEL_TAKEN');
      }
      throw error;
    });

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ address: saved, addresses: await customers.addresses(customerId) });
  }),
);

router.put(
  '/:slug/account/addresses/:addressId/default',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const customerId = await customerOf(req, store.id);
    const addressId = req.params['addressId'];
    if (!isUuid(addressId)) throw badRequest('That is not one of your addresses.', 'INVALID_ADDRESS');

    // set_default_address() refuses an address that is not theirs, which is the access check as well as the
    // arithmetic — so a guessed id gets the same answer as a missing one.
    await customers.makeDefaultAddress(customerId, addressId).catch(() => {
      throw notFound('That is not one of your addresses.', 'NO_SUCH_ADDRESS');
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({ addresses: await customers.addresses(customerId) });
  }),
);

router.delete(
  '/:slug/account/addresses/:addressId',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const customerId = await customerOf(req, store.id);
    const addressId = req.params['addressId'];
    if (!isUuid(addressId)) throw badRequest('That is not one of your addresses.', 'INVALID_ADDRESS');

    // Deleting something already gone is not an error, for the reason the cart's Remove has: the button can be
    // tapped twice.
    await customers.removeAddress(customerId, addressId);

    res.setHeader('Cache-Control', 'no-store');
    res.json({ addresses: await customers.addresses(customerId) });
  }),
);

// ---------------------------------------------------------------------------
/**
 * "Order this again".
 *
 * ADDS WHAT IT CAN AND SAYS WHAT IT COULD NOT, which is the board's own message: "Added 1 of 2 items. Fries
 * are sold out today." V020's reorder_into_cart() decides that; this turns the counts into the sentence.
 */
router.post(
  '/:slug/orders/:code/reorder',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const code = req.params['code'];
    if (typeof code !== 'string' || !TRACKING_CODE.test(code)) {
      throw notFound('No order with that reference.', 'NO_SUCH_ORDER');
    }

    const order = await orders.findByTrackingCode(store.id, code);
    if (order === null) throw notFound('No order with that reference.', 'NO_SUCH_ORDER');

    // A cart is needed, and a shopper who has none yet gets one — reordering is a reason to have a cart.
    const customerId = await currentCustomer(req, store.id);
    const sessionId = readShopperId(req);
    const owner: carts.CartOwner | null =
      customerId !== null ? { userId: customerId } : sessionId !== null ? { sessionId } : null;
    if (owner === null) {
      throw badRequest('Open the shop first, then order it again.', 'NO_CART');
    }

    const result = await withTransaction(async (tx) => {
      const cartId = await carts.findOrCreateId(store.id, owner, tx);
      const outcome = await customers.reorder(cartId, order.id, tx);
      return { cartId, outcome };
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      added: result.outcome.added,
      skipped: result.outcome.skipped,
      skippedNames: result.outcome.skippedNames,
      cart: await carts.read(result.cartId),
    });
  }),
);

/**
 * "Something wrong? Tell the store."
 *
 * A COMPLAINT NEEDS AN ACCOUNT, and V008 decides that rather than this route: file_complaint() takes the
 * customer from the ORDER, so a guest order has nobody to attach a complaint to. The board agrees — the
 * complaint screens are inside the account.
 */
router.post(
  '/:slug/orders/:code/complaints',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const customerId = await customerOf(req, store.id);

    const code = req.params['code'];
    if (typeof code !== 'string' || !TRACKING_CODE.test(code)) {
      throw notFound('No order with that reference.', 'NO_SUCH_ORDER');
    }

    const order = await orders.findByTrackingCode(store.id, code);
    if (order === null) throw notFound('No order with that reference.', 'NO_SUCH_ORDER');

    const body = bodyOf(req.body);
    const reason = body['reason'];
    if (
      typeof reason !== 'string' ||
      !(customers.COMPLAINT_REASONS as readonly string[]).includes(reason)
    ) {
      throw badRequest('Choose what went wrong.', 'INVALID_REASON');
    }
    const detail = requiredString(body, 'detail', { min: 3, max: 2000 });

    const id = await customers.fileComplaint(
      order.id,
      reason as customers.ComplaintReason,
      detail,
      customerId,
    );

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      complaint: { id, reason, detail, status: 'open' },
      complaints: await customers.complaints(store.id, customerId),
    });
  }),
);

/** "Not sorted? Reopen" */
router.post(
  '/:slug/account/complaints/:complaintId/reopen',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const customerId = await customerOf(req, store.id);
    const complaintId = req.params['complaintId'];
    if (!isUuid(complaintId)) throw badRequest('That is not one of your reports.', 'INVALID_COMPLAINT');

    // Theirs, at this store. Checked here because reopen_complaint() takes a side rather than an owner, and a
    // complaint id is not an access rule.
    const mine = (await customers.complaints(store.id, customerId)).find((c) => c.id === complaintId);
    if (mine === undefined) throw notFound('That is not one of your reports.', 'NO_SUCH_COMPLAINT');
    if (!mine.canReopen) {
      throw conflict('That report is already open with the store.', 'ALREADY_OPEN');
    }

    const note = optionalString(req.body === undefined ? {} : bodyOf(req.body), 'note', { max: 2000 });
    await customers.reopenComplaint(complaintId, customerId, note ?? 'Reopened by the customer');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ complaints: await customers.complaints(store.id, customerId) });
  }),
);

export default router;
