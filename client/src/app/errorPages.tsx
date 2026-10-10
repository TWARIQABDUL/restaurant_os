// client/src/app/errorPages.tsx — milestone 28, from project/ErrorPages.dc.html: the four pages and the boundary that shows the 500.
//
//   ItemGonePage     "That item isn't on the menu any more"     INSIDE a store → the store's look, a way back to its menu
//   ServerErrorPage  "Something went wrong on our side"         any page → Vendlyfy's look, a reference, Try again
//   NoStorePage      "We can't find a store at this address"    Vendlyfy's look, and "Did you mean …?" when a live store is a typo away
//   SuspendedPage    "This store isn't taking orders right now" Vendlyfy's look; WHY is never shown to a customer
//
// TWO WORDS IN THE BOARD ARE NOT TRUE YET AND ARE NOT SAID. The suspended page promises "You'll get an SMS about it" and offers "Check an
// order"; there is no SMS until messaging has a provider, and a suspended store's tracking pages are refused with the rest of the
// store. So the page says the order and refund "are still being handled" and offers support — the part that is true.

import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { lookupApi } from './api.ts';
import { ErrorPage } from '../shared/ui/ErrorPage.tsx';

/** Vendlyfy's own number, as the Identity check's rejected page uses it. */
export const SUPPORT_TEL = 'tel:+250780000000';

const PLATFORM = { look: 'platform' as const, brand: 'Vendlyfy', mark: 'V' };

/** ERR-7F3A-21C9: random, not derived from anything about the person or the request. */
export function newReference(random: () => number = Math.random): string {
  const part = (): string => Math.floor(random() * 0x10000).toString(16).toUpperCase().padStart(4, '0');
  return `ERR-${part()}-${part()}`;
}

export function ItemGonePage({ storeName, mark, catalogWord, onMenu }: { storeName: string; mark: string; catalogWord: string; onMenu: () => void }): ReactNode {
  const word = catalogWord.toLowerCase();
  return (
    <ErrorPage
      look="store"
      brand={storeName}
      mark={mark}
      code="404"
      title={`That item isn’t on the ${word} any more`}
      body={`It may have been removed or renamed. Everything available today is on the ${word}.`}
      action={{ label: `See the ${word}`, onSelect: onMenu }}
    />
  );
}

export function ServerErrorPage({ reference, onRetry }: { reference: string; onRetry: () => void }): ReactNode {
  return (
    <ErrorPage
      {...PLATFORM}
      code="500"
      title="Something went wrong on our side"
      body="Your cart and any payment are safe. Nothing was charged twice. Try again in a moment."
      action={{ label: 'Try again', onSelect: onRetry }}
      reference={reference}
    />
  );
}

/** A path with more in it than a store address, which no store could own. */
export function NotFoundPage({ onHome }: { onHome: () => void }): ReactNode {
  return <ErrorPage {...PLATFORM} code="404" title="We can’t find that page" body="The link may be out of date or mistyped." action={{ label: 'Go to Vendlyfy', onSelect: onHome }} />;
}

export function NoStorePage({ slug, suggestion, onGo, onStart, asked }: { slug: string; suggestion: string | null; onGo: (slug: string) => void; onStart: () => void; asked?: string }): ReactNode {
  const host = typeof window === 'undefined' ? '' : window.location.host;
  return (
    <ErrorPage
      {...PLATFORM}
      code="?"
      title="We can’t find a store at this address"
      body={suggestion === null ? `Check the spelling of “${slug}”, or ask the store for its link again.` : <>Check the spelling. Did you mean <strong>{host === '' ? '' : `${host}/`}{suggestion}</strong>?</>}
      action={suggestion === null ? { label: 'Start your own store', onSelect: onStart } : { label: `Go to ${suggestion}`, onSelect: () => onGo(suggestion) }}
      {...(suggestion === null ? {} : { secondary: { label: 'Start your own store', onSelect: onStart } })}
      {...(asked === undefined ? {} : { asked })}
    />
  );
}

/** Looks up the near-miss once the page is up; the page is useful without it, so it never blocks. */
export function NoStore({ slug, onGo, onStart }: { slug: string; onGo: (slug: string) => void; onStart: () => void }): ReactNode {
  const [suggestion, setSuggestion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void lookupApi.nearStore(slug).then((r) => live && setSuggestion(r.slug)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [slug]);
  return <NoStorePage slug={slug} suggestion={suggestion} onGo={onGo} onStart={onStart} asked={typeof window === 'undefined' ? undefined : `${window.location.host}/${slug}`} />;
}

export function SuspendedPage({ asked }: { asked?: string }): ReactNode {
  return (
    <ErrorPage
      {...PLATFORM}
      code="—"
      title="This store isn’t taking orders right now"
      body="If you ordered here recently, your order and any refund are still being handled."
      action={{ label: 'Contact Vendlyfy support', onSelect: () => { window.location.assign(SUPPORT_TEL); } }}
      {...(asked === undefined ? {} : { asked })}
    />
  );
}

/**
 * The 500. A render error anywhere below this takes the page down to a screen a person can act on, with a reference that is also written
 * to the console — the one place a client crash can be found from a screenshot. It is not a try/catch around the network (every request
 * already turns a failure into a state); it is for the bug nobody expected.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { reference: string | null }> {
  override state = { reference: null as string | null };

  static getDerivedStateFromError(): { reference: string } {
    return { reference: newReference() };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[app] render error ${this.state.reference ?? ''}`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.reference === null) return this.props.children;
    return <ServerErrorPage reference={this.state.reference} onRetry={() => window.location.reload()} />;
  }
}
