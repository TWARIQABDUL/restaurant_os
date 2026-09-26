// client/src/shared/ui/EmptyState.tsx — milestone 14, from project/Main.dc.html and States.dc.html.
//
// Main: "Icon, one line of what's missing, one line of why, one action."
// States: "plain-language headline, one line of reassurance or reason, and at most two actions.
//          Nothing blames the customer, and money states always say whether they were charged."
//
// So the same shape serves an empty list and a failure, which is why there is one component and not
// two. `EmptyState` is the dashed-border version that sits inside a panel; `StateCard` is the same
// content as a standalone card — see StateCard.tsx.

import type { ReactNode } from 'react';
import { Button } from './Button.tsx';

export type StateAction = { label: string; onSelect?: () => void };

type Props = {
  /** A glyph or an SVG. Decorative — the headline carries the meaning. */
  icon?: ReactNode;
  headline: string;
  body?: string;
  action?: StateAction;
  secondaryAction?: StateAction;
};

export function EmptyState({ icon, headline, body, action, secondaryAction }: Props): ReactNode {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-control-line p-[22px] text-center">
      {icon === undefined ? null : (
        <span aria-hidden="true" className="text-muted">
          {icon}
        </span>
      )}
      <strong className="text-ink">{headline}</strong>
      {body === undefined ? null : <span className="max-w-[260px] text-caption text-muted">{body}</span>}
      {action === undefined ? null : (
        <span className="mt-1.5">
          <Button onClick={action.onSelect}>{action.label}</Button>
        </span>
      )}
      {secondaryAction === undefined ? null : (
        <Button variant="text" onClick={secondaryAction.onSelect}>
          {secondaryAction.label}
        </Button>
      )}
    </div>
  );
}

/** The board's own empty-orders icon: a shop awning. */
export function BagIcon(): ReactNode {
  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7h18l-2 13H5L3 7z" />
      <path d="M8 7a4 4 0 0 1 8 0" />
    </svg>
  );
}
