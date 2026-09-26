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
};
