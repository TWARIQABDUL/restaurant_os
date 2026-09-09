import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getSocket } from '../services/socket';

export default function DeliveryDashboard() {
  const { user } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchParams] = useSearchParams();
  const targetOrderId = searchParams.get('order');

  const fetchOrders = async () => {
    try {
      const { data } = await api.get('/delivery/my-orders');
      setOrders(data.orders || []);
    } catch (err) {
      console.error('Failed to fetch delivery orders', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!loading && targetOrderId) {
      const element = document.getElementById(`order-${targetOrderId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.style.boxShadow = '0 0 0 4px var(--color-accent)';
        setTimeout(() => {
          element.style.boxShadow = 'var(--shadow-sm)';
        }, 2000);
      }
    }
  }, [loading, targetOrderId]);

  useEffect(() => {
    fetchOrders();

    const socket = getSocket();
    if (!socket) return;

    socket.on('newDelivery', () => {
      fetchOrders();
    });

    return () => {
      socket.off('newDelivery');
    };
  }, []);

  const markDelivered = async (id) => {
    try {
      await api.patch(`/orders/${id}/delivered`);
      fetchOrders();
    } catch (err) {
      alert('Failed to mark as delivered');
    }
  };

  return (
    <div className="page mx-auto max-w-3xl px-4">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold">Driver dashboard</h1>
        <p className="text-sm text-[#475569]">{user.name} • {user.plate_number}</p>
      </div>

      {loading ? (
        <div className="loading-page"><div className="spinner" /></div>
      ) : orders.length === 0 ? (
        <div className="empty-state">
          <h3>No active deliveries</h3>
          <p>You currently have no orders assigned to you.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {orders.map(order => (
            <div key={order.id} id={`order-${order.id}`} className="card transition-shadow">
              <div className="mb-4 flex items-start justify-between gap-3 border-b border-[#e2e8f0] pb-4">
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-heading text-xl font-bold">#{order.tracking_code}</span>
                    <span className={`badge ${order.status === 'delivered' ? 'badge-delivered' : 'badge-assigned'}`}>
                      {order.status}
                    </span>
                  </div>
                  <div className="text-sm text-[#94a3b8]">
                    Assigned: {new Date(order.updated_at).toLocaleTimeString()}
                  </div>
                </div>

                {order.status === 'assigned' && (
                  <button className="btn btn-success btn-lg" onClick={() => markDelivered(order.id)}>
                    Mark delivered
                  </button>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-[#e2e8f0] bg-[#f8fafc] p-4">
                  <div className="mb-2 text-xs uppercase tracking-wide text-[#94a3b8]">Customer details</div>
                  <div className="font-semibold">{order.guest_name || order.customer?.name}</div>
                  <div className="text-[#475569]">{order.guest_phone || order.customer?.phone}</div>
                  <div className="mt-2 text-sm">
                    <strong>Address:</strong><br />
                    {order.guest_address || 'Address provided on file'}
                  </div>
                </div>

                <div className="rounded-lg border border-[#e2e8f0] bg-[#f8fafc] p-4">
                  <div className="mb-2 text-xs uppercase tracking-wide text-[#94a3b8]">Order info</div>
                  <div className="mb-2">
                    <span className={`badge ${order.payment_status === 'paid' ? 'badge-paid' : 'badge-unpaid'}`}>
                      Payment: {order.payment_method.replace(/_/g, ' ')} • {order.payment_status}
                    </span>
                  </div>
                  {order.delivery_notes && (
                    <div className="text-sm text-yellow-800 bg-yellow-50 p-2 rounded">
                      <strong>Note:</strong> {order.delivery_notes}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
