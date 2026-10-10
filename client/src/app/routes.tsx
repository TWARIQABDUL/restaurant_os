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
import { Onboarding } from '../onboarding/Onboarding.tsx';
import { Admin, SoonPage } from '../admin/Admin.tsx';
import type { AdminView } from '../admin/Admin.tsx';
import { AdminOrders } from '../admin/AdminOrders.tsx';
import { AdminSettings } from '../admin/AdminSettings.tsx';
import { AuditLog } from '../admin/AuditLog.tsx';
import { Currencies } from '../admin/Currencies.tsx';
import { Disputes } from '../admin/Disputes.tsx';
import { Kyc } from '../admin/Kyc.tsx';
import { PaymentMethods } from '../admin/PaymentMethods.tsx';
import { Payouts } from '../admin/Payouts.tsx';
import { Plans } from '../admin/Plans.tsx';
import { Team } from '../admin/Team.tsx';
import { Templates } from '../admin/Templates.tsx';
import { Merchants } from '../admin/Merchants.tsx';
import { Overview as AdminOverview } from '../admin/Overview.tsx';
import { Console } from '../console/Console.tsx';
import type { ConsoleView } from '../console/Console.tsx';
import { Rider } from '../rider/Rider.tsx';
import { Storefront } from '../storefront/Storefront.tsx';
import type { StorefrontView } from '../storefront/Storefront.tsx';

/** Every storefront path, rendered by the same shell — which is what loads the store once for all of them. */
function StoreRoute({ view }: { view: StorefrontView['kind'] }): ReactNode {
  const params = useParams();
  const navigate = useNavigate();
  const slug = params['store'];
  const productId = params['productId'];
  const code = params['code'];

  if (typeof slug !== 'string' || slug === '') return <Navigate to="/signin" replace />;

  const resolved: StorefrontView =
    view === 'product' && typeof productId === 'string'
      ? { kind: 'product', productId }
      : view === 'track' && typeof code === 'string'
        ? { kind: 'track', code }
        : view === 'cart'
          ? { kind: 'cart' }
          : view === 'checkout'
            ? { kind: 'checkout' }
            : view === 'account'
              ? { kind: 'account' }
              : { kind: 'home' };

  return <Storefront slug={slug} view={resolved} navigate={(to) => navigate(to)} />;
}

/**
 * The merchant console — milestone 19, and milestone 20's Orders board.
 *
 * `/app/:store`, and the slug is in the path for the same reason the storefront's is: §2.5's "the store comes
 * from the URL, never from a remembered slug". Milestone 15's Auth already lands here, sending an owner to
 * `/app/<slug>` and a manager to `/app/<slug>/orders`, so this path was settled before this screen existed.
 *
 * V010 stores a notification's destination as `/app/orders` — the store left out, because a notification belongs
 * to a store the reader is already inside. nav.ts's consoleHref() puts the slug back.
 */
function ConsoleRoute({ view }: { view: ConsoleView['kind'] }): ReactNode {
  const params = useParams();
  const navigate = useNavigate();
  const slug = params['store'];

  if (typeof slug !== 'string' || slug === '') return <Navigate to="/signin" replace />;

  // AddProduct is the one console screen that carries an id; `/products/new` has none, which is "New product".
  const productId = params['productId'];
  const resolved: ConsoleView =
    view === 'product' ? { kind: 'product', productId: typeof productId === 'string' ? productId : null } : { kind: view };

  return <Console slug={slug} view={resolved} navigate={(to) => navigate(to)} />;
}

/**
 * The rider's own app — milestone 21, Auth's own destination for a rider written at milestone 15
 * before this screen existed. `/rider/:store`, same reasoning as the console's `/app/:store`: the
 * store comes from the URL. 'rider' joined V001's reserved slugs at milestone 21 for the same reason
 * 'app' already was.
 */
function RiderRoute(): ReactNode {
  const params = useParams();
  const navigate = useNavigate();
  const slug = params['store'];

  if (typeof slug !== 'string' || slug === '') return <Navigate to="/signin" replace />;

  return <Rider slug={slug} navigate={(to) => navigate(to)} />;
}

/**
 * The Vendlyfy team's console (milestone 27). `/admin` is where Auth sends the team after the two-step code. `admin` is a
 * reserved slug (V001), so none of these can collide with a storefront. An address that matches none of them gets the console's own
 * "nothing here" inside the same frame, instead of the storefront's "No shop at this address".
 */
function AdminRoute({ view, active }: { view: AdminView; active: string }): ReactNode {
  const navigate = useNavigate();
  const go = (to: string): void => void navigate(to);
  const screens: Partial<Record<AdminView, ReactNode>> = {
    overview: <AdminOverview />,
    merchants: <Merchants />,
    kyc: <Kyc />,
    payouts: <Payouts />,
    disputes: <Disputes />,
    currencies: <Currencies />,
    payments: <PaymentMethods />,
    orders: <AdminOrders />,
    audit: <AuditLog />,
    settings: <AdminSettings navigate={go} />,
    team: <Team />,
    plans: <Plans />,
    industries: <Templates />,
  };
  return (
    <Admin view={view} active={active} navigate={go}>
      {() => screens[view] ?? <SoonPage label="Page not found" />}
    </Admin>
  );
}

