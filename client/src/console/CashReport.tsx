// client/src/console/CashReport.tsx — milestone 21, from project/CashReport.dc.html.
//
// "RIGHT NOW" IS WHAT RIDERS SET THEMSELVES, read-only here — the board's own line, "Riders set this
// themselves in the rider app." Nothing on this screen changes a rider's availability; it is the same
// one-way read Dashboard's cards already are for figures a different screen owns.
//
// A CARD PER RIDER WITH CASH ACTIVITY TODAY, not per rider full stop — `cashReportDay()`
// (repositories/riders.ts) only returns a rider once they have something to account for: a delivered
// cash order, a cash order still out, or an already-closed day. A rider who took no cash orders today
// has nothing to close and nothing to show.
//
// THE GAP DECISION IS THE SAME THREE OPTIONS close_rider_day() (V023) enforces, not a fourth the client
// invents: carry over, discount (which needs an order and a note — record_manual_discount(), V013, is
// what actually moves the number), or write off. The button stays disabled until one is chosen, for a
// real shortfall, the same rule the Orders board's decline/cancel reason panel already follows.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, Radio, SkeletonCard, TextField, Toast } from '../shared/ui/index.ts';
import { members as membersApi, ridersApi } from './api.ts';
import type { CarriedOverDebt, GapResolution, RiderCashCard, RosterRow } from './api.ts';
import { relativeWhen } from './lines.ts';
import { useShell } from './ShellProvider.tsx';

const GAP_OPTIONS: readonly { value: GapResolution; label: string }[] = [
  { value: 'carry_over', label: 'Rider will bring it next shift (carry over)' },
  { value: 'discount', label: 'Customer paid less: record it on the order' },
  { value: 'write_off', label: 'Write it off as a loss' },
];

type Props = {
  /**
   * A TESTING SEAM, the same one Orders.tsx (milestone 20) added and for the same reason:
   * `renderToStaticMarkup` runs no effects, so `load()`'s fetch never resolves in the render gate.
   * Console.tsx passes none of these.
   */
  initialRoster?: RosterRow[];
  initialCards?: RiderCashCard[];
  initialCarriedOver?: CarriedOverDebt[];
};

