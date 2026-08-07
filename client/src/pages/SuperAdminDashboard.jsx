import { useState, useEffect } from 'react';
import api from '../services/api';

export default function SuperAdminDashboard() {
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);

  // Form state for new tenant
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ name: '', slug: '' });

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
      await api.post('/tenants', formData);
      setFormData({ name: '', slug: '' });
      setShowForm(false);
      fetchTenants();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to create tenant');
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
          <h3 className="mb-4">Create New Tenant</h3>
          <form onSubmit={handleCreate} className="flex gap-4 items-end">
            <div className="form-group mb-0 flex-1">
              <label className="form-label">Restaurant Name</label>
              <input 
                type="text" 
                className="form-input" 
                required 
                value={formData.name}
                onChange={(e) => setFormData({...formData, name: e.target.value})}
              />
            </div>
            <div className="form-group mb-0 flex-1">
              <label className="form-label">URL Slug (e.g. my-restaurant)</label>
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
            <button type="submit" className="btn btn-primary" style={{ height: '42px' }}>
              Create
            </button>
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
