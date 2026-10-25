// server/src/routes/storefrontCheckout.ts — milestone 17.
//
// GET  /api/storefront/:slug/checkout                 the quote: what this will cost and how it can be paid
// POST /api/storefront/:slug/orders                   place it
// POST /api/storefront/:slug/orders/:code/payment     ask for the money
// GET  /api/storefront/:slug/orders/:code/payment     what happened to it
//
// THE QUOTE AND THE PLACEMENT ARE RECONCILED, NOT TRUSTED. The quote returns a total; the placement is sent
// that total back and refuses to write an order at any other figure. So a price edited, a promotion that
// expired, an option withdrawn or a delivery zone changed between the two screens produces "the total
// changed" rather than a charge nobody agreed to. See place_order() in V019 — this route is the thin half.
//
// THE IDEMPOTENCY KEY IS THE CLIENT'S, AND IT MUST BE REUSED ON RETRY. That is the one thing a client can get
// wrong that this endpoint cannot fix for it: a fresh key on every attempt turns a retry into a second order.
// The client generates one when the checkout screen opens and keeps it until the order succeeds.
//
// PLACING AND PAYING ARE TWO REQUESTS, and that is not an accident of REST. place_order() runs in a
// transaction that holds stock locks; a provider call inside it would hold those locks for the length of
// somebody else's network. So the order exists, unpaid, before any money is asked for — which is also what
// makes the board's "Try again" on the failed screen a second PAYMENT rather than a second order.

import { Router } from 'express';
import type { Request } from 'express';
import { badRequest, conflict, notFound } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { isUuid } from '../middleware/authorize.ts';
import { currentCustomer, resolveStorefront, storeOf } from '../middleware/storefront.ts';
import { readShopperId } from '../auth/shopper.ts';
import { bodyOf, optionalString, requiredString } from '../api/validate.ts';
import * as carts from '../repositories/carts.ts';
import * as checkout from '../repositories/checkout.ts';
import * as collections from '../repositories/collections.ts';
import * as orders from '../repositories/orders.ts';
import { isConfigured } from '../payments/urubuto.ts';

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

async function cartOf(req: Request, storeId: string): Promise<string | null> {
  const customerId = await currentCustomer(req, storeId);
  const sessionId = readShopperId(req);
  const owner: carts.CartOwner | null =
    customerId !== null ? { userId: customerId } : sessionId !== null ? { sessionId } : null;
  return owner === null ? null : carts.findId(storeId, owner);
}

function fulfilmentOf(raw: unknown): checkout.Fulfilment {
  if (raw === 'delivery' || raw === 'pickup') return raw;
  throw badRequest('Choose delivery or pickup.', 'INVALID_FULFILMENT');
}

router.get(
  '/:slug/checkout',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const fulfilment = fulfilmentOf(req.query['fulfilment'] ?? 'delivery');

    const rawZone = req.query['zone'];
    if (rawZone !== undefined && rawZone !== '' && !isUuid(rawZone)) {
      throw badRequest('That is not a delivery area.', 'INVALID_ZONE');
    }

    const cartId = await cartOf(req, store.id);
    if (cartId === null) throw notFound('Your cart is empty.', 'NO_CART');

    const quote = await checkout.quote(store.id, cartId, {
      fulfilment,
      zoneId: isUuid(rawZone) ? rawZone : null,
    });
    if (quote === null) throw notFound('Your cart is empty.', 'NO_CART');

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      quote,
      // Every area the store delivers to, so the screen can offer them without a second request.
      deliveryOptions: await checkout.deliveryOptions(store.id),
      pickup: fulfilment === 'pickup' ? null : undefined,
    });
  }),
);

