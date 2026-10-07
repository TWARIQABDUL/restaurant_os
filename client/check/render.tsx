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
import type { ActivityRow, AnalyticsPayload, CategoryRow, ComplaintDetail, ComplaintListItem, CustomerDetail, CustomerList, ReviewsPage, DashboardData, Payout, RefundRow as WalletRefund, WalletData, OrderAlert as OrderAlertData, OrderDetail, OrderListItem, ProductList, ProductSaved } from '../src/console/api.ts';
import { MobileTabs, Sidebar } from '../src/console/Sidebar.tsx';
import { Dashboard } from '../src/console/Dashboard.tsx';
import { NotificationsPanel } from '../src/console/NotificationsPanel.tsx';
import { OrderAlert } from '../src/console/OrderAlert.tsx';
import { columnOf, COLUMN_LABELS, Orders, statusMeta } from '../src/console/Orders.tsx';
import { CashReport } from '../src/console/CashReport.tsx';
import { Categories, pageTitle, productsMeta, sectionState } from '../src/console/Categories.tsx';
import { ProductEditor } from '../src/console/ProductEditor.tsx';
import { Wallet } from '../src/console/Wallet.tsx';
import { Customize, toPreview } from '../src/console/Customize.tsx';
import { ThemeStudio, accentClashes, normaliseHex } from '../src/console/ThemeStudio.tsx';
import { DEFAULT_INPUTS } from '../src/console/lookDraft.ts';
import { SAMPLE_CATEGORIES, SAMPLE_PRODUCTS, StorePreview } from '../src/console/StorePreview.tsx';
import { storeLookVariables, storeThemeVariables } from '../src/styles/store-theme.ts';
import { Analytics } from '../src/console/Analytics.tsx';
import { Settings } from '../src/console/Settings.tsx';
import { Verify } from '../src/console/Verify.tsx';
import { Admin, SoonPage } from '../src/admin/Admin.tsx';
import type { CaseDetail, MerchantDetail, MerchantList, Me as AdminMe, Overview as AdminOverviewData, QueueItem } from '../src/admin/adminApi.ts';
import { ageText, compactMoney, degradedNote, kpiDelta, kpiValue, overSla, rowBadge } from '../src/admin/adminLines.ts';
import { Kyc as AdminKyc } from '../src/admin/Kyc.tsx';
import { Merchants as AdminMerchants } from '../src/admin/Merchants.tsx';
import { Overview as AdminOverview } from '../src/admin/Overview.tsx';
import { BlockedView, CameraView, TipsView } from '../src/console/FaceCapture.tsx';
import type { KycStatus } from '../src/console/kycApi.ts';
import { BLUR_BELOW, GLARE_ABOVE, PROMPTS, RETENTION_LINE, glareShare, outcomeCopy, partRow, photoChecks, pickVideoType, promptAt, retakePartOf, sentLine, sharpness } from '../src/console/kycLines.ts';
import { LookLayout, Onboarding } from '../src/onboarding/Onboarding.tsx';
import { OTHER, accountProblem, businessReady, cleanPrice, whatFor } from '../src/onboarding/lines.ts';
import type { Member, SettingsBase, SettingsExtra } from '../src/console/settingsApi.ts';
import { generatePassword, grantableRoles, hoursSummary, maskPhone, paymentState, payoutSentence, visibleModules, weekFrom, weekToRows, zoneAreasLine, zoneFeeLine } from '../src/console/settingsLines.ts';
import { Complaints } from '../src/console/Complaints.tsx';
import { Customers } from '../src/console/Customers.tsx';
import { Reviews } from '../src/console/Reviews.tsx';
import { COMPLAINT_BADGE, RESPONSES, ageShort, canReopen, closedNote, deliveryLine, lowTrend, productRating, reasonLabel, reportReasonLabel, stars, timelineLine } from '../src/console/supportLines.ts';
import { chartTitle, compact, delta, formatDay, itemsTiles, onTimeTone, ordersNote, ordersTiles, paymentsTiles, revenueNote, summaryTiles } from '../src/console/analyticsLines.ts';
import { activityLine, availableNote, flowSteps, lockFor, payoutLine, pendingNote, refundLine, stamp } from '../src/console/walletLines.ts';
import { Products, statusChip, stockCell } from '../src/console/Products.tsx';
import { EMPTY_STATE, cleanAmount, problems as editorProblems, previewMeta, stateFrom, suggestSku, toDoc, variantRows } from '../src/console/catalogue.ts';
import { RiderApp } from '../src/rider/Rider.tsx';
import type { RiderHome } from '../src/rider/api.ts';
import { Console } from '../src/console/Console.tsx';
import { MOBILE_TABS, NAV_GROUPS, consoleHref, hrefFor, maySee } from '../src/console/nav.ts';
import { dateline, greeting, notificationLine, relativeWhen, toneClasses, waitingClock } from '../src/console/lines.ts';
import { DEFAULT_DESIGN, compileTheme, formatMoney } from '../src/app/core.ts';
import type { Design, ThemeInputs } from '../src/app/core.ts';

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
  design: DEFAULT_DESIGN,
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
    permissions: ['orders.read', 'orders.update', 'wallet.read', 'settings.write', 'products.write', 'support.write', 'customers.read', 'customers.write'],
  },
  stores: [
    { storeId: 's1', slug: 'nyama', name: 'Nyama & Co.', role: 'owner' },
    { storeId: 's2', slug: 'inzu', name: 'Inzu Threads', role: 'admin' },
  ],
  // The Food & drinks template's own four words (V002), because Products and Categories now ask t() for
  // their headings. A stub that returned `${key}s` would make "categorys" the thing the gate agrees with.
  t: ((key: string, form?: string) => {
    const words: Record<string, [string, string]> = {
      product: ['Menu item', 'Menu items'],
      catalog: ['Menu', 'Menu'],
      category: ['Section', 'Sections'],
      option: ['Extra', 'Extras'],
    };
    const [one, many] = words[key] ?? [key, key];
    return form === 'one' ? one : many;
  }) as ShellContextValue['t'],
  has: () => true,
  attributes: [
    { name: 'Spice level', pick: 'one' },
    { name: 'Extras', pick: 'several', priced: true },
    { name: 'Portion size', pick: 'one' },
  ],
  templateName: 'Food & drinks',
  currency: CURRENCY,
  money: (amount) => formatMoney(amount, CURRENCY),
  badges: { orders: 3, complaints: 2, reviews: 1, notifications: 7 },
  may: () => true,
  refreshBadges: noop,
  setBadges: noop,
  config: {
    template: { key: 'food', name: 'Food & drinks', accentColor: '#1D6B47', version: 1 },
    words: {} as never,
    modules: {
      modifiers: { enabled: true, source: 'template', label: 'Priced extras' },
      delivery: { enabled: true, source: 'template', label: 'Delivery' },
      pickup: { enabled: true, source: 'template', label: 'Pickup' },
      table: { enabled: false, source: 'template', label: 'Table ordering' },
      scheduled: { enabled: false, source: 'template', label: 'Scheduled' },
      stock: { enabled: true, source: 'store', label: 'Stock' },
      appointments: { enabled: false, source: 'template', label: 'Appointments' },
      rx: { enabled: false, source: 'template', label: 'Prescription' },
    },
    attributes: [],
    orderSteps: [],
    productFlags: [],
  },
  setConfig: noop,
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

// --- Orders, milestone 20 — one fixture per column, and one detail per drawer state ------------
function listItem(overrides: Partial<OrderListItem> & Pick<OrderListItem, 'id' | 'orderNumber' | 'status'>): OrderListItem {
  return {
    customer: 'Aimable Kayitare',
    phone: '078 330 1180',
    fulfilment: 'delivery',
    address: 'KG 11 Ave, Kimihurura',
    itemCount: 2,
    itemSummary: '2 items',
    total: '8500.00',
    paymentMethod: 'mtn_momo',
    paymentStatus: 'paid',
    cashConfirmed: true,
    riderName: null,
    hasLiveRefund: false,
    placedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ageMinutes: 5,
    ...overrides,
  };
}

const ORDER_LIST: OrderListItem[] = [
  listItem({ id: 'o1', orderNumber: 1031, status: 'pending', ageMinutes: 5 }),
  listItem({ id: 'o2', orderNumber: 1028, status: 'approved' }),
  listItem({ id: 'o3', orderNumber: 1003, status: 'preparing', paymentMethod: 'cash', paymentStatus: 'unpaid', cashConfirmed: false }),
  listItem({ id: 'o4', orderNumber: 1004, status: 'ready' }),
  listItem({ id: 'o5', orderNumber: 1005, status: 'assigned', riderName: 'Eric Mugisha' }),
  listItem({ id: 'o6', orderNumber: 1006, status: 'out', riderName: 'Olivier Nzeyimana', paymentMethod: 'cash', paymentStatus: 'unpaid', cashConfirmed: false }),
  listItem({ id: 'o7', orderNumber: 1027, status: 'delivered', paymentMethod: 'cash', paymentStatus: 'unpaid', cashConfirmed: false }),
  listItem({ id: 'o8', orderNumber: 1023, status: 'delivered' }),
  listItem({ id: 'o9', orderNumber: 1000, status: 'returned' }),
  listItem({ id: 'o10', orderNumber: 1008, status: 'collected', fulfilment: 'pickup', address: null }),
  listItem({ id: 'o11', orderNumber: 1002, status: 'closed_return' }),
  listItem({ id: 'o12', orderNumber: 1009, status: 'rejected' }),
  listItem({ id: 'o13', orderNumber: 1010, status: 'cancelled', fulfilment: 'pickup', address: null }),
];

function orderDetail(item: OrderListItem, extra: Partial<OrderDetail> = {}): OrderDetail {
  return {
    ...item,
    lines: [
      { id: 'l1', productName: 'Chicken burger', variantLabel: '', optionLabels: [], quantity: 2, unitPrice: '3500.00', lineTotal: '7000.00' },
      { id: 'l2', productName: 'Fries', variantLabel: '', optionLabels: [], quantity: 1, unitPrice: '1500.00', lineTotal: '1500.00' },
    ],
    subtotal: '8500.00',
    deliveryFee: '0.00',
    discount: '0.00',
    cashDue: item.paymentMethod === 'cash' ? item.total : null,
    cashReported: null,
    riderId: item.riderName === null ? null : 'r1',
    refundedAmount: '0.00',
    events: [{ fromStatus: null, toStatus: 'pending', reason: null, note: 'Order placed', actorName: null, at: item.placedAt }],
    ...extra,
  };
}

const DETAIL_PENDING = orderDetail(ORDER_LIST[0]!);
const DETAIL_READY_NO_RIDER = orderDetail(ORDER_LIST[3]!);
const DETAIL_ASSIGNED = orderDetail(ORDER_LIST[4]!);
const DETAIL_CASH_UNCONFIRMED = orderDetail(ORDER_LIST[6]!);
const DETAIL_DELIVERED_PAID = orderDetail(ORDER_LIST[7]!);
const DETAIL_RETURNED = orderDetail(ORDER_LIST[8]!, {
  events: [
    { fromStatus: null, toStatus: 'pending', reason: null, note: 'Order placed', actorName: null, at: ORDER_LIST[8]!.placedAt },
    { fromStatus: 'out', toStatus: 'returned', reason: 'Nobody answering', note: null, actorName: 'Olivier Nzeyimana', at: ORDER_LIST[8]!.placedAt },
  ],
});

// THE STATUS VOCABULARY AND THE COLUMN GROUPING ARE PINNED DIRECTLY, the same way notificationLine() is above —
// a screen scraped for text would only prove today's markup, where calling the exported functions proves the
// LOGIC a future refactor of the JSX could otherwise silently break.
{
  expect(statusMeta({ status: 'pending', paymentMethod: 'mtn_momo', cashConfirmed: true }).label === 'New', 'pending reads New');
  expect(statusMeta({ status: 'ready', paymentMethod: 'mtn_momo', cashConfirmed: true }).tone === 'success', 'ready is a success tone');
  expect(
    statusMeta({ status: 'delivered', paymentMethod: 'cash', cashConfirmed: false }).label === 'Delivered · cash unconfirmed',
    'an unconfirmed cash delivery reads differently from a settled one — the one case that is not a straight status → label lookup',
  );
  expect(
    statusMeta({ status: 'delivered', paymentMethod: 'cash', cashConfirmed: true }).label === 'Delivered',
    'once confirmed, the same status reads Delivered again',
  );
  expect(statusMeta({ status: 'delivered', paymentMethod: 'mtn_momo', cashConfirmed: false }).label === 'Delivered', 'the cash caveat never applies to an online payment');

  expect(COLUMN_LABELS.length === 6, `the board draws six columns; found ${COLUMN_LABELS.length}`);
  expect(new Set(COLUMN_LABELS).size === 6, 'no column repeats another\'s label');
  for (const o of ORDER_LIST) {
    const i = columnOf(o);
    expect(i >= 0 && i < COLUMN_LABELS.length, `order #${o.orderNumber} (${o.status}) lands in a real column`);
  }
  expect(columnOf(ORDER_LIST[0]!) === 0, 'a pending order is in New');
  expect(columnOf(ORDER_LIST[1]!) === 1, 'an accepted order is in Preparing, same column as one actually being prepared');
  expect(columnOf(ORDER_LIST[2]!) === 1, 'preparing is that same column');
  expect(columnOf(ORDER_LIST[4]!) === 3, 'assigned is With rider');
  expect(columnOf(ORDER_LIST[5]!) === 3, 'so is out for delivery — the same column, two statuses');
  expect(columnOf(ORDER_LIST[6]!) === 4, 'a delivered cash order still unconfirmed needs closing, not Done');
  expect(columnOf(ORDER_LIST[7]!) === 5, 'a delivered and settled order is Done today');
  expect(columnOf(ORDER_LIST[8]!) === 4, 'a return needs closing too');
}

