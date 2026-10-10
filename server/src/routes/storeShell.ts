// server/src/routes/storeShell.ts — milestone 19, from project/Sidebar.dc.html.
//
//   GET /api/stores/:storeId/shell
//
// THE MERCHANT SHELL'S ONE DOCUMENT. `Sidebar` is on every console screen, and everything it draws is the same
// on all of them: the store's name and mark, the URL under it, the five nav groups with their badges, the
// signed-in person and their role. A screen that fetched those itself would fetch them again on every
// navigation; the console loads this once and keeps it.
//
// IT CARRIES THE THREE THINGS EVERY CONSOLE SCREEN NEEDS AND NO SCREEN OWNS:
//
//   the currency    §3: "one formatter driven by the currency table". Every price the console prints — a
//                   dashboard total, an order line, a payout — is formatted from this, so it is fetched with
//                   the shell rather than by each screen that happens to show money.
//   the config      the industry's own words and which modules are on. §2.3's rule is that "a component asks
//                   the config a question; it never branches on an industry name", and the question needs the
//                   answer to hand.
//   the theme       the store's published colours, for the store mark in the sidebar and for StorePreview.
//                   PUBLISHED ONLY — the draft is ThemeStudio's business and is guarded by settings.write,
//                   which a manager does not have. What is published is on the shopfront for anybody to see.
//
// GUARDED BY orders.read, which is the lowest permission any console role holds. A shell that required more
// would be a shell a manager could not load, and then the console could not draw its own frame for the person
// it was designed around.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { authOf, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { notFound, readConsistent } from '../db/index.ts';
import { resolveConfig } from '../core.ts';
import * as configRepo from '../repositories/config.ts';
import * as dashboard from '../repositories/dashboard.ts';
import * as notifications from '../repositories/notifications.ts';
import * as stores from '../repositories/stores.ts';
import * as themes from '../repositories/themes.ts';

const router = Router({ mergeParams: true });

router.get(
  '/',
  requireStorePermission('orders.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);

    // ONE CONSISTENT READ, for the reason the storefront's config route gives about its own two reads: a
    // template rollout running alongside this could otherwise hand back one version's words with another's
    // modules. The badges join the same snapshot so the sidebar's counts agree with each other.
    const view = await readConsistent(async (tx) => {
      const store = await stores.findById(storeId, tx);
      if (store === null) return null;
      // The contact line a printed receipt and a QR poster carry. Read here, not added to the shared StoreSummary, because that
      // summary is also what the PUBLIC storefront is built from.
      const contact = (await tx.query<{ address: string | null; public_phone: string | null }>(`SELECT address, public_phone FROM stores WHERE id = $1`, [storeId])).rows[0];
      return {
        store,
        contact: { address: contact?.address ?? null, phone: contact?.public_phone ?? null },
        currency: await themes.findCurrencyByStoreId(storeId, tx),
        config: await configRepo.inputsByStoreId(storeId, tx),
        theme: await themes.findByStatus(storeId, 'published', tx),
        badges: await dashboard.badges(storeId, tx),
        unread: await notifications.unreadCount(context.userId, storeId, tx),
      };
    }, 'GET /api/stores/:storeId/shell');

    // requireStorePermission already proved a membership of this store, so a missing store here means it was
    // deleted between the two reads. 404 rather than 500: the answer is the same either way.
    if (view === null || view.currency === null || view.config === null) {
      throw notFound('That store is no longer here.', 'NO_SUCH_STORE');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      store: {
        id: view.store.id,
        slug: view.store.slug,
        name: view.store.name,
        status: view.store.status,
        country: view.store.country,
        // The store's own zone, so the console's clock is the store's clock. See stores.ts.
        timeZone: view.store.time_zone,
        address: view.contact.address,
        phone: view.contact.phone,
        currency: view.currency,
      },
      me: {
        id: context.userId,
        name: context.name,
        role: context.storeRole,
        // THE PERMISSIONS, so the console can hide what a role cannot do rather than offering it and failing.
        // §5.4: "a component asks whether a role may do something; it never contains the list."
        permissions: context.permissions,
      },
      config: resolveConfig(view.config.inputs),
      // THE SAME SHAPE THE STOREFRONT SERVES, so one client function applies either. Null until the merchant
      // publishes a theme, and null means "render the platform default", which tokens.css already holds — not
      // an error: a store that has never opened the theme studio has a working shop and a working console.
      theme:
        view.theme === null
          ? null
          : {
              colors: view.theme.colors,
              dark: view.theme.dark,
              outline: view.theme.outline,
              publishedAt: view.theme.publishedAt,
            },
      badges: { ...view.badges, notifications: view.unread },
    });
  }),
);

export default router;
