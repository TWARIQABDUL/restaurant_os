// client/src/app/LandingPage.tsx — milestone 30's cutover gap: the platform's own marketing page at "/".
//
// §10/the implementation plan deliberately left this out of the rewrite ("the platform's own marketing
// page is not part of this rewrite, and a shopper always arrives at a store" — routes.tsx's own comment).
// "/" sent everyone straight to /signin. Built now because the cutover dropped index.html (the LEGACY
// marketing page, branded "Vendly") from the production build entirely, so "/" had nothing of its own —
// see client/vite.config.js's header for why that file had to go. This is NOT a transcription of a design
// board (none exists for this page); it is built from the platform's own token layer
// (client/src/styles/tokens.css) and shared/ui kit, the same way every other platform-look page is, so it
// reads as part of the same system as ErrorPage.tsx and the admin console rather than a bolted-on brochure.
//
// What it claims is restricted to what the platform actually does today: a store slug, a catalogue with
// stock that decrements itself, Urubuto Pay / MoMo / cash collection, a wallet with payouts, a live order
// board, rider dispatch, and the merchant console's own screens — no invented numbers, no feature that
// isn't built.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../shared/ui/Button.tsx';

const MARK = 'V';
const BRAND = 'Vendlyfy';

function Icon({ path }: { path: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="size-5" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  catalogue: 'M4 7h16M4 12h16M4 17h10',
  wallet: 'M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 4h18M16 13.5h2',
  stock: 'M21 8 12 3 3 8l9 5 9-5Zm0 0v8l-9 5-9-5V8M12 13v8',
  orders: 'M5 4h14v16l-4-2-3 2-3-2-4 2V4Z',
  rider: 'M6 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9 18h6m-6-6 3-6h4l3 6M9 12H5',
  analytics: 'M4 20V10M12 20V4m8 16v-7',
} as const;

const steps = [
  { number: 1, title: 'Add what you sell', description: 'Products, prices, photos and stock — set up in minutes, no code and no app download.' },
  { number: 2, title: 'Share your own link', description: `Every store gets a page at ${typeof window === 'undefined' ? 'vendlyfy.com' : window.location.host}/your-store. No marketplace fee comes out of your price.` },
  { number: 3, title: 'Take orders, get paid', description: 'Mobile money, bank transfer or cash on delivery — money lands in your wallet and stock updates itself.' },
];

const features: { icon: keyof typeof ICONS; title: string; description: string }[] = [
  { icon: 'catalogue', title: 'Your own catalogue', description: 'Products, categories and option groups — customers browse and buy from a page that carries your name, not ours.' },
  { icon: 'wallet', title: 'Payments that settle', description: 'Mobile Money, bank transfer or cash on delivery. Collections clear into a wallet you can withdraw from.' },
  { icon: 'stock', title: 'Stock that keeps itself', description: 'Every sale reserves and decrements stock atomically — two customers can never both buy the last one.' },
  { icon: 'orders', title: 'A live order board', description: 'Every order lands on one screen the moment it is placed, ready to accept, pack and hand off.' },
  { icon: 'rider', title: 'Rider dispatch', description: 'Assign your own riders or run cash hand-ins as a running account, and always know who is carrying what.' },
  { icon: 'analytics', title: 'Real numbers, not a spreadsheet', description: "See what's selling and how the day is going, right inside the console you already use to run it." },
];

const roles = [
  { title: 'Owners', description: 'Full control over the catalogue, pricing, stock, staff, payouts and store design.' },
  { title: 'Managers', description: 'Accept orders, run the fulfilment queue, and dispatch riders in real time.' },
  { title: 'Riders', description: "See assigned orders and hand-ins on a screen built for the road, not a desk." },
];

function Header(): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
      <div className="flex h-14 items-center justify-between px-5">
        <span className="flex items-center gap-2.5">
          <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-chip bg-ink font-display text-body font-bold text-ground">
            {MARK}
          </span>
          <strong className="font-display text-[18px]">{BRAND}</strong>
        </span>

        {/* Tablet and up: the full nav, every link a real 44px target. */}
        <nav className="hidden items-center gap-1 sm:flex">
          <a href="#how-it-works" className="flex h-11 items-center px-3 text-body font-semibold text-ink-2 no-underline">
            How it works
          </a>
          <a href="#features" className="flex h-11 items-center px-3 text-body font-semibold text-ink-2 no-underline">
            Features
          </a>
          <Link to="/signin" className="flex h-11 items-center rounded-control px-3 text-body font-semibold text-ink no-underline">
            Sign in
          </Link>
          <Link to="/signup">
            <Button tone="brand">Get started</Button>
          </Link>
        </nav>

        {/* Phone: the two anchor links move into a menu instead of disappearing. */}
        <div className="flex items-center gap-2 sm:hidden">
          <Link to="/signup">
            <Button tone="brand">Get started</Button>
          </Link>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="landing-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
            className="flex size-11 shrink-0 items-center justify-center rounded-control border border-control-line bg-surface"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" className="size-5" aria-hidden="true">
              {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>

      {open ? (
        <nav id="landing-menu" className="flex flex-col border-t border-line px-5 py-1.5 sm:hidden">
          <a href="#how-it-works" onClick={() => setOpen(false)} className="flex h-11 items-center text-body font-semibold text-ink-2 no-underline">
            How it works
          </a>
          <a href="#features" onClick={() => setOpen(false)} className="flex h-11 items-center text-body font-semibold text-ink-2 no-underline">
            Features
          </a>
          <Link to="/signin" onClick={() => setOpen(false)} className="flex h-11 items-center text-body font-semibold text-ink no-underline">
            Sign in
          </Link>
        </nav>
      ) : null}
    </header>
  );
}

