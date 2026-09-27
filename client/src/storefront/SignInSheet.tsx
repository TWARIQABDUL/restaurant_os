// client/src/storefront/SignInSheet.tsx — milestone 18, from CustomerAccount's SIGN IN sheet.
//
// "Sign in to Nyama & Co." / "Create an account at Nyama & Co.", with the promise underneath that is the
// whole reason this sheet exists rather than a redirect: "Your cart (3 items) stays exactly as it is."
//
// IT IS A SHEET AND NOT A PAGE because a redirect to /signin would lose the checkout screen's own state — the
// address half-typed, the payment method chosen, the idempotency key generated for this attempt. The board
// draws it as a sheet for the same reason.
//
// THE CART FOLLOWS, AND THE CLIENT ASKS FOR THAT EXPLICITLY. POST /api/session knows nothing about carts —
// it is the one endpoint every persona shares — so signing in is two calls: the session, then
// POST /cart/claim. V020's merge_cart_into_account() is what makes the second one safe to call twice.
//
// SIGNING IN USES THE PLATFORM'S OWN ENDPOINT, the same one merchant staff and the Vendlyfy team use. §5.4:
// the identifier is looked up across the platform and the PASSWORD decides which account it is. A customer of
// this store signing in here lands on their customer identity because that is the row their password matches.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure, api } from '../app/api.ts';
import { BottomSheet, Button, TextField } from '../shared/ui/index.ts';
import { storefront } from './api.ts';
import type { CartData } from './api.ts';
import { useStore } from './StoreProvider.tsx';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called once the session exists and the cart has been claimed. */
  onSignedIn: (cart: CartData | null) => void;
};

export function SignInSheet({ open, onClose, onSignedIn }: Props): ReactNode {
  const { face, cart } = useStore();

  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);

    const work =
      mode === 'register'
        ? storefront
            .register(face.store.slug, {
              name: name.trim(),
              email: identifier.trim(),
              password,
            })
            .then((result) => result.cart)
        : api
            .post<unknown>('/api/session', { identifier: identifier.trim(), password })
            // The session exists; now the cart. Two calls, because the session endpoint is shared by every
            // persona and a storefront concern inside it would run for merchant staff too.
            .then(() => storefront.claimCart(face.store.slug))
            .then((result) => result.cart);

    void work
      .then((merged) => {
        setPassword('');
        onSignedIn(merged);
      })
      .catch((failure: unknown) => {
        setError(
          failure instanceof ApiFailure
            ? failure.message
            : 'Something went wrong. Please try again.',
        );
      })
      .finally(() => setBusy(false));
  };

  const registering = mode === 'register';

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={registering ? `Create an account at ${face.store.name}` : `Sign in to ${face.store.name}`}
    >
      <div className="flex flex-col gap-3">
        <strong className="text-heading">
          {registering ? `Create an account at ${face.store.name}` : `Sign in to ${face.store.name}`}
        </strong>
        <span className="text-caption text-store-muted">
          Your cart ({cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'}) stays exactly as it is.
        </span>

        {registering ? (
          <TextField
            label="Name"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        ) : null}

        <TextField
          label={registering ? 'Email' : 'Phone or email'}
          autoComplete={registering ? 'email' : 'username'}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete={registering ? 'new-password' : 'current-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          {...(registering
            ? { hint: 'At least 8 characters, including a number, and not your phone or the store’s name.' }
            : {})}
        />

        {error === null ? null : (
          <p role="alert" className="text-body font-semibold text-status-danger-fg">
            {error}
          </p>
        )}

        <Button variant="primary" block onClick={submit} busy={busy} busyLabel="Just a moment…">
          {registering ? 'Create account' : 'Sign in'}
        </Button>

        <div className="flex justify-between text-body">
          <button
            type="button"
            onClick={() => {
              setMode(registering ? 'signin' : 'register');
              setError(null);
            }}
            className="font-semibold text-store-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {registering ? 'I have an account' : 'Create an account'}
          </button>
        </div>

        <Button variant="text" block onClick={onClose}>
          Continue as guest
        </Button>
      </div>
    </BottomSheet>
  );
}
