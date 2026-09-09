import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../services/api';
import { Search, Package, Star, Clock, ArrowRight } from 'lucide-react';
import { BRAND } from '../config/brand';

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
        document.title = seo.seoTitle || tenant.name || BRAND.name;
        
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
      console.error('Failed to load products', err);
      if (err.response?.status === 404) {
        setNotFound(true);
      }
    } finally {
      setLoading(false);
    }
  }

  // Extract store info for hero
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
      <div className="page mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
        <h1 className="font-heading text-5xl font-bold text-[#94a3b8]">404</h1>
        <h2 className="mt-3">Store not found</h2>
        <p className="mt-2 mb-6 text-[#475569]">We couldn't find a store at this URL.</p>
        <Link to="/" className="btn btn-primary">Return to homepage</Link>
      </div>
    );
  }

  const storeName = tenantInfo?.name || tenantSlug?.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Store';

  return (
    <div className="page mx-auto max-w-6xl px-4 sm:px-6">
      {/* ── Store header ── */}
      <section className="flex items-center gap-5 pb-6">
        {tenantInfo?.logo_url ? (
          <img
            src={tenantInfo.logo_url}
            alt={storeName}
            className="h-[76px] w-[76px] shrink-0 rounded-2xl border border-[#e2e8f0] object-cover"
          />
        ) : (
          <div className="flex h-[76px] w-[76px] shrink-0 items-center justify-center rounded-2xl border border-[#fecaca] bg-[#fef2f2] text-[#dc2626]">
            <Package size={30} strokeWidth={1.5} />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-3xl font-bold">{storeName}</h1>
          <p className="mt-1.5 text-[15px] text-[#475569]">
            {tenantInfo?.seo?.seoDescription || 'Browse the catalogue and order in a couple of taps.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e2e8f0] bg-white px-2.5 py-1 text-xs font-semibold text-[#0f172a]">
              <Star size={13} className="fill-[#f59e0b] text-[#f59e0b]" /> 4.8
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#dcfce7] px-2.5 py-1 text-xs font-semibold text-[#16a34a]">
              <Clock size={13} /> Open now
            </span>
          </div>
        </div>
      </section>

      {/* ── Filters ── */}
      <div className="flex flex-col gap-4 border-t border-[#e2e8f0] py-5 md:flex-row md:items-center md:justify-between">
        <div className="scrollable-tabs">
          <button
            className={`btn btn-pill shrink-0 ${selectedCategory === '' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSelectedCategory('')}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              className={`btn btn-pill shrink-0 ${selectedCategory === cat ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setSelectedCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="relative w-full md:max-w-[280px]">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#94a3b8]" />
          <input
            type="text"
            className="form-input pl-9"
            placeholder="Search products"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* ── Product grid ── */}
      {loading ? (
        <div className="loading-page"><div className="spinner" /></div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <Package size={44} strokeWidth={1.25} className="mx-auto mb-4 text-[#cbd5e1]" />
          <h3>No items found</h3>
          <p>Try adjusting your search or category filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <Link
              to={`/${tenantSlug}/menu/${item.id}`}
              key={item.id}
              className="group flex flex-col overflow-hidden rounded-xl border border-[#e2e8f0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-[#cbd5e1]"
            >
              <div className={`relative ${item.in_stock === false ? 'opacity-55' : ''}`}>
                {item.image_url ? (
                  <img src={item.image_url} alt={item.name} className="h-44 w-full object-cover" />
                ) : (
                  <div className="flex h-44 w-full items-center justify-center bg-[#eef2f6] text-[#cbd5e1]">
                    <Package size={40} strokeWidth={1.25} />
                  </div>
                )}
                <span className="absolute right-3 top-3 rounded-full bg-[#0f172a] px-2.5 py-1 text-xs font-bold text-white">
                  ${parseFloat(item.price).toFixed(2)}
                </span>
                {item.in_stock === false && (
                  <span className="absolute left-3 top-3 rounded-full bg-[#dc2626] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Sold out
                  </span>
                )}
                {item.low_stock && item.in_stock !== false && (
                  <span className="absolute left-3 top-3 rounded-full bg-[#fef3c7] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[#92400e]">
                    Only {item.stock_quantity} left
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-col p-4 pt-3.5">
                <h3 className="text-[15px] font-semibold">{item.name}</h3>
                <p className="mt-1 flex-1 text-[13px] leading-snug text-[#475569]">
                  {item.description?.length > 80 ? item.description.slice(0, 80) + '…' : item.description}
                </p>
                {item.in_stock === false ? (
                  <span className="mt-3.5 inline-flex items-center gap-1.5 self-start rounded-lg border border-[#e2e8f0] bg-[#f8fafc] px-3 py-1.5 text-xs font-semibold text-[#94a3b8]">
                    Out of stock
                  </span>
                ) : (
                  <span className="mt-3.5 inline-flex items-center gap-1.5 self-start rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-1.5 text-xs font-semibold text-[#dc2626]">
                    View details <ArrowRight size={13} />
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}