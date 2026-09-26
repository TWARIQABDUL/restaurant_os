// client/src/gallery/Gallery.tsx — milestone 14.
//
// The gallery shell. Its one job beyond navigation is the VIEWPORT SWITCH, because milestone 14's
// done-when is "The gallery matches the artboards at 1440 and 390" — the two widths the canvas is
// drawn at.
//
// THE FRAME SETS A REAL WIDTH, it does not scale. A transform: scale() would show the 1440 layout
// shrunk, which is exactly what Main.dc.html says must not happen: "Layouts re-compose at each size;
// nothing is simply shrunk." So the frame is a container of that width and the components inside
// reflow against it.
//
// Which means the breakpoints have to be container-relative, not viewport-relative: at 390 inside a
// 1440 window, `sm:` and `lg:` would still match the window and nothing would reflow. `@container`
// with `@sm:`/`@lg:` variants would be the Tailwind v4 way — but the kit is written with the ordinary
// responsive variants because that is what the real screens will use, so the frame instead sets its
// own width AND the page is meant to be resized. The 390 frame is therefore an honest preview of
// narrow layout only when the window is narrow; the switch is a ruler, and the note below says so.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Segmented } from '../shared/ui/index.ts';
import { TokenSheet } from './TokenSheet.tsx';
import { ComponentSheet } from './ComponentSheet.tsx';
import { AdminStateSheet, ProductStateSheet } from './StateSheet.tsx';
import { ALL_STATES, PRODUCT_STATES } from '../shared/states/index.tsx';

type Tab = 'tokens' | 'components' | 'states' | 'admin';
type Width = '1440' | '390' | 'fluid';

const TABS: readonly { readonly value: Tab; readonly label: string }[] = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'components', label: 'Components' },
  { value: 'states', label: `States · ${PRODUCT_STATES.length}` },
  { value: 'admin', label: 'Admin states · 8' },
];

const FRAME: Readonly<Record<Width, string>> = {
  '1440': 'w-[1440px]',
  '390': 'w-[390px]',
  fluid: 'w-full',
};

export function Gallery(): ReactNode {
  const [tab, setTab] = useState<Tab>('components');
  const [width, setWidth] = useState<Width>('fluid');

  return (
    <div className="min-h-dvh bg-ground font-sans text-body text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-baseline gap-3">
            <strong className="font-display text-heading">Vendlyfy UI kit</strong>
            <span className="text-caption text-muted">
              {ALL_STATES.length} states · milestone 14
            </span>
          </div>

          <nav aria-label="Sheets" className="lg:w-[520px]">
            <Segmented label="Sheet" value={tab} onChange={setTab} options={TABS} />
          </nav>

          <div className="lg:w-[260px]">
            <Segmented
              label="Viewport"
              value={width}
              onChange={setWidth}
              options={[
                { value: 'fluid', label: 'Fluid' },
                { value: '1440', label: '1440' },
                { value: '390', label: '390' },
              ]}
            />
          </div>
        </div>
      </header>

      {/* overflow-x-auto so the 1440 frame is reachable on a narrow screen instead of being clipped. */}
      <div className="overflow-x-auto">
        <main className={`mx-auto px-4 py-8 ${FRAME[width]}`}>
          {tab === 'tokens' ? <TokenSheet /> : null}
          {tab === 'components' ? <ComponentSheet /> : null}
          {tab === 'states' ? <ProductStateSheet /> : null}
          {tab === 'admin' ? <AdminStateSheet /> : null}
        </main>
      </div>

      <footer className="mx-auto max-w-[1440px] px-4 pb-10 text-caption text-muted">
        <p className="max-w-[820px]">
          The viewport buttons set the frame’s width. They are a ruler for checking a layout against the artboards at
          1440 and 390 — the components’ own breakpoints are the window’s, so to see the narrow layout as a phone gets
          it, narrow the window too.
        </p>
      </footer>
    </div>
  );
}
