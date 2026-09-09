import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../services/api';
import toast from 'react-hot-toast';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  Plus, X, Search, Copy, Check, ExternalLink, Store, ShoppingBag,
  Wallet, PiggyBank, Receipt, Ban, Power,
} from 'lucide-react';

const money = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const compact = (n) => (Number(n) || 0).toLocaleString();
const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');

const RANGES = [
  { key: '7', label: '7d', days: 7 },
  { key: '30', label: '30d', days: 30 },
  { key: 'all', label: 'All', days: Infinity },
];

export default function SuperAdminDashboard() {
  const [tenants, setTenants] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [range, setRange] = useState('30');
  const [copiedSlug, setCopiedSlug] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [formData, setFormData] = useState({
    restaurantName: '', slug: '', slugTouched: false,
    adminName: '', adminEmail: '', adminPassword: '',
  });

  const fetchData = useCallback(async () => {
    try {
      const [tenantsRes, analyticsRes] = await Promise.all([
        api.get('/tenants'),
        api.get('/tenants/analytics'),
      ]);
      setTenants(tenantsRes.data.tenants || []);
      setAnalytics(analyticsRes.data.analytics);
    } catch (err) {
      console.error('Failed to fetch data', err);
      toast.error('Could not load platform data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!showForm) return;
    const onKey = (e) => e.key === 'Escape' && setShowForm(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showForm]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post('/auth/register-tenant', {
        restaurantName: formData.restaurantName,
        slug: formData.slug,
        adminName: formData.adminName,
        adminEmail: formData.adminEmail,
        adminPassword: formData.adminPassword,
      });
      toast.success(`${formData.restaurantName} provisioned`);
      setFormData({ restaurantName: '', slug: '', slugTouched: false, adminName: '', adminEmail: '', adminPassword: '' });
      setShowForm(false);
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to provision restaurant');
    } finally {
      setCreating(false);
    }
  };

  const toggleStatus = async (tenant) => {
    const suspending = tenant.active;
    if (suspending && !window.confirm(`Suspend ${tenant.name}? Their storefront and staff logins stop working immediately.`)) return;
    setBusyId(tenant.id);
    try {
      await api.patch(`/tenants/${tenant.id}/toggle`);
      toast.success(suspending ? `${tenant.name} suspended` : `${tenant.name} reactivated`);
      fetchData();
    } catch {
      toast.error('Failed to update status');
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = (slug) => {
    navigator.clipboard.writeText(`${window.location.origin}/${slug}`);
    setCopiedSlug(slug);
    setTimeout(() => setCopiedSlug((s) => (s === slug ? null : s)), 1600);
  };

  const chartData = useMemo(() => {
    const history = analytics?.revenueHistory || [];
    const days = RANGES.find((r) => r.key === range)?.days ?? 30;
    return days === Infinity ? history : history.slice(-days);
  }, [analytics, range]);

  const rangeTotal = useMemo(
    () => chartData.reduce((sum, d) => sum + (Number(d.amount) || 0), 0),
    [chartData],
  );

  const filteredTenants = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tenants.filter((t) => {
      if (statusFilter === 'active' && !t.active) return false;
      if (statusFilter === 'suspended' && t.active) return false;
      if (!q) return true;
      return t.name?.toLowerCase().includes(q) || t.slug?.toLowerCase().includes(q);
    });
  }, [tenants, query, statusFilter]);

  const activeCount = tenants.filter((t) => t.active).length;

  const kpis = analytics ? [
    { label: 'Platform revenue', value: money(analytics.totalRevenue), icon: Receipt, sub: 'Paid orders, all time' },
    { label: 'Total orders', value: compact(analytics.totalOrders), icon: ShoppingBag, sub: 'Across every restaurant' },
    { label: 'Avg order value', value: money(analytics.totalOrders ? analytics.totalRevenue / analytics.totalOrders : 0), icon: PiggyBank, sub: 'Revenue ÷ orders' },
    { label: 'Active restaurants', value: compact(analytics.activeTenants), icon: Store, sub: `of ${compact(analytics.totalTenants)} provisioned` },
    { label: 'Held balances', value: money(analytics.heldBalances), icon: Wallet, sub: 'Pending clearance' },
    { label: 'Cleared balances', value: money(analytics.clearedBalances), icon: Wallet, sub: 'Available to withdraw' },
  ] : [];

  return (
    <div className="page mx-auto max-w-7xl px-4 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Platform</h1>
          <p className="text-sm text-[#475569]">
            {loading ? 'Loading…' : `${compact(tenants.length)} restaurants · ${compact(activeCount)} active`}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>
          <Plus size={16} /> New restaurant
        </button>
      </div>

      {/* KPI row */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[104px] animate-pulse rounded-xl border border-[#e2e8f0] bg-white" />
            ))
          : kpis.map((k) => {
              const Icon = k.icon;
              return (
                <div key={k.label} className="rounded-xl border border-[#e2e8f0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                  <div className="flex items-center justify-between">
                    <span className="text-[12.5px] font-medium text-[#475569]">{k.label}</span>
                    <Icon size={15} className="text-[#94a3b8]" />
                  </div>
                  <div className="font-heading mt-2 text-[22px] font-bold leading-none">{k.value}</div>
                  <div className="mt-2 text-[11px] text-[#94a3b8]">{k.sub}</div>
                </div>
              );
            })}
      </div>

      {/* Revenue chart */}
      <div className="mb-6 rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold">Platform revenue</h3>
            <p className="mt-0.5 text-xs text-[#94a3b8]">
              {loading ? '—' : `${money(rangeTotal)} over the selected range`}
            </p>
          </div>
          <div className="flex gap-1 rounded-lg bg-[#f1f5f9] p-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                  range === r.key ? 'bg-white text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.06)]' : 'text-[#94a3b8] hover:text-[#475569]'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="h-[280px]">
          {loading ? (
            <div className="h-full animate-pulse rounded-lg bg-[#f1f5f9]" />
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                <defs>
                  <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#dc2626" stopOpacity={0.16} />
                    <stop offset="100%" stopColor="#dc2626" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={28}
                  tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                  tickFormatter={(v) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`)}
                />
                <Tooltip
                  cursor={{ stroke: '#e2e8f0' }}
                  contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12, boxShadow: '0 4px 12px rgba(15,23,42,0.08)' }}
                  labelFormatter={(d) => new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  formatter={(value) => [money(value), 'Revenue']}
                />
                <Area type="monotone" dataKey="amount" stroke="#dc2626" strokeWidth={2} fill="url(#revFill)" activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <Receipt size={28} className="text-[#cbd5e1]" />
              <p className="mt-2 text-sm text-[#94a3b8]">No paid orders in this range yet</p>
            </div>
          )}
        </div>
      </div>

      {/* Restaurants */}
      <div className="rounded-xl border border-[#e2e8f0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e2e8f0] p-4">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold">Restaurants</h3>
            <span className="rounded-full bg-[#f1f5f9] px-2 py-0.5 text-xs font-semibold text-[#475569]">
              {filteredTenants.length}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#94a3b8]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or slug"
                className="w-56 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] py-1.5 pl-8 pr-3 text-sm outline-none transition-colors focus:border-[#dc2626] focus:bg-white"
              />
            </div>
            <div className="flex gap-1 rounded-lg bg-[#f1f5f9] p-1">
              {[['all', 'All'], ['active', 'Active'], ['suspended', 'Suspended']].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setStatusFilter(key)}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                    statusFilter === key ? 'bg-white text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.06)]' : 'text-[#94a3b8] hover:text-[#475569]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-[#f1f5f9]" />
            ))}
          </div>
        ) : filteredTenants.length === 0 ? (
          <div className="empty-state">
            <Store size={32} strokeWidth={1.25} className="mx-auto mb-3 text-[#cbd5e1]" />
            <h3>{tenants.length === 0 ? 'No restaurants yet' : 'No matches'}</h3>
            <p>{tenants.length === 0 ? 'Provision your first restaurant to get started.' : 'Try a different search or filter.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[#e2e8f0] text-left text-[11px] uppercase tracking-wide text-[#94a3b8]">
                  <th className="px-4 py-3 font-semibold">Restaurant</th>
                  <th className="px-4 py-3 font-semibold">Storefront</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Created</th>
                  <th className="px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTenants.map((tenant) => (
                  <tr key={tenant.id} className="border-b border-[#f1f5f9] last:border-b-0 hover:bg-[#f8fafc]">
                    <td className="px-4 py-3">
                      <div className="text-sm font-semibold text-[#0f172a]">{tenant.name}</div>
                      <div className="text-xs text-[#94a3b8]">/{tenant.slug}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => copyLink(tenant.slug)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-[#e2e8f0] bg-white px-2 py-1 text-xs font-medium text-[#475569] transition-colors hover:border-[#cbd5e1]"
                        >
                          {copiedSlug === tenant.slug
                            ? <><Check size={12} className="text-[#16a34a]" /> Copied</>
                            : <><Copy size={12} /> Copy link</>}
                        </button>
                        <a
                          href={`${window.location.origin}/${tenant.slug}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-[#e2e8f0] bg-white text-[#475569] transition-colors hover:border-[#cbd5e1]"
                          title="Open storefront"
                        >
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`badge ${tenant.active ? 'badge-ready' : 'badge-rejected'}`}>
                        {tenant.active ? 'Active' : 'Suspended'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[#475569]">
                      {new Date(tenant.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        className={`btn btn-sm ${tenant.active ? 'btn-secondary text-[#dc2626] hover:border-[#dc2626]' : 'btn-success'}`}
                        onClick={() => toggleStatus(tenant)}
                        disabled={busyId === tenant.id}
                      >
                        {tenant.active ? <Ban size={13} /> : <Power size={13} />}
                        {busyId === tenant.id ? '…' : tenant.active ? 'Suspend' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Provision modal */}
      {showForm && (
        <div
          className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-[#0f172a]/40 p-4 py-10"
          onMouseDown={(e) => e.target === e.currentTarget && setShowForm(false)}
        >
          <div className="w-full max-w-lg rounded-2xl border border-[#e2e8f0] bg-white shadow-[0_24px_48px_rgba(15,23,42,0.18)]">
            <div className="flex items-center justify-between border-b border-[#e2e8f0] px-5 py-4">
              <h3 className="text-[15px] font-semibold">Provision a restaurant</h3>
              <button onClick={() => setShowForm(false)} className="icon-btn p-1 text-[#94a3b8] hover:text-[#0f172a]" aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreate} className="flex flex-col gap-4 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="form-label">Restaurant name</label>
                  <input
                    type="text" className="form-input" required
                    value={formData.restaurantName}
                    onChange={(e) => setFormData((f) => ({
                      ...f,
                      restaurantName: e.target.value,
                      slug: f.slugTouched ? f.slug : slugify(e.target.value),
                    }))}
                  />
                </div>
                <div>
                  <label className="form-label">URL slug</label>
                  <input
                    type="text" className="form-input" required
                    pattern="^[a-z0-9-]+$"
                    title="Lowercase letters, numbers and hyphens only"
                    value={formData.slug}
                    onChange={(e) => setFormData((f) => ({ ...f, slug: e.target.value, slugTouched: true }))}
                  />
                  <p className="mt-1 text-[11px] text-[#94a3b8]">
                    {formData.slug ? `${window.location.host}/${formData.slug}` : 'e.g. burger-king'}
                  </p>
                </div>
              </div>

              <div className="border-t border-[#e2e8f0] pt-4">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#94a3b8]">Initial admin account</h4>
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="form-label">Admin name</label>
                    <input type="text" className="form-input" required
                      value={formData.adminName}
                      onChange={(e) => setFormData((f) => ({ ...f, adminName: e.target.value }))} />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="form-label">Admin email</label>
                      <input type="email" className="form-input" required
                        value={formData.adminEmail}
                        onChange={(e) => setFormData((f) => ({ ...f, adminEmail: e.target.value }))} />
                    </div>
                    <div>
                      <label className="form-label">Temp password</label>
                      <input type="password" className="form-input" required minLength={6}
                        value={formData.adminPassword}
                        onChange={(e) => setFormData((f) => ({ ...f, adminPassword: e.target.value }))} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-1 flex justify-end gap-2">
                <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Provisioning…' : 'Provision restaurant'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
