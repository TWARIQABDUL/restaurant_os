const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// GET /api/complaints — Admin/Manager fetch all complaints
router.get('/', authenticate, authorize('admin', 'manager'), async (req, res) => {
  try {
    const { data: complaints, error } = await supabase
      .from('complaints')
      .select(`
        id, 
        issue_type, 
        description, 
        status, 
        is_escalated,
        escalation_reason,
        refunded_amount,
        resolution_notes, 
        created_at,
        orders ( 
          id, 
          tracking_code,
          total_amount,
          payment_method,
          payment_status,
          status,
          guest_name,
          guest_phone,
          customer:users!orders_customer_id_fkey ( phone ),
          delivery_type,
          external_rider_info,
          delivery_person:users!orders_delivery_person_id_fkey ( name, phone ),
          created_at,
          order_items (
            quantity,
            unit_price,
            menu_item:menu_items ( name ),
            order_item_addons (
              quantity,
              add_on:add_ons ( name )
            )
          )
        )
      `)
      .eq('tenant_id', req.tenant.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Fetch complaints error:', error);
      return res.status(500).json({ error: 'Failed to fetch complaints' });
    }

    res.json({ complaints });
  } catch (err) {
    console.error('Fetch complaints error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/complaints — Customer submits a complaint via tracking code
router.post(
  '/',
  [
    body('tracking_code').notEmpty().withMessage('Tracking code is required'),
    body('issue_type').notEmpty().withMessage('Issue type is required'),
    body('description').notEmpty().withMessage('Description is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { tracking_code, issue_type, description } = req.body;
      const tenantId = req.tenant.id;

      // Verify the order exists and belongs to this tenant
      const { data: order } = await supabase
        .from('orders')
        .select('id, status')
        .eq('tracking_code', tracking_code)
        .eq('tenant_id', tenantId)
        .single();

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Check if order is eligible for complaints (delivered, ready, assigned)
      if (!['delivered', 'ready', 'assigned'].includes(order.status)) {
        return res.status(400).json({ error: 'Order is not eligible for complaints at its current status.' });
      }

      // Insert the complaint
      const { data: complaint, error } = await supabase
        .from('complaints')
        .insert({
          tenant_id: tenantId,
          order_id: order.id,
          issue_type,
          description
        })
        .select()
        .single();

      if (error) {
        console.error('Create complaint error:', error);
        return res.status(500).json({ error: 'Failed to create complaint' });
      }

      res.status(201).json({ complaint, message: 'Complaint submitted successfully' });
    } catch (err) {
      console.error('Create complaint error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/complaints/:id/resolve — Admin/Manager resolves a complaint
router.patch(
  '/:id/resolve',
  authenticate,
  authorize('admin', 'manager'),
  [
    body('resolution_notes').optional().trim(),
  ],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { resolution_notes } = req.body;
      const tenantId = req.tenant.id;

      const { data: complaint, error } = await supabase
        .from('complaints')
        .update({
          status: 'resolved',
          resolution_notes: resolution_notes || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select()
        .single();

      if (error) {
        console.error('Resolve complaint error:', error);
        return res.status(500).json({ error: 'Failed to resolve complaint' });
      }

      res.json({ complaint });
    } catch (err) {
      console.error('Resolve complaint error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/complaints/:id/escalate — Manager escalates a complaint
router.patch(
  '/:id/escalate',
  authenticate,
  authorize('manager'),
  [
    body('escalation_reason').notEmpty().withMessage('Reason is required to escalate'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id } = req.params;
      const { escalation_reason } = req.body;
      const tenantId = req.tenant.id;

      const { data: complaint, error } = await supabase
        .from('complaints')
        .update({
          is_escalated: true,
          escalation_reason: escalation_reason,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select()
        .single();

      if (error) {
        console.error('Escalate complaint error:', error);
        return res.status(500).json({ error: 'Failed to escalate complaint' });
      }

      res.json({ complaint });
    } catch (err) {
      console.error('Escalate complaint error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/complaints/:id/approve-refund — Admin approves refund for an escalated complaint
router.patch(
  '/:id/approve-refund',
  authenticate,
  authorize('admin', 'super_admin'),
  [
    body('amount').optional().isFloat({ min: 0 }),
    body('resolution_notes').optional().isString()
  ],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, resolution_notes } = req.body;
      const tenantId = req.tenant.id;

      // 1. Fetch complaint and verify it is escalated and open
      const { data: complaint, error: fetchErr } = await supabase
        .from('complaints')
        .select('*, order:orders(id, total_amount)')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (fetchErr || !complaint) return res.status(404).json({ error: 'Complaint not found' });
      if (!complaint.is_escalated || complaint.status !== 'open') {
        return res.status(400).json({ error: 'Complaint is not open and escalated' });
      }

      const refundAmount = amount !== undefined ? amount : complaint.order.total_amount;
      const finalNotes = resolution_notes || `Refund of ${refundAmount} approved by Admin.`;

      // 2. Create Refund Request
      const { data: refundRequest, error: reqErr } = await supabase
        .from('refund_requests')
        .insert({
          order_id: complaint.order.id,
          requested_by: req.user.id,
          reason: `Escalated complaint ${id}: ${finalNotes}`,
          amount: refundAmount
        })
        .select('*')
        .single();

      if (reqErr) {
        console.error('Failed to create refund request:', reqErr);
        return res.status(500).json({ error: 'Failed to create refund request' });
      }

      // 3. Trigger wallet deduction and MoMo payout
      const walletService = require('../services/walletService');
      try {
        await walletService.approveRefund({ 
          refundRequestId: refundRequest.id, 
          reviewerUserId: req.user.id 
        });
      } catch (refundErr) {
        console.error('Wallet deduction/payout failed:', refundErr.message);
        return res.status(400).json({ error: refundErr.message });
      }

      // 4. Mark complaint as resolved
      const { data: updatedComplaint, error: updateErr } = await supabase
        .from('complaints')
        .update({
          status: 'resolved',
          refunded_amount: refundAmount,
          resolution_notes: finalNotes,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (updateErr) return res.status(500).json({ error: 'Failed to update complaint status' });

      res.json({ complaint: updatedComplaint });
    } catch (err) {
      console.error('Approve refund error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/complaints/:id/reject-escalation — Admin rejects an escalated complaint
router.patch(
  '/:id/reject-escalation',
  authenticate,
  authorize('admin', 'super_admin'),
  [
    body('resolution_notes').notEmpty().withMessage('Reason is required to reject')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { id } = req.params;
      const { resolution_notes } = req.body;
      const tenantId = req.tenant.id;

      const { data: complaint, error } = await supabase
        .from('complaints')
        .update({
          status: 'rejected',
          resolution_notes: resolution_notes,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .eq('is_escalated', true)
        .select()
        .single();

      if (error) return res.status(500).json({ error: 'Failed to reject complaint' });

      res.json({ complaint });
    } catch (err) {
      console.error('Reject escalation error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/complaints/:id/reopen — Customer reopens a rejected complaint
router.patch(
  '/:id/reopen',
  authenticate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const tenantId = req.tenant.id;

      const { data: complaint, error: fetchErr } = await supabase
        .from('complaints')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (fetchErr || !complaint) return res.status(404).json({ error: 'Complaint not found' });
      
      // Can't reopen if it was refunded
      if (complaint.refunded_amount > 0) {
        return res.status(400).json({ error: 'Cannot reopen a complaint that was resolved with a refund' });
      }

      const { data: updatedComplaint, error } = await supabase
        .from('complaints')
        .update({
          status: 'open',
          is_escalated: false, // reset escalation so manager can review again
          resolution_notes: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (error) return res.status(500).json({ error: 'Failed to reopen complaint' });

      res.json({ complaint: updatedComplaint });
    } catch (err) {
      console.error('Reopen complaint error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