function SignupRoute(): ReactNode {
  const navigate = useNavigate();
  return <Onboarding navigate={(to) => navigate(to)} />;
}

export function AppRoutes(): ReactNode {
  return (
    <BrowserRouter>
      <Routes>
        {/* Auth keeps its own path handling for the invite token, which it reads from the URL itself. */}
        <Route path="/signin" element={<AuthPage />} />
        <Route path="/invite/:token" element={<AuthPage />} />
        {/* Milestone 26: a stranger becomes a merchant. `signup` is reserved at the column (V001), so it cannot be a store. */}
        <Route path="/signup" element={<SignupRoute />} />
        <Route path="/admin" element={<AdminRoute view="overview" active="overview" />} />
        <Route path="/admin/merchants" element={<AdminRoute view="merchants" active="merchants" />} />
        <Route path="/admin/kyc" element={<AdminRoute view="kyc" active="kyc" />} />
        <Route path="/admin/payouts" element={<AdminRoute view="payouts" active="payouts" />} />
        <Route path="/admin/disputes" element={<AdminRoute view="disputes" active="disputes" />} />
        <Route path="/admin/currencies" element={<AdminRoute view="currencies" active="currencies" />} />
        <Route path="/admin/payments" element={<AdminRoute view="payments" active="payments" />} />
        <Route path="/admin/orders" element={<AdminRoute view="orders" active="orders" />} />
        <Route path="/admin/audit" element={<AdminRoute view="audit" active="audit" />} />
        <Route path="/admin/settings" element={<AdminRoute view="settings" active="settings" />} />
        <Route path="/admin/team" element={<AdminRoute view="team" active="team" />} />
        <Route path="/admin/plans" element={<AdminRoute view="plans" active="plans" />} />
        <Route path="/admin/industries" element={<AdminRoute view="industries" active="industries" />} />
        <Route path="/admin/:section" element={<AdminRoute view="soon" active="" />} />

        {/* The console, BEFORE the storefront's /:store — react-router prefers the more specific path either
            way, and V001 refuses `app` as a slug at the column, so the two cannot collide. */}
        <Route path="/app/:store" element={<ConsoleRoute view="dashboard" />} />
        <Route path="/app/:store/orders" element={<ConsoleRoute view="orders" />} />
        <Route path="/app/:store/riders" element={<ConsoleRoute view="riders" />} />
        <Route path="/app/:store/products" element={<ConsoleRoute view="products" />} />
        {/* "new" is matched before :productId because react-router ranks a literal segment above a param. */}
        <Route path="/app/:store/products/new" element={<ConsoleRoute view="product" />} />
        <Route path="/app/:store/products/:productId" element={<ConsoleRoute view="product" />} />
        <Route path="/app/:store/categories" element={<ConsoleRoute view="categories" />} />
        <Route path="/app/:store/money" element={<ConsoleRoute view="money" />} />
        <Route path="/app/:store/complaints" element={<ConsoleRoute view="complaints" />} />
        <Route path="/app/:store/reviews" element={<ConsoleRoute view="reviews" />} />
        <Route path="/app/:store/customers" element={<ConsoleRoute view="customers" />} />
        <Route path="/app/:store/analytics" element={<ConsoleRoute view="analytics" />} />
        <Route path="/app/:store/settings" element={<ConsoleRoute view="settings" />} />
        <Route path="/app/:store/verify" element={<ConsoleRoute view="verify" />} />
        <Route path="/app/:store/store-design" element={<ConsoleRoute view="design" />} />
        <Route path="/app/:store/store-design/theme" element={<ConsoleRoute view="theme" />} />

        {/* Same reasoning: 'rider' is reserved (V023), so this cannot collide with a storefront. */}
        <Route path="/rider/:store" element={<RiderRoute />} />

        <Route path="/:store" element={<StoreRoute view="home" />} />
        <Route path="/:store/p/:productId" element={<StoreRoute view="product" />} />
        <Route path="/:store/cart" element={<StoreRoute view="cart" />} />
        <Route path="/:store/checkout" element={<StoreRoute view="checkout" />} />
        <Route path="/:store/account" element={<StoreRoute view="account" />} />
        {/* The tracking code is the credential, so this route is openable cold from an SMS link. */}
        <Route path="/:store/orders/:code" element={<StoreRoute view="track" />} />

        {/* Nothing at the root yet: the platform's own marketing page is not part of this rewrite, and a
            shopper always arrives at a store. Sign-in is the one thing here that is always somewhere. */}
        <Route path="/" element={<Navigate to="/signin" replace />} />

        {/* Milestone 28 owns ErrorPages. Until then an unknown path goes where a person can act. */}
        <Route path="*" element={<Navigate to="/signin" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
