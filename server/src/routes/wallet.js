const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');
const walletService = require('../services/walletService');
const platformSettings = require('../services/platformSettings');

const router = express.Router();

// GET /api/wallet — current balance
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const wallet = await walletService.getWallet(req.tenant.id);
    res.json({ wallet });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/wallet/ledger — transaction history (audit trail)
router.get('/ledger', authenticate, authorize('admin'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const ledger = await walletService.getLedger(req.tenant.id, limit);
    res.json({ ledger });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/wallet/withdrawals — past withdrawal requests + status
router.get('/withdrawals', authenticate, authorize('admin'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const withdrawals = await walletService.getWithdrawals(req.tenant.id, limit);
    res.json({ withdrawals });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/wallet/withdraw — request a withdrawal of the available balance
router.post(
  '/withdraw',
  authenticate,
  authorize('admin'),
  [
    body('amount').optional().isFloat({ gt: 0 }).withMessage('Amount must be a positive number'),
    body('phone').optional().trim().notEmpty().withMessage('Phone cannot be blank if provided'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { data: tenant } = await supabase.from('tenants').select('settings').eq('id', req.tenant.id).single();
      const paymentSettings = tenant?.settings?.payments || {};

      // A payout is a MoMo disbursement, and momoClient sends the platform's
      // settlement currency. If this store's balance is denominated in anything
      // else, transferring it would move a number MTN interprets in a different
      // currency — so refuse rather than pay out the wrong amount.
      const storeCurrency = String(tenant?.settings?.currency || '').toUpperCase()
        || platformSettings.SETTLEMENT_CURRENCY;

      if (!platformSettings.isSettleable(storeCurrency)) {
        return res.status(400).json({
          error: `Your balance is held in ${storeCurrency}, but payouts are sent in `
            + `${platformSettings.SETTLEMENT_CURRENCY}. Contact support to arrange this withdrawal — `
            + 'sending it automatically would transfer the wrong amount.',
          code: 'PAYOUT_CURRENCY_MISMATCH',
          storeCurrency,
          settlementCurrency: platformSettings.SETTLEMENT_CURRENCY,
        });
      }

      const wallet = await walletService.getWallet(req.tenant.id);
      if (wallet.currency && !platformSettings.isSettleable(wallet.currency)) {
        return res.status(400).json({
          error: `This wallet is recorded in ${wallet.currency}, but payouts are sent in `
            + `${platformSettings.SETTLEMENT_CURRENCY}. Contact support before withdrawing.`,
          code: 'WALLET_CURRENCY_MISMATCH',
        });
      }

      const phone = req.body.phone || paymentSettings.payoutPhone;
      if (!phone) {
        return res.status(400).json({ error: 'No payout phone number provided or saved. Set one in payment settings, or include "phone" in this request.' });
      }

      let amount = req.body.amount;
      if (!amount) {
        amount = wallet.available_balance;
        if (!amount || Number(amount) <= 0) {
          return res.status(400).json({ error: 'No available balance to withdraw' });
        }
      }

      const result = await walletService.requestWithdrawal({
        tenantId: req.tenant.id,
        userId: req.user.id,
        amount,
        phone,
        initiatedBy: 'manual',
      });

      res.status(201).json({ withdrawal: result });
    } catch (err) {
      // request_withdrawal raises a plain-text exception for insufficient balance
      const message = err.message || 'Failed to process withdrawal';
      const status = /insufficient/i.test(message) ? 400 : 500;
      res.status(status).json({ error: message });
    }
  }
);

module.exports = router;