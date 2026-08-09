const express = require('express');
const walletService = require('../services/walletService');

const router = express.Router();

// POST /api/momo/callback/collection/:referenceId
// POST /api/momo/callback/disbursement/:referenceId
//
// MTN MoMo POSTs a result body here, but we deliberately do NOT trust it —
// the callback isn't signed, so anyone who guesses a reference id could
// otherwise spoof a "SUCCESSFUL" result. Instead, the callback is just a
// "check now" trigger: we look up the reference id and re-verify the real
// status directly with MoMo's authenticated status endpoint. Respond 200
// immediately either way so MoMo doesn't retry-storm this endpoint; the
// actual reconciliation happens async.
router.post('/callback/:type/:referenceId', (req, res) => {
  res.status(200).json({ received: true });

  const { type, referenceId } = req.params;
  const recheck = type === 'disbursement'
    ? walletService.recheckDisbursement(referenceId)
    : walletService.recheckCollection(referenceId);

  recheck.catch(err => {
    console.error(`MoMo callback recheck failed for ${type}/${referenceId}:`, err.message);
  });
});

module.exports = router;