// client/src/shared/ui/overlays.tsx — milestone 14, from project/Main.dc.html.
//
// The board decides which is which, and it is a rule rather than a preference:
//
//   "Sheets for choices on mobile (product options, payment). Drawers for detail on desktop (cart,
//    order). Modals only to confirm something destructive."
//
// So three components, each named for its job, and `Modal` takes a `confirmTone` of 'danger' because
// that is the only thing it is for. A modal used to show detail is a drawer drawn wrongly.
//
// ALL THREE USE <dialog>. The browser gives the focus trap, the Escape key, the inert background and
// the top layer for free — a hand-rolled overlay gets at most three of those and usually loses the
// focus trap, which is the one a keyboard user needs.
//
// THE SHEET AND THE DRAWER CARRY THE PER-STORE SURFACE, added at milestone 16. Both appear over a
// shopfront — the sheet holds product options and the drawer holds the cart — and a store whose theme is
// dark would otherwise get a white panel over a dark page. The modal keeps the fixed palette, because
// confirming something destructive is console chrome and is never themed. Where no store theme is
// applied these resolve to the platform default in tokens.css, so the gallery is unchanged.

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button.tsx';

function useDialog(open: boolean): React.RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    // showModal() throws if already open, and close() on a closed dialog is a no-op.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return ref;
}

type OverlayProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** The action bar at the foot. */
  footer?: ReactNode;
};

const BACKDROP = 'backdrop:bg-ink/40';

function CloseButton({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={onClose}
      className="flex size-11 items-center justify-center rounded-control text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      ✕
    </button>
  );
}

/**
 * A bottom sheet — mobile choices.
 *
 * The grab handle is decorative; dragging is not implemented, because the board draws a handle as an
 * affordance and every sheet on it also has a visible close. A drag gesture that only works with a
 * pointer would be the one way out for some people.
 */
export function BottomSheet({ open, onClose, title, children, footer }: OverlayProps): ReactNode {
  const ref = useDialog(open);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
      className={`m-0 mt-auto max-h-[85vh] w-full max-w-none rounded-t-sheet bg-store-surface p-0 text-store-text ${BACKDROP}`}
    >
      <div className="flex flex-col">
        <span aria-hidden="true" className="mx-auto mt-2 h-[3px] w-7 rounded-pill bg-control-line" />
        <div className="flex items-center justify-between px-4 py-2">
          <strong className="text-title">{title}</strong>
          <CloseButton onClose={onClose} />
        </div>
        <div className="overflow-y-auto px-4 pb-4">{children}</div>
        {footer === undefined ? null : <div className="border-t border-line-subtle p-4">{footer}</div>}
      </div>
    </dialog>
  );
}

/** A right-hand drawer — desktop detail. Cart, order detail. */
export function Drawer({ open, onClose, title, children, footer }: OverlayProps): ReactNode {
  const ref = useDialog(open);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
      className={`m-0 ml-auto h-full max-h-none w-[min(420px,100vw)] max-w-none rounded-none bg-store-surface p-0 text-store-text ${BACKDROP}`}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-line-subtle px-4 py-2">
          <strong className="text-title">{title}</strong>
          <CloseButton onClose={onClose} />
        </div>
        <div className="grow overflow-y-auto p-4">{children}</div>
        {footer === undefined ? null : <div className="border-t border-line-subtle p-4">{footer}</div>}
      </div>
    </dialog>
  );
}

/**
 * A confirmation modal. Destructive only.
 *
 * `confirmLabel` says what will happen — "Delete section", not "OK" — because the board's delete
 * confirmations all name the act, and a button labelled OK makes the reader re-read the question.
 */
export function ConfirmModal({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  onConfirm,
  cancelLabel = 'Keep it',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  cancelLabel?: string;
}): ReactNode {
  const ref = useDialog(open);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="confirm-title"
      className={`m-auto w-[min(420px,calc(100vw-32px))] rounded-card bg-surface p-5 text-ink ${BACKDROP}`}
    >
      <div className="flex flex-col gap-2">
        <strong id="confirm-title" className="text-title">
          {title}
        </strong>
        <span className="text-body text-ink-2">{body}</span>
        <div className="mt-2 flex gap-2">
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button variant="text" onClick={onClose}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
