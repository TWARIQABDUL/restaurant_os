// server/src/api/app.ts — milestone 11.
//
// THE NEW SERVER. Express, pg, and nothing else between a request and the database.
//
// It is a second app rather than an edit to server/src/app.js because the legacy app
// imports config/supabase.js, which refuses to start without a service_role key — so
// "boots against the local container with no supabase-js in the path" is not a state
// that app can be in. Both run side by side: the legacy one keeps serving production
// until cutover (milestone 30), and Stage D moves features onto this one, "feature by
// feature alongside the repository layer" (§2.1). At cutover server/src/app.js and its
// routers are deleted and this becomes the only app.
//
// WHAT IS MOUNTED HERE IS ALL OF IT. There are no stubs: every endpoint below reads or
// writes real rows and is complete for what it claims. Requesting a payout, placing an
// order, publishing a theme and signing in are later milestones, and they are absent
// rather than half-present.

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { globalLimiter } from '../middleware/rateLimit.js';
import { issueCsrfToken, requireCsrf } from '../auth/csrf.ts';
import { errorHandler, unmatchedRoute } from './errorHandler.ts';
import sessionRoutes from '../routes/session.ts';
import storeConfigRoutes from '../routes/storeConfig.ts';
import storeThemeRoutes from '../routes/storeTheme.ts';
import storefrontConfigRoutes from '../routes/storefrontConfig.ts';
import storefrontThemeRoutes from '../routes/storefrontTheme.ts';
import storefrontStoreRoutes from '../routes/storefrontStore.ts';
import storefrontCatalogueRoutes from '../routes/storefrontCatalogue.ts';
import storefrontReviewRoutes from '../routes/storefrontReviews.ts';
import storefrontCartRoutes from '../routes/storefrontCart.ts';
import membersRoutes from '../routes/members.ts';
import storeSettingsRoutes from '../routes/storeSettings.ts';
import { payoutsRouter, walletRouter } from '../routes/storeWallet.ts';
import healthRoutes from '../routes/health.ts';
import momoWebhookRoutes from '../routes/momoWebhook.ts';
import storefrontCheckoutRoutes from '../routes/storefrontCheckout.ts';
import { publicInvitesRouter, storeInvitesRouter } from '../routes/invites.ts';
import { passwordRouter, staffPasswordRouter } from '../routes/password.ts';

/**
 * Every permission string the routers above ask for, checked against role_permissions
 * at boot by assertPermissionsExist().
 *
 * A misspelt permission is invisible at run time — it matches nobody's set, so every
 * caller gets 403 and it reads as a role problem. V001 refuses a typo'd ROLE at the
 * column for exactly that reason; this list is the same protection for the other half
 * of the pair, which no constraint can see because it lives here.
 */
export const REQUIRED_PERMISSIONS = [
  'staff.create',
  'wallet.read',
  'payouts.request',
  'settings.write',
] as const;

