// client/src/storefront/CheckoutPage.tsx — milestone 17, from `Shop`'s checkout, pending, failed and
// success screens.
//
// `/:store/checkout`. Four screens in one route, because they are four states of one attempt to pay and the
// board draws them as a sequence with no way back into the middle of it.
//
// THE IDEMPOTENCY KEY IS GENERATED ONCE, WHEN THIS SCREEN OPENS, and reused for every attempt until an order
// comes back. That is the whole contract with place_order(): a fresh key on a retry is a second order. It is
// held in a ref rather than state because it must not change when React re-renders, and it is NOT stored
// anywhere — a key that outlived the screen would make the next order a retry of the last one.
//
// THE TOTAL IS SENT BACK TO THE SERVER. The quote produced it; place_order() refuses any other figure. So the
// customer can only be charged what this screen last showed them, and a price that moved underneath produces
// "the total changed" — which this screen answers by re-quoting and asking again, rather than by charging.
//
// PAYING IS A SECOND REQUEST. The order exists, unpaid, before any money is asked for — which is what makes
// the board's "Try again" on the failed screen a second PAYMENT rather than a second order.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, Segmented, Spinner, StateCard, TextField } from '../shared/ui/index.ts';
import { storefront } from './api.ts';
import type { PlacedOrder, Quote, SavedAddress } from './api.ts';
import { useStore } from './StoreProvider.tsx';
import { SignInSheet } from './SignInSheet.tsx';

/** How often the pending screen asks what happened. The board: "Waiting for approval. Keep this page open." */
const POLL_MS = 2500;

type Stage =
  | { kind: 'form' }
  | { kind: 'placing' }
  | { kind: 'pending'; order: PlacedOrder; phone: string }
  | { kind: 'failed'; order: PlacedOrder; reason: string | null }
  | { kind: 'success'; order: PlacedOrder };

type Props = {
  onBack: () => void;
  onHome: () => void;
  onTrack: (code: string) => void;
  /** Where a new account lands after the success screen's offer. */
  onAccount: () => void;
};

