// client/src/storefront/TrackPage.tsx — milestone 17, from `Shop`'s tracking screen.
//
// `/:store/orders/:code`. Where an order is, and when it is coming.
//
// THE TIMELINE'S LABELS COME FROM THE CONFIG ENGINE, and this is the screen that proves `Industries`' claim
// about order steps. V002 puts them on the industry template — "the key is what code and history refer to
// while the label is per-industry wording — Services calls its first step 'Booked' where Food calls it
// 'New'" — so this renders `config.orderSteps` and matches them against the order's own status. A label
// written here would be a second vocabulary, and a food shop and a clinic would eventually disagree with
// their own dashboards.
//
// THE STEPS ARE NOT THE STATUSES. V004 has twelve statuses and a template lists five or six steps; several
// statuses map to one step, and the ones a customer never needs to see (approved, assigned) do not appear at
// all. `stepIndexFor` is that mapping, and it is the one piece of this file that had to be decided rather
// than read — see the note on it.
//
// IT IS OPENABLE COLD, from an SMS link, by somebody who has never had a session: the 32-character code is
// the credential. So this screen fetches everything it needs from the code alone and never assumes a cart, a
// session or a previous screen.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Button, Skeleton, StateCard, Toast } from '../shared/ui/index.ts';
import { ComplaintSheet } from './ComplaintSheet.tsx';
import { storefront } from './api.ts';
import type { CustomerOrder, PaymentState } from './api.ts';
import { useStore } from './StoreProvider.tsx';

/** How often an order in flight is re-read. Slower than the payment poll: a kitchen moves in minutes. */
const POLL_MS = 20_000;

/**
 * How far along the template's own steps a status is.
 *
 * THIS IS AN ANSWER TO ONE OF PART 9'S OPEN QUESTIONS, not a transcription: "template `order_steps` →
 * `orders.status` mapping". It is answered BY POSITION rather than by key, and the templates are why. Food's
 * steps are new → preparing → ready → delivered; fashion's are new → packed → out_for_delivery → delivered.
 * The keys differ, the POSITIONS mean the same thing, and a template a merchant writes next year will have
 * keys nobody here can predict. So:
 *
 *   pending, approved       → 0. The order exists. A customer does not need to know a merchant pressed
 *                                Accept; they need to know it was received.
 *   preparing               → 1. Being made, packed, dispensed — whatever this industry calls it.
 *   ready, assigned, out    → 2. Out of the shop's hands, or waiting to be collected.
 *   delivered, collected    → 3. Arrived.
 *   rejected, cancelled,
 *   returned, closed_return → null. No step: the timeline is replaced by what happened.
 *
 * FOUR POSITIONS, because every shipped template has four steps. A template with five would map its extra
 * step to nothing until this list grew, which is a limit worth stating out loud rather than hiding behind
 * arithmetic on the array's length.
 */
export function stepIndexFor(status: string): number | null {
  switch (status) {
    case 'pending':
    case 'approved':
      return 0;
    case 'preparing':
      return 1;
    case 'ready':
    case 'assigned':
    case 'out':
      return 2;
    case 'delivered':
    case 'collected':
      return 3;
    default:
      return null;
  }
}

/** The statuses that end an order without it arriving. The board has no timeline for these. */
export function isStopped(status: string): boolean {
  return ['rejected', 'cancelled', 'returned', 'closed_return'].includes(status);
}

/**
 * The timeline a CUSTOMER sees: the template's steps, with "Payment confirmed" inserted.
 *
 * A template's `order_steps` is the MERCHANT's list — what they move an order through. The customer's
 * timeline in `Shop` has one more entry, "Payment confirmed", which is not a state a merchant advances: it is
 * `payment_status`. So it is inserted where the board draws it, second, and only for an order that is paid
 * online — a cash order's money arrives at the door, so a step for it before then would sit unticked through
 * the whole journey and read as something going wrong.
 *
 * Exported for the render gate, which checks it against both industries' real step lists.
 */
export function customerSteps(
  orderSteps: readonly { key: string; label: string }[],
  payOnline: boolean,
): { key: string; label: string; fromStatus: number | null; isPayment: boolean }[] {
  const steps = orderSteps.map((step, index) => ({
    key: step.key,
    label: step.label,
    fromStatus: index,
    isPayment: false,
  }));

  if (!payOnline || steps.length === 0) return steps;

  return [
    steps[0] as (typeof steps)[number],
    { key: 'payment_confirmed', label: 'Payment confirmed', fromStatus: null, isPayment: true },
    ...steps.slice(1),
  ];
}

type Props = {
  code: string;
  onHome: () => void;
  /** After reordering, so the shopper lands on the cart they just filled. */
  onOpenCart?: () => void;
};

