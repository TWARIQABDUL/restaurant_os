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

  const [formData, setFormData] = useState({
    guest_name: '',
    guest_email: '',
    guest_phone: '',
    guest_address: '',
    payment_method: 'cash_on_delivery',
    delivery_notes: ''
  });

  useEffect(() => {
    if (items.length === 0) {
      navigate(`/${tenantSlug}/cart`);
    }
  }, [items, navigate, tenantSlug]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

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
      navigate(`/${tenantSlug}/track?code=${data.order.tracking_code}`);
    } catch (err) {
      setError(err.response?.data?.errors?.[0]?.msg || err.response?.data?.error || 'Failed to place order');
    } finally {
      setLoading(false);
    }
  };

  if (items.length === 0) return null;

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
            <p className="text-sm text-secondary mb-4">Note: Your payment will be verified manually by our staff.</p>

            <div className="form-group">
              <select name="payment_method" className="form-select" value={formData.payment_method} onChange={handleChange}>
                <option value="cash_on_delivery">Cash on Delivery</option>
                <option value="mobile_money">Mobile Money</option>
                <option value="bank_transfer">Bank Transfer</option>
              </select>
            </div>
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
