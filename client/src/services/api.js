import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // Attach tenant slug
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const globalRoutes = ['login', 'register', 'manager', 'admin', 'delivery', 'super-admin'];
  
  let tenantSlug = localStorage.getItem('tenantSlug') || 'demo';
  
  // If the first path segment is not a global route and not a static file, assume it's a tenant slug
  if (pathParts.length > 0 && !globalRoutes.includes(pathParts[0]) && !pathParts[0].includes('.')) {
    tenantSlug = pathParts[0];
    localStorage.setItem('tenantSlug', tenantSlug);
  }

  config.headers['X-Tenant-Slug'] = tenantSlug;

  return config;
});

// Handle 401 responses globally
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      // Don't redirect if already on login/register page
      if (!window.location.pathname.includes('/login') && !window.location.pathname.includes('/register')) {
        const currentPath = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/login?redirect=${currentPath}`;
      }
    }
    return Promise.reject(error);
  }
);

export default api;
