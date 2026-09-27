// client/src/storefront/CartPage.tsx — milestone 17, from `Shop`'s cart screen.
//
// `/:store/cart`. The lines, the promo field, the totals, and the one button out.
//
// EVERY EDIT IS A REQUEST, and the answer replaces the cart. No optimistic update, and that is deliberate on
// this screen: a quantity the browser shows and the server disagrees with is a total the customer is about to
// agree to. §2.5 makes the server authoritative, and a cart is the last place to make an exception.
//
// THE STEPPER DISABLES ITSELF WHILE A REQUEST IS IN FLIGHT rather than queueing taps. Three fast taps on + is
// otherwise three requests whose answers arrive in any order, and the last one to land wins — which is not
// necessarily the last one the customer made.
//
// THE PROMO FIELD KEEPS A CODE THAT DOES NOT APPLY YET. A code below its minimum becomes valid when another
// item goes in the bag, so clearing it on the first rejection would mean typing it again. Only a misspelling
// is cleared, because a misspelling never becomes valid — which is exactly what the board's two messages
// distinguish.

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Button, StateCard, TextField, Toast } from '../shared/ui/index.ts';
import { storefront } from './api.ts';
import type { PromoState } from './api.ts';
import { useStore } from './StoreProvider.tsx';
import { tileFor } from './tiles.ts';

/** The board's own sentence for each outcome V013 can report. */
const PROMO_REASONS: Readonly<Record<string, string>> = {
  applied: '',
  unknown_code: 'That code isn’t valid. Check the spelling or try another.',
  withdrawn: 'That code has been withdrawn.',
  not_started: 'That code isn’t active yet.',
  expired: 'That code has expired.',
  outside_hours: 'That code only applies at certain times.',
  already_applied: 'That code is already on this order.',
  below_minimum: 'Your items don’t reach the minimum for that code yet.',
  requirements_not_met: 'Your cart doesn’t have what that code needs.',
  limit_reached: 'That code has been used as many times as it can be.',
  nothing_to_discount: 'There’s nothing left for that code to take off.',
};

type Props = {
  onBack: () => void;
  onCheckout: () => void;
};

