import { createContext, useContext, useState, useEffect } from 'react';
import api from '../services/api';
import { connectSocket, disconnectSocket } from '../services/socket';

const AuthContext = createContext(null);

/**
 * The session lives in an httpOnly cookie the browser can't read, so the client
 * can no longer tell whether it's signed in by inspecting storage — it has to
 * ask. The stored `user` is a UI cache only: it renders the shell immediately
 * on load, then /auth/me confirms or clears it.
 *
 * Nothing here is authoritative. The server re-reads the user's role on every
 * request, so a tampered cache buys a rendered page and 403s on all its data.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Show the cached user straight away so protected pages don't flash the
    // login redirect while /me is in flight.
    const cached = localStorage.getItem('user');
    const legacyToken = localStorage.getItem('token');
    if (cached) {
      try {
        setUser(JSON.parse(cached));
      } catch {
        localStorage.removeItem('user');
      }
    }

    // No cookie and no legacy token means there is nothing to confirm.
    if (!cached && !legacyToken) {
      setLoading(false);
      return;
    }

    api.get('/auth/me')
      .then(({ data }) => {
        if (cancelled) return;
        setUser(data.user);
        localStorage.setItem('user', JSON.stringify(data.user));
        connectSocket();
      })
      .catch(() => {
        if (cancelled) return;
        // Expired or revoked — drop the cache rather than leaving a stale
        // identity rendered.
        localStorage.removeItem('user');
        localStorage.removeItem('token');
        setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  async function login(email, password) {
    // The response also sets the httpOnly session cookie; the token in the body
    // is for pre-migration clients and is deliberately not stored.
    const { data } = await api.post('/auth/login', { email, password });
    localStorage.setItem('user', JSON.stringify(data.user));

    // A stale pre-migration token would otherwise keep being sent as a header
    // and win over the new cookie.
    localStorage.removeItem('token');

    if (data.user?.tenants?.slug) {
      localStorage.setItem('tenantSlug', data.user.tenants.slug);
    }

    setUser(data.user);
    connectSocket();
    return data.user;
  }

  async function register(name, email, password, phone) {
    const { data } = await api.post('/auth/register', { name, email, password, phone });
    localStorage.setItem('user', JSON.stringify(data.user));
    localStorage.removeItem('token');
    setUser(data.user);
    connectSocket();
    return data.user;
  }

  async function logout() {
    // The cookie is httpOnly, so only the server can clear it.
    try {
      await api.post('/auth/logout');
    } catch {
      // Already expired or offline — clear locally regardless.
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('tenantSlug');
    setUser(null);
    disconnectSocket();
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
