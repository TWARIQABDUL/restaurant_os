// server/src/auth/shopper.ts — milestone 16.
//
// How the server recognises a shopper who is not signed in.
//
// A cart has to survive a page reload for somebody who has not made an account, and §2.5 forbids
// keeping it in the page: "Browser storage is never the source of truth, and every screen must render
// correctly with it empty, blocked or unavailable." So the cart is a row and the browser holds nothing
// but an opaque pointer to it, in a cookie the server set and the page cannot read.
//
// WHY httpOnly WHEN THE PAGE NEVER NEEDS IT. Because holding this value IS holding the cart — V003
// bounds its length at the column for that reason — and a value no script needs is a value no script
// should be able to steal. It differs from the CSRF cookie, which is readable precisely because
// echoing it is the mechanism.
//
// IT IS NOT A SESSION AND CARRIES NO AUTHORITY. It names a cart. It does not say who anybody is, it
// cannot be used to read an order, and a stolen one costs its owner a shopping list. That is why it is
// not signed: there is nothing to forge except somebody else's cart, and the value is 32 random bytes.
//
// ISSUED LATE, ON PURPOSE. Nothing is set while a shopper only browses — a cookie banner's worth of
// complexity for a visitor who never adds anything. The cookie appears on the first write to a cart.
//
// ONE COOKIE FOR EVERY STORE, not one per store. `carts` is unique per (store, session), so the same
// pointer resolves to a different cart at each shopfront, and a shopper with a bag at two stores has
// two carts and one cookie. Whether those shopfronts share a host at all is Part 9's open domain
// question; this works either way, which is the point of not encoding the store in it.

import type { Request, Response } from 'express';

const COOKIE_NAME = 'vf_shopper';

/** Seven days, matching carts.expires_at — a pointer that outlives every cart it could name is litter. */
const TTL_SECONDS = 7 * 24 * 60 * 60;

/** What V003's carts_session_id_length allows. A value outside it cannot name a cart, so it is ignored. */
const SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

/** The shopper id this request carries, or null. Never throws: a malformed cookie is simply nobody. */
export function readShopperId(req: Request): string | null {
  const raw = (req.cookies as Record<string, unknown> | undefined)?.[COOKIE_NAME];
  return typeof raw === 'string' && SHAPE.test(raw) ? raw : null;
}

export function setShopperCookie(res: Response, sessionId: string): void {
  res.cookie(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: TTL_SECONDS * 1000,
  });
}

export function clearShopperCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}
