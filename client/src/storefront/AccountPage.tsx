// client/src/storefront/AccountPage.tsx — milestone 18, from project/CustomerAccount.dc.html.
//
// `/:store/account`. Who they are, what they have ordered, what went wrong, and where things go.
//
// THE BOARD'S FIVE SCREENS ARE NOT FIVE ROUTES. CustomerAccount draws checkout, placed, account, order and
// complain — and three of those already exist elsewhere in this app: checkout is `Shop`'s (milestone 17),
// placed is its success screen, and "order" is the tracking page, which shows the same order with a timeline
// besides. Building them again here would be two screens that show one order and eventually disagree about
// it. So this route is the ACCOUNT, the complaint form opens inside it, and "Order this again" and "Something
// wrong?" live on the tracking page where the order already is.
//
// COMPLAINT STATUSES ARE THE BOARD'S WORDS FOR V008'S STATES. V008 has open, escalated, resolved and
// rejected; the board shows "Sent to the store", "Resolved" and "Reopened". A reopened complaint IS open, so
// the label depends on `reopenedCount` — which is why V008 counts them rather than adding a fifth status.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, OrderStatusBadge, Skeleton, StateCard, TextField, Toast } from '../shared/ui/index.ts';
import { storefront, COMPLAINT_REASONS } from './api.ts';
import type { StatusTone } from '../shared/ui/index.ts';
import type { AccountPayload, CustomerComplaint, OrderSummary } from './api.ts';
import { useStore } from './StoreProvider.tsx';

/** V008's reason codes as the board writes them. */
const REASON_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  COMPLAINT_REASONS.map((reason) => [reason.code, reason.label]),
);

/**
 * The badge on a complaint.
 *
 * "Reopened" rather than "Sent to the store" once it has been round the loop, which is the difference V008's
 * `reopened_count` exists to record — the status is `open` either way, and a customer who has had to chase
 * something should not see the same label as somebody who has just reported it.
 */
export function complaintBadge(complaint: CustomerComplaint): { label: string; tone: StatusTone } {
  if (complaint.status === 'resolved') return { label: 'Resolved', tone: 'success' };
  if (complaint.status === 'rejected') return { label: 'Not accepted', tone: 'danger' };
  if (complaint.status === 'escalated') return { label: 'With Vendlyfy', tone: 'warn' };
  return complaint.reopenedCount > 0
    ? { label: 'Reopened', tone: 'warn' }
    : { label: 'Sent to the store', tone: 'info' };
}

/** The order badge, from the status. The customer's words, not the merchant's. */
export function orderBadge(order: OrderSummary): { label: string; tone: StatusTone } {
  switch (order.status) {
    case 'delivered':
    case 'collected':
      return { label: 'Delivered', tone: 'neutral' };
    case 'out':
      // Main's SIXTH status tone, which milestone 14 added for exactly this: its order badges use
      // #EDE9F6/#4B3A83 for "Out for delivery" and no other board uses it.
      return { label: 'On the way', tone: 'progress' };
    case 'rejected':
      return { label: 'Not accepted', tone: 'danger' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'danger' };
    case 'returned':
    case 'closed_return':
      return { label: 'Returned', tone: 'warn' };
    default:
      return { label: 'In progress', tone: 'info' };
  }
}

type Props = {
  onHome: () => void;
  onOpenOrder: (trackingCode: string) => void;
  onSignIn: () => void;
};