// --- Riders & cash, and the rider's own app — milestone 21 ---------------------------------------
const ROSTER = [
  { id: 'r1', name: 'Eric Mugisha', phone: '078 455 9012', plate: 'RAD 482 K', availability: 'available' as const, activeJobs: 2, cashCarried: '0.00', lastUpdate: new Date().toISOString() },
  { id: 'r2', name: 'Claude Habineza', phone: '078 612 7781', plate: 'RAE 115 C', availability: 'available' as const, activeJobs: 1, cashCarried: '10000.00', lastUpdate: new Date().toISOString() },
  { id: 'r3', name: 'Olivier Nzeyimana', phone: '072 990 3310', plate: 'RAB 903 F', availability: 'off_duty' as const, activeJobs: 0, cashCarried: '0.00', lastUpdate: new Date().toISOString() },
];
const CASH_CARDS = [
  {
    riderId: 'r2', name: 'Claude Habineza', closedToday: false, settlementId: null,
    deliveredToday: [{ id: 'o1', orderNumber: 1015, label: 'delivered', amount: '6000.00' }],
    stillOut: [],
    expected: '18500.00', handedInToday: '6000.00', due: '12500.00', gapAmount: null, gapResolution: null,
  },
  {
    riderId: 'r1', name: 'Eric Mugisha', closedToday: false, settlementId: null,
    deliveredToday: [],
    stillOut: [{ id: 'o2', orderNumber: 1026, label: 'assigned, not picked up', amount: '12000.00' }],
    expected: '0.00', handedInToday: '0.00', due: '0.00', gapAmount: null, gapResolution: null,
  },
  {
    riderId: 'r3', name: 'Olivier Nzeyimana', closedToday: true, settlementId: 's1',
    deliveredToday: [], stillOut: [],
    expected: '0.00', handedInToday: '0.00', due: '0.00', gapAmount: '0.00', gapResolution: null,
  },
];
const CARRIED_OVER = [
  { settlementId: 's9', riderName: 'Olivier Nzeyimana', businessDate: '2026-09-21', gapAmount: '1000.00', orderNumber: 994 },
];

const RIDER_JOB_AT_STORE: RiderHome['jobs'][number] = {
  id: 'j1', orderNumber: 1026, status: 'assigned', storeName: 'Nyama & Co.', storeAddress: 'KG 7 Ave, Kimihurura',
  customer: 'Grace Ingabire', phone: '078 455 1209', address: 'KG 541 St, house 12, Kacyiru',
  paymentMethod: 'cash', cashDue: '12000.00', total: '12000.00', placedAt: new Date().toISOString(),
  lines: [{ id: 'l1', productName: 'Chicken burger', variantLabel: '', optionLabels: [], quantity: 2, unitPrice: '3500.00', lineTotal: '7000.00' }],
};
const RIDER_JOB_ON_ROAD: RiderHome['jobs'][number] = { ...RIDER_JOB_AT_STORE, id: 'j2', orderNumber: 1024, status: 'out', paymentMethod: 'mtn_momo', cashDue: null };
const RIDER_JOB_ON_ROAD_CASH: RiderHome['jobs'][number] = { ...RIDER_JOB_AT_STORE, id: 'j3', orderNumber: 1029, status: 'out' };
const RIDER_HOME: RiderHome = {
  storeName: 'Nyama & Co.',
  currency: CURRENCY,
  me: { name: 'Eric Mugisha', phone: '078 455 9012', plateNumber: 'RAD 482 K' },
  availability: 'available',
  cashHeld: '0.00',
  jobs: [RIDER_JOB_AT_STORE, RIDER_JOB_ON_ROAD, RIDER_JOB_ON_ROAD_CASH],
};



// --- the catalogue — milestone 22 ----------------------------------------------------------------
const PRODUCT_LIST: ProductList = {
  rows: [
    { id: '5555a001-0000-4000-8000-000000000001', name: 'Chicken Burger', sub: '2 option groups · SKU NY-001', categories: ['Burgers'], price: '3500.00', trackStock: true, stock: 42, state: 'ok', status: 'active', coverImageUrl: null },
    { id: '5555a001-0000-4000-8000-000000000002', name: 'Goat Brochette Plate', sub: 'SKU NY-010', categories: ['Grills'], price: '5000.00', trackStock: true, stock: 6, state: 'low', status: 'active', coverImageUrl: null },
    { id: '5555a001-0000-4000-8000-000000000003', name: 'Veggie Wrap', sub: 'SKU NY-021', categories: ['Sides', 'Lunch'], price: '3000.00', trackStock: true, stock: 0, state: 'out', status: 'active', coverImageUrl: null },
    { id: '5555a001-0000-4000-8000-000000000004', name: 'Passion Juice', sub: '500 ml', categories: [], price: '1200.00', trackStock: false, stock: null, state: 'ok', status: 'active', coverImageUrl: '/api/media/s1/0123456789abcdef0123456789abcdef.png' },
    { id: '5555a001-0000-4000-8000-000000000005', name: 'Chapati', sub: 'Not visible to customers', categories: ['Sides'], price: '500.00', trackStock: true, stock: 50, state: 'draft', status: 'draft', coverImageUrl: null },
  ],
  total: 182,
  page: 1,
  pageSize: 25,
  counts: { all: 182, active: 176, draft: 4, low: 7, out: 2 },
};

const SECTIONS: CategoryRow[] = [
  { id: 'c1', name: 'Burgers', isVisible: true, productCount: 6, activeCount: 6 },
  { id: 'c2', name: 'Grills', isVisible: true, productCount: 5, activeCount: 5 },
  { id: 'c3', name: 'Breakfast', isVisible: false, productCount: 3, activeCount: 3 },
  { id: 'c4', name: 'Christmas specials', isVisible: true, productCount: 0, activeCount: 0 },
  { id: 'c5', name: 'Seasonal', isVisible: true, productCount: 2, activeCount: 0 },
];

// AddProduct's own clothing preset: Size S/M/L/XL x Color Black/White, one pick-several group besides.
const TSHIRT: ProductSaved = {
  id: '5555a001-0000-4000-8000-0000000000aa',
  name: 'Everyday T-Shirt',
  description: '',
  price: '15000.00',
  compareAtPrice: null,
  status: 'active',
  categoryIds: ['c1'],
  images: [],
  trackStock: true,
  sku: null,
  stock: null,
  groups: [
    { id: 'gs', shared: false, name: 'Size', mode: 'one', values: ['S', 'M', 'L', 'XL'].map((l) => ({ key: `v${l}`, label: l, priceDelta: l === 'XL' ? '1000.00' : '0.00' })) },
    { id: 'gc', shared: false, name: 'Color', mode: 'one', values: ['Black', 'White'].map((l) => ({ key: `v${l}`, label: l, priceDelta: '0.00' })) },
    { id: 'ge', shared: false, name: 'Gift wrap', mode: 'several', values: [{ key: 'vw', label: 'Wrapped', priceDelta: '500.00' }] },
  ],
  variants: [
    { combo: ['vS', 'vBlack'], sku: 'TS-S-BLA', stock: 4, available: true },
    { combo: ['vM', 'vBlack'], sku: null, stock: 0, available: true },
  ],
  sold: false,
};
const TSHIRT_STATE = stateFrom(TSHIRT);

{
  // The matrix is the cartesian product of the pick-ONE groups only — AddProduct's `attrs.filter(a => a.mode === 'one')`.
  const rows = variantRows(TSHIRT_STATE);
  expect(rows.length === 8, `4 sizes x 2 colours is 8 variants; found ${rows.length}`);
  expect(rows[0]!.label === 'S / Black', 'the first group varies slowest, so the first row is S / Black');
  expect(rows[1]!.label === 'S / White', 'and the second group varies fastest');
  expect(!rows.some((r) => r.label.includes('Wrapped')), 'a pick-several group is priced on the line, never a row');
  expect(rows.find((r) => r.label === 'XL / Black')!.price === '16000', 'XL carries its +1,000: 15,000 + 1,000');
  expect(rows.find((r) => r.label === 'S / Black')!.price === '15000', 'and S does not');

  // A group with no values yet is not a dimension: the board filters on `a.values.length`.
  const withEmpty = { ...TSHIRT_STATE, groups: [...TSHIRT_STATE.groups, { uid: 'x', id: null, shared: false, name: 'Fit', mode: 'one' as const, values: [], draft: '', draftPrice: '' }] };
  expect(variantRows(withEmpty).length === 8, 'an option with no values yet does not zero the matrix');
  expect(variantRows({ ...TSHIRT_STATE, hasOptions: false }).length === 0, 'switching options off removes every variant');

  // Decimal prices add as decimals, not floats: 0.1 + 0.2 has to be 0.3.
  const cents = { ...TSHIRT_STATE, price: '0.1', groups: [{ ...TSHIRT_STATE.groups[0]!, values: [{ key: 'a', label: 'A', priceDelta: '0.2' }] }] };
  expect(variantRows(cents)[0]!.price === '0.3', `0.1 + 0.2 is exactly 0.3; got ${variantRows(cents)[0]!.price}`);

  // The saved edits come back against the right combination.
  expect(TSHIRT_STATE.variantEdits['vS|vBlack']?.sku === 'TS-S-BLA', 'a saved SKU lands on its combination');
  expect(TSHIRT_STATE.variantEdits['vM|vBlack']?.stock === '0', 'and a saved count of zero stays a zero, not blank');

  const doc = toDoc(TSHIRT_STATE, 'active');
  expect(doc.variants.length === 8, 'the document carries every combination, not only the edited ones');
  expect(doc.variants.find((v) => v.combo.join('|') === 'vM|vBlack')!.stock === 0, 'a combination never counted is saved as 0 when stock is tracked');
  expect(doc.variants.find((v) => v.combo.join('|') === 'vS|vBlack')!.sku === 'TS-S-BLA', 'a SKU survives the round trip');
  expect(doc.sku === null && doc.stock === null, 'a product with variants keeps its SKU and count on the variants');
  expect(doc.price === '15000', 'the price is the string the merchant sees, never a float');
  expect(doc.groups.length === 3 && doc.groups[2]!.mode === 'several', 'every group travels, in order');

  const untracked = toDoc({ ...TSHIRT_STATE, trackStock: false }, 'draft');
  expect(untracked.status === 'draft', 'Save draft sends draft whatever the radio says');
  expect(untracked.variants.every((v) => v.stock === null), 'a product that does not track stock sends no counts');

  const plain = toDoc({ ...EMPTY_STATE, name: ' Fries ', price: '1500', trackStock: true, sku: 'NY-020', stock: '120' }, 'active');
  expect(plain.name === 'Fries', 'the name is trimmed');
  expect(plain.sku === 'NY-020' && plain.stock === 120 && plain.variants.length === 0, 'with no options, the SKU and count are the product\'s own');
  expect(toDoc({ ...EMPTY_STATE, name: 'x', price: '1', compareAt: '' }, 'active').compareAtPrice === null, 'a blank compare-at is null, not "0"');

  expect(editorProblems(EMPTY_STATE) === 'Give the product a name.', 'no name is the first thing said');
  expect(editorProblems({ ...EMPTY_STATE, name: 'x' }) === 'Enter a price.', 'then the price');
  expect(editorProblems({ ...EMPTY_STATE, name: 'x', price: '100', compareAt: '100' }) !== null, 'a compare-at that is not higher is refused');
  expect(editorProblems({ ...TSHIRT_STATE, groups: [...TSHIRT_STATE.groups, { uid: 'x', id: null, shared: false, name: 'size', mode: 'one', values: [{ key: 'q', label: 'Q', priceDelta: '0' }], draft: '', draftPrice: '' }] })?.includes('two options') === true, 'two options with the same name are caught in any case');
  expect(editorProblems({ ...TSHIRT_STATE, groups: [{ ...TSHIRT_STATE.groups[0]!, values: [] }] })?.includes('Add at least one value') === true, 'an option with no values is named');
  expect(editorProblems(TSHIRT_STATE) === null, 'a complete product passes');

  expect(cleanAmount('12a.5.6') === '12.56', 'a price box keeps digits and the first dot only');
  expect(suggestSku('Everyday T-Shirt', rows[0]!) === 'EV-S-BLA', 'the SKU suggestion is the name\'s letters then each value\'s');
  expect(previewMeta(TSHIRT_STATE) === 'Size: S · M · L · XL', 'the preview line names the first pick-one group, as the board does');
  expect(previewMeta(EMPTY_STATE) === 'No options', 'and says so when there are none');

  // Products' status chips and the section rules.
  expect(statusChip({ state: 'draft' }).label === 'Draft' && statusChip({ state: 'out' }).label === 'Out of stock', 'the board\'s status chips');
  expect(statusChip({ state: 'low' }).label === 'Active', 'low stock is still Active: it is the STOCK that turns red');
  expect(stockCell({ stock: 6, state: 'low' }).text === '6 · low' && stockCell({ stock: 6, state: 'low' }).alarming, 'low stock reads "6 · low" in red');
  expect(stockCell({ stock: null, state: 'ok' }).text === '—', 'a product that does not track stock shows a dash, not a zero');
  expect(sectionState(SECTIONS[0]!).label === 'Shown', 'a visible section with live products is Shown');
  expect(sectionState(SECTIONS[2]!).label === 'Hidden', 'a switched-off one is Hidden, whatever is in it');
  expect(sectionState(SECTIONS[3]!).label === 'Empty · not shown', 'an empty one is not shown');
  expect(sectionState(SECTIONS[4]!).label === 'Drafts only · not shown', 'one holding only drafts is not shown either: the storefront needs a LIVE product');
  expect(pageTitle('Menu', 'Sections') === 'Menu sections', 'Food & drinks reads "Menu sections", as the board does');
  expect(pageTitle('Aisles', 'Aisles') === 'Aisles', 'a template whose two words are the same reads once');
  expect(productsMeta({ productCount: 0 }, 'Menu item', 'Menu items') === 'No menu items yet', 'an empty section says so');
  expect(productsMeta({ productCount: 1 }, 'Menu item', 'Menu items') === '1 menu item', 'and a single one is singular');
}


// --- the wallet — milestone 23 -------------------------------------------------------------------
const HOUR = 3_600_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const WALLET: WalletData = {
  currency: 'RWF',
  pending: '42000.00',
  available: '184500.00',
  updatedAt: iso(0),
  pendingOrders: 3,
  nextRelease: { at: new Date(Date.now() + HOUR / 2).toISOString(), amount: '15500.00' },
  identity: 'verified',
  refundsOwed: '0.00',
  holdMinutes: 60,
  cashWithRiders: '10000.00',
  shortfalls: 1,
  payout: { methodKey: 'mtn_momo', phoneMasked: '078 ••• 4412', mode: 'automatic', automaticAt: '08:00' },
};

