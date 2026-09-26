// client/src/auth/AuthShell.tsx — milestone 15, from project/Auth.dc.html.
//
// The two-panel frame every step sits in: the explanation on the left, the form on the right. Below the
// breakpoint the left panel moves above the form rather than disappearing — the roles table is how
// somebody works out which of the four personas they are, and losing it on a phone loses the point.

import type { ReactNode } from 'react';

/** Auth's own roles table, verbatim. */
const ROLES: readonly { readonly name: string; readonly goes: string }[] = [
  { name: 'Store owners', goes: 'Dashboard, money, settings' },
  { name: 'Managers', goes: 'Orders, products, riders' },
  { name: 'Riders', goes: 'Their deliveries only' },
  { name: 'Vendlyfy team', goes: 'Admin console, with 2-step' },
];

export function AuthShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="min-h-dvh bg-ground font-sans text-body text-ink">
      <div className="mx-auto grid max-w-[1100px] gap-10 px-4 py-10 lg:grid-cols-2 lg:items-start lg:py-16">
        <section className="flex flex-col gap-5">
          <div>
            <span className="text-caption font-semibold uppercase tracking-[0.08em] text-muted">Vendlyfy</span>
            <h1 className="mt-2 font-display text-display leading-tight text-ink">
              One sign-in for owners, staff, riders and the Vendlyfy team.
            </h1>
            <p className="mt-2.5 text-title text-ink-2">
              After you sign in, Vendlyfy opens the right place for your role.
            </p>
          </div>

          <ul className="flex flex-col rounded-card border border-line bg-surface">
            {ROLES.map((role) => (
              <li
                key={role.name}
                className="flex flex-col gap-0.5 border-b border-line-subtle px-4 py-3 last:border-b-0 sm:flex-row sm:justify-between"
              >
                <strong className="text-body">{role.name}</strong>
                <span className="text-caption text-muted">{role.goes}</span>
              </li>
            ))}
          </ul>

          <p className="text-caption text-muted">
            Shopping at a store? Customers sign in on the store itself, at checkout or from the account icon.
          </p>
        </section>

        <main className="rounded-card border border-line bg-surface p-5 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

/** A step's heading and one line under it. Every step on the board has exactly this. */
export function StepHeading({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <header className="mb-4 flex flex-col gap-1">
      <h2 className="font-display text-heading text-ink">{title}</h2>
      {children === undefined ? null : <p className="text-caption text-muted">{children}</p>}
    </header>
  );
}
