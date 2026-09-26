// client/src/shared/states/index.tsx — milestone 14.
//
// ALL 20 STATES FROM States.dc.html, AND THE 8 FROM AdminStates.dc.html, each as a component.
//
// Every one is composed from client/src/shared/ui — nothing here reaches for a colour, a radius or a
// font of its own. That is the point: if the kit could not express a state, the kit would be wrong,
// and this file is where that would show.
//
// The copy is the boards', word for word, including the apostrophes. It is not placeholder text —
// States.dc.html's whole argument is that the wording IS the design: "Nothing blames the customer,
// and money states always say whether they were charged."

import type { ReactNode } from 'react';
import {
  Alert,
  SetupChecklist,
  SkeletonCard,
  SkeletonRow,
  StateCard,
  TextField,
} from '../ui/index.ts';

export type StateSide = 'customer' | 'merchant' | 'admin';

export type StateEntry = {
  /** The board's own name for the card. */
  name: string;
  /** The board's "where" chip — which screen this appears on. */
  where: string;
  side: StateSide;
  render: () => ReactNode;
};

// ---------------------------------------------------------------------------
// Customer — 16 of them
// ---------------------------------------------------------------------------

const CUSTOMER: StateEntry[] = [
  {
    name: 'Empty store',
    where: 'Storefront',
    side: 'customer',
    render: () => (
      <StateCard
        tone="neutral"
        icon="◇"
        headline="Nyama & Co. is getting ready"
        body="The menu isn’t up yet. Check back soon or follow for updates."
        action={{ label: 'Get notified' }}
        quietAction
        secondaryAction={{ label: 'Call the store' }}
      />
    ),
  },
  {
    name: 'Empty cart',
    where: 'Cart',
    side: 'customer',
    render: () => (
      <StateCard
        tone="neutral"
        icon="∅"
        headline="Your cart is empty"
        body="Add something you like and it will show up here."
        action={{ label: 'Browse the menu' }}
      />
    ),
  },
  {
    name: 'Product unavailable',
    where: 'Product',
    side: 'customer',
    render: () => (
      <StateCard
        tone="warn"
        icon="!"
        headline="Not available right now"
        body="Brochettes are only served after 5 pm. You can order them for later."
        action={{ label: 'Schedule for 5 pm' }}
        secondaryAction={{ label: 'See similar items' }}
      />
    ),
  },
  {
    name: 'Out of stock',
    where: 'Product',
    side: 'customer',
    render: () => (
      <StateCard
        tone="neutral"
        icon="○"
        headline="Linen tee · XL is sold out"
        body="S, M and L are still in stock. We can message you when XL is back."
        action={{ label: 'Notify me' }}
        quietAction
        secondaryAction={{ label: 'Choose another size' }}
      />
    ),
  },
  {
    name: 'Payment pending',
    where: 'Payment',
    side: 'customer',
    render: () => (
      // The board's rule at the foot of States: "Pending payments never show 'failed' until the
      // provider confirms." So the action reads "Waiting…" rather than offering a retry.
      <StateCard
        tone="info"
        icon="◐"
        headline="Approve on your phone"
        body="We sent a request to 078 812 3456. Enter your MoMo PIN to finish. This can take up to 2 minutes."
        action={{ label: 'Waiting…' }}
        quietAction
        secondaryAction={{ label: 'Resend request' }}
      />
    ),
  },
  {
    name: 'Payment failed',
    where: 'Payment',
    side: 'customer',
    render: () => (
      // "money states always say whether they were charged" — the second sentence is not optional.
      <StateCard
        tone="danger"
        icon="✕"
        headline="Payment didn’t go through"
        body="You weren’t charged. The request timed out on your phone."
        action={{ label: 'Try again' }}
        secondaryAction={{ label: 'Use another method' }}
      />
    ),
  },
  {
    name: 'Payment successful',
    where: 'Payment',
    side: 'customer',
    render: () => (
      <StateCard
        tone="success"
        icon="✓"
        headline="Paid · order #ORD-10293"
        body="Nyama & Co. has your order. Estimated delivery 25–35 min."
        action={{ label: 'Track order' }}
        secondaryAction={{ label: 'Get receipt by SMS' }}
      />
    ),
  },
  {
    name: 'Order cancelled',
    where: 'Tracking',
    side: 'customer',
    render: () => (
      <StateCard
        tone="danger"
        icon="⊘"
        headline="The store cancelled your order"
        body="They ran out of chicken. 9,500 RWF is on its way back to your MoMo within 24 h."
        action={{ label: 'Order something else' }}
        quietAction
        secondaryAction={{ label: 'Contact store' }}
      />
    ),
  },
  {
    name: 'Delivery unavailable',
    where: 'Checkout',
    side: 'customer',
    render: () => (
      <StateCard
        tone="warn"
        icon="⌖"
        headline="No delivery to Nyamata yet"
        body="This store delivers within 8 km of Kimihurura. Pickup is 10 min after ordering."
        action={{ label: 'Switch to pickup' }}
        secondaryAction={{ label: 'Change address' }}
      />
    ),
  },
  {
    name: 'Invalid address',
    where: 'Checkout',
    side: 'customer',
    // NOT a StateCard. States.dc.html's rule: "Errors appear next to the thing that caused them,
    // not in a banner." So this is the field itself, in its error state — which is why TextField
    // takes an `error` prop rather than there being an ErrorBanner component.
    render: () => (
      <div className="flex h-full flex-col gap-2 p-3.5">
        <TextField
          label="Delivery address"
          defaultValue="near the big tree"
          error="Add a street, building or landmark the rider can find."
        />
        <div className="mt-auto rounded-control bg-ground p-2.5 text-caption text-ink-2">
          Tip: drop a pin on the map. Riders call you if they can’t find it.
        </div>
      </div>
    ),
  },
  {
    name: 'Network failure',
    where: 'Anywhere',
    side: 'customer',
    render: () => (
      // "Carts survive network loss and are kept for 7 days" — the body says so, because a customer
      // whose cart looks lost leaves.
      <StateCard
        tone="neutral"
        icon="⌁"
        headline="You’re offline"
        body="Your cart is saved on this phone. We’ll reconnect automatically."
        action={{ label: 'Retry now' }}
        quietAction
      />
    ),
  },
  {
    name: 'Store closed',
    where: 'Storefront',
    side: 'customer',
    render: () => (
      <StateCard
        tone="warn"
        icon="☾"
        headline="Closed · opens at 10:00"
        body="You can still browse and schedule an order for when they open."
        action={{ label: 'Schedule an order' }}
        secondaryAction={{ label: 'See opening hours' }}
      />
    ),
  },
  {
    name: 'Product deleted',
    where: 'Cart',
    side: 'customer',
    render: () => (
      <StateCard
        tone="neutral"
        icon="−"
        headline="An item was removed"
        body="Fish brochette is no longer sold, so we took it out. Your total is now 6,000 RWF."
        action={{ label: 'Review cart' }}
        quietAction
      />
    ),
  },
  {
    name: 'Discount expired',
    where: 'Checkout',
    side: 'customer',
    render: () => (
      // "Prices are re-checked at checkout; any change is shown before paying."
      <StateCard
        tone="warn"
        icon="%"
        headline="FRIDAY20 ended yesterday"
        body="Your total went back to 9,500 RWF. We’ll show you before you pay."
        action={{ label: 'Continue at 9,500' }}
        quietAction
        secondaryAction={{ label: 'Remove code' }}
      />
    ),
  },
  {
    name: 'Invalid coupon',
    where: 'Cart',
    side: 'customer',
    render: () => (
      <div className="flex h-full flex-col gap-2 p-3.5">
        <TextField
          label="Promo code"
          defaultValue="WELCOME100"
          error="That code doesn’t exist. Check spelling and try again."
        />
        <div className="mt-auto rounded-control bg-ground p-2.5 text-caption text-ink-2">
          The field keeps what you typed so it’s easy to fix one letter.
        </div>
      </div>
    ),
  },
  {
    name: 'Loading',
    where: 'Storefront',
    side: 'customer',
    render: () => (
      <div className="flex h-full flex-col gap-2.5 p-3.5">
        <div className="grid grid-cols-2 gap-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <span className="mt-auto text-caption text-muted">
          Skeletons mirror the grid; images fade in as they arrive. Shown only after 300 ms.
        </span>
      </div>
    ),
  },
];

