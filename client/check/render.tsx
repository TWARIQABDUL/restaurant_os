// client/check/render.tsx — milestone 14's render gate.
//
// `tsc` proves the types and `vite build` proves the JSX compiles and the imports resolve. Neither
// proves a component RUNS. This renders every part of the kit and all 28 states to static HTML and
// asserts on the result, so a component that throws on first render — a bad hook order, an index into
// an empty array — fails the build instead of the gallery.
//
// Built by Vite in SSR mode (`npm run ui:check` in client/) so it uses the same transform the app
// does. renderToStaticMarkup runs no effects, which is why the overlays below render closed: that is
// their correct initial state, and it is the state a first paint has to get right.

import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { ALL_STATES, ADMIN_STATES, PRODUCT_STATES } from '../src/shared/states/index.tsx';
import { ComponentSheet } from '../src/gallery/ComponentSheet.tsx';
import { AdminStateSheet, ProductStateSheet } from '../src/gallery/StateSheet.tsx';
import { TokenSheet } from '../src/gallery/TokenSheet.tsx';
import { AuthShell, StepHeading } from '../src/auth/AuthShell.tsx';
import {
  CodeStep,
  ForgotStep,
  NewPasswordStep,
  RoutedStep,
  SignInStep,
  StorePickerStep,
} from '../src/auth/steps.tsx';
import { evaluateRules } from '../src/auth/passwordRules.ts';
import { StoreContext } from '../src/storefront/StoreProvider.tsx';
import type { StoreContextValue } from '../src/storefront/StoreProvider.tsx';
import type { ProductDetailData, StoreFace } from '../src/storefront/api.ts';
import { CategoryNav, PromoBanner, SearchField, StoreHeader, StoreInfo, fulfilmentLine, hoursLines, openLabel } from '../src/storefront/ShopChrome.tsx';
import { OptionSheet, availableValues, matchVariant, unitPriceOf } from '../src/storefront/OptionSheet.tsx';
import { CartSummary, StickyCartBar } from '../src/storefront/CartViews.tsx';
import { ratingLine, relativeDay } from '../src/storefront/ProductPage.tsx';
import { CartPage } from '../src/storefront/CartPage.tsx';
import { CheckoutPage } from '../src/storefront/CheckoutPage.tsx';
import { TrackPage, customerSteps, isStopped, stepIndexFor } from '../src/storefront/TrackPage.tsx';
import { AccountPage, complaintBadge, orderBadge } from '../src/storefront/AccountPage.tsx';
import { SignInSheet } from '../src/storefront/SignInSheet.tsx';
import { ComplaintSheet } from '../src/storefront/ComplaintSheet.tsx';
import { tileFor } from '../src/storefront/tiles.ts';
import { ShellContext } from '../src/console/ShellProvider.tsx';
import type { ShellContextValue } from '../src/console/ShellProvider.tsx';
import type { DashboardData, OrderAlert as OrderAlertData } from '../src/console/api.ts';
import { MobileTabs, Sidebar } from '../src/console/Sidebar.tsx';
import { Dashboard } from '../src/console/Dashboard.tsx';
import { NotificationsPanel } from '../src/console/NotificationsPanel.tsx';
import { OrderAlert } from '../src/console/OrderAlert.tsx';
import { Console } from '../src/console/Console.tsx';
import { MOBILE_TABS, NAV_GROUPS, consoleHref, hrefFor, maySee } from '../src/console/nav.ts';
import { dateline, greeting, notificationLine, relativeWhen, toneClasses, waitingClock } from '../src/console/lines.ts';
import { formatMoney } from '../src/app/core.ts';

const problems: string[] = [];
let checks = 0;

function expect(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) problems.push(message);
}