export function CartPage({ onBack, onCheckout }: Props): ReactNode {
  const { face, money, t, cart, setCart } = useStore();

  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [promo, setPromo] = useState<PromoState | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoBusy, setPromoBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2400);
  }, []);

  const edit = useCallback(
    async (lineId: string, action: 'quantity' | 'remove', quantity = 1): Promise<void> => {
      setBusyLine(lineId);
      try {
        const result =
          action === 'remove'
            ? await storefront.removeLine(face.store.slug, lineId)
            : await storefront.setQuantity(face.store.slug, lineId, quantity);
        setCart(result.cart);
      } catch (failure) {
        if (failure instanceof ApiFailure) flash(failure.message);
      } finally {
        setBusyLine(null);
      }
    },
    [face.store.slug, setCart, flash],
  );

  const applyCode = useCallback(async (): Promise<void> => {
    const typed = code.trim().toUpperCase();
    if (typed === '') return;
    setPromoBusy(true);
    setPromoError(null);
    try {
      const result = await storefront.setPromo(face.store.slug, typed);
      setCart(result.cart);
      setPromo(result.promo);
      if (result.promo !== null && !result.promo.applies) {
        setPromoError(PROMO_REASONS[result.promo.reason ?? ''] ?? 'That code doesn’t apply to this order.');
      }
    } catch (failure) {
      if (failure instanceof ApiFailure) {
        setPromoError(failure.message);
        // UNKNOWN_CODE is the one the server clears, so the field clears with it.
        if (failure.code === 'UNKNOWN_CODE') {
          setPromo(null);
          setCode('');
        }
      }
    } finally {
      setPromoBusy(false);
    }
  }, [code, face.store.slug, setCart]);

  const clearCode = useCallback(async (): Promise<void> => {
    setPromoBusy(true);
    try {
      const result = await storefront.setPromo(face.store.slug, null);
      setCart(result.cart);
      setPromo(null);
      setCode('');
      setPromoError(null);
    } catch {
      /* the field stays as it is; a second tap retries */
    } finally {
      setPromoBusy(false);
    }
  }, [face.store.slug, setCart]);

  const unavailable = cart.lines.filter((line) => line.unavailable);

  return (
    <div className="mx-auto flex min-h-dvh max-w-[760px] flex-col">
      <header className="flex h-15 shrink-0 items-center gap-1 border-b border-store-border bg-store-surface px-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={`Back to ${face.store.name}`}
          className="flex size-11 items-center justify-center rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 className="grow text-title font-bold">Your cart</h1>
        <span className="pr-3 text-body text-store-muted">
          {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'}
        </span>
      </header>

      {cart.itemCount === 0 ? (
        <div className="flex grow items-center justify-center p-8">
          <StateCard
            tone="neutral"
            icon="◦"
            headline="Your cart is empty"
            body="Add something you like and it will show up here."
            action={{ label: `Browse the ${t('catalog').toLowerCase()}`, onSelect: onBack }}
          />
        </div>
      ) : (
        <>
          <div className="flex grow flex-col gap-3 p-4">
            <section className="overflow-hidden rounded-card border border-store-border bg-store-surface">
              {cart.lines.map((line) => {
                const tile = tileFor(line.productId);
                const busy = busyLine === line.id;
                return (
                  <div key={line.id} className="flex gap-3 border-b border-line-subtle p-3.5 last:border-b-0">
                    <span
                      aria-hidden="true"
                      className="flex size-14 shrink-0 items-center justify-center rounded-control font-display text-title font-bold"
                      style={{ background: tile.background, color: tile.foreground }}
                    >
                      {line.productName.trim().charAt(0).toUpperCase()}
                    </span>

                    <div className="flex min-w-0 grow flex-col gap-0.5">
                      <div className="flex justify-between gap-2">
                        <span className="font-semibold">{line.productName}</span>
                        <span className="font-semibold">{money(line.lineTotal)}</span>
                      </div>
                      {line.optionLabels.length === 0 ? null : (
                        <span className="text-caption text-store-muted">{line.optionLabels.join(' · ')}</span>
                      )}
                      <span className="text-caption text-store-muted">{money(line.unitPrice)} each</span>
                      {line.unavailable ? (
                        <span className="text-caption font-semibold text-status-danger-fg">
                          Sold out while you were choosing
                        </span>
                      ) : null}

                      <div className="mt-1.5 flex items-center justify-between">
                        <div className="flex items-center rounded-control border border-store-border">
                          <button
                            type="button"
                            aria-label={`One less ${line.productName}`}
                            disabled={busy || line.quantity <= 1}
                            onClick={() => void edit(line.id, 'quantity', line.quantity - 1)}
                            className="flex h-10 w-11 items-center justify-center disabled:text-disabled focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
                          >
                            −
                          </button>
                          <span aria-live="polite" className="min-w-5 text-center font-bold">
                            {line.quantity}
                          </span>
                          <button
                            type="button"
                            aria-label={`One more ${line.productName}`}
                            disabled={busy || line.quantity >= 999}
                            onClick={() => void edit(line.id, 'quantity', line.quantity + 1)}
                            className="flex h-10 w-11 items-center justify-center disabled:text-disabled focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
                          >
                            +
                          </button>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void edit(line.id, 'remove')}
                          className="h-11 px-1 text-body font-semibold text-store-muted underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="rounded-card border border-store-border bg-store-surface p-3.5">
              <TextField
                label="Promo code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="e.g. WELCOME10"
                autoCapitalize="characters"
                {...(promoError === null ? {} : { error: promoError })}
              />
              <div className="mt-2 flex gap-2">
                <Button variant="secondary" onClick={() => void applyCode()} busy={promoBusy} busyLabel="Checking…">
                  Apply
                </Button>
                {promo === null ? null : (
                  <Button variant="text" onClick={() => void clearCode()}>
                    Remove code
                  </Button>
                )}
              </div>
              {promo !== null && promo.applies ? (
                <p className="mt-2 text-caption font-semibold text-status-success-fg">
                  {promo.code} applied · {money(promo.amount)} off your items
                </p>
              ) : null}
            </section>

            <section className="flex flex-col gap-2 rounded-card border border-store-border bg-store-surface p-3.5 text-body">
              <div className="flex justify-between">
                <span className="text-store-muted">Subtotal</span>
                <span>{money(cart.subtotal)}</span>
              </div>
              {/* Delivery is not on this screen's total, because the zone is chosen at checkout. The board
                  shows a Delivery line here because its mock has one fee; a store with two would be quoting
                  a number it cannot know yet. */}
              <p className="text-caption text-store-muted">
                Delivery is added at checkout, once you say where it is going.
              </p>
            </section>

            {unavailable.length === 0 ? null : (
              <p role="alert" className="text-body font-semibold text-status-danger-fg">
                Remove{' '}
                {unavailable.map((line) => line.productName).join(', ')} to carry on — it sold out while you
                were choosing.
              </p>
            )}
          </div>

          <div className="sticky bottom-0 shrink-0 border-t border-store-border bg-store-surface p-4">
            <Button
              variant="primary"
              block
              onClick={onCheckout}
              disabled={unavailable.length > 0 || cart.itemCount === 0}
            >
              Checkout · {money(cart.subtotal)}
            </Button>
          </div>
        </>
      )}

      {toast === null ? null : (
        <div className="pointer-events-none fixed inset-x-4 bottom-24 z-20 flex justify-center">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