// ---------------------------------------------------------------------------
// Merchant — 4
// ---------------------------------------------------------------------------

const MERCHANT: StateEntry[] = [
  {
    name: 'First-time merchant',
    where: 'Dashboard',
    side: 'merchant',
    render: () => (
      <SetupChecklist
        steps={[
          { label: 'Create your store', done: true },
          { label: 'Add a product', done: true },
          { label: 'Connect a payment method', done: false },
          { label: 'Share your link', done: false },
        ]}
        action={{ label: 'Connect MTN MoMo' }}
      />
    ),
  },
  {
    name: 'No orders',
    where: 'Orders',
    side: 'merchant',
    render: () => (
      <StateCard
        tone="neutral"
        icon="◎"
        headline="No orders yet"
        body="Share your store link on WhatsApp or print a QR code for your counter."
        action={{ label: 'Copy store link' }}
        secondaryAction={{ label: 'Get QR poster' }}
      />
    ),
  },
  {
    name: 'No products',
    where: 'Products',
    side: 'merchant',
    render: () => (
      <StateCard
        tone="neutral"
        icon="+"
        headline="Add your first product"
        body="Start with your best seller. You can add photos and options later."
        action={{ label: 'Add product' }}
        secondaryAction={{ label: 'Import from spreadsheet' }}
      />
    ),
  },
  {
    name: 'Low inventory',
    where: 'Inventory',
    side: 'merchant',
    render: () => (
      <div className="flex h-full flex-col gap-1 p-3 pt-3">
        <Alert tone="warn" headline="7 products are running low" />
        {[
          { name: 'Linen tee · M', left: '2 left', urgent: true, tile: '#DCE3EC' },
          { name: 'Denim jacket · L', left: '3 left', urgent: false, tile: '#D5DCE6' },
          { name: 'Canvas tote', left: '4 left', urgent: false, tile: '#E8E0D0' },
        ].map((row) => (
          <div key={row.name} className="flex items-center gap-2 border-b border-line-subtle py-1.5 text-caption">
            <span aria-hidden="true" className="size-7 shrink-0 rounded-chip" style={{ background: row.tile }} />
            <span className="min-w-0 grow text-ink">{row.name}</span>
            <strong className={row.urgent ? 'text-status-danger-fg' : 'text-status-warn-fg'}>{row.left}</strong>
          </div>
        ))}
        <span className="mt-auto flex h-[38px] items-center justify-center rounded-control border border-control-line text-caption font-semibold text-ink">
          Restock all
        </span>
      </div>
    ),
  },
];

