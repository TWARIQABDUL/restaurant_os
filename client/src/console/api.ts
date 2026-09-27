// client/src/console/api.ts — milestone 19.
//
// Every read and write the merchant console makes, named once. The pattern is the storefront's
// (src/storefront/api.ts): the shapes live beside the calls, so a screen imports a type and a function
// together and nothing in a component composes a URL.
//
// THE STORE IS ALWAYS A UUID HERE, never a slug — which is the opposite of the storefront. The console's own
// URL carries the slug (`/app/:store`), because §2.5 says "the store comes from the URL, never from a
// remembered slug"; the API takes the id, because the guard on every /api/stores/:storeId route reads the
// membership for that id and "a caller naming a store they do not work at gets 403 from the store they
// named". GET /api/session is what turns one into the other, and it is the only place that does.

import { api } from '../app/api.ts';
import type { CompiledColors, CurrencyFormat, EffectiveConfig } from '../app/core.ts';

// ---------------------------------------------------------------------------
// The shell — one document, loaded once per store
// ---------------------------------------------------------------------------

export type ConsoleStore = {
  id: string;
  slug: string;
  name: string;
  status: string;
  country: string;
  /** The store's own IANA zone, from V021. Every time the console prints is formatted in it. */
  timeZone: string;
  currency: CurrencyFormat;
};

export type ConsoleMe = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'manager' | 'rider' | null;
  /** So a screen can ask whether this role may do something rather than testing the role's name. */
  permissions: readonly string[];
};

export type ShellBadges = {
  orders: number;
  complaints: number;
  reviews: number;
  notifications: number;
};

export type ShellData = {
  store: ConsoleStore;
  me: ConsoleMe;
  config: EffectiveConfig;
  theme: { colors: CompiledColors; dark: boolean; outline: boolean; publishedAt: string | null } | null;
  badges: ShellBadges;
};

export const shell = {
  load: (storeId: string): Promise<ShellData> => api.get<ShellData>(`/api/stores/${storeId}/shell`),
};

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

export type DashboardCounts = {
  ordersToday: number;
  ordersWaiting: number;
  productsActive: number;
  productsDraft: number;
  lowStockVariants: number;
  isOpen: boolean;
  /** 'HH:MM' in the store's own time zone, or null when it has no hours set for today. */
  closesAt: string | null;
  acceptingOrders: boolean;
  /** The store's local date, which is what "today" on every card means. */
  localDate: string;
};

/** Absent for a role without `wallet.read`. A manager's dashboard has no money on it at all. */
export type DashboardSales = {
  salesToday: string;
  salesSameDayLastWeek: string;
  changePercent: number | null;
} | null;

export type DashboardDay = { day: string; dayOfWeek: number; sales: string; orders: number };

export type ConsoleOrder = {
  id: string;
  orderNumber: number;
  trackingCode: string;
  customer: string;
  fulfilment: 'delivery' | 'pickup';
  itemCount: number;
  total: string;
  paymentMethod: string;
  paymentStatus: string;
  placedAt: string;
};

export type DashboardData = {
  me: { name: string; role: string | null };
  counts: DashboardCounts;
  sales: DashboardSales;
  week: DashboardDay[] | null;
  needsAttention: ConsoleOrder[];
  recent: (ConsoleOrder & { status: string })[];
  lowestStock: { productName: string; variantLabel: string | null; left: number } | null;
  unreadNotifications: number;
};

export const dashboard = {
  load: (storeId: string): Promise<DashboardData> =>
    api.get<DashboardData>(`/api/stores/${storeId}/dashboard`),

  /** "Pause new orders", and starting again. */
  setAccepting: (storeId: string, accepting: boolean): Promise<{ acceptingOrders: boolean }> =>
    api.put<{ acceptingOrders: boolean }>(`/api/stores/${storeId}/dashboard/accepting`, { accepting }),
};

// ---------------------------------------------------------------------------
// Notifications, and the new-order alert
// ---------------------------------------------------------------------------

/** V010's five tones. The panel colours a row from this and nothing else. */
export type NotificationTone = 'info' | 'good' | 'bad' | 'attention' | 'progress';

export type Notification = {
  id: string;
  type: string;
  tone: NotificationTone;
  /** The console path it is about — /app/orders, /app/money. The panel prefixes the store's slug. */
  route: string;
  /** THE VALUES, NOT THE WORDS. V010: the sentence is the industry template's, so the client writes it. */
  payload: Record<string, unknown>;
  orderId: string | null;
  complaintId: string | null;
  reviewId: string | null;
  withdrawalId: string | null;
  unread: boolean;
  createdAt: string;
};

export type NotificationCursor = { createdAt: string; id: string };

export type NotificationPage = {
  notifications: Notification[];
  nextCursor: NotificationCursor | null;
  unread: number;
};

export type OrderAlert = {
  orderId: string;
  orderNumber: number;
  trackingCode: string;
  customer: string;
  total: string;
  fulfilment: string;
  paymentMethod: string;
  paymentStatus: string;
  deliveryAddress: string | null;
  placedAt: string;
  /** From the order's placed_at, not from when this tab opened — so a reload shows the customer's wait. */
  waitingSeconds: number;
};

export const notifications = {
  page: (storeId: string, options: { unreadOnly?: boolean; before?: NotificationCursor | null } = {}):
    Promise<NotificationPage> => {
    const query = new URLSearchParams();
    if (options.unreadOnly === true) query.set('unread', 'true');
    if (options.before != null) {
      // BOTH HALVES OR NEITHER — V010's cursor IS the pair, because rows written by one transaction share a
      // timestamp and a half cursor steps over all of them. The server refuses one without the other.
      query.set('before', options.before.createdAt);
      query.set('beforeId', options.before.id);
    }
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return api.get<NotificationPage>(`/api/stores/${storeId}/notifications${suffix}`);
  },

  markAllRead: (storeId: string): Promise<{ unread: number }> =>
    api.post<{ unread: number }>(`/api/stores/${storeId}/notifications/read-all`),

  markRead: (storeId: string, id: string): Promise<{ unread: number }> =>
    api.post<{ unread: number }>(`/api/stores/${storeId}/notifications/${id}/read`),

  alert: (storeId: string): Promise<{ alert: OrderAlert | null; sound: boolean }> =>
    api.get<{ alert: OrderAlert | null; sound: boolean }>(`/api/stores/${storeId}/notifications/alert`),

  /** Per DEVICE, not per account: "Sound is off for this device." */
  setSound: (storeId: string, enabled: boolean): Promise<{ sound: boolean }> =>
    api.put<{ sound: boolean }>(`/api/stores/${storeId}/notifications/sound`, { enabled }),
};

// ---------------------------------------------------------------------------
// Orders — the one transition the alert needs. Milestone 20 owns the rest.
// ---------------------------------------------------------------------------

export const orders = {
  accept: (storeId: string, orderId: string):
    Promise<{ orderNumber: number; status: string; accepted: boolean }> =>
    api.post<{ orderNumber: number; status: string; accepted: boolean }>(
      `/api/stores/${storeId}/orders/${orderId}/accept`,
    ),
};
