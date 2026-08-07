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

  // Protect against SPA fallback matching static assets like /favicon.ico
  if (tenantSlug && tenantSlug.includes('.')) {
    return null;
  }

  useEffect(() => {
    fetchData();
  }, [selectedCategory, searchQuery]);

  async function fetchData() {
    try {
      setLoading(true);
      const [catRes, itemsRes] = await Promise.all([
        api.get('/menu/categories'),
        api.get('/menu', { params: { category: selectedCategory, search: searchQuery } }),
      ]);
      setCategories(catRes.data.categories);
      setItems(itemsRes.data.items);
    } catch (err) {
      console.error('Failed to load menu', err);
      if (err.response?.status === 404) {
        setNotFound(true);
      }
    } finally {
      setLoading(false);
    }
  }

  if (notFound) {
    return (
      <div className="page flex flex-col items-center justify-center text-center" style={{ minHeight: '60vh' }}>
        <h1 style={{ fontSize: '3rem', marginBottom: '1rem', color: 'var(--color-secondary)' }}>404</h1>
        <h2>Restaurant Not Found</h2>
        <p className="text-secondary mt-2 mb-6">We couldn't find a restaurant at this URL.</p>
        <Link to="/" className="btn btn-primary">Return to Homepage</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="flex flex-col items-center mb-8 text-center">
        <h1>Our Menu</h1>
        <p className="text-secondary mt-2">Discover our delicious offerings.</p>
      </div>

      <div className="flex flex-col gap-6 md:flex-row justify-between mb-8">
        <div className="flex gap-2" style={{ overflowX: 'auto', paddingBottom: '4px' }}>
          <button
            className={`btn ${selectedCategory === '' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSelectedCategory('')}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              className={`btn ${selectedCategory === cat ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setSelectedCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        <div style={{ minWidth: '250px' }}>
          <input
            type="text"
            className="form-input"
            placeholder="Search menu..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="loading-page">
          <div className="spinner" />
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <h3>No items found</h3>
          <p>Try adjusting your search or category filter.</p>
        </div>
      ) : (
        <div className="grid grid-3">
          {items.map((item) => (
            <Link to={`/menu/${item.id}`} key={item.id} className="card" style={{ display: 'flex', flexDirection: 'column' }}>
              {item.image_url ? (
                <img src={item.image_url} alt={item.name} className="card-image" />
              ) : (
                <div className="card-image flex items-center" style={{ justifyContent: 'center' }}>
                  <span className="text-muted">No Image</span>
                </div>
              )}
              <h3 className="mb-2">{item.name}</h3>
              <p className="text-secondary text-sm mb-4" style={{ flexGrow: 1 }}>{item.description}</p>
              <div className="flex items-center justify-between mt-auto">
                <span style={{ fontWeight: 600, color: 'var(--color-accent)', fontSize: 'var(--font-size-lg)' }}>
                  ${parseFloat(item.price).toFixed(2)}
                </span>
                <span className="btn btn-secondary btn-sm">View</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
