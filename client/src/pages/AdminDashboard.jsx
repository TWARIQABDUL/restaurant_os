import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getSocket } from '../services/socket';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, AreaChart, Area,
} from 'recharts';
import ProductsManagement from '../components/ProductsManagement';
import StaffManagement from '../components/StaffManagement';
import ComplaintsManagement from '../components/ComplaintsManagement';
import toast from 'react-hot-toast';
import {
  Copy, QrCode, X, Download, MapPin, StickyNote, Phone,
  BarChart3, Bike, Wallet, Users, MessageSquare, Globe, Palette,
  ShoppingBag, Package, CheckCircle2, Clock, ArrowUpRight,
} from 'lucide-react';
import { uploadImage } from '../services/supabase';
import { QRCodeCanvas } from 'qrcode.react';

import { useMoney } from '../context/TenantContext';
import { formatMoney } from '../config/money';
const COLORS = ['#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed'];

const NAV = [
  { group: 'Operations', items: [
    { key: 'analytics', label: 'Analytics', icon: BarChart3 },
    { key: 'delivery', label: 'Dispatch', icon: Bike },
    { key: 'wallet', label: 'Wallet', icon: Wallet },
  ] },
  { group: 'Catalogue', items: [
    { key: 'menu', label: 'Products', icon: Package },
    { key: 'staff', label: 'Staff', icon: Users },
  ] },
  { group: 'Support', items: [
    { key: 'complaints', label: 'Complaints', icon: MessageSquare },
  ] },
  { group: 'Settings', items: [
    { key: 'seo', label: 'SEO', icon: Globe },
    { key: 'theme', label: 'Theme', icon: Palette },
  ] },
];
const ALL_TABS = NAV.flatMap((g) => g.items);

const money = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Kpi({ label, value, icon: Icon, sub, accent }) {

  return (
    <div className="rounded-xl border border-[#e2e8f0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-[#475569]">{label}</span>
        <Icon size={15} className="text-[#94a3b8]" />
      </div>
      <div className={`font-heading mt-2 text-[22px] font-bold leading-none ${accent ? 'text-[#dc2626]' : ''}`}>{value}</div>
      {sub && <div className="mt-2 text-[11px] text-[#94a3b8]">{sub}</div>}
    </div>
  );
}