export function createApp(): Express {
  const app = express();

  // Render terminates TLS at a proxy. Without this every request appears to come from
  // the proxy's address, which makes the rate limiter count the whole internet as one
  // client and makes a `secure` cookie look insecure. Same reasoning as app.js.
  app.set('trust proxy', 1);

  // A JSON API on its own origin: it serves no HTML and embeds nothing, so the
  // strictest CSP costs nothing and stops a stray error page loading anything.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: { maxAge: 15552000, includeSubDomains: true },
    }),
  );

  app.use(
    cors({
      origin: process.env.CLIENT_URL ?? 'http://localhost:5173',
      // The session is an httpOnly cookie (§2.5 — no browser storage), so the browser
      // only sends it when credentials are allowed.
      credentials: true,
    }),
  );

  // Every endpoint here takes small JSON. Images go straight to storage on a signed
  // URL, and an oversized body is the cheap half of a denial of service.
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  // Backstop. Per-route limiters, where a route needs one, run before it.
  app.use('/api', globalLimiter);

  // Health first, and outside the CSRF layer: it is a GET, a load balancer calls it, and it changes
  // nothing.
  app.use('/api/health', healthRoutes);

  // THE PAYMENT WEBHOOK, also outside the CSRF layer, which is the exception the note below anticipates.
  // MTN cannot echo a double-submit cookie. It is safe because the callback GRANTS NOTHING: the body is
  // ignored and the real status is re-read from MoMo's authenticated endpoint, so a forged call only makes
  // the server ask a question it already knew the answer to. See routes/momoWebhook.ts.
  app.use('/api/momo', momoWebhookRoutes);

  // CSRF. §2.5: "Cookie-borne credentials are sent automatically, so every state-changing request needs
  // a token or a strict same-origin check."
  //
  // Issued for every request so a fresh browser has a token before its first POST — otherwise the first
  // sign-in would fail and the client would have to know to fetch something first. Required on every
  // unsafe method, mounted ONCE for the whole API rather than per route: a route added later that forgot
  // it would be a hole nobody notices. Webhooks are the only endpoints that must not have it, and they
  // are the legacy server's until Stage D moves them.
  app.use('/api', issueCsrfToken);
  app.use('/api', requireCsrf);

  // Names no store: it tells a signed-in person which stores they are a member of.
  app.use('/api/session', sessionRoutes);

  // THE STORE IS IN THE PATH. Not in a header, not in the body, and with no fallback to
  // "the first active store" — the three things the old resolveTenant() did. The guard
  // on each of these reads the membership for the :storeId it is mounted under, so a
  // caller naming a store they do not work at gets 403 from the store they named.
  app.use('/api/stores/:storeId/members', membersRoutes);
  app.use('/api/stores/:storeId/members/:userId/password', staffPasswordRouter);
  app.use('/api/stores/:storeId/invites', storeInvitesRouter);
  app.use('/api/stores/:storeId/wallet', walletRouter);
  app.use('/api/stores/:storeId/payouts', payoutsRouter);
  app.use('/api/stores/:storeId/settings', storeSettingsRoutes);
  app.use('/api/stores/:storeId/config', storeConfigRoutes);
  app.use('/api/stores/:storeId/theme', storeThemeRoutes);

  // PUBLIC, and keyed by SLUG rather than by store id. A slug is already in the storefront's
  // URL; a store uuid is not, and milestone 11 deliberately made store existence unobservable
  // through the console. The console reads this same endpoint — it has the slug from
  // GET /api/session — so the storefront and the console cannot drift on what a store calls
  // its categories. See routes/storefrontConfig.ts.
  app.use('/api/password', passwordRouter);

  // Unauthenticated, because the invitee has no account yet — the TOKEN is the credential.
  app.use('/api/invites', publicInvitesRouter);

  // THE SHOPFRONT. All six mount on the same prefix and each declares its own full path, so the
  // ORDER HERE DOES NOT MATTER — which is deliberate: `/:slug` and `/:slug/products` are different
  // patterns to Express, not a prefix and a suffix, so no route can shadow another by being mounted
  // first. The one thing that would break that is a router declaring a bare '/:slug/*' catch-all, and
  // none does.
  app.use('/api/storefront', storefrontConfigRoutes);
  app.use('/api/storefront', storefrontThemeRoutes);
  app.use('/api/storefront', storefrontCatalogueRoutes);
  app.use('/api/storefront', storefrontReviewRoutes);
  app.use('/api/storefront', storefrontCartRoutes);
  app.use('/api/storefront', storefrontCheckoutRoutes);
  // Last of the six, because '/:slug' is the least specific pattern among them. Express matches by
  // pattern rather than by order for these, but a reader should not have to know that to be sure.
  app.use('/api/storefront', storefrontStoreRoutes);

  // Anything unmatched becomes a 404 through the same handler as everything else, so
  // there is one response shape for every failure.
  app.use((_req, _res, next) => next(unmatchedRoute()));

  app.use(errorHandler);

  return app;
}
