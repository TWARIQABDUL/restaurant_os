import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AuthShell from '../components/AuthShell';

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
    <AuthShell
      heading={<>Create your<br />account.</>}
      subheading="Order food, track deliveries to the door, and pick up where you left off across devices."
    >
      <h2 className="text-[22px] font-bold">Create account</h2>
      <p className="mt-1.5 mb-6 text-[13.5px] text-[#475569]">Fill in your details to get started.</p>

      {error && (
        <div className="shake mb-5 rounded-lg border border-[#fecaca] bg-[#fee2e2] px-4 py-3 text-sm font-medium text-[#dc2626]">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="form-label">Full name</label>
          <input type="text" name="name" className="form-input" required
            value={formData.name} onChange={handleChange} placeholder="John Doe" />
        </div>
        <div>
          <label className="form-label">Email address</label>
          <input type="email" name="email" className="form-input" required
            value={formData.email} onChange={handleChange} placeholder="you@example.com" />
        </div>
        <div>
          <label className="form-label">Phone number</label>
          <input type="tel" name="phone" className="form-input" required
            value={formData.phone} onChange={handleChange} placeholder="0780000000" />
        </div>
        <div>
          <label className="form-label">Password</label>
          <input type="password" name="password" className="form-input" required minLength="6"
            value={formData.password} onChange={handleChange} placeholder="••••••••" />
        </div>

        <button type="submit" className="btn btn-primary btn-full btn-lg mt-1" disabled={loading}>
          {loading ? 'Creating account…' : 'Sign up'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-[#475569]">
        Already have an account?{' '}
        <Link
          to={redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login'}
          className="font-semibold text-[#dc2626]"
        >
          Log in
        </Link>
      </p>
    </AuthShell>
  );
}
