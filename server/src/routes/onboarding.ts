// server/src/routes/onboarding.ts — milestone 26: "Create your store".
//
//   GET  /api/onboarding/templates        the business types a new merchant can pick (public)
//   GET  /api/onboarding/slug?name=…      the store address that name would get, and whether it is free (public)
//   POST /api/onboarding                  account + store in one transaction, and signs the new owner in
//
// PUBLIC, because the caller has no account yet — which is also why the write is behind the same rate limit as sign-in:
// an unauthenticated endpoint that creates rows is the one an attacker would script, and what it costs them is the
// bcrypt hash this route has to compute anyway.
//
// IT SIGNS THE PERSON IN. A merchant who has just typed a password into this form should land in their own console, not
// on a sign-in page asking for it again. The cookie is the same one POST /api/session sets, at the same cost.
//
// THE REST OF ONBOARDING IS NOT HERE. Steps 2 and 3 (logo and colour, first product) are the ordinary Customize and
// Products endpoints, which the new owner can call because they now hold the owner role — no second, onboarding-only
// way to write a theme or a product exists to drift from the real one.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, optionalString, requiredEmail, requiredString } from '../api/validate.ts';
import { badRequest, db, withTransaction } from '../db/index.ts';
import { setSessionCookie, signSessionToken, ttlFor } from '../auth/sessionToken.ts';
import * as config from '../repositories/config.ts';
import * as onboarding from '../repositories/onboarding.ts';
import { authLimiter } from '../middleware/rateLimit.js';

const router = Router();

/** The same floor as a staff password (routes/members.ts): ten characters. */
const MIN_PASSWORD = 10;

router.get(
  '/templates',
  asyncHandler(async (_req, res) => {
    res.json({ templates: await config.offeredTemplates(db) });
  }),
);

router.get(
  '/slug',
  asyncHandler(async (req, res) => {
    const name = typeof req.query['name'] === 'string' ? req.query['name'].slice(0, 120) : '';
    res.json(await onboarding.suggestSlug(name));
  }),
);

router.post(
  '/',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = bodyOf(req.body);
    const name = requiredString(body, 'name', { min: 2, max: 120 });
    const email = requiredEmail(body);
    const phone = optionalString(body, 'phone', { max: 40 });
    const password = requiredString(body, 'password', { min: MIN_PASSWORD, max: 200 });
    const businessName = requiredString(body, 'businessName', { min: 2, max: 80 });
    const templateKey = optionalString(body, 'templateKey', { max: 60 });

    // The slug is the person's to choose only by choosing the name; an explicit one is accepted if it is still free.
    const wanted = optionalString(body, 'slug', { max: 63 });
    const slug = wanted ?? (await onboarding.suggestSlug(businessName)).slug;
    if (slug === '') throw badRequest('Use letters or numbers in your business name.', 'SLUG_INVALID');

    const created = await withTransaction((tx) => onboarding.createMerchant({ name, email, phone, password, businessName, slug, templateKey }, tx), {
      label: 'POST /api/onboarding',
      retries: 0,
    });

    const token = signSessionToken(created.userId, { sessionVersion: created.sessionVersion, expiresInSeconds: ttlFor(false) });
    setSessionCookie(res, token, { remembered: false });

    res.status(201).json({ storeId: created.storeId, slug: created.slug, userId: created.userId });
  }),
);

export default router;
