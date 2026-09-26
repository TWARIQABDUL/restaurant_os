// client/src/app/routes.tsx — milestone 16.
//
// The new app's routes. Until this milestone there was one screen and main.tsx rendered it directly; the
// storefront is the first thing with more than one place to be.
//
// THE STORE IS THE FIRST PATH SEGMENT — `/:store`, `/:store/p/:id` — which is Part 6's map, and it is the
// shape that survives Part 9's open domain question either way: if stores move to subdomains, the slug
// comes from the host instead and these routes lose a segment, which is one change here. Nothing else in
// the app knows where the slug came from, because §2.5 already forbids remembering it anywhere: "The store
// comes from the URL, never from a remembered slug."
//
// RESERVED SEGMENTS ARE NOT A PROBLEM THIS FILE HAS TO SOLVE. V001 refuses `api`, `signin`, `cart`,
// `checkout` and thirty others as slugs, at the column, "rather than discover it when a merchant picks
// one" — so /signin cannot collide with a store called signin.
//
// react-router, not a hand-rolled switch on window.location: the app needs real history, so that Back from
// a product returns to the grid with the filter and scroll intact, and so that a shared link to a product
// opens the product.

import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthPage } from '../auth/AuthPage.tsx';
import { Storefront } from '../storefront/Storefront.tsx';

/** `/:store` and `/:store/p/:productId`, both rendered by the same shell. */
function StoreRoute({ view }: { view: 'home' | 'product' }): ReactNode {
  const params = useParams();
  const navigate = useNavigate();
  const slug = params['store'];
  const productId = params['productId'];

  if (typeof slug !== 'string' || slug === '') return <Navigate to="/signin" replace />;

  return (
    <Storefront
      slug={slug}
      view={view === 'product' && typeof productId === 'string' ? { kind: 'product', productId } : { kind: 'home' }}
      navigate={(to) => navigate(to)}
    />
  );
}

export function AppRoutes(): ReactNode {
  return (
    <BrowserRouter>
      <Routes>
        {/* Auth keeps its own path handling for the invite token, which it reads from the URL itself. */}
        <Route path="/signin" element={<AuthPage />} />
        <Route path="/invite/:token" element={<AuthPage />} />

        <Route path="/:store" element={<StoreRoute view="home" />} />
        <Route path="/:store/p/:productId" element={<StoreRoute view="product" />} />

        {/* Nothing at the root yet: the platform's own marketing page is not part of this rewrite, and a
            shopper always arrives at a store. Sign-in is the one thing here that is always somewhere. */}
        <Route path="/" element={<Navigate to="/signin" replace />} />

        {/* Milestone 28 owns ErrorPages. Until then an unknown path goes where a person can act. */}
        <Route path="*" element={<Navigate to="/signin" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
