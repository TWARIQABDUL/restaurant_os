// client/src/auth/steps.tsx — milestone 15, from project/Auth.dc.html.
//
// The board's steps, each a component: sign in · which store · confirm it's you · reset · enter the code ·
// choose a new password · signed in.
//
// NOTHING HERE STORES ANYTHING. No localStorage, no sessionStorage, no module-level cache of the user.
// Step state is React state, which is gone on reload — and that is correct: reloading mid-flow should
// return you to the start, not to a half-remembered position the server knows nothing about.

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Checkbox, PhoneField, TextField } from '../shared/ui/index.ts';
import { StepHeading } from './AuthShell.tsx';
import { allPassed, evaluateRules } from './passwordRules.ts';
import type { Membership } from '../app/api.ts';

/** A failure to show beside the form. Errors belong next to what caused them (States.dc.html). */
export type StepError = { message: string; hint?: string } | null;

function Problem({ error }: { error: StepError }): ReactNode {
  if (error === null) return null;
  return (
    <Alert tone="danger" headline={error.message}>
      {error.hint}
    </Alert>
  );
}

// ---------------------------------------------------------------------------

export function SignInStep({
  notice,
  error,
  busy,
  onSubmit,
  onForgot,
}: {
  notice?: string;
  error: StepError;
  busy: boolean;
  onSubmit: (input: { identifier: string; password: string; remember: boolean }) => void;
  onForgot: () => void;
}): ReactNode {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [tried, setTried] = useState(false);
  const [show, setShow] = useState(false);

  const missingPassword = tried && password === '';

  return (
    <>
      <StepHeading title="Sign in">Use the email or phone number you were invited with.</StepHeading>

      {notice === undefined ? null : (
        <div className="mb-4">
          <Alert tone="warn" headline={notice} />
        </div>
      )}

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (password === '') return;
          onSubmit({ identifier, password, remember });
        }}
      >
        <Problem error={error} />

        <TextField
          label="Email or phone"
          autoComplete="username"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />

        <div className="flex flex-col gap-1.5">
          <TextField
            label="Password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            {...(missingPassword ? { error: 'Enter your password.' } : {})}
          />
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShow(!show)}
              className="text-caption font-semibold text-store-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {show ? 'Hide' : 'Show'} password
            </button>
            <button
              type="button"
              onClick={onForgot}
              className="text-caption font-semibold text-store-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              Forgot password?
            </button>
          </div>
        </div>

        {/* §2.5: "an explicit max-age for Auth's 'Keep me signed in on this device'". Unticked means a
            session cookie that goes when the browser closes. */}
        <Checkbox label="Keep me signed in on this device" checked={remember} onChange={setRemember} />

        <Button type="submit" block busy={busy} busyLabel="Signing in…">
          Sign in
        </Button>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------