function render(what: string, node: ReactNode): string {
  try {
    const html = renderToStaticMarkup(node);
    checks += 1;
    if (html.length === 0) problems.push(`${what} rendered nothing`);
    return html;
  } catch (error) {
    problems.push(`${what} threw: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

// --- the counts the boards fix -------------------------------------------------
expect(PRODUCT_STATES.length === 20, `States.dc.html draws 20; found ${PRODUCT_STATES.length}`);
expect(ADMIN_STATES.length === 8, `AdminStates.dc.html draws 8; found ${ADMIN_STATES.length}`);
expect(ALL_STATES.length === 28, `expected 28 states in total; found ${ALL_STATES.length}`);
expect(
  PRODUCT_STATES.filter((s) => s.side === 'customer').length === 16,
  'States.dc.html has 16 customer states',
);
expect(
  PRODUCT_STATES.filter((s) => s.side === 'merchant').length === 4,
  'States.dc.html has 4 merchant states',
);

// --- every state renders, and says something ----------------------------------
for (const state of ALL_STATES) {
  const html = render(`state "${state.name}" (${state.where})`, state.render());
  // A state card with no text is the failure mode that would otherwise look fine: the pattern is
  // "headline, one line of reason, at most two actions", and all of it is text.
  const text = html.replace(/<[^>]+>/g, '').trim();
  expect(text.length > 20, `state "${state.name}" rendered almost no text`);
}

// --- no duplicate names within a board ----------------------------------------
for (const [label, list] of [
  ['States.dc.html', PRODUCT_STATES],
  ['AdminStates.dc.html', ADMIN_STATES],
] as const) {
  const names = list.map((s) => s.name);
  expect(new Set(names).size === names.length, `${label} has a duplicate state name`);
}

// --- the sheets render --------------------------------------------------------
const sheets = [
  ['TokenSheet', <TokenSheet />],
  ['ComponentSheet', <ComponentSheet />],
  ['ProductStateSheet', <ProductStateSheet />],
  ['AdminStateSheet', <AdminStateSheet />],
] as const;

let allHtml = '';
/** Everything except the token sheet — see the hex assertion below for why it is excluded. */
let kitHtml = '';
for (const [name, node] of sheets) {
  const html = render(name, node);
  allHtml += html;
  if (name !== 'TokenSheet') kitHtml += html;
}

// --- milestone 15: Auth's steps ----------------------------------------------
//
// Rendered the same way as the states: if a step throws on first paint, the build fails rather than the
// page. AuthPage itself is not rendered here — it calls the API on mount, and a render gate that needed a
// server would stop being a build-time check.
const RULES = ['At least 8 characters', 'Includes a number', 'Not your phone number or store name'];
const noop = (): void => undefined;

const authSteps: readonly (readonly [string, ReactNode])[] = [
  ['Auth · shell', <AuthShell><StepHeading title="Sign in">Use the email or phone number you were invited with.</StepHeading></AuthShell>],
  ['Auth · sign in', <SignInStep error={null} busy={false} onSubmit={noop} onForgot={noop} />],
  ['Auth · sign in, session expired', <SignInStep notice="You were signed out after a while without activity." error={null} busy={false} onSubmit={noop} onForgot={noop} />],
  ['Auth · sign in, busy', <SignInStep error={null} busy onSubmit={noop} onForgot={noop} />],
  ['Auth · sign in, failed', <SignInStep error={{ message: 'That email or password is not right.' }} busy={false} onSubmit={noop} onForgot={noop} />],
  [
    'Auth · which store',
    <StorePickerStep
      memberships={[
        { storeId: 'a', slug: 'nyama', name: 'Nyama & Co.', role: 'owner' },
        { storeId: 'b', slug: 'inzu', name: 'Inzu Threads', role: 'manager' },
      ]}
      onPick={noop}
    />,
  ],
  ['Auth · two-step', <CodeStep title="Confirm it’s you" sub="Vendlyfy team accounts need a second step." error={null} busy={false} resendLabel="Send again" onSubmit={noop} onResend={noop} onBack={noop} />],
  ['Auth · forgot', <ForgotStep error={null} busy={false} onSubmit={noop} onBack={noop} />],
  ['Auth · new password', <NewPasswordStep title="Choose a new password" sub="This signs you out on every other device." cta="Save password" rules={RULES} context={{}} error={null} busy={false} onSubmit={noop} />],
  ['Auth · invite', <NewPasswordStep title="Join Nyama & Co." sub="Aline Uwase invited Patrick Niyonzima as a manager." cta="Join and sign in" rules={RULES} context={{ storeName: 'Nyama & Co.' }} error={null} busy={false} onSubmit={noop} />],
  ['Auth · invite, rider', <NewPasswordStep title="Join Nyama & Co." sub="Invited as a rider." cta="Join and sign in" rules={RULES} context={{}} error={null} busy={false} needsPlate onSubmit={noop} />],
  ['Auth · routed, owner', <RoutedStep title="Welcome back, Aline" sub="Opening the Nyama & Co. dashboard." cta="Go to dashboard" onContinue={noop} />],
];

for (const [name, node] of authSteps) allHtml += render(name, node);

expect(authSteps.length >= 12, `Auth has ${authSteps.length} steps rendered`);

// The password checklist has to evaluate locally, because the board ticks it as you type.
expect(evaluateRules(RULES, '').every((r) => !r.passed), 'an empty password passes no rule');
expect(evaluateRules(RULES, 'correct-horse-42').every((r) => r.passed), 'a good one passes all three');
expect(
  evaluateRules(RULES, 'nyama2024', { storeName: 'Nyama & Co.' })[2]?.passed === false,
  'the store name is refused locally as well as on the server',
);

// --- milestone 16: the storefront ---------------------------------------------
//
// THE PURE PARTS ARE ASSERTED, NOT JUST RENDERED. Most of what could be wrong on a shopfront is not
// "does this throw" but "is the right size struck through" — so the functions that decide that are
// checked against the boards' OWN fixtures: Shop.dc.html's clothing store, with XL sold out.

/** Shop.dc.html's clothing product, as the schema would hold it: two pick-one groups, one gap. */
const TEE: ProductDetailData = {
  id: 'tee',
  name: 'Everyday T-Shirt',
  description: 'Sizes S · M · L · XL',
  price: '15000.00',
  compareAtPrice: null,
  coverImageUrl: null,
  defaultVariantId: 'v-s-black',
  hasChoices: true,
  hasExtras: false,
  stock: { soldOut: false, lowStock: true, fewestLeft: 1 },
  rating: null,
  trackStock: true,
  categoryIds: [],
  groups: [
    {
      id: 'size',
      name: 'Size',
      selectMode: 'one',
      isRequired: true,
      values: [
        { id: 's', label: 'S', priceDelta: '0.00', isAvailable: true },
        { id: 'm', label: 'M', priceDelta: '0.00', isAvailable: true },
        { id: 'xl', label: 'XL', priceDelta: '0.00', isAvailable: true },
      ],
    },
    {
      id: 'colour',
      name: 'Color',
      selectMode: 'one',
      isRequired: true,
      values: [
        { id: 'black', label: 'Black', priceDelta: '0.00', isAvailable: true },
        { id: 'white', label: 'White', priceDelta: '0.00', isAvailable: true },
      ],
    },
  ],
  // S and M in both colours; XL only in black, and that one is counted down to nothing. So XL is
  // reachable as a size only while nothing else rules it out, and XL/white never exists at all.
  variants: [
    { id: 'v-s-black', sku: 'TS-BLK-S', stockQuantity: 4, isAvailable: true, isDefault: true, optionValueIds: ['s', 'black'] },
    { id: 'v-s-white', sku: 'TS-WHT-S', stockQuantity: 2, isAvailable: true, isDefault: false, optionValueIds: ['s', 'white'] },
    { id: 'v-m-black', sku: 'TS-BLK-M', stockQuantity: 0, isAvailable: true, isDefault: false, optionValueIds: ['m', 'black'] },
    { id: 'v-m-white', sku: 'TS-WHT-M', stockQuantity: 5, isAvailable: true, isDefault: false, optionValueIds: ['m', 'white'] },
    { id: 'v-xl-black', sku: 'TS-BLK-XL', stockQuantity: 0, isAvailable: true, isDefault: false, optionValueIds: ['xl', 'black'] },
  ],
};

/** A burger: no dimensions, one default variant, priced extras. */
const BURGER: ProductDetailData = {
  ...TEE,
  id: 'burger',
  name: 'Chicken Burger',
  price: '3500.00',
  trackStock: false,
  hasChoices: false,
  hasExtras: true,
  defaultVariantId: 'v-burger',
  stock: { soldOut: false, lowStock: false, fewestLeft: null },
  groups: [
    {
      id: 'extras',
      name: 'Extras',
      selectMode: 'several',
      isRequired: false,
      values: [
        { id: 'cheese', label: 'Cheese', priceDelta: '500.00', isAvailable: true },
        { id: 'fries', label: 'Fries', priceDelta: '1000.00', isAvailable: true },
      ],
    },
  ],
  variants: [
    { id: 'v-burger', sku: null, stockQuantity: null, isAvailable: true, isDefault: true, optionValueIds: [] },
  ],
};

// Nothing chosen: every size with at least one buyable variant, and both colours.
{
  const open = availableValues(TEE, {});
  expect(open.has('s'), 'S has stock in both colours, so it is pickable');
  expect(open.has('m'), 'M is out in black but in stock in white, so the SIZE is still pickable');
  expect(!open.has('xl'), 'XL exists only in black, and that one is out — so XL is struck through');
}

// Choose black, and M becomes unpickable: M/black is the combination with nothing left.
{
  const inBlack = availableValues(TEE, { colour: ['black'] });
  expect(inBlack.has('s'), 'S/black has four left');
  expect(!inBlack.has('m'), 'M/black is out, so M is struck through once black is chosen');
  expect(!inBlack.has('xl'), 'XL/black is out too');
}

// Choose M, and black becomes unpickable — the same rule read the other way round.
{
  const inM = availableValues(TEE, { size: ['m'] });
  expect(!inM.has('black'), 'M/black is out, so black is struck through once M is chosen');
  expect(inM.has('white'), 'M/white has five left');
}

// A combination the merchant never created is not a hole to be discovered at checkout.
expect(matchVariant(TEE, { size: ['xl'], colour: ['white'] }) === null, 'XL/white does not exist');
expect(matchVariant(TEE, { size: ['s'], colour: ['black'] })?.id === 'v-s-black', 'S/black is one variant');
expect(matchVariant(TEE, { size: ['s'] }) === null, 'a variant needs every pick-one group answered');
expect(matchVariant(BURGER, {})?.id === 'v-burger', 'a product with no dimensions has its default');

// Extras are priced per line; dimensions are not.
expect(unitPriceOf(BURGER, {}) === '3500.00', 'no extras, base price');
expect(unitPriceOf(BURGER, { extras: ['cheese'] }) === '4000.00', 'cheese is +500');
expect(unitPriceOf(BURGER, { extras: ['cheese', 'fries'] }) === '5000.00', 'cheese and fries are +1,500');
expect(unitPriceOf(TEE, { size: ['s'], colour: ['black'] }) === '15000.00', 'a size costs nothing extra');

/** Declared here because the fulfilment assertions below need them before the full FACE fixture. */
const CURRENCY_FOR_LINE = { code: 'RWF', symbol: 'RWF', symbolPosition: 'after' as const, decimals: 0, thousandsSeparator: ',', cashRounding: 0 };
const FACE_FOR_LINE = {
  delivery: { fromFee: '1000.00', etaMinMinutes: 25, etaMaxMinutes: 35, zoneCount: 2 },
  pickup: { address: 'KG 7 Ave, Kacyiru', readyMinutes: 15, instructions: null },
} as StoreFace;

// V009's rule, as the line beside the price.
expect(ratingLine({ reviewCount: 0, averageRating: null, counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }).text === 'New · no reviews yet', 'no reviews');
expect(
  ratingLine({ reviewCount: 2, averageRating: null, counts: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 } }).text ===
    '2 reviews · too few for a rating',
  'below the threshold the count is shown, never an average',
);
expect(
  ratingLine({ reviewCount: 3, averageRating: '3.7', counts: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 } }).text === '★ 3.7 (3)',
  'at three reviews the average appears',
);

// The open/closed sentence, from V018's answer.
expect(openLabel({ isOpen: true, closesAt: '22:00', opensAt: '10:00', opensOn: 1 }, 1) === 'Open · closes 22:00', 'the board\'s own open line');
expect(openLabel({ isOpen: false, closesAt: null, opensAt: '10:00', opensOn: 1 }, 1) === 'Closed · opens 10:00', 'shut, opening later today');
expect(
  openLabel({ isOpen: false, closesAt: null, opensAt: '10:00', opensOn: 1 }, 7) === 'Closed · opens Mon 10:00',
  'shut until another day, which needs the day named',
);
expect(openLabel({ isOpen: false, closesAt: null, opensAt: null, opensOn: null }, 3) === 'Closed', 'a store with no hours at all');

// "Daily 10:00–22:00" rather than seven identical lines.
const daily: StoreFace['hours'] = [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, opensAt: '10:00', closesAt: '22:00' }));
expect(hoursLines(daily).length === 1 && hoursLines(daily)[0] === 'Daily 10:00–22:00', 'seven identical days collapse');
const sixDays = daily.slice(0, 6);
expect(hoursLines(sixDays)[0] === 'Mon–Sat 10:00–22:00', 'a run of days collapses into a range');
expect(hoursLines([]).length === 0, 'no hours is no lines, not an empty one');
const split: StoreFace['hours'] = [
  { dayOfWeek: 1, opensAt: '10:00', closesAt: '22:00' },
  { dayOfWeek: 2, opensAt: '10:00', closesAt: '22:00' },
  { dayOfWeek: 5, opensAt: '18:00', closesAt: '01:00' },
];
expect(hoursLines(split).length === 2, 'a gap in the week breaks the run');
expect(hoursLines(split)[1] === 'Fri 18:00–01:00', 'and a past-midnight day is written as it is stored');

// The fulfilment line, which both boards write above the grid.
expect(
  fulfilmentLine(FACE_FOR_LINE, (amount) => formatMoney(amount, CURRENCY_FOR_LINE), () => true) ===
    'Delivery 25–35 min · from 1,000 RWF · Pickup in 15 min',
  'the delivery and pickup line is the boards\' own, in their order',
);
expect(
  fulfilmentLine(FACE_FOR_LINE, (amount) => formatMoney(amount, CURRENCY_FOR_LINE), (module) => module !== 'pickup') ===
    'Delivery 25–35 min · from 1,000 RWF',
  'a store without the pickup module says nothing about pickup',
);

// A tile is stable for a product and spread across the palette.
expect(tileFor('a-product-id').background === tileFor('a-product-id').background, 'the same product keeps its tile');
expect(new Set(Array.from({ length: 40 }, (_, n) => tileFor(`33333333-0000-4000-8000-0000000000${n}`).background)).size >= 5, 'tiles are spread, not all one colour');

// "Today", "2 days ago" — the board's own scale.
expect(relativeDay(new Date().toISOString()) === 'Today', 'today');
expect(relativeDay(new Date(Date.now() - 2 * 86_400_000).toISOString()) === '2 days ago', 'two days');
expect(relativeDay(new Date(Date.now() - 21 * 86_400_000).toISOString()) === '3 weeks ago', 'three weeks');

// --- and every storefront component renders -----------------------------------
const FACE: StoreFace = {
  store: { id: 's', slug: 'nyama', name: 'Nyama & Co.', currency: 'RWF', country: 'RW', phone: '+250 78 000 0000' },
  open: { isOpen: true, closesAt: '22:00', opensAt: '10:00', opensOn: 1 },
  hours: daily,
  delivery: { fromFee: '1000.00', etaMinMinutes: 25, etaMaxMinutes: 35, zoneCount: 2 },
  pickup: { address: 'KG 7 Ave, Kacyiru', readyMinutes: 15, instructions: null },
  banner: { promotionId: 'p', title: 'Two burgers, free fries', subtitle: 'Weekdays 12:00–15:00. Added automatically at checkout.' },
  categories: [
    { id: 'burgers', name: 'Burgers', description: '', imageUrl: null, productCount: 2 },
    { id: 'sides', name: 'Sides', description: '', imageUrl: null, productCount: 3 },
  ],
};

const CURRENCY = CURRENCY_FOR_LINE;

const STORE_VALUE: StoreContextValue = {
  face: FACE,
  currency: CURRENCY,
  // The real vocabulary and gates come from the config engine; the gate only needs them to answer.
  t: ((key: string, form?: string) => (form === 'one' ? key : `${key}s`)) as StoreContextValue['t'],
  has: () => true,
  // Food's steps, from V002's own template — which is what the tracking timeline renders.
  orderSteps: [
    { key: 'new', label: 'New' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'ready', label: 'Ready' },
    { key: 'delivered', label: 'Delivered' },
  ],
  money: (amount) => formatMoney(amount, CURRENCY),
  cart: {
    id: 'cart',
    itemCount: 3,
    subtotal: '9500.00',
    expiresAt: null,
    lines: [
      {
        id: 'l1',
        variantId: 'v',
        productId: 'p1',
        productName: 'Chicken Burger',
        optionLabels: ['Medium', 'Cheese'],
        quantity: 2,
        unitPrice: '4000.00',
        lineTotal: '8000.00',
        coverImageUrl: null,
        unavailable: false,
      },
      {
        id: 'l2',
        variantId: 'v2',
        productId: 'p2',
        productName: 'Fries',
        optionLabels: [],
        quantity: 1,
        unitPrice: '1500.00',
        lineTotal: '1500.00',
        coverImageUrl: null,
        // The state States.dc.html draws, which milestone 17's cart screen has to resolve.
        unavailable: true,
      },
    ],
  },
  setCart: noop,
  refreshCart: noop,
};

function inStore(node: ReactNode): ReactNode {
  return <StoreContext.Provider value={STORE_VALUE}>{node}</StoreContext.Provider>;
}

const storefrontParts: readonly (readonly [string, ReactNode])[] = [
  ['Shop · header', inStore(<StoreHeader query="" onSearch={noop} cartCount={3} onCart={noop} today={1} />)],
  ['Shop · search', <SearchField value="" onChange={noop} placeholder="Search the menu" />],
  ['Shop · promo banner', <PromoBanner title={FACE.banner?.title ?? null} subtitle={FACE.banner?.subtitle ?? null} />],
  ['Shop · categories', <CategoryNav categories={FACE.categories} active={null} onPick={noop} allLabel="Menu" totalCount={null} />],
  ['StoreDesktop · store info', inStore(<StoreInfo />)],
  ['StoreDesktop · cart aside', inStore(<CartSummary onCheckout={noop} />)],
  ['Shop · sticky cart bar', inStore(<StickyCartBar onOpen={noop} />)],
  // The sheet renders CLOSED, which is its correct initial state: renderToStaticMarkup runs no effects,
  // so a <dialog> that only opens in one is exactly what a first paint should produce.
  ['Shop · option sheet', inStore(<OptionSheet product={TEE} open onClose={noop} onAdd={noop} />)],
  ['Shop · option sheet, refused', inStore(<OptionSheet product={BURGER} open onClose={noop} onAdd={noop} error="Chicken Burger is sold out" />)],
];

for (const [name, node] of storefrontParts) {
  const html = render(name, node);
  allHtml += html;
  kitHtml += html;
}

expect(storefrontParts.length >= 9, `the storefront has ${storefrontParts.length} parts rendered`);

// --- milestone 17: checkout ----------------------------------------------------
//
// The timeline is the piece worth asserting rather than eyeballing: it is the one place a customer is told
// where their order is, and the mapping from V004's twelve statuses to a template's four steps is an ANSWER
// to a Part 9 question rather than something the boards settled.

/** V002's own two, which differ in their third step — which is the whole point of reading them from config. */
const FOOD_STEPS = [
  { key: 'new', label: 'New' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'ready', label: 'Ready' },
  { key: 'delivered', label: 'Delivered' },
];
const FASHION_STEPS = [
  { key: 'new', label: 'New' },
  { key: 'packed', label: 'Packed' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'delivered', label: 'Delivered' },
];

// A customer is not shown that a merchant pressed Accept.
expect(stepIndexFor('pending') === 0, 'a new order is at the first step');
expect(stepIndexFor('approved') === 0, 'accepted is still the first step to a customer');
expect(stepIndexFor('preparing') === 1, 'preparing is the second');
expect(stepIndexFor('ready') === 2 && stepIndexFor('assigned') === 2 && stepIndexFor('out') === 2,
  'ready, assigned and out are all the third step — the shop is done with it');
expect(stepIndexFor('delivered') === 3 && stepIndexFor('collected') === 3, 'both endings are the last step');
for (const stopped of ['rejected', 'cancelled', 'returned', 'closed_return']) {
  expect(stepIndexFor(stopped) === null, `${stopped} has no step on the timeline`);
  expect(isStopped(stopped), `${stopped} ends the order`);
}
expect(!isStopped('out'), 'an order on its way has not stopped');

// The payment step is inserted second, and ONLY for an order paid online.
{
  const online = customerSteps(FOOD_STEPS, true);
  expect(online.length === 5, 'an online order has the template four plus Payment confirmed');
  expect(online[1]?.key === 'payment_confirmed', 'and it goes second, where the board draws it');
  expect(online[1]?.isPayment === true, 'it is marked as the payment step, not a status step');
  expect(online[1]?.fromStatus === null, 'because no status advances it — payment_status does');

  const cash = customerSteps(FOOD_STEPS, false);
  expect(cash.length === 4, 'a cash order has no payment step: the money arrives at the door');
  expect(cash.every((step) => !step.isPayment), 'and nothing on its timeline sits unticked all journey');
}

// The LABELS are the template's, which is the claim Industries makes.
expect(
  customerSteps(FASHION_STEPS, false).map((s) => s.label).join(' → ') ===
    'New → Packed → Out for delivery → Delivered',
  'a fashion store gets its own words',
);
expect(
  customerSteps(FOOD_STEPS, false).map((s) => s.label).join(' → ') === 'New → Preparing → Ready → Delivered',
  'and a restaurant gets its own',
);
// Same component, same mapping, different words — with no branch on an industry anywhere.
expect(
  customerSteps(FOOD_STEPS, false).map((s) => s.fromStatus).join(',') ===
    customerSteps(FASHION_STEPS, false).map((s) => s.fromStatus).join(','),
  'the positions are identical across industries; only the labels differ',
);
expect(customerSteps([], true).length === 0, 'a template with no steps produces no timeline');

const checkoutParts: readonly (readonly [string, ReactNode])[] = [
  ['Shop · cart', inStore(<CartPage onBack={noop} onCheckout={noop} />)],
  ['Shop · checkout', inStore(<CheckoutPage onBack={noop} onHome={noop} onTrack={noop} onAccount={noop} />)],
  // The tracking page renders its loading state here: it fetches on mount, and renderToStaticMarkup runs no
  // effects. That IS the first paint, and getting it right is what this gate is for.
  ['Shop · tracking', inStore(<TrackPage code={'a'.repeat(32)} onHome={noop} />)],
];

// --- milestone 18: the account ------------------------------------------------
//
// The badge rules are what is worth asserting: "Reopened" rather than "Sent to the store" once a complaint has
// been round the loop, which is the difference V008's reopened_count exists to record.
{
  const base = {
    id: 'c1',
    reference: 44,
    orderNumber: 990,
    trackingCode: 'trk_000000000001',
    reasonCode: 'arrived_late',
    detail: 'It was an hour late.',
    storeReply: null,
    reopenedCount: 0,
    createdAt: new Date().toISOString(),
    canReopen: false,
  };

  expect(
    complaintBadge({ ...base, status: 'open' }).label === 'Sent to the store',
    'a fresh complaint reads as sent',
  );
  expect(
    complaintBadge({ ...base, status: 'open', reopenedCount: 1 }).label === 'Reopened',
    'and the SAME status reads as Reopened once it has been round the loop — reopened_count is why',
  );
  expect(complaintBadge({ ...base, status: 'resolved' }).label === 'Resolved', 'resolved');
  expect(
    complaintBadge({ ...base, status: 'escalated' }).label === 'With Vendlyfy',
    'escalated is named for who has it, because that is what the customer needs to know',
  );
  expect(complaintBadge({ ...base, status: 'rejected' }).label === 'Not accepted', 'rejected');
}

{
  const order = {
    trackingCode: 'trk_000000000001',
    orderNumber: 1026,
    paymentStatus: 'unpaid',
    paymentMethod: 'cash',
    total: '12000.00',
    placedAt: new Date().toISOString(),
    summary: '2× Chicken burger',
    itemCount: 2,
  };
  expect(orderBadge({ ...order, status: 'out' }).tone === 'progress',
    'an order on its way uses Main\'s sixth status tone, which milestone 14 added for exactly this');
  expect(orderBadge({ ...order, status: 'delivered' }).label === 'Delivered', 'delivered');
  expect(orderBadge({ ...order, status: 'collected' }).label === 'Delivered',
    'and a collected order says the same thing to a customer who has it');
  expect(orderBadge({ ...order, status: 'pending' }).label === 'In progress',
    'every step before it leaves is "in progress" — a customer does not need the merchant\'s state machine');
  expect(orderBadge({ ...order, status: 'cancelled' }).tone === 'danger', 'cancelled');
}

const accountParts: readonly (readonly [string, ReactNode])[] = [
  ['CustomerAccount · account', inStore(<AccountPage onHome={noop} onOpenOrder={noop} onSignIn={noop} />)],
  ['CustomerAccount · sign-in sheet', inStore(<SignInSheet open onClose={noop} onSignedIn={noop} />)],
  [
    'CustomerAccount · report a problem',
    inStore(<ComplaintSheet open onClose={noop} orderNumber={990} trackingCode={'a'.repeat(32)} onFiled={noop} />),
  ],
];

for (const [name, node] of [...checkoutParts, ...accountParts]) {
  const html = render(name, node);
  allHtml += html;
  kitHtml += html;
}


// --- milestone 19: the merchant console ---------------------------------------
//
// THE SENTENCES ARE THE THING WORTH ASSERTING HERE. V010 stores a notification's VALUES and never its words, so
// lines.ts writes every sentence in the console's inbox — which makes it the one place where a wrong key or a
// missing branch shows up as a blank row in front of a merchant. All eight seeded types are checked, and so is
// the ninth case: a type this build has never heard of.
{
  const line = (type: string, payload: Record<string, unknown>) =>
    notificationLine(
      {
        id: 'n',
        type,
        tone: 'info',
        route: '/app/orders',
        payload,
        orderId: null,
        complaintId: null,
        reviewId: null,
        withdrawalId: null,
        unread: true,
        createdAt: new Date().toISOString(),
      },
      CURRENCY,
    );

  const placed = line('order_placed', { order_number: 1031, total_amount: '8500', customer_name: 'Aimable K.' });
  expect(placed.title === 'New order #1031 · 8,500 RWF', `the new-order line is the board's: ${placed.title}`);
  expect(
    placed.sub === 'Aimable K. · waiting for you to accept',
    `and so is its second line: ${placed.sub}`,
  );

  // The board writes "Eric picked up #1026" where the payload holds a full name.
  expect(
    line('order_picked_up', { order_number: 1026, rider_name: 'Claude Habineza' }).title === 'Claude picked up #1026',
    'a rider is named by their first name, as the board does',
  );

  expect(line('order_delivered', { order_number: 1024, customer_name: 'Sandrine K.' }).title === '#1024 delivered', 'delivered');
  expect(
    line('order_declined', { order_number: 1022, actor_name: 'Patrick Mukama', reason: 'An item is out of stock' })
      .title === '#1022 declined by Patrick',
    'a decline names who did it',
  );

  // The reason arrives as V008's code and is shown in the words the customer picked from.
  expect(
    line('complaint_filed', { order_number: 1023, reason: 'item_missing', customer_name: 'Pacifique I.' }).sub ===
      'Missing item · Pacifique I.',
    'a complaint reason is a code in the database and a phrase on the screen',
  );

  expect(
    line('review_posted', { rating: 2, product_name: 'Grilled chicken' }).title === 'New 2★ review on Grilled chicken',
    'the review line carries the stars',
  );
  expect(
    line('review_posted', { rating: 2, product_name: 'Grilled chicken' }).sub === 'No comment, just a rating.',
    'and a rating with no words says so rather than quoting nothing — `comment` is not a required key',
  );
  expect(
    line('review_posted', { rating: 5, product_name: 'Fries', comment: 'Perfect' }).sub === '“Perfect”',
    'a review with words is quoted',
  );

  expect(
    line('payout_sent', { amount: '212000', destination: 'MTN MoMo 078 ••• 4412' }).title ===
      'Payout sent · 212,000 RWF',
    'a payout is money, formatted by the store\'s own currency',
  );
  expect(line('identity_verified', {}).sub === 'Payouts are unlocked', 'identity verified');

  // A payload written with a thousands separator in it. parseDecimal() throws on that, and one bad row must not
  // take the panel down — see the money helper in lines.ts.
  expect(line('payout_sent', { amount: '212,000', destination: 'x' }).title !== '', 'a malformed amount still renders');

  const unknown = line('order_returned', { order_number: 9 });
  expect(unknown.title === 'Order returned', `an unknown type is still a readable line: ${unknown.title}`);

  // V010's five tones are the kit's five status pairs, so the panel carries no colour of its own.
  expect(toneClasses('good').includes('status-success'), 'good is the success pair');
  expect(toneClasses('attention').includes('status-warn'), 'attention is the warn pair');
  expect(toneClasses('progress').includes('status-progress'), "progress is Main's sixth tone");
}

// The clocks. Each one is a rule about which zone the answer belongs to.
{
  const now = new Date('2026-09-27T09:30:00Z');
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

  expect(relativeWhen(ago(0), 'Africa/Kigali', now) === 'Just now', 'under a minute is "Just now"');
  expect(relativeWhen(ago(2), 'Africa/Kigali', now) === '2 min ago', 'minutes');
  expect(relativeWhen(ago(120), 'Africa/Kigali', now) === '2 h ago', 'hours');
  // Kigali is UTC+2, so 09:30Z is 11:30 local and eight hours earlier is 03:30 the SAME local day.
  expect(
    relativeWhen(ago(480), 'Africa/Kigali', now).startsWith('Today '),
    `beyond six hours it gives the clock time: ${relativeWhen(ago(480), 'Africa/Kigali', now)}`,
  );
  expect(relativeWhen(ago(60 * 26), 'Africa/Kigali', now) === 'Yesterday', 'yesterday');
  expect(relativeWhen('not a date', 'Africa/Kigali', now) === '', 'a value that is not a timestamp renders nothing');

  // THE ZONE DECIDES WHAT "TODAY" MEANS, which is the bug V021 was written to fix. 23:00 in Kigali is 21:00 UTC
  // on the same date, but 23:00 in Honolulu is the next date in UTC — so the same instant is a different day.
  expect(
    relativeWhen('2026-09-26T23:00:00Z', 'Pacific/Honolulu', now) !== relativeWhen('2026-09-26T23:00:00Z', 'Africa/Kigali', now),
    'the same instant reads as a different day in two zones, which is why the store\'s zone is carried',
  );

  expect(greeting('Africa/Kigali', new Date('2026-09-27T06:00:00Z')) === 'Good morning', '08:00 in Kigali is morning');
  expect(greeting('Africa/Kigali', new Date('2026-09-27T12:00:00Z')) === 'Good afternoon', '14:00 is afternoon');
  expect(greeting('Africa/Kigali', new Date('2026-09-27T18:00:00Z')) === 'Good evening', '20:00 is evening');

  expect(dateline('2026-09-27', 'Africa/Kigali') === 'Sunday, 27 September', `the dateline: ${dateline('2026-09-27', 'Africa/Kigali')}`);
  expect(waitingClock(7) === '0:07', 'the alert counts 0:07');
  expect(waitingClock(605) === '10:05', 'and past ten minutes');
}

// The navigation table. What is asserted is its RULES, not its contents — a milestone that adds a screen changes
// the data, and a test that listed the labels would fail for the right change.
{
  const ids = NAV_GROUPS.flat().map((item) => item.id);
  expect(new Set(ids).size === ids.length, 'no nav id appears twice');
  expect(NAV_GROUPS.length === 5, `the board draws five groups, separated by rules: ${NAV_GROUPS.length}`);
  expect(MOBILE_TABS.length === 5, 'the phone bar has five items');
  expect(
    NAV_GROUPS.flat().filter((item) => item.built).length >= 1,
    'at least the dashboard is built, or the console has no screen',
  );
  expect(
    NAV_GROUPS.flat().every((item) => item.built || item.milestone > 19),
    'every unbuilt item names the milestone that builds it',
  );

  // A manager holds neither wallet.read nor settings.write, and Auth promised them so in as many words.
  const managerPermissions = ['orders.read', 'orders.update', 'orders.assign_rider', 'products.write', 'stock.write'];
  const visible = NAV_GROUPS.flat().filter((item) => maySee(item, managerPermissions)).map((i) => i.id);
  expect(!visible.includes('money'), 'a manager does not see Money');
  expect(!visible.includes('settings'), 'nor Settings');
  expect(visible.includes('orders'), 'but does see Orders');
  expect(visible.includes('riders'), 'and Riders & cash, which is the job they do');

  expect(hrefFor('nyama', '/orders') === '/app/nyama/orders', 'the console path carries the slug');
  expect(hrefFor('nyama', '') === '/app/nyama', 'and the dashboard is the bare path');
  // V010 stores '/app/orders' with the store left out; the panel puts it back.
  expect(consoleHref('nyama', '/app/orders') === '/app/nyama/orders', "a notification's route gains the store");
  expect(consoleHref('nyama', '/app/money') === '/app/nyama/money', 'and so does a payout\'s');
}

// --- and every console component renders --------------------------------------
const CONSOLE_SHELL: ShellContextValue = {
  store: {
    id: 's1',
    slug: 'nyama',
    name: 'Nyama & Co.',
    status: 'active',
    country: 'RW',
    timeZone: 'Africa/Kigali',
    currency: CURRENCY,
  },
  me: {
    id: 'u1',
    name: 'Aline Uwase',
    role: 'owner',
    permissions: ['orders.read', 'orders.update', 'wallet.read', 'settings.write', 'products.write'],
  },
  stores: [
    { storeId: 's1', slug: 'nyama', name: 'Nyama & Co.', role: 'owner' },
    { storeId: 's2', slug: 'inzu', name: 'Inzu Threads', role: 'admin' },
  ],
  t: ((key: string, form?: string) => (form === 'one' ? key : `${key}s`)) as ShellContextValue['t'],
  has: () => true,
  currency: CURRENCY,
  money: (amount) => formatMoney(amount, CURRENCY),
  badges: { orders: 3, complaints: 2, reviews: 1, notifications: 7 },
  may: () => true,
  refreshBadges: noop,
  setBadges: noop,
};

function inConsole(node: ReactNode): ReactNode {
  return <ShellContext.Provider value={CONSOLE_SHELL}>{node}</ShellContext.Provider>;
}

const CONSOLE_ORDER = {
  id: 'o1',
  orderNumber: 1026,
  trackingCode: 'a'.repeat(32),
  customer: 'Grace Mukamana',
  fulfilment: 'delivery' as const,
  itemCount: 3,
  total: '10200.00',
  paymentMethod: 'mtn_momo',
  paymentStatus: 'paid',
  placedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
};

const DASHBOARD: DashboardData = {
  me: { name: 'Aline Uwase', role: 'owner' },
  counts: {
    ordersToday: 24,
    ordersWaiting: 3,
    productsActive: 182,
    productsDraft: 4,
    lowStockVariants: 7,
    isOpen: true,
    closesAt: '22:00',
    acceptingOrders: true,
    localDate: '2026-09-27',
  },
  sales: { salesToday: '125000.00', salesSameDayLastWeek: '111000.00', changePercent: 12 },
  week: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
    day: `2026-09-2${dayOfWeek}`,
    dayOfWeek,
    sales: String(60_000 + dayOfWeek * 9_000),
    orders: dayOfWeek,
  })),
  needsAttention: [CONSOLE_ORDER],
  recent: [{ ...CONSOLE_ORDER, status: 'preparing' }],
  lowestStock: { productName: 'Passion Juice', variantLabel: null, left: 4 },
  unreadNotifications: 7,
};

