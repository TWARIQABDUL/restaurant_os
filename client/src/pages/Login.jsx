import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await login(email, password);
      // Redirect based on role
      if (user.role === 'admin') navigate('/admin');
      else if (user.role === 'manager') navigate('/manager');
      else if (user.role === 'delivery') navigate('/delivery');
      else if (user.role === 'super_admin') navigate('/super-admin');
      else {
        const slug = localStorage.getItem('tenantSlug');
        navigate(slug ? `/${slug}` : '/');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page flex justify-center items-center" style={{ minHeight: 'calc(100vh - 120px)' }}>
      <div className="card w-full" style={{ maxWidth: '400px' }}>
        <h2 className="text-center mb-6">Welcome Back</h2>
        
        {error && (
          <div className="form-error text-center p-3 bg-red-50 text-red-700 rounded mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Email Address</label>
            <input 
              type="email" 
              className="form-input" 
              required 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="form-group mb-6">
            <label className="form-label">Password</label>
            <input 
              type="password" 
              className="form-input" 
              required 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          
          <button type="submit" className="btn btn-primary btn-full btn-lg mb-4" disabled={loading}>
            {loading ? 'Logging in...' : 'Log In'}
          </button>
        </form>

        <p className="text-center text-sm text-secondary">
          Don't have an account? <Link to="/register" style={{ fontWeight: 500 }}>Sign up</Link>
        </p>
      </div>
    </div>
  );
}
