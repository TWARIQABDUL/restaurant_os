// server/src/middleware/storefront.ts — milestone 16.
//
// Every storefront route starts the same way: a slug in the path becomes a store, or the request is
// over. Four routes needed it, so it is here once.
//
// KEYED BY SLUG, UNAUTHENTICATED, for the reasons routes/storefrontConfig.ts sets out at length — a
// slug is already in the URL a shopper typed, a store uuid is not, and milestone 11 went to some
// trouble to make store existence unobservable through the console.
//
// THIS IS WHERE A SUSPENDED STORE STOPS. storefrontConfig.ts deferred that on purpose: "It serves a
// suspended store. Refusing one is the storefront's job (milestone 16), not the config's" — because a
// suspended store's own staff still need their console's vocabulary to render the explanation. The
// shopfront is the other half of that decision, and it is here:
//
//   active      served.
//   suspended   403 STORE_SUSPENDED. ErrorPages.dc.html draws this as its own page, so it gets its
//               own code rather than being flattened into a 404.
//   pending     404, BYTE-IDENTICAL to a store that does not exist. A store awaiting approval has no
//               shopfront yet, and saying "this one exists but isn't open" would turn the storefront
//               into a way to enumerate which slugs are taken. The merchant's own view of a pending
//               store is Onboarding's (milestone 26), not this.
//
// It attaches through a Symbol rather than augmenting Express.Request, for the reason
// middleware/authorize.ts gives: an augmented request makes the property optional on every route in
// the process, so a handler whose middleware was forgotten reads `undefined` instead of failing.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { badRequest, db, forbidden, notFound, toAppError } from '../db/index.ts';
import { readToken, verifySessionToken } from '../auth/sessionToken.ts';
import { loadAuthContext } from '../repositories/authContext.ts';
import * as storefront from '../repositories/storefront.ts';

/** Same shape as stores_slug_format in V001, so a malformed slug is a 400 rather than a miss. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const STORE = Symbol('vendlyfy.storefrontStore');

type Carrier = { [STORE]?: storefront.PublicStore };

/**
 * The store this request is about.
 *
 * Throws rather than returning undefined: a handler reachable without resolveStorefront is a bug, and
 * one that reads a missing store would serve one shop's catalogue under another's name.
 */
export function storeOf(req: Request): storefront.PublicStore {
  const found = (req as Request & Carrier)[STORE];
  if (found === undefined) {
    throw new Error(
      'storeOf() called on a request that did not pass resolveStorefront. Mount the middleware.',
    );
  }
  return found;
}

/** Validate the slug, load the store, and decide whether it has a shopfront at all. */
export function resolveStorefront(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const slug = req.params['slug'];
      if (
        typeof slug !== 'string' ||
        slug.length < 2 ||
        slug.length > 63 ||
        !SLUG.test(slug)
      ) {
        throw badRequest('That is not a valid store address.', 'INVALID_SLUG');
      }

      const store = await storefront.findBySlug(slug, db);

      // One message and one code for "no such store" and "not open yet". See the header.
      if (store === null || store.status === 'pending') {
        throw notFound('No store at that address.', 'NO_SUCH_STORE');
      }

      if (store.status === 'suspended') {
        throw forbidden(
          `${store.name} is not taking orders at the moment.`,
          'STORE_SUSPENDED',
        );
      }

      (req as Request & Carrier)[STORE] = store;
      next();
    } catch (error) {
      next(toAppError(error));
    }
  };
}

/**
 * The signed-in CUSTOMER of this store, or null.
 *
 * OPTIONAL BY DESIGN, unlike every other identity check in this codebase. A shopfront serves anonymous
 * shoppers as its normal case — that is most of its traffic — so a missing, expired or revoked session
 * is not an error here. It is nobody, and the page renders for nobody. `requireSession` is still what
 * writing a review goes through, because that one needs an account.
 *
 * WHO COUNTS AS A CUSTOMER OF THIS STORE, and the answer is narrower than "signed in". V001 made
 * `scope = 'store'` mean "a customer of exactly one store", and CustomerAccount is explicit that "This
 * account is only for Nyama & Co. Other stores on Vendlyfy ask separately." So:
 *
 *   * a customer of THIS store              → the customer
 *   * a customer of a DIFFERENT store       → nobody, here
 *   * a platform identity (staff, Vendlyfy) → nobody, here
 *
 * That last one is the interesting case, and it is deliberate: a merchant browsing their own shopfront
 * while signed in to the console is not a customer of it, and giving their staff session a shopping
 * cart would mean their own test orders arrived attached to their staff account. They get an anonymous
 * cart, like any other visitor, which is also what makes "order as a customer to check it works" behave
 * the way they expect.
 *
 * THE SESSION VERSION IS STILL CHECKED. A revoked session must not keep reading a cart after a password
 * change, even where the failure mode is mild — V016's promise is about every token in the wild, and a
 * caller that quietly skipped the comparison would be a second, weaker rule.
 */
export async function currentCustomer(req: Request, storeId: string): Promise<string | null> {
  const token = readToken(req);
  if (token === null || token === undefined || token === '') return null;

  let claims: { userId: string; sessionVersion: number };
  try {
    claims = verifySessionToken(token);
  } catch {
    // An expired or tampered token is an anonymous visitor, not a 401: a shopper whose session lapsed
    // while the tab was open should see the shop, not a sign-in wall.
    return null;
  }

  const context = await loadAuthContext(null, claims.userId, db);
  if (context === null) return null;
  if (context.sessionVersion !== claims.sessionVersion) return null;
  if (context.scope !== 'store' || context.customerStoreId !== storeId) return null;
  return context.userId;
}