export function CheckoutPage({ onBack, onHome, onTrack, onAccount }: Props): ReactNode {
  const { face, money, has, cart, setCart, refreshCart } = useStore();

  const [fulfilment, setFulfilment] = useState<'delivery' | 'pickup'>(
    has('delivery') && face.delivery !== null ? 'delivery' : 'pickup',
  );
  const [zone, setZone] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [zones, setZones] = useState<Quote['zone'][]>([]);
  const [method, setMethod] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');

  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Milestone 18: signing in without leaving checkout, and the saved addresses that come with it.
  const [signingIn, setSigningIn] = useState(false);
  const [saved, setSaved] = useState<SavedAddress[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ONE KEY PER VISIT TO THIS SCREEN. See the header: this is the contract with place_order().
  const idempotencyKey = useRef(newIdempotencyKey());

  // The quote, whenever the fulfilment or the zone changes.
  useEffect(() => {
    let live = true;
    void storefront
      .checkout(face.store.slug, { fulfilment, zone })
      .then((result) => {
        if (!live) return;
        setQuote(result.quote);
        setZones(result.deliveryOptions);
        // Default to the cheapest area, which is the one the shopfront already quoted "from".
        if (zone === null && fulfilment === 'delivery' && result.deliveryOptions[0] !== undefined) {
          setZone(result.deliveryOptions[0].zoneId);
        }
        // Default to the first method that can actually take this total.
        setMethod((current) => {
          const usable = result.quote.paymentMethods.filter((m) => m.usableForTotal);
          if (current !== null && usable.some((m) => m.key === current)) return current;
          return usable[0]?.key ?? null;
        });
      })
      .catch((failure: unknown) => {
        if (!live) return;
        if (failure instanceof ApiFailure) setError(failure.message);
      });
    return () => {
      live = false;
    };
  }, [face.store.slug, fulfilment, zone, reload]);

  // The pending screen's poll. The server re-reads the real status from the provider on each call.
  useEffect(() => {
    if (stage.kind !== 'pending') return;
    const code = stage.order.trackingCode;
    let live = true;

    const timer = setInterval(() => {
      void storefront
        .paymentStatus(face.store.slug, code)
        .then((result) => {
          if (!live) return;
          if (result.payment?.status === 'successful' || result.order.paymentStatus === 'paid') {
            setStage({ kind: 'success', order: stage.order });
          } else if (result.payment?.status === 'failed') {
            setStage({ kind: 'failed', order: stage.order, reason: result.payment.message ?? null });
          }
        })
        .catch(() => {
          /* the poll keeps trying; a lost tick is not a failed payment */
        });
    }, POLL_MS);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [stage, face.store.slug]);

  /**
   * Load the account's saved details, if there is an account.
   *
   * FAILS SILENTLY BY DESIGN: most people at this screen are guests, and a 403 from the account endpoint is
   * the normal answer rather than a problem to report. What it changes when it succeeds is that the form
   * arrives filled in.
   */
  useEffect(() => {
    let live = true;
    void storefront
      .account(face.store.slug)
      .then((account) => {
        if (!live) return;
        setSaved(account.addresses);
        setName((current) => (current === '' ? account.customer.name : current));
        setPhone((current) => (current === '' ? (account.customer.phone ?? '') : current));
        setEmail((current) => (current === '' ? account.customer.email : current));
        const preferred = account.addresses.find((a) => a.isDefault) ?? account.addresses[0];
        if (preferred !== undefined) setAddress((current) => (current === '' ? preferred.address : current));
      })
      .catch(() => {
        // A guest. The form stays empty, which is what the board draws for them.
        if (live) setSaved(null);
      });
    return () => {
      live = false;
    };
  }, [face.store.slug, reload]);

  const place = useCallback(async (): Promise<void> => {
    if (quote === null || method === null) return;
    setError(null);
    setStage({ kind: 'placing' });

    try {
      const result = await storefront.placeOrder(face.store.slug, {
        idempotencyKey: idempotencyKey.current,
        fulfilment,
        paymentMethod: method,
        expectedTotal: quote.total,
        ...(name.trim() === '' ? {} : { name: name.trim() }),
        ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
        ...(email.trim() === '' ? {} : { email: email.trim() }),
        ...(fulfilment === 'delivery' ? { address: address.trim() } : {}),
        ...(fulfilment === 'delivery' && zone !== null ? { zone } : {}),
      });

      refreshCart();

      if (!result.needsPayment) {
        // Cash: the order is placed and the rider collects. Nothing to wait for.
        setStage({ kind: 'success', order: result.order });
        return;
      }

      const payment = await storefront.startPayment(face.store.slug, result.order.trackingCode, phone.trim());
      if (payment.alreadyPaid === true || payment.payment.status === 'successful') {
        setStage({ kind: 'success', order: result.order });
      } else {
        setStage({ kind: 'pending', order: result.order, phone: phone.trim() });
      }
    } catch (failure) {
      if (!(failure instanceof ApiFailure)) {
        setError('Something went wrong. Please try again.');
        setStage({ kind: 'form' });
        return;
      }

      // The total moved, or the catalogue did. Re-quote and let them look before they agree again — which is
      // what place_order() refused the order for.
      if (failure.code === 'STALE_CATALOGUE') {
        setReload((n) => n + 1);
        refreshCart();
      }
      setError(failure.message);
      setStage({ kind: 'form' });
    }
  }, [quote, method, face.store.slug, fulfilment, name, phone, email, address, zone, refreshCart]);

  const retryPayment = useCallback(
    async (order: PlacedOrder): Promise<void> => {
      setError(null);
      setStage({ kind: 'placing' });
      try {
        const payment = await storefront.startPayment(face.store.slug, order.trackingCode, phone.trim());
        if (payment.alreadyPaid === true || payment.payment.status === 'successful') {
          setStage({ kind: 'success', order });
        } else {
          setStage({ kind: 'pending', order, phone: phone.trim() });
        }
      } catch (failure) {
        setStage({
          kind: 'failed',
          order,
          reason: failure instanceof ApiFailure ? failure.message : null,
        });
      }
    },
    [face.store.slug, phone],
  );

  // ---------------------------------------------------------------------------
  if (stage.kind === 'pending') {
    return <PendingScreen amount={money(stage.order.total)} phone={stage.phone} />;
  }

  if (stage.kind === 'success') {
    return (
      <SuccessScreen
        order={stage.order}
        storeName={face.store.name}
        slug={face.store.slug}
        money={money}
        guest={saved === null}
        phone={phone.trim()}
        onTrack={() => onTrack(stage.order.trackingCode)}
        onHome={onHome}
        onAccount={onAccount}
      />
    );
  }

  if (stage.kind === 'failed') {
    return (
      <FailedScreen
        reason={stage.reason}
        onRetry={() => void retryPayment(stage.order)}
        onChangeMethod={() => setStage({ kind: 'form' })}
      />
    );
  }

  // ---------------------------------------------------------------------------
  const placing = stage.kind === 'placing';
  const canPay = quote !== null && method !== null && quote.unavailable.length === 0;
  const cashDue = method === 'cash' ? quote?.cashDue ?? null : null;
  const payLabel =
    quote === null
      ? 'Checkout'
      : method === 'cash'
        ? `Place order · ${money(cashDue ?? quote.total)}`
        : `Pay ${money(quote.total)}`;

  return (
    <div className="mx-auto flex min-h-dvh max-w-[760px] flex-col">
      <header className="flex h-15 shrink-0 items-center gap-1 border-b border-store-border bg-store-surface px-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to cart"
          className="flex size-11 items-center justify-center rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-title font-bold">Checkout</h1>
      </header>

      {cart.itemCount === 0 && quote === null ? (
        <div className="flex grow items-center justify-center p-8">
          <StateCard
            tone="neutral"
            icon="◦"
            headline="Your cart is empty"
            body="Add something you like and it will show up here."
            action={{ label: 'Back to the shop', onSelect: onHome }}
          />
        </div>
      ) : (
        <>
          <div className="flex grow flex-col gap-3 p-4">
            {notice === null ? null : (
              <div role="status" className="rounded-control bg-status-success px-3 py-2.5 text-caption text-status-success-fg">
                {notice}
              </div>
            )}
            <section className="flex flex-col gap-3 rounded-card border border-store-border bg-store-surface p-4">
              <div className="flex items-center justify-between gap-2.5">
                <h2 className="text-title">Your details</h2>
                {saved === null ? (
                  <button
                    type="button"
                    onClick={() => setSigningIn(true)}
                    className="flex min-h-8 items-center text-body font-semibold text-store-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    Ordered before? Sign in
                  </button>
                ) : null}
              </div>
              <TextField
                label="Full name"
                autoComplete="name"
                placeholder="Your name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <TextField
                label="Phone number"
                type="tel"
                autoComplete="tel"
                placeholder="078 123 4567"
                hint="We text your receipt and delivery updates here."
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
              <TextField
                label="Email (optional)"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </section>

            <section className="flex flex-col gap-3 rounded-card border border-store-border bg-store-surface p-4">
              <h2 className="text-title">Delivery or pickup</h2>
              <Segmented
                label="How you want it"
                options={[
                  ...(has('delivery') && face.delivery !== null
                    ? [{ value: 'delivery', label: 'Delivery' }]
                    : []),
                  ...(has('pickup') && face.pickup !== null ? [{ value: 'pickup', label: 'Pickup' }] : []),
                ]}
                value={fulfilment}
                onChange={(value) => setFulfilment(value === 'pickup' ? 'pickup' : 'delivery')}
              />

              {fulfilment === 'delivery' ? (
                <>
                  {/* "Deliver to" — the board's radio list, shown only to somebody who has saved one. */}
                  {saved === null || saved.length === 0 ? null : (
                    <div role="radiogroup" aria-label="Deliver to" className="flex flex-col gap-2">
                      {saved.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          role="radio"
                          aria-checked={address === option.address}
                          onClick={() => setAddress(option.address)}
                          className={`flex flex-col items-start rounded-control border p-3 text-left text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                            address === option.address
                              ? 'border-2 border-store-primary bg-store-tint'
                              : 'border-control-line'
                          }`}
                        >
                          <strong>{option.label}</strong>
                          <span className="text-store-muted">{option.address}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <TextField
                    label="Delivery address"
                    autoComplete="street-address"
                    placeholder="Street, house number, landmark"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                  />
                  {zones.length <= 1 ? null : (
                    <label className="flex flex-col gap-1.5 text-caption font-semibold">
                      Which area?
                      <select
                        value={zone ?? ''}
                        onChange={(event) => setZone(event.target.value)}
                        className="h-12 rounded-control border border-control-line bg-store-surface px-3 text-body text-store-text"
                      >
                        {zones.map((option) =>
                          option === null ? null : (
                            <option key={option.zoneId} value={option.zoneId}>
                              {option.name} · {money(option.fee)}
                              {option.areas.length === 0 ? '' : ` · ${option.areas.join(', ')}`}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  )}
                  {quote?.zone == null ? null : (
                    <p className="text-caption text-store-muted">
                      {quote.zone.etaMinMinutes}–{quote.zone.etaMaxMinutes} min · {money(quote.zone.fee)}
                    </p>
                  )}
                </>
              ) : face.pickup === null ? null : (
                <p className="rounded-control bg-store-bg p-3 text-body">
                  Pick up at {face.pickup.address}.{' '}
                  {face.pickup.readyMinutes >= 1440
                    ? 'Ready from tomorrow.'
                    : `Ready in about ${face.pickup.readyMinutes} minutes.`}
                  {face.pickup.instructions === null ? '' : ` ${face.pickup.instructions}`}
                </p>
              )}
            </section>

            <section className="flex flex-col gap-2 rounded-card border border-store-border bg-store-surface p-4">
              <h2 className="text-title">Payment</h2>
              <div role="radiogroup" aria-label="How you want to pay" className="flex flex-col gap-2">
                {(quote?.paymentMethods ?? []).map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="radio"
                    aria-checked={method === option.key}
                    aria-disabled={!option.usableForTotal}
                    disabled={!option.usableForTotal}
                    onClick={() => setMethod(option.key)}
                    className={`flex min-h-15 items-center gap-3 rounded-control border px-3.5 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                      method === option.key
                        ? 'border-2 border-store-primary bg-store-tint'
                        : 'border-control-line'
                    } ${option.usableForTotal ? '' : 'opacity-60'}`}
                  >
                    <span className="flex grow flex-col">
                      <span className="font-semibold">{option.label}</span>
                      <span className="text-caption text-store-muted">
                        {option.usableForTotal
                          ? option.hint
                          : `Takes between ${money(option.minAmount ?? '0')} and ${money(option.maxAmount ?? '0')}`}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              {(quote?.paymentMethods ?? []).length === 0 ? (
                <p className="text-body text-store-muted">
                  {face.store.name} has not connected a way to be paid yet.
                </p>
              ) : null}
            </section>

            {quote === null ? null : (
              <section className="flex flex-col gap-2 rounded-card border border-store-border bg-store-surface p-4 text-body">
                <h2 className="text-title">Order summary</h2>
                {cart.lines.map((line) => (
                  <div key={line.id} className="flex justify-between gap-2">
                    <span>
                      {line.quantity} × {line.productName}
                    </span>
                    <span>{money(line.lineTotal)}</span>
                  </div>
                ))}
                <div className="my-1 h-px bg-store-border" />
                <div className="flex justify-between">
                  <span className="text-store-muted">Subtotal</span>
                  <span>{money(quote.subtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-store-muted">{fulfilment === 'delivery' ? 'Delivery' : 'Pickup'}</span>
                  <span>{fulfilment === 'delivery' ? money(quote.deliveryFee) : 'Free'}</span>
                </div>
                {quote.discount === '0' || quote.discount === '0.00' ? null : (
                  <div className="flex justify-between text-status-success-fg">
                    <span>Discount</span>
                    <span>−{money(quote.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-title font-bold">
                  <span>Total</span>
                  <span>{money(quote.total)}</span>
                </div>
                {/* The board's AdminCurrencies rule, made visible to the person it affects: the rider carries
                    no small change, so a cash total is rounded and that is the figure they hand over. */}
                {cashDue === null || cashDue === quote.total ? null : (
                  <div className="flex justify-between font-semibold">
                    <span>Cash due on delivery</span>
                    <span>{money(cashDue)}</span>
                  </div>
                )}
              </section>
            )}

            {quote !== null && quote.unavailable.length > 0 ? (
              <Alert tone="danger" headline="Something in your cart sold out.">
                Remove {quote.unavailable.map((line) => line.productName).join(', ')} and try again.
              </Alert>
            ) : null}

            {error === null ? null : (
              <Alert tone="danger" headline={error}>
                Check the total and try again.
              </Alert>
            )}
          </div>

          <div className="sticky bottom-0 flex shrink-0 flex-col gap-2 border-t border-store-border bg-store-surface p-4">
              <span className="flex items-center justify-center gap-1.5 text-caption text-store-muted">
              Secure payment · SMS receipt after you pay
            </span>
            <Button
              variant="primary"
              block
              busy={placing}
              busyLabel="Placing your order…"
              disabled={!canPay}
              onClick={() => void place()}
            >
              {payLabel}
            </Button>
          </div>
        </>
      )}

      <SignInSheet
        open={signingIn}
        onClose={() => setSigningIn(false)}
        onSignedIn={(merged) => {
          setSigningIn(false);
          if (merged !== null) setCart(merged);
          // Re-read the account so the form fills in, and re-quote — a discount can depend on WHO is buying,
          // because V013 counts max_redemptions_per_customer per account.
          setReload((n) => n + 1);
          setNotice('Signed in. Your cart is exactly as it was.');
        }}
      />
    </div>
  );
}

/** `Shop`'s pending screen. The board: "Waiting for approval. Keep this page open." */
function PendingScreen({ amount, phone }: { amount: string; phone: string }): ReactNode {
  const masked = phone.replace(/\d(?=\d{4})/g, '•');
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-store-surface p-8 text-center">
      <Spinner />
      <h1 className="font-display text-heading">Approve on your phone</h1>
      <p className="max-w-[300px] text-body text-store-muted">
        We sent a mobile money request to {masked}. Enter your PIN to approve.
      </p>
      <div className="flex flex-col gap-0.5 rounded-card bg-store-bg px-6 py-3.5">
        <span className="text-caption text-store-muted">Amount</span>
        <span className="text-heading font-bold">{amount}</span>
      </div>
      <p role="status" className="text-caption text-store-muted">
        Waiting for approval. Keep this page open.
      </p>
    </div>
  );
}

/**
 * `Shop`'s success screen, plus CustomerAccount's offer to a guest.
 *
 * "Save your details for next time? Add a password and this order, your address and phone are saved to an
 * account at Nyama & Co." — which is a real conversion rather than a sign-up form: V020's claim_guest_order()
 * MOVES the order onto the new account, because `orders_has_a_customer` allows a customer or a guest and never
 * both.
 *
 * THE TRACKING CODE IS WHAT PROVES THE OFFER IS THEIRS. A guest has no session, so the only thing
 * distinguishing them from a stranger is the code they were just given — which is why the endpoint requires it
 * rather than an order id.
 */
function SuccessScreen({
  order,
  storeName,
  slug,
  money,
  guest,
  phone,
  onTrack,
  onHome,
  onAccount,
}: {
  order: PlacedOrder;
  storeName: string;
  slug: string;
  money: (amount: string) => string;
  /** True when nobody is signed in — the only case the offer is shown. */
  guest: boolean;
  phone: string;
  onTrack: () => void;
  onHome: () => void;
  onAccount: () => void;
}): ReactNode {
  const cash = order.paymentMethod === 'cash';

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The board's own bar for the button: at least 8 characters. The server holds all three rules and will say
  // which one failed; this only stops the obviously-too-short from being a round trip.
  const ready = name.trim().length >= 2 && email.trim() !== '' && password.length >= 8;

  const create = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setFailed(null);
    void storefront
      .claimOrder(slug, {
        trackingCode: order.trackingCode,
        name: name.trim(),
        email: email.trim(),
        password,
        ...(phone === '' ? {} : { phone }),
      })
      .then(() => {
        setPassword('');
        setSaved(true);
      })
      .catch((error: unknown) => {
        setFailed(error instanceof ApiFailure ? error.message : 'Something went wrong. Please try again.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex min-h-dvh flex-col bg-store-surface p-6">
      <div className="flex grow flex-col items-center justify-center gap-3.5 text-center">
        <span
          aria-hidden="true"
          className="flex size-18 items-center justify-center rounded-pill bg-store-primary text-heading text-store-on-primary"
        >
          ✓
        </span>
        <h1 role="status" className="font-display text-heading">
          {cash ? 'Order confirmed' : 'Payment successful'}
        </h1>
        <span className="rounded-chip bg-store-bg px-2.5 py-1 font-mono text-body">
          Order #{order.orderNumber}
        </span>
        <p className="max-w-[300px] text-body text-store-muted">
          {storeName} has your order. We’ve sent the details by SMS.
        </p>
        <div className="flex w-full flex-col gap-2 rounded-card border border-store-border p-4 text-left text-body">
          <div className="flex justify-between">
            <span className="text-store-muted">Payment</span>
            <span>{cash ? 'Cash on delivery' : 'Mobile money'}</span>
          </div>
          <div className="flex justify-between font-bold">
            <span>Total</span>
            <span>{money(order.total)}</span>
          </div>
          {order.cashDue === null || order.cashDue === order.total ? null : (
            <div className="flex justify-between font-semibold">
              <span>Cash due</span>
              <span>{money(order.cashDue)}</span>
            </div>
          )}
        </div>

        {/* The offer. Only to a guest, and only once. */}
        {!guest ? null : saved ? (
          <Alert tone="success" headline="Account created.">
            Order #{order.orderNumber} is saved to it.
          </Alert>
        ) : (
          <div className="flex w-full flex-col gap-2.5 rounded-card border border-store-border p-4 text-left">
            <strong>Save your details for next time?</strong>
            <span className="text-body text-store-muted">
              Add a password and this order, your address and phone are saved to an account at {storeName}.
            </span>
            <TextField
              label="Name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <TextField
              label="Choose a password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              {...(failed === null ? {} : { error: failed })}
            />
            <Button variant="primary" block onClick={create} disabled={!ready} busy={busy} busyLabel="Saving…">
              Create my account
            </Button>
            <span className="text-caption text-store-muted">
              This account is only for {storeName}. Other stores on Vendlyfy ask separately.
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2.5">
        <Button variant="primary" block onClick={onTrack}>
          Track order
        </Button>
        {saved ? (
          <Button variant="secondary" block onClick={onAccount}>
            See my orders
          </Button>
        ) : null}
        <Button variant="text" block onClick={onHome}>
          Back to store
        </Button>
      </div>
    </div>
  );
}

function FailedScreen({
  reason,
  onRetry,
  onChangeMethod,
}: {
  reason: string | null;
  onRetry: () => void;
  onChangeMethod: () => void;
}): ReactNode {
  return (
    <div className="flex min-h-dvh flex-col bg-store-surface p-6">
      <div className="flex grow flex-col items-center justify-center gap-3.5 text-center">
        <span
          aria-hidden="true"
          className="flex size-18 items-center justify-center rounded-pill bg-status-danger text-heading text-status-danger-fg"
        >
          ✕
        </span>
        <h1 role="alert" className="font-display text-heading">
          Payment didn’t go through
        </h1>
        <p className="max-w-[300px] text-body text-store-muted">
          {reason ?? 'The request expired before it was approved.'} No money was taken, and your order is
          waiting.
        </p>
      </div>
      <div className="flex flex-col gap-2.5">
        <Button variant="primary" block onClick={onRetry}>
          Try again
        </Button>
        <Button variant="secondary" block onClick={onChangeMethod}>
          Use another payment method
        </Button>
      </div>
    </div>
  );
}

/**
 * A key for one checkout attempt.
 *
 * crypto.randomUUID() where it exists, which is every browser this ships to, and a random fallback otherwise
 * — because a key that failed to generate would silently become a duplicate, and place_order() would treat
 * the next order as a retry of the last one.
 */
function newIdempotencyKey(): string {
  try {
    return `co-${crypto.randomUUID()}`;
  } catch {
    return `co-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
}