function ColorField({ label, value, hint, onChange }) {
  return (
    <div>
      <label className="form-label">{label}</label>
      <div className="flex items-center gap-3">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-10 cursor-pointer rounded-lg border border-[#e2e8f0] bg-transparent p-0.5"
        />
        <input
          type="text"
          className="form-input w-32 font-mono text-sm uppercase"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {hint && <p className="mt-1 text-[11px] text-[#94a3b8]">{hint}</p>}
    </div>
  );
}

export default function AdminDashboard() {
  const { money, delta } = useMoney();
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
  const [assigningId, setAssigningId] = useState(null);

  // Wallet State
  const [wallet, setWallet] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [paymentSettings, setPaymentSettings] = useState({ settlementMode: 'manual', payoutPhone: '', acceptedPaymentMethods: ['cash_on_delivery', 'mobile_money', 'bank_transfer'], currency: '', settlementCurrency: '', currencyLocked: true, staleCurrency: null });
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawPhone, setWithdrawPhone] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // SEO State
  const [seoSettings, setSeoSettings] = useState({
    seoTitle: '', seoDescription: '', seoKeywords: '',
    faviconUrl: '', themeColor: '#ffffff', twitterHandle: '', ogLocale: 'en_US', author: '',
  });
  const [faviconFile, setFaviconFile] = useState(null);
  const [savingSeo, setSavingSeo] = useState(false);

  // Theme State
  const [themeSettings, setThemeSettings] = useState({
    primaryColor: '#DC2626', accentColor: '#A16207', secondaryColor: '#F87171',
    backgroundColor: '#FEF2F2', textColor: '#450A0A',
  });
  const [savingTheme, setSavingTheme] = useState(false);

  // QR Code State
  const [showQrModal, setShowQrModal] = useState(false);

  const storefrontUrl = `${window.location.origin}/${user?.tenants?.slug || localStorage.getItem('tenantSlug')}`;

  useEffect(() => {
    if (activeTab === 'analytics') fetchAnalytics();
    else if (activeTab === 'delivery') fetchDeliveryData();
    else if (activeTab === 'wallet') fetchWallet();
    else if (activeTab === 'seo') fetchSeoSettings();
    else if (activeTab === 'theme') fetchThemeSettings();
    else setLoading(false);
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

  useEffect(() => {
    if (!showQrModal) return;
    const onKey = (e) => e.key === 'Escape' && setShowQrModal(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showQrModal]);

  const fetchAnalytics = async () => {
    setLoading(true);
    try {
      const [sumRes, revRes, topRes] = await Promise.all([
        api.get('/analytics/summary'),
        api.get('/analytics/revenue'),
        api.get('/analytics/top-items'),
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
        api.get('/delivery/drivers'),
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
        author: data.seo_settings?.author || '',
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
        finalFaviconUrl = await uploadImage(faviconFile, 'favicons');
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
        accentColor: data.theme?.accentColor || '#A16207',
        secondaryColor: data.theme?.secondaryColor || '#F87171',
        backgroundColor: data.theme?.backgroundColor || '#FEF2F2',
        textColor: data.theme?.textColor || '#450A0A',
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
    setAssigningId(orderId);
    try {
      await api.patch(`/orders/${orderId}/assign`, payload);
      toast.success('Driver assigned');
      fetchDeliveryData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to assign driver');
    } finally {
      setAssigningId(null);
    }
  };

  const handleDispatchState = (orderId, field, value) => {
    setDispatchState((prev) => ({
      ...prev,
      [orderId]: {
        ...(prev[orderId] || { type: 'internal', driverId: '', name: '', phone: '', plate: '' }),
        [field]: value,
      },
    }));
  };

  const downloadQRCode = () => {
    const canvas = document.getElementById('tenant-qr-code');
    if (canvas) {
      const pngUrl = canvas.toDataURL('image/png').replace('image/png', 'image/octet-stream');
      const link = document.createElement('a');
      link.href = pngUrl;
      link.download = `${user?.tenants?.slug || 'store'}-qr-code.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const copyStorefront = () => {
    navigator.clipboard.writeText(storefrontUrl);
    toast.success('Storefront link copied');
  };

  const activeMeta = ALL_TABS.find((t) => t.key === activeTab);

  return (
    <div className="page mx-auto max-w-7xl px-4 sm:px-6">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Admin</h1>
          <p className="text-sm text-[#475569]">{user?.tenants?.name || 'Your store'}</p>
        </div>
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-[#e2e8f0] bg-white px-2.5 py-1.5">
          <a
            href={storefrontUrl}
            target="_blank"
            rel="noreferrer"
            className="truncate text-xs font-medium text-[#475569] hover:text-[#0f172a]"
          >
            {storefrontUrl.replace(/^https?:\/\//, '')}
          </a>
          <button onClick={copyStorefront} className="icon-btn shrink-0 p-1 text-[#94a3b8] hover:text-[#0f172a]" title="Copy link">
            <Copy size={15} />
          </button>
          <button onClick={() => setShowQrModal(true)} className="icon-btn shrink-0 p-1 text-[#94a3b8] hover:text-[#0f172a]" title="QR code">
            <QrCode size={15} />
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[196px_minmax(0,1fr)]">
        {/* Mobile tab strip */}
        <div className="scrollable-tabs lg:hidden">
          {ALL_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`btn shrink-0 ${activeTab === t.key ? 'btn-primary' : 'btn-secondary'}`}
            >
              <t.icon size={14} /> {t.label}
            </button>
          ))}
        </div>

        {/* Sidebar nav */}
        <nav className="hidden lg:block">
          <div className="sticky top-20 flex flex-col gap-5">
            {NAV.map((group) => (
              <div key={group.group}>
                <div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-[#94a3b8]">{group.group}</div>
                <div className="flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const on = activeTab === item.key;
                    return (
                      <button
                        key={item.key}
                        onClick={() => setActiveTab(item.key)}
                        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors ${
                          on ? 'bg-[#fef2f2] text-[#dc2626]' : 'text-[#475569] hover:bg-[#f1f5f9] hover:text-[#0f172a]'
                        }`}
                      >
                        <Icon size={16} className={on ? 'text-[#dc2626]' : 'text-[#94a3b8]'} />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </nav>

        {/* Content */}
        <div className="min-w-0">
          <div className="mb-4 hidden items-center gap-2 lg:flex">
            {activeMeta && <activeMeta.icon size={18} className="text-[#dc2626]" />}
            <h2 className="text-lg font-semibold">{activeMeta?.label}</h2>
          </div>

          {loading ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-24 animate-pulse rounded-xl border border-[#e2e8f0] bg-white" />
                ))}
              </div>
              <div className="h-64 animate-pulse rounded-xl border border-[#e2e8f0] bg-white" />
            </div>
          ) : (
            <>
              {activeTab === 'analytics' && summary && (
                <div className="flex flex-col gap-5">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    <Kpi label="Today's revenue" value={money(summary.totalRevenue)} icon={ArrowUpRight} sub="Paid orders today" accent />
                    <Kpi label="Total orders" value={summary.totalOrders} icon={ShoppingBag} sub="Today" />
                    <Kpi label="Pending" value={summary.pendingOrders} icon={Clock} sub="Awaiting approval" />
                    <Kpi label="Ready" value={summary.readyOrders} icon={Package} sub="For dispatch" />
                    <Kpi label="Delivered" value={summary.deliveredOrders} icon={CheckCircle2} sub="Today" />
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                      <h3 className="mb-4 text-[15px] font-semibold">Revenue trend</h3>
                      <div className="h-[260px]">
                        {revenue.length > 0 ? (
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={revenue} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                              <defs>
                                <linearGradient id="adminRev" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor="#dc2626" stopOpacity={0.16} />
                                  <stop offset="100%" stopColor="#dc2626" stopOpacity={0} />
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={24} />
                              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`)} />
                              <Tooltip
                                contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                                formatter={(value) => [money(value), 'Revenue']}
                              />
                              <Area type="monotone" dataKey="amount" stroke="#dc2626" strokeWidth={2} fill="url(#adminRev)" activeDot={{ r: 4 }} />
                            </AreaChart>
                          </ResponsiveContainer>
                        ) : (
                          <div className="flex h-full items-center justify-center text-sm text-[#94a3b8]">No revenue data yet</div>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                      <h3 className="mb-4 text-[15px] font-semibold">Top selling items</h3>
                      <div className="h-[260px]">
                        {topItems.length > 0 ? (
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={topItems} layout="vertical" margin={{ left: 12, right: 12 }}>
                              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                              <XAxis type="number" hide />
                              <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: '#475569' }} tickLine={false} axisLine={false} width={110} />
                              <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }} />
                              <Bar dataKey="totalQuantity" radius={[0, 4, 4, 0]} maxBarSize={22}>
                                {topItems.map((entry, index) => (
                                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        ) : (
                          <div className="flex h-full items-center justify-center text-sm text-[#94a3b8]">No order data yet</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'delivery' && (
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-start">
                  <div>
                    <h3 className="mb-3 text-[15px] font-semibold">Ready for dispatch ({readyOrders.length})</h3>
                    {readyOrders.length === 0 ? (
                      <div className="empty-state rounded-xl border border-[#e2e8f0] bg-white">
                        <Bike size={30} strokeWidth={1.25} className="mx-auto mb-3 text-[#cbd5e1]" />
                        <h3>Nothing waiting</h3>
                        <p>Orders show here the moment they're marked ready to ship.</p>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {readyOrders.map((order) => {
                          const state = dispatchState[order.id] || { type: 'internal', driverId: '', name: '', phone: '', plate: '' };
                          const canAssign = state.type === 'internal' ? !!state.driverId : (state.name.trim() && state.phone.trim());
                          return (
                            <div key={order.id} className="rounded-xl border border-[#e2e8f0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="font-heading text-sm font-bold">
                                    #{order.tracking_code}
                                    <span className="ml-2 font-sans text-xs font-semibold text-[#dc2626]">{money(order.total_amount)}</span>
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#475569]">
                                    <span>{order.guest_name || order.customer?.name}</span>
                                    <a href={`tel:${order.guest_phone || order.customer?.phone}`} className="inline-flex items-center gap-1 text-[#2563eb] hover:underline">
                                      <Phone size={11} />{order.guest_phone || order.customer?.phone || 'No phone'}
                                    </a>
                                  </div>
                                  <div className="mt-1 flex items-start gap-1 text-xs text-[#475569]">
                                    <MapPin size={13} className="mt-0.5 shrink-0 text-[#94a3b8]" />
                                    <span>{order.guest_address || 'Customer address'}</span>
                                  </div>
                                </div>
                                <span className="whitespace-nowrap text-[11px] text-[#94a3b8]">
                                  Ready {new Date(order.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>

                              <div className="mt-3 rounded-lg border border-[#f1f5f9] bg-[#f8fafc] p-2 text-xs text-[#475569]">
                                {order.order_items?.map((item, i) => (
                                  <div key={i} className="truncate">{item.quantity}× {item.menu_item?.name || 'Unknown item'}</div>
                                ))}
                              </div>

                              {order.delivery_notes && (
                                <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-[#fef3c7] p-2 text-xs text-[#92400e]">
                                  <StickyNote size={13} className="mt-0.5 shrink-0" />
                                  <span>{order.delivery_notes}</span>
                                </div>
                              )}

                              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#f1f5f9] pt-3">
                                <select
                                  className="form-select w-36 !py-1.5 text-sm"
                                  value={state.type}
                                  onChange={(e) => handleDispatchState(order.id, 'type', e.target.value)}
                                >
                                  <option value="internal">Internal driver</option>
                                  <option value="external">External rider</option>
                                </select>

                                {state.type === 'internal' ? (
                                  <select
                                    className="form-select min-w-[10rem] flex-1 !py-1.5 text-sm"
                                    value={state.driverId}
                                    onChange={(e) => handleDispatchState(order.id, 'driverId', e.target.value)}
                                  >
                                    <option value="">Select driver…</option>
                                    {drivers.map((driver) => (
                                      <option key={driver.id} value={driver.id}>
                                        {driver.name} ({driver.plate_number || 'no plate'})
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <div className="flex min-w-[12rem] flex-1 flex-wrap gap-1.5">
                                    <input type="text" className="form-input !py-1.5 min-w-[5rem] flex-1 text-sm" placeholder="Name" value={state.name} onChange={(e) => handleDispatchState(order.id, 'name', e.target.value)} />
                                    <input type="text" className="form-input !py-1.5 min-w-[5rem] flex-1 text-sm" placeholder="Phone" value={state.phone} onChange={(e) => handleDispatchState(order.id, 'phone', e.target.value)} />
                                    <input type="text" className="form-input !py-1.5 min-w-[5rem] flex-1 text-sm" placeholder="Plate" value={state.plate} onChange={(e) => handleDispatchState(order.id, 'plate', e.target.value)} />
                                  </div>
                                )}

                                <button
                                  className="btn btn-primary btn-sm whitespace-nowrap"
                                  disabled={!canAssign || assigningId === order.id}
                                  onClick={() => {
                                    if (state.type === 'internal') {
                                      assignDriver(order.id, { assign_type: 'internal', delivery_person_id: state.driverId });
                                    } else {
                                      assignDriver(order.id, {
                                        assign_type: 'external',
                                        external_rider_info: { name: state.name, phone: state.phone, plateNumber: state.plate },
                                      });
                                    }
                                  }}
                                >
                                  {assigningId === order.id ? '…' : 'Assign'}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-[#e2e8f0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                    <h3 className="mb-3 text-[15px] font-semibold">Drivers ({drivers.length})</h3>
                    {drivers.length === 0 ? (
                      <p className="text-sm text-[#94a3b8]">No drivers on staff yet.</p>
                    ) : (
                      <div className="flex flex-col">
                        {drivers.map((driver) => (
                          <div key={driver.id} className="flex items-center gap-3 border-b border-[#f1f5f9] py-2.5 last:border-b-0">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f1f5f9] text-sm font-bold text-[#475569]">
                              {driver.name.charAt(0)}
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-medium">{driver.name}</div>
                              <div className="truncate text-xs text-[#94a3b8]">{driver.phone} • {driver.plate_number || 'N/A'}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'wallet' && wallet && (
                <div className="flex flex-col gap-5">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Kpi label="Available to withdraw" value={money(wallet.available_balance)} icon={Wallet} sub="Cleared the hold window" accent />
                    <Kpi label="Pending" value={money(wallet.pending_balance)} icon={Clock} sub="Still in hold window" />
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
                    <div className="rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                      <h3 className="mb-4 text-[15px] font-semibold">Withdraw funds</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <label className="form-label">Amount</label>
                          <input
                            type="number" step="0.01" className="form-input"
                            placeholder={`Full balance (${money(wallet.available_balance)})`}
                            value={withdrawAmount}
                            onChange={(e) => setWithdrawAmount(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="form-label">MoMo phone number</label>
                          <input
                            type="text" className="form-input" placeholder="e.g. 25078xxxxxxx"
                            value={withdrawPhone} onChange={(e) => setWithdrawPhone(e.target.value)}
                          />
                        </div>
                        <button
                          className="btn btn-primary"
                          disabled={withdrawing || parseFloat(wallet.available_balance) <= 0}
                          onClick={handleWithdraw}
                        >
                          {withdrawing ? 'Processing…' : 'Request withdrawal'}
                        </button>
                        {parseFloat(wallet.available_balance) <= 0 && (
                          <p className="text-xs text-[#94a3b8]">No available balance yet — paid orders clear their hold window before they can be withdrawn.</p>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                      <h3 className="mb-4 text-[15px] font-semibold">Payment settings</h3>
                      <div className="flex flex-col gap-4">
                        <div>
                          <label className="form-label">Currency</label>
                          <p className="mb-2 text-xs text-[#94a3b8]">
                            Every price in your store — products, options, orders, your wallet — is shown in this currency.
                            It is set by the payment account this platform collects through, so it is the same for every store
                            and cannot be changed here. Showing a price in a currency we cannot charge would mean quoting a
                            customer one amount and taking another.
                          </p>
                          <select
                            className="form-input"
                            value={paymentSettings.currency || paymentSettings.settlementCurrency || ''}
                            disabled
                            onChange={(e) => setPaymentSettings((prev) => ({ ...prev, currency: e.target.value }))}
                          >
                            <option value={paymentSettings.settlementCurrency}>
                              {paymentSettings.settlementCurrency || '—'}
                            </option>
                          </select>
                          {paymentSettings.staleCurrency && (
                            <p className="mt-2 rounded-md border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-xs text-[#92400e]">
                              Your store was previously set to <strong>{paymentSettings.staleCurrency}</strong>, which this
                              platform cannot collect. Prices are shown in {paymentSettings.settlementCurrency} instead.
                              Check that your product prices are the right numbers for {paymentSettings.settlementCurrency} —
                              they were not converted.
                            </p>
                          )}
                          {paymentSettings.settlementCurrency && (
                            <p className="mt-2 text-xs text-[#64748b]">
                              Prices will look like{' '}
                              <span className="font-semibold text-[#0f172a]">
                                {formatMoney(1500, paymentSettings.settlementCurrency)}
                              </span>
                              {' '}and{' '}
                              <span className="font-semibold text-[#0f172a]">
                                {formatMoney(24990, paymentSettings.settlementCurrency)}
                              </span>.
                            </p>
                          )}
                        </div>

                        <div>
                          <label className="form-label">Accepted payment methods</label>
                          <p className="mb-2 text-xs text-[#94a3b8]">What customers can use at checkout. At least one is required.</p>
                          <div className="flex flex-col gap-2">
                            {[
                              { value: 'cash_on_delivery', label: 'Cash on delivery' },
                              { value: 'mobile_money', label: 'Mobile Money (MoMo)' },
                              { value: 'bank_transfer', label: 'Bank transfer' },
                            ].map((method) => {
                              const isChecked = (paymentSettings.acceptedPaymentMethods || []).includes(method.value);
                              const isOnly = isChecked && (paymentSettings.acceptedPaymentMethods || []).length === 1;
                              return (
                                <label
                                  key={method.value}
                                  className={`flex items-center gap-3 rounded-lg border p-3 text-sm transition-colors ${
                                    isChecked ? 'border-[#dc2626] bg-[#fef2f2]' : 'border-[#e2e8f0] bg-white'
                                  } ${isOnly ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    disabled={isOnly}
                                    className="h-[18px] w-[18px] accent-[#dc2626]"
                                    onChange={() => {
                                      setPaymentSettings((prev) => {
                                        const current = prev.acceptedPaymentMethods || [];
                                        const next = isChecked ? current.filter((m) => m !== method.value) : [...current, method.value];
                                        return { ...prev, acceptedPaymentMethods: next };
                                      });
                                    }}
                                  />
                                  <span className="font-medium">{method.label}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>

                        <div className="border-t border-[#e2e8f0] pt-4">
                          <label className="form-label">Settlement mode</label>
                          <select
                            className="form-select"
                            value={paymentSettings.settlementMode}
                            onChange={(e) => setPaymentSettings((prev) => ({ ...prev, settlementMode: e.target.value }))}
                          >
                            <option value="manual">Manual — I'll request withdrawals myself</option>
                            <option value="auto">Automatic — pay out as soon as funds clear</option>
                          </select>
                        </div>
                        <div>
                          <label className="form-label">Default payout phone</label>
                          <input
                            type="text" className="form-input" placeholder="e.g. 25078xxxxxxx"
                            value={paymentSettings.payoutPhone}
                            onChange={(e) => setPaymentSettings((prev) => ({ ...prev, payoutPhone: e.target.value }))}
                          />
                        </div>
                        {paymentSettings.settlementMode === 'auto' && !paymentSettings.payoutPhone && (
                          <p className="rounded-lg bg-[#fef3c7] px-3 py-2 text-xs text-[#92400e]">Automatic mode needs a default payout phone to actually pay out.</p>
                        )}
                        <button className="btn btn-secondary self-start" disabled={savingSettings} onClick={savePaymentSettings}>
                          {savingSettings ? 'Saving…' : 'Save settings'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="mb-3 text-[15px] font-semibold">Recent withdrawals</h3>
                    {withdrawals.length === 0 ? (
                      <div className="rounded-xl border border-[#e2e8f0] bg-white p-6 text-center text-sm text-[#94a3b8]">No withdrawals yet.</div>
                    ) : (
                      <div className="table-wrapper">
                        <table>
                          <thead><tr><th>Date</th><th>Amount</th><th>Phone</th><th>Status</th><th>Initiated</th></tr></thead>
                          <tbody>
                            {withdrawals.map((w) => (
                              <tr key={w.id}>
                                <td>{new Date(w.requested_at).toLocaleString()}</td>
                                <td className="font-semibold">{money(w.amount)}</td>
                                <td>{w.phone_number}</td>
                                <td>
                                  <span className={`badge ${w.status === 'completed' ? 'badge-delivered' : (w.status === 'failed' || w.status === 'rejected') ? 'badge-rejected' : 'badge-pending'}`}>
                                    {w.status}
                                  </span>
                                </td>
                                <td className="text-sm text-[#475569]">{w.initiated_by}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  <div>
                    <h3 className="mb-3 text-[15px] font-semibold">Ledger</h3>
                    {ledger.length === 0 ? (
                      <div className="rounded-xl border border-[#e2e8f0] bg-white p-6 text-center text-sm text-[#94a3b8]">No transactions yet.</div>
                    ) : (
                      <div className="table-wrapper">
                        <table>
                          <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Note</th></tr></thead>
                          <tbody>
                            {ledger.map((entry) => (
                              <tr key={entry.id}>
                                <td className="text-sm">{new Date(entry.created_at).toLocaleString()}</td>
                                <td className="text-sm capitalize">{entry.entry_type.replace(/_/g, ' ')}</td>
                                <td className={`font-semibold ${parseFloat(entry.amount) < 0 ? 'text-[#dc2626]' : 'text-[#16a34a]'}`}>
                                  {delta(entry.amount) || money(0)}
                                </td>
                                <td className="text-sm text-[#475569]">{entry.note}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'menu' && <ProductsManagement />}
              {activeTab === 'staff' && <StaffManagement />}
              {activeTab === 'complaints' && <ComplaintsManagement />}

              {activeTab === 'seo' && (
                <form onSubmit={saveSeoSettings} className="max-w-2xl">
                  <div className="rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                    <h3 className="text-[15px] font-semibold">Search &amp; social</h3>
                    <p className="mt-0.5 mb-4 text-xs text-[#94a3b8]">How your storefront appears in Google and when shared.</p>

                    <div className="flex flex-col gap-4">
                      <div>
                        <label className="form-label">Page title</label>
                        <input
                          type="text" className="form-input" maxLength={60}
                          value={seoSettings.seoTitle}
                          onChange={(e) => setSeoSettings({ ...seoSettings, seoTitle: e.target.value })}
                          placeholder="e.g. Burger Bros — the best burgers in town"
                        />
                        <p className="mt-1 text-[11px] text-[#94a3b8]">{seoSettings.seoTitle.length}/60 · leave empty to use your restaurant name.</p>
                      </div>

                      <div>
                        <label className="form-label">Meta description</label>
                        <textarea
                          className="form-textarea" rows="3" maxLength={160}
                          value={seoSettings.seoDescription}
                          onChange={(e) => setSeoSettings({ ...seoSettings, seoDescription: e.target.value })}
                          placeholder="Brief description that appears under the title in search results."
                        />
                        <p className="mt-1 text-[11px] text-[#94a3b8]">{seoSettings.seoDescription.length}/160</p>
                      </div>

                      <div>
                        <label className="form-label">Keywords</label>
                        <input
                          type="text" className="form-input"
                          value={seoSettings.seoKeywords}
                          onChange={(e) => setSeoSettings({ ...seoSettings, seoKeywords: e.target.value })}
                          placeholder="burgers, fast food, delivery, local"
                        />
                        <p className="mt-1 text-[11px] text-[#94a3b8]">Comma-separated.</p>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className="form-label">Favicon</label>
                          <input
                            type="file" accept="image/*" className="form-input !py-1.5 text-sm"
                            onChange={(e) => e.target.files?.[0] && setFaviconFile(e.target.files[0])}
                          />
                          {(seoSettings.faviconUrl || faviconFile) && (
                            <p className="mt-1 text-[11px] text-[#94a3b8]">{faviconFile ? `Selected: ${faviconFile.name}` : 'Current favicon active'}</p>
                          )}
                        </div>
                        <ColorField
                          label="Browser theme colour"
                          value={seoSettings.themeColor}
                          hint="Mobile browser header tint."
                          onChange={(v) => setSeoSettings({ ...seoSettings, themeColor: v })}
                        />
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className="form-label">Twitter / X handle</label>
                          <input
                            type="text" className="form-input"
                            value={seoSettings.twitterHandle}
                            onChange={(e) => setSeoSettings({ ...seoSettings, twitterHandle: e.target.value })}
                            placeholder="@yourstore"
                          />
                        </div>
                        <div>
                          <label className="form-label">Author &amp; locale</label>
                          <div className="flex gap-2">
                            <input
                              type="text" className="form-input flex-1"
                              value={seoSettings.author}
                              onChange={(e) => setSeoSettings({ ...seoSettings, author: e.target.value })}
                              placeholder="Author name"
                            />
                            <input
                              type="text" className="form-input w-20"
                              value={seoSettings.ogLocale}
                              onChange={(e) => setSeoSettings({ ...seoSettings, ogLocale: e.target.value })}
                              placeholder="en_US"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <button type="submit" className="btn btn-primary mt-4" disabled={savingSeo}>
                    {savingSeo ? 'Saving…' : 'Save SEO settings'}
                  </button>
                </form>
              )}

              {activeTab === 'theme' && (
                <form onSubmit={saveThemeSettings} className="max-w-2xl">
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-start">
                    <div className="rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                      <h3 className="text-[15px] font-semibold">Storefront colours</h3>
                      <p className="mt-0.5 mb-4 text-xs text-[#94a3b8]">Applied to your customer-facing ordering page.</p>
                      <div className="flex flex-col gap-4">
                        <ColorField label="Primary" hint="Buttons and key highlights." value={themeSettings.primaryColor} onChange={(v) => setThemeSettings({ ...themeSettings, primaryColor: v })} />
                        <ColorField label="Accent" hint="Links and secondary highlights." value={themeSettings.accentColor} onChange={(v) => setThemeSettings({ ...themeSettings, accentColor: v })} />
                        <ColorField label="Secondary" hint="Alternative buttons and badges." value={themeSettings.secondaryColor} onChange={(v) => setThemeSettings({ ...themeSettings, secondaryColor: v })} />
                        <ColorField label="Background" hint="Page background." value={themeSettings.backgroundColor} onChange={(v) => setThemeSettings({ ...themeSettings, backgroundColor: v })} />
                        <ColorField label="Text" hint="Primary text — check contrast with the background." value={themeSettings.textColor} onChange={(v) => setThemeSettings({ ...themeSettings, textColor: v })} />
                      </div>
                    </div>

                    <div
                      className="sticky top-20 overflow-hidden rounded-xl border border-[#e2e8f0]"
                      style={{ background: themeSettings.backgroundColor, color: themeSettings.textColor }}
                    >
                      <div className="p-4">
                        <div className="text-[11px] font-semibold uppercase tracking-wide opacity-60">Preview</div>
                        <div className="mt-2 text-lg font-bold">Featured products</div>
                        <div className="mt-1 text-xs opacity-70">Handpicked for you</div>
                        <button
                          type="button"
                          className="mt-3 rounded-lg px-3 py-2 text-sm font-semibold"
                          style={{ background: themeSettings.primaryColor, color: '#fff' }}
                        >
                          Add to cart
                        </button>
                        <div className="mt-3">
                          <span
                            className="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold"
                            style={{ background: themeSettings.secondaryColor, color: '#fff' }}
                          >
                            Popular
                          </span>
                        </div>
                        <a href="#" onClick={(e) => e.preventDefault()} className="mt-3 block text-xs font-medium underline" style={{ color: themeSettings.accentColor }}>
                          View full menu
                        </a>
                      </div>
                    </div>
                  </div>

                  <button type="submit" className="btn btn-primary mt-4" disabled={savingTheme}>
                    {savingTheme ? 'Saving…' : 'Save theme'}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>

      {/* QR modal */}
      {showQrModal && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-[#0f172a]/40 p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setShowQrModal(false)}
        >
          <div className="w-full max-w-sm rounded-2xl border border-[#e2e8f0] bg-white p-6 shadow-[0_24px_48px_rgba(15,23,42,0.18)]">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-[15px] font-semibold">Storefront QR code</h3>
                <p className="text-xs text-[#94a3b8]">Print it or add it to your menu — it opens your ordering page.</p>
              </div>
              <button onClick={() => setShowQrModal(false)} className="icon-btn p-1 text-[#94a3b8] hover:text-[#0f172a]" aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="my-5 flex justify-center rounded-xl border border-[#e2e8f0] bg-white p-4">
              <QRCodeCanvas id="tenant-qr-code" value={storefrontUrl} size={220} level="H" includeMargin />
            </div>

            <button className="btn btn-primary btn-full" onClick={downloadQRCode}>
              <Download size={16} /> Download PNG
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
