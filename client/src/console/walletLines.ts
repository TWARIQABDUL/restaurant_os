// client/src/console/walletLines.ts — milestone 23, from project/Wallet.dc.html.
//
// THE WORDS OF THE WALLET, with no React in them: what a ledger row says, which chip it wears and what the four
// steps under "How your money moves" read. Kept apart for the reason lines.ts is — the render gate can call
// these directly, and a rule that lives in JSX is only tested by whatever markup happens to be scraped.
//
// THE LEDGER IS NOT SHOWN AS IT IS STORED. wallet_ledger writes both sides of every internal movement (a sale
// that clears is `pending −X` and `available +X`), which is exactly right for an auditor and exactly wrong for a
// merchant, who sees one story: a sale, Pending, then Available. The server picks the four entry types a
// merchant reads (repositories/money.ts) and this file words them.

import type { ActivityRow, IdentityState, Payout, RefundRow, WithdrawalStatus } from './api.ts';

export type Chip = { label: string; className: string };

// The board's own S map, as the kit's status pairs.
const CHIP = {
  pending: { label: 'Pending', className: 'bg-status-warn text-status-warn-fg' },
  available: { label: 'Available', className: 'bg-status-success text-status-success-fg' },
  completed: { label: 'Completed', className: 'bg-status-success text-status-success-fg' },
  paidOut: { label: 'Paid out', className: 'bg-status-neutral text-status-neutral-fg' },
  processing: { label: 'Processing', className: 'bg-status-info text-status-info-fg' },
  failed: { label: 'Failed', className: 'bg-status-danger text-status-danger-fg' },
  rejected: { label: 'Rejected', className: 'bg-status-danger text-status-danger-fg' },
  requested: { label: 'Waiting for Vendlyfy', className: 'bg-status-info text-status-info-fg' },
  approved: { label: 'Approved', className: 'bg-status-success text-status-success-fg' },
  queued: { label: 'Approved · waiting for funds', className: 'bg-status-warn text-status-warn-fg' },
} as const satisfies Record<string, Chip>;

export const METHODS: Record<string, string> = {
  mtn_momo: 'MTN MoMo',
  airtel_money: 'Airtel Money',
  mpesa: 'M-Pesa',
  card: 'card',
  cash: 'cash',
};

export const methodName = (key: string): string => METHODS[key] ?? key;

/** Short names for the sale's second line, where the board says "Delivered 14:02 · MoMo". */
const PAID_BY: Record<string, string> = { mtn_momo: 'MoMo', airtel_money: 'Airtel Money', mpesa: 'M-Pesa', card: 'card' };

type Parts = { date: string; time: string };

