// client/src/storefront/CartViews.tsx — milestone 16.
//
// The two places the cart appears while BROWSING: the sticky bar `Shop` puts at the bottom of the phone,
// and the aside `StoreDesktop` puts to the right of the grid.
//
// THE CART SCREEN IS MILESTONE 17'S, and this is deliberately not it. Editing a quantity, removing a line,
// the coupon field and checkout all belong to `Shop`'s cart screen, which arrives with checkout. What is
// here is the two summaries drawn ON THE BROWSE BOARDS — without them, this milestone's own boards have a
// cart badge that counts nothing and an empty column where the aside is.
//
// THE TOTALS ARE THE SERVER'S. Every amount is a string the server computed from the product and the
// options, because V003 stores no price on a cart line: "Prices are re-checked at checkout; any change is
// shown before paying. A price copied into the cart would be a second source of truth that goes stale
// silently." The same argument applies to a total computed in the browser.

import type { ReactNode } from 'react';
import { Button } from '../shared/ui/index.ts';
import { useStore } from './StoreProvider.tsx';
import { tileFor } from './tiles.ts';

/** The desktop aside. */
export function CartSummary({ onCheckout }: { onCheckout: () => void }): ReactNode {
  const { cart, money, face, has } = useStore();

  if (cart.itemCount === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-card border border-store-border bg-store-surface p-5">
        <h2 className="text-title font-bold">Your cart</h2>
        <p className="text-body text-store-muted">
          Nothing in it yet. Add something and it will appear here.
        </p>
      </div>
    );
  }

  const unavailable = cart.lines.filter((line) => line.unavailable);

  return (
    <div className="flex flex-col gap-3 rounded-card border border-store-border bg-store-surface p-5">
      <h2 className="text-title font-bold">Your cart</h2>

      <div className="flex flex-col gap-3">
        {cart.lines.map((line) => {
          const tile = tileFor(line.productId);
          return (
            <div key={line.id} className="flex gap-3">
              <span
                aria-hidden="true"
                className="size-12 shrink-0 rounded-control"
                style={{ background: tile.background }}
              />
              <span className="flex min-w-0 grow flex-col">
                <span className="truncate font-semibold">{line.productName}</span>
                {line.optionLabels.length === 0 ? null : (
                  <span className="truncate text-caption text-store-muted">
                    {line.optionLabels.join(' · ')}
                  </span>
                )}
                {line.unavailable ? (
                  <span className="text-caption font-semibold text-status-danger-fg">
                    Sold out while you were choosing
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 flex-col items-end">
                <span className="font-semibold">{money(line.lineTotal)}</span>
                <span className="text-caption text-store-muted">× {line.quantity}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="h-px bg-store-border" />

      <div className="flex justify-between">
        <span className="text-store-muted">Subtotal</span>
        <span>{money(cart.subtotal)}</span>
      </div>
      {has('delivery') && face.delivery !== null ? (
        <div className="flex justify-between">
          <span className="text-store-muted">Delivery</span>
          {/* "from", because the zone is not known until an address is given at checkout. */}
          <span className="text-store-muted">from {money(face.delivery.fromFee)}</span>
        </div>
      ) : null}

      <Button variant="primary" block onClick={onCheckout} disabled={unavailable.length > 0}>
        {unavailable.length > 0 ? 'Remove sold-out items to continue' : 'Checkout'}
      </Button>

      <span className="text-center text-caption text-store-muted">
        The total is confirmed before you pay.
      </span>
    </div>
  );
}

/** The mobile sticky bar. Absent when the cart is empty, which is what the board draws. */
export function StickyCartBar({ onOpen }: { onOpen: () => void }): ReactNode {
  const { cart, money } = useStore();
  if (cart.itemCount === 0) return null;

  return (
    <div className="fixed inset-x-4 bottom-5 z-20 lg:hidden">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-14 w-full items-center justify-between rounded-card bg-store-primary px-5 text-title font-semibold text-store-on-primary shadow-sheet focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <span>
          View cart · {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'}
        </span>
        <span>{money(cart.subtotal)}</span>
      </button>
    </div>
  );
}
