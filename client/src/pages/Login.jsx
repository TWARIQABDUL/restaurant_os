import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect');
  
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
      // Redirect based on role or URL param
      if (redirect) {
        navigate(redirect);
      } else if (user.role === 'admin') navigate('/admin');
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
    <div style={{
      display: 'flex', minHeight: 'calc(100vh - 60px)',
      background: 'var(--color-bg)'
    }}>
      {/* Left branded panel */}
      <div style={{
        flex: '0 0 45%', background: 'var(--gradient-dark)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-10)', position: 'relative', overflow: 'hidden'
      }} className="auth-panel-left">
        <div style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(circle at 20% 80%, rgba(232,137,12,0.2) 0%, transparent 50%)',
          pointerEvents: 'none'
        }} />
        <div style={{ position: 'relative', textAlign: 'center', color: 'var(--color-text-inverse)' }}>
          <div style={{ fontSize: '3rem', marginBottom: 'var(--space-4)' }}>🍽️</div>
          <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-3)' }}>Welcome back</h2>
          <p style={{ opacity: 0.6, maxWidth: '280px', lineHeight: 1.6, fontSize: 'var(--font-size-sm)' }}>
            Sign in to manage your restaurant, track orders, and serve your customers.
          </p>
        </div>
      </div>

      {/* Right form panel */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-8)'
      }}>
        <div style={{ width: '100%', maxWidth: '380px' }}>
          <h2 style={{ marginBottom: 'var(--space-2)' }}>Log In</h2>
          <p className="text-secondary mb-6" style={{ fontSize: 'var(--font-size-sm)' }}>
            Enter your credentials to continue.
          </p>

          {error && (
            <div className="shake" style={{
              background: 'var(--color-error-light)', color: 'var(--color-error)',
              padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-md)',
              fontSize: 'var(--font-size-sm)', marginBottom: 'var(--space-5)',
              border: '1px solid rgba(197,48,48,0.15)'
            }}>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Email Address</label>
              <input
                type="email" className="form-input" required
                value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="form-group mb-6">
              <label className="form-label">Password</label>
              <input
                type="password" className="form-input" required
                value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            <button type="submit" className="btn btn-primary btn-full btn-lg btn-pill mb-4" disabled={loading}>
              {loading ? 'Logging in...' : 'Log In'}
            </button>
          </form>

          <p className="text-center text-sm text-secondary">
            Don't have an account? <Link to={redirect ? `/register?redirect=${encodeURIComponent(redirect)}` : '/register'} style={{ fontWeight: 600, color: 'var(--color-accent)' }}>Sign up</Link>
          </p>
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .auth-panel-left { display: none !important; }
        }
      `}</style>
    </div>
  );
}
