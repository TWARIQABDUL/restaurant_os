import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { ShoppingCart, Minus, Plus } from 'lucide-react';

export default function Cart() {
  const { items, removeItem, updateQuantity, getTotal, clearCart } = useCart();
  const navigate = useNavigate();
  const { tenantSlug } = useParams();

  if (items.length === 0) {
    return (
      <div className="page mx-auto max-w-2xl px-4 text-center">
        <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-[#fef2f2] text-[#dc2626]">
          <ShoppingCart size={32} />
        </div>
        <h3 className="text-[#0f172a]">Your cart is empty</h3>
        <p className="mt-2 mb-6 text-[#475569]">Looks like you haven't added anything to your cart yet.</p>
        <Link to={`/${tenantSlug}`} className="btn btn-primary btn-lg">Browse products</Link>
      </div>
    );
  }

  return (
    <div className="page mx-auto max-w-3xl px-4">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Your cart</h1>
        <button className="btn btn-secondary btn-sm" onClick={clearCart}>Clear cart</button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="overflow-hidden rounded-xl border border-[#e2e8f0] bg-white">
          {items.map((item, index) => {
            const itemBaseTotal = item.menuItem.price * item.quantity;
            const addOnsTotal = item.selectedAddOns.reduce((sum, ao) => sum + (ao.price * ao.quantity), 0) * item.quantity;
            const lineTotal = itemBaseTotal + addOnsTotal;

            return (
              <div
                key={index}
                className={`flex gap-4 p-5 ${index < items.length - 1 ? 'border-b border-[#e2e8f0]' : ''}`}
              >
                {item.menuItem.image_url ? (
                  <img
                    src={item.menuItem.image_url}
                    alt={item.menuItem.name}
                    className="h-20 w-20 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <div className="h-20 w-20 shrink-0 rounded-lg bg-[#eef2f6]" />
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-base font-semibold">{item.menuItem.name}</h3>
                    <div className="text-base font-semibold">${lineTotal.toFixed(2)}</div>
                  </div>
                  <div className="mt-0.5 text-sm text-[#94a3b8]">${parseFloat(item.menuItem.price).toFixed(2)} each</div>

                  {item.selectedAddOns.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs text-[#475569]">
                      {item.selectedAddOns.map(ao => (
                        <li key={ao.id}>
                          {ao.single_choice ? ao.name : `+ ${ao.quantity}× ${ao.name}`}
                          {parseFloat(ao.price) > 0 && ` (+$${(ao.price * ao.quantity).toFixed(2)})`}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-3 flex items-center gap-3">
                    <div className="flex items-center gap-3 rounded-lg border border-[#e2e8f0] px-2">
                      <button
                        onClick={() => updateQuantity(index, item.quantity - 1)}
                        className="icon-btn p-1.5 text-[#475569] hover:text-[#0f172a]"
                        aria-label="Decrease quantity"
                      >
                        <Minus size={14} />
                      </button>
                      <span className="min-w-[1rem] text-center text-sm font-semibold">{item.quantity}</span>
                      <button
                        onClick={() => updateQuantity(index, item.quantity + 1)}
                        className="icon-btn p-1.5 text-[#0f172a]"
                        aria-label="Increase quantity"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <button
                      onClick={() => removeItem(index)}
                      className="text-xs font-medium text-[#dc2626] hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <aside className="rounded-xl border border-[#e2e8f0] bg-white p-5 lg:sticky lg:top-20">
          <h3 className="text-base font-semibold">Summary</h3>
          <div className="mt-4 flex items-baseline justify-between border-t border-[#e2e8f0] pt-4">
            <span className="text-sm font-medium text-[#475569]">Total</span>
            <span className="font-heading text-2xl font-bold">${getTotal().toFixed(2)}</span>
          </div>
          <button
            className="btn btn-primary btn-full btn-lg mt-4"
            onClick={() => navigate(`/${tenantSlug}/checkout`)}
          >
            Proceed to checkout
          </button>
          <Link to={`/${tenantSlug}`} className="btn btn-secondary btn-full mt-2">
            Continue shopping
          </Link>
        </aside>
      </div>
    </div>
  );
}
