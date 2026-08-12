import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getSocket } from '../services/socket';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line
} from 'recharts';
import MenuManagement from '../components/MenuManagement';
import StaffManagement from '../components/StaffManagement';
import ComplaintsManagement from '../components/ComplaintsManagement';
import toast from 'react-hot-toast';
import { Copy } from 'lucide-react';
import { uploadImage } from '../services/supabase';

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

  // Wallet State
  const [wallet, setWallet] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [paymentSettings, setPaymentSettings] = useState({ settlementMode: 'manual', payoutPhone: '' });
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawPhone, setWithdrawPhone] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // SEO State
  const [seoSettings, setSeoSettings] = useState({ 
    seoTitle: '', seoDescription: '', seoKeywords: '',
    faviconUrl: '', themeColor: '#ffffff', twitterHandle: '', ogLocale: 'en_US', author: ''
  });
  const [faviconFile, setFaviconFile] = useState(null);
  const [savingSeo, setSavingSeo] = useState(false);

  useEffect(() => {
    if (activeTab === 'analytics') {
      fetchAnalytics();
    } else if (activeTab === 'delivery') {
      fetchDeliveryData();
    } else if (activeTab === 'wallet') {
      fetchWallet();
    } else if (activeTab === 'seo') {
      fetchSeoSettings();
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

  const fetchWallet = async () => {
    setLoading(true);
    try {
      const [walletRes, ledgerRes, withdrawalsRes, settingsRes] = await Promise.all([
        api.get('/wallet'),
        api.get('/wallet/ledger'),
        api.get('/wallet/withdrawals'),
        api.get('/tenants/me/payment-settings'),
      ]);
      setWallet(walletRes.data.wallet);
      setLedger(ledgerRes.data.ledger);
      setWithdrawals(withdrawalsRes.data.withdrawals);
      setPaymentSettings(settingsRes.data.payment_settings);
      setWithdrawPhone(settingsRes.data.payment_settings.payoutPhone || '');
    } catch (err) {
      console.error('Failed to load wallet', err);
      toast.error('Failed to load wallet data');
    } finally {
      setLoading(false);
    }
  };

  const handleWithdraw = async () => {
    if (!withdrawPhone.trim()) {
      toast.error('A payout phone number is required');
      return;
    }
    setWithdrawing(true);
    try {
      await api.post('/wallet/withdraw', {
        amount: withdrawAmount ? parseFloat(withdrawAmount) : undefined,
        phone: withdrawPhone.trim(),
      });
      toast.success('Withdrawal submitted');
      setWithdrawAmount('');
      fetchWallet();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Withdrawal failed');
    } finally {
      setWithdrawing(false);
    }
  };

  const savePaymentSettings = async (e) => {
    e.preventDefault();
    setSavingSettings(true);
    try {
      await api.patch('/tenants/me/payment-settings', paymentSettings);
      toast.success('Payment settings saved!');
    } catch (err) {
      toast.error('Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  const fetchSeoSettings = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/tenants/me/seo-settings');
      setSeoSettings({
        seoTitle: data.seo_settings?.seoTitle || '',
        seoDescription: data.seo_settings?.seoDescription || '',
        seoKeywords: data.seo_settings?.seoKeywords || '',
        faviconUrl: data.seo_settings?.faviconUrl || '',
        themeColor: data.seo_settings?.themeColor || '#ffffff',
        twitterHandle: data.seo_settings?.twitterHandle || '',
        ogLocale: data.seo_settings?.ogLocale || 'en_US',
        author: data.seo_settings?.author || ''
      });
    } catch (err) {
      console.error('Failed to load SEO settings', err);
    } finally {
      setLoading(false);
    }
  };

  const saveSeoSettings = async (e) => {
    e.preventDefault();
    setSavingSeo(true);
    try {
      let finalFaviconUrl = seoSettings.faviconUrl;
      
      if (faviconFile) {
        finalFaviconUrl = await uploadImage(faviconFile, 'blog-images', 'favicons');
      }

      await api.patch('/tenants/me/seo-settings', { ...seoSettings, faviconUrl: finalFaviconUrl });
      setFaviconFile(null);
      toast.success('SEO settings saved!');
    } catch (err) {
      toast.error('Failed to save SEO settings');
    } finally {
      setSavingSeo(false);
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
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1>Admin Dashboard</h1>
          <p className="text-secondary mb-3">Overview & Analytics</p>
          
          <div className="inline-flex items-center gap-2 bg-blue-50 border border-blue-200 text-blue-800 px-3 py-1.5 rounded-lg text-sm">
            <span className="font-medium">Storefront Link:</span>
            <a 
              href={`${window.location.origin}/${user?.tenants?.slug || localStorage.getItem('tenantSlug')}`} 
              target="_blank" 
              rel="noreferrer"
              className="text-blue-600 hover:underline hover:text-blue-800"
            >
              {`${window.location.origin}/${user?.tenants?.slug || localStorage.getItem('tenantSlug')}`}
            </a>
            <button 
              className="icon-btn ml-2 text-blue-500 hover:text-blue-700 p-1 rounded hover:bg-blue-100 transition-colors"
              onClick={() => {
                navigator.clipboard.writeText(`${window.location.origin}/${user?.tenants?.slug || localStorage.getItem('tenantSlug')}`);
                toast.success('Storefront link copied!');
              }}
              title="Copy Link"
            >
              <Copy size={16} />
            </button>
          </div>
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
            className={`btn ${activeTab === 'wallet' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('wallet')}
          >
            Wallet
          </button>
          <button 
            className={`btn ${activeTab === 'menu' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('menu')}
          >
            Menu Management
          </button>
          <button 
            className={`btn ${activeTab === 'staff' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('staff')}
          >
            Staff
          </button>
          <button 
            className={`btn ${activeTab === 'complaints' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('complaints')}
          >
            Complaints
          </button>
          <button 
            className={`btn ${activeTab === 'seo' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('seo')}
          >
            SEO
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

      {!loading && activeTab === 'wallet' && wallet && (
        <>
          <div className="stats-grid mb-8">
            <div className="stat-card">
              <div className="stat-card-label">Available to withdraw</div>
              <div className="stat-card-value text-accent">${parseFloat(wallet.available_balance).toFixed(2)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Pending (in hold window)</div>
              <div className="stat-card-value">${parseFloat(wallet.pending_balance).toFixed(2)}</div>
            </div>
          </div>

          <div className="grid grid-2 mb-8">
            <div className="card">
              <h3 className="mb-4">Withdraw funds</h3>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="form-label">Amount</label>
                  <input
                    type="number"
                    step="0.01"
                    className="form-input"
                    placeholder={`Full available balance ($${parseFloat(wallet.available_balance).toFixed(2)})`}
                    value={withdrawAmount}
                    onChange={e => setWithdrawAmount(e.target.value)}
                  />
                </div>
                <div>
                  <label className="form-label">MoMo phone number</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. 25078xxxxxxx"
                    value={withdrawPhone}
                    onChange={e => setWithdrawPhone(e.target.value)}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  disabled={withdrawing || parseFloat(wallet.available_balance) <= 0}
                  onClick={handleWithdraw}
                >
                  {withdrawing ? 'Processing…' : 'Request Withdrawal'}
                </button>
                {parseFloat(wallet.available_balance) <= 0 && (
                  <p className="text-xs text-muted">No available balance yet — paid orders clear their hold window before they can be withdrawn.</p>
                )}
              </div>
            </div>

            <div className="card">
              <h3 className="mb-4">Payment settings</h3>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="form-label">Settlement mode</label>
                  <select
                    className="form-select"
                    value={paymentSettings.settlementMode}
                    onChange={e => setPaymentSettings(prev => ({ ...prev, settlementMode: e.target.value }))}
                  >
                    <option value="manual">Manual — I'll request withdrawals myself</option>
                    <option value="auto">Automatic — pay out as soon as funds clear</option>
                  </select>
                </div>
                <div>
                  <label className="form-label">Default payout phone</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. 25078xxxxxxx"
                    value={paymentSettings.payoutPhone}
                    onChange={e => setPaymentSettings(prev => ({ ...prev, payoutPhone: e.target.value }))}
                  />
                </div>
                <button className="btn btn-secondary" disabled={savingSettings} onClick={savePaymentSettings}>
                  {savingSettings ? 'Saving…' : 'Save Settings'}
                </button>
                {paymentSettings.settlementMode === 'auto' && !paymentSettings.payoutPhone && (
                  <p className="text-xs text-yellow-800">Automatic mode needs a default payout phone to actually pay out — add one above.</p>
                )}
              </div>
            </div>
          </div>

          <div className="mb-8">
            <h3 className="mb-4">Recent withdrawals</h3>
            {withdrawals.length === 0 ? (
              <div className="card text-center p-8 text-secondary">No withdrawals yet.</div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Amount</th>
                      <th>Phone</th>
                      <th>Status</th>
                      <th>Initiated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {withdrawals.map(w => (
                      <tr key={w.id}>
                        <td>{new Date(w.requested_at).toLocaleString()}</td>
                        <td>${parseFloat(w.amount).toFixed(2)}</td>
                        <td>{w.phone_number}</td>
                        <td>
                          <span className={`badge ${w.status === 'completed' ? 'badge-delivered' : w.status === 'failed' || w.status === 'rejected' ? 'badge-rejected' : 'badge-pending'}`}>
                            {w.status}
                          </span>
                        </td>
                        <td className="text-secondary text-sm">{w.initiated_by}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h3 className="mb-4">Ledger</h3>
            {ledger.length === 0 ? (
              <div className="card text-center p-8 text-secondary">No transactions yet.</div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Amount</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map(entry => (
                      <tr key={entry.id}>
                        <td className="text-sm">{new Date(entry.created_at).toLocaleString()}</td>
                        <td className="text-sm">{entry.entry_type.replace(/_/g, ' ')}</td>
                        <td className={parseFloat(entry.amount) < 0 ? 'text-red-700' : ''}>
                          {parseFloat(entry.amount) >= 0 ? '+' : ''}{parseFloat(entry.amount).toFixed(2)}
                        </td>
                        <td className="text-sm text-secondary">{entry.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {!loading && activeTab === 'menu' && (
        <MenuManagement />
      )}

      {!loading && activeTab === 'staff' && (
        <StaffManagement />
      )}

      {!loading && activeTab === 'complaints' && (
        <ComplaintsManagement />
      )}

      {!loading && activeTab === 'seo' && (
        <div className="card max-w-2xl mx-auto">
          <h2 className="mb-4">SEO Settings</h2>
          <p className="text-secondary mb-6">Optimize your restaurant's storefront for search engines.</p>
          <form onSubmit={saveSeoSettings}>
            <div className="form-group">
              <label className="form-label">SEO Page Title</label>
              <input 
                type="text" 
                className="form-input" 
                value={seoSettings.seoTitle}
                onChange={(e) => setSeoSettings({ ...seoSettings, seoTitle: e.target.value })}
                placeholder="e.g. Burger Bros - The Best Burgers in Town"
              />
              <p className="text-xs text-secondary mt-1">Leave empty to use your restaurant name.</p>
            </div>
            
            <div className="form-group">
              <label className="form-label">Meta Description</label>
              <textarea 
                className="form-input" 
                rows="3"
                value={seoSettings.seoDescription}
                onChange={(e) => setSeoSettings({ ...seoSettings, seoDescription: e.target.value })}
                placeholder="Brief description of your restaurant that appears in search results."
              />
              <p className="text-xs text-secondary mt-1">Leave empty to use a default description.</p>
            </div>

            <div className="form-group mb-4">
              <label className="form-label">Meta Keywords</label>
              <input 
                type="text" 
                className="form-input" 
                value={seoSettings.seoKeywords}
                onChange={(e) => setSeoSettings({ ...seoSettings, seoKeywords: e.target.value })}
                placeholder="burgers, fast food, delivery, local"
              />
              <p className="text-xs text-secondary mt-1">Comma-separated list of keywords.</p>
            </div>

            <div className="grid grid-2 gap-4 mb-4">
              <div className="form-group mb-0">
                <label className="form-label">Favicon Upload</label>
                <input 
                  type="file" 
                  accept="image/*"
                  className="form-input" 
                  onChange={e => {
                    if (e.target.files && e.target.files[0]) {
                      setFaviconFile(e.target.files[0]);
                    }
                  }} 
                  style={{ padding: '6px' }}
                />
                {(seoSettings.faviconUrl || faviconFile) && (
                  <p className="text-xs text-secondary mt-1">
                    {faviconFile ? `Selected: ${faviconFile.name}` : 'Current favicon active'}
                  </p>
                )}
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Theme Color</label>
                <input 
                  type="color" 
                  className="form-input" 
                  style={{ height: '42px', padding: '4px' }}
                  value={seoSettings.themeColor}
                  onChange={(e) => setSeoSettings({ ...seoSettings, themeColor: e.target.value })}
                />
                <p className="text-xs text-secondary mt-1">Mobile browser header color.</p>
              </div>
            </div>

            <div className="grid grid-2 gap-4 mb-6">
              <div className="form-group mb-0">
                <label className="form-label">Twitter Handle</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={seoSettings.twitterHandle}
                  onChange={(e) => setSeoSettings({ ...seoSettings, twitterHandle: e.target.value })}
                  placeholder="@yourrestaurant"
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Author / Locale</label>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    className="form-input flex-1" 
                    value={seoSettings.author}
                    onChange={(e) => setSeoSettings({ ...seoSettings, author: e.target.value })}
                    placeholder="Author Name"
                  />
                  <input 
                    type="text" 
                    className="form-input" 
                    style={{ width: '80px' }}
                    value={seoSettings.ogLocale}
                    onChange={(e) => setSeoSettings({ ...seoSettings, ogLocale: e.target.value })}
                    placeholder="en_US"
                  />
                </div>
              </div>
            </div>

            <button type="submit" className="btn btn-primary" disabled={savingSeo}>
              {savingSeo ? 'Saving...' : 'Save Advanced SEO Settings'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}