const ALERT: OrderAlertData = {
  orderId: 'o9',
  orderNumber: 1034,
  trackingCode: 'b'.repeat(32),
  customer: 'Aimable K.',
  total: '8500.00',
  fulfilment: 'delivery',
  paymentMethod: 'mtn_momo',
  paymentStatus: 'paid',
  deliveryAddress: 'Kimihurura',
  placedAt: new Date().toISOString(),
  waitingSeconds: 7,
};


const consoleParts: readonly (readonly [string, ReactNode])[] = [
  ['Sidebar', inConsole(<Sidebar active="dashboard" unread={7} onOpenNotifications={noop} navigate={noop} />)],
  ['DashboardMobile · bottom bar', inConsole(<MobileTabs active="dashboard" navigate={noop} />)],
  ['Dashboard', inConsole(<Dashboard data={DASHBOARD} onChanged={noop} />)],
  // A manager's dashboard: no sales card, no chart, and the rest unchanged. The route omits the money rather
  // than the screen hiding it, so this is the payload a manager actually receives.
  [
    'Dashboard · a manager, with no wallet.read',
    inConsole(<Dashboard data={{ ...DASHBOARD, sales: null, week: null }} onChanged={noop} />),
  ],
  // A shop with nothing in it yet — the state a merchant sees on their first morning.
  [
    'Dashboard · a store with no orders yet',
    inConsole(
      <Dashboard
        data={{
          ...DASHBOARD,
          counts: { ...DASHBOARD.counts, ordersToday: 0, ordersWaiting: 0, lowStockVariants: 0, productsDraft: 0 },
          sales: { salesToday: '0', salesSameDayLastWeek: '0', changePercent: null },
          week: DASHBOARD.week?.map((d) => ({ ...d, sales: '0', orders: 0 })) ?? null,
          needsAttention: [],
          recent: [],
          lowestStock: null,
        }}
        onChanged={noop}
      />,
    ),
  ],
  // Paused, which is a different sentence from closed: the shop is open and the kitchen has stopped.
  [
    'Dashboard · new orders paused',
    inConsole(
      <Dashboard data={{ ...DASHBOARD, counts: { ...DASHBOARD.counts, acceptingOrders: false } }} onChanged={noop} />,
    ),
  ],
  // The panel renders CLOSED here, which is its correct first paint: renderToStaticMarkup runs no effects, so
  // the <dialog> has not been opened and the list has not been fetched.
  [
    'Notifications · panel',
    inConsole(
      <NotificationsPanel open onClose={noop} sound onSoundChange={noop} navigate={noop} onUnreadChange={noop} />,
    ),
  ],
  ['Notifications · new-order alert', inConsole(<OrderAlert alert={ALERT} sound onSilence={noop} onAccepted={noop} navigate={noop} />)],
  [
    'Notifications · alert with sound off for this device',
    inConsole(<OrderAlert alert={ALERT} sound={false} onSilence={noop} onAccepted={noop} navigate={noop} />),
  ],
  // The whole console, cold. It fetches on mount, so what this proves is that the first paint — the shell's
  // loading state — renders rather than throwing.
  ['Console · first paint', <Console slug="nyama" view={{ kind: 'dashboard' }} navigate={noop} />],
];