const ACTIVITY: ActivityRow[] = [
  { id: 'a1', at: iso(HOUR / 4), kind: 'sale', amount: '15500.00', balanceAfter: '226500.00', pot: 'pending', note: null, orderNumber: 1023, method: 'mtn_momo', released: false, availableAt: new Date(Date.now() + HOUR / 2).toISOString(), refund: null, withdrawal: null },
  { id: 'a2', at: iso(HOUR), kind: 'sale', amount: '18000.00', balanceAfter: '211000.00', pot: 'pending', note: null, orderNumber: 1021, method: 'card', released: true, availableAt: null, refund: null, withdrawal: null },
  { id: 'a3', at: iso(2 * HOUR), kind: 'refund', amount: '-3000.00', balanceAfter: '193000.00', pot: 'available', note: null, orderNumber: 1019, method: null, released: null, availableAt: null, refund: { approvedAmount: '3000.00', orderTotal: '12500.00', partial: true }, withdrawal: null },
  { id: 'a4', at: iso(3 * HOUR), kind: 'refund', amount: '-8000.00', balanceAfter: '196000.00', pot: 'pending', note: null, orderNumber: 1018, method: null, released: null, availableAt: null, refund: { approvedAmount: '8000.00', orderTotal: '8000.00', partial: false }, withdrawal: null },
  { id: 'a5', at: iso(8 * HOUR), kind: 'withdrawal', amount: '-212000.00', balanceAfter: '204000.00', pot: 'available', note: null, orderNumber: null, method: null, released: null, availableAt: null, refund: null, withdrawal: { status: 'completed', initiatedBy: 'automatic', phone: '0781114412', failureReason: null } },
  { id: 'a6', at: iso(30 * HOUR), kind: 'withdrawal', amount: '-50000.00', balanceAfter: '416000.00', pot: 'available', note: null, orderNumber: null, method: null, released: null, availableAt: null, refund: null, withdrawal: { status: 'failed', initiatedBy: 'manual', phone: '0781114412', failureReason: 'PAYEE_NOT_FOUND' } },
  { id: 'a7', at: iso(31 * HOUR), kind: 'adjust', amount: '-6000.00', balanceAfter: '416000.00', pot: 'available', note: 'Escalated complaint, refund approved by Vendlyfy', orderNumber: null, method: null, released: null, availableAt: null, refund: null, withdrawal: null },
];

const PAYOUTS: Payout[] = [
  { id: 'p1', amount: '212000.00', phoneMasked: '078 ••• 4412', status: 'completed', failureReason: null, initiatedBy: 'automatic', requestedAt: iso(8 * HOUR), completedAt: iso(8 * HOUR - 120_000) },
  { id: 'p2', amount: '30000.00', phoneMasked: '078 ••• 4412', status: 'processing', failureReason: null, initiatedBy: 'manual', requestedAt: iso(HOUR / 10), completedAt: null },
  { id: 'p3', amount: '50000.00', phoneMasked: '078 ••• 4412', status: 'failed', failureReason: 'MoMo number isn’t registered to Aline Uwase.', initiatedBy: 'manual', requestedAt: iso(30 * HOUR), completedAt: null },
  { id: 'p4', amount: '30000.00', phoneMasked: '078 ••• 4412', status: 'rejected', failureReason: 'Held while a dispute on #0998 was open.', initiatedBy: 'manual', requestedAt: iso(80 * HOUR), completedAt: null },
];

const WALLET_REFUNDS: WalletRefund[] = [
  { id: 'r1', orderNumber: 1020, reason: 'item_missing', note: null, requestedAt: iso(5 * HOUR), amount: '5000.00', approvedAmount: null, orderTotal: '12000.00', status: 'pending', rejectionReason: null, settledAt: null },
  { id: 'r2', orderNumber: 1019, reason: 'quality_problem', note: null, requestedAt: iso(9 * HOUR), amount: '3000.00', approvedAmount: '3000.00', orderTotal: '12500.00', status: 'approved', rejectionReason: null, settledAt: iso(2 * HOUR) },
  { id: 'r3', orderNumber: 1014, reason: 'arrived_late', note: null, requestedAt: iso(300 * HOUR), amount: '7000.00', approvedAmount: null, orderTotal: '7000.00', status: 'rejected', rejectionReason: 'rider tracking shows on-time delivery.', settledAt: null },
  { id: 'r4', orderNumber: 1011, reason: 'other', note: 'Customer sent it back', requestedAt: iso(20 * HOUR), amount: '2000.00', approvedAmount: '2000.00', orderTotal: '9000.00', status: 'queued', rejectionReason: null, settledAt: null },
];

{
  const m = (v: string): string => formatMoney(v, CURRENCY);
  const tz = 'Africa/Kigali';

  // The ledger is worded the board's way.
  const sale = activityLine(ACTIVITY[0]!, tz, m);
  expect(sale.what === 'Sale · #1023', 'a sale reads Sale · #n');
  expect(sale.chip.label === 'Pending' && sale.sub.startsWith('Paid by MoMo · Available at '), 'inside the hold window a sale is Pending and says when it clears');
  expect(sale.amount.startsWith('+') && sale.positive, 'a sale adds');
  expect(activityLine(ACTIVITY[1]!, tz, m).chip.label === 'Available', 'once released it is Available');
  expect(activityLine(ACTIVITY[1]!, tz, m).sub === 'Paid by card', 'and a card sale says card');

  const part = activityLine(ACTIVITY[2]!, tz, m);
  expect(part.what === 'Refund · #1019 (part)', 'a partial refund says (part)');
  expect(part.sub.startsWith('Approved by Vendlyfy · ') && part.sub.includes(' of '), 'and how much of the order');
  expect(part.amount.startsWith('−'), 'a refund takes — with the board\'s true minus, not a hyphen');
  expect(activityLine(ACTIVITY[3]!, tz, m).sub === 'Refunded before it cleared · Never reached Available', 'a refund from Pending says it never reached Available');

  expect(activityLine(ACTIVITY[4]!, tz, m).what === 'Automatic payout' && activityLine(ACTIVITY[4]!, tz, m).chip.label === 'Paid out', 'an arrived automatic payout is Paid out');
  const failed = activityLine(ACTIVITY[5]!, tz, m);
  expect(failed.amount === '—' && failed.chip.label === 'Failed' && failed.sub.endsWith('Returned to Available'), 'a failed payout moved nothing, and says the money is back');
  expect(failed.sub.includes('078 ••• 4412') && !failed.sub.includes('0781114412'), 'and the number is never printed whole');

  expect(payoutLine(PAYOUTS[0]!, tz).chip.label === 'Completed' && payoutLine(PAYOUTS[0]!, tz).note.startsWith('Arrived '), 'the Withdrawals tab says Completed and when it arrived');
  expect(payoutLine(PAYOUTS[1]!, tz).chip.label === 'Processing', 'in flight is Processing');
  expect(payoutLine(PAYOUTS[2]!, tz).canRetry && !payoutLine(PAYOUTS[3]!, tz).canRetry, 'a failed one can be retried; a rejected one is a decision');
  expect(payoutLine(PAYOUTS[2]!, tz).note.endsWith('Money returned to Available.'), 'both say where the money went');

  expect(refundLine(WALLET_REFUNDS[0]!, tz, m).chip.label === 'Waiting for Vendlyfy', 'a pending refund waits for Vendlyfy');
  expect(refundLine(WALLET_REFUNDS[1]!, tz, m).amount.includes('of'), 'a part refund shows of the order total');
  expect(refundLine(WALLET_REFUNDS[2]!, tz, m).amount.endsWith('(full)'), 'a refund of the whole order says (full)');
  expect(refundLine(WALLET_REFUNDS[2]!, tz, m).note.startsWith('Vendlyfy: '), 'a rejection quotes Vendlyfy');
  expect(refundLine(WALLET_REFUNDS[3]!, tz, m).chip.label === 'Approved · waiting for funds' && refundLine(WALLET_REFUNDS[3]!, tz, m).reason === 'Customer sent it back', 'a queued refund says so, and "other" shows the merchant\'s own note');

  // The four steps.
  expect(flowSteps({ mode: 'automatic', locked: false, automaticAt: '08:00', holdMinutes: 60 })[3]!.title === 'Paid out at 08:00', 'automatic reads Paid out at 08:00');
  expect(flowSteps({ mode: 'manual', locked: false, automaticAt: null, holdMinutes: 60 })[3]!.title === 'Paid out when you withdraw', 'manual reads when you withdraw');
  expect(flowSteps({ mode: 'manual', locked: true, automaticAt: null, holdMinutes: 60 })[3]!.body === 'On hold until your identity is verified.', 'a locked store says why');
  expect(flowSteps({ mode: 'manual', locked: false, automaticAt: null, holdMinutes: 90 })[1]!.body.includes('90 minutes'), 'the hold is the configured one, not a hard-coded 60');

  expect(lockFor('verified') === null, 'a verified store has no banner');
  expect(lockFor('in_review')!.title === 'Payouts are on hold while we check your ID', 'in review has the board\'s own title');
  expect(lockFor('not_started')!.title === 'Verify your identity to get paid', 'not started too');

  expect(availableNote({ locked: true, mode: 'automatic', methodKey: 'mtn_momo', phoneMasked: '078 ••• 4412', automaticAt: '08:00', storeNowHHMM: '09:00' }) === 'Yours, but held until you’re verified.', 'a locked store\'s money is held');
  expect(availableNote({ locked: false, mode: 'manual', methodKey: 'mtn_momo', phoneMasked: 'x', automaticAt: null, storeNowHHMM: '09:00' }) === 'Stays here until you withdraw.', 'manual stays put');
  expect(availableNote({ locked: false, mode: 'automatic', methodKey: 'mtn_momo', phoneMasked: '078 ••• 4412', automaticAt: '08:00', storeNowHHMM: '09:00' }) === 'Goes to MTN MoMo 078 ••• 4412 tomorrow at 08:00.', 'after 08:00 the next payout is tomorrow');
  expect(availableNote({ locked: false, mode: 'automatic', methodKey: 'mtn_momo', phoneMasked: '078 ••• 4412', automaticAt: '08:00', storeNowHHMM: '07:00' }).endsWith('today at 08:00.'), 'and before it, today');
  expect(pendingNote(0, null, tz, m).startsWith('Nothing waiting'), 'nothing pending says so');
  expect(pendingNote(1, WALLET.nextRelease, tz, m).startsWith('From 1 order.'), 'one order is singular');
  expect(pendingNote(3, WALLET.nextRelease, tz, m).includes('becomes available at'), 'three orders says when the next clears');

  // Stamps.
  const noon = new Date('2026-10-05T12:00:00Z');
  expect(stamp('2026-10-05T11:02:00Z', tz, noon) === 'Today 13:02', 'a stamp is in the store\'s zone (Kigali is UTC+2)');
  expect(stamp('2026-10-04T19:10:00Z', tz, noon) === 'Yesterday 21:10', 'yesterday keeps its clock time');
  expect(/^20 Sep\w* \d\d:\d\d$/.test(stamp('2026-09-20T13:12:00Z', tz, noon)), 'older ones carry the date and the time');
}


// --- support and insight — milestone 24 ----------------------------------------------------------
const COMPLAINT_LIST: ComplaintListItem[] = [
  { id: 'cp1', reference: 'C-051', reason: 'item_missing', customer: 'Sandrine Keza', orderNumber: 1023, at: iso(2 * HOUR), status: 'open' },
  { id: 'cp2', reference: 'C-050', reason: 'quality_problem', customer: 'Pacifique Irakoze', orderNumber: 1027, at: iso(5 * HOUR), status: 'open' },
];

const COMPLAINT: ComplaintDetail = {
  id: 'cp1',
  reference: 'C-051',
  reason: 'item_missing',
  status: 'open',
  text: 'The salad wasn’t in the bag. Everything else was fine.',
  at: iso(2 * HOUR),
  reopenedCount: 0,
  customer: { name: 'Sandrine Keza', phone: '078 543 6671' },
  order: {
    id: 'o1',
    number: 1023,
    items: [{ label: '2× Grilled chicken', amount: '12500.00' }, { label: '1× Salad', amount: '3000.00' }],
    total: '15500.00',
    refunded: '0.00',
    deliveredAt: iso(3 * HOUR),
    riderName: 'Claude Habineza',
    paymentMethod: 'mtn_momo',
    fulfilment: 'delivery',
  },
  evidence: [{ id: 'e1', side: 'customer', kind: 'photo', label: 'Photo of bag', url: null }],
  timeline: [{ type: 'filed', side: 'customer', note: null, at: iso(2 * HOUR), actor: null }],
  decision: null,
  pendingRefund: null,
};

const COMPLAINT_ESCALATED: ComplaintDetail = {
  ...COMPLAINT,
  id: 'cp3',
  reference: 'C-047',
  reason: 'wrong_item',
  status: 'escalated',
  timeline: [
    { type: 'filed', side: 'customer', note: null, at: iso(60 * HOUR), actor: null },
    { type: 'rejected', side: 'store', note: 'Our packing photo shows the platter.', at: iso(59 * HOUR), actor: 'Aline Uwase' },
    { type: 'reopened', side: 'customer', note: null, at: iso(50 * HOUR), actor: null },
    { type: 'escalated', side: 'store', note: 'We disagree on what was delivered.', at: iso(48 * HOUR), actor: 'Aline Uwase' },
  ],
};

const REVIEWS_PAGE: ReviewsPage = {
  overview: { averageRating: '4.3', last90Days: 126, needsReply: 3, lowThisMonth: 4, lowLastMonth: 7, reportedOpen: 1 },
  reviews: [
    { id: 'rv1', product: 'Grilled chicken', customer: 'Pacifique I.', orderNumber: 1027, at: iso(5 * HOUR), rating: 2, body: 'Tasty but arrived cold.', reply: null, reported: null },
    { id: 'rv2', product: 'Chicken burger', customer: 'Sandrine K.', orderNumber: 1023, at: iso(HOUR), rating: 5, body: 'Juicy and the sauce is perfect.', reply: null, reported: null },
    { id: 'rv3', product: 'Grilled chicken', customer: 'Kevin M.', orderNumber: 1011, at: iso(48 * HOUR), rating: 4, body: 'Great taste, fries a bit soft.', reply: 'Thanks Kevin! We’ve switched to vented boxes for fries.', reported: null },
    { id: 'rv4', product: 'Brochette platter', customer: 'Anonymous123', orderNumber: 901, at: iso(72 * HOUR), rating: 1, body: 'Worst place ever, the owner is a thief.', reply: null, reported: { reason: 'abusive' } },
  ],
  nextCursor: null,
  byProduct: [
    { id: 'p1', name: 'Chicken burger', count: 58, average: '4.6' },
    { id: 'p2', name: 'Grilled chicken', count: 41, average: '4.1' },
    { id: 'p3', name: 'Veggie wrap', count: 2, average: null },
    { id: 'p4', name: 'Mango juice', count: 0, average: null },
  ],
  minForAverage: 3,
};