router.post(
  '/:slug/orders',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const body = bodyOf(req.body);

    // At least 16 characters, which is place_order()'s own bound and orders.idempotency_key's.
    const idempotencyKey = requiredString(body, 'idempotencyKey', { min: 16, max: 128 });
    const fulfilment = fulfilmentOf(body['fulfilment']);
    const paymentMethod = requiredString(body, 'paymentMethod', { max: 40 });
    const expectedTotal = body['expectedTotal'];
    if (typeof expectedTotal !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(expectedTotal)) {
      throw badRequest('The total is missing. Reload the checkout and try again.', 'MISSING_TOTAL');
    }

    const customerId = await currentCustomer(req, store.id);

    // A guest needs a name and a number; States is explicit that the receipt and the delivery updates go to
    // that number. A signed-in customer has both on their account already.
    const guestName = optionalString(body, 'name', { max: 120 });
    const guestPhone = optionalString(body, 'phone', { max: 32 });
    const guestEmail = optionalString(body, 'email', { max: 254 });
    if (customerId === null) {
      if (guestName === null) throw badRequest('Tell us your name for the order.', 'MISSING_NAME');
      if (guestPhone === null) {
        throw badRequest('We need a phone number to text your receipt.', 'MISSING_PHONE');
      }
    }

    const address = optionalString(body, 'address', { max: 500 });
    const rawZone = body['zone'];
    if (fulfilment === 'delivery') {
      if (address === null) {
        throw badRequest('Add a street, building or landmark the rider can find.', 'MISSING_ADDRESS');
      }
      if (!isUuid(rawZone)) throw badRequest('Choose where it is going.', 'INVALID_ZONE');
    }

    const cartId = await cartOf(req, store.id);
    if (cartId === null) throw notFound('Your cart is empty.', 'NO_CART');

    // ONE CALL. Everything that has to be atomic is inside place_order(), including the retry.
    const placed = await checkout.place({
      cartId,
      idempotencyKey,
      fulfilment,
      paymentMethod,
      expectedTotal,
      customerUserId: customerId,
      guestName,
      guestPhone,
      guestEmail,
      deliveryAddress: fulfilment === 'delivery' ? address : null,
      deliveryZoneId: fulfilment === 'delivery' && isUuid(rawZone) ? rawZone : null,
    });

    res.setHeader('Cache-Control', 'no-store');
    // 201 when this call created it, 200 when it was already there. The body is identical, so a client that
    // ignores the status still shows the right order.
    res.status(placed.created ? 201 : 200).json({
      order: {
        orderNumber: placed.orderNumber,
        trackingCode: placed.trackingCode,
        total: placed.total,
        cashDue: placed.cashDue,
        paymentMethod,
      },
      created: placed.created,
      // Cash needs no provider: the order is placed and the rider collects. Anything else needs a payment.
      needsPayment: paymentMethod !== 'cash',
    });
  }),
);

/**
 * The order behind a tracking code, for the receipt and the timeline.
 *
 * THE CODE IS THE CREDENTIAL. A guest order has no account behind it, so whoever holds the 32-character code
 * sees the order — which is what `Shop`'s success screen requires, and is safe only because the code is
 * random. See repositories/orders.ts.
 */
router.get(
  '/:slug/orders/:code',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const code = req.params['code'];
    if (typeof code !== 'string' || !TRACKING_CODE.test(code)) {
      throw notFound('No order with that reference.', 'NO_SUCH_ORDER');
    }

    const order = await orders.findByTrackingCode(store.id, code);
    if (order === null) throw notFound('No order with that reference.', 'NO_SUCH_ORDER');

    const attempt = order.paymentMethod === 'cash' ? null : await collections.latestForOrder(order.id);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      order,
      payment:
        attempt === null
          ? null
          : { status: attempt.status, message: attempt.providerMessage, phone: attempt.phone },
    });
  }),
);

/**
 * Ask for the money.
 *
 * SEPARATE FROM PLACING, and idempotent on the ORDER rather than on a key: an order may be charged once, so
 * "is there already an attempt for this order" is the whole question. `momo_one_pending_per_order` answers it
 * under concurrency — two simultaneous calls cannot both insert, and the loser reads the winner's row.
 */
