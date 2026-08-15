import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../services/api';

export default function Home() {
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [notFound, setNotFound] = useState(false);
  const { tenantSlug } = useParams();
  const isStaticAssetPath = tenantSlug && tenantSlug.includes('.');

  useEffect(() => {
    // Protect against SPA fallback matching static assets like /favicon.ico
    if (isStaticAssetPath) return;
    fetchData();
  }, [selectedCategory, searchQuery, isStaticAssetPath]);

  async function fetchData() {
    try {
      setLoading(true);
      const [catRes, itemsRes, tenantRes] = await Promise.all([
        api.get('/menu/categories'),
        api.get('/menu', { params: { category: selectedCategory, search: searchQuery } }),
        api.get(`/tenants/public/${tenantSlug}`).catch(() => null)
      ]);
      
      setCategories(catRes.data.categories);
      setItems(itemsRes.data.items);

      if (tenantRes?.data?.tenant) {
        const tenant = tenantRes.data.tenant;
        const seo = tenant.seo || {};
        
        // Inject SEO tags
        document.title = seo.seoTitle || tenant.name || 'Restaurant OS';
        
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
          metaDesc.setAttribute('content', seo.seoDescription || `Order online from ${tenant.name}`);
        } else {
          const newMetaDesc = document.createElement('meta');
          newMetaDesc.name = "description";
          newMetaDesc.content = seo.seoDescription || `Order online from ${tenant.name}`;
          document.head.appendChild(newMetaDesc);
        }

        const metaKeywords = document.querySelector('meta[name="keywords"]');
        if (seo.seoKeywords) {
          if (metaKeywords) {
            metaKeywords.setAttribute('content', seo.seoKeywords);
          } else {
            const newMetaKeywords = document.createElement('meta');
            newMetaKeywords.name = "keywords";
            newMetaKeywords.content = seo.seoKeywords;
            document.head.appendChild(newMetaKeywords);
          }
        }

        // Favicon
        if (seo.faviconUrl) {
          let linkIcon = document.querySelector('link[rel="icon"]');
          if (linkIcon) {
            linkIcon.setAttribute('href', seo.faviconUrl);
          } else {
            linkIcon = document.createElement('link');
            linkIcon.rel = 'icon';
            linkIcon.href = seo.faviconUrl;
            document.head.appendChild(linkIcon);
          }
        }

        // Theme Color
        if (seo.themeColor) {
          let metaTheme = document.querySelector('meta[name="theme-color"]');
          if (metaTheme) {
            metaTheme.setAttribute('content', seo.themeColor);
          } else {
            metaTheme = document.createElement('meta');
            metaTheme.name = 'theme-color';
            metaTheme.content = seo.themeColor;
            document.head.appendChild(metaTheme);
          }
        }

        // Author
        if (seo.author) {
          let metaAuthor = document.querySelector('meta[name="author"]');
          if (metaAuthor) {
            metaAuthor.setAttribute('content', seo.author);
          } else {
            metaAuthor = document.createElement('meta');
            metaAuthor.name = 'author';
            metaAuthor.content = seo.author;
            document.head.appendChild(metaAuthor);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load menu', err);
      if (err.response?.status === 404) {
        setNotFound(true);
      }
    } finally {
      setLoading(false);
    }
  }

  // Extract restaurant info for hero
  const [tenantInfo, setTenantInfo] = useState(null);

  // Store tenant info when fetched
  useEffect(() => {
    if (items.length > 0 || categories.length > 0) return; // already fetched
  }, []);

  // We capture tenant info from the fetchData response
  const storeTenantInfo = (tenant) => {
    if (tenant && !tenantInfo) setTenantInfo(tenant);
  };

  // Patch: store tenant info inside fetchData
  useEffect(() => {
    // This runs once to capture the tenant data for the hero
    if (!tenantInfo && !loading) {
      api.get(`/tenants/public/${tenantSlug}`).then(res => {
        if (res.data?.tenant) setTenantInfo(res.data.tenant);
      }).catch(() => {});
    }
  }, [loading, tenantSlug, tenantInfo]);

  if (isStaticAssetPath) {
    return null;
  }

  if (notFound) {
    return (
      <div className="page flex flex-col items-center justify-center text-center" style={{ minHeight: '60vh' }}>
        <h1 style={{ fontSize: '3rem', marginBottom: '1rem', color: 'var(--color-text-secondary)' }}>404</h1>
        <h2>Restaurant Not Found</h2>
        <p className="text-secondary mt-2 mb-6">We couldn't find a restaurant at this URL.</p>
        <Link to="/" className="btn btn-primary">Return to Homepage</Link>
      </div>
    );
  }

  const restaurantName = tenantInfo?.name || tenantSlug?.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Restaurant';

  return (
    <div className="page">
      {/* ── Restaurant Hero Banner ── */}
      <div style={{
        background: 'var(--gradient-dark)',
        borderRadius: 'var(--radius-xl)',
        padding: 'var(--space-10) var(--space-8)',
        marginBottom: 'var(--space-8)',
        position: 'relative',
        overflow: 'hidden',
        textAlign: 'center',
        color: 'var(--color-text-inverse)'
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(circle at 30% 50%, rgba(232, 137, 12, 0.15) 0%, transparent 60%)',
          pointerEvents: 'none'
        }} />
        {tenantInfo?.logo_url && (
          <img
            src={tenantInfo.logo_url}
            alt={restaurantName}
            style={{
              width: '72px', height: '72px', borderRadius: '50%',
              objectFit: 'cover', margin: '0 auto var(--space-4)',
              border: '3px solid rgba(255,255,255,0.2)',
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
            }}
          />
        )}
        <h1 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-2)', position: 'relative' }}>
          {restaurantName}
        </h1>
        <p style={{ opacity: 0.7, fontSize: 'var(--font-size-sm)', position: 'relative' }}>
          {tenantInfo?.seo?.seoDescription || 'Explore our menu and order your favorites.'}
        </p>
      </div>

      {/* ── Category Pills + Search ── */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 'var(--space-4)',
        marginBottom: 'var(--space-8)'
      }}>
        <div style={{
          display: 'flex', gap: 'var(--space-2)',
          overflowX: 'auto', paddingBottom: '4px',
          scrollbarWidth: 'none'
        }}>
          <button
            className={`btn btn-pill ${selectedCategory === '' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSelectedCategory('')}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              className={`btn btn-pill ${selectedCategory === cat ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setSelectedCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        <div style={{ position: 'relative', maxWidth: '360px' }}>
          <span style={{
            position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)',
            color: 'var(--color-text-muted)', fontSize: '16px', pointerEvents: 'none'
          }}>🔍</span>
          <input
            type="text"
            className="form-input"
            placeholder="Search menu..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ paddingLeft: '36px' }}
          />
        </div>
      </div>

      {/* ── Menu Grid ── */}
      {loading ? (
        <div className="loading-page">
          <div className="spinner" />
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: '48px', marginBottom: 'var(--space-4)' }}>🍽️</div>
          <h3>No items found</h3>
          <p>Try adjusting your search or category filter.</p>
        </div>
      ) : (
        <div className="grid grid-3">
          {items.map((item) => (
            <Link
              to={`/${tenantSlug}/menu/${item.id}`}
              key={item.id}
              className="card"
              style={{
                display: 'flex', flexDirection: 'column',
                padding: 0, overflow: 'hidden',
                textDecoration: 'none', color: 'inherit'
              }}
            >
              <div style={{ position: 'relative', overflow: 'hidden' }}>
                {item.image_url ? (
                  <img
                    src={item.image_url}
                    alt={item.name}
                    style={{
                      width: '100%', height: '200px', objectFit: 'cover',
                      transition: 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)'
                    }}
                  />
                ) : (
                  <div style={{
                    width: '100%', height: '200px',
                    background: 'var(--color-bg-alt)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: '2rem' }}>🍴</span>
                  </div>
                )}
                {/* Gradient overlay */}
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0,
                  height: '60px',
                  background: 'linear-gradient(transparent, rgba(0,0,0,0.04))',
                  pointerEvents: 'none'
                }} />
                {/* Price badge */}
                <span style={{
                  position: 'absolute', top: 'var(--space-3)', right: 'var(--space-3)',
                  background: 'var(--gradient-accent)',
                  color: 'white', fontWeight: 700,
                  fontSize: 'var(--font-size-sm)',
                  padding: '4px 10px', borderRadius: '999px',
                  boxShadow: 'var(--shadow-md)'
                }}>
                  ${parseFloat(item.price).toFixed(2)}
                </span>
              </div>

              <div style={{ padding: 'var(--space-4) var(--space-5) var(--space-5)', flex: 1, display: 'flex', flexDirection: 'column' }}>
                <h3 style={{ fontSize: 'var(--font-size-base)', marginBottom: 'var(--space-1)' }}>{item.name}</h3>
                <p className="text-secondary text-sm" style={{ flexGrow: 1, marginBottom: 'var(--space-3)', lineHeight: 1.5 }}>
                  {item.description?.length > 80 ? item.description.slice(0, 80) + '…' : item.description}
                </p>
                <span className="btn btn-secondary btn-sm btn-pill" style={{ alignSelf: 'flex-start' }}>
                  View Details →
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}