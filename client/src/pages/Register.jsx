import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Rocket } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect');
  
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    phone: searchParams.get('phone') || ''
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
      if (redirect) {
        navigate(redirect);
      } else {
        const slug = localStorage.getItem('tenantSlug');
        navigate(slug ? `/${slug}` : '/');
      }
    } catch (err) {
      setError(err.response?.data?.errors?.[0]?.msg || err.response?.data?.error || 'Registration failed.');
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
          background: 'radial-gradient(circle at 80% 20%, rgba(220, 38, 38, 0.2) 0%, transparent 50%)',
          pointerEvents: 'none'
        }} />
        <div style={{ position: 'relative', textAlign: 'center', color: 'var(--color-text-inverse)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}><Rocket size={48} color="var(--color-accent)" /></div>
          <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-3)' }}>Get started</h2>
          <p style={{ opacity: 0.6, maxWidth: '280px', lineHeight: 1.6, fontSize: 'var(--font-size-sm)' }}>
            Create an account to order food, track deliveries, and enjoy a seamless experience.
          </p>
        </div>
      </div>

      {/* Right form panel */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-8)'
      }}>
        <div style={{ width: '100%', maxWidth: '380px' }}>
          <h2 style={{ marginBottom: 'var(--space-2)' }}>Create Account</h2>
          <p className="text-secondary mb-6" style={{ fontSize: 'var(--font-size-sm)' }}>
            Fill in your details to get started.
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
              <label className="form-label">Full Name</label>
              <input type="text" name="name" className="form-input" required
                value={formData.name} onChange={handleChange} placeholder="John Doe" />
            </div>
            <div className="form-group">
              <label className="form-label">Email Address</label>
              <input type="email" name="email" className="form-input" required
                value={formData.email} onChange={handleChange} placeholder="you@example.com" />
            </div>
            <div className="form-group">
              <label className="form-label">Phone Number</label>
              <input type="tel" name="phone" className="form-input" required
                value={formData.phone} onChange={handleChange} placeholder="0780000000" />
            </div>
            <div className="form-group mb-6">
              <label className="form-label">Password</label>
              <input type="password" name="password" className="form-input" required minLength="6"
                value={formData.password} onChange={handleChange} placeholder="••••••••" />
            </div>

            <button type="submit" className="btn btn-primary btn-full btn-lg btn-pill mb-4" disabled={loading}>
              {loading ? 'Creating Account...' : 'Sign Up'}
            </button>
          </form>

          <p className="text-center text-sm text-secondary">
            Already have an account? <Link to={redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login'} style={{ fontWeight: 600, color: 'var(--color-accent)' }}>Log in</Link>
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
