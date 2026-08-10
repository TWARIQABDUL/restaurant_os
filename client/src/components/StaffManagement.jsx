import { useState, useEffect } from 'react';
import api from '../services/api';
import toast from 'react-hot-toast';

export default function StaffManagement() {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    role: 'manager',
    phone: '',
    plate_number: ''
  });

  useEffect(() => {
    fetchStaff();
  }, []);

  const fetchStaff = async () => {
    setLoading(true);
    try {
      const res = await api.get('/auth/staff');
      setStaff(res.data.staff);
    } catch (err) {
      console.error('Failed to load staff:', err);
      toast.error('Failed to load staff list');
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name || !formData.email || !formData.password || !formData.role) {
      return toast.error('Please fill in all required fields');
    }

    if (formData.role === 'delivery' && !formData.phone) {
      return toast.error('Phone number is highly recommended for delivery drivers');
    }

    setSubmitting(true);
    try {
      await api.post('/auth/create-staff', formData);
      toast.success('Staff member created successfully!');
      
      // Reset form
      setFormData({
        name: '',
        email: '',
        password: '',
        role: 'manager',
        phone: '',
        plate_number: ''
      });
      setIsAdding(false);
      
      // Refresh list
      fetchStaff();
    } catch (err) {
      console.error('Create staff error:', err);
      toast.error(err.response?.data?.error || 'Failed to create staff member');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && staff.length === 0) {
    return <div className="text-center p-8">Loading staff...</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center">
        <h2>Staff Management</h2>
        <button 
          className="btn btn-primary"
          onClick={() => setIsAdding(!isAdding)}
        >
          {isAdding ? 'Cancel' : 'Add Staff Member'}
        </button>
      </div>

      {isAdding && (
        <div className="card">
          <h3 className="mb-4">Create New Staff Account</h3>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid grid-2">
              <div>
                <label className="form-label">Full Name *</label>
                <input 
                  type="text" 
                  className="form-input" 
                  name="name"
                  value={formData.name}
                  onChange={handleInputChange}
                  required
                />
              </div>
              <div>
                <label className="form-label">Email Address *</label>
                <input 
                  type="email" 
                  className="form-input" 
                  name="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  required
                />
              </div>
            </div>

            <div className="grid grid-2">
              <div>
                <label className="form-label">Temporary Password *</label>
                <input 
                  type="password" 
                  className="form-input" 
                  name="password"
                  value={formData.password}
                  onChange={handleInputChange}
                  minLength={6}
                  required
                  placeholder="Min 6 characters"
                />
              </div>
              <div>
                <label className="form-label">Role *</label>
                <select 
                  className="form-select" 
                  name="role"
                  value={formData.role}
                  onChange={handleInputChange}
                >
                  <option value="manager">Manager (Can manage menu & orders)</option>
                  <option value="delivery">Delivery Driver</option>
                </select>
              </div>
            </div>

            <div className="grid grid-2">
              <div>
                <label className="form-label">Phone Number {formData.role === 'delivery' && '*'}</label>
                <input 
                  type="text" 
                  className="form-input" 
                  name="phone"
                  value={formData.phone}
                  onChange={handleInputChange}
                  placeholder="e.g. 25078..."
                />
              </div>
              {formData.role === 'delivery' && (
                <div>
                  <label className="form-label">Plate Number (Optional)</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    name="plate_number"
                    value={formData.plate_number}
                    onChange={handleInputChange}
                    placeholder="e.g. RAA 123A"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end mt-2">
              <button 
                type="submit" 
                className="btn btn-primary"
                disabled={submitting}
              >
                {submitting ? 'Creating...' : 'Create Account'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <h3 className="mb-4">Organization Members</h3>
        {staff.length === 0 ? (
          <div className="text-center p-8 text-secondary">No staff members found.</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Plate Number</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((user) => (
                  <tr key={user.id}>
                    <td className="font-medium">{user.name}</td>
                    <td>
                      <span className={`badge ${user.role === 'admin' ? 'badge-delivered' : user.role === 'manager' ? 'badge-preparing' : 'badge-pending'}`}>
                        {user.role}
                      </span>
                    </td>
                    <td>{user.email}</td>
                    <td>{user.phone || '-'}</td>
                    <td>{user.plate_number || '-'}</td>
                    <td className="text-sm text-secondary">
                      {new Date(user.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
