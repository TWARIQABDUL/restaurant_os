import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AuthShell from '../components/AuthShell';

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
    <AuthShell
      heading={<>One screen for your<br />whole service.</>}
      subheading="Menus, live orders, dispatch and analytics — for owners, managers, kitchen staff and drivers."
    >
      <h2 className="text-[22px] font-bold">Log in</h2>
      <p className="mt-1.5 mb-6 text-[13.5px] text-[#475569]">Enter your credentials to continue.</p>

      {error && (
        <div className="shake mb-5 rounded-lg border border-[#fecaca] bg-[#fee2e2] px-4 py-3 text-sm font-medium text-[#dc2626]">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="form-label">Email address</label>
          <input
            type="email" className="form-input" required
            value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label className="form-label">Password</label>
          <input
            type="password" className="form-input" required
            value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>

        <button type="submit" className="btn btn-primary btn-full btn-lg mt-1" disabled={loading}>
          {loading ? 'Logging in…' : 'Log in'}
        </button>
      </form>

      <p className="mt-5 text-center text-xs text-[#94a3b8]">
        Need a workspace? <span className="font-semibold text-[#0f172a]">Contact your administrator</span>
      </p>
    </AuthShell>
  );
}
