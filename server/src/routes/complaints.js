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
        resolution_notes, 
        created_at,
        orders ( id, tracking_code )
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

module.exports = router;
