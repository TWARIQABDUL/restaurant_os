import { useState, useEffect } from 'react';
import api from '../services/api';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function SuperAdminDashboard() {
  const [tenants, setTenants] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);

  // Form state for new tenant
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ 
    restaurantName: '', 
    slug: '', 
    adminName: '', 
    adminEmail: '', 
    adminPassword: '' 
  });

  const fetchData = async () => {
    try {
      const [tenantsRes, analyticsRes] = await Promise.all([
        api.get('/tenants'),
        api.get('/tenants/analytics')
      ]);
      setTenants(tenantsRes.data.tenants || []);
      setAnalytics(analyticsRes.data.analytics);
    } catch (err) {
      console.error('Failed to fetch data', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await api.post('/auth/register-tenant', formData);
      setFormData({ restaurantName: '', slug: '', adminName: '', adminEmail: '', adminPassword: '' });
      setShowForm(false);
      fetchData();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to create tenant and admin');
    }
  };

  const toggleStatus = async (id) => {
    try {
      await api.patch(`/tenants/${id}/toggle`);
      fetchData();
    } catch (err) {
      alert('Failed to toggle status');
    }
  };

  return (
    <div className="page mx-auto max-w-7xl px-4 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Platform analytics</h1>
          <p className="text-sm text-[#475569]">Manage SaaS tenants</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ New restaurant'}
        </button>
      </div>

      {showForm && (
        <div className="card mb-8 bg-gray-50 border-gray-200">
          <h3 className="mb-4">Provision New Restaurant Space</h3>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            
            <div className="flex gap-4">
              <div className="form-group mb-0 flex-1">
                <label className="form-label">Restaurant Name</label>
                <input 
                  type="text" 
                  className="form-input" 
                  required 
                  value={formData.restaurantName}
                  onChange={(e) => setFormData({...formData, restaurantName: e.target.value})}
                />
              </div>
              <div className="form-group mb-0 flex-1">
                <label className="form-label">URL Slug (e.g. burger-king)</label>
                <input 
                  type="text" 
                  className="form-input" 
                  required 
                  pattern="^[a-z0-9-]+$"
                  title="Lowercase alphanumeric and hyphens only"
                  value={formData.slug}
                  onChange={(e) => setFormData({...formData, slug: e.target.value})}
                />
              </div>
            </div>

            <div className="border-t border-gray-200 pt-4 mt-2">
              <h4 className="mb-3 text-sm uppercase text-secondary">Initial Admin Account</h4>
              <div className="flex gap-4">
                <div className="form-group mb-0 flex-1">
                  <label className="form-label">Admin Name</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    required 
                    value={formData.adminName}
                    onChange={(e) => setFormData({...formData, adminName: e.target.value})}
                  />
                </div>
                <div className="form-group mb-0 flex-1">
                  <label className="form-label">Admin Email</label>
                  <input 
                    type="email" 
                    className="form-input" 
                    required 
                    value={formData.adminEmail}
                    onChange={(e) => setFormData({...formData, adminEmail: e.target.value})}
                  />
                </div>
                <div className="form-group mb-0 flex-1">
                  <label className="form-label">Admin Password</label>
                  <input 
                    type="password" 
                    className="form-input" 
                    required 
                    minLength={6}
                    value={formData.adminPassword}
                    onChange={(e) => setFormData({...formData, adminPassword: e.target.value})}
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end mt-2">
              <button type="submit" className="btn btn-primary px-8 py-2">
                Provision Tenant & Admin
              </button>
            </div>
          </form>
        </div>
      )}

      {analytics && !loading && (
        <>
          <div className="stats-grid mb-8">
            <div className="stat-card">
              <div className="stat-card-label">Platform Revenue</div>
              <div className="stat-card-value text-accent">${(analytics.totalRevenue || 0).toFixed(2)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Total Orders</div>
              <div className="stat-card-value">{analytics.totalOrders || 0}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Held Balances</div>
              <div className="stat-card-value">${(analytics.heldBalances || 0).toFixed(2)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">Cleared Balances</div>
              <div className="stat-card-value">${(analytics.clearedBalances || 0).toFixed(2)}</div>
            </div>
          </div>

          <div className="card mb-8">
            <h3 className="mb-6">Platform Revenue Over Time</h3>
            <div style={{ height: 300 }}>
              {analytics.revenueHistory && analytics.revenueHistory.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={analytics.revenueHistory}>
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
        </>
      )}

      {loading ? (
        <div className="loading-page"><div className="spinner" /></div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Restaurant Name</th>
                <th>Slug</th>
                <th>Store Link</th>
                <th>Status</th>
                <th>Created At</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map(tenant => (
                <tr key={tenant.id}>
                  <td style={{ fontWeight: 500 }}>{tenant.name}</td>
                  <td className="text-secondary">{tenant.slug}</td>
                  <td>
                    <div className="flex gap-2 items-center">
                      <span className="text-sm font-mono bg-gray-100 px-2 py-1 rounded border">
                        /{tenant.slug}
                      </span>
                      <button 
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          const url = `${window.location.origin}/${tenant.slug}`;
                          navigator.clipboard.writeText(url);
                          alert('Copied to clipboard!');
                        }}
                        style={{ padding: '2px 8px', fontSize: '12px' }}
                      >
                        Copy
                      </button>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${tenant.active ? 'badge-approved' : 'badge-rejected'}`}>
                      {tenant.active ? 'Active' : 'Suspended'}
                    </span>
                  </td>
                  <td className="text-secondary">
                    {new Date(tenant.created_at).toLocaleDateString()}
                  </td>
                  <td className="text-right">
                    <button 
                      className={`btn btn-sm ${tenant.active ? 'btn-danger' : 'btn-success'}`}
                      onClick={() => toggleStatus(tenant.id)}
                    >
                      {tenant.active ? 'Suspend' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
