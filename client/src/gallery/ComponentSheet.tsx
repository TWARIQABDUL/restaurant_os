// client/src/gallery/ComponentSheet.tsx — milestone 14.
//
// Main.dc.html's Components section, as the real components. Everything interactive is wired to real
// state, because a gallery of static screenshots proves the markup and nothing else — the stepper
// must actually clamp, the sold-out pill must actually refuse a click, the sheet must actually trap
// focus.

import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  BagIcon,
  BottomSheet,
  Button,
  Checkbox,
  Chip,
  ConfirmModal,
  DataTable,
  Drawer,
  EmptyState,
  OptionGroup,
  OrderStatusBadge,
  PaymentStatusBadge,
  PhoneField,
  ProductCard,
  QuantityStepper,
  Radio,
  Segmented,
  SelectField,
  SkeletonRow,
  Switch,
  TextField,
  Toast,
} from '../shared/ui/index.ts';
import type { Column, PaymentState, StatusTone } from '../shared/ui/index.ts';

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="text-body font-semibold text-muted">{title}</h3>
      {children}
      {note === undefined ? null : <p className="text-caption text-muted">{note}</p>}
    </div>
  );
}

/** Main's order badges: the six order tones, and the five payment states. */
const ORDER_BADGES: readonly { label: string; tone: StatusTone }[] = [
  { label: 'New', tone: 'info' },
  { label: 'Preparing', tone: 'warn' },
  { label: 'Ready', tone: 'success' },
  { label: 'Out for delivery', tone: 'progress' },
  { label: 'Delivered', tone: 'neutral' },
  { label: 'Cancelled', tone: 'danger' },
];

const PAYMENTS: readonly PaymentState[] = ['paid', 'pending', 'failed', 'unpaid_cash', 'refunded'];

type OrderRow = { id: string; customer: string; total: string; status: string; tone: StatusTone };

const ORDER_ROWS: OrderRow[] = [
  { id: '#1026', customer: 'Grace I.', total: '12,000', status: 'New', tone: 'info' },
  { id: '#1025', customer: 'Jean-Paul N.', total: '8,500', status: 'Ready', tone: 'success' },
];

const ORDER_COLUMNS: readonly Column<OrderRow>[] = [
  { key: 'id', header: 'Order', width: '90px', mono: true, cell: (r) => r.id },
  { key: 'customer', header: 'Customer', width: 'minmax(0,1fr)', cell: (r) => r.customer },
  { key: 'total', header: 'Total', width: '90px', cell: (r) => <span className="font-semibold">{r.total}</span> },
  {
    key: 'status',
    header: 'Status',
    width: '90px',
    cell: (r) => <OrderStatusBadge label={r.status} tone={r.tone} />,
  },
];