export function LandingPage(): ReactNode {
  return (
    <div className="min-h-dvh bg-ground text-ink">
      <Header />

      {/* ── HERO ── */}
      <section className="mx-auto max-w-[760px] px-5 pb-14 pt-16 text-center sm:pt-24">
        <h1 className="m-0 font-display text-[36px] leading-[1.1] sm:text-display">
          Sell anything. Get paid. Track your stock.
        </h1>
        <p className="mx-auto mt-4 max-w-[480px] text-body leading-relaxed text-ink-2">
          {BRAND} gives any business its own ordering page, payments that actually clear, and stock that
          keeps itself — without stitching together five different tools.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link to="/signup">
            <Button tone="brand">Start selling</Button>
          </Link>
          <a href="#how-it-works" className="flex h-11 items-center rounded-control border border-control-line bg-surface px-[18px] text-body font-semibold text-ink no-underline">
            See how it works
          </a>
        </div>
        <p className="mt-4 text-caption text-muted">Live in under an hour · no marketplace cut</p>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section id="how-it-works" className="mx-auto max-w-[1040px] px-5 py-16">
        <h2 className="m-0 text-center font-display text-heading">Live in three steps</h2>
        <div className="mt-9 grid gap-5 sm:grid-cols-3">
          {steps.map((step) => (
            <div key={step.number} className="rounded-card border border-line bg-surface p-6">
              <span className="font-display text-[26px] font-bold text-brand">{String(step.number).padStart(2, '0')}</span>
              <h3 className="mt-2.5 text-title font-semibold">{step.title}</h3>
              <p className="mt-2 text-body leading-relaxed text-muted">{step.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section id="features" className="mx-auto max-w-[1040px] px-5 py-6">
        <h2 className="m-0 text-center font-display text-heading">Everything selling actually needs</h2>
        <div className="mt-9 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title}>
              <span className="flex size-10 items-center justify-center rounded-chip bg-brand-tint text-brand">
                <Icon path={ICONS[feature.icon]} />
              </span>
              <h3 className="mt-3.5 mb-1.5 text-title font-semibold">{feature.title}</h3>
              <p className="text-body leading-relaxed text-muted">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── ROLES ── */}
      <section className="mt-6 bg-surface py-16">
        <div className="mx-auto max-w-[1040px] px-5">
          <h2 className="m-0 text-center font-display text-heading">A screen for every role</h2>
          <div className="mt-9 grid gap-5 sm:grid-cols-3">
            {roles.map((role) => (
              <div key={role.title} className="rounded-card border border-line bg-ground p-6">
                <h3 className="m-0 text-title font-semibold">{role.title}</h3>
                <p className="mt-2 text-body leading-relaxed text-muted">{role.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="mx-auto max-w-[1040px] px-5 py-20 text-center">
        <div className="rounded-sheet bg-ink px-8 py-14 shadow-sheet">
          <h2 className="m-0 font-display text-heading text-ground">Ready to sell?</h2>
          <p className="mx-auto mt-3 max-w-[460px] text-body text-on-ink-muted">
            Add your products, share your link, and take your first paid order today.
          </p>
          <Link to="/signup" className="mt-6 inline-flex">
            <Button tone="brand">Start selling</Button>
          </Link>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1040px] flex-col items-center justify-between gap-3 px-5 py-7 text-caption text-muted sm:flex-row">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-chip bg-ink font-display text-[11px] font-bold text-ground">
              {MARK}
            </span>
            {BRAND}
          </span>
          <span>© {new Date().getFullYear()} {BRAND}. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}