const CUSTOMER_LIST: CustomerList = {
  rows: [
    { key: '784551209', name: 'Grace Ingabire', phone: '078 455 1209', orders: 14, spent: '168000.00', lastOrderAt: iso(2 * HOUR), account: true, complaints: 1 },
    { key: '785436671', name: 'Sandrine Keza', phone: '078 543 6671', orders: 6, spent: '81000.00', lastOrderAt: iso(3 * HOUR), account: true, complaints: 1 },
    { key: '783301180', name: 'Aimable Kayitare', phone: '078 330 1180', orders: 1, spent: '8500.00', lastOrderAt: iso(4 * HOUR), account: false, complaints: 0 },
  ],
  total: 1240,
  page: 1,
  pageSize: 25,
  counts: { all: 1240, regular: 86, account: 410, guest: 830 },
};

const CUSTOMER: CustomerDetail = {
  ...CUSTOMER_LIST.rows[1]!,
  usualAddress: 'KG 7 Ave, Kimihurura',
  recent: [
    { id: 'o1', number: 1026, at: iso(3 * HOUR), total: '12000.00', status: 'delivered' },
    { id: 'o2', number: 990, at: iso(96 * HOUR), total: '7000.00', status: 'delivered' },
  ],
  note: 'Allergic to peanuts',
};

const DAYS14 = Array.from({ length: 14 }, (_, i) => `2026-09-${String(10 + i).padStart(2, '0')}`);
const ANALYTICS_REVENUE: AnalyticsPayload & { range: number; from: string; to: string } = {
  tab: 'summary',
  range: 14,
  from: '2026-09-10',
  to: '2026-09-23',
  data: {
    dates: DAYS14,
    methods: [
      { key: 'mtn_momo', name: 'MTN MoMo', kind: 'online' },
      { key: 'cash', name: 'Cash on delivery', kind: 'offline' },
      { key: 'airtel_money', name: 'Airtel Money', kind: 'online' },
    ],
    byDay: Object.fromEntries(DAYS14.map((d, i) => [d, { mtn_momo: String(310000 + i * 9000), cash: String(110000 + i * 3000) }])),
    revenue: '6800000.00',
    previousRevenue: '6070000.00',
    orders: 810,
    previousOrders: 750,
    refunded: '94500.00',
    pendingNow: '42000.00',
    paidOut: '5900000.00',
    automaticPayouts: 14,
    repeatShare: 41,
  },
};

const ANALYTICS_ITEMS: AnalyticsPayload & { range: number; from: string; to: string } = {
  tab: 'items', range: 14, from: '2026-09-10', to: '2026-09-23',
  data: { items: [{ name: 'Grilled chicken', sold: 230, revenue: '1840000.00' }, { name: 'Chicken burger', sold: 412, revenue: '1442000.00' }, { name: 'Fries', sold: 520, revenue: '780000.00' }], itemsSold: 1778, bestSeller: 'Fries', topEarner: 'Grilled chicken', outOfStockNow: 2 },
};

const ANALYTICS_DELIVERY: AnalyticsPayload & { range: number; from: string; to: string } = {
  tab: 'delivery', range: 14, from: '2026-09-10', to: '2026-09-23',
  data: {
    riders: [
      { id: 'r1', name: 'Eric Mugisha', deliveries: 212, avgMinutes: 24, onTimeShare: 94 },
      { id: 'r2', name: 'Claude Habineza', deliveries: 180, avgMinutes: 27, onTimeShare: 88 },
      { id: 'r3', name: 'Olivier Nzeyimana', deliveries: 96, avgMinutes: 31, onTimeShare: 81 },
    ],
    orderToDoorMinutes: 38, prepMinutes: 14, waitingForRiderMinutes: 6, returned: 4, topReturnReason: 'Customer not answering', etaMaxMinutes: 60,
  },
};

const ANALYTICS_ORDERS: AnalyticsPayload & { range: number; from: string; to: string } = {
  tab: 'orders', range: 14, from: '2026-09-10', to: '2026-09-23',
  data: { dates: DAYS14, perDay: Object.fromEntries(DAYS14.map((d, i) => [d, 40 + i * 3])), total: 810, previousTotal: 750, deliveryShare: 72, turnedAway: 49, topReason: 'Item out of stock', acceptMinutes: 2.1, busiestHour: 12 },
};

const ANALYTICS_PAYMENTS: AnalyticsPayload & { range: number; from: string; to: string } = {
  tab: 'payments', range: 14, from: '2026-09-10', to: '2026-09-23',
  data: {
    methods: [
      { key: 'mtn_momo', name: 'MTN MoMo', kind: 'online', orders: 470, revenue: '4200000.00', successRate: 98.9 },
      { key: 'cash', name: 'Cash on delivery', kind: 'offline', orders: 220, revenue: '1500000.00', successRate: null },
    ],
    paidOnlineShare: 73, failedPayments: 31, retriedAfterFailure: 22, cashUnconfirmed: { orders: 1, amount: '12500.00' }, refunds: { count: 6, amount: '94500.00' },
  },
};

{
  const m = (v: string): string => formatMoney(v, CURRENCY);

  // Complaints — the board's words.
  expect(reasonLabel('item_missing') === 'Missing item' && reasonLabel('arrived_late') === 'Late delivery', 'a complaint reason reads as the board words it');
  expect(COMPLAINT_BADGE.open.label === 'Needs a reply' && COMPLAINT_BADGE.escalated.label === 'With Vendlyfy', 'the badges say whose move it is');
  expect(ageShort(iso(2 * HOUR)) === '2 h' && ageShort(iso(5 * 24 * HOUR)) === '5 d' && ageShort(iso(30 * 60_000)) === '30 min', 'a complaint\'s age reads 30 min, 2 h, 5 d');
  expect(RESPONSES.resolve.submit === 'Send and resolve' && RESPONSES.reject.submit === 'Reject complaint' && RESPONSES.escalate.submit === 'Escalate to Vendlyfy', 'the three buttons');
  expect(RESPONSES.escalate.help.includes('can refund from your wallet'), 'escalating says Vendlyfy can refund from the wallet');
  expect(closedNote('open') === '' && closedNote('escalated').includes('comes out of your available balance'), 'an open complaint has no closed note; an escalated one explains the wallet');
  expect(canReopen('resolved') && canReopen('rejected') && !canReopen('open') && !canReopen('escalated'), 'only a resolved or rejected complaint can be reopened');
  expect(timelineLine(COMPLAINT_ESCALATED.timeline[0]!, 'Aline Uwase') === 'Complaint filed by customer', 'the first line is the filing');
  expect(timelineLine(COMPLAINT_ESCALATED.timeline[1]!, 'Aline Uwase') === 'You rejected: “Our packing photo shows the platter.”', 'your own action is "You"');
  expect(timelineLine(COMPLAINT_ESCALATED.timeline[1]!, 'Somebody Else') === 'Aline Uwase rejected: “Our packing photo shows the platter.”', 'a colleague is named, not called You');
  expect(timelineLine(COMPLAINT_ESCALATED.timeline[2]!, 'Aline Uwase') === 'Customer reopened it', 'a customer reopen reads that way');
  expect(timelineLine({ type: 'reopened', side: 'store', note: null, at: iso(0), actor: 'Aline Uwase' }, 'Aline Uwase') === 'Reopened by you', 'and your own reopen');
  expect(timelineLine(COMPLAINT_ESCALATED.timeline[3]!, 'Aline Uwase').startsWith('You escalated to Vendlyfy: “'), 'escalating reads that way');
  expect(deliveryLine(COMPLAINT.order, () => '14:02') === 'Delivered by Claude H. at 14:02 · paid by MTN MoMo', 'the order card says who delivered, when, and how it was paid');
  expect(deliveryLine({ ...COMPLAINT.order, deliveredAt: null, fulfilment: 'pickup' }, () => '') === 'Pickup · paid by MTN MoMo', 'a pickup order says Pickup');

  // Reviews.
  expect(stars(4) === '★★★★☆' && stars(1) === '★☆☆☆☆', 'stars are always five wide');
  expect(lowTrend(4, 7) === 'Down from 7 last month' && lowTrend(9, 7) === 'Up from 7 last month' && lowTrend(3, 3) === 'Same as last month', 'the month-on-month line says which way');
  expect(productRating({ count: 58, average: '4.6' }).text === '★ 4.6 (58)', 'three or more reviews show an average');
  expect(productRating({ count: 2, average: null }).text === '2 reviews' && productRating({ count: 1, average: null }).text === '1 review', 'under three, the count — never an average of one');
  expect(productRating({ count: 0, average: null }).text === 'No reviews', 'and none says so');
  expect(reportReasonLabel('personal_info') === 'shares personal info', 'a report reason reads in a sentence');

  // Analytics.
  expect(delta(6800000, 6070000, 14).text === '+12% vs previous 14 days' && delta(6800000, 6070000, 14).tone === 'good', 'a rise reads +12% and is good');
  expect(delta(90, 100, 7).text === '−10% vs previous 7 days' && delta(90, 100, 7).tone === 'bad', 'a fall reads with a true minus and is bad');
  expect(delta(5, 0, 7).text === 'Nothing to compare with yet', 'with no previous period it says so rather than printing infinity');
  expect(compact('6800000.00', 'RWF') === '6.8M RWF' && compact('84000.00', 'RWF') === '84K RWF' && compact('8400.00', 'RWF') === '8,400 RWF', 'big figures are compact, small ones exact');
  expect(formatDay('2026-09-10') === '10 Sep', 'an axis label is the store\'s own date, unshifted');
  expect(chartTitle('revenue', ['2026-09-10', '2026-09-23']) === 'Revenue per day, 10 Sep–23 Sep', 'the chart title names its span');
  const tiles = summaryTiles(ANALYTICS_REVENUE.data as never, 14, 'RWF', m);
  expect(tiles.length === 4 && tiles[0]!.value === '6.8M RWF' && tiles[3]!.value === '41%', 'summary has the board\'s four tiles');
  expect(itemsTiles(ANALYTICS_ITEMS.data as never)[3]!.label === 'Out of stock now', 'the stock tile says what is known, not what would need a history');
  expect(ordersNote(ANALYTICS_ORDERS.data as never).includes('Busiest hour: 12:00–13:00.'), 'the orders note names the busiest hour');
  expect(ordersTiles(ANALYTICS_ORDERS.data as never, 14)[1]!.value === '72% / 28%', 'delivery and pickup add to a hundred');
  expect(paymentsTiles(ANALYTICS_PAYMENTS.data as never, m)[2]!.tone === 'bad', 'unconfirmed cash is flagged');
  expect(onTimeTone(94) === 'good' && onTimeTone(88) === 'warn' && onTimeTone(81) === 'bad' && onTimeTone(null) === 'none', 'the on-time bar goes green from 90, amber from 85, red below');
  expect(revenueNote(ANALYTICS_REVENUE.data as never).includes('Today is partial'), 'the revenue note says today is partial');
}


// --- the studios — milestone 25 ------------------------------------------------------------------
// THE STUDIO PARTS ARE RENDERED INTO allHtml BUT NOT kitHtml, the exception TokenSheet already has, and for the same
// reason: their whole purpose is to show merchant-chosen colours — swatches, a generated palette, a preview painted in it —
// so a hex in their markup is the feature, not a value that escaped the token layer.
const KICKS: ThemeInputs = { brand: '#E4572E', accent: '#F4D35E', harmony: 'complementary', mood: 'light', shape: 'round', headingFont: 'sport', cardTreatment: 'shadow', hero: 'fill' };
const RUN: ThemeInputs = { brand: '#C6F432', accent: null, harmony: 'split', mood: 'dark', shape: 'soft', headingFont: 'modern', cardTreatment: 'flat', hero: 'fill' };
const LIST_DESIGN: Design = { productLayout: 'list', sections: { promo: false, categories: true, featured: false, info: true }, logoUrl: null };

{
  // The look tables are the board's own SHAPES and FONTS.
  const sharp = storeLookVariables({ shape: 'sharp', headingFont: 'modern', cardTreatment: 'flat' }, false);
  expect(sharp['--store-radius-card'] === '2px' && sharp['--store-radius-control'] === '2px', 'sharp is 2px everywhere, as the board draws it');
  const soft = storeLookVariables({ shape: 'soft', headingFont: 'modern', cardTreatment: 'flat' }, false);
  expect(soft['--store-radius-card'] === '14px' && soft['--store-radius-control'] === '10px' && soft['--store-radius-chip'] === '8px', 'soft is 14 / 10 / 8');
  const round = storeLookVariables({ shape: 'round', headingFont: 'modern', cardTreatment: 'flat' }, false);
  expect(round['--store-radius-card'] === '24px' && round['--store-radius-pill'] === '999px', 'round is 24px cards and fully round pills');
  expect(round['--store-radius-control'] === '22px', 'a round BUTTON is a pill at the kit\'s 44px; a field is not turned into a capsule it was never drawn as');

  const sport = storeLookVariables({ shape: 'soft', headingFont: 'sport', cardTreatment: 'flat' }, false);
  expect(sport['--store-heading-style'] === 'italic' && sport['--store-heading-transform'] === 'uppercase', 'Sport headings are italic and upper-case');
  expect(storeLookVariables({ shape: 'soft', headingFont: 'editorial', cardTreatment: 'flat' }, false)['--store-font-display']!.includes('Fraunces'), 'Editorial is Fraunces');
  expect(storeLookVariables({ shape: 'soft', headingFont: 'classic', cardTreatment: 'flat' }, false)['--store-font-display']!.includes('DM Serif Display'), 'Classic is DM Serif Display');

  const raised = storeLookVariables({ shape: 'soft', headingFont: 'modern', cardTreatment: 'shadow' }, false);
  const raisedDark = storeLookVariables({ shape: 'soft', headingFont: 'modern', cardTreatment: 'shadow' }, true);
  expect(raised['--store-card-shadow']!.includes('0.10') && raisedDark['--store-card-shadow']!.includes('0.45'), 'a raised card\'s shadow is stronger on a dark page');
  expect(storeLookVariables({ shape: 'soft', headingFont: 'modern', cardTreatment: 'outlined' }, false)['--store-card-edge'] === 'var(--store-border)', 'an outlined card takes the store\'s border colour');
  expect(storeLookVariables({ shape: 'soft', headingFont: 'modern', cardTreatment: 'flat' }, false)['--store-card-shadow'] === 'none', 'a flat card has no shadow');

  // The palette variables are exactly the compiler's output, and nothing else.
  const vars = storeThemeVariables(compileTheme(KICKS).colors);
  expect(Object.keys(vars).length === 12 && vars['--store-primary'] === compileTheme(KICKS).colors.primary, 'twelve palette variables, taken from the compiler');
  expect(Object.keys(storeThemeVariables({ ...compileTheme(KICKS).colors, bg: 'red; background: url(x)' })).length === 11, 'a value that is not a hex never becomes a variable');

  // Studio rules.
  expect(normaliseHex('e4572e') === '#E4572E' && normaliseHex('#e4572e') === '#E4572E', 'a typed hex is normalised to the compiler\'s form');
  expect(accentClashes('#1D6B47', '#1E6C48'), 'a second colour nearly identical to the brand clashes');
  expect(!accentClashes('#E4572E', '#2EC4B6'), 'a contrasting one does not');
  expect(!accentClashes('#17160F', '#FFFFFF'), 'black and white are far apart in luminance');
  expect(toPreview([{ id: 'p', name: 'Fries', sub: '', categories: ['Sides'], price: '1500.00', trackStock: false, stock: null, state: 'ok', status: 'active', coverImageUrl: null }, { id: 'd', name: 'Hidden', sub: '', categories: [], price: '1.00', trackStock: false, stock: null, state: 'draft', status: 'draft', coverImageUrl: null }], (v) => `${v} RWF`).length === 1, 'the preview shows only live products');
  expect(SAMPLE_PRODUCTS.length === 8 && SAMPLE_CATEGORIES.length === 4, 'a store with nothing yet still has something to judge a look by');
  expect(DEFAULT_INPUTS.brand === '#1D6B47', 'a store that never opened the studio starts from the platform\'s green');
}

