// client/src/gallery/StateSheet.tsx — milestone 14.
//
// The two state boards. Five across at 1440 and one across at 390, which is what makes the viewport
// switch in Gallery.tsx worth having: the cards have to reflow, not shrink.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Segmented } from '../shared/ui/index.ts';
import { ADMIN_STATES, PRODUCT_STATES } from '../shared/states/index.tsx';
import type { StateEntry, StateSide } from '../shared/states/index.tsx';

function StateGrid({ entries, tall }: { entries: readonly StateEntry[]; tall: boolean }): ReactNode {
  return (
    <div
      className={`grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 ${tall ? 'xl:grid-cols-4' : 'xl:grid-cols-5'}`}
    >
      {entries.map((entry) => (
        <article
          key={`${entry.side}-${entry.name}`}
          className={`flex flex-col overflow-hidden rounded-card border border-line bg-surface ${
            tall ? 'min-h-[380px]' : 'min-h-[292px]'
          }`}
        >
          <div className="flex items-center justify-between border-b border-line-subtle px-3.5 py-2.5">
            <span className="text-caption font-bold text-ink">{entry.name}</span>
            <span className="rounded-pill bg-status-neutral px-2 py-0.5 text-[11px] font-semibold text-muted">
              {entry.where}
            </span>
          </div>
          <div className="flex grow flex-col">{entry.render()}</div>
        </article>
      ))}
    </div>
  );
}

/** States.dc.html — 20 of them, with its own All / Customer / Merchant filter. */
export function ProductStateSheet(): ReactNode {
  const [side, setSide] = useState<'all' | StateSide>('all');
  const shown = PRODUCT_STATES.filter((s) => side === 'all' || s.side === side);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="text-caption font-semibold uppercase tracking-[0.08em] text-muted">
            Beyond the happy path
          </span>
          <h2 className="mt-2 font-display text-display text-ink">
            Every state says what happened and what to do next.
          </h2>
          <p className="mt-2.5 max-w-[820px] text-title text-ink-2">
            One pattern for all of them: plain-language headline, one line of reassurance or reason, and at most two
            actions. Nothing blames the customer, and money states always say whether they were charged.
          </p>
        </div>
        <div className="shrink-0 sm:w-[300px]">
          <Segmented
            label="Filter states"
            value={side}
            onChange={setSide}
            options={[
              { value: 'all', label: `All ${PRODUCT_STATES.length}` },
              { value: 'customer', label: 'Customer' },
              { value: 'merchant', label: 'Merchant' },
            ]}
          />
        </div>
      </header>

      <StateGrid entries={shown} tall={false} />

      <div className="flex flex-col gap-2 rounded-card border border-line bg-surface px-4.5 py-3.5 text-caption text-ink-2 lg:flex-row lg:gap-6">
        <strong className="text-ink">Rules</strong>
        <span>Errors appear next to the thing that caused them, not in a banner.</span>
        <span>Carts survive network loss and are kept for 7 days.</span>
        <span>Prices are re-checked at checkout; any change is shown before paying.</span>
        <span>Pending payments never show “failed” until the provider confirms.</span>
      </div>
    </section>
  );
}

/** AdminStates.dc.html — 8, four across, taller cards because they carry a support reference. */
export function AdminStateSheet(): ReactNode {
  return (
    <section className="flex flex-col gap-6">
      <header>
        <span className="text-caption font-semibold uppercase tracking-[0.08em] text-muted">Admin console</span>
        <h2 className="mt-1.5 font-display text-display text-ink">
          Empty, loading, error and no-permission states
        </h2>
        <p className="mt-2 max-w-[820px] text-title text-ink-2">
          The same four patterns on every admin screen. Errors always give a reference so support can find the failed
          request.
        </p>
      </header>

      <StateGrid entries={ADMIN_STATES} tall />
    </section>
  );
}
