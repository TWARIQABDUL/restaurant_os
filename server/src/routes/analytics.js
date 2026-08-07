const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// GET /api/analytics/summary — Today's snapshot (Admin)
router.get(
  '/summary',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const tenantId = req.tenant.id;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayISO = today.toISOString();

      const { data: todayOrders } = await supabase
        .from('orders')
        .select('id, status, total_amount, payment_status')
        .eq('tenant_id', tenantId)
        .gte('created_at', todayISO);

      const orders = todayOrders || [];

      const summary = {
        totalOrders: orders.length,
        totalRevenue: orders.filter(o => o.payment_status === 'paid').reduce((sum, o) => sum + parseFloat(o.total_amount), 0),
        pendingOrders: orders.filter(o => o.status === 'pending').length,
        approvedOrders: orders.filter(o => o.status === 'approved').length,
        preparingOrders: orders.filter(o => o.status === 'preparing').length,
        readyOrders: orders.filter(o => o.status === 'ready').length,
        assignedOrders: orders.filter(o => o.status === 'assigned').length,
        deliveredOrders: orders.filter(o => o.status === 'delivered').length,
        rejectedOrders: orders.filter(o => o.status === 'rejected').length,
        unpaidOrders: orders.filter(o => o.payment_status === 'unpaid').length,
        paidOrders: orders.filter(o => o.payment_status === 'paid').length,
      };

      res.json({ summary, date: todayISO });
    } catch (err) {
      console.error('Analytics summary error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/analytics/orders — Orders breakdown by status (Admin)
router.get(
  '/orders',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const tenantId = req.tenant.id;
      const { from, to } = req.query;

      let query = supabase
        .from('orders')
        .select('id, status, total_amount, payment_status, payment_method, created_at')
        .eq('tenant_id', tenantId);

      if (from) query = query.gte('created_at', from);
      if (to) query = query.lte('created_at', to);

      const { data: orders } = await query;
      const items = orders || [];

      const breakdown = {
        byStatus: {},
        byPaymentMethod: {},
        byPaymentStatus: {},
      };

      for (const order of items) {
        breakdown.byStatus[order.status] = (breakdown.byStatus[order.status] || 0) + 1;
        breakdown.byPaymentMethod[order.payment_method] = (breakdown.byPaymentMethod[order.payment_method] || 0) + 1;
        breakdown.byPaymentStatus[order.payment_status] = (breakdown.byPaymentStatus[order.payment_status] || 0) + 1;
      }

      res.json({ breakdown, totalOrders: items.length });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/analytics/revenue — Revenue grouped by period (Admin)
router.get(
  '/revenue',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const tenantId = req.tenant.id;
      const { from, to } = req.query;

      let query = supabase
        .from('orders')
        .select('total_amount, payment_status, created_at')
        .eq('tenant_id', tenantId)
        .eq('payment_status', 'paid')
        .not('status', 'eq', 'rejected');

      if (from) query = query.gte('created_at', from);
      if (to) query = query.lte('created_at', to);

      query = query.order('created_at');

      const { data: orders } = await query;
      const items = orders || [];

      // Group by date
      const dailyRevenue = {};
      for (const order of items) {
        const date = order.created_at.split('T')[0];
        dailyRevenue[date] = (dailyRevenue[date] || 0) + parseFloat(order.total_amount);
      }

      const revenue = Object.entries(dailyRevenue).map(([date, amount]) => ({ date, amount }));
      const totalRevenue = items.reduce((sum, o) => sum + parseFloat(o.total_amount), 0);

      res.json({ revenue, totalRevenue });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/analytics/top-items — Top selling menu items (Admin)
router.get(
  '/top-items',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const tenantId = req.tenant.id;
      const { from, to, limit: queryLimit } = req.query;
      const itemLimit = parseInt(queryLimit) || 10;

      // Get order IDs for the tenant in date range
      let orderQuery = supabase
        .from('orders')
        .select('id')
        .eq('tenant_id', tenantId)
        .not('status', 'eq', 'rejected');

      if (from) orderQuery = orderQuery.gte('created_at', from);
      if (to) orderQuery = orderQuery.lte('created_at', to);

      const { data: orders } = await orderQuery;
      const orderIds = (orders || []).map(o => o.id);

      if (orderIds.length === 0) {
        return res.json({ topItems: [] });
      }

      const { data: orderItems } = await supabase
        .from('order_items')
        .select('menu_item_id, quantity, menu_item:menu_items ( name )')
        .in('order_id', orderIds);

      // Aggregate by menu item
      const itemCounts = {};
      for (const oi of (orderItems || [])) {
        const key = oi.menu_item_id;
        if (!itemCounts[key]) {
          itemCounts[key] = { id: key, name: oi.menu_item?.name || 'Unknown', totalQuantity: 0 };
        }
        itemCounts[key].totalQuantity += oi.quantity;
      }

      const topItems = Object.values(itemCounts)
        .sort((a, b) => b.totalQuantity - a.totalQuantity)
        .slice(0, itemLimit);

      res.json({ topItems });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/analytics/payments — Payment status breakdown (Admin)
router.get(
  '/payments',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const tenantId = req.tenant.id;
      const { from, to } = req.query;

      let query = supabase
        .from('orders')
        .select('total_amount, payment_status, payment_method')
        .eq('tenant_id', tenantId);

      if (from) query = query.gte('created_at', from);
      if (to) query = query.lte('created_at', to);

      const { data: orders } = await query;
      const items = orders || [];

      const payments = {
        paid: { count: 0, total: 0 },
        unpaid: { count: 0, total: 0 },
        refunded: { count: 0, total: 0 },
        byMethod: {},
      };

      for (const order of items) {
        const amount = parseFloat(order.total_amount);
        payments[order.payment_status].count++;
        payments[order.payment_status].total += amount;

        if (!payments.byMethod[order.payment_method]) {
          payments.byMethod[order.payment_method] = { count: 0, total: 0 };
        }
        payments.byMethod[order.payment_method].count++;
        payments.byMethod[order.payment_method].total += amount;
      }

      res.json({ payments });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/analytics/delivery — Delivery performance (Admin)
router.get(
  '/delivery',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    try {
      const tenantId = req.tenant.id;

      const { data: deliveredOrders } = await supabase
        .from('orders')
        .select('delivery_person_id, created_at, updated_at')
        .eq('tenant_id', tenantId)
        .eq('status', 'delivered')
        .not('delivery_person_id', 'is', null);

      const { data: drivers } = await supabase
        .from('users')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .eq('role', 'delivery');

      const driverStats = {};
      for (const driver of (drivers || [])) {
        driverStats[driver.id] = { name: driver.name, deliveries: 0 };
      }

      for (const order of (deliveredOrders || [])) {
        if (driverStats[order.delivery_person_id]) {
          driverStats[order.delivery_person_id].deliveries++;
        }
      }

      const performance = Object.values(driverStats).sort((a, b) => b.deliveries - a.deliveries);

      res.json({
        totalDelivered: (deliveredOrders || []).length,
        driverPerformance: performance,
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