export function CashReport({ initialRoster, initialCards, initialCarriedOver }: Props = {}): ReactNode {
  const { store, money, may, currency } = useShell();

  const [roster, setRoster] = useState<RosterRow[] | null>(initialRoster ?? null);
  const [cards, setCards] = useState<RiderCashCard[] | null>(initialCards ?? null);
  const [carriedOver, setCarriedOver] = useState<CarriedOverDebt[]>(initialCarriedOver ?? []);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((t) => (t === m ? null : t)), 3000);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [r, c] = await Promise.all([ridersApi.roster(store.id), ridersApi.cashReport(store.id)]);
      setRoster(r.roster);
      setCards(c.cards);
      setCarriedOver(c.carriedOver);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : 'Riders & cash could not be loaded.');
    }
  }, [store.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (roster === null || cards === null) {
    return error === null ? (
      <div className="flex flex-col gap-3">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    ) : (
      <Alert tone="danger" headline={error}>
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3.5">
        <div className="grow">
          <h1 className="m-0 font-display text-[22px] lg:text-[28px]">Riders &amp; cash</h1>
          <p className="m-0 text-caption text-muted">Who’s on duty, what they’re carrying, and closing each rider’s day.</p>
        </div>
        {may('staff.create') ? (
          <Button tone="brand" variant="secondary" onClick={() => setAddOpen(true)}>
            Add a rider
          </Button>
        ) : null}
      </header>

      <section className="overflow-hidden rounded-card border border-line bg-surface">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="m-0 text-title">Right now</h2>
          <span className="text-caption text-muted">Riders set this themselves in the rider app</span>
        </div>
        <div className="grid grid-cols-[minmax(0,1.6fr)_90px_120px_90px_110px_minmax(0,1fr)] gap-3 bg-status-neutral px-4 py-2.5 text-[12px] font-semibold text-muted">
          <span>Rider</span>
          <span>Plate</span>
          <span>Status</span>
          <span>Jobs now</span>
          <span>Cash</span>
          <span>Last update</span>
        </div>
        {roster.map((r) => (
          <div key={r.id} className="grid grid-cols-[minmax(0,1.6fr)_90px_120px_90px_110px_minmax(0,1fr)] items-center gap-3 border-t border-line-subtle px-4 py-3 text-body">
            <span className="flex items-center gap-2.5">
              <span className="flex size-[34px] shrink-0 items-center justify-center rounded-pill bg-ink text-[12px] font-bold text-white">
                {r.name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2)}
              </span>
              <span className="flex flex-col">
                <strong>{r.name}</strong>
                <span className="text-caption text-muted">{r.phone ?? '—'}</span>
              </span>
            </span>
            <span className="font-mono text-mono text-[12px]">{r.plate}</span>
            <span
              className={`justify-self-start rounded-pill px-2.5 py-[2px] text-[12px] font-bold ${
                r.availability === 'available' ? 'bg-status-success text-status-success-fg' : 'bg-status-neutral text-muted'
              }`}
            >
              {r.availability === 'available' ? (r.activeJobs > 0 ? 'On a delivery' : 'Available') : 'Off duty'}
            </span>
            <span>{r.activeJobs}</span>
            <span className="font-semibold tabular-nums">{r.cashCarried === '0.00' ? '—' : money(r.cashCarried)}</span>
            <span className="text-caption text-muted">{relativeWhen(r.lastUpdate, store.timeZone)}</span>
          </div>
        ))}
      </section>

      <div>
        <h2 className="m-0 text-title">Close the day</h2>
        <span className="text-caption text-muted">Count what each rider hands in against the cash orders they delivered.</span>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {cards.map((c) => (
          <RiderCard key={c.riderId} storeId={store.id} card={c} money={money} onChanged={load} onToast={flash} />
        ))}
        {cards.length === 0 ? <p className="text-caption text-muted">No cash activity to close today.</p> : null}
      </div>

      {carriedOver.length === 0 ? null : (
        <section className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4">
          <h2 className="m-0 mb-1.5 text-title">Carried over</h2>
          {carriedOver.map((d) => (
            <div key={d.settlementId} className="flex items-center justify-between border-t border-line-subtle py-2 text-body">
              <span>
                {d.riderName} · from {d.businessDate}
                {d.orderNumber === null ? '' : ` · #${d.orderNumber}`}
              </span>
              <span className="flex items-center gap-3">
                <strong>{money(d.gapAmount)} owed</strong>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void ridersApi
                      .receiveCarriedOver(store.id, d.settlementId)
                      .then(() => {
                        flash('Marked received');
                        void load();
                      })
                      .catch(() => flash('That could not be marked received.'))
                  }
                >
                  Mark received
                </Button>
              </span>
            </div>
          ))}
        </section>
      )}

      {!addOpen ? null : (
        <AddRiderForm
          storeId={store.id}
          currencyCode={currency.code}
          onClose={() => setAddOpen(false)}
          onCreated={(name) => {
            setAddOpen(false);
            flash(`${name} added as a rider`);
          }}
        />
      )}

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}

