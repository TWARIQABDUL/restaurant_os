import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import api from '../services/api';
import { getSocket } from '../services/socket';
import toast from 'react-hot-toast';

export default function TrackOrder() {
  const [searchParams] = useSearchParams();
  const initialCode = searchParams.get('code') || '';
  
  const [trackingCode, setTrackingCode] = useState(initialCode);
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchOrder = async (code) => {
    if (!code) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get(`/orders/track/${code}`);
      setOrder(data.order);
      
      // Join tracking room via socket
      const socket = getSocket();
      if (socket) {
        socket.emit('trackOrder', code);
      }
    } catch (err) {
      setError('Order not found. Please check your tracking code.');
      setOrder(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialCode) {
      fetchOrder(initialCode);
    }
    
    const socket = getSocket();
    if (!socket) return;

    const handlers = {
      orderApproved: () => {
        toast.success('Your order has been approved!');
        fetchOrder(trackingCode);
      },
      orderRejected: () => {
        toast.error('Unfortunately, your order was rejected.');
        fetchOrder(trackingCode);
      },
      deliveryAssigned: () => {
        toast.success('A driver has been assigned to your order!');
        fetchOrder(trackingCode);
      },
      orderDelivered: () => {
        toast.success('Your order has been delivered! Enjoy your meal!');
        fetchOrder(trackingCode);
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
  }, [initialCode]);

  const handleSubmit = (e) => {
    e.preventDefault();
    fetchOrder(trackingCode);
  };

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

  return (
    <div className="page" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h1 className="text-center mb-6">Track Your Order</h1>

      <form onSubmit={handleSubmit} className="flex gap-2 mb-8">
        <input 
          type="text" 
          className="form-input flex-1" 
          placeholder="Enter Tracking Code (e.g. ORD-12345)" 
          value={trackingCode}
          onChange={(e) => setTrackingCode(e.target.value)}
          required
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Searching...' : 'Track'}
        </button>
      </form>

      {error && <div className="form-error text-center p-4 bg-red-50 text-red-700 rounded mb-6">{error}</div>}

      {order && (
        <div className="card">
          <div className="flex justify-between items-center mb-6 pb-4 border-b">
            <div>
              <div className="text-sm text-secondary uppercase tracking-wide mb-1">Order Number</div>
              <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-accent)' }}>
                {order.tracking_code}
              </div>
            </div>
            <div className={getStatusBadge(order.status)}>
              {order.status}
            </div>
          </div>

          <div className="grid grid-2 gap-4 mb-6">
            <div>
              <div className="text-xs text-secondary uppercase mb-1">Date</div>
              <div style={{ fontWeight: 500 }}>{new Date(order.created_at).toLocaleString()}</div>
            </div>
            <div>
              <div className="text-xs text-secondary uppercase mb-1">Payment Status</div>
              <div className={`badge ${order.payment_status === 'paid' ? 'badge-paid' : 'badge-unpaid'}`}>
                {order.payment_status}
              </div>
            </div>
          </div>

          {order.status === 'assigned' && order.delivery_person && order.delivery_type === 'internal' && (
            <div className="mb-6 p-4 rounded-lg bg-blue-50 border border-blue-100">
              <h4 className="mb-2 text-blue-800">Your Delivery is on the way!</h4>
              <p className="text-sm mb-1"><strong>Driver:</strong> {order.delivery_person.name}</p>
              <p className="text-sm mb-1"><strong>Phone:</strong> {order.delivery_person.phone}</p>
              <p className="text-sm text-blue-600"><strong>Plate:</strong> {order.delivery_person.plate_number}</p>
            </div>
          )}
          
          {order.status === 'assigned' && order.delivery_type === 'external' && order.external_rider_info && (
            <div className="mb-6 p-4 rounded-lg bg-blue-50 border border-blue-100">
              <h4 className="mb-2 text-blue-800">Your Delivery is on the way! (External Partner)</h4>
              <p className="text-sm mb-1"><strong>Driver:</strong> {order.external_rider_info.name}</p>
              <p className="text-sm mb-1"><strong>Phone:</strong> {order.external_rider_info.phone}</p>
              {order.external_rider_info.plateNumber && <p className="text-sm text-blue-600"><strong>Plate:</strong> {order.external_rider_info.plateNumber}</p>}
            </div>
          )}

          <h4 className="mb-3">Order Details</h4>
          <div className="mb-4">
            {order.order_items?.map((item, idx) => (
              <div key={idx} className="flex justify-between text-sm mb-2">
                <div>
                  {item.quantity}x {item.menu_item?.name}
                  {item.order_item_addons?.map(ao => (
                    <div key={ao.id} className="text-xs text-secondary pl-3">
                      + {ao.quantity}x {ao.add_on?.name}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          
          <div className="flex justify-between items-center pt-4 border-t">
            <span style={{ fontWeight: 600 }}>Total</span>
            <span style={{ fontWeight: 700 }}>${parseFloat(order.total_amount).toFixed(2)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