export function TrackPage({ code, onHome, onOpenCart }: Props): ReactNode {
  const { face, money, orderSteps, currency } = useStore();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [payment, setPayment] = useState<PaymentState | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [reload, setReload] = useState(0);
  // "Order this again" and "Something wrong? Tell the store" — CustomerAccount's ORDER screen, which is this
  // screen with two more buttons rather than a second page showing the same order.
  const [busy, setBusy] = useState(false);
  const [complaining, setComplaining] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await storefront.order(face.store.slug, code);
      setOrder(result.order);
      setPayment(result.payment);
      setError(null);
    } catch (failure) {
      if (failure instanceof ApiFailure) setError(failure);
    }
  }, [face.store.slug, code]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  // Kept fresh while the order is still moving. An order that has arrived does not need polling, and one
  // that was cancelled will not move again.
  useEffect(() => {
    if (order === null) return;
    if (isStopped(order.status) || order.status === 'delivered' || order.status === 'collected') return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [order, load]);

  const reorder = useCallback((): void => {
    setBusy(true);
    void storefront
      .reorder(face.store.slug, code)
      .then((result) => {
        // The board's own two sentences, and which one depends on whether anything was left behind:
        // "Added 2 items from #0951 to your cart at today's prices." / "Added 1 of 2 items. Fries are sold
        // out today."
        const total = result.added + result.skipped;
        flash(
          result.skipped === 0
            ? `Added ${result.added} ${result.added === 1 ? 'item' : 'items'} to your cart at today’s prices.`
            : `Added ${result.added} of ${total} items. ${result.skippedNames.join(', ')} ${
                result.skippedNames.length === 1 ? 'is' : 'are'
              } sold out today.`,
        );
        if (result.added > 0 && onOpenCart !== undefined) setTimeout(onOpenCart, 1200);
      })
      .catch((failure: unknown) => {
        if (failure instanceof ApiFailure) flash(failure.message);
      })
      .finally(() => setBusy(false));
  }, [face.store.slug, code, flash, onOpenCart]);

  if (error !== null) {
    return (
      <div className="px-4 py-16">
        <StateCard
          tone={error.code === 'OFFLINE' ? 'warn' : 'neutral'}
          icon={error.code === 'OFFLINE' ? '⚡' : '?'}
          headline={error.code === 'OFFLINE' ? 'You’re offline' : 'No order with that reference'}
          body={
            error.code === 'OFFLINE'
              ? error.message
              : 'Check the link you were sent, or ask the store to look it up by your phone number.'
          }
          action={{ label: 'Retry now', onSelect: () => setReload((n) => n + 1) }}
          secondaryAction={{ label: `Back to ${face.store.name}`, onSelect: onHome }}
        />
      </div>
    );
  }

  if (order === null) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-48 w-full rounded-card" />
        <Skeleton className="h-24 w-full rounded-card" />
      </div>
    );
  }

  // The template's own words. A fashion store's third step is "Out for delivery"; a restaurant's is "Ready".
  const steps = customerSteps(orderSteps, order.paymentMethod !== 'cash');
  const current = stepIndexFor(order.status);
  const paid = order.paymentStatus === 'paid';
  const stopped = isStopped(order.status);

  const eta =
    order.fulfilment === 'pickup'
      ? order.pickup === null
        ? 'Ready soon'
        : order.pickup.readyMinutes >= 1440
          ? 'Ready from tomorrow'
          : `Ready in about ${order.pickup.readyMinutes} minutes`
      : order.delivery === null
        ? 'On its way'
        : `Arriving in about ${order.delivery.etaMaxMinutes} minutes`;

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
        <h1 className="text-title font-bold">
          Order <span className="font-mono">#{order.orderNumber}</span>
        </h1>
      </header>

      <div className="flex grow flex-col gap-3 p-4">
        <section className="rounded-card border border-store-border bg-store-surface p-5">
          <span className="text-caption text-store-muted">{order.store.name}</span>

          {stopped ? (
            <h2 className="mt-0.5 font-display text-heading leading-tight">
              {order.status === 'rejected'
                ? 'The store couldn’t take this order'
                : order.status === 'cancelled'
                  ? 'This order was cancelled'
                  : 'This order came back'}
            </h2>
          ) : (
            <h2 className="mt-0.5 mb-5 font-display text-heading leading-tight">{eta}</h2>
          )}

          {stopped ? null : (
            <ol className="m-0 list-none p-0">
              {steps.map((step, index) => {
                // The payment step is the payment's, not the status's — and for cash it stays open until the
                // rider is handed the money.
                const done = step.isPayment
                  ? paid
                  : current !== null && step.fromStatus !== null && step.fromStatus < current;
                const here = step.isPayment
                  ? !paid && current !== null && current === 0
                  : current !== null && step.fromStatus === current;
                const at =
                  step.isPayment
                    ? order.paidAt
                    : (order.events.find((event) => stepIndexFor(event.status) === step.fromStatus)?.at ??
                       null);

                return (
                  <li key={step.key} className="flex gap-3.5">
                    <div className="flex w-5.5 flex-col items-center">
                      <span
                        aria-hidden="true"
                        className={`flex size-5.5 shrink-0 items-center justify-center rounded-pill text-[11px] ${
                          done
                            ? 'bg-store-primary text-store-on-primary'
                            : here
                              ? 'border-[5px] border-store-primary bg-store-surface'
                              : 'border-2 border-control-line bg-store-surface'
                        }`}
                      >
                        {done ? '✓' : ''}
                      </span>
                      {index === steps.length - 1 ? null : (
                        <span
                          className={`min-h-6 w-0.5 grow ${done ? 'bg-store-primary' : 'bg-store-border'}`}
                        />
                      )}
                    </div>
                    <div className="flex grow justify-between pb-4.5 text-body">
                      <span className={here ? 'font-bold' : done ? '' : 'text-store-muted'}>{step.label}</span>
                      <span className="text-caption text-store-muted">
                        {at === null ? '' : timeOf(at)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="flex gap-3 rounded-card border border-store-border bg-store-surface p-4 text-body">
          <div className="flex flex-col gap-0.5">
            <strong>{order.fulfilment === 'delivery' ? 'Delivering to' : 'Pick up at'}</strong>
            <span className="text-store-muted">
              {order.fulfilment === 'delivery'
                ? (order.deliveryAddress ?? 'The address you gave at checkout')
                : (order.pickup?.address ?? order.store.name)}
            </span>
          </div>
        </section>

        <section className="flex flex-col gap-2 rounded-card border border-store-border bg-store-surface p-4 text-body">
          {order.lines.map((line) => (
            <div key={line.id} className="flex justify-between gap-2">
              <span>
                {line.quantity} × {line.productName}
                {line.variantLabel === '' ? '' : ` · ${line.variantLabel}`}
                {line.optionLabels.length === 0 ? '' : ` · ${line.optionLabels.join(', ')}`}
              </span>
              <span>{money(line.lineTotal)}</span>
            </div>
          ))}
          <div className="my-1 h-px bg-store-border" />
          <div className="flex justify-between">
            <span className="text-store-muted">Subtotal</span>
            <span>{money(order.subtotal)}</span>
          </div>
          {order.deliveryFee === '0.00' ? null : (
            <div className="flex justify-between">
              <span className="text-store-muted">Delivery</span>
              <span>{money(order.deliveryFee)}</span>
            </div>
          )}
          {order.discount === '0.00' ? null : (
            <div className="flex justify-between text-status-success-fg">
              <span>Discount</span>
              <span>−{money(order.discount)}</span>
            </div>
          )}
          <div className="flex justify-between text-title font-bold">
            <span>Total</span>
            <span>{money(order.total)}</span>
          </div>
          {order.cashDue === null || order.cashDue === order.total ? null : (
            // AdminCurrencies' rule, shown to the person who has to hand over the notes.
            <div className="flex justify-between font-semibold">
              <span>Cash due{paid ? '' : ' on delivery'}</span>
              <span>{money(order.cashDue)}</span>
            </div>
          )}
          <span className="text-caption text-store-muted">
            {order.paymentMethod === 'cash'
              ? paid
                ? 'Paid in cash'
                : `Pay the rider ${money(order.cashDue ?? order.total)} when it arrives`
              : paid
                ? 'Paid by mobile money'
                : (payment?.status === 'pending' ? 'Waiting for your approval' : 'Not paid yet')}
          </span>
        </section>

        {order.store.phone === null ? null : (
          <a
            href={`tel:${order.store.phone.replace(/[^+0-9]/g, '')}`}
            className="flex h-13 items-center justify-center rounded-card border border-control-line bg-store-surface font-semibold text-store-text no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Call the store
          </a>
        )}

        {/* CustomerAccount's ORDER screen: the same order, with the two things a customer does next. */}
        <Button variant="primary" block onClick={reorder} busy={busy} busyLabel="Adding…">
          Order this again
        </Button>
        <Button variant="secondary" block onClick={() => setComplaining(true)}>
          Something wrong? Tell the store
        </Button>

        <Button variant="text" block onClick={onHome}>
          Back to {face.store.name}
        </Button>
        <span className="sr-only">Prices in {currency.code}.</span>
      </div>

      <ComplaintSheet
        open={complaining}
        onClose={() => setComplaining(false)}
        orderNumber={order.orderNumber}
        trackingCode={order.trackingCode}
        onFiled={() => {
          setComplaining(false);
          flash(`Sent to ${face.store.name}. You’ll get an SMS when they reply.`);
        }}
      />

      {toast === null ? null : (
        <div className="pointer-events-none fixed inset-x-4 bottom-8 z-20 flex justify-center">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

/** "12:04" in the reader's own zone. */
function timeOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
