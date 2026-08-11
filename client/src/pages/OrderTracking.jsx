import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../services/api';
import { getSocket } from '../services/socket';
import toast from 'react-hot-toast';

export default function OrderTracking() {
  const { tenantSlug } = useParams();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchOrders = async () => {
    try {
      const { data } = await api.get('/orders/me');
      setOrders(data.orders || []);
    } catch (err) {
      console.error('Failed to load orders', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();

    const socket = getSocket();
    if (!socket) return;

    const handlers = {
      orderApproved: () => {
        toast.success('Your order has been approved!');
        fetchOrders();
      },
      orderRejected: () => {
        toast.error('Unfortunately, your order was rejected.');
        fetchOrders();
      },
      deliveryAssigned: () => {
        toast.success('A driver has been assigned to your order!');
        fetchOrders();
      },
      orderDelivered: () => {
        toast.success('Your order has been delivered! Enjoy your meal!');
        fetchOrders();
      },
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      socket.on(event, handler);
    });

    return () => {
      Object.entries(handlers).forEach(([event, handler]) => {
        socket.off(event, handler);
      });
    };
  }, []);

  const getStatusBadge = (status) => {
    const map = {
      'pending': 'badge-pending',
      'approved': 'badge-approved',
      'preparing': 'badge-preparing',
      'ready': 'badge-ready',
      'assigned': 'badge-assigned',
      'delivered': 'badge-delivered',
      'rejected': 'badge-rejected'
    };
    return `badge ${map[status] || ''}`;
  };

  if (loading) {
    return <div className="loading-page"><div className="spinner" /></div>;
  }

  if (orders.length === 0) {
    return (
      <div className="page empty-state">
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>📦</div>
        <h3>No Orders Yet</h3>
        <p className="mb-6">You haven't placed any orders with us yet.</p>
        <Link to="/" className="btn btn-primary">Start Ordering</Link>
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: '800px', margin: '0 auto' }}>
      <h1 className="mb-8">My Orders</h1>

      <div className="flex flex-col gap-6">
        {orders.map((order) => (
          <div key={order.id} className="card">
            <div className="flex justify-between items-center mb-4 pb-4 border-b">
              <div>
                <span className="text-secondary text-sm">Order #{order.tracking_code}</span>
                <div style={{ fontWeight: 600 }}>{new Date(order.created_at).toLocaleDateString()}</div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <span className={getStatusBadge(order.status)}>{order.status}</span>
                <Link to={`/${tenantSlug}/track?code=${order.tracking_code}`} className="text-xs text-accent underline">
                  Live Track
                </Link>
              </div>
            </div>

            <div className="mb-4">
              {order.order_items?.map((item, idx) => (
                <div key={idx} className="flex justify-between text-sm mb-1">
                  <span>{item.quantity}x {item.menu_item?.name}</span>
                  <span className="text-secondary">${(item.quantity * item.unit_price).toFixed(2)}</span>
                </div>
              ))}
            </div>

            {order.status === 'assigned' && order.delivery_person && order.delivery_type === 'internal' && (
              <div className="mb-4 p-3 rounded-lg bg-blue-50 border border-blue-100 text-sm">
                <div className="font-semibold text-blue-800 mb-1">Driver Details</div>
                <div>{order.delivery_person.name} • {order.delivery_person.phone}</div>
                <div className="text-blue-600 text-xs mt-1">Plate: {order.delivery_person.plate_number}</div>
              </div>
            )}
            
            {order.status === 'assigned' && order.delivery_type === 'external' && order.external_rider_info && (
              <div className="mb-4 p-3 rounded-lg bg-blue-50 border border-blue-100 text-sm">
                <div className="font-semibold text-blue-800 mb-1">Driver Details (External Partner)</div>
                <div>{order.external_rider_info.name} • {order.external_rider_info.phone}</div>
                {order.external_rider_info.plateNumber && <div className="text-blue-600 text-xs mt-1">Plate: {order.external_rider_info.plateNumber}</div>}
              </div>
            )}

            <div className="flex justify-between items-center pt-4 border-t">
              <span className={`badge ${order.payment_status === 'paid' ? 'badge-paid' : 'badge-unpaid'}`}>
                {order.payment_method.replace(/_/g, ' ')} • {order.payment_status}
              </span>
              <span style={{ fontWeight: 700 }}>${parseFloat(order.total_amount).toFixed(2)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
