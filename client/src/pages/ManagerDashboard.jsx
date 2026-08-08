import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getSocket } from '../services/socket';
import MenuManagement from '../components/MenuManagement';
import toast from 'react-hot-toast';
import { Clock, ChevronDown, ChevronUp } from 'lucide-react';

const COLUMNS = [
  { key: 'pending', label: 'Pending', statuses: ['pending'] },
  { key: 'kitchen', label: 'In the Kitchen', statuses: ['approved', 'preparing'] },
  { key: 'ready', label: 'Ready', statuses: ['ready'] },
  { key: 'dispatched', label: 'Out for Delivery', statuses: ['assigned'] },
];

function getElapsedLabel(dateString) {
  const diffMs = Date.now() - new Date(dateString).getTime();
  const diffMin = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  return `${diffHr}h ${remMin}m ago`;
}

export default function ManagerDashboard() {
  const { user } = useAuth();
  const [orders, setOrders] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dispatchState, setDispatchState] = useState({});
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [, setTick] = useState(0);
  const [searchParams] = useSearchParams();
  const targetOrderId = searchParams.get('order');

  const [activeTab, setActiveTab] = useState('orders');

  const fetchOrders = async () => {
    try {
      const [ordersRes, driversRes] = await Promise.all([
        api.get('/orders'),
        api.get('/delivery/drivers')
      ]);
      setOrders(ordersRes.data.orders || []);
      setDrivers(driversRes.data.drivers || []);
    } catch (err) {
      console.error('Failed to fetch manager orders', err);
    } finally {
      setLoading(false);
    }
  };

  // Re-render every 30s so "x minutes ago" labels stay fresh even with no new orders
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!loading && targetOrderId && activeTab === 'orders') {
      const element = document.getElementById(`order-${targetOrderId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.style.boxShadow = '0 0 0 4px var(--color-accent)';
        setTimeout(() => {
          element.style.boxShadow = '';
        }, 2000);
      }
    }
  }, [loading, targetOrderId, activeTab]);

  useEffect(() => {
    if (activeTab === 'orders') {
      fetchOrders();
    }

    const socket = getSocket();
    if (!socket) return;

    const notify = () => {
      toast.success('New order received!');
      fetchOrders();
    };
    const silentRefetch = () => fetchOrders();

    // newOrder needs a toast; the rest just need the board to stay in sync,
    // since they're triggered by other roles (customers, drivers, other managers).
    socket.on('newOrder', notify);
    socket.on('orderApproved', silentRefetch);
    socket.on('orderRejected', silentRefetch);
    socket.on('orderReady', silentRefetch);
    socket.on('deliveryAssigned', silentRefetch);
    socket.on('orderDelivered', silentRefetch);

    return () => {
      socket.off('newOrder', notify);
      socket.off('orderApproved', silentRefetch);
      socket.off('orderRejected', silentRefetch);
      socket.off('orderReady', silentRefetch);
      socket.off('deliveryAssigned', silentRefetch);
      socket.off('orderDelivered', silentRefetch);
    };
  }, [activeTab]);

  const updateOrderStatus = async (id, action) => {
    try {
      await api.patch(`/orders/${id}/${action}`);
      fetchOrders();
    } catch (err) {
      toast.error(err.response?.data?.error || `Failed to mark as ${action}`);
    }
  };

  const confirmPayment = async (id) => {
    try {
      await api.patch(`/orders/${id}/payment`);
      fetchOrders();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to confirm payment');
    }
  };

  const assignDriver = async (orderId, payload) => {
    try {
      await api.patch(`/orders/${orderId}/assign`, payload);
      fetchOrders();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to assign driver');
    }
  };

  const submitReject = async (orderId) => {
    if (!rejectReason.trim()) return;
    try {
      await api.patch(`/orders/${orderId}/reject`, { reason: rejectReason.trim() });
      setRejectingId(null);
      setRejectReason('');
      fetchOrders();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reject order');
    }
  };

  const handleDispatchState = (orderId, field, value) => {
    setDispatchState(prev => ({
      ...prev,
      [orderId]: {
        ...(prev[orderId] || { type: 'internal', name: '', phone: '', plate: '', driverId: '' }),
        [field]: value
      }
    }));
  };

  const getStatusBadge = (status) => {
    const map = {
      pending: 'badge-pending',
      approved: 'badge-approved',
      preparing: 'badge-preparing',
      ready: 'badge-ready',
      assigned: 'badge-assigned',
      delivered: 'badge-delivered',
      rejected: 'badge-rejected'
    };
    return `badge ${map[status] || ''}`;
  };

  const historyOrders = useMemo(
    () =>
      orders
        .filter(o => o.status === 'delivered' || o.status === 'rejected')
        .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at)),
    [orders]
  );

  const renderOrderCard = (order) => (
    <div key={order.id} id={`order-${order.id}`} className="card" style={{ transition: 'box-shadow 0.5s ease' }}>
      <div className="flex justify-between items-start mb-3 pb-3 border-b">
        <div>
          <div className="flex items-center gap-2 mb-1" style={{ flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>#{order.tracking_code}</span>
            <span className={getStatusBadge(order.status)}>{order.status}</span>
          </div>
          <div className="text-sm text-secondary mb-1">
            {order.guest_name || order.customer?.name} • {order.guest_phone || order.customer?.phone}
          </div>
          <div className="text-sm text-secondary flex items-center gap-1">
            <Clock size={12} /> {getElapsedLabel(order.created_at)}
          </div>
        </div>
        <div style={{ fontWeight: 700, color: 'var(--color-accent)', whiteSpace: 'nowrap' }}>
          ${parseFloat(order.total_amount).toFixed(2)}
        </div>
      </div>

      <div className="mb-3">
        <span className={`badge ${order.payment_status === 'paid' ? 'badge-paid' : 'badge-unpaid'}`} style={{ marginBottom: 'var(--space-2)', display: 'inline-block' }}>
          {order.payment_method.replace(/_/g, ' ')} • {order.payment_status}
        </span>
        {order.order_items?.map((item, idx) => (
          <div key={idx} className="flex justify-between text-sm mb-1">
            <span>{item.quantity}x {item.menu_item?.name}</span>
            {item.order_item_addons?.length > 0 && (
              <span className="text-secondary text-xs pl-2">
                (+ {item.order_item_addons.map(a => `${a.quantity}x ${a.add_on?.name}`).join(', ')})
              </span>
            )}
          </div>
        ))}
        {order.delivery_notes && (
          <div className="mt-3 p-3 bg-yellow-50 rounded text-sm text-yellow-800 border border-yellow-200">
            <strong>Note:</strong> {order.delivery_notes}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 pt-3 border-t">
        {order.status === 'pending' && rejectingId !== order.id && (
          <div className="flex gap-2">
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => updateOrderStatus(order.id, 'approve')}>Approve</button>
            <button className="btn btn-danger" onClick={() => { setRejectingId(order.id); setRejectReason(''); }}>Reject</button>
          </div>
        )}

        {order.status === 'pending' && rejectingId === order.id && (
          <div className="flex flex-col gap-2 p-3 bg-red-50 rounded">
            <input
              type="text"
              className="form-input"
              placeholder="Reason for rejection..."
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <button className="btn btn-danger" style={{ flex: 1 }} disabled={!rejectReason.trim()} onClick={() => submitReject(order.id)}>
                Confirm Reject
              </button>
              <button className="btn btn-secondary" onClick={() => setRejectingId(null)}>Cancel</button>
            </div>
          </div>
        )}

        {order.status === 'approved' && (
          <button className="btn btn-primary" onClick={() => updateOrderStatus(order.id, 'preparing')}>Start Preparing</button>
        )}
        {order.status === 'preparing' && (
          <button className="btn btn-success" onClick={() => updateOrderStatus(order.id, 'ready')}>Mark Ready</button>
        )}
        {order.status === 'ready' && (() => {
          const state = dispatchState[order.id] || { type: 'internal', name: '', phone: '', plate: '', driverId: '' };
          const canDispatch = state.type === 'internal' ? !!state.driverId : (state.name.trim() && state.phone.trim());
          return (
            <div className="flex flex-col gap-2 p-3 bg-gray-50 border border-gray-200 rounded">
              <select
                className="form-select"
                value={state.type}
                onChange={e => handleDispatchState(order.id, 'type', e.target.value)}
              >
                <option value="internal">Internal Driver</option>
                <option value="external">External Rider</option>
              </select>

              {state.type === 'internal' ? (
                <select
                  className="form-select"
                  value={state.driverId}
                  onChange={e => handleDispatchState(order.id, 'driverId', e.target.value)}
                >
                  <option value="">Select Driver...</option>
                  {drivers.map(driver => (
                    <option key={driver.id} value={driver.id}>
                      {driver.name} ({driver.plate_number || 'No Plate'})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex flex-col gap-2">
                  <input type="text" className="form-input" placeholder="Name (e.g. Uber)" value={state.name} onChange={e => handleDispatchState(order.id, 'name', e.target.value)} />
                  <input type="text" className="form-input" placeholder="Phone" value={state.phone} onChange={e => handleDispatchState(order.id, 'phone', e.target.value)} />
                  <input type="text" className="form-input" placeholder="Plate (optional)" value={state.plate} onChange={e => handleDispatchState(order.id, 'plate', e.target.value)} />
                </div>
              )}

              <button
                className="btn btn-primary whitespace-nowrap"
                disabled={!canDispatch}
                onClick={() => {
                  if (state.type === 'internal') {
                    assignDriver(order.id, { assign_type: 'internal', delivery_person_id: state.driverId });
                  } else {
                    assignDriver(order.id, {
                      assign_type: 'external',
                      external_rider_info: { name: state.name, phone: state.phone, plateNumber: state.plate }
                    });
                  }
                }}
              >
                Dispatch
              </button>
            </div>
          );
        })()}

        {order.status === 'assigned' && (
          <div className="text-sm text-secondary">
            On its way — waiting for the driver to mark it delivered.
          </div>
        )}

        {order.payment_status === 'unpaid' && (
          <button className="btn btn-secondary" onClick={() => confirmPayment(order.id)}>Confirm Payment</button>
        )}
      </div>
    </div>
  );

  return (
    <div className="page">
      <div className="flex justify-between items-center mb-8" style={{ flexWrap: 'wrap', gap: 'var(--space-4)' }}>
        <div>
          <h1>Manager Dashboard</h1>
          <p className="text-secondary">Welcome, {user.name}</p>
        </div>
        <div className="flex gap-2">
          <button
            className={`btn ${activeTab === 'orders' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('orders')}
          >
            Live Orders
          </button>
          <button
            className={`btn ${activeTab === 'menu' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('menu')}
          >
            Menu Management
          </button>
        </div>
      </div>

      {activeTab === 'orders' && (
        <>
          {loading ? (
            <div className="loading-page"><div className="spinner" /></div>
          ) : orders.length === 0 ? (
            <div className="empty-state"><h3>No active orders</h3></div>
          ) : (
            <>
              <div className="kanban-board">
                {COLUMNS.map(column => {
                  const columnOrders = orders
                    .filter(o => column.statuses.includes(o.status))
                    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                  return (
                    <div key={column.key} className="kanban-column">
                      <div className="kanban-column-header">
                        <h3 style={{ fontSize: 'var(--font-size-base)' }}>{column.label}</h3>
                        <span className="kanban-count">{columnOrders.length}</span>
                      </div>
                      {columnOrders.length === 0 ? (
                        <div className="kanban-empty">Nothing here</div>
                      ) : (
                        columnOrders.map(renderOrderCard)
                      )}
                    </div>
                  );
                })}
              </div>

              {historyOrders.length > 0 && (
                <div className="mt-8">
                  <button className="btn btn-secondary" onClick={() => setShowHistory(v => !v)}>
                    {showHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    {showHistory ? 'Hide' : 'Show'} completed orders ({historyOrders.length})
                  </button>
                  {showHistory && (
                    <div className="mt-4 table-wrapper">
                      <table>
                        <thead>
                          <tr>
                            <th>Order</th>
                            <th>Status</th>
                            <th>Customer</th>
                            <th>Total</th>
                            <th>Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {historyOrders.map(order => (
                            <tr key={order.id}>
                              <td>#{order.tracking_code}</td>
                              <td><span className={getStatusBadge(order.status)}>{order.status}</span></td>
                              <td>{order.guest_name || order.customer?.name}</td>
                              <td>${parseFloat(order.total_amount).toFixed(2)}</td>
                              <td>{new Date(order.updated_at || order.created_at).toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {activeTab === 'menu' && (
        <MenuManagement />
      )}
    </div>
  );
}