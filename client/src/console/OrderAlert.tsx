// client/src/console/OrderAlert.tsx — milestone 19, from project/Notifications.dc.html.
//
// "New order #1034 · 8,500 RWF" on ink, with Accept, Open in Orders and Silence, counting up from when the
// customer pressed Place order.
//
// IT IS DERIVED, NOT PUSHED, and the board's own sentence is the specification: "Shows on every signed-in screen
// at this store." So the server answers "the oldest order nobody has accepted", every screen asks, and every
// screen gets the same answer with no coordination at all — see server/src/routes/storeNotifications.ts. Which
// also means accepting it in Orders makes it disappear here, because it stops being pending.
//
// NOT A <dialog>. showModal() would trap focus and make the console inert every time an order arrived, which for
// somebody mid-sentence in a product description is hostile. role="alertdialog" with aria-live is the right
// reading: it announces itself and stays until dealt with, without seizing the screen.
//
// THE TIMER IS TWO CLOCKS AND THAT IS DELIBERATE. `waitingSeconds` comes from the order's placed_at on every
// poll, so a reload or a sleeping tablet shows the customer's real wait; between polls it ticks locally once a
// second so the number moves. The server is the truth and the local tick is only smoothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { orders as ordersApi } from './api.ts';
import type { OrderAlert as AlertData } from './api.ts';
import { waitingClock } from './lines.ts';
import { hrefFor } from './nav.ts';
import { useShell } from './ShellProvider.tsx';
import { playChime } from './chime.ts';

/** The board's own interval. Named so the number and the sentence it appears in cannot drift apart. */
const CHIME_EVERY_MS = 20_000;

type Props = {
  alert: AlertData;
  /** Off for this device. The alert still shows — the board says so in as many words. */
  sound: boolean;
  onSilence: () => void;
  onAccepted: (message: string) => void;
  navigate: (to: string) => void;
};

export function OrderAlert({ alert, sound, onSilence, onAccepted, navigate }: Props): ReactNode {
  const { store, money } = useShell();
  const [ticks, setTicks] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the local tick whenever the server's figure changes, so the two clocks never add up.
  useEffect(() => {
    setTicks(0);
  }, [alert.waitingSeconds, alert.orderId]);

  useEffect(() => {
    const interval = window.setInterval(() => setTicks((n) => n + 1), 1000);
    return () => window.clearInterval(interval);
  }, [alert.orderId]);

  // The chime: once on arrival, then every 20 seconds while this order is still waiting. Keyed to the order id
  // so a second order starts its own, and a re-render does not restart the first.
  const chimed = useRef<string | null>(null);
  useEffect(() => {
    if (!sound) return;
    if (chimed.current !== alert.orderId) {
      chimed.current = alert.orderId;
      playChime();
    }
    const interval = window.setInterval(playChime, CHIME_EVERY_MS);
    return () => window.clearInterval(interval);
  }, [sound, alert.orderId]);

  const ordersPath = hrefFor(store.slug, '/orders');

  const accept = useCallback(() => {
    setBusy(true);
    setError(null);
    ordersApi
      .accept(store.id, alert.orderId)
      .then((result) => {
        onAccepted(
          result.accepted
            ? `#${result.orderNumber} accepted · customer notified`
            : `#${result.orderNumber} was already accepted`,
        );
      })
      .catch((cause: unknown) => {
        // A 409 is somebody else deciding the other way, and its message and hint are written for a merchant —
        // so they are shown rather than replaced.
        setError(cause instanceof ApiFailure ? cause.message : 'That could not be accepted. Try again.');
      })
      .finally(() => setBusy(false));
  }, [store.id, alert.orderId, onAccepted]);

  const where =
    alert.fulfilment === 'delivery'
      ? alert.deliveryAddress === null
        ? 'delivery'
        : `delivery to ${alert.deliveryAddress}`
      : 'collecting themselves';
  const paid = alert.paymentStatus === 'paid' ? `paid by ${methodLabel(alert.paymentMethod)}` : 'cash on delivery';

  return (
    <div
      role="alertdialog"
      aria-label="New order"
      aria-live="assertive"
      className="fixed left-1/2 top-5 z-20 flex w-[min(520px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-3 rounded-sheet bg-ink p-5 text-white shadow-sheet lg:left-[calc(50%+124px)]"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-pill bg-brand motion-safe:animate-pulse">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
          </svg>
        </span>
        <span className="flex min-w-0 grow flex-col">
          <strong className="text-title">
            New order #{alert.orderNumber} · {money(alert.total)}
          </strong>
          <span className="truncate text-caption text-on-ink-muted">
            {alert.customer} · {where} · {paid}
          </span>
        </span>
        <span className="font-mono text-mono text-on-ink-timer">{waitingClock(alert.waitingSeconds + ticks)}</span>
      </div>

      <span className="text-caption text-on-ink-muted">
        {sound
          ? 'Chime repeats every 20 seconds until someone accepts or opens it. Shows on every signed-in screen at this store.'
          : 'Sound is off for this device. The alert still shows on screen.'}
      </span>

      {error === null ? null : <span className="text-caption text-on-ink-timer">{error}</span>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={accept}
          disabled={busy}
          className="h-12 flex-1 rounded-control bg-brand text-body font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-70"
        >
          {busy ? 'Accepting…' : 'Accept'}
        </button>
        <a
          href={ordersPath}
          onClick={(event) => {
            event.preventDefault();
            // Opening it counts as dealing with it: the board's chime stops "until someone accepts OR OPENS it".
            onSilence();
            navigate(ordersPath);
          }}
          className="flex h-12 flex-1 items-center justify-center rounded-control bg-ink-raised text-body font-bold text-white no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Open in Orders
        </a>
        <button
          type="button"
          onClick={onSilence}
          className="h-12 rounded-control bg-transparent px-3.5 font-semibold text-on-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Silence
        </button>
      </div>
    </div>
  );
}

/**
 * V005's payment methods in the words a merchant uses. Not the config engine's: these are the platform's
 * payment rails, the same everywhere, and none of them is renamed per industry.
 */
function methodLabel(method: string): string {
  switch (method) {
    case 'mtn_momo':
      return 'MoMo';
    case 'airtel_money':
      return 'Airtel Money';
    case 'card':
      return 'card';
    case 'cash':
      return 'cash';
    default:
      return method.replace(/_/g, ' ');
  }
}
