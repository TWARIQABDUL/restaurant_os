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
