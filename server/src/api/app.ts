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
import { writeFreeze } from '../middleware/writeFreeze.ts';
import { issueCsrfToken, requireCsrf } from '../auth/csrf.ts';
import { errorHandler, unmatchedRoute } from './errorHandler.ts';
import sessionRoutes from '../routes/session.ts';
import storeConfigRoutes from '../routes/storeConfig.ts';
import storeThemeRoutes from '../routes/storeTheme.ts';
import { storeKycRoutes } from '../routes/storeKyc.ts';
import storeExportRoutes from '../routes/storeExports.ts';
import onboardingRoutes from '../routes/onboarding.ts';
import adminRoutes from '../routes/admin.ts';
import adminMoneyRoutes from '../routes/adminMoney.ts';
import adminOpsRoutes from '../routes/adminOps.ts';
import lookupRoutes from '../routes/lookup.ts';
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
import urubutoWebhookRoutes from '../routes/urubutoWebhook.ts';
import storefrontCheckoutRoutes from '../routes/storefrontCheckout.ts';
import storefrontAccountRoutes from '../routes/storefrontAccount.ts';
import storeDashboardRoutes from '../routes/storeDashboard.ts';
import storeAnalyticsRoutes from '../routes/storeAnalytics.ts';
import storeCategoriesRoutes from '../routes/storeCategories.ts';
import storeComplaintsRoutes from '../routes/storeComplaints.ts';
import storeCustomersRoutes from '../routes/storeCustomers.ts';
import storeReviewsRoutes from '../routes/storeReviews.ts';
import storeOrderRoutes from '../routes/storeOrders.ts';
import storeProductsRoutes from '../routes/storeProducts.ts';
import { mediaRouter, uploadRouter } from '../routes/storeUploads.ts';
import riderAppRoutes from '../routes/riderApp.ts';
import storeRidersRoutes from '../routes/storeRiders.ts';
import storeShellRoutes from '../routes/storeShell.ts';
import storeNotificationRoutes from '../routes/storeNotifications.ts';
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
  // Milestone 19. The dashboard and the notification panel ask for orders.read; the pause switch asks for
  // orders.update, because pausing is what the person in the kitchen does and settings is not where that lives.
  'orders.read',
  'orders.update',
  // Milestone 20. V001 seeded this for owner/admin/manager from the start — Auth's invite screen already
  // promised a manager could "assign riders" — but nothing asked for it until the Orders board's picker did.
  'orders.assign_rider',
  // Milestone 21. V001 seeded these for 'rider' at the very start (§5.4: "their own deliveries only"),
  // and nothing asked for them until the rider's own app did — the same gap orders.assign_rider closed.
  'deliveries.own_read',
  'deliveries.own_update',
  // Milestone 22: the catalogue's admin. V001 seeded it for owner/admin/manager at the start.
  'products.write',
  // Milestone 24. V026 adds these three; analytics asks the wallet.read already required above.
  'support.write',
  'customers.read',
  'customers.write',
  // Milestone 27: the platform team's. V001 listed them explicitly (no wildcard) and nothing asked for them until the admin console.
  'merchants.read',
  'stores.suspend',
  'kyc.review',
  'audit.read',
  // Milestone 27 part B.
  'payouts.process',
  'refunds.approve',
  'disputes.resolve',
  'payment_methods.manage',
  'currencies.manage',
  // Milestone 27 part C.
  'plans.manage',
  'templates.manage',
  'platform_settings.manage',
  'platform_members.create',
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

  // Milestone 30's cutover switch. Ahead of everything else so a frozen write never reaches a rate
  // limiter, CSRF, or a route — see middleware/writeFreeze.ts for why it's shared with the legacy app.
  app.use(writeFreeze);

  // Backstop. Per-route limiters, where a route needs one, run before it.
  app.use('/api', globalLimiter);

  // Health first, and outside the CSRF layer: it is a GET, a load balancer calls it, and it changes
  // nothing.
  app.use('/api/health', healthRoutes);

  // THE PAYMENT WEBHOOK(S), also outside the CSRF layer, which is the exception the note below anticipates.
  // Neither provider can echo a double-submit cookie. momoWebhook is safe because its callback GRANTS
  // NOTHING: the body is ignored and the real status is re-read from MoMo's authenticated endpoint — still
  // mounted, because disbursements (payouts) stay on MoMo (see payments/momo.ts's header). urubutoWebhook
  // (decided 2026-10-25, collections only) hands out a JWT on /auth, which the one place here that DOES
  // need its own secret, because unlike MoMo's it grants access to a callback endpoint. See
  // routes/momoWebhook.ts and routes/urubutoWebhook.ts.
  app.use('/api/momo', momoWebhookRoutes);
  app.use('/api/urubuto', urubutoWebhookRoutes);

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
  // Milestone 26: a stranger becomes a merchant. Public by nature; rate-limited like sign-in. See the router's header.
  app.use('/api/onboarding', onboardingRoutes);
  // Milestone 28: "Did you mean …?" for a mistyped store address. Public; offers at most one live store within two typos.
  app.use('/api/lookup', lookupRoutes);
  // Milestone 27: the Vendlyfy team. Every route names a PLATFORM permission; none is reachable by a store role. See the router's header.
  app.use('/api/admin', adminRoutes);
  app.use('/api/admin', adminMoneyRoutes);
  app.use('/api/admin', adminOpsRoutes);

  // THE STORE IS IN THE PATH. Not in a header, not in the body, and with no fallback to
  // "the first active store" — the three things the old resolveTenant() did. The guard
  // on each of these reads the membership for the :storeId it is mounted under, so a
  // caller naming a store they do not work at gets 403 from the store they named.
  app.use('/api/stores/:storeId/members', membersRoutes);
  app.use('/api/stores/:storeId/members/:userId/password', staffPasswordRouter);
  app.use('/api/stores/:storeId/invites', storeInvitesRouter);
  app.use('/api/stores/:storeId/wallet', walletRouter);
  app.use('/api/stores/:storeId/payouts', payoutsRouter);
  // The console's frame, loaded once per session: the store, the currency, the config, the published theme and
  // the sidebar's badges. Every console screen reads it, so it is guarded by the lowest permission any console
  // role holds — see the route's header.
  app.use('/api/stores/:storeId/shell', storeShellRoutes);
  // The pause switch lives under /dashboard/accepting rather than at its own mount, so nothing has two URLs.
  app.use('/api/stores/:storeId/dashboard', storeDashboardRoutes);
  // Milestone 19 shipped accept() alone, for the new-order alert. Milestone 20 fills in the rest: the board, the
  // list, declining, the rider picker, cash confirmation and returns.
  app.use('/api/stores/:storeId/orders', storeOrderRoutes);
  // The rider's own app — their jobs, their availability, their own cash. Mounted separately from
  // /orders because its permission is deliveries.own_*, not orders.*: a rider reaches none of the
  // routes above, and nothing above reaches these.
  app.use('/api/stores/:storeId/rider', riderAppRoutes);
  // The merchant's own "Riders & cash" — the roster and the end-of-day settlement.
  app.use('/api/stores/:storeId/riders', storeRidersRoutes);
  // Milestone 22: the catalogue's admin. One permission, products.write — see storeProducts.ts.
  app.use('/api/stores/:storeId/products', storeProductsRoutes);
  app.use('/api/stores/:storeId/categories', storeCategoriesRoutes);
  app.use('/api/stores/:storeId/uploads', uploadRouter);
  // Milestone 24: support and insight. See each router's header for the permission it asks.
  app.use('/api/stores/:storeId/complaints', storeComplaintsRoutes);
  app.use('/api/stores/:storeId/reviews', storeReviewsRoutes);
  app.use('/api/stores/:storeId/customers', storeCustomersRoutes);
  app.use('/api/stores/:storeId/analytics', storeAnalyticsRoutes);
  app.use('/api/stores/:storeId/notifications', storeNotificationRoutes);
  app.use('/api/stores/:storeId/settings', storeSettingsRoutes);
  app.use('/api/stores/:storeId/config', storeConfigRoutes);
  app.use('/api/stores/:storeId/theme', storeThemeRoutes);
  app.use('/api/stores/:storeId/kyc', storeKycRoutes);
  // Milestone 28: files that leave the screen. Audited.
  app.use('/api/stores/:storeId/exports', storeExportRoutes);

  // Product photos, served from whichever ImageStore is configured. PUBLIC and GET-only: a storefront <img>
  // carries no session, and the name is 128 random bits.
  app.use('/api/media', mediaRouter);

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
  app.use('/api/storefront', storefrontAccountRoutes);
  // Last of the six, because '/:slug' is the least specific pattern among them. Express matches by
  // pattern rather than by order for these, but a reader should not have to know that to be sure.
  app.use('/api/storefront', storefrontStoreRoutes);

  // Anything unmatched becomes a 404 through the same handler as everything else, so
  // there is one response shape for every failure.
  app.use((_req, _res, next) => next(unmatchedRoute()));

  app.use(errorHandler);

  return app;
}