const studioParts: readonly (readonly [string, ReactNode])[] = [
  ['ThemeStudio · a light look', inConsole(<ThemeStudio navigate={noop} initial={{ inputs: DEFAULT_INPUTS, design: DEFAULT_DESIGN }} />)],
  ['ThemeStudio · Kigali Kicks, manual second color', inConsole(<ThemeStudio navigate={noop} initial={{ inputs: KICKS, design: DEFAULT_DESIGN }} />)],
  ['ThemeStudio · a dark look', inConsole(<ThemeStudio navigate={noop} initial={{ inputs: RUN, design: DEFAULT_DESIGN }} />)],
  ['Customize · mobile preview, grid', inConsole(<Customize navigate={noop} initial={{ inputs: DEFAULT_INPUTS, design: DEFAULT_DESIGN }} />)],
  ['Customize · desktop preview, list with sections off', inConsole(<Customize navigate={noop} initialDevice="desktop" initial={{ inputs: KICKS, design: LIST_DESIGN }} initialProducts={[{ id: 'a1', name: 'Chicken Burger', meta: 'Burgers', price: '3,500 RWF' }, { id: 'a2', name: 'Fries', meta: 'Sides', price: '1,500 RWF' }]} initialCategories={['Burgers', 'Sides']} />)],
  ['Customize · with a logo', inConsole(<Customize navigate={noop} initial={{ inputs: RUN, design: { ...DEFAULT_DESIGN, logoUrl: '/api/media/s1/0123456789abcdef0123456789abcdef.png' } }} />)],
  ['StorePreview · every section on', <StorePreview key="p1" theme={compileTheme(KICKS)} design={DEFAULT_DESIGN} device="mobile" storeName="Kigali Kicks" products={SAMPLE_PRODUCTS} categories={SAMPLE_CATEGORIES} cartTotal="113,000 RWF" />],
  ['StorePreview · every section off', <StorePreview key="p2" theme={compileTheme(RUN)} design={{ ...DEFAULT_DESIGN, sections: { promo: false, categories: false, featured: false, info: false } }} device="desktop" storeName="Run Rwanda" products={SAMPLE_PRODUCTS} categories={SAMPLE_CATEGORIES} cartTotal="113,000 RWF" />],
];

const studioHtml: string[] = [];
for (const [name, node] of studioParts) {
  const html = render(name, node);
  allHtml += html;
  studioHtml.push(html);
}
const studioText = studioHtml.join(' ').replace(/<[^>]+>/g, ' ').replaceAll('&amp;', '&').replace(/\s+/g, ' ');
expect(studioHtml.length === studioParts.length, 'every studio part rendered');
expect(studioHtml[6]!.includes('--store-primary:'), 'the preview carries the compiler\'s palette as variables on its own subtree');
expect(studioHtml[6]!.includes('Popular right now') && studioHtml[6]!.includes('Your promotion') && studioHtml[6]!.includes('Weekdays 12:00–15:00'), 'with every section on, the preview shows each');
expect(!studioHtml[7]!.includes('Popular right now') && !studioHtml[7]!.includes('Your promotion') && !studioHtml[7]!.includes('Weekdays'), 'with every section off, none of them is drawn');
expect(studioHtml[7]!.includes('View cart'), 'but the cart bar is not a section: it stays');
expect(studioHtml[4]!.includes('flex-col gap-2') && !studioHtml[4]!.includes('grid-cols-4'), 'the list layout is rows, not the four-column desktop grid');
expect(studioHtml[3]!.includes('grid-cols-2'), 'the mobile grid is two columns');
expect(studioHtml[5]!.includes('0123456789abcdef0123456789abcdef.png'), 'a logo replaces the letter mark');
expect(studioText.includes('Pick your colors. Vendlyfy builds the rest and keeps it readable.'), 'ThemeStudio\'s own subtitle');
expect(studioText.includes('For sale badges and highlights.') && studioText.includes('Let Vendlyfy pick'), 'the second-color panel');
expect(studioText.includes('Nothing. Your colors work exactly as picked.') || studioText.includes('nudged'), 'the adjustment notes say what was done, or that nothing was');
expect(studioText.includes('Text needs 4.5:1 against its background, buttons need 3:1 against the page.'), 'the readability footnote');
expect(studioText.includes('Changes are saved as a draft') && studioText.includes('Homepage sections') && studioText.includes('The products section is always shown.'), 'Customize\'s own wording');
expect(studioText.includes('Replace logo') || studioText.includes('Add logo'), 'the logo control');

const SETTINGS_BASE: SettingsBase = {
  pickup: { address: 'KG 7 Ave, Kacyiru', readyMinutes: 15, instructions: null },
  payout: { methodKey: 'mtn_momo', phone: '0781234412', settlementMode: 'manual', automaticAt: null },
  paymentMethods: [{ key: 'mtn_momo', isConnected: true, connectedAt: '2026-01-01T00:00:00Z' }, { key: 'cash', isConnected: true, connectedAt: '2026-01-01T00:00:00Z' }],
};
const SETTINGS_EXTRA: SettingsExtra = {
  store: { name: 'Nyama & Co.', slug: 'nyama', publicPhone: '0788000111', address: 'KG 7 Ave, Kacyiru', timeZone: 'Africa/Kigali', acceptingOrders: true },
  zones: [
    { id: 'z1', name: 'Kigali city centre', feeAmount: '1000.00', etaMinMinutes: 25, etaMaxMinutes: 35, isActive: true, areas: ['Kacyiru', 'Kimihurura', 'Kiyovu'] },
    { id: 'z2', name: 'Outer Kigali', feeAmount: '0.00', etaMinMinutes: 40, etaMaxMinutes: 60, isActive: true, areas: ['Kanombe', 'Remera', 'Gikondo', 'Nyamirambo', 'Kicukiro'] },
  ],
  hours: [1, 2, 3, 4, 5].map((day) => ({ day, opens: '09:00', closes: '18:00' })),
  catalogue: [
    { key: 'mtn_momo', name: 'MTN MoMo', kind: 'online', status: 'live' },
    { key: 'airtel_money', name: 'Airtel Money', kind: 'online', status: 'live' },
    { key: 'mpesa', name: 'M-Pesa', kind: 'online', status: 'draft' },
    { key: 'cash', name: 'Cash on delivery', kind: 'offline', status: 'live' },
  ],
};
const SETTINGS_MEMBERS: Member[] = [
  { user_id: 'u1', name: 'Aline Uwase', email: 'aline@nyama.rw', phone: null, role: 'owner', created_at: '2026-01-01', created_by: null, plate_number: null, availability: null },
  { user_id: 'u2', name: 'Eric Mugisha', email: 'eric@nyama.rw', phone: '0788111222', role: 'manager', created_at: '2026-02-01', created_by: 'u1', plate_number: null, availability: null },
  { user_id: 'u3', name: 'Jean Claude', email: 'jc@nyama.rw', phone: null, role: 'rider', created_at: '2026-02-02', created_by: 'u1', plate_number: 'RAE 123 B', availability: 'available' },
];
const SETTINGS_SEED = { base: SETTINGS_BASE, extra: SETTINGS_EXTRA, members: SETTINGS_MEMBERS };

