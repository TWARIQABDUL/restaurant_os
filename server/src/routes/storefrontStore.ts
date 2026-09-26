// server/src/routes/storefrontStore.ts — milestone 16.
//
// GET /api/storefront/:slug — the shopfront's own header, in one request.
//
// WHAT IS IN IT, and the reason it is one payload rather than five: `Shop`'s header and
// `StoreDesktop`'s left rail render the store's name, whether it is open, how long delivery takes, the
// pickup address, the phone number, this week's banner and the category list — and none of it is
// useful on its own. A shopper waiting on five round trips before the first paint is a shopper
// watching a blank screen on a Kigali 3G connection.
//
// A THIRD PAYLOAD BESIDE config AND theme, and not folded into either. storefrontTheme.ts already
// wrote down the trade-off: "The cost is that a cold page load fetches two documents, which milestone
// 16 can collapse if the storefront's own waterfall says it should; that is a decision to make with a
// real page in front of you, not now." With the real page in front of me they stay separate, because
// they change on different clocks — a merchant republishes a theme without touching their hours, and
// this document changes every time a store opens or shuts, which is twice a day. One ETag over all
// three would throw away the theme's cache each morning.
//
// SO THIS ONE IS NOT CACHEABLE THE WAY THE OTHER TWO ARE. It contains "open · closes 22:00", which is
// true for a few hours. It carries no ETag and says no-store, because a 304 on a stale open/closed
// flag is worse than a fresh request: the one thing a shopper must not be told wrongly is that the
// kitchen is open.

import { Router } from 'express';
import { readConsistent } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { resolveStorefront, storeOf } from '../middleware/storefront.ts';
import * as storefront from '../repositories/storefront.ts';

const router = Router();

router.get(
  '/:slug',
  resolveStorefront(),
  asyncHandler(async (req, res) => {
    const store = storeOf(req);

    // ONE CONSISTENT READ. The open state, the hours behind it and the banner must come from the same
    // moment: taken separately, a request that straddles 22:00 can answer "open" with a closing time
    // already in the past, and a promotion can appear in the banner after its window shut.
    const view = await readConsistent(async (tx) => {
      const openState = await storefront.openState(store.id, tx);
      const hours = await storefront.openingHours(store.id, tx);
      const contact = await storefront.contact(store.id, tx);
      const delivery = await storefront.deliverySummary(store.id, tx);
      const banner = await storefront.banner(store.id, tx);
      const categories = await storefront.categories(store.id, tx);
      return { openState, hours, contact, delivery, banner, categories };
    }, 'GET /api/storefront/:slug');

    res.setHeader('Cache-Control', 'no-store');

    res.json({
      store: {
        id: store.id,
        slug: store.slug,
        name: store.name,
        currency: store.currency,
        country: store.country,
        phone: view.contact.phone,
      },
      open: view.openState,
      hours: view.hours,
      // Present only when the store offers it. A shopfront with neither is a shopfront that has not
      // been set up, which Onboarding (milestone 26) is what fixes — the storefront renders what it has.
      delivery: view.delivery,
      pickup: view.contact.pickup,
      banner: view.banner,
      categories: view.categories,
    });
  }),
);

export default router;
