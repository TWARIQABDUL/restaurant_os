const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// GET /api/delivery/drivers — List delivery personnel (Admin/Manager)
router.get(
  '/drivers',
  authenticate,
  authorize('admin', 'manager'),
  async (req, res) => {
    try {
      const { data: drivers, error } = await supabase
        .from('users')
        .select('id, name, email, phone, plate_number, created_at')
        .eq('tenant_id', req.tenant.id)
        .eq('role', 'delivery')
        .order('name');

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch drivers' });
      }

      res.json({ drivers: drivers || [] });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/delivery/my-orders — Delivery person's assigned orders
router.get(
  '/my-orders',
  authenticate,
  authorize('delivery'),
  async (req, res) => {
    try {
      const { status } = req.query;

      let query = supabase
        .from('orders')
        .select(`
          *,
          customer:users!orders_customer_id_fkey ( name, phone ),
          order_items (
            *,
            menu_item:menu_items ( id, name )
          )
        `)
        .eq('delivery_person_id', req.user.id)
        .eq('tenant_id', req.tenant.id)
        .order('created_at', { ascending: false });

      if (status) {
        query = query.eq('status', status);
      } else {
        query = query.in('status', ['assigned', 'delivered']);
      }

      const { data: orders, error } = await query;

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch delivery orders' });
      }

      res.json({ orders: orders || [] });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
