// server/src/routes/storeSettings.ts — milestone 11.
//
// The third endpoint a manager must not reach.
//
// GUARDED BY settings.write ON A GET, which looks wrong and is not. There is no
// settings.read in role_permissions, because Auth's invite screen describes a manager as
// someone who "can't SEE payouts, the wallet or store settings". Seeing the panel and
// editing it are one capability on the board, so they are one permission in the rows.
// Inventing a settings.read here would make the guard disagree with what the invite
// screen tells the person being invited.
//
// A store's IDENTITY — its name, slug and currency — is not behind this permission. A
// manager needs it to render any screen at all, and they get it from GET /api/session,
// which lists the stores they are a member of.
//
// Writing settings is milestone 25 (Customize, ThemeStudio, Settings), which is also
// where the Staff panel that calls routes/members.ts lands.

import { Router } from 'express';
import { notFound, readConsistent } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import * as stores from '../repositories/stores.ts';

const router = Router({ mergeParams: true });

/** GET /api/stores/:storeId/settings — store details, pickup, payout destination, methods. */
router.get(
  '/',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);

    // One consistent read across four tables. A payout destination that disagrees with
    // the payment methods beside it on screen reads as a bug, and two plain reads a
    // millisecond apart can produce exactly that.
    const settings = await readConsistent(
      (tx) => stores.findSettings(storeId, tx),
      'GET /api/stores/:storeId/settings',
    );

    if (settings === null) throw notFound('That store no longer exists.');

    res.json({
      store: {
        id: settings.store.id,
        slug: settings.store.slug,
        name: settings.store.name,
        status: settings.store.status,
        country: settings.store.country,
        currency: settings.store.selling_currency,
        planKey: settings.store.plan_key,
        customDomain: settings.store.custom_domain,
        industryTemplateId: settings.store.industry_template_id,
        industryTemplateVersion: settings.store.industry_template_version,
      },
      // Absent when the store does not offer pickup — V007's own words. Null rather
      // than an empty object, so "not offered" and "offered with nothing filled in"
      // stay distinguishable.
      pickup:
        settings.pickup === null
          ? null
          : {
              address: settings.pickup.address,
              readyMinutes: settings.pickup.ready_minutes,
              instructions: settings.pickup.instructions,
            },
      payout:
        settings.payout === null
          ? null
          : {
              methodKey: settings.payout.payout_method_key,
              phone: settings.payout.payout_phone,
              settlementMode: settings.payout.settlement_mode,
              automaticAt: settings.payout.automatic_at,
            },
      paymentMethods: settings.paymentMethods.map((m) => ({
        key: m.payment_method_key,
        isConnected: m.is_connected,
        connectedAt: m.connected_at,
      })),
    });
  }),
);

export default router;
