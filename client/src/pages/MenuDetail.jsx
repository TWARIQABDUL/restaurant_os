import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';

export default function MenuDetail() {
  const { id, tenantSlug } = useParams();
  const navigate = useNavigate();
  const { addItem } = useCart();
  const { user } = useAuth();
  
  const [item, setItem] = useState(null);
  const [availableAddOns, setAvailableAddOns] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // State for user selections
  const [quantity, setQuantity] = useState(1);
  const [selectedAddOns, setSelectedAddOns] = useState({});

  // State for new review
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);

  useEffect(() => {
    async function fetchItem() {
      try {
        const [{ data: itemData }, { data: reviewsData }] = await Promise.all([
          api.get(`/menu/${id}`),
          api.get(`/reviews/menu/${id}`)
        ]);
        setItem(itemData.item);
        setAvailableAddOns(itemData.addOns || []);
        setReviews(reviewsData.reviews || []);
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
    navigate(`/${tenantSlug}/cart`);
  };

  const submitReview = async (e) => {
    e.preventDefault();
    if (!user) return;
    setSubmittingReview(true);
    try {
      const { data } = await api.post('/reviews', {
        menu_item_id: id,
        rating: reviewRating,
        comment: reviewComment
      });
      setReviews(prev => [data.review, ...prev]);
      setReviewRating(5);
      setReviewComment('');
      toast.success('Review submitted successfully!');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to submit review');
    } finally {
      setSubmittingReview(false);
    }
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

      <div className="card mt-8">
        <h3 className="mb-4">Customer Reviews</h3>
        
        {user ? (
          <form onSubmit={submitReview} className="mb-8 p-4" style={{ background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
            <h4 className="mb-3">Leave a Review</h4>
            <div className="flex flex-col gap-4">
              <div>
                <label className="form-label">Rating</label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map(star => (
                    <button
                      key={star}
                      type="button"
                      onClick={() => setReviewRating(star)}
                      style={{
                        background: 'none',
                        border: 'none',
                        fontSize: '24px',
                        cursor: 'pointer',
                        color: star <= reviewRating ? 'var(--color-accent)' : 'var(--color-border)'
                      }}
                    >
                      ★
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="form-label">Comment (Optional)</label>
                <textarea 
                  className="form-input" 
                  rows="3"
                  value={reviewComment}
                  onChange={e => setReviewComment(e.target.value)}
                  placeholder="What did you think about this item?"
                ></textarea>
              </div>
              <div className="flex justify-end">
                <button 
                  type="submit" 
                  className="btn btn-primary"
                  disabled={submittingReview}
                >
                  {submittingReview ? 'Submitting...' : 'Submit Review'}
                </button>
              </div>
            </div>
          </form>
        ) : (
          <div className="mb-8 p-4 text-center" style={{ background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
            <p className="text-secondary mb-3">Log in to leave a review</p>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/${tenantSlug}/login`)}>Log In</button>
          </div>
        )}

        <div className="flex flex-col gap-4">
          {reviews.length === 0 ? (
            <p className="text-secondary text-center py-4">No reviews yet. Be the first to review this item!</p>
          ) : (
            reviews.map(review => (
              <div key={review.id} style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: '16px' }}>
                <div className="flex justify-between items-center mb-2">
                  <div className="font-bold">{review.users?.name || 'Anonymous'}</div>
                  <div className="text-sm text-secondary">{new Date(review.created_at).toLocaleDateString()}</div>
                </div>
                <div className="mb-2" style={{ color: 'var(--color-accent)' }}>
                  {'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}
                </div>
                {review.comment && <p className="text-secondary m-0">{review.comment}</p>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
