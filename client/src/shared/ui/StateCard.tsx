// client/src/shared/ui/StateCard.tsx — milestone 14, from States.dc.html and AdminStates.dc.html.
//
// ONE PATTERN FOR ALL OF THEM, which is what States.dc.html says in its own subtitle:
//
//   "plain-language headline, one line of reassurance or reason, and at most two actions. Nothing
//    blames the customer, and money states always say whether they were charged."
//
// AdminStates adds one field: "Errors always give a reference so support can find the failed
// request." That is `reference`, rendered in mono — and it is the only difference between the two
// boards' cards, so they are one component.
//
// AT MOST TWO ACTIONS is enforced by the type: there is `action` and `secondaryAction`, and no array.

import type { ReactNode } from 'react';
import { Button } from './Button.tsx';
import type { StateAction } from './EmptyState.tsx';
import type { StatusTone } from './Badge.tsx';

const TONE: Readonly<Record<StatusTone, string>> = {
  neutral: 'bg-status-neutral text-status-neutral-fg',
  info: 'bg-status-info text-status-info-fg',
  warn: 'bg-status-warn text-status-warn-fg',
  progress: 'bg-status-progress text-status-progress-fg',
  success: 'bg-status-success text-status-success-fg',
  danger: 'bg-status-danger text-status-danger-fg',
};

type Props = {
  tone: StatusTone;
  /** A glyph. Decorative: the headline says what happened. */
  icon: string;
  headline: string;
  body: string;
  /** AdminStates: a support reference for a failed request. */
  reference?: string;
  action?: StateAction;
  /** Quiet primary — the board uses an outlined button where the action is not the obvious next step. */
  quietAction?: boolean;
  secondaryAction?: StateAction;
};

export function StateCard({
  tone,
  icon,
  headline,
  body,
  reference,
  action,
  quietAction = false,
  secondaryAction,
}: Props): ReactNode {
  return (
    <div className="flex h-full flex-col items-center gap-1.5 px-3.5 pb-3.5 pt-4 text-center">
      <span
        aria-hidden="true"
        className={`flex size-11 items-center justify-center rounded-pill text-[20px] font-bold ${TONE[tone]}`}
      >
        {icon}
      </span>
      <strong className="mt-1 text-body leading-tight text-ink">{headline}</strong>
      <span className="text-caption leading-snug text-muted">{body}</span>
      {reference === undefined ? null : (
        <span className="rounded-chip bg-ground px-2 py-[3px] font-mono text-[11px] text-muted">{reference}</span>
      )}

      {/* mt-auto pins the actions to the foot, so a grid of these lines its buttons up whatever the
          body length — which is what makes the board's five-across row read as one thing. */}
      <div className="mt-auto flex w-full flex-col gap-1.5 pt-2">
        {action === undefined ? null : (
          <Button variant={quietAction ? 'secondary' : 'primary'} block onClick={action.onSelect}>
            {action.label}
          </Button>
        )}
        {secondaryAction === undefined ? null : (
          <Button variant="text" block onClick={secondaryAction.onSelect}>
            {secondaryAction.label}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The first-time merchant checklist — States.dc.html's "Finish setting up · 2 of 4".
 *
 * A component rather than a gallery one-off because Dashboard shows it until it is complete, and the
 * progress bar has to agree with the ticks. Deriving both from one array is what makes that true.
 */
export function SetupChecklist({
  steps,
  action,
}: {
  steps: readonly { readonly label: string; readonly done: boolean }[];
  action?: StateAction;
}): ReactNode {
  const done = steps.filter((s) => s.done).length;
  const percent = steps.length === 0 ? 0 : Math.round((done / steps.length) * 100);

  return (
    <div className="flex h-full flex-col gap-1.5 px-3.5 py-3">
      <strong className="text-body text-ink">
        Finish setting up · {done} of {steps.length}
      </strong>
      <div
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-label="Setup progress"
        className="h-1.5 overflow-hidden rounded-pill bg-status-neutral"
      >
        <span className="block h-1.5 bg-store-primary" style={{ width: `${percent}%` }} />
      </div>

      <ul className="flex flex-col">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2 py-1 text-caption">
            <span
              aria-hidden="true"
              className={`flex size-5 items-center justify-center rounded-pill text-[11px] text-store-on-primary ${
                step.done ? 'bg-store-primary' : 'border-[1.5px] border-control-line'
              }`}
            >
              {step.done ? '✓' : ''}
            </span>
            <span className={step.done ? 'text-muted line-through' : 'font-semibold text-ink'}>{step.label}</span>
            <span className="sr-only">{step.done ? ' — done' : ' — not done'}</span>
          </li>
        ))}
      </ul>

      {action === undefined ? null : (
        <span className="mt-auto">
          <Button block onClick={action.onSelect}>
            {action.label}
          </Button>
        </span>
      )}
    </div>
  );
}
