import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    phone: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await register(formData.name, formData.email, formData.password, formData.phone);
      const slug = localStorage.getItem('tenantSlug');
      navigate(slug ? `/${slug}` : '/');
    } catch (err) {
      setError(err.response?.data?.errors?.[0]?.msg || err.response?.data?.error || 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page flex justify-center items-center" style={{ minHeight: 'calc(100vh - 120px)' }}>
      <div className="card w-full" style={{ maxWidth: '400px' }}>
        <h2 className="text-center mb-6">Create Account</h2>
        
        {error && (
          <div className="form-error text-center p-3 bg-red-50 text-red-700 rounded mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Full Name</label>
            <input 
              type="text" 
              name="name"
              className="form-input" 
              required 
              value={formData.name}
              onChange={handleChange}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Email Address</label>
            <input 
              type="email" 
              name="email"
              className="form-input" 
              required 
              value={formData.email}
              onChange={handleChange}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Phone Number</label>
            <input 
              type="tel" 
              name="phone"
              className="form-input" 
              required 
              value={formData.phone}
              onChange={handleChange}
            />
          </div>
          <div className="form-group mb-6">
            <label className="form-label">Password</label>
            <input 
              type="password" 
              name="password"
              className="form-input" 
              required 
              minLength="6"
              value={formData.password}
              onChange={handleChange}
            />
          </div>
          
          <button type="submit" className="btn btn-primary btn-full btn-lg mb-4" disabled={loading}>
            {loading ? 'Creating Account...' : 'Sign Up'}
          </button>
        </form>

        <p className="text-center text-sm text-secondary">
          Already have an account? <Link to="/login" style={{ fontWeight: 500 }}>Log in</Link>
        </p>
      </div>
    </div>
  );
}
