import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../services/api';

export default function TenantThemeInjector() {
  const location = useLocation();

  useEffect(() => {
    // Attempt to extract tenantSlug from the URL path.
    // Assuming format is /:tenantSlug/... where tenantSlug is not a static asset or reserved word.
    const pathParts = location.pathname.split('/').filter(Boolean);
    const tenantSlug = pathParts[0];

    // Reserved paths that are not tenant slugs
    const reserved = ['admin', 'manager', 'delivery', 'super-admin', 'login', 'register', 'api'];
    if (!tenantSlug || reserved.includes(tenantSlug) || tenantSlug.includes('.')) {
      // Reset theme or skip
      document.documentElement.style.removeProperty('--color-primary');
      document.documentElement.style.removeProperty('--color-accent');
      document.documentElement.style.removeProperty('--color-secondary');
      document.documentElement.style.removeProperty('--color-bg');
      document.documentElement.style.removeProperty('--color-text');
      document.documentElement.style.removeProperty('--gradient-dark');
      document.documentElement.style.removeProperty('--gradient-accent');
      return;
    }

    api.get(`/tenants/public/${tenantSlug}`)
      .then(res => {
        const tenant = res.data?.tenant;
        const root = document.documentElement;
        
        if (tenant?.theme) {
          const { primaryColor, accentColor, secondaryColor, backgroundColor, textColor } = tenant.theme;
          
          if (primaryColor) {
            root.style.setProperty('--color-primary', primaryColor);
            root.style.setProperty('--gradient-dark', `linear-gradient(135deg, ${primaryColor} 0%, #7F1D1D 100%)`);
          } else {
            root.style.removeProperty('--color-primary');
            root.style.removeProperty('--gradient-dark');
          }
          
          if (accentColor) {
            root.style.setProperty('--color-accent', accentColor);
            root.style.setProperty('--gradient-accent', `linear-gradient(135deg, ${primaryColor || '#DC2626'} 0%, ${accentColor} 100%)`);
          } else {
            root.style.removeProperty('--color-accent');
            root.style.removeProperty('--gradient-accent');
          }

          if (secondaryColor) {
            root.style.setProperty('--color-secondary', secondaryColor);
          } else {
            root.style.removeProperty('--color-secondary');
          }

          if (backgroundColor) {
            root.style.setProperty('--color-bg', backgroundColor);
            root.style.setProperty('--color-surface-hover', backgroundColor); // ensure hover states adapt to the custom bg
          } else {
            root.style.removeProperty('--color-bg');
            root.style.removeProperty('--color-surface-hover');
          }

          if (textColor) {
            root.style.setProperty('--color-text', textColor);
          } else {
            root.style.removeProperty('--color-text');
          }
        }
      })
      .catch(err => {
        // If tenant is not found or error, don't break the app but log
        console.error('Failed to load theme for tenant', err);
      });
  }, [location.pathname]);

  return null;
}