function parts(at: Date, timeZone: string): Parts {
  const f = (opts: Intl.DateTimeFormatOptions, locale: string): string => {
    try {
      return new Intl.DateTimeFormat(locale, { ...opts, timeZone }).format(at);
    } catch {
      return new Intl.DateTimeFormat(locale, opts).format(at);
    }
  };
  return {
    date: f({ year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA'),
    time: f({ hour: '2-digit', minute: '2-digit', hour12: false }, 'en-GB'),
  };
}

/**
 * "Today 14:02", "Yesterday 21:10", "20 Sep 15:12" — the board's three shapes, in the STORE's zone. Unlike
 * lines.ts's relativeWhen() this always carries the clock time: a ledger is read for exactly when, and "3 h ago"
 * stops being true the moment the page is left open.
 */
export function stamp(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const p = parts(at, timeZone);
  if (p.date === parts(now, timeZone).date) return `Today ${p.time}`;
  if (p.date === parts(new Date(now.getTime() - 86_400_000), timeZone).date) return `Yesterday ${p.time}`;
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(at);
  return `${day} ${p.time}`;
}

/** Just the clock, "15:02" — for "Available at 15:02". */
export function clock(iso: string, timeZone: string): string {
  return parts(new Date(iso), timeZone).time;
}

export type ActivityLine = {
  what: string;
  sub: string;
  chip: Chip;
  /** '+15,500 RWF' / '−3,000 RWF' / '—' for a payout that came back. */
  amount: string;
  positive: boolean;
};

/**
 * One Activity row as the board words it. `money` is the console's formatter; amounts are decimal STRINGS and
 * the sign is read from the string, never from a float.
 */
export function activityLine(row: ActivityRow, timeZone: string, money: (v: string) => string): ActivityLine {
  const negative = row.amount.startsWith('-');
  const abs = negative ? row.amount.slice(1) : row.amount;
  const signed = `${negative ? '−' : '+'}${money(abs)}`;

  if (row.kind === 'sale') {
    const paid = row.method === null ? '' : (PAID_BY[row.method] ?? row.method);
    const pending = row.released === false;
    return {
      what: row.orderNumber === null ? 'Sale' : `Sale · #${row.orderNumber}`,
      sub: [paid === '' ? 'Paid online' : `Paid by ${paid}`, pending && row.availableAt !== null ? `Available at ${clock(row.availableAt, timeZone)}` : '']
        .filter((s) => s !== '')
        .join(' · '),
      chip: pending ? CHIP.pending : CHIP.available,
      amount: signed,
      positive: !negative,
    };
  }

  if (row.kind === 'refund') {
    const partial = row.refund?.partial === true;
    const ofTotal = row.refund === null ? '' : ` · ${money(abs)} of ${money(row.refund.orderTotal)}`;
    return {
      what: `Refund${row.orderNumber === null ? '' : ` · #${row.orderNumber}`}${partial ? ' (part)' : ''}`,
      // From the Pending pot means it never reached Available — the board's "Refunded before it cleared".
      sub: row.pot === 'pending' ? 'Refunded before it cleared · Never reached Available' : `Approved by Vendlyfy${ofTotal}`,
      chip: row.pot === 'pending' ? CHIP.pending : CHIP.available,
      amount: signed,
      positive: false,
    };
  }

  if (row.kind === 'withdrawal') {
    const w = row.withdrawal;
    const auto = w?.initiatedBy === 'automatic';
    const failed = w?.status === 'failed' || w?.status === 'rejected';
    return {
      what: auto ? 'Automatic payout' : 'Manual withdrawal',
      sub: w === null ? '' : `To MTN MoMo ${maskedFrom(w.phone)}${failed ? ' · Returned to Available' : ''}`,
      chip: w === null ? CHIP.processing : withdrawalChip(w.status),
      // A payout that came back moved nothing, which is what the board's "—" says.
      amount: failed ? '—' : signed,
      positive: false,
    };
  }

  return { what: 'Adjustment', sub: row.note ?? '', chip: CHIP.available, amount: signed, positive: !negative };
}

/** The ledger row carries the raw number; the board never prints one whole. Mirrors the server's maskPhone(). */
export function maskedFrom(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('250') && digits.length === 12 ? `0${digits.slice(3)}` : digits;
  return local.length < 7 ? '•••' : `${local.slice(0, 3)} ••• ${local.slice(-4)}`;
}

export function withdrawalChip(status: WithdrawalStatus): Chip {
  switch (status) {
    case 'completed':
      return CHIP.paidOut;
    case 'failed':
      return CHIP.failed;
    case 'rejected':
      return CHIP.rejected;
    case 'processing':
      return CHIP.processing;
    case 'pending':
      return CHIP.pending;
  }
}

/** The Withdrawals tab's chip: "Completed" there, "Paid out" in Activity — the board uses both words. */
export function payoutLine(p: Payout, timeZone: string): { kind: string; chip: Chip; note: string; canRetry: boolean } {
  const kind = p.initiatedBy === 'automatic' ? 'Automatic payout' : 'Manual withdrawal';
  switch (p.status) {
    case 'completed':
      return { kind, chip: CHIP.completed, note: p.completedAt === null ? 'Arrived' : `Arrived ${clock(p.completedAt, timeZone)}`, canRetry: false };
    case 'processing':
      return { kind, chip: CHIP.processing, note: 'MoMo is processing it', canRetry: false };
    case 'pending':
      return { kind, chip: CHIP.pending, note: 'Queued', canRetry: false };
    case 'failed':
      return { kind, chip: CHIP.failed, note: `${p.failureReason ?? 'MoMo could not complete the transfer.'} Money returned to Available.`, canRetry: true };
    case 'rejected':
      return { kind, chip: CHIP.rejected, note: `${p.failureReason ?? 'Held.'} Money returned to Available.`, canRetry: false };
  }
}

const REASONS: Record<string, string> = {
  item_missing: 'Item missing from the order',
  wrong_item: 'Wrong item',
  quality_problem: 'Quality problem',
  arrived_late: 'Arrived very late',
};

export function refundLine(r: RefundRow, timeZone: string, money: (v: string) => string): {
  reason: string;
  amount: string;
  chip: Chip;
  note: string;
} {
  const granted = r.approvedAmount ?? r.amount;
  const partial = Number(granted) < Number(r.orderTotal);
  const amount = `${money(granted)}${partial ? ` of ${money(r.orderTotal)}` : ' (full)'}`;
  const reason = r.reason === 'other' ? (r.note ?? 'Other') : (REASONS[r.reason] ?? r.reason);

  switch (r.status) {
    case 'pending':
      return { reason, amount, chip: CHIP.requested, note: 'Vendlyfy usually answers within a day.' };
    case 'approved':
      return {
        reason,
        amount,
        chip: CHIP.approved,
        note: r.settledAt === null ? 'Customer refunded.' : `Customer refunded. Deducted from Available at ${clock(r.settledAt, timeZone)}.`,
      };
    case 'queued':
      return {
        reason,
        amount,
        chip: CHIP.queued,
        // V008's own wording for why payouts stop.
        note: 'Paid as soon as your balance covers it. Payouts are paused until then.',
      };
    case 'rejected':
      return { reason, amount, chip: CHIP.rejected, note: r.rejectionReason === null ? 'Vendlyfy declined this refund.' : `Vendlyfy: ${r.rejectionReason}` };
  }
}

export type FlowStep = { n: string; title: string; body: string; tone: 'plain' | 'warn' | 'success' | 'danger' };

/** The four steps under "How your money moves". Step 4 is the one that changes with the mode and the lock. */
export function flowSteps(opts: { mode: 'manual' | 'automatic'; locked: boolean; automaticAt: string | null; holdMinutes: number }): FlowStep[] {
  const auto = opts.mode === 'automatic';
  const at = opts.automaticAt ?? '08:00';
  return [
    { n: '1', title: 'Customer pays', body: 'MoMo or card, at checkout.', tone: 'plain' },
    {
      n: '2',
      title: 'Pending',
      // THE BOARD SAYS "60 minutes after delivery"; the rule that runs is after PAYMENT (release_eligible_orders
      // reads paid_at). The screen says what happens, and the difference is recorded for the designer.
      body: `Held for ${opts.holdMinutes} minutes after payment, in case the order is returned or refunded.`,
      tone: 'warn',
    },
    { n: '3', title: 'Available', body: 'Yours to withdraw. Refunds you approve come out of here.', tone: 'success' },
    {
      n: '4',
      title: auto ? `Paid out at ${at}` : 'Paid out when you withdraw',
      body: opts.locked ? 'On hold until your identity is verified.' : auto ? 'Everything available goes to your MoMo each morning.' : 'Withdraw any amount, any time.',
      tone: opts.locked ? 'danger' : 'plain',
    },
  ];
}

export const FLOW_TONE: Record<FlowStep['tone'], string> = {
  plain: 'bg-ground',
  warn: 'bg-status-warn text-status-warn-fg',
  success: 'bg-status-success text-status-success-fg',
  danger: 'bg-status-danger text-status-danger-fg',
};

export type Lock = { title: string; body: string } | null;

/** The board's two lock banners. `rejected` and `redo_requested` read as not-started: both need the merchant to act. */
export function lockFor(identity: IdentityState): Lock {
  if (identity === 'verified') return null;
  return identity === 'in_review'
    ? {
        title: 'Payouts are on hold while we check your ID',
        body: 'Usually within 24 hours. Sales keep adding up here and nothing is lost. Automatic payouts start the morning after you’re verified.',
      }
    : {
        title: 'Verify your identity to get paid',
        body: 'You can sell and take payments now. To move money to your MoMo, we need a photo of your ID and a 5-second face video.',
      };
}

/** "Goes to MTN MoMo 078 ••• 4412 tomorrow at 08:00." — today if the time is still ahead of the store's clock. */
export function availableNote(opts: {
  locked: boolean;
  mode: 'manual' | 'automatic';
  methodKey: string;
  phoneMasked: string;
  automaticAt: string | null;
  storeNowHHMM: string;
}): string {
  if (opts.locked) return 'Yours, but held until you’re verified.';
  if (opts.mode === 'manual') return 'Stays here until you withdraw.';
  const at = opts.automaticAt ?? '08:00';
  const when = opts.storeNowHHMM < at ? 'today' : 'tomorrow';
  return `Goes to ${methodName(opts.methodKey)} ${opts.phoneMasked} ${when} at ${at}.`;
}

export function pendingNote(pendingOrders: number, next: { at: string; amount: string } | null, timeZone: string, money: (v: string) => string): string {
  if (pendingOrders === 0) return 'Nothing waiting. Sales appear here as soon as they are paid.';
  const from = `From ${pendingOrders} ${pendingOrders === 1 ? 'order' : 'orders'}.`;
  if (next === null) return from;
  return new Date(next.at).getTime() <= Date.now()
    ? `${from} ${money(next.amount)} is about to become available.`
    : `${from} Next ${money(next.amount)} becomes available at ${clock(next.at, timeZone)}.`;
}
