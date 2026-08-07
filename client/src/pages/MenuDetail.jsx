import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useCart } from '../context/CartContext';

export default function MenuDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { addItem } = useCart();
  
  const [item, setItem] = useState(null);
  const [availableAddOns, setAvailableAddOns] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // State for user selections
  const [quantity, setQuantity] = useState(1);
  const [selectedAddOns, setSelectedAddOns] = useState({});

  useEffect(() => {
    async function fetchItem() {
      try {
        const { data } = await api.get(`/menu/${id}`);
        setItem(data.item);
        setAvailableAddOns(data.addOns || []);
      } catch (err) {
        console.error('Failed to load item detail', err);
      } finally {
        setLoading(false);
      }
    }
    fetchItem();
  }, [id]);

  const toggleAddOn = (addOn) => {
    setSelectedAddOns(prev => {
      const next = { ...prev };
      if (next[addOn.id]) {
        delete next[addOn.id];
      } else {
        next[addOn.id] = { ...addOn, quantity: 1 };
      }
      return next;
    });
  };

  const updateAddOnQuantity = (addOnId, delta) => {
    setSelectedAddOns(prev => {
      if (!prev[addOnId]) return prev;
      const nextQty = prev[addOnId].quantity + delta;
      if (nextQty <= 0) {
        const next = { ...prev };
        delete next[addOnId];
        return next;
      }
      return {
        ...prev,
        [addOnId]: { ...prev[addOnId], quantity: nextQty }
      };
    });
  };

  const calculateTotal = () => {
    if (!item) return 0;
    let total = parseFloat(item.price);
    Object.values(selectedAddOns).forEach(addon => {
      total += parseFloat(addon.price) * addon.quantity;
    });
    return total * quantity;
  };

  const handleAddToCart = () => {
    addItem(item, quantity, Object.values(selectedAddOns));
    navigate('/cart');
  };

  if (loading) {
    return <div className="loading-page"><div className="spinner" /></div>;
  }

  if (!item) {
    return <div className="empty-state"><h3>Item not found</h3></div>;
  }

  const addOnCategories = [...new Set(availableAddOns.map(a => a.category))];

  return (
    <div className="page" style={{ maxWidth: '800px', margin: '0 auto' }}>
      <button className="btn btn-secondary mb-6" onClick={() => navigate(-1)}>
        ← Back to Menu
      </button>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {item.image_url ? (
          <img src={item.image_url} alt={item.name} style={{ width: '100%', height: '300px', objectFit: 'cover' }} />
        ) : (
          <div style={{ width: '100%', height: '200px', background: 'var(--color-bg-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="text-muted">No Image</span>
          </div>
        )}

        <div className="p-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="mb-2">{item.name}</h1>
              <p className="text-secondary">{item.description}</p>
            </div>
            <span style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-accent)' }}>
              ${parseFloat(item.price).toFixed(2)}
            </span>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '24px 0' }} />

          {availableAddOns.length > 0 && (
            <div className="mb-8">
              <h3 className="mb-4">Customize your order</h3>
              
              {addOnCategories.map(category => (
                <div key={category} className="mb-6">
                  <h4 className="mb-3" style={{ textTransform: 'capitalize', color: 'var(--color-text-secondary)' }}>
                    {category}
                  </h4>
                  <div className="grid grid-2">
                    {availableAddOns.filter(a => a.category === category).map(addOn => {
                      const isSelected = !!selectedAddOns[addOn.id];
                      return (
                        <div 
                          key={addOn.id} 
                          className={`card ${isSelected ? 'selected' : ''}`}
                          style={{ 
                            padding: '12px 16px', 
                            cursor: 'pointer',
                            borderColor: isSelected ? 'var(--color-accent)' : 'var(--color-border)',
                            backgroundColor: isSelected ? 'var(--color-accent-light)' : 'var(--color-surface)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                          }}
                          onClick={() => !isSelected && toggleAddOn(addOn)}
                        >
                          <div>
                            <div style={{ fontWeight: 500 }}>{addOn.name}</div>
                            <div className="text-sm text-secondary">+${parseFloat(addOn.price).toFixed(2)}</div>
                          </div>
                          
                          {isSelected ? (
                            <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                              <button 
                                className="btn btn-secondary btn-sm" 
                                style={{ padding: '2px 8px' }}
                                onClick={() => updateAddOnQuantity(addOn.id, -1)}
                              >
                                -
                              </button>
                              <span>{selectedAddOns[addOn.id].quantity}</span>
                              <button 
                                className="btn btn-secondary btn-sm"
                                style={{ padding: '2px 8px' }}
                                onClick={() => updateAddOnQuantity(addOn.id, 1)}
                              >
                                +
                              </button>
                            </div>
                          ) : (
                            <div style={{ width: '20px', height: '20px', border: '1px solid var(--color-border)', borderRadius: '4px' }}></div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mt-8 p-4" style={{ background: 'var(--color-bg)', borderRadius: 'var(--radius-lg)' }}>
            <div className="flex items-center gap-4">
              <span style={{ fontWeight: 500 }}>Quantity:</span>
              <div className="flex items-center gap-2 bg-white rounded-md border" style={{ padding: '4px' }}>
                <button 
                  className="btn btn-secondary btn-sm" 
                  onClick={() => setQuantity(q => Math.max(1, q - 1))}
                  style={{ border: 'none' }}
                >
                  -
                </button>
                <span style={{ width: '30px', textAlign: 'center', fontWeight: 600 }}>{quantity}</span>
                <button 
                  className="btn btn-secondary btn-sm" 
                  onClick={() => setQuantity(q => q + 1)}
                  style={{ border: 'none' }}
                >
                  +
                </button>
              </div>
            </div>

            <button className="btn btn-primary btn-lg flex-1 sm:flex-none" onClick={handleAddToCart}>
              Add to Cart • ${calculateTotal().toFixed(2)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
