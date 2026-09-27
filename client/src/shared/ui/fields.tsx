// client/src/shared/ui/fields.tsx — milestone 14, from project/Main.dc.html.
//
// Every input the boards use. One rule runs through all of them, from States.dc.html: "Errors
// appear next to the thing that caused them, not in a banner." So an error is a prop on the field,
// it sets `aria-invalid`, it turns the border red, and it is announced by being referenced from
// `aria-describedby` rather than by a live region.

import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

const CONTROL =
  'h-11 rounded-control border border-control-line bg-surface px-3 text-body font-normal text-ink ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

const LABEL = 'flex flex-col gap-1.5 text-body font-semibold text-ink';

function ErrorText({ id, children }: { id: string; children: string }): ReactNode {
  return (
    <span id={id} className="text-caption font-medium text-status-danger-fg">
      {children}
    </span>
  );
}

export function TextField({
  label,
  error,
  hint,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & {
  label: string;
  error?: string;
  hint?: string;
}): ReactNode {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const described = [error === undefined ? null : errorId, hint === undefined ? null : hintId]
    .filter((v): v is string => v !== null)
    .join(' ');

  return (
    <label className={LABEL}>
      {label}
      <input
        {...rest}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={described === '' ? undefined : described}
        className={`${CONTROL} ${error === undefined ? '' : 'border-2 border-status-danger-fg'}`}
      />
      {hint === undefined ? null : (
        <span id={hintId} className="text-caption font-normal text-muted">
          {hint}
        </span>
      )}
      {error === undefined ? null : <ErrorText id={errorId}>{error}</ErrorText>}
    </label>
  );
}

/**
 * A phone field with a fixed country prefix.
 *
 * The prefix is a SIBLING, not part of the input's value, because the value that reaches the
 * database must be just the digits — and a customer editing a field whose first four characters
 * they cannot delete is the reason this is drawn as two boxes on the board.
 */
export function PhoneField({
  label,
  prefix = '+250',
  error,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & {
  label: string;
  prefix?: string;
  error?: string;
}): ReactNode {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <label className={LABEL}>
      {label}
      <span
        className={`flex h-11 overflow-hidden rounded-control border bg-surface ${
          error === undefined ? 'border-control-line' : 'border-2 border-status-danger-fg'
        }`}
      >
        <span aria-hidden="true" className="flex items-center bg-status-neutral px-2.5 font-medium text-ink-2">
          {prefix}
        </span>
        <input
          inputMode="tel"
          {...rest}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
          className="min-w-0 grow border-0 px-2.5 text-body font-normal text-ink outline-none"
        />
      </span>
      {error === undefined ? null : <ErrorText id={errorId}>{error}</ErrorText>}
    </label>
  );
}

export function SelectField({
  label,
  children,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & { label: string; children: ReactNode }): ReactNode {
  return (
    <label className={LABEL}>
      {label}
      <select {...rest} className={`${CONTROL} px-2.5`}>
        {children}
      </select>
    </label>
  );
}

/**
 * The two-or-three-way switch the boards use everywhere — Delivery/Pickup, All/Customer/Merchant.
 *
 * A radiogroup rather than a tablist: it chooses a value, it does not reveal a panel.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { readonly value: T; readonly label: string }[];
  value: T;
  onChange: (value: T) => void;
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-control bg-status-neutral p-[3px]">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.value)}
            className={`h-[38px] flex-1 rounded-chip px-4 text-body font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
              on ? 'bg-surface text-ink shadow-menu' : 'bg-transparent text-ink-2'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A checkbox. The tick is the store's colour, so a themed store's forms are its own. */
export function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <label className="flex items-center gap-2 text-body text-ink">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={`flex size-5 shrink-0 items-center justify-center rounded-chip text-caption text-store-on-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink ${
          checked ? 'bg-store-primary' : 'border-[1.5px] border-control-line'
        }`}
      >
        {checked ? '✓' : ''}
      </span>
      {label}
    </label>
  );
}

/**
 * `tone` arrived at milestone 20 for the same reason `Switch`'s did at 19: the merchant console's own decline
 * and cancel reason pickers are not the store's UI, so the selected dot must not be the store's theme colour
 * either. Defaults to `'store'`, so every existing use — the storefront's option groups — is unchanged.
 */
export function Radio({
  label,
  checked,
  onChange,
  name,
  tone = 'store',
}: {
  label: ReactNode;
  checked: boolean;
  onChange: () => void;
  name: string;
  tone?: 'store' | 'brand';
}): ReactNode {
  return (
    <label className="flex items-center gap-2 text-body text-ink">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={`size-5 shrink-0 rounded-pill peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink ${
          checked ? `border-[6px] ${tone === 'brand' ? 'border-brand' : 'border-store-primary'}` : 'border-[1.5px] border-control-line'
        }`}
      />
      {label}
    </label>
  );
}

/**
 * A switch — "Track stock", "Show on store". Toggles immediately; there is no Save beside it.
 *
 * TWO PROPS ARRIVED AT MILESTONE 19, both because the merchant console draws the same switch differently and
 * the alternative was a second switch.
 *
 *   `labelPosition` — `Notifications` puts its footer label on the left and the switch hard right, where
 *     `AddProduct` puts the switch first and the label after it. Same control, two rows.
 *   `tone` — a store's switch is the store's primary colour; the console's is Vendlyfy's green, because the
 *     console chrome is not themed by the store it happens to be showing (see tokens.css on --color-brand).
 *
 * Both default to what the kit already did, so every existing use is unchanged.
 */
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
  labelPosition = 'after',
  tone = 'store',
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  labelPosition?: 'before' | 'after';
  tone?: 'store' | 'brand';
}): ReactNode {
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex h-[26px] w-11 shrink-0 rounded-pill p-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
        checked
          ? `justify-end ${tone === 'brand' ? 'bg-brand' : 'bg-store-primary'}`
          : 'justify-start bg-control-line'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <span aria-hidden="true" className="size-5 rounded-pill bg-white" />
    </button>
  );

  return labelPosition === 'before' ? (
    <span className="flex w-full items-center justify-between gap-2 text-body text-ink">
      <span>{label}</span>
      {control}
    </span>
  ) : (
    <span className="flex items-center gap-2 text-body text-ink">
      {control}
      {label}
    </span>
  );
}

/**
 * The quantity stepper. Minimum 1, capped at whatever stock says.
 *
 * The cap is a prop rather than being inferred, because "capped at stock (5)" on the board is the
 * store's stock — and V005 reserves it atomically at checkout, so the number here is a courtesy
 * that stops a customer choosing something that will be refused, not the check itself.
 */
export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max,
  label = 'Quantity',
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  label?: string;
}): ReactNode {
  const ceiling = max ?? Number.MAX_SAFE_INTEGER;
  return (
    <div className="inline-flex h-11 items-center rounded-control border border-control-line">
      <button
        type="button"
        aria-label={`Decrease ${label.toLowerCase()}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="size-11 text-[20px] text-ink disabled:text-disabled focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        −
      </button>
      {/* aria-live so a screen reader hears the new number without the buttons losing focus. */}
      <span aria-live="polite" className="min-w-7 text-center font-semibold tabular-nums">
        {value}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label.toLowerCase()}`}
        disabled={value >= ceiling}
        onClick={() => onChange(Math.min(ceiling, value + 1))}
        className="size-11 text-[20px] text-ink disabled:text-disabled focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        +
      </button>
    </div>
  );
}
