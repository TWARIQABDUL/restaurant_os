const express = require('express');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { authenticate, authorize, optionalAuth } = require('../middleware/auth');

const router = express.Router();

/** Generate a unique tracking code like ORD-A1B2C3 */
function generateTrackingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return `ORD-${code}`;
}

// POST /api/orders — Place new order (public: customer or guest)
router.post(
  '/',
  optionalAuth,
  [
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.menu_item_id').notEmpty().withMessage('menu_item_id is required'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('payment_method').isIn(['cash_on_delivery', 'mobile_money', 'bank_transfer']).withMessage('Invalid payment method'),
    body('payment_phone').optional().trim(),
    body('delivery_notes').optional().trim(),
    // Guest fields (required if not authenticated)
    body('guest_name').if((value, { req }) => !req.user).notEmpty().withMessage('Name is required for guest orders'),
    body('guest_phone').if((value, { req }) => !req.user).notEmpty().withMessage('Phone is required for guest orders'),
    body('guest_address').if((value, { req }) => !req.user).notEmpty().withMessage('Address is required for guest orders'),
    body('guest_email').optional().isEmail().withMessage('Valid email required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const tenantId = req.tenant.id;
      const { items, payment_method, payment_phone, delivery_notes, guest_name, guest_phone, guest_address, guest_email } = req.body;

      // Calculate total — fetch prices from DB to prevent client-side manipulation
      let totalAmount = 0;
      const orderItems = [];

      for (const item of items) {
        const { data: menuItem } = await supabase
          .from('menu_items')
          .select('id, price, name')
          .eq('id', item.menu_item_id)
          .eq('tenant_id', tenantId)
          .eq('available', true)
          .single();

        if (!menuItem) {
          return res.status(400).json({ error: `Menu item ${item.menu_item_id} not found or unavailable` });
        }

        let itemTotal = menuItem.price * item.quantity;

        // Process add-ons if provided
        const itemAddOns = [];
        if (item.add_ons && Array.isArray(item.add_ons)) {
          for (const addOn of item.add_ons) {
            const { data: addOnData } = await supabase
              .from('add_ons')
              .select('id, price, name')
              .eq('id', addOn.add_on_id)
              .eq('tenant_id', tenantId)
              .eq('available', true)
              .single();

            if (!addOnData) {
              return res.status(400).json({ error: `Add-on ${addOn.add_on_id} not found or unavailable` });
            }

            const addOnQty = addOn.quantity || 1;
            itemTotal += addOnData.price * addOnQty;

            itemAddOns.push({
              add_on_id: addOnData.id,
              quantity: addOnQty,
              unit_price: addOnData.price,
            });
          }
        }

        totalAmount += itemTotal;

        orderItems.push({
          menu_item_id: menuItem.id,
          quantity: item.quantity,
          unit_price: menuItem.price,
          addOns: itemAddOns,
        });
      }

      // Create the order
      const trackingCode = generateTrackingCode();

      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          tenant_id: tenantId,
          tracking_code: trackingCode,
          customer_id: req.user ? req.user.id : null,
          guest_name: req.user ? null : guest_name,
          guest_phone: req.user ? null : guest_phone,
          guest_address: req.user ? null : guest_address,
          guest_email: req.user ? null : (guest_email || null),
          status: 'pending',
          total_amount: totalAmount,
          payment_method,
          payment_status: 'unpaid',
          delivery_notes: delivery_notes || null,
        })
        .select('*')
        .single();

      if (orderError) {
        console.error('Order creation error:', orderError);
        return res.status(500).json({ error: 'Failed to create order' });
      }

      // Create order items
      for (const item of orderItems) {
        const { data: orderItem, error: itemError } = await supabase
          .from('order_items')
          .insert({
            order_id: order.id,
            menu_item_id: item.menu_item_id,
            quantity: item.quantity,
            unit_price: item.unit_price,
          })
          .select('id')
          .single();

        if (itemError) {
          console.error('Order item error:', itemError);
          continue;
        }

        // Create order item add-ons
        if (item.addOns.length > 0) {
          const addOnInserts = item.addOns.map(ao => ({
            order_item_id: orderItem.id,
            add_on_id: ao.add_on_id,
            quantity: ao.quantity,
            unit_price: ao.unit_price,
          }));

          await supabase.from('order_item_addons').insert(addOnInserts);
        }
      }

      // For mobile_money orders, payment goes through the platform's own
      // MoMo account (Collections API) rather than being collected by the
      // restaurant directly. The initial request-to-pay call is awaited
      // (fast — MoMo just acks with 202), but waiting for the CUSTOMER to
      // actually approve it on their phone can take a while, so that part
      // runs in the background rather than holding this response open.
      // The client polls GET /orders/track/:code to see payment_status
      // flip to 'paid' once it resolves; if the tab closes before that,
      // the settlement scheduler's reconciliation sweep still catches it.
      let paymentInfo = { status: 'not_applicable' };
      if (payment_method === 'mobile_money') {
        const walletService = require('../services/walletService');
        const momoConfigCheck = require('../config/momo');

        try {
          momoConfigCheck.assertConfigured('collection');
          const payerPhone = payment_phone || order.guest_phone || (req.user && req.user.phone) || null;

          if (!payerPhone) {
            paymentInfo = { status: 'UNAVAILABLE', reason: 'No phone number on file to charge' };
          } else {
            paymentInfo = { status: 'PENDING' };

            // Fire the actual MoMo call + resolution in the background so
            // order creation itself stays fast. Errors are caught and
            // logged inside initiateOrderPayment's own try/catch (it never
            // throws), so this is safe to leave unawaited. The client
            // polls GET /orders/track/:code (by tracking_code) to see the
            // result land, so we don't need to hand back a reference id here.
            walletService.initiateOrderPayment({ ...order, guest_phone: payerPhone }).catch(err => {
              console.error(`Background MoMo initiation failed for order ${order.id}:`, err.message);
            });
          }
        } catch (err) {
          // MoMo isn't configured on this deployment yet — don't fail the
          // whole order, just surface it so the frontend can tell the
          // customer payment collection isn't available right now.
          console.error('MoMo not configured:', err.message);
          paymentInfo = { status: 'UNAVAILABLE', reason: 'Mobile money payment is not configured on this server yet' };
        }
      }

      // Send confirmation email and write to DB
      const notificationService = require('../services/notificationService');
      await notificationService.notifyOrderPlaced(order, req.user, { guest_name, guest_email, guest_phone });

      // Emit socket notification to trigger frontend fetch
      const io = req.app.get('io');
      if (io) {
        io.to(`tenant:${tenantId}:managers`).emit('newOrder', {
          orderId: order.id,
          trackingCode,
          totalAmount,
        });
        io.to(`tenant:${tenantId}:admins`).emit('newOrder', {
          orderId: order.id,
          trackingCode,
          totalAmount,
        });
      }

      res.status(201).json({
        order: {
          id: order.id,
          tracking_code: trackingCode,
          status: order.status,
          total_amount: totalAmount,
          payment_method,
          payment_status: order.payment_status,
        },
        payment: paymentInfo,
      });
    } catch (err) {
      console.error('Order error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/orders/me — My orders (authenticated customer)
router.get('/me', authenticate, async (req, res) => {
  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select(`
        *,
        order_items (
          *,
          menu_item:menu_items ( id, name, image_url ),
          order_item_addons (
            *,
            add_on:add_ons ( id, name )
          )
        ),
        delivery_person:users!orders_delivery_person_id_fkey ( id, name, phone, plate_number )
      `)
      .eq('customer_id', req.user.id)
      .eq('tenant_id', req.tenant.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('My orders error:', error);
      return res.status(500).json({ error: 'Failed to fetch orders' });
    }

    res.json({ orders: orders || [] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/orders/track/:code — Track order by code (public)
router.get('/track/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const tenantId = req.tenant.id;

    const { data: order, error } = await supabase
      .from('orders')
      .select(`
        id, tracking_code, status, total_amount, payment_method, payment_status,
        guest_name, created_at, updated_at, delivery_type, external_rider_info,
        order_items (
          *,
          menu_item:menu_items ( id, name, image_url ),
          order_item_addons (
            *,
            add_on:add_ons ( id, name )
          )
        ),
        delivery_person:users!orders_delivery_person_id_fkey ( name, phone, plate_number )
      `)
      .eq('tracking_code', code.toUpperCase())
      .eq('tenant_id', tenantId)
      .single();

    if (error || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/orders — All orders (Manager/Admin)
router.get(
  '/',
  authenticate,
  authorize('admin', 'manager'),
  async (req, res) => {
    try {
      const tenantId = req.tenant.id;
      const { status, payment_status, from, to } = req.query;

      let query = supabase
        .from('orders')
        .select(`
          *,
          customer:users!orders_customer_id_fkey ( id, name, email, phone ),
          delivery_person:users!orders_delivery_person_id_fkey ( id, name, phone, plate_number ),
          order_items (
            *,
            menu_item:menu_items ( id, name ),
            order_item_addons (
              *,
              add_on:add_ons ( id, name )
            )
          )
        `)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });

      if (status) query = query.eq('status', status);
      if (payment_status) query = query.eq('payment_status', payment_status);
      if (from) query = query.gte('created_at', from);
      if (to) query = query.lte('created_at', to);

      const { data: orders, error } = await query;

      if (error) {
        console.error('Orders fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch orders' });
      }

      res.json({ orders: orders || [] });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/orders/:id/approve — Approve order (Manager)
router.patch(
  '/:id/approve',
  authenticate,
  authorize('manager', 'admin'),
  async (req, res) => {
    try {
      const { data: order, error } = await supabase
        .from('orders')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('tenant_id', req.tenant.id)
        .eq('status', 'pending')
        .select('*')
        .single();

      if (error || !order) {
        return res.status(400).json({ error: 'Order not found or cannot be approved' });
      }

      const notificationService = require('../services/notificationService');
      await notificationService.notifyOrderApproved(order);

      const io = req.app.get('io');
      if (io) {
        if (order.customer_id) {
          io.to(`user:${order.customer_id}`).emit('orderApproved', { orderId: order.id });
        }
        io.to(`tenant:${req.tenant.id}:managers`).emit('orderApproved', { orderId: order.id });
      }

      res.json({ order });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/orders/:id/reject — Reject order (Manager)
router.patch(
  '/:id/reject',
  authenticate,
  authorize('manager', 'admin'),
  async (req, res) => {
    try {
      const { reason } = req.body;

      const { data: order, error } = await supabase
        .from('orders')
        .update({
          status: 'rejected',
          delivery_notes: reason || 'Order rejected',
          updated_at: new Date().toISOString(),
        })
        .eq('id', req.params.id)
        .eq('tenant_id', req.tenant.id)
        .eq('status', 'pending')
        .select('*')
        .single();

      if (error || !order) {
        return res.status(400).json({ error: 'Order not found or cannot be rejected' });
      }

      // If this was already paid via MoMo, the restaurant declining it
      // means the customer needs their money back — automatically, not
      // via a separate refund request they'd have to know to submit.
      if (order.payment_method === 'mobile_money' && order.payment_status === 'paid' && order.settlement_status === 'pending') {
        const walletService = require('../services/walletService');
        supabase
          .from('refund_requests')
          .insert({
            order_id: order.id,
            reason: `Auto-refund: order rejected by restaurant (${reason || 'no reason given'})`,
            status: 'pending',
          })
          .select('id')
          .single()
          .then(({ data: refundRequest, error: refundErr }) => {
            if (refundErr || !refundRequest) {
              console.error(`Failed to create auto-refund request for rejected order ${order.id}:`, refundErr?.message);
              return;
            }
            return walletService.approveRefund({ refundRequestId: refundRequest.id, reviewerUserId: req.user.id });
          })
          .catch(err => {
            console.error(`Auto-refund failed for rejected order ${order.id}:`, err.message);
          });
      }

      const notificationService = require('../services/notificationService');
      await notificationService.notifyOrderRejected(order, reason);

      const io = req.app.get('io');
      if (io) {
        if (order.customer_id) {
          io.to(`user:${order.customer_id}`).emit('orderRejected', { orderId: order.id, reason });
        }
        io.to(`tenant:${req.tenant.id}:managers`).emit('orderRejected', { orderId: order.id, reason });
      }

      res.json({ order });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/orders/:id/payment — Confirm payment (Manager)
router.patch(
  '/:id/payment',
  authenticate,
  authorize('manager', 'admin'),
  async (req, res) => {
    try {
      const { data: existing } = await supabase
        .from('orders')
        .select('id, payment_method, payment_status')
        .eq('id', req.params.id)
        .eq('tenant_id', req.tenant.id)
        .single();

      if (!existing) {
        return res.status(400).json({ error: 'Order not found' });
      }

      if (existing.payment_method === 'mobile_money') {
        return res.status(400).json({
          error: 'Mobile money orders are confirmed automatically once MoMo payment succeeds and cannot be marked paid manually.',
        });
      }

      const { data: order, error } = await supabase
        .from('orders')
        .update({ payment_status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('tenant_id', req.tenant.id)
        .select('*')
        .single();

      if (error || !order) {
        return res.status(400).json({ error: 'Order not found' });
      }

      res.json({ order });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/orders/:id/preparing — Mark as preparing (Manager)
router.patch(
  '/:id/preparing',
  authenticate,
  authorize('manager', 'admin'),
  async (req, res) => {
    try {
      const { data: order, error } = await supabase
        .from('orders')
        .update({ status: 'preparing', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('tenant_id', req.tenant.id)
        .eq('status', 'approved')
        .select('*')
        .single();

      if (error || !order) {
        return res.status(400).json({ error: 'Order not found or cannot be marked as preparing' });
      }

      res.json({ order });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/orders/:id/ready — Mark ready (Manager/Admin)
router.patch(
  '/:id/ready',
  authenticate,
  authorize('manager', 'admin'),
  async (req, res) => {
    try {
      const { data: order, error } = await supabase
        .from('orders')
        .update({ status: 'ready', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('tenant_id', req.tenant.id)
        .eq('status', 'preparing')
        .select('*')
        .single();

      if (error || !order) {
        return res.status(400).json({ error: 'Order not found or cannot be marked as ready' });
      }

      const notificationService = require('../services/notificationService');
      await notificationService.notifyOrderReady(order, req.tenant.id);

      // Notify admins and managers
      const io = req.app.get('io');
      if (io) {
        io.to(`tenant:${req.tenant.id}:admins`).emit('orderReady', {
          orderId: order.id,
          trackingCode: order.tracking_code,
        });
        io.to(`tenant:${req.tenant.id}:managers`).emit('orderReady', {
          orderId: order.id,
          trackingCode: order.tracking_code,
        });
      }

      res.json({ order });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/orders/:id/assign — Assign delivery person (Admin/Manager)
router.patch(
  '/:id/assign',
  authenticate,
  authorize('admin', 'manager'),
  async (req, res) => {
    try {
      const { delivery_person_id, assign_type = 'internal', external_rider_info } = req.body;

      let updatePayload = {
        status: 'assigned',
        updated_at: new Date().toISOString(),
      };
      
      let driverDetails = null;

      if (assign_type === 'internal') {
        if (!delivery_person_id) {
          return res.status(400).json({ error: 'Delivery person ID is required for internal dispatch' });
        }
        const { data: driver } = await supabase
          .from('users')
          .select('id, name, phone, plate_number')
          .eq('id', delivery_person_id)
          .eq('role', 'delivery')
          .eq('tenant_id', req.tenant.id)
          .single();

        if (!driver) {
          return res.status(400).json({ error: 'Delivery person not found' });
        }
        
        updatePayload.delivery_person_id = delivery_person_id;
        updatePayload.delivery_type = 'internal';
        driverDetails = { id: driver.id, name: driver.name, phone: driver.phone, plateNumber: driver.plate_number };
      } else {
        if (!external_rider_info) {
          return res.status(400).json({ error: 'External rider info is required' });
        }
        updatePayload.delivery_person_id = null;
        updatePayload.delivery_type = 'external';
        updatePayload.external_rider_info = external_rider_info;
        driverDetails = { name: external_rider_info.name, phone: external_rider_info.phone, plateNumber: external_rider_info.plateNumber || 'N/A' };
      }

      const { data: order, error } = await supabase
        .from('orders')
        .update(updatePayload)
        .eq('id', req.params.id)
        .eq('tenant_id', req.tenant.id)
        .eq('status', 'ready')
        .select('*')
        .single();

      if (error || !order) {
        return res.status(400).json({ error: 'Order not found or cannot be assigned' });
      }

      // We only have the notification service set up for full User models, so we simulate it for external
      const notificationService = require('../services/notificationService');
      if (assign_type === 'internal') {
        const fullDriver = { id: driverDetails.id, name: driverDetails.name, phone: driverDetails.phone, plate_number: driverDetails.plateNumber };
        await notificationService.notifyDeliveryAssigned(order, fullDriver);
      } else {
        await notificationService.notifyDeliveryAssigned(order, { name: driverDetails.name, phone: driverDetails.phone, plate_number: driverDetails.plateNumber, isExternal: true });
      }

      // Notify customer with driver info
      const io = req.app.get('io');
      if (io) {
        if (order.customer_id) {
          io.to(`user:${order.customer_id}`).emit('deliveryAssigned', {
            orderId: order.id,
            driver: driverDetails,
          });
        }
        if (assign_type === 'internal' && driverDetails.id) {
          io.to(`user:${driverDetails.id}`).emit('newDelivery', { orderId: order.id });
        }
        io.to(`tenant:${req.tenant.id}:managers`).emit('deliveryAssigned', {
          orderId: order.id,
          driver: driverDetails,
        });
      }

      res.json({ order, driver: driverDetails });
    } catch (err) {
      console.error('Assign error', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/orders/:id/delivered — Mark delivered (Delivery)
router.patch(
  '/:id/delivered',
  authenticate,
  authorize('delivery'),
  async (req, res) => {
    try {
      const { data: order, error } = await supabase
        .from('orders')
        .update({ status: 'delivered', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('tenant_id', req.tenant.id)
        .eq('delivery_person_id', req.user.id)
        .eq('status', 'assigned')
        .select('*')
        .single();

      if (error || !order) {
        return res.status(400).json({ error: 'Order not found or cannot be marked as delivered' });
      }

      const notificationService = require('../services/notificationService');
      await notificationService.notifyOrderDelivered(order);

      const io = req.app.get('io');
      if (io) {
        if (order.customer_id) {
          io.to(`user:${order.customer_id}`).emit('orderDelivered', { orderId: order.id });
        }
        io.to(`tenant:${req.tenant.id}:managers`).emit('orderDelivered', { orderId: order.id });
      }

      res.json({ order });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/orders/:id/refund-request — customer (or guest, via tracking
// code as proof of ownership) or staff requests a refund on an order.
// A pending request here blocks the settlement scheduler from releasing
// that order's funds until staff reviews it (see refunds.js).
router.post(
  '/:id/refund-request',
  optionalAuth,
  [
    body('reason').trim().notEmpty().withMessage('A reason is required'),
    body('tracking_code').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { data: order } = await supabase
        .from('orders')
        .select('id, tenant_id, tracking_code, customer_id, payment_status, settlement_status')
        .eq('id', req.params.id)
        .eq('tenant_id', req.tenant.id)
        .single();

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Ownership check: either you're the authenticated customer on this
      // order, staff on this tenant, or you know the tracking code (the
      // same "password" guests already use to check order status).
      const isOwner = req.user && (req.user.id === order.customer_id || ['manager', 'admin'].includes(req.user.role));
      const knowsTrackingCode = req.body.tracking_code && req.body.tracking_code.toUpperCase() === order.tracking_code;

      if (!isOwner && !knowsTrackingCode) {
        return res.status(403).json({ error: 'Not authorized to request a refund on this order' });
      }

      if (order.payment_status !== 'paid') {
        return res.status(400).json({ error: 'This order has not been paid yet, so there is nothing to refund' });
      }

      const { data: refundRequest, error } = await supabase
        .from('refund_requests')
        .insert({ order_id: order.id, requested_by: req.user ? req.user.id : null, reason: req.body.reason })
        .select('*')
        .single();

      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'A refund request is already pending for this order' });
        }
        return res.status(500).json({ error: 'Failed to submit refund request' });
      }

      // Give an honest heads-up if this order already left escrow — the
      // request still gets recorded for staff to review, but it can't
      // automatically block money that's already moved.
      const alreadySettled = order.settlement_status === 'released';

      res.status(201).json({
        refund_request: refundRequest,
        note: alreadySettled
          ? 'This order was already settled to the restaurant, so this refund will need manual handling by staff rather than being caught automatically.'
          : undefined,
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;