const consoleParts: readonly (readonly [string, ReactNode])[] = [
  ['Sidebar', inConsole(<Sidebar active="dashboard" unread={7} onOpenNotifications={noop} navigate={noop} />)],
  ['DashboardMobile · bottom bar', inConsole(<MobileTabs active="dashboard" navigate={noop} />)],
  ['Dashboard', inConsole(<Dashboard data={DASHBOARD} onChanged={noop} navigate={noop} />)],
  // A manager's dashboard: no sales card, no chart, and the rest unchanged. The route omits the money rather
  // than the screen hiding it, so this is the payload a manager actually receives.
  [
    'Dashboard · a manager, with no wallet.read',
    inConsole(<Dashboard data={{ ...DASHBOARD, sales: null, week: null }} onChanged={noop} navigate={noop} />),
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
        navigate={noop}
      />,
    ),
  ],
  // Paused, which is a different sentence from closed: the shop is open and the kitchen has stopped.
  [
    'Dashboard · new orders paused',
    inConsole(
      <Dashboard
        data={{ ...DASHBOARD, counts: { ...DASHBOARD.counts, acceptingOrders: false } }}
        onChanged={noop}
        navigate={noop}
      />,
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
  // Orders — milestone 20. `initialOrders`/`initialDetail`/`initialMode` are the testing seam its own header
  // explains: renderToStaticMarkup runs no effects, so list() never resolves here, the same reason Dashboard
  // takes its payload as a prop rather than fetching it.
  ['Orders · board, all six columns', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} />)],
  ['Orders · detail, pending and waiting', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={DETAIL_PENDING} />)],
  ['Orders · detail, ready with no rider yet', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={DETAIL_READY_NO_RIDER} />)],
  ['Orders · detail, assigned to a rider', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={DETAIL_ASSIGNED} />)],
  ['Orders · detail, delivered with cash unconfirmed', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={DETAIL_CASH_UNCONFIRMED} />)],
  ['Orders · detail, delivered and paid', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={DETAIL_DELIVERED_PAID} />)],
  ['Orders · detail, returned to the store', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={DETAIL_RETURNED} />)],
  ['Orders · decline panel', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={DETAIL_PENDING} initialMode="decline" />)],
  ['Orders · cancel panel', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={orderDetail(ORDER_LIST[1]!)} initialMode="cancel" />)],
  ['Orders · rider picker', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={DETAIL_READY_NO_RIDER} initialMode="pick" />)],
  ['Orders · cash panel', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={DETAIL_CASH_UNCONFIRMED} initialMode="cash" />)],
  ['Orders · refund panel', inConsole(<Orders navigate={noop} initialOrders={ORDER_LIST} initialDetail={DETAIL_DELIVERED_PAID} initialMode="refund" />)],
  // The whole console, cold. It fetches on mount, so what this proves is that the first paint — the shell's
  // loading state — renders rather than throwing.
  ['Console · first paint', <Console slug="nyama" view={{ kind: 'dashboard' }} navigate={noop} />],
  ['Console · first paint, Orders', <Console slug="nyama" view={{ kind: 'orders' }} navigate={noop} />],
  ['Console · first paint, Riders & cash', <Console slug="nyama" view={{ kind: 'riders' }} navigate={noop} />],
  ['Console · first paint, Products', <Console slug="nyama" view={{ kind: 'products' }} navigate={noop} />],
  ['Console · first paint, AddProduct', <Console slug="nyama" view={{ kind: 'product', productId: null }} navigate={noop} />],
  ['Console · first paint, Categories', <Console slug="nyama" view={{ kind: 'categories' }} navigate={noop} />],

  // The catalogue — milestone 22. Same testing seam as Orders and CashReport.
  ['Products · a page of the list', inConsole(<Products navigate={noop} initialList={PRODUCT_LIST} initialCategories={SECTIONS} />)],
  ['Products · nothing matches the search', inConsole(<Products navigate={noop} initialList={{ ...PRODUCT_LIST, rows: [], total: 0 }} initialCategories={SECTIONS} />)],
  ['Products · a brand-new store', inConsole(<Products navigate={noop} initialList={{ ...PRODUCT_LIST, rows: [], total: 0, counts: { all: 0, active: 0, draft: 0, low: 0, out: 0 } }} initialCategories={[]} />)],
  ['AddProduct · new', inConsole(<ProductEditor navigate={noop} productId={null} initialState={EMPTY_STATE} initialCategories={SECTIONS} />)],
  ['AddProduct · a t-shirt with its 8-variant matrix', inConsole(<ProductEditor navigate={noop} productId={TSHIRT.id} initialState={TSHIRT_STATE} initialCategories={SECTIONS} />)],
  ['AddProduct · a product that has been ordered', inConsole(<ProductEditor navigate={noop} productId={TSHIRT.id} initialState={TSHIRT_STATE} initialSold initialCategories={SECTIONS} />)],
  ['AddProduct · a simple product with its own stock', inConsole(<ProductEditor navigate={noop} productId={null} initialState={{ ...EMPTY_STATE, name: 'Fries', price: '1500', trackStock: true, stock: '120', sku: 'NY-020' }} initialCategories={SECTIONS} />)],
  ['Categories · sections in every state', inConsole(<Categories initialRows={SECTIONS} />)],
  ['Categories · deleting a section that has products', inConsole(<Categories initialRows={SECTIONS} initialDoomed="c1" />)],
  ['Console · first paint, Money', <Console slug="nyama" view={{ kind: 'money' }} navigate={noop} />],
  ['Wallet · Activity, automatic payouts', inConsole(<Wallet navigate={noop} initialData={WALLET} initialActivity={ACTIVITY} />)],
  ['Wallet · Activity, nothing yet', inConsole(<Wallet navigate={noop} initialData={{ ...WALLET, pendingOrders: 0, nextRelease: null, pending: '0.00' }} initialActivity={[]} />)],
  ['Wallet · Withdrawals', inConsole(<Wallet navigate={noop} initialData={WALLET} initialActivity={ACTIVITY} initialPayouts={PAYOUTS} initialTab="withdrawals" />)],
  ['Wallet · Withdrawals, none yet', inConsole(<Wallet navigate={noop} initialData={WALLET} initialActivity={ACTIVITY} initialPayouts={[]} initialTab="withdrawals" />)],
  ['Wallet · Refunds', inConsole(<Wallet navigate={noop} initialData={WALLET} initialActivity={ACTIVITY} initialRefunds={WALLET_REFUNDS} initialTab="refunds" />)],
  ['Wallet · ID in review', inConsole(<Wallet navigate={noop} initialData={{ ...WALLET, identity: 'in_review' }} initialActivity={ACTIVITY} />)],
  ['Wallet · ID not started, manual payouts', inConsole(<Wallet navigate={noop} initialData={{ ...WALLET, identity: 'not_started', payout: { ...WALLET.payout!, mode: 'manual', automaticAt: null } }} initialActivity={ACTIVITY} />)],
  ['Wallet · approved refunds waiting for funds', inConsole(<Wallet navigate={noop} initialData={{ ...WALLET, refundsOwed: '2000.00' }} initialActivity={ACTIVITY} />)],
  ['Wallet · no payout number yet', inConsole(<Wallet navigate={noop} initialData={{ ...WALLET, payout: null }} initialActivity={ACTIVITY} />)],
  ['Wallet · the Withdraw sheet', inConsole(<Wallet navigate={noop} initialData={WALLET} initialActivity={ACTIVITY} initialSheet={{ amount: '50000' }} />)],
  ['Console · first paint, Complaints', <Console slug="nyama" view={{ kind: 'complaints' }} navigate={noop} />],
  ['Console · first paint, Reviews', <Console slug="nyama" view={{ kind: 'reviews' }} navigate={noop} />],
  ['Console · first paint, Customers', <Console slug="nyama" view={{ kind: 'customers' }} navigate={noop} />],
  ['Console · first paint, Analytics', <Console slug="nyama" view={{ kind: 'analytics' }} navigate={noop} />],
  ['Complaints · an open one, ready to answer', inConsole(<Complaints navigate={noop} initialCounts={{ open: 2, escalated: 1, closed: 3 }} initialList={COMPLAINT_LIST} initialDetail={COMPLAINT} />)],
  ['Complaints · the reject response', inConsole(<Complaints navigate={noop} initialCounts={{ open: 2, escalated: 1, closed: 3 }} initialList={COMPLAINT_LIST} initialDetail={COMPLAINT} initialKind="reject" initialNote="Our packing photo shows it." />)],
  ['Complaints · the escalate response', inConsole(<Complaints navigate={noop} initialCounts={{ open: 2, escalated: 1, closed: 3 }} initialList={COMPLAINT_LIST} initialDetail={COMPLAINT} initialKind="escalate" />)],
  ['Complaints · escalated, with the whole thread', inConsole(<Complaints navigate={noop} initialCounts={{ open: 1, escalated: 1, closed: 0 }} initialList={[{ ...COMPLAINT_LIST[0]!, id: 'cp3', status: 'escalated' }]} initialDetail={COMPLAINT_ESCALATED} />)],
  ['Complaints · resolved, with a refund waiting', inConsole(<Complaints navigate={noop} initialCounts={{ open: 0, escalated: 0, closed: 1 }} initialList={[{ ...COMPLAINT_LIST[0]!, status: 'resolved' }]} initialDetail={{ ...COMPLAINT, status: 'resolved', pendingRefund: '3000.00' }} />)],
  ['Complaints · none here', inConsole(<Complaints navigate={noop} initialCounts={{ open: 0, escalated: 0, closed: 0 }} initialList={[]} />)],
  ['Reviews · the page', inConsole(<Reviews initialPage={REVIEWS_PAGE} />)],
  ['Reviews · replying', inConsole(<Reviews initialPage={REVIEWS_PAGE} initialEditing={{ id: 'rv1', mode: 'reply' }} />)],
  ['Reviews · reporting', inConsole(<Reviews initialPage={REVIEWS_PAGE} initialEditing={{ id: 'rv4', mode: 'report' }} />)],
  ['Reviews · none yet', inConsole(<Reviews initialPage={{ ...REVIEWS_PAGE, reviews: [], overview: { averageRating: null, last90Days: 0, needsReply: 0, lowThisMonth: 0, lowLastMonth: 0, reportedOpen: 0 }, byProduct: [] }} />)],
  ['Customers · the list and one customer', inConsole(<Customers navigate={noop} initialList={CUSTOMER_LIST} initialDetail={CUSTOMER} />)],
  ['Customers · the list alone', inConsole(<Customers navigate={noop} initialList={CUSTOMER_LIST} />)],
  ['Customers · nobody yet', inConsole(<Customers navigate={noop} initialList={{ ...CUSTOMER_LIST, rows: [], total: 0, counts: { all: 0, regular: 0, account: 0, guest: 0 } }} />)],
  ['Analytics · Summary', inConsole(<Analytics initial={ANALYTICS_REVENUE} />)],
  ['Analytics · Orders over time', inConsole(<Analytics initial={ANALYTICS_ORDERS} initialTab="orders" />)],
  ['Analytics · Top items', inConsole(<Analytics initial={ANALYTICS_ITEMS} initialTab="items" />)],
  ['Analytics · Payment methods', inConsole(<Analytics initial={ANALYTICS_PAYMENTS} initialTab="payments" />)],
  ['Analytics · Delivery performance', inConsole(<Analytics initial={ANALYTICS_DELIVERY} initialTab="delivery" />)],
  ['Settings · all five panels', inConsole(<Settings navigate={noop} initial={SETTINGS_SEED} />)],
  ['Settings · add a delivery zone', inConsole(<Settings navigate={noop} initial={SETTINGS_SEED} initialOpen="zone" />)],
  ['Settings · pickup', inConsole(<Settings navigate={noop} initial={SETTINGS_SEED} initialOpen="pickup" />)],
  ['Settings · payout destination', inConsole(<Settings navigate={noop} initial={SETTINGS_SEED} initialOpen="payout" />)],
  ['Settings · add staff', inConsole(<Settings navigate={noop} initial={SETTINGS_SEED} initialOpen="staff" />)],
  ['Settings · change business type', inConsole(<Settings navigate={noop} initial={{ ...SETTINGS_SEED, templates: [{ key: 'food', name: 'Food & drinks' }, { key: 'fashion', name: 'Fashion' }] }} initialOpen="template" />)],
  ['Settings · nothing set up yet', inConsole(<Settings navigate={noop} initial={{ ...SETTINGS_SEED, base: { pickup: null, payout: null, paymentMethods: [] }, extra: { ...SETTINGS_SEED.extra, zones: [], hours: [] } }} />)],
  ['Categories · none yet', inConsole(<Categories initialRows={[]} />)],

  // CashReport — milestone 21. Same testing seam as Orders.tsx: no effects run in SSR.
  ['CashReport · roster, cards and a carried-over debt', inConsole(<CashReport initialRoster={ROSTER} initialCards={CASH_CARDS} initialCarriedOver={CARRIED_OVER} />)],
  ['CashReport · nothing to close today', inConsole(<CashReport initialRoster={ROSTER} initialCards={[]} initialCarriedOver={[]} />)],

  // The rider's own app — milestone 21. RiderApp is exported precisely so the gate can seed it, the
  // same reason Orders.tsx exports its own internals for testing.
  ['Rider · list, with a cash job and an online one', <RiderApp storeId="s1" initialData={RIDER_HOME} />],
  ['Rider · job detail, at the store (pick-up checklist)', <RiderApp storeId="s1" initialData={RIDER_HOME} initialSelectedId="j1" initialView="job" />],
  ['Rider · job detail, on the road', <RiderApp storeId="s1" initialData={RIDER_HOME} initialSelectedId="j2" initialView="job" />],
  ['Rider · the cash sheet', <RiderApp storeId="s1" initialData={RIDER_HOME} initialSelectedId="j3" initialView="job" initialMode="cash" />],
  ['Rider · the couldn\'t-deliver sheet', <RiderApp storeId="s1" initialData={RIDER_HOME} initialSelectedId="j2" initialView="job" initialMode="fail" />],
  ['Rider · no deliveries right now', <RiderApp storeId="s1" initialData={{ ...RIDER_HOME, jobs: [] }} />],
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


// --- milestone 26: the identity check and onboarding ---------------------------------------------------------------
const kycStatus = (outcome: KycStatus['outcome'], parts: [string, string][], over: Partial<NonNullable<KycStatus['submission']>> = {}): KycStatus => ({
  outcome,
  verified: outcome === 'approved',
  submission: outcome === 'none' ? null : { id: 'k1', reference: 5521, documentType: 'national_id', submittedAt: new Date().toISOString(), decisionNote: null, parts: parts.map(([part, state]) => ({ part: part as 'id_front', state: state as 'accepted', purged: false })), ...over },
});
const PARTS_OK: [string, string][] = [['id_front', 'accepted'], ['id_back', 'accepted'], ['face_video', 'accepted']];
const KYC_NONE = kycStatus('none', []);
const KYC_BUILDING = kycStatus('building', [['id_front', 'received'], ['id_back', 'missing'], ['face_video', 'missing']]);
const KYC_REVIEW = kycStatus('inReview', [['id_front', 'received'], ['id_back', 'received'], ['face_video', 'received']]);
const KYC_REDO = kycStatus('redoRequested', [['id_front', 'accepted'], ['id_back', 'retake'], ['face_video', 'accepted']], { decisionNote: 'The back of your ID is blurry, so we can’t read the numbers.' });
const KYC_REJECTED = kycStatus('rejected', [['id_front', 'received'], ['id_back', 'received'], ['face_video', 'received']], { decisionNote: 'The face in the video didn’t match the photo on the ID.' });
// The video of a decided case is gone — V028 + the sweep — and the screen says so.
const KYC_APPROVED: KycStatus = { ...kycStatus('approved', PARTS_OK), submission: { ...kycStatus('approved', PARTS_OK).submission!, parts: kycStatus('approved', PARTS_OK).submission!.parts.map((p) => (p.part === 'face_video' ? { ...p, purged: true } : p)) } };

const kycParts: readonly (readonly [string, ReactNode])[] = [
  ['Verify · intro', inConsole(<Verify navigate={noop} initial={{ status: KYC_NONE, step: 'intro' }} />)],
  ['Verify · intro, a case half built', inConsole(<Verify navigate={noop} initial={{ status: KYC_BUILDING, step: 'intro' }} />)],
  ['Verify · front of the ID, nothing taken yet', inConsole(<Verify navigate={noop} initial={{ status: KYC_NONE, step: 'front' }} />)],
  ['Verify · front, a good photo', inConsole(<Verify navigate={noop} initial={{ status: KYC_NONE, step: 'front', prepared: { good: true, checks: [{ label: 'No glare or shadow', ok: true }, { label: 'Text is sharp and readable', ok: true }] } }} />)],
  ['Verify · front, glare', inConsole(<Verify navigate={noop} initial={{ status: KYC_NONE, step: 'front', prepared: { good: false, checks: [{ label: 'Glare is covering your details. Tilt the card away from the light.', ok: false }, { label: 'Text is sharp and readable', ok: true }] } }} />)],
  ['Verify · back of the ID', inConsole(<Verify navigate={noop} initial={{ status: KYC_BUILDING, step: 'back' }} />)],
  ['Verify · passport photo page', inConsole(<Verify navigate={noop} initial={{ status: KYC_NONE, step: 'front', documentType: 'passport' }} />)],
  ['Verify · review', inConsole(<Verify navigate={noop} initial={{ status: kycStatus('building', [['id_front', 'received'], ['id_back', 'received'], ['face_video', 'received']]), step: 'review' }} />)],
  ['Verify · done', inConsole(<Verify navigate={noop} initial={{ status: KYC_REVIEW, step: 'done' }} />)],
  ['Verify · outcome, one photo to redo', inConsole(<Verify navigate={noop} initial={{ status: KYC_REDO, step: 'outcome' }} />)],
  ['Verify · outcome, rejected', inConsole(<Verify navigate={noop} initial={{ status: KYC_REJECTED, step: 'outcome' }} />)],
  ['Verify · outcome, in review', inConsole(<Verify navigate={noop} initial={{ status: KYC_REVIEW, step: 'outcome' }} />)],
  ['Verify · outcome, approved', inConsole(<Verify navigate={noop} initial={{ status: KYC_APPROVED, step: 'outcome' }} />)],
  ['Face · tips', <TipsView key="f1" onReady={noop} />],
  ['Face · blocked', <BlockedView key="f2" onTryAgain={noop} onClose={noop} />],
  ['Face · looking', <CameraView key="f3" phase="searching" t={0} autoStart onStart={noop} onClose={noop} />],
  ['Face · no detector, start by button', <CameraView key="f4" phase="ready" t={0} autoStart={false} onStart={noop} onClose={noop} />],
  ['Face · recording, turn left', <CameraView key="f5" phase="recording" t={1.6} autoStart onStart={noop} onClose={noop} />],
  ['Face · lost', <CameraView key="f6" phase="lost" t={0} autoStart onStart={noop} onClose={noop} />],
];
const onboardingParts: readonly (readonly [string, ReactNode])[] = [
  ['Onboarding · your business', <Onboarding key="o1" navigate={noop} initial={{ step: 0, industries: [{ key: 'food', name: 'Food & drinks' }, { key: 'fashion', name: 'Fashion' }] }} />],
  ['Onboarding · business filled in', <Onboarding key="o2" navigate={noop} initial={{ step: 0, industries: [{ key: 'food', name: 'Food & drinks' }, { key: 'fashion', name: 'Fashion' }], business: { name: 'Nyama & Co.', industry: 'food', slug: 'nyama-and-co' } }} />],
  ['Onboarding · your account', <Onboarding key="o3" navigate={noop} initial={{ step: 1, industries: [], business: { name: 'Nyama & Co.', industry: 'food', slug: 'nyama-and-co' } }} />],
  ['Onboarding · look and feel', <LookLayout key="o4" ready error={null} problem={null} color="#2A55A0" onColor={noop} logoUrl={null} onPickLogo={noop} onRemoveLogo={noop} fileInput={null} action={<span>Continue</span>} preview={<StorePreview theme={compileTheme({ ...DEFAULT_INPUTS, brand: '#2A55A0' })} design={DEFAULT_DESIGN} device="mobile" storeName="Nyama & Co." products={SAMPLE_PRODUCTS} categories={SAMPLE_CATEGORIES} cartTotal="0" />} />],
  ['Onboarding · first product', <Onboarding key="o5" navigate={noop} initial={{ step: 3, industries: [], business: { name: 'Nyama & Co.', industry: 'food', slug: 'nyama-and-co' }, created: { storeId: 's1', slug: 'nyama-and-co' } }} />],
  ['Onboarding · ready', <Onboarding key="o6" navigate={noop} initial={{ step: 4, industries: [], business: { name: 'Nyama & Co.', industry: 'food', slug: 'nyama-and-co' }, created: { storeId: 's1', slug: 'nyama-and-co' } }} />],
];