export function AccountPage({ onHome, onOpenOrder, onSignIn }: Props): ReactNode {
  const { face, money, t } = useStore();

  const [account, setAccount] = useState<AccountPayload | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [reload, setReload] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const [addingAddress, setAddingAddress] = useState(false);
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [addressError, setAddressError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    let live = true;
    void storefront
      .account(face.store.slug)
      .then((result) => {
        if (live) {
          setAccount(result);
          setError(null);
        }
      })
      .catch((failure: unknown) => {
        if (live && failure instanceof ApiFailure) setError(failure);
      });
    return () => {
      live = false;
    };
  }, [face.store.slug, reload]);

  const saveAddress = useCallback(async (): Promise<void> => {
    if (label.trim() === '' || address.trim().length < 4) return;
    setBusy(true);
    setAddressError(null);
    try {
      const result = await storefront.addAddress(face.store.slug, {
        label: label.trim(),
        address: address.trim(),
      });
      setAccount((current) => (current === null ? current : { ...current, addresses: result.addresses }));
      setLabel('');
      setAddress('');
      setAddingAddress(false);
      flash('Address saved.');
    } catch (failure) {
      if (failure instanceof ApiFailure) setAddressError(failure.message);
    } finally {
      setBusy(false);
    }
  }, [label, address, face.store.slug, flash]);

  const reopen = useCallback(
    async (complaintId: string): Promise<void> => {
      try {
        const result = await storefront.reopenComplaint(face.store.slug, complaintId);
        setAccount((current) => (current === null ? current : { ...current, complaints: result.complaints }));
        flash(`You reopened this. ${face.store.name} has been told.`);
      } catch (failure) {
        if (failure instanceof ApiFailure) flash(failure.message);
      }
    },
    [face.store.slug, face.store.name, flash],
  );

  // Not signed in is not an error: it is the state the sign-in sheet exists for.
  if (error !== null && (error.code === 'NOT_A_CUSTOMER' || error.status === 401)) {
    return (
      <div className="px-4 py-16">
        <StateCard
          tone="neutral"
          icon="◦"
          headline="Sign in to see your orders"
          body={`Your account at ${face.store.name} keeps your orders, your addresses and anything you have reported.`}
          action={{ label: 'Sign in', onSelect: onSignIn }}
          secondaryAction={{ label: `Back to ${face.store.name}`, onSelect: onHome }}
        />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="px-4 py-16">
        <StateCard
          tone={error.code === 'OFFLINE' ? 'warn' : 'danger'}
          icon={error.code === 'OFFLINE' ? '⚡' : '!'}
          headline={error.code === 'OFFLINE' ? 'You’re offline' : 'That didn’t load'}
          body={error.message}
          action={{ label: 'Retry now', onSelect: () => setReload((n) => n + 1) }}
        />
      </div>
    );
  }

  if (account === null) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-13 w-48" />
        <Skeleton className="h-20 w-full rounded-card" />
        <Skeleton className="h-20 w-full rounded-card" />
      </div>
    );
  }

  const initials = account.customer.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <div className="mx-auto flex min-h-dvh max-w-[760px] flex-col">
      <header className="flex h-15 shrink-0 items-center gap-1 border-b border-store-border bg-store-surface px-2">
        <button
          type="button"
          onClick={onHome}
          aria-label={`Back to ${face.store.name}`}
          className="flex size-11 items-center justify-center rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-title font-bold">Your account</h1>
      </header>

      <div className="flex grow flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-13 items-center justify-center rounded-pill bg-status-success font-bold text-status-success-fg"
          >
            {initials}
          </span>
          <span>
            <strong className="text-title">{account.customer.name}</strong>
            <br />
            <span className="text-caption text-store-muted">
              {account.customer.phone ?? account.customer.email} · customer since {monthOf(account.customer.since)}
            </span>
          </span>
        </div>

        <strong className="mt-1 text-body">Your orders</strong>
        {account.orders.length === 0 ? (
          <p className="text-body text-store-muted">
            Nothing yet. What you order at {face.store.name} shows up here.
          </p>
        ) : (
          account.orders.map((order) => {
            const badge = orderBadge(order);
            return (
              <button
                key={order.trackingCode}
                type="button"
                onClick={() => onOpenOrder(order.trackingCode)}
                className="flex flex-col gap-1 rounded-card border border-store-border bg-store-surface p-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-caption">#{order.orderNumber}</span>
                  <OrderStatusBadge label={badge.label} tone={badge.tone} />
                </span>
                <span className="text-body">{order.summary}</span>
                <span className="text-caption text-store-muted">
                  {dayOf(order.placedAt)} · {money(order.total)}
                </span>
              </button>
            );
          })
        )}

        <strong className="mt-1 text-body">Problems you reported</strong>
        {account.complaints.length === 0 ? (
          <p className="text-body text-store-muted">Nothing reported. Open an order to tell the store about it.</p>
        ) : (
          account.complaints.map((complaint) => {
            const badge = complaintBadge(complaint);
            return (
              <div
                key={complaint.id}
                className="flex flex-col gap-1.5 rounded-card border border-store-border bg-store-surface p-3.5"
              >
                <span className="flex items-center justify-between gap-2">
                  <strong className="text-body">
                    {REASON_LABELS[complaint.reasonCode] ?? complaint.reasonCode} · #{complaint.orderNumber}
                  </strong>
                  <OrderStatusBadge label={badge.label} tone={badge.tone} />
                </span>
                <span className="text-caption text-store-muted">{complaint.detail}</span>
                {complaint.storeReply === null ? null : (
                  <span className="text-caption">
                    <strong>{face.store.name}:</strong> “{complaint.storeReply}”
                  </span>
                )}
                {complaint.canReopen ? (
                  <span className="self-start">
                    <Button variant="secondary" onClick={() => void reopen(complaint.id)}>
                      Not sorted? Reopen
                    </Button>
                  </span>
                ) : null}
              </div>
            );
          })
        )}

        <strong className="mt-1 text-body">Saved addresses</strong>
        {account.addresses.map((saved) => (
          <div
            key={saved.id}
            className="flex items-start gap-2.5 rounded-card border border-store-border bg-store-surface p-3"
          >
            <span className="flex grow flex-col text-body">
              <strong>
                {saved.label}
                {saved.isDefault ? ' · default' : ''}
              </strong>
              <span className="text-store-muted">{saved.address}</span>
            </span>
            <span className="flex shrink-0 flex-col gap-1">
              {saved.isDefault ? null : (
                <Button
                  variant="text"
                  onClick={() => {
                    void storefront
                      .makeDefaultAddress(face.store.slug, saved.id)
                      .then((result) =>
                        setAccount((current) =>
                          current === null ? current : { ...current, addresses: result.addresses },
                        ),
                      )
                      .catch(() => flash('That didn’t save.'));
                  }}
                >
                  Use by default
                </Button>
              )}
              <Button
                variant="text"
                onClick={() => {
                  void storefront
                    .removeAddress(face.store.slug, saved.id)
                    .then((result) =>
                      setAccount((current) =>
                        current === null ? current : { ...current, addresses: result.addresses },
                      ),
                    )
                    .catch(() => flash('That didn’t save.'));
                }}
              >
                Remove
              </Button>
            </span>
          </div>
        ))}

        {addingAddress ? (
          <div className="flex flex-col gap-2 rounded-card border border-store-border bg-store-surface p-3.5">
            <TextField
              label="Name it"
              placeholder="Home"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <TextField
              label="Address"
              placeholder="Street, house number, landmark"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              {...(addressError === null ? {} : { error: addressError })}
            />
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => void saveAddress()} busy={busy} busyLabel="Saving…">
                Save address
              </Button>
              <Button variant="text" onClick={() => setAddingAddress(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setAddingAddress(true)}>
            + New address
          </Button>
        )}

        <Alert tone="info" headline={`This account is only for ${face.store.name}.`}>
          Other stores on Vendlyfy ask separately.
        </Alert>

        <Button variant="text" block onClick={onHome}>
          Back to the {t('catalog').toLowerCase()}
        </Button>
      </div>

      {toast === null ? null : (
        <div className="pointer-events-none fixed inset-x-4 bottom-8 z-20 flex justify-center">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

/** "March" — the board's own granularity for "customer since". */
function monthOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString('en-GB', { month: 'long' });
}

/** "Today 13:58" or "19 Sep", which is what the board shows beside an order. */
function dayOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const today = new Date();
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  if (sameDay) {
    return `Today ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  }
  return at.toLocaleString('en-GB', { day: 'numeric', month: 'short' });
}
