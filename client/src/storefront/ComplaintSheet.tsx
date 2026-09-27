// client/src/storefront/ComplaintSheet.tsx — milestone 18, from CustomerAccount's COMPLAIN screen.
//
// "What went wrong with #0990?" — five chips, a description, and one button.
//
// THE FIVE CHIPS ARE V008'S FIVE REASON CODES, which is a coincidence worth not relying on: the board's
// labels are "Missing item, Wrong item, Quality, Late, Other" and the column's values are
// item_missing, wrong_item, quality_problem, arrived_late, other. The pairing lives in api.ts as data, so a
// sixth reason is a migration plus one line rather than a search through components.
//
// BOTH A REASON AND A DESCRIPTION ARE REQUIRED, which is the board's own rule (`complaintBad` is
// `!s.issue||!s.desc.trim()`) and V008's too — file_complaint() refuses an empty detail because "a complaint
// needs the customer's own words". The button stays disabled rather than failing after the tap.
//
// THE PHOTO BUTTON IS NOT HERE. The board draws "+ Add a photo" and V008 has `complaint_evidence` for it, but
// where uploaded files live is one of Part 9's open decisions ("Image storage") — and it is no longer only
// about product photos, because complaint evidence and KYC documents share the same store. A button that
// cannot upload would be worse than no button.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { BottomSheet, Button, Chip } from '../shared/ui/index.ts';
import { COMPLAINT_REASONS, storefront } from './api.ts';
import type { CustomerComplaint } from './api.ts';
import { useStore } from './StoreProvider.tsx';

type Props = {
  open: boolean;
  onClose: () => void;
  orderNumber: number;
  trackingCode: string;
  onFiled: (complaints: CustomerComplaint[]) => void;
};

export function ComplaintSheet({ open, onClose, orderNumber, trackingCode, onFiled }: Props): ReactNode {
  const { face } = useStore();
  const [reason, setReason] = useState<string | null>(null);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = reason !== null && detail.trim() !== '';

  const send = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    void storefront
      .fileComplaint(face.store.slug, trackingCode, { reason, detail: detail.trim() })
      .then((result) => {
        setReason(null);
        setDetail('');
        onFiled(result.complaints);
      })
      .catch((failure: unknown) => {
        if (failure instanceof ApiFailure) setError(failure.message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Report a problem">
      <div className="flex flex-col gap-3">
        <strong className="font-display text-heading">What went wrong with #{orderNumber}?</strong>

        <div role="radiogroup" aria-label="What went wrong" className="flex flex-wrap gap-2">
          {COMPLAINT_REASONS.map((option) => (
            <Chip
              key={option.code}
              label={option.label}
              selected={reason === option.code}
              onSelect={() => setReason(option.code)}
            />
          ))}
        </div>

        <textarea
          rows={4}
          aria-label="Tell the store what happened"
          placeholder="Tell the store what happened"
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
          maxLength={2000}
          className="resize-none rounded-control border border-control-line bg-store-surface px-3 py-2.5 text-body text-store-text"
        />

        <span className="text-caption text-store-muted">
          {face.store.name} sees this first. If you can’t agree, the store can ask Vendlyfy to decide.
        </span>

        {error === null ? null : (
          <p role="alert" className="text-body font-semibold text-status-danger-fg">
            {error}
          </p>
        )}

        <Button variant="primary" block onClick={send} disabled={!ready} busy={busy} busyLabel="Sending…">
          Send to the store
        </Button>
      </div>
    </BottomSheet>
  );
}
