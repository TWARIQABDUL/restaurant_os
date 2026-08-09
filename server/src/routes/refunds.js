const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');
const walletService = require('../services/walletService');

const router = express.Router();

// GET /api/refunds — list refund requests for this tenant (default: pending only)
router.get('/', authenticate, authorize('manager', 'admin'), async (req, res) => {
  try {
    const status = req.query.status || 'pending';

    let query = supabase
      .from('refund_requests')
      .select('*, order:orders!inner(id, tenant_id, tracking_code, total_amount, guest_name, guest_phone, customer_id, settlement_status)')
      .eq('order.tenant_id', req.tenant.id)
      .order('created_at', { ascending: false });

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    const { data: refundRequests, error } = await query;
    if (error) {
      return res.status(500).json({ error: 'Failed to fetch refund requests' });
    }

    res.json({ refund_requests: refundRequests || [] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/refunds/:id/approve — deduct tenant wallet and pay the customer back
router.patch('/:id/approve', authenticate, authorize('admin'), async (req, res) => {
  try {
    // Ownership check: the refund request's order must belong to this tenant.
    const { data: refundRequest } = await supabase
      .from('refund_requests')
      .select('id, order:orders!inner(tenant_id)')
      .eq('id', req.params.id)
      .single();

    if (!refundRequest || refundRequest.order.tenant_id !== req.tenant.id) {
      return res.status(404).json({ error: 'Refund request not found' });
    }

    const result = await walletService.approveRefund({
      refundRequestId: req.params.id,
      reviewerUserId: req.user.id,
    });

    res.json({ refunded_amount: result.amount });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to approve refund' });
  }
});

// PATCH /api/refunds/:id/reject
router.patch('/:id/reject', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { data: refundRequest } = await supabase
      .from('refund_requests')
      .select('id, order:orders!inner(tenant_id)')
      .eq('id', req.params.id)
      .single();

    if (!refundRequest || refundRequest.order.tenant_id !== req.tenant.id) {
      return res.status(404).json({ error: 'Refund request not found' });
    }

    const result = await walletService.rejectRefund({
      refundRequestId: req.params.id,
      reviewerUserId: req.user.id,
    });

    res.json({ refund_request: result });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to reject refund' });
  }
});

module.exports = router;