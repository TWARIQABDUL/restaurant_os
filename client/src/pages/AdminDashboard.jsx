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
import { Copy, QrCode, X, Download, MapPin, StickyNote, Phone } from 'lucide-react';
import { uploadImage } from '../services/supabase';
import { QRCodeCanvas } from 'qrcode.react';

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
  const [paymentSettings, setPaymentSettings] = useState({ settlementMode: 'manual', payoutPhone: '', acceptedPaymentMethods: ['cash_on_delivery', 'mobile_money', 'bank_transfer'] });
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

  // Theme State
  const [themeSettings, setThemeSettings] = useState({ primaryColor: '#DC2626', accentColor: '#A16207' });
  const [savingTheme, setSavingTheme] = useState(false);

  // QR Code State
  const [showQrModal, setShowQrModal] = useState(false);

  useEffect(() => {
    if (activeTab === 'analytics') {
      fetchAnalytics();
    } else if (activeTab === 'delivery') {
      fetchDeliveryData();
    } else if (activeTab === 'wallet') {
      fetchWallet();
    } else if (activeTab === 'seo') {
      fetchSeoSettings();
    } else if (activeTab === 'theme') {
      fetchThemeSettings();
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

  const fetchThemeSettings = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/tenants/me/theme');
      setThemeSettings({
        primaryColor: data.theme?.primaryColor || '#DC2626',
        accentColor: data.theme?.accentColor || '#A16207'
      });
    } catch (err) {
      console.error('Failed to load theme settings', err);
    } finally {
      setLoading(false);
    }
  };

  const saveThemeSettings = async (e) => {
    e.preventDefault();
    setSavingTheme(true);
    try {
      await api.patch('/tenants/me/theme', themeSettings);
      toast.success('Theme settings saved!');
    } catch (err) {
      toast.error('Failed to save theme settings');
    } finally {
      setSavingTheme(false);
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

  const downloadQRCode = () => {
    const canvas = document.getElementById('tenant-qr-code');
    if (canvas) {
      const pngUrl = canvas.toDataURL('image/png').replace('image/png', 'image/octet-stream');
      const downloadLink = document.createElement('a');
      downloadLink.href = pngUrl;
      downloadLink.download = `${user?.tenants?.slug || 'restaurant'}-qr-code.png`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
    }
  };

  return (
    <div className="page" style={{ maxWidth: '100vw', overflowX: 'hidden', position: 'relative' }}>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8 w-full max-w-full">
        <div className="w-full md:w-auto min-w-0">
          <h1>Admin Dashboard</h1>
          <p className="text-secondary mb-3">Overview & Analytics</p>
          
          <div className="inline-flex items-center gap-2 bg-blue-50 border border-blue-200 text-blue-800 px-3 py-1.5 rounded-lg text-sm w-full md:w-auto overflow-hidden">
            <span className="font-medium whitespace-nowrap">Storefront:</span>
            <a 
              href={`${window.location.origin}/${user?.tenants?.slug || localStorage.getItem('tenantSlug')}`} 
              target="_blank" 
              rel="noreferrer"
              className="text-blue-600 hover:underline hover:text-blue-800 truncate block"
            >
              {`${window.location.origin}/${user?.tenants?.slug || localStorage.getItem('tenantSlug')}`}
            </a>
            <button 
              className="icon-btn ml-2 text-blue-500 hover:text-blue-700 p-1 rounded hover:bg-blue-100 transition-colors flex-shrink-0"
              onClick={() => {
                navigator.clipboard.writeText(`${window.location.origin}/${user?.tenants?.slug || localStorage.getItem('tenantSlug')}`);
                toast.success('Storefront link copied!');
              }}
              title="Copy Link"
            >
              <Copy size={16} />
            </button>
            <button 
              className="icon-btn ml-2 text-blue-500 hover:text-blue-700 p-1 rounded hover:bg-blue-100 transition-colors flex-shrink-0"
              onClick={() => setShowQrModal(true)}
              title="Generate QR Code"
            >
              <QrCode size={16} />
            </button>
          </div>
        </div>
        <div style={{ width: '100%', minWidth: 0, marginTop: 'var(--space-4)' }}>
          <div className="scrollable-tabs">
            <button 
              className={`btn flex-shrink-0 ${activeTab === 'analytics' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('analytics')}
            >
              Analytics
            </button>
            <button 
              className={`btn flex-shrink-0 ${activeTab === 'delivery' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('delivery')}
            >
              Dispatch & Delivery
            </button>
            <button 
              className={`btn flex-shrink-0 ${activeTab === 'wallet' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('wallet')}
            >
              Wallet
            </button>
            <button 
              className={`btn flex-shrink-0 ${activeTab === 'menu' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('menu')}
            >
              Menu Management
            </button>
            <button 
              className={`btn flex-shrink-0 ${activeTab === 'staff' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('staff')}
            >
              Staff
            </button>
            <button 
              className={`btn flex-shrink-0 ${activeTab === 'complaints' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('complaints')}
            >
              Complaints
            </button>
            <button 
              className={`btn flex-shrink-0 ${activeTab === 'seo' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('seo')}
            >
              SEO
            </button>
            <button 
              className={`btn flex-shrink-0 ${activeTab === 'theme' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('theme')}
            >
              Theme
            </button>
          </div>
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
          <div style={{ flex: '2 1 400px', minWidth: 0 }}>
            <h3 className="mb-4">Orders Ready for Dispatch</h3>
            {readyOrders.length === 0 ? (
              <div className="card text-center p-8 text-secondary">
                No orders currently waiting for dispatch.
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {readyOrders.map(order => (
                  <div key={order.id} className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                      <div className="font-bold mb-1">
                        #{order.tracking_code}
                        <span className="text-sm font-normal text-accent ml-2">${parseFloat(order.total_amount).toFixed(2)}</span>
                      </div>
                      <div className="text-sm text-secondary mb-1 flex items-center gap-1">
                        {order.guest_name || order.customer?.name} 
                        {' • '} 
                        <a href={`tel:${order.guest_phone || order.customer?.phone}`} className="text-blue-600 hover:underline flex items-center gap-1">
                          <Phone size={12} />
                          {order.guest_phone || order.customer?.phone || 'No phone'}
                        </a>
                      </div>
                      <div className="text-sm text-secondary mb-2 flex items-start gap-1">
                        <MapPin size={14} className="mt-0.5 text-secondary flex-shrink-0" /> 
                        <span>{order.guest_address || 'Customer Address'}</span>
                      </div>
                      
                      {/* Order items summary */}
                      <div className="text-xs text-secondary mb-2 bg-gray-50 p-2 rounded border border-gray-100">
                        {order.order_items?.map((item, i) => (
                          <div key={i} className="truncate">
                            {item.quantity}x {item.menu_item?.name || 'Unknown item'}
                          </div>
                        ))}
                      </div>

                      {order.delivery_notes && (
                        <div className="text-xs text-warning mb-2 bg-warning-light p-2 rounded flex items-start gap-1">
                          <StickyNote size={14} className="mt-0.5 flex-shrink-0" />
                          <span>{order.delivery_notes}</span>
                        </div>
                      )}
                      
                      <div className="text-xs text-muted">
                        Ready since: {new Date(order.updated_at).toLocaleTimeString()}
                      </div>
                    </div>
                    <div style={{ flex: '2 1 300px', minWidth: 0 }}>
                      {(() => {
                        const state = dispatchState[order.id] || { type: 'internal', name: '', phone: '', plate: '' };
                        return (
                          <div className="flex flex-col gap-2 w-full">
                            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', width: '100%' }}>
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
                                  className="form-select form-select-sm" 
                                  id={`driver-select-${order.id}`}
                                  defaultValue=""
                                  style={{ flex: '1 1 150px', minWidth: 0 }}
                                >
                                  <option value="" disabled>Select Driver...</option>
                                  {drivers.map(driver => (
                                    <option key={driver.id} value={driver.id}>
                                      {driver.name} ({driver.plate_number || 'No Plate'})
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)', flex: '1 1 200px', minWidth: 0 }}>
                                  <input type="text" className="form-input form-input-sm" style={{ padding: '4px 8px', flex: '1 1 80px', minWidth: 0 }} placeholder="Name" value={state.name} onChange={e => handleDispatchState(order.id, 'name', e.target.value)} />
                                  <input type="text" className="form-input form-input-sm" style={{ padding: '4px 8px', flex: '1 1 80px', minWidth: 0 }} placeholder="Phone" value={state.phone} onChange={e => handleDispatchState(order.id, 'phone', e.target.value)} />
                                  <input type="text" className="form-input form-input-sm" style={{ padding: '4px 8px', flex: '1 1 80px', minWidth: 0 }} placeholder="Plate" value={state.plate} onChange={e => handleDispatchState(order.id, 'plate', e.target.value)} />
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

          {/* Active Deliveries */}
          <div style={{ flex: '1 1 300px', minWidth: 0 }}>
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

                {/* Accepted payment methods */}
                <div>
                  <label className="form-label" style={{ marginBottom: 'var(--space-3)' }}>Accepted payment methods</label>
                  <p className="text-xs text-muted" style={{ marginBottom: 'var(--space-3)' }}>
                    Choose which payment methods your customers can use at checkout.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                    {[
                      { value: 'cash_on_delivery', label: 'Cash on Delivery' },
                      { value: 'mobile_money', label: 'Mobile Money (MoMo)' },
                      { value: 'bank_transfer', label: 'Bank Transfer' },
                    ].map(method => {
                      const isChecked = (paymentSettings.acceptedPaymentMethods || []).includes(method.value);
                      const isOnly = isChecked && (paymentSettings.acceptedPaymentMethods || []).length === 1;
                      return (
                        <label key={method.value} style={{
                          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                          padding: 'var(--space-3) var(--space-4)',
                          borderRadius: 'var(--radius-md)',
                          border: `1px solid ${isChecked ? 'var(--color-accent)' : 'var(--color-border)'}`,
                          background: isChecked ? 'var(--color-accent-light)' : 'var(--color-surface)',
                          cursor: isOnly ? 'not-allowed' : 'pointer',
                          transition: 'all var(--transition-base)',
                          opacity: isOnly ? 0.7 : 1
                        }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={isOnly}
                            onChange={() => {
                              setPaymentSettings(prev => {
                                const current = prev.acceptedPaymentMethods || [];
                                const next = isChecked
                                  ? current.filter(m => m !== method.value)
                                  : [...current, method.value];
                                return { ...prev, acceptedPaymentMethods: next };
                              });
                            }}
                            style={{ width: '18px', height: '18px', accentColor: 'var(--color-accent)', cursor: 'inherit' }}
                          />
                          <span style={{ fontWeight: 500, fontSize: 'var(--font-size-sm)' }}>{method.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-3)', marginTop: 'var(--space-1)' }}>
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

      {!loading && activeTab === 'theme' && (
        <div className="card max-w-2xl mx-auto">
          <h2 className="mb-4">Storefront Theme</h2>
          <p className="text-secondary mb-6">Customize the primary and accent colors of your customer-facing storefront.</p>
          <form onSubmit={saveThemeSettings}>
            <div className="form-group">
              <label className="form-label">Primary Color</label>
              <div className="flex items-center gap-3">
                <input 
                  type="color" 
                  value={themeSettings.primaryColor}
                  onChange={(e) => setThemeSettings({ ...themeSettings, primaryColor: e.target.value })}
                  style={{ width: '50px', height: '50px', padding: '0', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                />
                <input
                  type="text"
                  className="form-input"
                  value={themeSettings.primaryColor}
                  onChange={(e) => setThemeSettings({ ...themeSettings, primaryColor: e.target.value })}
                  style={{ width: '120px' }}
                />
              </div>
              <p className="text-xs text-secondary mt-1">Used for primary buttons and main highlights.</p>
            </div>
            
            <div className="form-group mb-6">
              <label className="form-label">Accent Color</label>
              <div className="flex items-center gap-3">
                <input 
                  type="color" 
                  value={themeSettings.accentColor}
                  onChange={(e) => setThemeSettings({ ...themeSettings, accentColor: e.target.value })}
                  style={{ width: '50px', height: '50px', padding: '0', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                />
                <input
                  type="text"
                  className="form-input"
                  value={themeSettings.accentColor}
                  onChange={(e) => setThemeSettings({ ...themeSettings, accentColor: e.target.value })}
                  style={{ width: '120px' }}
                />
              </div>
              <p className="text-xs text-secondary mt-1">Used for gradients, links, and secondary highlights.</p>
            </div>

            <button type="submit" className="btn btn-primary" disabled={savingTheme}>
              {savingTheme ? 'Saving...' : 'Save Theme'}
            </button>
          </form>
        </div>
      )}

      {/* QR Code Modal */}
      {showQrModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div className="card" style={{ background: 'var(--color-surface)', width: '100%', maxWidth: '400px', padding: 'var(--space-6)', position: 'relative' }}>
            <button 
              onClick={() => setShowQrModal(false)}
              style={{ position: 'absolute', top: 'var(--space-4)', right: 'var(--space-4)', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <X size={20} className="text-muted" />
            </button>
            <h3 className="mb-2 text-center">Storefront QR Code</h3>
            <p className="text-sm text-secondary text-center mb-6">Scan to visit the restaurant page</p>
            
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-6)', background: 'white', padding: 'var(--space-4)', borderRadius: 'var(--radius-md)' }}>
              <QRCodeCanvas 
                id="tenant-qr-code"
                value={`${window.location.origin}/${user?.tenants?.slug || localStorage.getItem('tenantSlug')}`}
                size={256}
                level={"H"}
                includeMargin={true}
              />
            </div>
            
            <button className="btn btn-primary w-full" onClick={downloadQRCode} style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: 'var(--space-2)' }}>
              <Download size={18} />
              Download QR Code
            </button>
          </div>
        </div>
      )}

    </div>
  );
}