export function StorePickerStep({
  memberships,
  onPick,
}: {
  memberships: readonly Membership[];
  onPick: (membership: Membership) => void;
}): ReactNode {
  return (
    <>
      <StepHeading title="Which store?">
        We only show stores after the password matches one of them, so nobody can find out where an email is
        registered.
      </StepHeading>

      <ul className="flex flex-col gap-2">
        {memberships.map((membership) => (
          <li key={membership.storeId}>
            <button
              type="button"
              onClick={() => onPick(membership)}
              className="flex w-full items-center gap-3 rounded-card border border-control-line bg-surface p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-control bg-store-primary font-display text-title text-store-on-primary"
              >
                {membership.name.slice(0, 1)}
              </span>
              <span className="flex grow flex-col">
                <strong className="text-body">{membership.name}</strong>
                <span className="text-caption text-muted">{membership.slug}</span>
              </span>
              <span className="rounded-pill bg-status-neutral px-2.5 py-0.5 text-caption font-semibold capitalize text-status-neutral-fg">
                {membership.role}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------

/** Six boxes, one input. The board draws boxes; a real one-input-per-digit form loses paste. */
export function CodeStep({
  title,
  sub,
  error,
  busy,
  resendLabel,
  onSubmit,
  onResend,
  onBack,
}: {
  title: string;
  sub: string;
  error: StepError;
  busy: boolean;
  resendLabel: string;
  onSubmit: (code: string) => void;
  onResend: () => void;
  onBack: () => void;
}): ReactNode {
  const [code, setCode] = useState('');
  const id = useId();
  const digits = code.replace(/[^0-9]/g, '').slice(0, 6);

  return (
    <>
      <StepHeading title={title}>{sub}</StepHeading>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (digits.length === 6) onSubmit(digits);
        }}
      >
        <Problem error={error} />

        {/* ONE input behind six boxes. Six separate inputs look like the board and break pasting a code
            out of an SMS, which is how almost everybody enters one. */}
        <label htmlFor={id} className="text-body font-semibold text-ink">
          6-digit code
        </label>
        <div className="relative">
          <input
            id={id}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={digits}
            onChange={(e) => setCode(e.target.value)}
            className="absolute inset-0 size-full rounded-control opacity-0"
          />
          <div aria-hidden="true" className="flex gap-1.5">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <span
                key={index}
                className={`flex h-12 flex-1 items-center justify-center rounded-control font-mono text-title tabular-nums ${
                  index === digits.length ? 'border-2 border-ink' : 'border border-control-line'
                }`}
              >
                {digits[index] ?? ''}
              </span>
            ))}
          </div>
        </div>

        <Button type="submit" block busy={busy} busyLabel="Checking…" disabled={digits.length !== 6}>
          Continue
        </Button>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onResend}
            className="text-caption font-semibold text-store-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {resendLabel}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="text-caption font-semibold text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Back to sign in
          </button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------

export function ForgotStep({
  error,
  busy,
  onSubmit,
  onBack,
}: {
  error: StepError;
  busy: boolean;
  onSubmit: (identifier: string) => void;
  onBack: () => void;
}): ReactNode {
  const [identifier, setIdentifier] = useState('');

  return (
    <>
      <StepHeading title="Reset your password">We’ll send a 6-digit code to your phone or email.</StepHeading>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(identifier);
        }}
      >
        <Problem error={error} />
        <TextField
          label="Email or phone"
          autoComplete="username"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
        <Button type="submit" block busy={busy} busyLabel="Sending…">
          Send code
        </Button>
        <Button variant="text" block onClick={onBack}>
          Back to sign in
        </Button>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Choosing a password — the reset, the invite and the owner-reset all end here.
 *
 * The checklist ticks as you type, which is the board's own behaviour and the reason the rules are
 * evaluated locally as well as on the server (see passwordRules.ts for why that duplication is
 * deliberate and which direction it errs in).
 */
export function NewPasswordStep({
  title,
  sub,
  cta,
  rules,
  context,
  error,
  busy,
  needsPlate = false,
  onSubmit,
}: {
  title: string;
  sub: string;
  cta: string;
  rules: readonly string[];
  context: { email?: string | null; storeName?: string | null };
  error: StepError;
  busy: boolean;
  needsPlate?: boolean;
  onSubmit: (input: { password: string; plateNumber?: string }) => void;
}): ReactNode {
  const [password, setPassword] = useState('');
  const [plate, setPlate] = useState('');
  const evaluated = evaluateRules(rules, password, context);
  const strong = allPassed(evaluated);

  return (
    <>
      <StepHeading title={title}>{sub}</StepHeading>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!strong) return;
          if (needsPlate && plate.trim() === '') return;
          onSubmit({ password, ...(needsPlate ? { plateNumber: plate } : {}) });
        }}
      >
        <Problem error={error} />

        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <ul className="flex flex-col gap-1">
          {evaluated.map((rule) => (
            <li key={rule.label} className="flex items-center gap-2 text-caption">
              <span aria-hidden="true" className={rule.passed ? 'text-status-success-fg' : 'text-muted'}>
                {rule.passed ? '✓' : '·'}
              </span>
              <span className={rule.passed ? 'text-status-success-fg' : 'text-muted'}>{rule.label}</span>
              <span className="sr-only">{rule.passed ? ' — met' : ' — not met yet'}</span>
            </li>
          ))}
        </ul>

        {needsPlate ? (
          <PhoneField label="Plate number" prefix="RA" value={plate} onChange={(e) => setPlate(e.target.value)} />
        ) : null}

        <Button type="submit" block busy={busy} busyLabel="Saving…" disabled={!strong}>
          {cta}
        </Button>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------

/** Where the board sends each persona once it is done. */
export function RoutedStep({
  title,
  sub,
  cta,
  onContinue,
}: {
  title: string;
  sub: string;
  cta: string;
  onContinue: () => void;
}): ReactNode {
  return (
    <>
      <StepHeading title={title}>{sub}</StepHeading>
      <Button block onClick={onContinue}>
        {cta}
      </Button>
    </>
  );
}
