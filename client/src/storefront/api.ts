// client/src/storefront/api.ts — milestone 16.
//
// The shapes the shopfront reads, and the calls that fetch them. One module, so a field the server
// renamed breaks the build in one place rather than in six components.
//
// EVERY AMOUNT IS A STRING HERE, exactly as the server sent it — "3500.00", never 3500. Milestone 13's
// rule, and the reason is that a `number` invites arithmetic that loses cents. Amounts become numbers
// only inside packages/core, as BigInt minor units, and come back out as formatted text.
//
// NOTHING IS CACHED IN A MODULE VARIABLE. §2.5: the server is authoritative, and every screen must
// render correctly with browser storage empty. A module-level cache is the same bug with a shorter
// lifetime — it survives a route change and then disagrees with the server about what is in the cart.

import { api } from '../app/api.ts';
import type { CurrencyFormat } from '../app/core.ts';

export type OpenState = {
  isOpen: boolean;
  closesAt: string | null;
  opensAt: string | null;
  /** ISO day number: the session in effect while open, the next opening while shut. 1 = Monday. */
  opensOn: number | null;
};

export type StoreFace = {
  store: {
    id: string;
    slug: string;
    name: string;
    currency: string;
    country: string;
    phone: string | null;
  };
  open: OpenState;
  hours: { dayOfWeek: number; opensAt: string; closesAt: string }[];
  delivery: { fromFee: string; etaMinMinutes: number; etaMaxMinutes: number; zoneCount: number } | null;
  pickup: { address: string; readyMinutes: number; instructions: string | null } | null;
  banner: { promotionId: string; title: string | null; subtitle: string | null } | null;
  categories: { id: string; name: string; description: string; imageUrl: string | null; productCount: number }[];
};

export type RatingSummary = {
  reviewCount: number;
  /** Null below three reviews — V009's rule. The screen must not render it as a number. */
  averageRating: string | null;
  counts: Record<'1' | '2' | '3' | '4' | '5', number>;
};

export type StockState = { soldOut: boolean; lowStock: boolean; fewestLeft: number | null };

export type ProductCardData = {
  id: string;
  name: string;
  description: string;
  price: string;
  compareAtPrice: string | null;
  coverImageUrl: string | null;
  defaultVariantId: string | null;
  hasChoices: boolean;
  hasExtras: boolean;
  stock: StockState;
  rating: RatingSummary | null;
};

export type ProductCursor = { position: number; id: string };

export type OptionValueData = { id: string; label: string; priceDelta: string; isAvailable: boolean };

export type OptionGroupData = {
  id: string;
  name: string;
  selectMode: 'one' | 'several';
  isRequired: boolean;
  values: OptionValueData[];
};

export type VariantData = {
  id: string;
  sku: string | null;
  stockQuantity: number | null;
  isAvailable: boolean;
  isDefault: boolean;
  optionValueIds: string[];
};

export type ProductDetailData = ProductCardData & {
  trackStock: boolean;
  groups: OptionGroupData[];
  variants: VariantData[];
  categoryIds: string[];
};

export type ReviewData = {
  id: string;
  rating: number;
  body: string | null;
  author: string;
  createdAt: string;
  reply: { body: string; createdAt: string } | null;
};

/** The four things the review sheet can be. See the note in routes/storefrontCatalogue.ts. */
export type WriteGate =
  | { can: true; orderCode: string }
  | { can: false; reason: 'needsSignIn' }
  | { can: false; reason: 'nothingToReview' }
  | { can: false; reason: 'alreadyReviewed'; reviewId: string };

export type CartLineData = {
  id: string;
  variantId: string;
  productId: string;
  productName: string;
  optionLabels: string[];
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  coverImageUrl: string | null;
  unavailable: boolean;
};

export type CartData = {
  id: string | null;
  lines: CartLineData[];
  itemCount: number;
  subtotal: string;
  expiresAt: string | null;
};

// --- milestone 17: checkout ---------------------------------------------------

export type DeliveryOption = {
  zoneId: string;
  name: string;
  fee: string;
  etaMinMinutes: number;
  etaMaxMinutes: number;
  areas: string[];
};

export type PaymentOption = {
  key: string;
  label: string;
  hint: string;
  kind: 'offline' | 'online';
  minAmount: string | null;
  maxAmount: string | null;
  /** False when this total is outside the provider's range. Shown, but not choosable. */
  usableForTotal: boolean;
};

export type PromoState = { code: string; applies: boolean; reason: string | null; amount: string };

export type Quote = {
  itemCount: number;
  subtotal: string;
  deliveryFee: string;
  discount: string;
  total: string;
  /** What the rider collects, for cash. Null for every other method. */
  cashDue: string | null;
  promo: PromoState | null;
  fulfilment: 'delivery' | 'pickup';
  zone: DeliveryOption | null;
  paymentMethods: PaymentOption[];
  unavailable: { productName: string; reason: 'sold_out' | 'withdrawn' }[];
};

export type PlacedOrder = {
  orderNumber: number;
  trackingCode: string;
  total: string;
  cashDue: string | null;
  paymentMethod: string;
};

export type PaymentState = {
  status: 'pending' | 'successful' | 'failed';
  message?: string | null;
  phone?: string;
  amount?: string;
  reference?: string;
};

export type OrderLine = {
  id: string;
  productName: string;
  variantLabel: string;
  optionLabels: string[];
  quantity: number;
  unitPrice: string;
  lineTotal: string;
};

