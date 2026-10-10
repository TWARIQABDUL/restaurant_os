// client/src/shared/ui/ErrorPage.tsx — milestone 28, from project/ErrorPages.dc.html.
//
// "INSIDE A WORKING STORE, ERRORS KEEP THE STORE'S OWN LOOK AND A WAY BACK TO ITS MENU. WHEN THE STORE ITSELF IS MISSING OR SUSPENDED,
// VENDLYFY'S NEUTRAL LOOK IS USED, AND NOTHING ABOUT WHY A STORE WAS SUSPENDED IS SHOWN TO CUSTOMERS." — the board's own sentence, and the
// whole of this component's one decision: `look="store"` draws with the store tokens the storefront has already applied to the page
// (bg-store-*), `look="platform"` draws with Vendlyfy's fixed ones. A page that failed BEFORE a store loaded cannot know a store's
// colours, so it must not guess them; and a suspended store's page must not be recognisably that store's, or the neutral look would be
// a costume.
//
// StateCard (States.dc.html) is the in-page card for a section that failed to load. This is the whole-page version for when the page
// itself cannot be shown — a missing item, a crash, a missing store — so they are two components with one voice, not one pretending
// to be both.

import type { ReactNode } from 'react';
import { Button } from './Button.tsx';

export type ErrorAction = { label: string; onSelect: () => void; href?: string };

type Props = {
  look: 'store' | 'platform';
  /** The brand line in the bar: the store's name inside a store, "Vendlyfy" outside one. */
  brand: string;
  mark: string;
  /** "404", "500", "?" or "—" — large and quiet. */
  code: string;
  title: string;
  body: ReactNode;
  action: ErrorAction;
  secondary?: ErrorAction;
  /** ERR-7F3A-21C9: shown beneath, in mono, so a person can read it to support. */
  reference?: string;
  /** An address-bar-style line under the buttons, e.g. what was asked for. */
  asked?: string;
};

export function ErrorPage({ look, brand, mark, code, title, body, action, secondary, reference, asked }: Props): ReactNode {
  const store = look === 'store';
  return (
    <div className={`flex min-h-dvh flex-col ${store ? 'bg-store-bg text-store-text' : 'bg-ground text-ink'}`}>
      <header className={`flex h-14 shrink-0 items-center gap-2.5 border-b px-4 ${store ? 'border-store-border bg-store-surface' : 'border-line bg-surface'}`}>
        <span aria-hidden="true" className={`flex size-8 items-center justify-center rounded-chip font-display text-body font-bold ${store ? 'bg-store-primary text-store-on-primary' : 'bg-ink text-ground'}`}>
          {mark}
        </span>
        <strong className="font-display text-[18px]">{brand}</strong>
      </header>
      <main className="mx-auto flex w-full max-w-[520px] grow flex-col items-center justify-center gap-3 px-5 py-14 text-center">
        <span aria-hidden="true" className={`font-display text-[72px] font-bold leading-none ${store ? 'text-store-primary' : code === '500' ? 'text-status-danger-fg' : 'text-muted'}`}>
          {code}
        </span>
        <h1 className="m-0 font-display text-[28px] leading-tight">{title}</h1>
        <p className={`m-0 text-[16px] ${store ? 'text-store-muted' : 'text-ink-2'}`}>{body}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2.5">
          <Button tone={store ? 'store' : 'brand'} onClick={action.onSelect}>
            {action.label}
          </Button>
          {secondary === undefined ? null : secondary.href !== undefined ? (
            <a href={secondary.href} onClick={(e) => { if (secondary.href?.startsWith('/')) { e.preventDefault(); secondary.onSelect(); } }} className="flex h-12 items-center rounded-control border border-control-line bg-surface px-5 font-semibold text-ink no-underline">
              {secondary.label}
            </a>
          ) : (
            <Button variant="secondary" onClick={secondary.onSelect}>
              {secondary.label}
            </Button>
          )}
        </div>
        {reference === undefined ? null : (
          <span className="mt-2 text-caption text-muted">
            Reference <span className="font-mono">{reference}</span>
          </span>
        )}
        {asked === undefined ? null : <span className="font-mono text-caption text-muted">{asked}</span>}
      </main>
    </div>
  );
}
