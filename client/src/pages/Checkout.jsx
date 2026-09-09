import { useState, useEffect } from 'react';
import { useNavigate, Link, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import api from '../services/api';
import { Banknote, Smartphone, Landmark, ShoppingCart } from 'lucide-react';


export default function Checkout() {
  const { user } = useAuth();
  const { items, getTotal, clearCart } = useCart();
  const navigate = useNavigate();
  const { tenantSlug } = useParams();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState(null); // null | 'waiting' | 'paid' | 'timeout'
  const [trackingCode, setTrackingCode] = useState(null);
  const [acceptedMethods, setAcceptedMethods] = useState(['cash_on_delivery', 'mobile_money', 'bank_transfer']);

  const [formData, setFormData] = useState({
    guest_name: '',
    guest_email: '',
    guest_phone: '',
    guest_address: '',
    payment_method: 'cash_on_delivery',
    payment_phone: '',
    delivery_notes: ''
  });

  // Fetch tenant's accepted payment methods
  useEffect(() => {
    async function loadTenantPaymentMethods() {
      try {
        const res = await api.get(`/tenants/public/${tenantSlug}`);
        const methods = res.data.tenant?.acceptedPaymentMethods || ['cash_on_delivery', 'mobile_money', 'bank_transfer'];
        setAcceptedMethods(methods);
        // Set default to the first accepted method
        if (!methods.includes(formData.payment_method)) {
          setFormData(prev => ({ ...prev, payment_method: methods[0] }));
        }
      } catch (err) {
        console.error('Failed to load tenant payment methods');
      }
    }
    loadTenantPaymentMethods();
  }, [tenantSlug]);

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
      <div className="page mx-auto max-w-md px-4">
        <div className="card text-center">
          {paymentStatus === 'waiting' && (
            <>
              <div className="spinner mx-auto mb-4" />
              <h3 className="mb-2 text-lg font-semibold">Check your phone</h3>
              <p className="text-sm text-[#475569]">We've sent a MoMo payment request to your phone. Approve it there to confirm your order.</p>
            </>
          )}
          {paymentStatus === 'paid' && (
            <>
              <h3 className="mb-2 text-lg font-semibold">Payment confirmed</h3>
              <p className="text-sm text-[#475569]">Taking you to your order…</p>
            </>
          )}
          {paymentStatus === 'timeout' && (
            <>
              <h3 className="mb-2 text-lg font-semibold">Still waiting on confirmation</h3>
              <p className="mb-4 text-sm text-[#475569]">This is taking longer than expected, but your order has been placed — we'll keep checking in the background. You can come back to this any time.</p>
              <Link to={`/${tenantSlug}/track?code=${trackingCode}`} className="btn btn-primary">View order status</Link>
            </>
          )}
        </div>
      </div>
    );
  }

  const paymentOptions = [
    { value: 'cash_on_delivery', label: 'Cash on delivery', hint: 'Pay the driver when your order arrives', icon: Banknote },
    { value: 'mobile_money', label: 'Mobile Money', hint: 'Approve the prompt on your phone', icon: Smartphone },
    { value: 'bank_transfer', label: 'Bank transfer', hint: 'Details sent after you place the order', icon: Landmark },
  ].filter(method => acceptedMethods.includes(method.value));

  return (
    <div className="page mx-auto max-w-5xl px-4">
      <h1 className="text-2xl font-bold">Checkout</h1>
      <p className="mt-1 mb-6 text-sm text-[#475569]">Delivery to your address</p>

      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div>
          {!user && (
            <div className="mb-5 rounded-xl border border-[#dbeaff] bg-[#eff5ff] p-4 text-sm text-[#2563eb]">
              <strong className="font-semibold">Want to save your details?</strong>{' '}
              <Link to="/register" className="underline">Create an account</Link> or{' '}
              <Link to="/login" className="underline">log in</Link>. You can also continue as a guest.
            </div>
          )}

          {error && (
            <div className="mb-5 rounded-lg border border-[#fecaca] bg-[#fee2e2] px-4 py-3 text-sm font-medium text-[#dc2626]">
              {error}
            </div>
          )}

          <form id="checkout-form" onSubmit={handleSubmit} className="flex flex-col gap-5">
            <section className="card">
              <h3 className="mb-4 text-[15px] font-semibold">Delivery details</h3>

              {!user && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="form-label">Full name</label>
                    <input type="text" name="guest_name" className="form-input" required value={formData.guest_name} onChange={handleChange} />
                  </div>
                  <div>
                    <label className="form-label">Email (for receipt)</label>
                    <input type="email" name="guest_email" className="form-input" required value={formData.guest_email} onChange={handleChange} />
                  </div>
                  <div>
                    <label className="form-label">Phone number</label>
                    <input type="tel" name="guest_phone" className="form-input" required value={formData.guest_phone} onChange={handleChange} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="form-label">Delivery address</label>
                    <textarea name="guest_address" className="form-textarea min-h-20" required value={formData.guest_address} onChange={handleChange} />
                  </div>
                </div>
              )}

              {user && (
                <div className="rounded-lg border border-[#e2e8f0] bg-[#f8fafc] p-4">
                  <p className="text-sm"><strong className="font-semibold">Deliver to:</strong> {user.name}</p>
                  <p className="mt-1 text-xs text-[#475569]">We'll contact you at {user.phone || user.email} on arrival.</p>
                </div>
              )}

              <div className={user ? 'mt-4' : 'mt-4'}>
                <label className="form-label">Notes for the kitchen or driver (optional)</label>
                <input type="text" name="delivery_notes" className="form-input" placeholder="e.g. Leave at front door" value={formData.delivery_notes} onChange={handleChange} />
              </div>
            </section>

            <section className="card">
              <h3 className="mb-4 text-[15px] font-semibold">Payment method</h3>
              <div className="flex flex-col gap-3">
                {paymentOptions.map(method => {
                  const Icon = method.icon;
                  const selected = formData.payment_method === method.value;
                  return (
                    <button
                      type="button"
                      key={method.value}
                      onClick={() => setFormData(prev => ({ ...prev, payment_method: method.value }))}
                      className={`flex items-center gap-3.5 rounded-lg border p-4 text-left transition-colors ${
                        selected ? 'border-[#dc2626] bg-[#fef2f2]' : 'border-[#e2e8f0] bg-white hover:border-[#cbd5e1]'
                      }`}
                    >
                      <span
                        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border ${
                          selected ? 'border-[5px] border-[#dc2626]' : 'border-[1.5px] border-[#cbd5e1]'
                        }`}
                      />
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
                        selected ? 'border-[#fecaca] bg-white text-[#dc2626]' : 'border-[#e2e8f0] bg-[#f8fafc] text-[#475569]'
                      }`}>
                        <Icon size={17} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{method.label}</span>
                        <span className="mt-0.5 block text-xs text-[#475569]">{method.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {formData.payment_method === 'mobile_money' && (
                <div className="mt-4">
                  <label className="form-label">MoMo phone number</label>
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
            </section>
          </form>
        </div>

        <aside className="card lg:sticky lg:top-20">
          <h3 className="mb-4 text-[15px] font-semibold">Order summary</h3>

          <div className="flex flex-col gap-3.5 border-b border-[#e2e8f0] pb-4">
            {items.map((item, index) => (
              <div key={index} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#0f172a] text-xs font-bold text-white">
                  {item.quantity}
                </span>
                <span className="min-w-0 flex-1 text-[13px]">
                  {item.menuItem.name}
                  {item.selectedAddOns.map(ao => (
                    <span key={ao.id} className="mt-0.5 block text-[11.5px] text-[#94a3b8]">+ {ao.quantity}× {ao.name}</span>
                  ))}
                </span>
                <span className="text-[13px] font-semibold">
                  ${((item.menuItem.price * item.quantity) + item.selectedAddOns.reduce((s, ao) => s + (ao.price * ao.quantity * item.quantity), 0)).toFixed(2)}
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-baseline justify-between py-4">
            <span className="text-sm font-semibold">Total</span>
            <span className="font-heading text-[22px] font-bold">${getTotal().toFixed(2)}</span>
          </div>

          <button
            type="submit"
            form="checkout-form"
            className="btn btn-primary btn-full"
            disabled={loading}
          >
            {loading ? 'Processing…' : <><ShoppingCart size={16} /> Place order</>}
          </button>
          <p className="mt-3 text-center text-[11.5px] leading-relaxed text-[#94a3b8]">
            You'll get a tracking link as soon as the kitchen confirms.
          </p>
        </aside>
      </div>
    </div>
  );
}