for (const [name, node] of consoleParts) {
  const html = render(name, node);
  allHtml += html;
  kitHtml += html;
}

expect(consoleParts.length >= 10, `the console has ${consoleParts.length} parts rendered`);

/**
 * The rendered text, with tags removed and the entities React escapes decoded.
 *
 * Asserting phrases against raw markup fails on "Nyama & Co." — React writes `&amp;` — and chasing
 * that with an escaped literal in the test would mean the test agreed with the escaping rather than
 * with the board.
 */
const visibleText = allHtml
  .replace(/<[^>]+>/g, ' ')
  .replaceAll('&amp;', '&')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&#x27;', "'")
  .replace(/\s+/g, ' ');

// --- the copy is the boards', not a paraphrase --------------------------------
//
// A handful of sentences that only appear if the wording was carried across. States.dc.html's whole
// argument is that the wording IS the design, so a rewrite of these is a regression.
for (const phrase of [
  'You weren’t charged.',
  'Your cart is saved on this phone.',
  'Nothing was changed.',
  'The store’s wallet wasn’t charged.',
  'Nyama & Co. is getting ready',
  'Add a street, building or landmark the rider can find.',
  // Auth's own wording, milestone 15.
  'One sign-in for owners, staff, riders and the Vendlyfy team.',
  'Keep me signed in on this device',
  'We only show stores after the password matches one of them',
  'This signs you out on every other device.',
  // The storefront's own wording, milestone 16.
  'Open · closes 22:00',
  'Two burgers, free fries',
  'Weekdays 12:00–15:00. Added automatically at checkout.',
  'Daily 10:00–22:00',
  'Delivery 25–35 min · from 1,000 RWF',
  'Sold out while you were choosing',
  'The total is confirmed before you pay.',
  // Checkout's own wording, milestone 17.
  'Your cart is empty',
  'Add something you like and it will show up here.',
  'We text your receipt and delivery updates here.',
  'Secure payment · SMS receipt after you pay',
  'Ordered before? Sign in',
  // CustomerAccount's own wording, milestone 18.
  //
  // Chosen from what the gate can actually REACH. renderToStaticMarkup runs no effects, so a screen that
  // fetches on mount renders its loading state — which is the correct first paint and is what is asserted
  // above. And `visibleText` strips tags, so a placeholder is not visible text however visible it looks.
  // Phrases from those two places would pass or fail for reasons that have nothing to do with the wording.
  'Your cart (3 items) stays exactly as it is.',
  'If you can’t agree, the store can ask Vendlyfy to decide.',
  'Send to the store',
  // The console's, milestone 19. The alert's long sentence is the specification for how the alert works, so it
  // is the one most worth pinning: it says the chime repeats, and that it shows everywhere.
  'Chime repeats every 20 seconds until someone accepts or opens it. Shows on every signed-in screen at this store.',
  'Sound is off for this device. The alert still shows on screen.',
  'Sound for new orders',
  'Mark all as read',
  'Your store is open',
  'Pause new orders',
  'New orders are paused',
  'Needs your attention',
  'Sales this week',
  'Recent orders',
  'Restock before tonight →',
  '3 waiting for you →',
  'View your store',
  'Nothing waiting. New orders appear here the moment they arrive.',
]) {
  expect(visibleText.includes(phrase), `the boards' wording is missing: ${phrase}`);
}

