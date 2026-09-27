// client/src/storefront/Storefront.tsx — milestone 16.
//
// The shopfront's shell: it loads the store, applies its theme, and renders either the grid or one product.
//
// THE LOADING AND FAILURE STATES ARE THE BOARDS'. States.dc.html has words for each of them and its whole
// argument is that the wording IS the design, so a store that is loading says nothing and a store that is
// not there says what ErrorPages says.

import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Skeleton, StateCard } from '../shared/ui/index.ts';
import { StoreProvider } from './StoreProvider.tsx';
import type { LoadState } from './StoreProvider.tsx';
import { ShopHome } from './ShopHome.tsx';
import { ProductPage } from './ProductPage.tsx';
import { CartPage } from './CartPage.tsx';
import { CheckoutPage } from './CheckoutPage.tsx';
import { TrackPage } from './TrackPage.tsx';

export type StorefrontView =
  | { kind: 'home' }
  | { kind: 'product'; productId: string }
  | { kind: 'cart' }
  | { kind: 'checkout' }
  | { kind: 'track'; code: string };

type Props = {
  slug: string;
  view: StorefrontView;
  navigate: (to: string) => void;
};

/**
 * What a shopper sees while the three documents are in flight, and when they do not arrive.
 *
 * A SUSPENDED STORE AND A MISSING ONE GET DIFFERENT PAGES, which is what ErrorPages draws and what the
 * server's two codes are for. The suspended one names the store, because the shopper knows where they
 * meant to be.
 */
function fallback(slug: string, state: LoadState, retry: () => void): ReactNode {
  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-4 p-4" aria-busy="true">
        <Skeleton className="h-11 w-48" />
        <Skeleton className="h-12 w-full rounded-control" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {[0, 1, 2, 3].map((n) => (
            <Skeleton key={n} className="h-48 w-full rounded-card" />
          ))}
        </div>
      </div>
    );
  }

  // Narrowed by the early return above, but TypeScript needs the discriminant checked rather than
  // inferred from control flow across a return of a different branch.
  if (state.status !== 'failed') return null;
  const error: ApiFailure = state.error;

  if (error.code === 'STORE_SUSPENDED') {
    return (
      <div className="px-4 py-16">
        <StateCard
          tone="warn"
          icon="!"
          headline="This shop is closed"
          body={error.message}
          {...(error.hint === undefined ? {} : { reference: error.hint })}
        />
      </div>
    );
  }

  if (error.code === 'NO_SUCH_STORE' || error.code === 'INVALID_SLUG') {
    return (
      <div className="px-4 py-16">
        <StateCard
          tone="neutral"
          icon="?"
          headline="No shop at this address"
          body={`We couldn’t find a store at “${slug}”. Check the link, or ask the store for it again.`}
        />
      </div>
    );
  }

  return (
    <div className="px-4 py-16">
      <StateCard
        tone={error.code === 'OFFLINE' ? 'warn' : 'danger'}
        icon={error.code === 'OFFLINE' ? '⚡' : '!'}
        headline={error.code === 'OFFLINE' ? 'You’re offline' : 'That didn’t load'}
        body={error.message}
        action={{ label: 'Retry now', onSelect: retry }}
      />
    </div>
  );
}

export function Storefront({ slug, view, navigate }: Props): ReactNode {
  return (
    <StoreProvider slug={slug} fallback={(state, retry) => fallback(slug, state, retry)}>
      {view.kind === 'home' ? (
        <ShopHome
          onOpenProduct={(productId) => navigate(`/${slug}/p/${productId}`)}
          onOpenCart={() => navigate(`/${slug}/cart`)}
        />
      ) : view.kind === 'product' ? (
        <ProductPage
          productId={view.productId}
          onBack={() => navigate(`/${slug}`)}
          onOpenCart={() => navigate(`/${slug}/cart`)}
          onSignIn={() => navigate('/signin')}
        />
      ) : view.kind === 'cart' ? (
        <CartPage onBack={() => navigate(`/${slug}`)} onCheckout={() => navigate(`/${slug}/checkout`)} />
      ) : view.kind === 'checkout' ? (
        <CheckoutPage
          onBack={() => navigate(`/${slug}/cart`)}
          onHome={() => navigate(`/${slug}`)}
          onTrack={(code) => navigate(`/${slug}/orders/${code}`)}
          onSignIn={() => navigate('/signin')}
        />
      ) : (
        <TrackPage code={view.code} onHome={() => navigate(`/${slug}`)} />
      )}
    </StoreProvider>
  );
}
