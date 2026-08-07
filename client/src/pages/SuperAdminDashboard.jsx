import { useState, useEffect } from 'react';
import api from '../services/api';

export default function SuperAdminDashboard() {
  const [tenants, setTenants] = useState([]);
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

  const fetchTenants = async () => {
    try {
      const { data } = await api.get('/tenants');
      setTenants(data.tenants || []);
    } catch (err) {
      console.error('Failed to fetch tenants', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await api.post('/auth/register-tenant', formData);
      setFormData({ restaurantName: '', slug: '', adminName: '', adminEmail: '', adminPassword: '' });
      setShowForm(false);
      fetchTenants();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to create tenant and admin');
    }
  };

  const toggleStatus = async (id) => {
    try {
      await api.patch(`/tenants/${id}/toggle`);
      fetchTenants();
    } catch (err) {
      alert('Failed to toggle status');
    }
  };

  return (
    <div className="page">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1>Platform Administration</h1>
          <p className="text-secondary">Manage SaaS Tenants</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ New Restaurant'}
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
