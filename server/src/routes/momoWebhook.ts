// server/src/routes/momoWebhook.ts — milestone 17.
//
// POST /api/momo/callback/collection/:referenceId
//
// Carried across from server/src/routes/momoWebhook.js, which §1.2 names explicitly: "the MTN MoMo
// integration including the webhook that RE-VERIFIES STATUS rather than trusting its callback".
//
// THE BODY IS IGNORED. MTN's callback is not signed, so anybody who guesses a reference id could otherwise
// post `{"status":"SUCCESSFUL"}` and be believed — which is a free order. The callback is treated as a "check
// now" nudge and nothing more: the reference id is looked up and the real status is read from MoMo's
// authenticated endpoint. That is the whole design, and it is why this endpoint needs no secret of its own.
//
// IT ANSWERS 200 IMMEDIATELY, before doing the work, so MTN does not retry-storm it. The reconciliation is
// asynchronous and idempotent — record_momo_collection_success() posts to the ledger under a key "exactly
// once, however many times the webhook arrives" — so a callback that arrives twice, or arrives after a poll
// already settled the payment, costs nothing.
//
// MOUNTED OUTSIDE THE CSRF LAYER, which is the one exception app.ts already anticipated: "Webhooks are the
// only endpoints that must not have it". MTN cannot echo a double-submit cookie. What protects this endpoint
// is that it grants nothing — the worst a forged call can do is make the server ask MoMo a question it
// already knew the answer to.

import { Router } from 'express';
import * as collections from '../repositories/collections.ts';
import { isConfigured } from '../payments/momo.ts';

const router = Router();

/** A MoMo reference id is a uuid, and this is the shape momo.newReferenceId() produces. */
const REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/callback/collection/:referenceId', (req, res) => {
  const referenceId = req.params['referenceId'];

  // Answer first, always, even for a malformed id: a webhook that is made to wait is a webhook that gets
  // retried, and there is nothing here worth telling a caller about.
  res.status(200).json({ received: true });

  if (typeof referenceId !== 'string' || !REFERENCE.test(referenceId)) return;
  if (!isConfigured()) return;

  // Deliberately not awaited — the response has already gone. The catch is what keeps an unhandled rejection
  // from taking the process down on a callback for something that no longer exists.
  void collections.refresh(referenceId).catch((error: unknown) => {
    console.error(
      `[momo] recheck failed for collection ${referenceId}:`,
      error instanceof Error ? error.message : String(error),
    );
  });
});

export default router;
