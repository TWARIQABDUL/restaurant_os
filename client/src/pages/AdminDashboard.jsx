import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getSocket } from '../services/socket';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line
} from 'recharts';
import MenuManagement from '../components/MenuManagement';
import toast from 'react-hot-toast';

const COLORS = ['#e8890c', '#2563eb', '#2d8a4e', '#c53030', '#8b5cf6'];

export default function AdminDashboard() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('analytics');
  
  // Analytics State
  const [summary, setSummary] = useState(null);
  const [revenue, setRevenue] = useState([]);
  const [topItems, setTopItems] = useState([]);
  
  // Delivery State
  const [readyOrders, setReadyOrders] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dispatchState, setDispatchState] = useState({});

  useEffect(() => {
    if (activeTab === 'analytics') {
      fetchAnalytics();
    } else if (activeTab === 'delivery') {
      fetchDeliveryData();
    }
  }, [activeTab]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    socket.on('orderReady', () => {
      toast.success('An order is ready for dispatch!');
      if (activeTab === 'delivery') fetchDeliveryData();
    });

    socket.on('newOrder', () => {
      toast.success('A new order has been placed!');
      if (activeTab === 'analytics') fetchAnalytics();
    });

    return () => {
      socket.off('orderReady');
      socket.off('newOrder');
    };
  }, [activeTab]);

  const fetchAnalytics = async () => {
    setLoading(true);
    try {
      const [sumRes, revRes, topRes] = await Promise.all([
        api.get('/analytics/summary'),
        api.get('/analytics/revenue'),
        api.get('/analytics/top-items')
      ]);
      setSummary(sumRes.data.summary);
      setRevenue(revRes.data.revenue);
      setTopItems(topRes.data.topItems);
    } catch (err) {
      console.error('Failed to load analytics', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchDeliveryData = async () => {
    setLoading(true);
    try {
      const [ordersRes, driversRes] = await Promise.all([
        api.get('/orders', { params: { status: 'ready' } }),
        api.get('/delivery/drivers')
      ]);
      setReadyOrders(ordersRes.data.orders);
      setDrivers(driversRes.data.drivers);
    } catch (err) {
      console.error('Failed to load delivery data', err);
    } finally {
      setLoading(false);
    }
  };

  const assignDriver = async (orderId, payload) => {
    try {
      await api.patch(`/orders/${orderId}/assign`, payload);
      fetchDeliveryData();
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

  return (
    <div className="page">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1>Admin Dashboard</h1>
          <p className="text-secondary">Overview & Analytics</p>
        </div>
        <div className="flex gap-2">
          <button 
            className={`btn ${activeTab === 'analytics' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('analytics')}
          >
            Analytics
          </button>
          <button 
            className={`btn ${activeTab === 'delivery' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('delivery')}
          >
            Dispatch & Delivery
          </button>
          <button 
            className={`btn ${activeTab === 'menu' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('menu')}
          >
            Menu Management
          </button>
        </div>
      </div>

      {loading && <div className="loading-page"><div className="spinner" /></div>}

      {!loading && activeTab === 'analytics' && summary && (
        <>
          <div className="stats-grid mb-8">
            <div className="stat-card">
              <div className="stat-card-label">Today's Revenue</div>
              <div className="stat-card-value text-accent">${summary.totalRevenue.toFixed(2)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Total Orders</div>
              <div className="stat-card-value">{summary.totalOrders}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Pending / Ready</div>
              <div className="stat-card-value">{summary.pendingOrders} / {summary.readyOrders}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Delivered</div>
              <div className="stat-card-value">{summary.deliveredOrders}</div>
            </div>
          </div>

          <div className="grid grid-2 mb-8">
            <div className="card">
              <h3 className="mb-6">Revenue Trend</h3>
              <div style={{ height: 300 }}>
                {revenue.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={revenue}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                      <XAxis dataKey="date" tick={{fontSize: 12}} tickLine={false} axisLine={false} />
                      <YAxis tick={{fontSize: 12}} tickLine={false} axisLine={false} tickFormatter={val => `$${val}`} />
                      <Tooltip formatter={(value) => [`$${parseFloat(value).toFixed(2)}`, 'Revenue']} />
                      <Line type="monotone" dataKey="amount" stroke="var(--color-accent)" strokeWidth={3} dot={{r: 4}} activeDot={{r: 6}} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted">No revenue data available</div>
                )}
              </div>
            </div>

            <div className="card">
              <h3 className="mb-6">Top Selling Items</h3>
              <div style={{ height: 300 }}>
                {topItems.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={topItems} layout="vertical" margin={{ left: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#eee" />
                      <XAxis type="number" hide />
                      <YAxis dataKey="name" type="category" tick={{fontSize: 12}} tickLine={false} axisLine={false} width={100} />
                      <Tooltip />
                      <Bar dataKey="totalQuantity" fill="var(--color-info)" radius={[0, 4, 4, 0]}>
                        {topItems.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted">No order data available</div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {!loading && activeTab === 'delivery' && (
        <div className="grid grid-2" style={{ gridTemplateColumns: '2fr 1fr' }}>
          <div>
            <h3 className="mb-4">Orders Ready for Dispatch</h3>
            {readyOrders.length === 0 ? (
              <div className="card text-center p-8 text-secondary">
                No orders currently waiting for dispatch.
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {readyOrders.map(order => (
                  <div key={order.id} className="card flex justify-between items-center">
                    <div>
                      <div className="font-bold mb-1">#{order.tracking_code}</div>
                      <div className="text-sm text-secondary mb-1">
                        {order.guest_name || order.customer?.name} • {order.guest_address || 'Customer Address'}
                      </div>
                      <div className="text-xs text-muted">
                        Ready since: {new Date(order.updated_at).toLocaleTimeString()}
                      </div>
                    </div>
                    <div className="w-full mt-2">
                      {(() => {
                        const state = dispatchState[order.id] || { type: 'internal', name: '', phone: '', plate: '' };
                        return (
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 w-full">
                              <select 
                                className="form-select form-select-sm"
                                value={state.type}
                                onChange={e => handleDispatchState(order.id, 'type', e.target.value)}
                                style={{ width: '130px' }}
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
                                <div className="flex gap-1 flex-1">
                                  <input type="text" className="form-input form-input-sm" style={{ padding: '4px 8px' }} placeholder="Name (e.g. Uber)" value={state.name} onChange={e => handleDispatchState(order.id, 'name', e.target.value)} />
                                  <input type="text" className="form-input form-input-sm" style={{ padding: '4px 8px' }} placeholder="Phone" value={state.phone} onChange={e => handleDispatchState(order.id, 'phone', e.target.value)} />
                                  <input type="text" className="form-input form-input-sm" style={{ padding: '4px 8px' }} placeholder="Plate (Optional)" value={state.plate} onChange={e => handleDispatchState(order.id, 'plate', e.target.value)} />
                                </div>
                              )}
                              
                              <button 
                                className="btn btn-primary btn-sm whitespace-nowrap"
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
                                Assign
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="mb-4">Available Drivers</h3>
            <div className="card">
              {drivers.map((driver, idx) => (
                <div key={driver.id} className="flex items-center gap-3 py-3" style={{ borderBottom: idx < drivers.length - 1 ? '1px solid var(--color-border)' : 'none' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'var(--color-bg-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', color: 'var(--color-text-secondary)' }}>
                    {driver.name.charAt(0)}
                  </div>
                  <div>
                    <div style={{ fontWeight: 500 }}>{driver.name}</div>
                    <div className="text-xs text-secondary">{driver.phone} • {driver.plate_number || 'N/A'}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {!loading && activeTab === 'menu' && (
        <MenuManagement />
      )}
    </div>
  );
}
