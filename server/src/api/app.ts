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
import { errorHandler, unmatchedRoute } from './errorHandler.ts';
import sessionRoutes from '../routes/session.ts';
import storeConfigRoutes from '../routes/storeConfig.ts';
import storeThemeRoutes from '../routes/storeTheme.ts';
import storefrontConfigRoutes from '../routes/storefrontConfig.ts';
import storefrontThemeRoutes from '../routes/storefrontTheme.ts';
import membersRoutes from '../routes/members.ts';
import storeSettingsRoutes from '../routes/storeSettings.ts';
import { payoutsRouter, walletRouter } from '../routes/storeWallet.ts';
import healthRoutes from '../routes/health.ts';

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

  app.use('/api/health', healthRoutes);

  // Names no store: it tells a signed-in person which stores they are a member of.
  app.use('/api/session', sessionRoutes);

  // THE STORE IS IN THE PATH. Not in a header, not in the body, and with no fallback to
  // "the first active store" — the three things the old resolveTenant() did. The guard
  // on each of these reads the membership for the :storeId it is mounted under, so a
  // caller naming a store they do not work at gets 403 from the store they named.
  app.use('/api/stores/:storeId/members', membersRoutes);
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
  app.use('/api/storefront', storefrontConfigRoutes);
  app.use('/api/storefront', storefrontThemeRoutes);

  // Anything unmatched becomes a 404 through the same handler as everything else, so
  // there is one response shape for every failure.
  app.use((_req, _res, next) => next(unmatchedRoute()));

  app.use(errorHandler);

  return app;
}