export function ComponentSheet(): ReactNode {
  const [qty, setQty] = useState(2);
  const [fulfilment, setFulfilment] = useState<'delivery' | 'pickup'>('delivery');
  const [size, setSize] = useState<string[]>(['M']);
  const [extras, setExtras] = useState<string[]>(['cheese']);
  const [chip, setChip] = useState('All');
  const [cheese, setCheese] = useState(true);
  const [method, setMethod] = useState('momo');
  const [trackStock, setTrackStock] = useState(true);
  const [paying, setPaying] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [confirm, setConfirm] = useState(false);

  function pay(): void {
    setPaying(true);
    setTimeout(() => setPaying(false), 1800);
  }

  return (
    <section className="flex flex-col gap-8">
      <header>
        <span className="text-caption font-semibold uppercase tracking-[0.08em] text-muted">Components</span>
        <h2 className="mt-1.5 font-display text-display text-ink">One set of parts. Every kind of shop.</h2>
      </header>

      <div className="grid gap-7 lg:grid-cols-2 xl:grid-cols-3">
        <Block
          title="Buttons"
          note="One primary per view. Disabled buttons say what's missing. Tap the pay button to see loading."
        >
          <div className="flex flex-wrap gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="text">Text</Button>
            <Button variant="danger">Cancel order</Button>
            <Button disabled>Choose a size</Button>
            <Button busy={paying} busyLabel="Paying…" onClick={pay}>
              Pay 9,500 RWF
            </Button>
          </div>
        </Block>

        <Block title="Quantity stepper" note="Min 1 · capped at stock (5)">
          <div className="flex items-center gap-4">
            <QuantityStepper value={qty} onChange={setQty} min={1} max={5} />
            <span className="text-caption text-muted">
              {qty === 5 ? 'At the stock ceiling' : qty === 1 ? 'At the minimum' : 'Between the bounds'}
            </span>
          </div>
        </Block>

        <Block
          title="Chips & badges"
          note="Order state is filled, payment state is outlined, so both read at a glance in the same row. Each carries a word, never color alone."
        >
          <div className="flex flex-wrap gap-1.5">
            {['All', 'Burgers', 'Sides'].map((label) => (
              <Chip key={label} label={label} selected={chip === label} onSelect={() => setChip(label)} />
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ORDER_BADGES.map((b) => (
              <OrderStatusBadge key={b.label} label={b.label} tone={b.tone} />
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PAYMENTS.map((state) => (
              <PaymentStatusBadge key={state} state={state} />
            ))}
          </div>
        </Block>

        <Block title="Inputs">
          <TextField label="Full name" defaultValue="Eric Mugisha" />
          <PhoneField label="Phone" defaultValue="78 812" error="Enter 9 digits, e.g. 78 812 3456" />
          <SelectField label="Category" defaultValue="Burgers">
            <option>Burgers</option>
            <option>Sides</option>
            <option>Drinks</option>
          </SelectField>
          <div className="flex flex-col gap-1.5 text-body font-semibold text-ink">
            Segmented
            <Segmented
              label="Fulfilment"
              value={fulfilment}
              onChange={setFulfilment}
              options={[
                { value: 'delivery', label: 'Delivery' },
                { value: 'pickup', label: 'Pickup' },
              ]}
            />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-5">
            <Checkbox label="Cheese +500" checked={cheese} onChange={setCheese} />
            <Checkbox label="Fries +1,000" checked={false} onChange={() => undefined} />
            <Radio name="method" label="Delivery" checked={method === 'momo'} onChange={() => setMethod('momo')} />
            <Switch label="Track stock" checked={trackStock} onChange={setTrackStock} />
          </div>
        </Block>

        <Block
          title="Option group (one component, any attribute)"
          note="XL is sold out, so it's struck through and can't be picked. The same group renders checkboxes when the merchant chooses “Several”."
        >
          <OptionGroup
            name="Size"
            pick="one"
            required
            selected={size}
            onChange={setSize}
            values={[
              { id: 'S', label: 'S' },
              { id: 'M', label: 'M' },
              { id: 'L', label: 'L' },
              { id: 'XL', label: 'XL', soldOut: true },
            ]}
          />
          <OptionGroup
            name="Extras"
            pick="several"
            selected={extras}
            onChange={setExtras}
            values={[
              { id: 'cheese', label: 'Cheese', priceLabel: '+500' },
              { id: 'fries', label: 'Fries', priceLabel: '+1,000' },
              { id: 'sauce', label: 'Extra sauce', priceLabel: '+300' },
            ]}
          />
        </Block>

        <Block
          title="Product card · one component, configured"
          note="Slots: image, name, price (+ compare-at), one meta line (variants, rating, “+ extras”, or restock date), badge, action. The store's config fills the slots."
        >
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            <ProductCard
              name="Chicken burger"
              price="3,500 RWF"
              meta="+ extras"
              initial="C"
              tileBackground="#F3E3CF"
              tileForeground="#8A5A2B"
              onAdd={() => undefined}
            />
            <ProductCard
              name="Linen tee"
              price="12,000"
              compareAtPrice="15,000"
              meta="S M L XL · ★ 4.6"
              badge={{ label: '−20%', tone: 'danger' }}
              initial="T"
              tileBackground="#DCE3EC"
              tileForeground="#36506E"
              onAdd={() => undefined}
            />
            <ProductCard
              name="Face cleanser"
              price="18,000 RWF"
              meta="Back Friday"
              badge={{ label: 'Sold out' }}
              initial="F"
              tileBackground="#EFEDE7"
              tileForeground="#A8A499"
              soldOut
              secondaryAction={{ label: 'Notify me' }}
            />
          </div>
        </Block>

        <Block title="Feedback" note="Skeletons match the final layout; no spinners for lists.">
          <Alert tone="warn" headline="Delivery isn't available to Nyamata.">
            Choose pickup or another address.
          </Alert>
          <Alert tone="danger" headline="Payment didn't go through.">
            You weren't charged. Try again or pick another method.
          </Alert>
          <Toast message="Added Chicken burger" actionLabel="Undo" />
          <SkeletonRow />
        </Block>

        <Block title="Table row (dashboard)" note="On mobile, rows become stacked cards with the same fields in the same order.">
          <DataTable caption="Recent orders" columns={ORDER_COLUMNS} rows={ORDER_ROWS} rowKey={(r) => r.id} />
        </Block>

        <Block title="Empty state" note="Icon, one line of what's missing, one line of why, one action.">
          <EmptyState
            icon={<BagIcon />}
            headline="No orders yet"
            body="Share your store link and orders will show up here as they arrive."
            action={{ label: 'Copy store link' }}
          />
        </Block>

        <Block
          title="Overlays: bottom sheet · drawer · modal"
          note="Sheets for choices on mobile (product options, payment). Drawers for detail on desktop (cart, order). Modals only to confirm something destructive."
        >
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setSheet(true)}>
              Open sheet
            </Button>
            <Button variant="secondary" onClick={() => setDrawer(true)}>
              Open drawer
            </Button>
            <Button variant="secondary" onClick={() => setConfirm(true)}>
              Confirm delete
            </Button>
          </div>

          <BottomSheet
            open={sheet}
            onClose={() => setSheet(false)}
            title="Choose a size"
            footer={
              <Button block onClick={() => setSheet(false)}>
                Add · 12,000 RWF
              </Button>
            }
          >
            <OptionGroup
              name="Size"
              pick="one"
              required
              selected={size}
              onChange={setSize}
              values={[
                { id: 'S', label: 'S' },
                { id: 'M', label: 'M' },
                { id: 'L', label: 'L' },
                { id: 'XL', label: 'XL', soldOut: true },
              ]}
            />
          </BottomSheet>

          <Drawer
            open={drawer}
            onClose={() => setDrawer(false)}
            title="Order #1026"
            footer={
              <Button block onClick={() => setDrawer(false)}>
                Mark as ready
              </Button>
            }
          >
            <DataTable caption="Order lines" columns={ORDER_COLUMNS} rows={ORDER_ROWS} rowKey={(r) => r.id} />
          </Drawer>

          <ConfirmModal
            open={confirm}
            onClose={() => setConfirm(false)}
            title="Delete “Breakfast”?"
            body="Its 3 products stay in your catalog. They just won’t be in this section."
            confirmLabel="Delete section"
            onConfirm={() => setConfirm(false)}
          />
        </Block>
      </div>
    </section>
  );
}