function RiderCard({
  storeId,
  card,
  money,
  onChanged,
  onToast,
}: {
  storeId: string;
  card: RiderCashCard;
  money: (v: string) => string;
  onChanged: () => Promise<void>;
  onToast: (m: string) => void;
}): ReactNode {
  const [counted, setCounted] = useState(card.due);
  const [resolution, setResolution] = useState<GapResolution | ''>('');
  const [gapOrderId, setGapOrderId] = useState('');
  const [gapNote, setGapNote] = useState('');
  const [busy, setBusy] = useState(false);

  const countedNum = Number(counted.replace(/[^0-9.]/g, '')) || 0;
  const gap = Number(card.due) - countedNum;
  const canClose = card.stillOut.length === 0 && !card.closedToday;

  const close = (): void => {
    if (gap > 0 && resolution === '') return;
    setBusy(true);
    ridersApi
      .closeDay(
        storeId,
        card.riderId,
        counted,
        resolution === '' ? undefined : resolution,
        resolution === 'discount' ? gapOrderId : undefined,
        resolution === 'discount' ? gapNote : gap > 0 ? gapNote || undefined : undefined,
      )
      .then(() => {
        onToast(`${card.name}’s day closed`);
        return onChanged();
      })
      .catch((cause: unknown) => onToast(cause instanceof ApiFailure ? cause.message : 'That could not be closed.'))
      .finally(() => setBusy(false));
  };

  return (
    <section className={`flex flex-col gap-2.5 rounded-card bg-surface p-4 ${card.closedToday ? 'border border-line' : canClose ? 'border-2 border-status-warn-fg' : 'border border-line'}`}>
      <div className="flex items-center justify-between">
        <strong className="text-title">{card.name}</strong>
        <span
          className={`rounded-pill px-2.5 py-[2px] text-[12px] font-bold ${
            card.closedToday ? 'bg-status-success text-status-success-fg' : canClose ? 'bg-status-warn text-status-warn-fg' : 'bg-status-neutral text-muted'
          }`}
        >
          {card.closedToday ? 'Closed' : canClose ? 'Ready to close' : 'Still out'}
        </span>
      </div>

      {[...card.deliveredToday, ...card.stillOut].map((o) => (
        <div key={o.id} className="flex justify-between border-b border-line-subtle py-1 text-[13px]">
          <span>
            <span className="font-mono text-mono">#{o.orderNumber}</span> · {o.label}
          </span>
          <span className={card.stillOut.some((s) => s.id === o.id) ? 'text-muted' : ''}>{money(o.amount)}</span>
        </div>
      ))}

      <div className="flex justify-between text-body">
        <span>Cash orders delivered</span>
        <span className="tabular-nums">{money(card.expected)}</span>
      </div>
      {card.handedInToday === '0.00' ? null : (
        <div className="flex justify-between text-body text-muted">
          <span>Handed in today</span>
          <span className="tabular-nums">− {money(card.handedInToday)}</span>
        </div>
      )}
      <div className="flex justify-between font-semibold text-body">
        <span>{card.closedToday ? 'Counted' : 'Should hand in now'}</span>
        <span className="tabular-nums">{money(card.closedToday ? counted : card.due)}</span>
      </div>

      {card.closedToday ? (
        <p className="m-0 rounded-control bg-status-success p-2.5 text-caption text-status-success-fg">
          Closed{card.gapAmount !== null && Number(card.gapAmount) > 0 ? ` · ${money(card.gapAmount)} ${card.gapResolution ?? ''}`.replace('_', ' ') : ''}
        </p>
      ) : !canClose ? (
        <p className="m-0 rounded-control bg-status-neutral p-2.5 text-caption">
          Can’t close yet: {card.stillOut.length} cash order{card.stillOut.length === 1 ? '' : 's'} still with {card.name.split(' ')[0]}. The day closes once they’re delivered or returned.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <TextField label="Cash counted now" inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value)} />
          {gap <= 0 ? null : (
            <div className="flex flex-col gap-2 rounded-control bg-status-warn p-2.5">
              <strong className="text-caption text-status-warn-fg">Short by {money(String(gap))}</strong>
              {GAP_OPTIONS.map((o) => (
                <Radio key={o.value} name={`gap-${card.riderId}`} label={o.label} checked={resolution === o.value} onChange={() => setResolution(o.value)} tone="brand" />
              ))}
              {resolution !== 'discount' ? null : (
                <>
                  <TextField label="Which order" placeholder="Order id" value={gapOrderId} onChange={(e) => setGapOrderId(e.target.value)} />
                  <TextField label="Note" value={gapNote} onChange={(e) => setGapNote(e.target.value)} />
                </>
              )}
            </div>
          )}
          <Button
            tone="brand"
            onClick={close}
            disabled={busy || (gap > 0 && (resolution === '' || (resolution === 'discount' && (gapOrderId === '' || gapNote === ''))))}
            busy={busy}
          >
            {gap > 0 && resolution === '' ? 'Choose what happens to the gap' : `Close ${card.name.split(' ')[0]}’s day`}
          </Button>
        </div>
      )}
    </section>
  );
}

function AddRiderForm({
  storeId,
  onClose,
  onCreated,
}: {
  storeId: string;
  currencyCode: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [plateNumber, setPlateNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalid = name === '' || email === '' || password.length < 10 || plateNumber === '';

  const submit = (): void => {
    setBusy(true);
    setError(null);
    membersApi
      .createRider(storeId, { name, email, password, plateNumber, phone: phone || undefined })
      .then((m) => onCreated(m.name))
      .catch((cause: unknown) => setError(cause instanceof ApiFailure ? cause.message : 'That rider could not be added.'))
      .finally(() => setBusy(false));
  };

  return (
    <section className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-4">
      <strong className="text-title">Add a rider</strong>
      {error === null ? null : <Alert tone="danger" headline={error} />}
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <TextField label="Password" type="password" hint="At least 10 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
      <TextField label="Phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <TextField label="Plate number" value={plateNumber} onChange={(e) => setPlateNumber(e.target.value)} />
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button tone="brand" onClick={submit} disabled={invalid || busy} busy={busy}>
          Add rider
        </Button>
      </div>
    </section>
  );
}
