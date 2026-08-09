import { useState, useEffect } from 'react';
import { useNavigate, Link, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import api from '../services/api';

export default function Checkout() {
  const { user } = useAuth();
  const { items, getTotal, clearCart } = useCart();
  const navigate = useNavigate();
  const { tenantSlug } = useParams();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState(null); // null | 'waiting' | 'paid' | 'timeout'
  const [trackingCode, setTrackingCode] = useState(null);

  const [formData, setFormData] = useState({
    guest_name: '',
    guest_email: '',
    guest_phone: '',
    guest_address: '',
    payment_method: 'cash_on_delivery',
    payment_phone: '',
    delivery_notes: ''
  });

  useEffect(() => {
    if (user && user.phone && !formData.payment_phone) {
      setFormData(prev => ({ ...prev, payment_phone: user.phone }));
    }
  }, [user, formData.payment_phone]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => {
      const next = { ...prev, [name]: value };
      if (name === 'guest_phone' && !prev.payment_phone) {
        next.payment_phone = value;
      }
      return next;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (formData.payment_method === 'mobile_money' && !formData.payment_phone) {
      setError('Please provide a MoMo phone number.');
      return;
    }

    setLoading(true);

    try {
      const orderData = {
        items: items.map(item => ({
          menu_item_id: item.menuItem.id,
          quantity: item.quantity,
          add_ons: item.selectedAddOns.map(ao => ({
            add_on_id: ao.id,
            quantity: ao.quantity
          }))
        })),
        payment_method: formData.payment_method,
        payment_phone: formData.payment_phone,
        delivery_notes: formData.delivery_notes
      };

      if (!user) {
        orderData.guest_name = formData.guest_name;
        orderData.guest_email = formData.guest_email;
        orderData.guest_phone = formData.guest_phone;
        orderData.guest_address = formData.guest_address;
      }

      const { data } = await api.post('/orders', orderData);
      clearCart();

      if (formData.payment_method === 'mobile_money' && data.payment?.status === 'PENDING') {
        setTrackingCode(data.order.tracking_code);
        setPaymentStatus('waiting');
        pollPaymentStatus(data.order.tracking_code);
      } else {
        navigate(`/${tenantSlug}/track?code=${data.order.tracking_code}`);
      }
    } catch (err) {
      setError(err.response?.data?.errors?.[0]?.msg || err.response?.data?.error || 'Failed to place order');
    } finally {
      setLoading(false);
    }
  };

  // Poll the (already-public) tracking endpoint for up to ~60s waiting for
  // the customer to approve the MoMo prompt on their phone. If it's still
  // pending after that, the order still exists and the backend keeps
  // reconciling it in the background — the customer just isn't blocked
  // waiting on this screen forever.
  const pollPaymentStatus = async (code, attempt = 0) => {
    const maxAttempts = 30;
    try {
      const { data } = await api.get(`/orders/track/${code}`);
      if (data.order.payment_status === 'paid') {
        setPaymentStatus('paid');
        setTimeout(() => navigate(`/${tenantSlug}/track?code=${code}`), 1200);
        return;
      }
    } catch {
      // transient network hiccup — keep trying rather than aborting
    }

    if (attempt >= maxAttempts) {
      setPaymentStatus('timeout');
      return;
    }
    setTimeout(() => pollPaymentStatus(code, attempt + 1), 2000);
  };

  if (items.length === 0) return null;

  if (paymentStatus) {
    return (
      <div className="page" style={{ maxWidth: '440px', margin: '0 auto' }}>
        <div className="card p-8 text-center">
          {paymentStatus === 'waiting' && (
            <>
              <div className="spinner" style={{ margin: '0 auto var(--space-4)' }} />
              <h3 className="mb-2">Check your phone</h3>
              <p className="text-secondary">We've sent a MoMo payment request to your phone. Approve it there to confirm your order.</p>
            </>
          )}
          {paymentStatus === 'paid' && (
            <>
              <h3 className="mb-2">Payment confirmed!</h3>
              <p className="text-secondary">Taking you to your order…</p>
            </>
          )}
          {paymentStatus === 'timeout' && (
            <>
              <h3 className="mb-2">Still waiting on confirmation</h3>
              <p className="text-secondary mb-4">This is taking longer than expected, but your order has been placed — we'll keep checking in the background. You can come back to this any time.</p>
              <Link to={`/${tenantSlug}/track?code=${trackingCode}`} className="btn btn-primary">View Order Status</Link>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page grid grid-2" style={{ maxWidth: '1000px', margin: '0 auto', gap: 'var(--space-8)' }}>
      
      <div>
        <h1 className="mb-6">Checkout</h1>

        {!user && (
          <div className="card mb-6" style={{ background: 'var(--color-info-light)', borderColor: 'var(--color-info)' }}>
            <p className="text-sm" style={{ color: 'var(--color-info)' }}>
              <strong>Want to save your details?</strong> <Link to="/register" style={{ textDecoration: 'underline' }}>Create an account</Link> or <Link to="/login" style={{ textDecoration: 'underline' }}>log in</Link>. You can also continue as a guest.
            </p>
          </div>
        )}

        {error && <div className="form-error mb-4 p-3 bg-red-50 text-red-700 rounded">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="card mb-6">
            <h3 className="mb-4">Delivery Details</h3>
            
            {!user && (
              <>
                <div className="form-group">
                  <label className="form-label">Full Name</label>
                  <input type="text" name="guest_name" className="form-input" required value={formData.guest_name} onChange={handleChange} />
                </div>
                <div className="form-group">
                  <label className="form-label">Email (for receipt)</label>
                  <input type="email" name="guest_email" className="form-input" required value={formData.guest_email} onChange={handleChange} />
                </div>
                <div className="form-group">
                  <label className="form-label">Phone Number</label>
                  <input type="tel" name="guest_phone" className="form-input" required value={formData.guest_phone} onChange={handleChange} />
                </div>
                <div className="form-group">
                  <label className="form-label">Delivery Address</label>
                  <textarea name="guest_address" className="form-textarea" required value={formData.guest_address} onChange={handleChange} style={{ minHeight: '80px' }}></textarea>
                </div>
              </>
            )}

            {user && (
              <div className="mb-4 p-4 rounded bg-gray-50 border">
                <p><strong>Deliver to:</strong> {user.name}</p>
                <p className="text-secondary text-sm">We'll contact you at {user.phone || user.email} upon arrival.</p>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Delivery Instructions (Optional)</label>
              <input type="text" name="delivery_notes" className="form-input" placeholder="e.g. Leave at front door" value={formData.delivery_notes} onChange={handleChange} />
            </div>
          </div>

          <div className="card mb-8">
            <h3 className="mb-4">Payment Method</h3>
            <p className="text-sm text-secondary mb-4">
              {formData.payment_method === 'mobile_money'
                ? "You'll get a MoMo payment prompt on your phone as soon as you place the order."
                : formData.payment_method === 'cash_on_delivery'
                ? 'Pay in cash when your order arrives.'
                : 'Your payment will be verified manually by our staff.'}
            </p>

            <div className="form-group">
              <select name="payment_method" className="form-select" value={formData.payment_method} onChange={handleChange}>
                <option value="cash_on_delivery">Cash on Delivery</option>
                <option value="mobile_money">Mobile Money</option>
                <option value="bank_transfer">Bank Transfer</option>
              </select>
            </div>

            {formData.payment_method === 'mobile_money' && (
              <div className="form-group mt-4">
                <label className="form-label">MoMo Phone Number</label>
                <input 
                  type="tel" 
                  name="payment_phone" 
                  className="form-input" 
                  required 
                  value={formData.payment_phone} 
                  onChange={handleChange} 
                  placeholder="e.g. 0780000000"
                />
              </div>
            )}
          </div>

          <button type="submit" className="btn btn-primary btn-lg btn-full" disabled={loading}>
            {loading ? 'Processing...' : 'Place Order'}
          </button>
        </form>
      </div>

      <div>
        <div className="card sticky" style={{ top: '80px' }}>
          <h3 className="mb-4">Order Summary</h3>
          
          <div style={{ maxHeight: '300px', overflowY: 'auto', margin: '0 -24px', padding: '0 24px' }}>
            {items.map((item, index) => (
              <div key={index} className="flex justify-between items-start mb-4 pb-4 border-b">
                <div>
                  <div style={{ fontWeight: 500 }}>{item.quantity}x {item.menuItem.name}</div>
                  {item.selectedAddOns.map(ao => (
                    <div key={ao.id} className="text-xs text-secondary pl-4">
                      + {ao.quantity}x {ao.name}
                    </div>
                  ))}
                </div>
                <div style={{ fontWeight: 500 }}>
                  ${((item.menuItem.price * item.quantity) + item.selectedAddOns.reduce((s, ao) => s + (ao.price * ao.quantity * item.quantity), 0)).toFixed(2)}
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-between items-center mt-4 pt-4 border-t">
            <span style={{ fontWeight: 600, fontSize: 'var(--font-size-lg)' }}>Total</span>
            <span style={{ fontWeight: 700, fontSize: 'var(--font-size-xl)', color: 'var(--color-accent)' }}>
              ${getTotal().toFixed(2)}
            </span>
          </div>
        </div>
      </div>

    </div>
  );
}