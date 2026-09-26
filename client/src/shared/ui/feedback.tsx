// client/src/shared/ui/feedback.tsx — milestone 14, from project/Main.dc.html.
//
// Alert, Toast and the skeletons. Two rules from the boards:
//
//   States.dc.html: "Errors appear next to the thing that caused them, not in a banner."
//   Main.dc.html:   "Skeletons match the final layout; no spinners for lists."
//
// So `Alert` is for a condition about the page — delivery unavailable, payment failed — and a field
// error belongs to the field (see fields.tsx). Neither is a floating banner.

import type { ReactNode } from 'react';

export type AlertTone = 'warn' | 'danger' | 'info' | 'success';

const ALERT: Readonly<Record<AlertTone, { box: string; mark: string }>> = {
  warn: { box: 'bg-status-warn text-status-warn-fg', mark: '!' },
  danger: { box: 'bg-status-danger text-status-danger-fg', mark: '✕' },
  info: { box: 'bg-status-info text-status-info-fg', mark: 'i' },
  success: { box: 'bg-status-success text-status-success-fg', mark: '✓' },
};

/**
 * `headline` is the sentence that says what happened; `children` says what to do next. The board
 * always writes them that way round — "Payment didn't go through. You weren't charged." — and a
 * money alert always says whether the customer was charged.
 */
export function Alert({
  tone,
  headline,
  children,
}: {
  tone: AlertTone;
  headline: string;
  children?: ReactNode;
}): ReactNode {
  const { box, mark } = ALERT[tone];
  return (
    // assertive for danger: the customer is mid-payment and needs to hear it now.
    <div role="alert" aria-live={tone === 'danger' ? 'assertive' : 'polite'} className={`flex gap-2.5 rounded-control p-3 text-body ${box}`}>
      <strong aria-hidden="true" className="shrink-0">
        {mark}
      </strong>
      <span>
        <strong>{headline}</strong>
        {children === undefined ? null : <> {children}</>}
      </span>
    </div>
  );
}

/**
 * The dark pill with an action. The board's is "Added Chicken burger · Undo", and the undo is the
 * reason it exists — a toast with nothing to do on it is a notification, not a toast.
 */
export function Toast({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}): ReactNode {
  return (
    <div role="status" className="inline-flex items-center gap-3 rounded-card bg-ink px-3.5 py-2.5 text-body text-white shadow-sheet">
      <span>{message}</span>
      {actionLabel === undefined ? null : (
        <button
          type="button"
          onClick={onAction}
          className="font-bold text-[#BFE3CD] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/** One shimmering block. Sized by the caller so it matches what is arriving. */
export function Skeleton({ className = 'h-3 w-full' }: { className?: string }): ReactNode {
  return <span aria-hidden="true" className={`block animate-pulse rounded-chip bg-status-neutral ${className}`} />;
}

/**
 * A skeleton shaped like a list row: thumbnail, long line, short line.
 *
 * The boards are explicit that skeletons appear only after 300 ms, "so fast loads don't flicker" —
 * that delay belongs to whatever is fetching, not here, so this renders immediately when asked.
 */
export function SkeletonRow(): ReactNode {
  return (
    <div className="flex items-center gap-2.5">
      <Skeleton className="size-8 rounded-chip" />
      <span className="flex grow flex-col gap-1.5">
        <Skeleton className="h-2.5 w-4/5" />
        <Skeleton className="h-2.5 w-1/2" />
      </span>
    </div>
  );
}

/** A skeleton shaped like a product card, for the storefront grid. */
export function SkeletonCard(): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-[70px] rounded-control" />
      <Skeleton className="h-2.5 w-4/5" />
      <Skeleton className="h-2.5 w-[45%]" />
    </div>
  );
}
