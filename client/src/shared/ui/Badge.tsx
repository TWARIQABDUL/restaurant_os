// client/src/shared/ui/Badge.tsx — milestone 14, from project/Main.dc.html.
//
// The board's rule, verbatim: "Order state is filled, payment state is outlined, so both read at a
// glance in the same row. Each carries a word, never color alone."
//
// So two components rather than one with a `filled` prop: the fill/outline distinction carries
// meaning, and a prop would let a caller put an order state in an outline and quietly break the
// thing that makes a row readable.

import type { ReactNode } from 'react';

/** The six tones tokens.css carries. `progress` is Main's "Out for delivery" purple. */
export type StatusTone = 'neutral' | 'info' | 'warn' | 'progress' | 'success' | 'danger';

const FILLED: Readonly<Record<StatusTone, string>> = {
  neutral: 'bg-status-neutral text-status-neutral-fg',
  info: 'bg-status-info text-status-info-fg',
  warn: 'bg-status-warn text-status-warn-fg',
  progress: 'bg-status-progress text-status-progress-fg',
  success: 'bg-status-success text-status-success-fg',
  danger: 'bg-status-danger text-status-danger-fg',
};

const OUTLINED: Readonly<Record<StatusTone, string>> = {
  neutral: 'border-control-line text-ink-2',
  info: 'border-status-info-fg text-status-info-fg',
  warn: 'border-status-warn-fg text-status-warn-fg',
  progress: 'border-status-progress-fg text-status-progress-fg',
  success: 'border-status-success-fg text-status-success-fg',
  danger: 'border-status-danger-fg text-status-danger-fg',
};

/**
 * Where an order is. FILLED.
 *
 * Takes a label rather than a status key, because the label is per-industry: the config engine's
 * `orderSteps` says food's first step is "New" and services' is "Booked", and both are the same
 * state. Mapping a step to a tone is the screen's job (milestone 20), not this component's.
 */
export function OrderStatusBadge({ label, tone }: { label: string; tone: StatusTone }): ReactNode {
  return (
    <span
      className={`inline-flex items-center rounded-pill px-[10px] py-[3px] text-caption font-bold ${FILLED[tone]}`}
    >
      {label}
    </span>
  );
}

/**
 * Whether money moved. OUTLINED, and the five are fixed — unlike order steps, payment states are
 * the platform's and mean the same thing everywhere.
 */
export type PaymentState = 'paid' | 'pending' | 'failed' | 'unpaid_cash' | 'refunded';

const PAYMENT: Readonly<Record<PaymentState, { label: string; mark: string; tone: StatusTone }>> = {
  paid: { label: 'Paid', mark: '●', tone: 'success' },
  pending: { label: 'Pending', mark: '◐', tone: 'warn' },
  failed: { label: 'Failed', mark: '✕', tone: 'danger' },
  unpaid_cash: { label: 'Unpaid · cash', mark: '○', tone: 'neutral' },
  refunded: { label: 'Refunded', mark: '↺', tone: 'info' },
};

export function PaymentStatusBadge({ state }: { state: PaymentState }): ReactNode {
  const { label, mark, tone } = PAYMENT[state];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-pill border px-[9px] py-[2px] text-caption font-bold ${OUTLINED[tone]}`}
    >
      <span aria-hidden="true">{mark}</span>
      {label}
    </span>
  );
}

/** A filter chip. Selected is ink-on-white, per the board's "All / Burgers / Sides" row. */
export function Chip({
  label,
  selected = false,
  onSelect,
}: {
  label: string;
  selected?: boolean;
  onSelect?: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`inline-flex h-9 items-center rounded-pill px-[14px] text-body font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
        selected ? 'bg-ink text-white' : 'bg-status-neutral text-ink'
      }`}
    >
      {label}
    </button>
  );
}

/** A small corner badge on a product card — a discount, "Sold out", an Rx flag. */
export function CardBadge({ label, tone = 'ink' }: { label: string; tone?: 'ink' | 'danger' | 'info' }): ReactNode {
  const style =
    tone === 'danger'
      ? 'bg-status-danger-fg text-white'
      : tone === 'info'
        ? 'bg-status-info-fg text-white'
        : 'bg-ink text-white';
  return (
    <span className={`absolute left-1.5 top-1.5 rounded-pill px-[7px] py-[2px] font-sans text-[11px] font-bold ${style}`}>
      {label}
    </span>
  );
}
