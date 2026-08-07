import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getSocket } from '../services/socket';
import MenuManagement from '../components/MenuManagement';
import toast from 'react-hot-toast';

export default function ManagerDashboard() {
  const { user } = useAuth();
  const [orders, setOrders] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dispatchState, setDispatchState] = useState({});
  const [searchParams] = useSearchParams();
  const targetOrderId = searchParams.get('order');

  // Simple tabs: Orders | Menu Management
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

  useEffect(() => {
    if (!loading && targetOrderId && activeTab === 'orders') {
      const element = document.getElementById(`order-${targetOrderId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Optional: highlight the element
        element.style.boxShadow = '0 0 0 4px var(--color-accent)';
        setTimeout(() => {
          element.style.boxShadow = 'var(--shadow-sm)';
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

    const handlers = {
      newOrder: () => {
        toast.success('New order received!');
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
  }, [activeTab]);

  const updateOrderStatus = async (id, action) => {
    try {
      await api.patch(`/orders/${id}/${action}`);
      fetchOrders();
    } catch (err) {
      alert(err.response?.data?.error || `Failed to mark as ${action}`);
    }
  };

  const confirmPayment = async (id) => {
    try {
      await api.patch(`/orders/${id}/payment`);
      fetchOrders();
    } catch (err) {
      alert('Failed to confirm payment');
    }
  };

  const assignDriver = async (orderId, payload) => {
    try {
      await api.patch(`/orders/${orderId}/assign`, payload);
      fetchOrders();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to assign driver');
    }
  };

  const handleDispatchState = (orderId, field, value) => {
    setDispatchState(prev => ({
      ...prev,
      [orderId]: {
        ...(prev[orderId] || { type: 'internal', name: '', phone: '', plate: '' }),
        [field]: value
      }
    }));
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
    <div className="page">
      <div className="flex justify-between items-center mb-8">
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
          ) : (
            <div className="flex flex-col gap-6">
              {orders.length === 0 ? (
                <div className="empty-state"><h3>No active orders</h3></div>
              ) : (
                orders.map(order => (
                  <div key={order.id} id={`order-${order.id}`} className="card" style={{ transition: 'box-shadow 0.5s ease' }}>
                    <div className="flex justify-between items-start mb-4 pb-4 border-b">
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600 }}>#{order.tracking_code}</span>
                          <span className={getStatusBadge(order.status)}>{order.status}</span>
                          <span className={`badge ${order.payment_status === 'paid' ? 'badge-paid' : 'badge-unpaid'}`}>
                            {order.payment_method.replace(/_/g, ' ')} • {order.payment_status}
                          </span>
                        </div>
                        <div className="text-sm text-secondary">
                          {order.guest_name || order.customer?.name} • {order.guest_phone || order.customer?.phone}
                        </div>
                        <div className="text-sm text-secondary">
                          Ordered: {new Date(order.created_at).toLocaleTimeString()}
                        </div>
                      </div>
                      
                      <div className="text-right">
                        <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-accent)' }}>
                          ${parseFloat(order.total_amount).toFixed(2)}
                        </div>
                      </div>
                    </div>

                    <div className="mb-4">
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

                    <div className="flex gap-2 pt-4 border-t">
                      {order.status === 'pending' && (
                        <>
                          <button className="btn btn-primary" onClick={() => updateOrderStatus(order.id, 'approve')}>Approve</button>
                          <button className="btn btn-danger" onClick={() => {
                            const reason = prompt('Reason for rejection?');
                            if (reason) {
                              api.patch(`/orders/${order.id}/reject`, { reason }).then(fetchOrders);
                            }
                          }}>Reject</button>
                        </>
                      )}
                      {order.status === 'approved' && (
                        <button className="btn btn-primary" onClick={() => updateOrderStatus(order.id, 'preparing')}>Start Preparing</button>
                      )}
                      {order.status === 'preparing' && (
                        <button className="btn btn-success" onClick={() => updateOrderStatus(order.id, 'ready')}>Mark Ready</button>
                      )}
                      {order.status === 'ready' && (() => {
                        const state = dispatchState[order.id] || { type: 'internal', name: '', phone: '', plate: '' };
                        return (
                          <div className="flex flex-col gap-2 w-full mt-2 p-3 bg-gray-50 border border-gray-200 rounded">
                            <div className="flex items-center gap-2">
                              <select 
                                className="form-select form-select-sm"
                                value={state.type}
                                onChange={e => handleDispatchState(order.id, 'type', e.target.value)}
                                style={{ width: '150px' }}
                              >
                                <option value="internal">Internal Driver</option>
                                <option value="external">External Rider</option>
                              </select>
                              
                              {state.type === 'internal' ? (
                                <select 
                                  className="form-select form-select-sm flex-1" 
                                  id={`driver-select-${order.id}`}
                                  defaultValue=""
                                >
                                  <option value="" disabled>Select Driver...</option>
                                  {drivers.map(driver => (
                                    <option key={driver.id} value={driver.id}>
                                      {driver.name} ({driver.plate_number || 'No Plate'})
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <div className="flex gap-2 flex-1">
                                  <input type="text" className="form-input" style={{ padding: '4px 8px' }} placeholder="Name (e.g. Uber)" value={state.name} onChange={e => handleDispatchState(order.id, 'name', e.target.value)} />
                                  <input type="text" className="form-input" style={{ padding: '4px 8px' }} placeholder="Phone" value={state.phone} onChange={e => handleDispatchState(order.id, 'phone', e.target.value)} />
                                  <input type="text" className="form-input" style={{ padding: '4px 8px' }} placeholder="Plate (Optional)" value={state.plate} onChange={e => handleDispatchState(order.id, 'plate', e.target.value)} />
                                </div>
                              )}
                              
                              <button 
                                className="btn btn-primary whitespace-nowrap"
                                onClick={() => {
                                  if (state.type === 'internal') {
                                    const select = document.getElementById(`driver-select-${order.id}`);
                                    if (select.value) {
                                      assignDriver(order.id, { assign_type: 'internal', delivery_person_id: select.value });
                                    } else {
                                      alert('Please select a driver first');
                                    }
                                  } else {
                                    if (!state.name || !state.phone) return alert('Name and phone are required for external riders');
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
                          </div>
                        );
                      })()}
                      
                      {order.payment_status === 'unpaid' && (
                        <button className="btn btn-secondary ml-auto" onClick={() => confirmPayment(order.id)}>Confirm Payment</button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}

      {activeTab === 'menu' && (
        <MenuManagement />
      )}
    </div>
  );
}