router.post(
  '/:slug/orders/:code/payment',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const code = req.params['code'];
    if (typeof code !== 'string' || !TRACKING_CODE.test(code)) {
      throw notFound('No order with that reference.', 'NO_SUCH_ORDER');
    }

    const order = await orders.findByTrackingCode(store.id, code);
    if (order === null) throw notFound('No order with that reference.', 'NO_SUCH_ORDER');

    if (order.paymentMethod === 'cash') {
      throw conflict('This order is paid in cash when it arrives.', 'CASH_ON_DELIVERY');
    }
    if (order.paymentStatus !== 'unpaid') {
      // Not an error the customer should see as a failure: their order is paid, and the client should show
      // the receipt.
      res.json({ payment: { status: 'successful' }, alreadyPaid: true });
      return;
    }

    const body = bodyOf(req.body);
    // The number to charge, which may not be the one on the order: the board's failed screen offers another
    // method, and a customer may pay from a different phone than the one they gave for delivery updates.
    const phone = optionalString(body, 'phone', { max: 32 }) ?? order.placedFor;
    if (phone === null || phone.trim() === '') {
      throw badRequest('Which number should we ask?', 'MISSING_PHONE');
    }

    if (!isConfigured()) {
      // Said plainly rather than hidden behind a generic failure. Part 9: where provider credentials live is
      // an open decision, so a deployment without them is an expected state and must not look like a bug in
      // the order.
      throw conflict(
        'Mobile money is not available on this deployment yet. Choose cash on delivery.',
        'PAYMENTS_NOT_CONFIGURED',
      );
    }

    const result = await collections.start(order.id, phone);

    res.setHeader('Cache-Control', 'no-store');
    if (result.outcome === 'already_paid') {
      res.json({ payment: { status: 'successful' }, alreadyPaid: true });
      return;
    }

    res.status(result.outcome === 'requested' ? 202 : 200).json({
      payment: {
        status: 'pending',
        phone: result.attempt.phone,
        amount: result.attempt.amount,
        reference: result.attempt.referenceId,
      },
      // An attempt that was already in flight is the common case on a second tap.
      started: result.outcome === 'requested',
      ...(result.outcome === 'provider_unavailable' ? { warning: result.message } : {}),
    });
  }),
);

/**
 * What actually happened to the payment.
 *
 * THE PENDING SCREEN POLLS THIS, and it re-reads the status from MoMo's authenticated endpoint rather than
 * from the row — because the row is only as fresh as the last thing that told it something, and a customer
 * watching a spinner is the one person who needs the truth now.
 */
router.get(
  '/:slug/orders/:code/payment',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);
    const code = req.params['code'];
    if (typeof code !== 'string' || !TRACKING_CODE.test(code)) {
      throw notFound('No order with that reference.', 'NO_SUCH_ORDER');
    }

    const order = await orders.findByTrackingCode(store.id, code);
    if (order === null) throw notFound('No order with that reference.', 'NO_SUCH_ORDER');

    res.setHeader('Cache-Control', 'no-store');

    if (order.paymentStatus !== 'unpaid') {
      res.json({ payment: { status: 'successful' }, order: { paymentStatus: order.paymentStatus } });
      return;
    }
    if (order.paymentMethod === 'cash') {
      res.json({ payment: null, order: { paymentStatus: order.paymentStatus } });
      return;
    }

    const attempt = await collections.latestForOrder(order.id);
    if (attempt === null) {
      res.json({ payment: null, order: { paymentStatus: order.paymentStatus } });
      return;
    }

    // Only a pending attempt is worth asking the provider about, and only when there is a provider.
    let status = attempt.status;
    let message = attempt.providerMessage;
    if (attempt.status === 'pending' && isConfigured()) {
      const refreshed = await collections.refresh(attempt.referenceId);
      if (refreshed !== null) {
        status = refreshed.status;
        message = refreshed.message;
      }
    }

    res.json({
      payment: { status, message, phone: attempt.phone, amount: attempt.amount },
      order: { paymentStatus: status === 'successful' ? 'paid' : order.paymentStatus },
    });
  }),
);

export default router;