// --- §2.2: the kit carries no colour of its own --------------------------------
//
// Utilities live in markup and every colour comes from a token, so a hex in the kit's output is a
// value that escaped the token layer. Two exceptions, both deliberate:
//
//   * THE TOKEN SHEET IS EXCLUDED. Its whole purpose is to print the palette — swatches and their
//     hex labels — so asserting it holds no hex would be asserting it does not work.
//   * PRODUCT TILES. The boards draw a per-product placeholder tint behind an initial where there is
//     no photograph. That is data about a product, not a theme token, so the values are allowed by
//     name rather than by pattern — a list that has to be edited to add one, which is the point.
const ALLOWED_TILE_HEX = [
  '#F3E3CF', '#8A5A2B', '#DCE3EC', '#36506E', '#EFEDE7', '#A8A499', '#D5DCE6', '#E8E0D0',
  // The toast's undo, which Main.dc.html sets as a light green on ink. A token would be a token used
  // once; it is noted here instead so it cannot spread.
  '#BFE3CD',
  // The storefront's tile palette — milestone 16, from client/src/storefront/tiles.ts, which took them
  // from Shop, StoreDesktop and ReviewsCustomer.
  //
  // ALL TEN ARE LISTED, not just the ones that happen to appear. tileFor() picks a tint by hashing the
  // product id, so which tints reach the markup depends on the fixture ids — and a list holding only the
  // two that showed up today would fail the next time somebody changed a fixture. The gate stays
  // deterministic, and adding an ELEVENTH tint still means editing this list, which is the point.
  '#EAD9C3', '#E3D5CB', '#F2D7C2', '#E5D0C0', '#F0E2B8', '#DCE4CD', '#DADCE2', '#E6D6C6', '#E8DCC8',
];
const hexes = [...kitHtml.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => m[0]);
const stray = [...new Set(hexes)].filter((h) => !ALLOWED_TILE_HEX.includes(h.toUpperCase()));
expect(stray.length === 0, `hex colours in the kit's markup that are not product tiles: ${stray.join(' ')}`);

// --- accessibility basics the boards depend on --------------------------------
expect(allHtml.includes('role="radiogroup"'), 'the segmented control is a radiogroup');
expect(allHtml.includes('role="switch"'), 'the switch is a switch');
expect(allHtml.includes('aria-invalid="true"'), 'a field in error sets aria-invalid');
expect(allHtml.includes('role="progressbar"'), 'the setup checklist reports progress');
expect(allHtml.includes('aria-disabled="true"'), 'a sold-out option is announced as disabled');
expect(allHtml.includes('<dialog'), 'the overlays are dialog elements');

// --- report -------------------------------------------------------------------
if (problems.length > 0) {
  console.error(`\nUI render check FAILED — ${problems.length} of ${checks}:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`UI render check passed: ${checks} assertions over ${ALL_STATES.length} states and 4 sheets.`);
