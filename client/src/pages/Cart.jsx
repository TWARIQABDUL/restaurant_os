import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCart } from '../context/CartContext';

export default function Cart() {
  const { items, removeItem, updateQuantity, getTotal, clearCart } = useCart();
  const navigate = useNavigate();
  const { tenantSlug } = useParams();

  if (items.length === 0) {
    return (
      <div className="page empty-state">
        <div style={{
          width: '80px', height: '80px', borderRadius: '50%',
          background: 'var(--color-accent-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto var(--space-4)', fontSize: '32px'
        }}>🛒</div>
        <h3>Your cart is empty</h3>
        <p className="mb-6">Looks like you haven't added anything to your cart yet.</p>
        <Link to={`/${tenantSlug}`} className="btn btn-primary btn-lg btn-pill">Browse Menu</Link>
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: '800px', margin: '0 auto' }}>
      <div className="flex justify-between items-center mb-8">
        <h1>Your Cart</h1>
        <button className="btn btn-secondary btn-sm" onClick={clearCart}>
          Clear Cart
        </button>
      </div>

      <div className="card mb-8" style={{ padding: 0 }}>
        {items.map((item, index) => {
          const itemBaseTotal = item.menuItem.price * item.quantity;
          const addOnsTotal = item.selectedAddOns.reduce((sum, ao) => sum + (ao.price * ao.quantity), 0) * item.quantity;
          const lineTotal = itemBaseTotal + addOnsTotal;

          return (
            <div key={index} style={{ padding: '24px', borderBottom: index < items.length - 1 ? '1px solid var(--color-border)' : 'none' }}>
              <div className="flex justify-between items-start mb-4">
                <div className="flex gap-4">
                  {item.menuItem.image_url ? (
                    <img 
                      src={item.menuItem.image_url} 
                      alt={item.menuItem.name} 
                      style={{ width: '80px', height: '80px', objectFit: 'cover', borderRadius: 'var(--radius-md)' }} 
                    />
                  ) : (
                    <div style={{ width: '80px', height: '80px', background: 'var(--color-bg-alt)', borderRadius: 'var(--radius-md)' }} />
                  )}
                  
                  <div>
                    <h3 style={{ fontSize: 'var(--font-size-lg)' }}>{item.menuItem.name}</h3>
                    <div className="text-secondary text-sm mb-2">${parseFloat(item.menuItem.price).toFixed(2)}</div>
                    
                    {item.selectedAddOns.length > 0 && (
                      <div className="text-sm text-secondary">
                        <div style={{ fontWeight: 500, marginBottom: '2px' }}>Add-ons:</div>
                        <ul style={{ paddingLeft: '16px', margin: 0 }}>
                          {item.selectedAddOns.map(ao => (
                            <li key={ao.id}>
                              {ao.quantity}x {ao.name} (+${(ao.price * ao.quantity).toFixed(2)})
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>

                <div className="text-right">
                  <div style={{ fontWeight: 600, fontSize: 'var(--font-size-lg)', marginBottom: '12px' }}>
                    ${lineTotal.toFixed(2)}
                  </div>
                  
                  <div className="flex items-center gap-2 bg-white rounded-md border" style={{ padding: '2px' }}>
                    <button 
                      className="btn btn-secondary btn-sm" 
                      onClick={() => updateQuantity(index, item.quantity - 1)}
                      style={{ border: 'none', padding: '2px 8px' }}
                    >
                      -
                    </button>
                    <span style={{ width: '20px', textAlign: 'center', fontWeight: 500 }}>{item.quantity}</span>
                    <button 
                      className="btn btn-secondary btn-sm" 
                      onClick={() => updateQuantity(index, item.quantity + 1)}
                      style={{ border: 'none', padding: '2px 8px' }}
                    >
                      +
                    </button>
                  </div>
                  
                  <button 
                    onClick={() => removeItem(index)}
                    style={{ background: 'none', border: 'none', color: 'var(--color-error)', fontSize: 'var(--font-size-xs)', marginTop: '8px', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{
        background: 'var(--gradient-dark)',
        color: 'var(--color-text-inverse)',
        border: 'none'
      }}>
        <div className="flex justify-between items-center mb-6">
          <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 500, opacity: 0.8 }}>Total</span>
          <span style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 800 }}>
            ${getTotal().toFixed(2)}
          </span>
        </div>

        <button
          className="btn btn-lg btn-full btn-pill"
          onClick={() => navigate(`/${tenantSlug}/checkout`)}
          style={{
            background: 'var(--gradient-accent)', color: 'white',
            border: 'none', fontWeight: 700, marginBottom: 'var(--space-3)'
          }}
        >
          Proceed to Checkout
        </button>
        <Link
          to={`/${tenantSlug}`}
          className="btn btn-full btn-pill"
          style={{
            display: 'block', textAlign: 'center',
            background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)',
            border: '1px solid rgba(255,255,255,0.15)'
          }}
        >
          Continue Shopping
        </Link>
      </div>
    </div>
  );
}