const kycHtml: string[] = [];
for (const [name, node] of [...kycParts, ...onboardingParts]) {
  const html = render(name, node);
  // The swatches and previews carry the brand's own hex as data, like the studios — see studioParts above.
  allHtml += html;
  kycHtml.push(html);
}
const kycText = kycHtml.join(' ').replace(/<[^>]+>/g, ' ').replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replace(/\s+/g, ' ');
const kycAt = (i: number): string => kycHtml[i]!.replace(/<[^>]+>/g, ' ').replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replace(/\s+/g, ' ');
expect(kycHtml.length === kycParts.length + onboardingParts.length, 'every identity and onboarding part rendered');

// The board's words, where they were kept.
expect(kycAt(0).includes('Before you get paid, we need to know it’s you') && kycAt(0).includes('Takes about 2 minutes. It protects your money and your customers.'), 'the intro');
expect(kycAt(0).includes('National ID') && kycAt(0).includes('Passport') && !kycAt(0).includes('Driving licence'), 'two documents, because the database knows two');
expect(kycAt(1).includes('Continue') && !kycAt(0).includes('Continue'), 'a half-built case says Continue, a fresh one says Start');
expect(kycAt(2).includes('Front of your ID') && kycAt(2).includes('Take photo') && kycAt(2).includes('Upload from gallery'), 'the capture screen offers the camera and the gallery');
expect(kycAt(3).includes('Use this photo') && kycAt(3).includes('Retake'), 'a good photo');
expect(kycAt(4).includes('Glare is covering your details. Tilt the card away from the light.') && kycAt(4).includes('Retake photo') && kycAt(4).includes('use it anyway'), 'a glare photo says why and still has a way forward');
expect(kycAt(5).includes('Back of your ID'), 'the back');
expect(kycAt(6).includes('Photo page of your passport'), 'a passport has one photo');
expect(kycAt(7).includes('Send for verification') && kycAt(7).includes('Face video'), 'review');
expect(kycAt(9).includes('One photo needs redoing') && kycAt(9).includes('What our team said') && kycAt(9).includes('The back of your ID is blurry') && kycAt(9).includes('Retake the back of my ID'), 'the redo outcome, with the reviewer\'s sentence and the one part');
expect(kycAt(9).includes('Accepted') && kycAt(9).includes('Retake'), 'two parts accepted, one to retake');
expect(kycAt(10).includes('We couldn’t verify you') && kycAt(10).includes('The face in the video didn’t match the photo on the ID.') && kycAt(10).includes('Start again') && kycAt(10).includes('Call Vendlyfy support'), 'rejected');
expect(kycAt(11).includes('We’re checking your ID') && kycAt(11).includes('Most checks are done within 24 hours.'), 'in review');
expect(kycAt(12).includes('You’re verified') && kycAt(12).includes('See my money') && kycAt(12).includes('deleted'), 'approved');
expect(kycAt(12).includes('Accepted · deleted'), 'a deleted video says so');
expect(!kycText.includes('[RETENTION PERIOD]') && !kycText.includes('RETENTION PERIOD'), 'the board\'s placeholder is not shown to a merchant');
expect(RETENTION_LINE.includes('face video is deleted') && RETENTION_LINE.includes('ID photos are kept'), 'the retention sentence says what is true');
expect(!kycText.includes('We’ll text') && !kycText.includes('text 078'), 'nothing promises an SMS the system cannot send');
expect(kycAt(13).includes('Now a short video of your face') && kycAt(13).includes('Good light') && kycAt(13).includes('Hold steady'), 'the face tips');
expect(kycAt(14).includes('We can’t use your camera'), 'a blocked camera has a screen');
expect(kycAt(15).includes('Looking for your face') && kycAt(16).includes('Start recording') && !kycAt(15).includes('Start recording'), 'no face detector → a button; with one → none');
expect(kycAt(17).includes('Slowly turn your head left') && kycAt(17).includes('0:04'), 'recording shows the prompt for that second and the countdown');
expect(kycAt(18).includes('We lost your face'), 'a lost face');

// The logic behind them.
const flat = (v: number, n = 40): { data: number[]; width: number; height: number } => ({ data: Array.from({ length: n * n * 4 }, (_, i) => (i % 4 === 3 ? 255 : v)), width: n, height: n });
const textured = (n = 40): { data: number[]; width: number; height: number } => ({ data: Array.from({ length: n * n * 4 }, (_, i) => (i % 4 === 3 ? 255 : ((i >> 2) % 2 === 0 ? 40 : 200))), width: n, height: n });
expect(sharpness(flat(128)) < BLUR_BELOW && sharpness(textured()) > BLUR_BELOW, 'a flat image is soft and a textured one is sharp');
expect(glareShare(flat(255)) === 1 && glareShare(flat(128)) === 0, 'glare is the share of blown-out pixels');
expect(photoChecks(textured()).good && !photoChecks(flat(128)).good && !photoChecks(flat(255)).good, 'photoChecks: sharp and clean passes; soft or blown-out does not');
expect(photoChecks(flat(255)).checks.some((c) => !c.ok && c.label.startsWith('Glare')), 'and the failing check says which');
expect(GLARE_ABOVE > 0 && GLARE_ABOVE < 0.2, 'the glare threshold is a small share, not most of the frame');
expect(photoChecks(textured()).checks.length === 2, 'only the two checks that can be measured are claimed — no "corners visible" tick');
expect(promptAt(0).title === 'Look straight at the camera' && promptAt(1.3).title === 'Slowly turn your head left' && promptAt(4.5).title === 'Blink twice' && PROMPTS.length === 4, 'the board\'s four prompts on its schedule');
expect(pickVideoType((t) => t === 'video/webm') === 'video/webm' && pickVideoType((t) => t === 'video/mp4') === 'video/mp4' && pickVideoType(() => false) === null, 'the recorder\'s container: WebM, then MP4, else none');
expect(retakePartOf(KYC_REDO) === 'id_back' && retakePartOf(KYC_REVIEW) === null, 'the retake names exactly one part');
expect(outcomeCopy('redoRequested', 'x', 'face_video', null).cta === 'Record my face video again', 'a face-video retake says so');
expect(partRow('id_back', 'retake', 'redoRequested', false).tone === 'bad' && partRow('id_front', 'accepted', 'approved', true).note === 'Accepted · deleted', 'part rows');
expect(sentLine(new Date(2026, 9, 5, 14, 10).toISOString(), new Date(2026, 9, 5, 18, 0)) === 'today at 14:10' && sentLine(new Date(2026, 9, 4, 9, 5).toISOString(), new Date(2026, 9, 5, 18, 0)) === 'yesterday at 09:05', 'sent today / yesterday');

// Onboarding.
const onboardingAt = (i: number): string => kycAt(kycParts.length + i);
expect(onboardingAt(0).includes('Create your store') && onboardingAt(0).includes('What do you sell?') && onboardingAt(0).includes('Other') && onboardingAt(0).includes('Food & drinks'), 'step 1 is the board\'s, with the server\'s business types and Other');
expect(onboardingAt(0).includes('Fills in from your business name'), 'the address waits for a name');
expect(onboardingAt(1).includes('We’ll set up:') && onboardingAt(1).includes('Menu with categories') && onboardingAt(1).includes('nyama-and-co is available'), 'picking a type says what it sets up, and the address is shown');
expect(onboardingAt(2).includes('Your account') && onboardingAt(2).includes('Create my store') && onboardingAt(2).includes('At least 10 characters'), 'the added account step');
expect(onboardingAt(3).includes('Make it yours') && onboardingAt(3).includes('Brand color') && !onboardingAt(3).includes('Banner photo'), 'look and feel, without the banner nothing displays');
expect(onboardingAt(4).includes('Add your first product') && kycHtml[kycParts.length + 4]!.includes('e.g. Chicken Burger') && onboardingAt(4).includes('extras or spice level') && onboardingAt(4).includes('Skip for now'), 'first product, with the type\'s own example');
expect(onboardingAt(5).includes('Your store is ready') && onboardingAt(5).includes('nyama-and-co') && onboardingAt(5).includes('View store') && onboardingAt(5).includes('Go to dashboard'), 'ready');
expect(accountProblem({ name: 'A', email: 'a@b.rw', phone: '', password: 'a-long-enough-one' }) === 'Enter your name.', 'the account step names the first problem');
expect(accountProblem({ name: 'Aline', email: 'nope', phone: '', password: 'a-long-enough-one' }) === 'Enter a valid email address.' && accountProblem({ name: 'Aline', email: 'a@b.rw', phone: '', password: 'short' }) !== null && accountProblem({ name: 'Aline', email: 'a@b.rw', phone: '', password: 'a-long-enough-one' }) === null, 'email and password rules');
expect(businessReady('Nyama', 'food', true) && !businessReady('N', 'food', true) && !businessReady('Nyama', null, true) && !businessReady('Nyama', 'food', false), 'the first step needs a name, a type and a free address');
expect(whatFor(null).product === 'Your product' && whatFor(OTHER).category === 'General' && whatFor('made-up').sets.length > 0, 'a type the board never drew still gets a sensible example');
expect(cleanPrice('1,500 RWF') === '1500', 'a price is digits');



// --- milestone 27: the admin console -------------------------------------------------------------------------------
const ADMIN_ME: AdminMe = { id: 'u9', name: 'Grace Kamanzi', email: 'grace@vendlyfy.example', role: 'super_admin', permissions: ['merchants.read', 'kyc.review', 'stores.suspend', 'audit.read'] };
const inAdmin = (active: string, node: ReactNode, view: 'overview' | 'merchants' | 'kyc' | 'soon' = 'overview'): ReactNode => (
  <Admin view={view} active={active} navigate={noop} initialMe={ADMIN_ME} initialBadges={{ merchants: 3, kyc: 2 }}>
    {() => node}
  </Admin>
);
const OVERVIEW: AdminOverviewData = {
  range: 'today',
  kpis: [
    { key: 'sales', value: 18_400_000, previous: 17_360_000, note: null },
    { key: 'orders', value: 2318, previous: 2229, note: null },
    { key: 'stores', value: 1284, previous: null, note: '9 new in this period' },
    { key: 'signups', value: 14, previous: 10, note: '3 awaiting review' },
    { key: 'payment', value: 96.8, previous: 98.0, note: null },
  ],
  queue: [
    { kind: 'identity', title: '3 stores waiting for verification', sub: 'Ubwiza Beauty, Kigali Tech Hub, Isoko Fresh · ID and face video uploaded', ageHours: 19, count: 3 },
    { kind: 'payout', title: 'Payout failed · Inzu Threads', sub: 'MoMo: account name doesn’t match', ageHours: 6, count: 1 },
    { kind: 'disputes', title: '4 open disputes', sub: 'Oldest: complaint #188 · Nyama & Co.', ageHours: 52, count: 4 },
    { kind: 'template', title: 'Pharmacy template in draft', sub: 'Ready for review before it’s offered at sign-up', ageHours: 72, count: 1 },
  ],
  providers: [
    { key: 'mtn_momo', name: 'MTN MoMo', short: 'MTN', rate: 98.9, attempts: 120, status: 'operational', note: null },
    { key: 'airtel_money', name: 'Airtel Money', short: 'AIRTEL', rate: 91.2, attempts: 40, status: 'degraded', note: null },
    { key: 'mpesa', name: 'M-Pesa', short: 'M-PESA', rate: null, attempts: 0, status: 'paused', note: null },
  ],
  industries: [{ name: 'Food & drinks', amount: 7_500_000, share: 0.41 }, { name: 'Fashion', amount: 3_500_000, share: 0.19 }, { name: 'Other', amount: 700_000, share: 0.04 }],
  activity: [
    { at: new Date(2026, 8, 23, 14, 2).toISOString(), who: 'Grace Kamanzi', what: 'Approved identity · Claudine Mukamana' },
    { at: new Date(2026, 8, 23, 12, 15).toISOString(), who: 'Grace Kamanzi', what: 'Suspended Deals4U · counterfeit goods' },
  ],
};
const mrow = (id: string, name: string, status: 'pending' | 'active' | 'suspended', identity: MerchantDetail['identity'], over: Partial<MerchantDetail> = {}): MerchantDetail => ({
  id, slug: name.toLowerCase().replace(/[^a-z]+/g, '-'), name, status, identity, identityCaseId: identity === 'in_review' ? 'k1' : null, owner: { name: 'Claudine Mukamana', phone: '078 455 1209' }, industry: 'Beauty', plan: 'starter', sales30: 0, createdAt: new Date().toISOString(),
  orders: 0, openDisputes: 0, suspension: null, payout: 'MTN MoMo 078 ••• 1209',
  checks: [{ key: 'identity', label: 'Owner’s identity', state: identity === 'approved' ? 'ok' : 'warn', note: identity === 'approved' ? 'Verified' : 'Waiting for your decision' }, { key: 'payout', label: 'Payout account', state: 'ok', note: 'MTN MoMo · manual' }, { key: 'methods', label: 'Payment methods', state: 'ok', note: '2 connected' }],
  ...over,
});
const M_PENDING = mrow('m1', 'Ubwiza Beauty', 'active', 'in_review');
const M_LIVE = mrow('m2', 'Nyama & Co.', 'active', 'approved', { sales30: 3_900_000, orders: 612, openDisputes: 1, plan: 'growth', industry: 'Food & drinks' });
const M_SUSPENDED = mrow('m3', 'Deals4U', 'suspended', 'approved', { suspension: { reason: 'prohibited or counterfeit goods', note: null, at: new Date().toISOString(), by: 'Grace Kamanzi' } });
const mlist = (rows: MerchantDetail[], counts = { pending: 3, active: 1282, suspended: 11 }): MerchantList => ({ rows, hasMore: false, counts, filters: { industries: [{ key: 'food', name: 'Food & drinks' }, { key: 'beauty', name: 'Beauty' }], plans: [{ key: 'starter', name: 'Starter' }, { key: 'growth', name: 'Growth' }] } });
const KYC_QUEUE: QueueItem[] = [
  { id: 'k1', reference: 5521, owner: 'Claudine Mukamana', store: 'Ubwiza Beauty', storeId: 'm1', documentType: 'national_id', ageHours: 19, flag: { tone: 'ok', label: 'Ready to decide' } },
  { id: 'k2', reference: 5522, owner: 'Olivier Habimana', store: 'Kigali Tech Hub', storeId: 'm4', documentType: 'national_id', ageHours: 30, flag: { tone: 'bad', label: 'ID used by another store' } },
  { id: 'k3', reference: 5523, owner: 'Jean Bosco Nkurunziza', store: 'Isoko Fresh', storeId: 'm5', documentType: 'passport', ageHours: 2, flag: { tone: 'warn', label: 'ID number not entered' } },
];
const KYC_CASE: CaseDetail = {
  id: 'k1', reference: 5521, status: 'in_review', storeId: 'm1', storeName: 'Ubwiza Beauty', storeSlug: 'ubwiza', owner: 'Claudine Mukamana', documentType: 'national_id', submittedAt: new Date().toISOString(), decisionNote: null,
  documents: [{ part: 'face_video', contentType: 'video/webm', byteSize: 900000, purged: false, outcome: null }, { part: 'id_back', contentType: 'image/jpeg', byteSize: 400000, purged: false, outcome: null }, { part: 'id_front', contentType: 'image/jpeg', byteSize: 410000, purged: false, outcome: null }],
  checks: [
    { code: 'document_genuine', label: 'Document looks genuine', by: 'reviewer', state: 'pass', note: 'Looks right' },
    { code: 'face_in_view', label: 'Face in view for all 5 s', by: 'reviewer', state: 'open', note: 'Your call' },
    { code: 'liveness', label: 'Live person', by: 'reviewer', state: 'warn', note: 'Unsure' },
    { code: 'face_matches_document', label: 'Face matches ID photo', by: 'reviewer', state: 'open', note: 'Your call' },
    { code: 'name_matches_account', label: 'Name on the ID is the name on the account', by: 'computed', state: 'pass', note: 'Same words' },
    { code: 'not_used_by_another_store', label: 'Not used by another store', by: 'computed', state: 'fail', note: 'Also on Kigali Tech Hub' },
  ],
  fields: { fullName: 'MUKAMANA Claudine', accountName: 'Claudine Mukamana', dateOfBirth: '1994-03-14', expiresOn: '2031-06-01', idNumberMasked: '1199 ••••••• 3018', hasIdNumber: true },
};

