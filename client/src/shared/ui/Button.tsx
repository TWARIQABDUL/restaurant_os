// client/src/shared/ui/Button.tsx — milestone 14, from project/Main.dc.html.
//
// Six variants, one component. The board's own note: "One primary per view. Disabled buttons say
// what's missing."
//
// `primary` and `text` use the PER-STORE colour (`bg-store-primary`, `text-store-primary`), so the
// same button reads as the store's own in a storefront and as the platform's in the admin console —
// tokens.css's platform default is what renders where there is no store. `danger` does NOT: §2.2
// makes status colours unthemeable, and "Cancel order" means the same thing in every store.

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'danger';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  variant?: ButtonVariant;
  /**
   * Arrived at milestone 20, the same accommodation `Switch` and `Radio` got at 19 and 20: the merchant
   * console's own primary actions (Accept, Mark ready, Confirm cash…) are not the storefront, so `primary`
   * and `text` must not tint with whichever store happens to be open. Defaults to `'store'`, so a storefront
   * button — the only place `primary`/`text` were used before this milestone — is unchanged.
   */
  tone?: 'store' | 'brand';
  /** Renders a spinner and sets aria-busy. The label is replaced by `busyLabel`. */
  busy?: boolean;
  busyLabel?: string;
  /** Fills its container — the board uses this for the action at the foot of a state card. */
  block?: boolean;
  children: ReactNode;
};

const VARIANT: Readonly<Record<ButtonVariant, Readonly<Record<'store' | 'brand', string>>>> = {
  primary: { store: 'bg-store-primary text-store-on-primary', brand: 'bg-brand text-white' },
  secondary: { store: 'bg-surface text-ink border border-control-line', brand: 'bg-surface text-ink border border-control-line' },
  text: { store: 'bg-transparent text-store-primary', brand: 'bg-transparent text-brand' },
  danger: { store: 'bg-status-danger-fg text-white', brand: 'bg-status-danger-fg text-white' },
};

// 44px is the board's control height throughout, and the minimum comfortable tap target.
const BASE =
  'inline-flex h-11 items-center justify-center gap-2 rounded-control px-[18px] ' +
  'text-body font-semibold transition-opacity ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ' +
  'disabled:cursor-not-allowed disabled:border-0 disabled:bg-line disabled:text-muted';

export function Button({
  variant = 'primary',
  tone = 'store',
  busy = false,
  busyLabel = 'Working…',
  block = false,
  disabled,
  children,
  ...rest
}: Props): ReactNode {
  return (
    <button
      type="button"
      {...rest}
      // A busy button is not disabled — that would move focus and lose the screen reader's place.
      // aria-busy says what is happening and the click is ignored below.
      aria-busy={busy || undefined}
      disabled={disabled === true}
      onClick={busy ? undefined : rest.onClick}
      className={`${BASE} ${VARIANT[variant][tone]} ${variant === 'text' ? 'px-[14px]' : ''} ${block ? 'w-full' : ''}`}
    >
      {busy ? (
        <>
          <Spinner />
          {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** The board's spinner: a ring with one bright quarter. Decorative — the label carries the meaning. */
export function Spinner(): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="size-4 animate-spin rounded-pill border-2 border-white/40 border-t-white"
    />
  );
}

/** A circular icon button — the product card's "+", the board's 32px round action. */
export function RoundButton({
  label,
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'aria-label'> & {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      {...rest}
      className="inline-flex size-8 items-center justify-center rounded-pill bg-store-primary text-body text-store-on-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      {children}
    </button>
  );
}
