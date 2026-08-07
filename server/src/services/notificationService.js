const supabase = require('../config/supabase');
const { sendTemplatedEmail } = require('./emailService');

async function insertDbNotification(tenantId, userIds, message, icon, actionUrl = null) {
  if (!userIds || userIds.length === 0) return;
  try {
    const inserts = userIds.map(uid => ({
      tenant_id: tenantId,
      user_id: uid,
      message,
      icon,
      action_url: actionUrl
    }));
    await supabase.from('notifications').insert(inserts);
  } catch (err) {
    console.error('DB Notification Insert Error:', err.message);
  }
}

/**
 * Get the email address for an order's customer (registered or guest).
 */
async function getCustomerEmail(order) {
  if (order.guest_email) return order.guest_email;

  if (order.customer_id) {
    const { data: user } = await supabase
      .from('users')
      .select('email')
      .eq('id', order.customer_id)
      .single();
    return user?.email || null;
  }

  return null;
}

/**
 * Get customer display name.
 */
async function getCustomerName(order) {
  if (order.guest_name) return order.guest_name;

  if (order.customer_id) {
    const { data: user } = await supabase
      .from('users')
      .select('name')
      .eq('id', order.customer_id)
      .single();
    return user?.name || 'Customer';
  }

  return 'Customer';
}

// --- Notification functions ---

async function notifyOrderPlaced(order, user, guestInfo) {
  try {
    const { data: staff } = await supabase
      .from('users')
      .select('id')
      .eq('tenant_id', order.tenant_id)
      .in('role', ['admin', 'manager']);
      
    if (staff && staff.length > 0) {
      await insertDbNotification(
        order.tenant_id,
        staff.map(s => s.id),
        'A new order has been placed!',
        'ShoppingBag',
        `/manager?order=${order.id}`
      );
    }

    const email = user?.email || guestInfo?.guest_email;
    const name = user?.name || guestInfo?.guest_name || 'Customer';

    if (email) {
      await sendTemplatedEmail({
        to: email,
        subject: `Order Confirmed — ${order.tracking_code}`,
        template: 'orderConfirmation',
        data: {
          title: 'Order Confirmed',
          customerName: name,
          trackingCode: order.tracking_code,
          totalAmount: parseFloat(order.total_amount).toFixed(2),
          paymentMethod: order.payment_method.replace(/_/g, ' '),
          message: 'Your order has been received and is awaiting approval.',
        },
      });
    }
  } catch (err) {
    console.error('notifyOrderPlaced error:', err.message);
  }
}

async function notifyOrderApproved(order) {
  try {
    if (order.customer_id) {
      await insertDbNotification(
        order.tenant_id, 
        [order.customer_id], 
        'Your order has been approved!', 
        'CheckCircle',
        order.tracking_code ? `/track?code=${order.tracking_code}` : null
      );
    }

    const email = await getCustomerEmail(order);
    const name = await getCustomerName(order);

    if (email) {
      await sendTemplatedEmail({
        to: email,
        subject: `Order Approved — ${order.tracking_code}`,
        template: 'orderApproved',
        data: {
          title: 'Order Approved',
          customerName: name,
          trackingCode: order.tracking_code,
          message: 'Your order has been approved and is being prepared.',
        },
      });
    }
  } catch (err) {
    console.error('notifyOrderApproved error:', err.message);
  }
}

async function notifyOrderRejected(order, reason) {
  try {
    if (order.customer_id) {
      await insertDbNotification(
        order.tenant_id, 
        [order.customer_id], 
        'Unfortunately, your order was rejected.', 
        'XCircle',
        order.tracking_code ? `/track?code=${order.tracking_code}` : null
      );
    }

    const email = await getCustomerEmail(order);
    const name = await getCustomerName(order);

    if (email) {
      await sendTemplatedEmail({
        to: email,
        subject: `Order Update — ${order.tracking_code}`,
        template: 'orderRejected',
        data: {
          title: 'Order Could Not Be Fulfilled',
          customerName: name,
          trackingCode: order.tracking_code,
          reason: reason || 'No reason provided',
          message: 'Unfortunately, your order could not be fulfilled.',
        },
      });
    }
  } catch (err) {
    console.error('notifyOrderRejected error:', err.message);
  }
}

async function notifyOrderReady(order, tenantId) {
  try {
    const { data: admins } = await supabase
      .from('users')
      .select('id, email, name')
      .eq('tenant_id', tenantId)
      .eq('role', 'admin');

    if (admins && admins.length > 0) {
      await insertDbNotification(
        tenantId,
        admins.map(a => a.id),
        'An order is ready for dispatch!',
        'UtensilsCrossed',
        `/manager?order=${order.id}`
      );
    }

    for (const admin of (admins || [])) {
      await sendTemplatedEmail({
        to: admin.email,
        subject: `Order Ready — ${order.tracking_code}`,
        template: 'orderReady',
        data: {
          title: 'Order Ready for Delivery',
          adminName: admin.name,
          trackingCode: order.tracking_code,
          message: `Order ${order.tracking_code} is ready and needs a delivery person assigned.`,
        },
      });
    }
  } catch (err) {
    console.error('notifyOrderReady error:', err.message);
  }
}

async function notifyDeliveryAssigned(order, driver) {
  try {
    if (order.customer_id) {
      await insertDbNotification(
        order.tenant_id, 
        [order.customer_id], 
        'A driver has been assigned to your order!', 
        'Bike',
        order.tracking_code ? `/track?code=${order.tracking_code}` : null
      );
    }
    
    // Notify the driver as well
    if (driver && driver.id) {
      await insertDbNotification(
        order.tenant_id, 
        [driver.id], 
        `You have been assigned a new delivery for order ${order.tracking_code}!`, 
        'Bike',
        `/delivery?order=${order.id}`
      );
    }

    const email = await getCustomerEmail(order);
    const name = await getCustomerName(order);

    if (email) {
      await sendTemplatedEmail({
        to: email,
        subject: `Delivery On The Way — ${order.tracking_code}`,
        template: 'deliveryAssigned',
        data: {
          title: 'Your Order Is On The Way',
          customerName: name,
          trackingCode: order.tracking_code,
          driverName: driver.name,
          driverPhone: driver.phone,
          driverPlateNumber: driver.plate_number,
          message: 'Your delivery person is on the way with your order.',
        },
      });
    }
  } catch (err) {
    console.error('notifyDeliveryAssigned error:', err.message);
  }
}

async function notifyOrderDelivered(order) {
  try {
    if (order.customer_id) {
      await insertDbNotification(
        order.tenant_id, 
        [order.customer_id], 
        'Your order has been delivered! Enjoy your meal!', 
        'PartyPopper',
        order.tracking_code ? `/track?code=${order.tracking_code}` : null
      );
    }

    const email = await getCustomerEmail(order);
    const name = await getCustomerName(order);

    if (email) {
      await sendTemplatedEmail({
        to: email,
        subject: `Order Delivered — ${order.tracking_code}`,
        template: 'orderDelivered',
        data: {
          title: 'Order Delivered',
          customerName: name,
          trackingCode: order.tracking_code,
          message: 'Your order has been delivered. Thank you for your patronage!',
        },
      });
    }
  } catch (err) {
    console.error('notifyOrderDelivered error:', err.message);
  }
}

module.exports = {
  notifyOrderPlaced,
  notifyOrderApproved,
  notifyOrderRejected,
  notifyOrderReady,
  notifyDeliveryAssigned,
  notifyOrderDelivered,
};