// ---------------------------------------------------------------------------
// Admin — 8, from AdminStates.dc.html
// ---------------------------------------------------------------------------

const ADMIN: StateEntry[] = [
  {
    name: 'Empty queue',
    where: 'Identity checks',
    side: 'admin',
    render: () => (
      <StateCard
        tone="neutral"
        icon="✓"
        headline="All caught up"
        body="No identity checks are waiting. New ones appear here as merchants submit them."
        action={{ label: 'Back to overview' }}
        quietAction
      />
    ),
  },
  {
    name: 'Loading',
    where: 'Any table',
    side: 'admin',
    render: () => (
      <div className="flex h-full flex-col gap-3 p-4">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <SkeletonRow key={n} />
        ))}
        <span className="text-caption text-muted">
          Skeletons match the real rows. Shown after 300 ms so fast loads don’t flicker.
        </span>
      </div>
    ),
  },
  {
    name: 'Couldn’t load',
    where: 'Payouts',
    side: 'admin',
    render: () => (
      <StateCard
        tone="danger"
        icon="!"
        headline="Payouts didn’t load"
        body="Nothing was changed. Try again; if it keeps failing, send support this reference."
        reference="ref ERR-7F3A-21C9"
        action={{ label: 'Try again' }}
        secondaryAction={{ label: 'Copy reference' }}
      />
    ),
  },
  {
    name: 'No permission',
    where: 'Payouts · Support role',
    side: 'admin',
    render: () => (
      // This is §5.4's third escalation test as a screen: a role that can see but not act. The
      // guard already refuses the endpoint (milestone 11) — this is what the person is told.
      <StateCard
        tone="warn"
        icon="⊘"
        headline="Finance or super admin only"
        body="You can see payouts but not retry or reject them. Ask Diane (Finance) or Grace."
        action={{ label: 'View as read-only' }}
        quietAction
        secondaryAction={{ label: 'Request access' }}
      />
    ),
  },
  {
    name: 'Action failed',
    where: 'Refund approval',
    side: 'admin',
    render: () => (
      <StateCard
        tone="danger"
        icon="!"
        headline="Refund didn’t go through"
        body="MTN didn’t accept the transfer. The store’s wallet wasn’t charged. The request is back in the queue."
        reference="ref MTN-5521-TIMEOUT"
        action={{ label: 'Retry refund' }}
        secondaryAction={{ label: 'Keep in queue' }}
      />
    ),
  },
  {
    name: 'Session ended',
    where: 'Any screen',
    side: 'admin',
    render: () => (
      <StateCard
        tone="info"
        icon="⏻"
        headline="Sign in again to continue"
        body="Console sessions end after a period without activity and always need your 2-step code."
        action={{ label: 'Sign in' }}
      />
    ),
  },
  {
    name: 'No results',
    where: 'All orders search',
    side: 'admin',
    render: () => (
      <StateCard
        tone="neutral"
        icon="⌕"
        headline="No orders match “0788 12”"
        body="Search by order number, full phone number or store name."
        action={{ label: 'Clear search' }}
        quietAction
      />
    ),
  },
  {
    name: 'Offline',
    where: 'Any screen',
    side: 'admin',
    render: () => (
      <StateCard
        tone="warn"
        icon="⌁"
        headline="You’re offline"
        body="Showing what was last loaded at 14:21. Actions are paused until you reconnect."
        action={{ label: 'Retry now' }}
        quietAction
      />
    ),
  },
];

// The three exports below make oxlint warn `react/only-export-components`: this file holds JSX and
// also exports data, so Vite's fast refresh will full-reload it instead of hot-swapping. That is the
// right trade here — splitting the registry into its own module would mean 28 named components
// imported across two files to win a dev-only convenience on a gallery page.

/** The 20 States.dc.html draws, in its order. */
export const PRODUCT_STATES: readonly StateEntry[] = [...CUSTOMER, ...MERCHANT];

/** The 8 AdminStates.dc.html draws, in its order. */
export const ADMIN_STATES: readonly StateEntry[] = ADMIN;

export const ALL_STATES: readonly StateEntry[] = [...PRODUCT_STATES, ...ADMIN_STATES];
