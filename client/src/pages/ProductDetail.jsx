import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { ArrowLeft, Star, Package, Minus, Plus } from 'lucide-react';

export default function ProductDetail() {
  const { id, tenantSlug } = useParams();
  const navigate = useNavigate();
  const { addItem } = useCart();
  const { user } = useAuth();

  const [item, setItem] = useState(null);
  const [availableAddOns, setAvailableAddOns] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);

  const [quantity, setQuantity] = useState(1);
  const [selectedAddOns, setSelectedAddOns] = useState({});

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

  // Multi-choice add-on: toggle it, with a quantity.
  const toggleAddOn = (addOn) => {
    setSelectedAddOns(prev => {
      const next = { ...prev };
      if (next[addOn.id]) delete next[addOn.id];
      else next[addOn.id] = { ...addOn, quantity: 1 };
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
      return { ...prev, [addOnId]: { ...prev[addOnId], quantity: nextQty } };
    });
  };

  // Single-choice group (Size): pick one, replacing any other choice in the group.
  const pickOne = (addOn) => {
    if (addOn.in_stock === false) return;
    setSelectedAddOns(prev => {
      const next = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!(v.single_choice && v.category === addOn.category)) next[k] = v;
      }
      next[addOn.id] = { ...addOn, quantity: 1 };
      return next;
    });
  };

  // Groups where every option is "pick one".
  const singleChoiceGroups = [...new Set(
    availableAddOns.filter(a => a.single_choice).map(a => a.category),
  )].filter(g => availableAddOns.filter(a => a.category === g).every(a => a.single_choice));

  const missingRequired = singleChoiceGroups.filter(
    g => !Object.values(selectedAddOns).some(o => o.category === g),
  );

  const calculateTotal = () => {
    if (!item) return 0;
    const opts = Object.values(selectedAddOns);
    const perUnit = opts.filter(o => o.single_choice).reduce((s, o) => s + parseFloat(o.price || 0), 0);
    const lineExtras = opts.filter(o => !o.single_choice).reduce((s, o) => s + parseFloat(o.price || 0) * o.quantity, 0);
    return (parseFloat(item.price) + perUnit) * quantity + lineExtras * quantity;
  };

  const soldOut = item?.in_stock === false;
  const stockCap = item?.track_inventory ? item.stock_quantity : null;

  const handleAddToCart = () => {
    if (soldOut) return;
    if (missingRequired.length > 0) {
      toast.error(`Choose a ${missingRequired[0]} first`);
      return;
    }
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
    <div className="page mx-auto max-w-4xl px-4">
      <button
        onClick={() => navigate(-1)}
        className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-[#475569] hover:text-[#0f172a]"
      >
        <ArrowLeft size={16} /> Back to shop
      </button>

      <div className="grid gap-9 md:grid-cols-[minmax(0,420px)_minmax(0,1fr)] md:items-start">
        {item.image_url ? (
          <img
            src={item.image_url}
            alt={item.name}
            className="h-[420px] w-full rounded-2xl border border-[#e2e8f0] object-cover"
          />
        ) : (
          <div className="flex h-[420px] w-full items-center justify-center rounded-2xl border border-[#e2e8f0] bg-[#eef2f6] text-[#cbd5e1]">
            <Package size={58} strokeWidth={1.1} />
          </div>
        )}

        <div>
          <h1 className="text-3xl font-bold">{item.name}</h1>
          <p className="mt-2.5 leading-relaxed text-[#475569]">{item.description}</p>
          <div className="font-heading mt-4 text-2xl font-bold">${parseFloat(item.price).toFixed(2)}</div>
          {soldOut && (
            <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[#fee2e2] px-3 py-2 text-sm font-semibold text-[#dc2626]">
              Out of stock — check back soon
            </div>
          )}
          {!soldOut && item.low_stock && (
            <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[#fef3c7] px-3 py-2 text-sm font-semibold text-[#92400e]">
              Only {item.stock_quantity} left in stock
            </div>
          )}

          {availableAddOns.length > 0 && (
            <div className="mt-6 border-t border-[#e2e8f0] pt-5">
              {addOnCategories.map(category => {
                const groupOptions = availableAddOns.filter(a => a.category === category);
                const isPickOne = singleChoiceGroups.includes(category);

                if (isPickOne) {
                  return (
                    <div key={category} className="mb-5">
                      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[#94a3b8]">
                        {category}
                        <span className="text-[#dc2626]">*</span>
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {groupOptions.map(opt => {
                          const chosen = !!selectedAddOns[opt.id];
                          const oos = opt.in_stock === false;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              disabled={oos}
                              onClick={() => pickOne(opt)}
                              className={`rounded-lg border px-3.5 py-2 text-sm font-semibold transition-colors ${
                                chosen
                                  ? 'border-[#dc2626] bg-[#fef2f2] text-[#dc2626]'
                                  : oos
                                    ? 'cursor-not-allowed border-[#e2e8f0] bg-[#f8fafc] text-[#cbd5e1] line-through'
                                    : 'border-[#e2e8f0] bg-white text-[#0f172a] hover:border-[#cbd5e1]'
                              }`}
                            >
                              {opt.name}
                              {parseFloat(opt.price) > 0 && <span className="ml-1 font-medium">+${parseFloat(opt.price).toFixed(2)}</span>}
                              {opt.low_stock && !oos && <span className="ml-1 text-[10px] font-medium text-[#d97706]">({opt.stock_quantity} left)</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={category} className="mb-5">
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#94a3b8]">{category}</h4>
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      {groupOptions.map(addOn => {
                        const isSelected = !!selectedAddOns[addOn.id];
                        const oos = addOn.in_stock === false;
                        return (
                          <div
                            key={addOn.id}
                            onClick={() => !isSelected && !oos && toggleAddOn(addOn)}
                            className={`flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors ${
                              isSelected
                                ? 'border-[#dc2626] bg-[#fef2f2]'
                                : oos
                                  ? 'border-[#e2e8f0] bg-[#f8fafc] opacity-60'
                                  : 'cursor-pointer border-[#e2e8f0] bg-white hover:border-[#cbd5e1]'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium">{addOn.name}{oos && <span className="ml-1.5 text-xs text-[#94a3b8]">· out of stock</span>}</div>
                              <div className="text-xs font-semibold text-[#475569]">+${parseFloat(addOn.price).toFixed(2)}</div>
                            </div>
                            {isSelected ? (
                              <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                <button className="icon-btn p-1 text-[#475569] hover:text-[#0f172a]" onClick={() => updateAddOnQuantity(addOn.id, -1)} aria-label="Decrease">
                                  <Minus size={14} />
                                </button>
                                <span className="min-w-[1rem] text-center text-sm font-semibold">{selectedAddOns[addOn.id].quantity}</span>
                                <button className="icon-btn p-1 text-[#0f172a]" onClick={() => updateAddOnQuantity(addOn.id, 1)} aria-label="Increase">
                                  <Plus size={14} />
                                </button>
                              </div>
                            ) : (
                              <span className="h-5 w-5 shrink-0 rounded-md border border-[#cbd5e1]" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <div className="flex items-center gap-4 rounded-lg border border-[#e2e8f0] bg-white px-4">
              <button
                className="icon-btn p-2 text-[#475569] hover:text-[#0f172a]"
                onClick={() => setQuantity(q => Math.max(1, q - 1))}
                aria-label="Decrease quantity"
              >
                <Minus size={16} />
              </button>
              <span className="font-heading min-w-[1.5rem] text-center text-[15px] font-bold">{quantity}</span>
              <button
                className="icon-btn p-2 text-[#0f172a] disabled:opacity-40"
                onClick={() => setQuantity(q => (stockCap ? Math.min(stockCap, q + 1) : q + 1))}
                disabled={soldOut || (stockCap !== null && quantity >= stockCap)}
                aria-label="Increase quantity"
              >
                <Plus size={16} />
              </button>
            </div>
            <button
              className="btn btn-primary btn-lg flex-1"
              onClick={handleAddToCart}
              disabled={soldOut}
            >
              {soldOut ? 'Out of stock' : (
                <>Add to cart <span className="opacity-80">· ${calculateTotal().toFixed(2)}</span></>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="card mt-9">
        <h3 className="mb-4 text-[15px] font-semibold">Customer reviews</h3>

        {user ? (
          <form onSubmit={submitReview} className="mb-6 rounded-lg bg-[#f8fafc] p-4">
            <h4 className="mb-3 text-sm font-semibold">Leave a review</h4>
            <div className="flex flex-col gap-4">
              <div>
                <span className="form-label">Rating</span>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map(star => (
                    <button
                      key={star}
                      type="button"
                      onClick={() => setReviewRating(star)}
                      className="icon-btn p-0.5"
                      aria-label={`${star} star${star > 1 ? 's' : ''}`}
                    >
                      <Star
                        size={22}
                        className={star <= reviewRating ? 'fill-[#f59e0b] text-[#f59e0b]' : 'text-[#cbd5e1]'}
                      />
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="form-label">Comment (optional)</label>
                <textarea
                  className="form-textarea"
                  rows="3"
                  value={reviewComment}
                  onChange={e => setReviewComment(e.target.value)}
                  placeholder="What did you think about this item?"
                />
              </div>
              <div className="flex justify-end">
                <button type="submit" className="btn btn-primary" disabled={submittingReview}>
                  {submittingReview ? 'Submitting…' : 'Submit review'}
                </button>
              </div>
            </div>
          </form>
        ) : (
          <div className="mb-6 rounded-lg bg-[#f8fafc] p-4 text-center">
            <p className="mb-3 text-sm text-[#475569]">Log in to leave a review</p>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/${tenantSlug}/login`)}>Log in</button>
          </div>
        )}

        <div className="flex flex-col">
          {reviews.length === 0 ? (
            <p className="py-4 text-center text-sm text-[#94a3b8]">No reviews yet. Be the first to review this item.</p>
          ) : (
            reviews.map(review => (
              <div key={review.id} className="border-b border-[#e2e8f0] py-4 last:border-b-0">
                <div className="mb-1.5 flex items-center justify-between">
                  <div className="text-sm font-semibold">{review.users?.name || 'Anonymous'}</div>
                  <div className="text-xs text-[#94a3b8]">{new Date(review.created_at).toLocaleDateString()}</div>
                </div>
                <div className="mb-1.5 flex gap-0.5">
                  {[1, 2, 3, 4, 5].map(n => (
                    <Star
                      key={n}
                      size={13}
                      className={n <= review.rating ? 'fill-[#f59e0b] text-[#f59e0b]' : 'text-[#cbd5e1]'}
                    />
                  ))}
                </div>
                {review.comment && <p className="text-sm text-[#475569]">{review.comment}</p>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