export type CustomerOrder = {
  id: string;
  orderNumber: number;
  trackingCode: string;
  status: string;
  paymentStatus: 'unpaid' | 'paid' | 'refunded';
  paymentMethod: string;
  fulfilment: 'delivery' | 'pickup';
  deliveryAddress: string | null;
  subtotal: string;
  deliveryFee: string;
  discount: string;
  total: string;
  cashDue: string | null;
  placedAt: string;
  paidAt: string | null;
  lines: OrderLine[];
  events: { status: string; at: string; note: string | null }[];
  store: { slug: string; name: string; phone: string | null };
  pickup: { address: string; readyMinutes: number; instructions: string | null } | null;
  delivery: { etaMinMinutes: number; etaMaxMinutes: number } | null;
  placedFor: string | null;
};

export type ThemePayload = {
  store: { slug: string; name: string };
  theme: {
    inputs: unknown;
    colors: Record<string, string>;
    dark: boolean;
    outline: boolean;
    publishedAt: string;
  } | null;
  currency: CurrencyFormat;
};

const enc = encodeURIComponent;

export const storefront = {
  face: (slug: string): Promise<StoreFace> => api.get<StoreFace>(`/api/storefront/${enc(slug)}`),

  theme: (slug: string): Promise<ThemePayload> => api.get<ThemePayload>(`/api/storefront/${enc(slug)}/theme`),

  products: (
    slug: string,
    options: { category?: string | null; q?: string; limit?: number; after?: ProductCursor | null } = {},
  ): Promise<{ products: ProductCardData[]; nextCursor: ProductCursor | null }> => {
    const params = new URLSearchParams();
    if (options.category != null && options.category !== '') params.set('category', options.category);
    if (options.q !== undefined && options.q.trim() !== '') params.set('q', options.q.trim());
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.after != null) {
      params.set('afterPosition', String(options.after.position));
      params.set('afterId', options.after.id);
    }
    const query = params.toString();
    return api.get(`/api/storefront/${enc(slug)}/products${query === '' ? '' : `?${query}`}`);
  },

  product: (
    slug: string,
    productId: string,
  ): Promise<{
    product: ProductDetailData;
    rating: RatingSummary;
    reviews: ReviewData[];
    nextCursor: { createdAt: string; id: string } | null;
    write: WriteGate;
  }> => api.get(`/api/storefront/${enc(slug)}/products/${enc(productId)}`),

  reviews: (
    slug: string,
    productId: string,
    after: { createdAt: string; id: string },
  ): Promise<{ reviews: ReviewData[]; nextCursor: { createdAt: string; id: string } | null }> =>
    api.get(
      `/api/storefront/${enc(slug)}/products/${enc(productId)}/reviews` +
        `?after=${enc(after.createdAt)}&afterId=${enc(after.id)}`,
    ),

  postReview: (
    slug: string,
    productId: string,
    body: { rating: number; body?: string },
  ): Promise<{ review: { id: string; rating: number; body: string | null }; rating: RatingSummary }> =>
    api.post(`/api/storefront/${enc(slug)}/products/${enc(productId)}/reviews`, body),

  cart: (slug: string): Promise<{ cart: CartData }> => api.get(`/api/storefront/${enc(slug)}/cart`),

  addToCart: (
    slug: string,
    body: { variantId: string; optionValueIds?: string[]; quantity?: number },
  ): Promise<{ line: { id: string; quantity: number; created: boolean }; cart: CartData }> =>
    api.post(`/api/storefront/${enc(slug)}/cart/items`, body),

  setQuantity: (slug: string, lineId: string, quantity: number): Promise<{ cart: CartData }> =>
    api.patch(`/api/storefront/${enc(slug)}/cart/items/${enc(lineId)}`, { quantity }),

  removeLine: (slug: string, lineId: string): Promise<{ cart: CartData }> =>
    api.delete(`/api/storefront/${enc(slug)}/cart/items/${enc(lineId)}`),

  setPromo: (slug: string, code: string | null): Promise<{ promo: PromoState | null; cart: CartData }> =>
    api.put(`/api/storefront/${enc(slug)}/cart/promo`, { code }),

  checkout: (
    slug: string,
    options: { fulfilment: 'delivery' | 'pickup'; zone?: string | null },
  ): Promise<{ quote: Quote; deliveryOptions: DeliveryOption[] }> => {
    const params = new URLSearchParams({ fulfilment: options.fulfilment });
    if (options.zone != null && options.zone !== '') params.set('zone', options.zone);
    return api.get(`/api/storefront/${enc(slug)}/checkout?${params.toString()}`);
  },

  placeOrder: (
    slug: string,
    body: {
      idempotencyKey: string;
      fulfilment: 'delivery' | 'pickup';
      paymentMethod: string;
      expectedTotal: string;
      name?: string;
      phone?: string;
      email?: string;
      address?: string;
      zone?: string;
    },
  ): Promise<{ order: PlacedOrder; created: boolean; needsPayment: boolean }> =>
    api.post(`/api/storefront/${enc(slug)}/orders`, body),

  order: (slug: string, code: string): Promise<{ order: CustomerOrder; payment: PaymentState | null }> =>
    api.get(`/api/storefront/${enc(slug)}/orders/${enc(code)}`),

  startPayment: (
    slug: string,
    code: string,
    phone: string,
  ): Promise<{ payment: PaymentState; started?: boolean; alreadyPaid?: boolean; warning?: string }> =>
    api.post(`/api/storefront/${enc(slug)}/orders/${enc(code)}/payment`, { phone }),

  paymentStatus: (
    slug: string,
    code: string,
  ): Promise<{ payment: PaymentState | null; order: { paymentStatus: string } }> =>
    api.get(`/api/storefront/${enc(slug)}/orders/${enc(code)}/payment`),
};