const adminParts: readonly (readonly [string, ReactNode])[] = [
  ['Admin · overview', inAdmin('overview', <AdminOverview initial={OVERVIEW} />)],
  ['Admin · overview, quiet', inAdmin('overview', <AdminOverview initialRange="week" initial={{ ...OVERVIEW, range: 'week', queue: [], providers: [{ key: 'mtn_momo', name: 'MTN MoMo', short: 'MTN', rate: null, attempts: 0, status: 'quiet', note: null }], industries: [], activity: [], kpis: OVERVIEW.kpis.map((k) => ({ ...k, value: k.key === 'payment' ? null : 0, previous: 0 })) }} />)],
  ['Admin · merchants, needs review', inAdmin('merchants', <AdminMerchants initialList={mlist([M_PENDING])} initialDetail={M_PENDING} />, 'merchants')],
  ['Admin · merchants, live', inAdmin('merchants', <AdminMerchants initialTab="active" initialList={mlist([M_LIVE, M_PENDING])} initialDetail={M_LIVE} />, 'merchants')],
  ['Admin · merchants, suspended', inAdmin('merchants', <AdminMerchants initialTab="suspended" initialList={mlist([M_SUSPENDED])} initialDetail={M_SUSPENDED} />, 'merchants')],
  ['Admin · merchants, suspend dialog', inAdmin('merchants', <AdminMerchants initialTab="active" initialList={mlist([M_LIVE])} initialDetail={M_LIVE} initialConfirm="suspend" />, 'merchants')],
  ['Admin · merchants, none', inAdmin('merchants', <AdminMerchants initialList={mlist([], { pending: 0, active: 0, suspended: 0 })} />, 'merchants')],
  ['Admin · identity checks, a case', inAdmin('kyc', <AdminKyc initialQueue={KYC_QUEUE} initialCase={KYC_CASE} />, 'kyc')],
  ['Admin · identity checks, photos shown and number revealed', inAdmin('kyc', <AdminKyc initialQueue={KYC_QUEUE} initialCase={KYC_CASE} initialShown initialRevealed="1199470048213018" />, 'kyc')],
  ['Admin · identity checks, a deleted video on a decided case', inAdmin('kyc', <AdminKyc initialQueue={[]} initialCase={{ ...KYC_CASE, status: 'approved', decisionNote: null, documents: KYC_CASE.documents.map((d) => (d.part === 'face_video' ? { ...d, purged: true } : d)) }} initialShown />, 'kyc')],
  ['Admin · identity checks, all caught up', inAdmin('kyc', <AdminKyc initialQueue={[]} />, 'kyc')],
  ['Admin · a screen not built yet', inAdmin('payouts', <SoonPage label="Payouts" />, 'soon')],
];
const adminHtml: string[] = [];
for (const [name, node] of adminParts) {
  const html = render(name, node);
  allHtml += html;
  adminHtml.push(html);
}
const adminAt = (i: number): string => adminHtml[i]!.replace(/<[^>]+>/g, ' ').replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replace(/\s+/g, ' ');
expect(adminHtml.length === adminParts.length, 'every admin part rendered');
expect(adminAt(0).includes('Platform overview') && adminAt(0).includes('Needs review') && adminAt(0).includes('Payment providers') && adminAt(0).includes('Sales by industry') && adminAt(0).includes('Recent admin activity'), 'the overview\'s five panels');
expect(adminAt(0).includes('18.4M RWF') && adminAt(0).includes('+6% vs yesterday') && adminAt(0).includes('96.8%') && adminAt(0).includes('−1.2 pts vs yesterday'), 'figures and deltas are computed, with the sign the board uses');
expect(adminAt(0).includes('Airtel Money') && adminAt(0).includes('Degraded') && adminAt(0).includes('may take longer'), 'a slow provider is called out, and what customers see');
expect(!adminAt(0).includes('Cards') && !adminAt(0).includes('SMS receipts') && !adminAt(0).includes('Flagged payment'), 'nothing the system does not produce is drawn');
expect(adminAt(1).includes('All caught up.') && adminAt(1).includes('No traffic') && adminAt(1).includes('No paid orders yet.') && adminAt(1).includes('Nothing recorded yet.'), 'every panel has an empty state');
expect(adminAt(0).includes('Identity checks') && adminAt(0).includes('Admin team & roles') && adminAt(0).includes('Platform settings') && adminHtml[0]!.includes('aria-disabled="true"'), 'the sidebar lists all thirteen and greys what is not built');
expect(adminAt(0).includes('Grace Kamanzi') && adminAt(0).includes('Super admin') && adminAt(0).includes('Sign out'), 'who is signed in');
expect(adminAt(2).includes('Needs review') && adminAt(2).includes('Verification') && adminAt(2).includes('Review identity') && !adminAt(2).includes('Approve and go live'), 'a store waiting on its identity check hands over to the review');
expect(adminAt(3).includes('Open store') && adminAt(3).includes('Suspend store') && !adminAt(3).includes('View as merchant'), 'a live store: open it or suspend it — and no impersonation promise');
expect(adminAt(4).includes('Suspended:') && adminAt(4).includes('counterfeit goods') && adminAt(4).includes('Reinstate store') && adminAt(4).includes('payouts are held'), 'a suspended store says why and what is held');
expect(adminAt(5).includes('Suspend Nyama & Co.?') && adminAt(5).includes('Documents unclear or don’t match') && adminAt(5).includes('Keep as is') && adminAt(5).includes('Internal note'), 'the suspend dialog\'s reasons are the board\'s four');
expect(adminAt(6).includes('Nothing here') && adminAt(6).includes('No merchants match this view.'), 'no merchants');
expect(adminAt(7).includes('Identity checks') && adminAt(7).includes('ID used by another store') && adminAt(7).includes('Ready to decide') && adminAt(7).includes('Show photos') && adminAt(7).includes('Viewing is recorded in the audit log.'), 'the queue, its flags, and the honest note about viewing');
expect(!adminHtml[7]!.includes('<img') && !adminHtml[7]!.includes('<video src'), 'photos are not loaded until somebody asks — each load is an audit entry');
expect(adminAt(7).includes('Two are worked out by the system; four are your own call.') && adminAt(7).includes('System') && adminAt(7).includes('Also on Kigali Tech Hub') && adminAt(7).includes('Unsure'), 'who made each check');
expect(adminAt(7).includes('Show full ID number') && adminAt(7).includes('recorded in the audit log, with your reason') && !adminAt(7).includes('1199470048213018'), 'the number is masked until asked for');
expect(adminHtml[8]!.includes('/api/admin/kyc/k1/documents/id_front') && adminHtml[8]!.includes('<video') && adminAt(8).includes('1199470048213018'), 'once asked, the photos load from the audited route and the number shows');
expect(adminAt(9).includes('Deleted') && adminAt(9).includes('This check is approved.'), 'a deleted video says so, and a decided case is read-only');
expect(adminAt(7).includes('Approve identity') && adminAt(7).includes('Ask them to redo…') && adminAt(7).includes('Send request') && adminAt(7).includes('Reject') && adminAt(7).includes('The face video is deleted automatically as soon as you decide.'), 'the decision panel, with the retention line that is true');
expect(!adminAt(7).includes('[RETENTION PERIOD]') && !adminAt(7).includes('SMS'), 'no placeholder, no SMS');
expect(adminAt(10).includes('All caught up.'), 'an empty queue');
expect(adminAt(11).includes('This screen isn’t built yet.') && adminAt(11).includes('Payouts'), 'a not-yet screen is an honest page');

expect(compactMoney(18_400_000) === '18.4M RWF' && compactMoney(121_000_000) === '121M RWF' && compactMoney(640_000) === '640K RWF' && compactMoney(900) === '900 RWF', 'headline money');
expect(kpiValue({ key: 'payment', value: null, previous: null, note: null }) === '—' && kpiValue({ key: 'orders', value: 2318, previous: 0, note: null }) === '2,318', 'a missing figure is a dash, never 0%');
expect(kpiDelta({ key: 'orders', value: 5, previous: 0, note: null }, 'week').text === 'New vs the 7 days before' && kpiDelta({ key: 'sales', value: 0, previous: 0, note: null }, 'today').text === 'No change', 'no division by zero');
expect(ageText(0.2) === '12 min' && ageText(19) === '19 h' && ageText(72) === '3 d' && overSla(30) && !overSla(2), 'ages and the SLA');
expect(degradedNote(OVERVIEW.providers) === 'Airtel Money is slow.' && degradedNote([]) === null, 'the degraded note names the provider');
expect(rowBadge({ status: 'active', identity: 'in_review' }).label === 'Needs review' && rowBadge({ status: 'active', identity: 'approved' }).label === 'Live' && rowBadge({ status: 'suspended', identity: 'approved' }).label === 'Suspended', 'a live store waiting on its check reads as needing review');


// --- Settings: the rules that live outside the JSX ---------------------------------
expect(visibleModules(CONSOLE_SHELL.config.modules).join() === 'modifiers,delivery,pickup,table,scheduled,stock', 'Settings lists the six modules and hides the two specialist ones that are off');
expect(zoneAreasLine({ areas: ['A', 'B', 'C', 'D', 'E'] }) === 'A, B, C and 2 more', 'a long area list is summarised');
expect(zoneFeeLine({ feeAmount: '0.00', etaMinMinutes: 40, etaMaxMinutes: 60 }, (v) => v) === 'Free · 40–60 min', 'a zone with no fee says Free');
expect(paymentState({ status: 'draft' }, false) === 'unavailable' && paymentState({ status: 'live' }, false) === 'connectable' && paymentState({ status: 'draft' }, true) === 'connected', 'payment states');
expect(maskPhone('250781234412') === '078 ••• 4412', 'a payout phone is masked');
expect(payoutSentence(null).startsWith('Add the MoMo'), 'no payout yet asks for one');
expect(hoursSummary(weekToRows(weekFrom(SETTINGS_EXTRA.hours))) === 'Mon–Fri 09:00–18:00', 'hours collapse into a range');
expect(grantableRoles('owner').includes('admin') && !grantableRoles('admin').includes('admin') && grantableRoles('manager').length === 0, 'who can create whom');
expect(/^(?=.*\d)[A-Za-z0-9]{12}$/.test(generatePassword()), 'a generated password is 12 characters with a digit');

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
  // The catalogue's, milestone 22. Chosen from visible text rather than placeholders, for the reason the
  // CustomerAccount phrases explain.
  'Showing 1–5 of 182',
  'Try another word or clear the filters.',
  'Add your first menu item and it can be ordered straight away.',
  'Square photos on a plain background look best. The first photo is the cover.',
  'Anything the customer chooses: size, color, spice level, extras, storage.',
  'Track stock to stop selling when you run out.',
  '8 variants · set stock for each',
  'Variants at 0 show as sold out.',
  'This is how the product card looks in your store.',
  'This product has been ordered, so its option groups are fixed.',
  'Called “Sections” in your Food & drinks template. Order here is the order on your store.',
  'Hidden sections and empty ones don’t appear. Menu items can sit in more than one section.',
  'Its 6 menu items stay in your catalog.',
  // The wallet's, milestone 23.
  'MoMo and card payments land here. Cash stays with you and your riders.',
  'How your money moves',
  'Customer pays',
  'Yours to withdraw. Refunds you approve come out of here.',
  'Paid out when you withdraw',
  'Goes to MTN MoMo 078 ••• 4412 tomorrow at 08:00.',
  'Payouts are on hold while we check your ID',
  'Verify your identity to get paid',
  'Yours, but held until you’re verified.',
  'An approved refund waiting for funds is paid before you are. It settles as soon as the balance covers it.',
  'Withdraw to MoMo',
  'Usually arrives in minutes. If it fails, the money comes straight back to Available.',
  'Where your payouts go',
  'Vendlyfy usually answers within a day.',
  'No withdrawals yet.',
  // Support and insight, milestone 24.
  'Customers file these from their order. Reply here; escalate to Vendlyfy if you can’t agree.',
  'Tell the customer what you did. They can reopen it if they’re not happy.',
  'Ask Vendlyfy to decide. They see the whole thread, rider notes and photos, and can refund from your wallet.',
  'Also refund part of the order',
  'What the customer said',
  'Reviews go live straight away. You can reply publicly, or report one to Vendlyfy if it breaks the rules. You can’t edit or remove them.',
  'Stores show an average only after 3 reviews. Until then customers see the count.',
  'Reported: abusive or hateful. Vendlyfy will review it. It stays visible until they decide.',
  'Everyone who ordered, with or without an account. Guests are matched by phone number.',
  'Private note (staff only)',
  'Usual address',
  'Revenue per day, 10 Sep–23 Sep',
  'Orders per day, 10 Sep–23 Sep',
  'Cash counts once it’s confirmed on the order.',
  'On time means delivered within 60 minutes of the order',
  'No complaints here.',
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
