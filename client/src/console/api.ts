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

import { api, upload } from '../app/api.ts';
import type { CompiledColors, CurrencyFormat, Design, EffectiveConfig, ThemeInputs } from '../app/core.ts';

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
// Orders — the board, the list, the rider picker, cash confirmation, returns
// ---------------------------------------------------------------------------

export type OrderStatus =
  | 'pending'
  | 'approved'
  | 'preparing'
  | 'ready'
  | 'assigned'
  | 'out'
  | 'delivered'
  | 'collected'
  | 'returned'
  | 'closed_return'
  | 'rejected'
  | 'cancelled';

export type OrderListItem = {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  customer: string;
  phone: string | null;
  fulfilment: 'delivery' | 'pickup';
  address: string | null;
  itemCount: number;
  itemSummary: string;
  total: string;
  paymentMethod: string;
  paymentStatus: 'unpaid' | 'paid' | 'refunded';
  /** Cash only: whether confirm_cash_payment() has run. Always true for an online method. */
  cashConfirmed: boolean;
  riderName: string | null;
  hasLiveRefund: boolean;
  placedAt: string;
  ageMinutes: number;
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

export type OrderEvent = {
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  reason: string | null;
  note: string | null;
  actorName: string | null;
  at: string;
};

export type OrderDetail = OrderListItem & {
  lines: OrderLine[];
  subtotal: string;
  deliveryFee: string;
  discount: string;
  cashDue: string | null;
  cashReported: string | null;
  riderId: string | null;
  refundedAmount: string;
  events: OrderEvent[];
};

export type RiderOption = {
  id: string;
  name: string;
  availability: 'available' | 'off_duty';
  activeJobs: number;
  cashCarried: string;
};

export type RefundReasonCode = 'item_missing' | 'wrong_item' | 'quality_problem' | 'arrived_late' | 'other';

/** What every transition below answers: whether it happened, and where the order stands now. */
export type TransitionOutcome = { ok: boolean; status: OrderStatus | null };

function post(storeId: string, orderId: string, action: string, body?: Record<string, unknown>): Promise<TransitionOutcome> {
  return api.post<TransitionOutcome>(`/api/stores/${storeId}/orders/${orderId}/${action}`, body);
}

export const orders = {
  list: (storeId: string): Promise<{ orders: OrderListItem[] }> =>
    api.get<{ orders: OrderListItem[] }>(`/api/stores/${storeId}/orders`),

  get: (storeId: string, orderId: string): Promise<{ order: OrderDetail }> =>
    api.get<{ order: OrderDetail }>(`/api/stores/${storeId}/orders/${orderId}`),

  riders: (storeId: string): Promise<{ riders: RiderOption[] }> =>
    api.get<{ riders: RiderOption[] }>(`/api/stores/${storeId}/orders/riders`),

  accept: (storeId: string, orderId: string):
    Promise<{ orderNumber: number; status: string; accepted: boolean }> =>
    api.post<{ orderNumber: number; status: string; accepted: boolean }>(
      `/api/stores/${storeId}/orders/${orderId}/accept`,
    ),

  decline: (storeId: string, orderId: string, reason: string, note?: string): Promise<TransitionOutcome> =>
    post(storeId, orderId, 'decline', { reason, note }),

  cancel: (storeId: string, orderId: string, reason: string, note?: string): Promise<TransitionOutcome> =>
    post(storeId, orderId, 'cancel', { reason, note }),

  startPreparing: (storeId: string, orderId: string): Promise<TransitionOutcome> =>
    post(storeId, orderId, 'start-preparing'),

  markReady: (storeId: string, orderId: string): Promise<TransitionOutcome> => post(storeId, orderId, 'ready'),

  assignRider: (storeId: string, orderId: string, riderUserId: string):
    Promise<TransitionOutcome & { riderName: string | null }> =>
    api.post<TransitionOutcome & { riderName: string | null }>(
      `/api/stores/${storeId}/orders/${orderId}/assign-rider`,
      { riderUserId },
    ),

  markPickedUp: (storeId: string, orderId: string): Promise<TransitionOutcome> =>
    post(storeId, orderId, 'picked-up'),

  markDelivered: (storeId: string, orderId: string): Promise<TransitionOutcome> =>
    post(storeId, orderId, 'delivered'),

  markCollected: (storeId: string, orderId: string): Promise<TransitionOutcome> =>
    post(storeId, orderId, 'collected'),

  confirmCash: (storeId: string, orderId: string, reportedAmount: string): Promise<TransitionOutcome> =>
    post(storeId, orderId, 'confirm-cash', { reportedAmount }),

  closeReturn: (storeId: string, orderId: string, restock: boolean): Promise<TransitionOutcome> =>
    post(storeId, orderId, 'close-return', { restock }),

  retryDelivery: (storeId: string, orderId: string): Promise<TransitionOutcome> =>
    post(storeId, orderId, 'retry-delivery'),

  requestRefund: (
    storeId: string,
    orderId: string,
    amount: string,
    reasonCode: RefundReasonCode,
    reasonNote?: string,
  ): Promise<{ refundId: string; refundStatus: string }> =>
    api.post<{ refundId: string; refundStatus: string }>(
      `/api/stores/${storeId}/orders/${orderId}/request-refund`,
      { amount, reasonCode, reasonNote },
    ),
};

// ---------------------------------------------------------------------------
// Staff — just enough to add a rider from CashReport's own button (milestone 21).
// Settings' Staff panel (milestone 25) is this same endpoint's real home.
// ---------------------------------------------------------------------------

export type NewMember = {
  created: boolean;
  userId: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'rider';
};

export const members = {
  createRider: (
    storeId: string,
    input: { name: string; email: string; password: string; plateNumber: string; phone?: string },
  ): Promise<NewMember> =>
    api.post<NewMember>(`/api/stores/${storeId}/members`, { ...input, role: 'rider' }),
};

// ---------------------------------------------------------------------------
// Riders & cash — milestone 21
// ---------------------------------------------------------------------------

export type RosterRow = {
  id: string;
  name: string;
  phone: string | null;
  plate: string;
  availability: 'available' | 'off_duty';
  activeJobs: number;
  cashCarried: string;
  lastUpdate: string;
};

export type CashOrderLine = { id: string; orderNumber: number; label: string; amount: string };

export type GapResolution = 'carry_over' | 'discount' | 'write_off';

export type RiderCashCard = {
  riderId: string;
  name: string;
  closedToday: boolean;
  settlementId: string | null;
  deliveredToday: CashOrderLine[];
  stillOut: CashOrderLine[];
  expected: string;
  handedInToday: string;
  due: string;
  gapAmount: string | null;
  gapResolution: GapResolution | null;
};

export type CarriedOverDebt = {
  settlementId: string;
  riderName: string;
  businessDate: string;
  gapAmount: string;
  orderNumber: number | null;
};

export const ridersApi = {
  roster: (storeId: string): Promise<{ roster: RosterRow[] }> =>
    api.get<{ roster: RosterRow[] }>(`/api/stores/${storeId}/riders`),

  cashReport: (storeId: string): Promise<{ cards: RiderCashCard[]; carriedOver: CarriedOverDebt[] }> =>
    api.get<{ cards: RiderCashCard[]; carriedOver: CarriedOverDebt[] }>(`/api/stores/${storeId}/riders/cash-report`),

  handover: (storeId: string, riderId: string, amount: string, note?: string): Promise<{ handoverId: string }> =>
    api.post<{ handoverId: string }>(`/api/stores/${storeId}/riders/${riderId}/handover`, { amount, note }),

  closeDay: (
    storeId: string,
    riderId: string,
    counted: string,
    resolution?: GapResolution,
    gapOrderId?: string,
    gapNote?: string,
  ): Promise<{ settlementId: string }> =>
    api.post<{ settlementId: string }>(`/api/stores/${storeId}/riders/${riderId}/close-day`, {
      counted,
      resolution,
      gapOrderId,
      gapNote,
    }),

  receiveCarriedOver: (storeId: string, settlementId: string): Promise<{ ok: boolean }> =>
    api.post<{ ok: boolean }>(`/api/stores/${storeId}/riders/settlements/${settlementId}/receive`),
};

// ---------------------------------------------------------------------------
// The catalogue — milestone 22
// ---------------------------------------------------------------------------

export type ListTab = 'all' | 'active' | 'draft' | 'low' | 'out';
export type ListSort = 'best' | 'newest' | 'price' | 'stock';
export type StockState = 'ok' | 'low' | 'out' | 'draft';

export type ProductRow = {
  id: string;
  name: string;
  sub: string;
  categories: string[];
  price: string;
  trackStock: boolean;
  stock: number | null;
  state: StockState;
  status: 'active' | 'draft';
  coverImageUrl: string | null;
};

export type ProductList = {
  rows: ProductRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<ListTab, number>;
};

export type ProductQuery = { tab: ListTab; q: string; category: string; sort: ListSort; page: number };

export type EditorValue = { key: string; label: string; priceDelta: string };

export type EditorGroup = {
  id: string | null;
  shared: boolean;
  name: string;
  mode: 'one' | 'several';
  values: EditorValue[];
};

export type EditorVariant = { combo: string[]; label?: string; sku: string | null; stock: number | null; available: boolean };

/** What the server returns for one product, and exactly what the editor sends back. */
export type ProductDoc = {
  id?: string;
  name: string;
  description: string;
  price: string;
  compareAtPrice: string | null;
  status: 'active' | 'draft';
  categoryIds: string[];
  images: string[];
  trackStock: boolean;
  sku: string | null;
  stock: number | null;
  groups: EditorGroup[];
  variants: EditorVariant[];
};

export type ProductSaved = Omit<ProductDoc, 'images'> & { id: string; images: { id: string; url: string }[]; sold: boolean };

export type BulkAction = 'activate' | 'draft' | 'delete' | 'category';

export const productsApi = {
  list: (storeId: string, q: ProductQuery): Promise<ProductList> => {
    const params = new URLSearchParams({ tab: q.tab, sort: q.sort, page: String(q.page) });
    if (q.q !== '') params.set('q', q.q);
    if (q.category !== '') params.set('category', q.category);
    return api.get<ProductList>(`/api/stores/${storeId}/products?${params.toString()}`);
  },

  get: (storeId: string, id: string): Promise<{ product: ProductSaved }> =>
    api.get<{ product: ProductSaved }>(`/api/stores/${storeId}/products/${id}`),

  create: (storeId: string, doc: ProductDoc): Promise<{ product: ProductSaved }> =>
    api.post<{ product: ProductSaved }>(`/api/stores/${storeId}/products`, doc),

  save: (storeId: string, id: string, doc: ProductDoc): Promise<{ product: ProductSaved }> =>
    api.put<{ product: ProductSaved }>(`/api/stores/${storeId}/products/${id}`, doc),

  bulk: (
    storeId: string,
    ids: string[],
    action: BulkAction,
    categoryId?: string,
  ): Promise<{ changed: number; kept: { id: string; name: string }[] }> =>
    api.post<{ changed: number; kept: { id: string; name: string }[] }>(`/api/stores/${storeId}/products/bulk`, {
      ids,
      action,
      categoryId,
    }),

  /** One photo. Resolves to the path a product keeps. */
  uploadPhoto: (storeId: string, file: Blob): Promise<{ url: string }> =>
    upload<{ url: string }>(`/api/stores/${storeId}/uploads`, file),
};

export type CategoryRow = {
  id: string;
  name: string;
  isVisible: boolean;
  productCount: number;
  activeCount: number;
};

type CategoryList = { categories: CategoryRow[] };

export const categoriesApi = {
  list: (storeId: string): Promise<CategoryList> => api.get<CategoryList>(`/api/stores/${storeId}/categories`),

  create: (storeId: string, name: string): Promise<CategoryList> =>
    api.post<CategoryList>(`/api/stores/${storeId}/categories`, { name }),

  update: (storeId: string, id: string, patch: { name?: string; isVisible?: boolean }): Promise<CategoryList> =>
    api.patch<CategoryList>(`/api/stores/${storeId}/categories/${id}`, patch),

  reorder: (storeId: string, ids: string[]): Promise<CategoryList> =>
    api.put<CategoryList>(`/api/stores/${storeId}/categories/order`, { ids }),

  remove: (storeId: string, id: string): Promise<CategoryList & { detached: number }> =>
    api.delete<CategoryList & { detached: number }>(`/api/stores/${storeId}/categories/${id}`),
};

// ---------------------------------------------------------------------------
// The wallet — milestone 23
// ---------------------------------------------------------------------------

export type IdentityState = 'verified' | 'in_review' | 'not_started';

export type WalletData = {
  currency: string;
  pending: string;
  available: string;
  updatedAt: string;
  pendingOrders: number;
  nextRelease: { at: string; amount: string } | null;
  identity: IdentityState;
  /** Approved refunds the balance cannot cover yet — paid before the merchant, and holding payouts. */
  refundsOwed: string;
  holdMinutes: number;
  cashWithRiders: string;
  shortfalls: number;
  payout: { methodKey: string; phoneMasked: string; mode: 'manual' | 'automatic'; automaticAt: string | null } | null;
};

export type ActivityFilter = 'all' | 'sale' | 'refund' | 'withdrawal' | 'adjust';

export type ActivityRow = {
  id: string;
  at: string;
  kind: 'sale' | 'refund' | 'withdrawal' | 'adjust';
  amount: string;
  balanceAfter: string;
  pot: 'pending' | 'available';
  note: string | null;
  orderNumber: number | null;
  method: string | null;
  released: boolean | null;
  availableAt: string | null;
  refund: { approvedAmount: string | null; orderTotal: string; partial: boolean } | null;
  withdrawal: { status: WithdrawalStatus; initiatedBy: 'manual' | 'automatic'; phone: string; failureReason: string | null } | null;
};

export type WithdrawalStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'rejected';

export type Payout = {
  id: string;
  amount: string;
  phoneMasked: string;
  status: WithdrawalStatus;
  failureReason: string | null;
  initiatedBy: 'manual' | 'automatic';
  requestedAt: string;
  completedAt: string | null;
};

export type RefundRow = {
  id: string;
  orderNumber: number;
  reason: string;
  note: string | null;
  requestedAt: string;
  amount: string;
  approvedAmount: string | null;
  orderTotal: string;
  status: 'pending' | 'approved' | 'rejected' | 'queued';
  rejectionReason: string | null;
  settledAt: string | null;
};

type Cursor = { at: string; id: string } | null;

export const walletApi = {
  load: (storeId: string): Promise<WalletData> => api.get<WalletData>(`/api/stores/${storeId}/wallet`),

  activity: (storeId: string, filter: ActivityFilter, cursor: Cursor): Promise<{ activity: ActivityRow[]; nextCursor: Cursor }> => {
    const params = new URLSearchParams({ filter });
    if (cursor !== null) {
      params.set('before', cursor.at);
      params.set('beforeId', cursor.id);
    }
    return api.get<{ activity: ActivityRow[]; nextCursor: Cursor }>(`/api/stores/${storeId}/wallet/activity?${params.toString()}`);
  },

  refunds: (storeId: string): Promise<{ refunds: RefundRow[] }> =>
    api.get<{ refunds: RefundRow[] }>(`/api/stores/${storeId}/wallet/refunds`),

  payouts: (
    storeId: string,
    cursor: { requestedAt: string; id: string } | null,
  ): Promise<{ payouts: Payout[]; nextCursor: { requestedAt: string; id: string } | null }> => {
    const params = new URLSearchParams();
    if (cursor !== null) {
      params.set('before', cursor.requestedAt);
      params.set('beforeId', cursor.id);
    }
    return api.get<{ payouts: Payout[]; nextCursor: { requestedAt: string; id: string } | null }>(
      `/api/stores/${storeId}/payouts?${params.toString()}`,
    );
  },

  payout: (storeId: string, id: string): Promise<{ payout: Payout }> =>
    api.get<{ payout: Payout }>(`/api/stores/${storeId}/payouts/${id}`),

  /** The destination is never sent: the server uses the number in the store's settings. */
  withdraw: (storeId: string, amount: string, idempotencyKey: string): Promise<{ withdrawalId: string; status: WithdrawalStatus; failureReason: string | null }> =>
    api.post(`/api/stores/${storeId}/payouts`, { amount, idempotencyKey }),

  setMode: (storeId: string, mode: 'manual' | 'automatic'): Promise<{ payout: { mode: 'manual' | 'automatic'; automaticAt: string | null; phoneMasked: string } | null }> =>
    api.put(`/api/stores/${storeId}/payouts/mode`, { mode }),
};

// ---------------------------------------------------------------------------
// Support and insight — milestone 24
// ---------------------------------------------------------------------------

export type ReviewFilter = 'all' | 'reply' | 'low';

export type ReviewItem = {
  id: string;
  product: string;
  customer: string;
  orderNumber: number;
  at: string;
  rating: number;
  body: string | null;
  reply: string | null;
  reported: { reason: string } | null;
};

export type ReviewsOverview = {
  averageRating: string | null;
  last90Days: number;
  needsReply: number;
  lowThisMonth: number;
  lowLastMonth: number;
  reportedOpen: number;
};

export type ProductRating = { id: string; name: string; count: number; average: string | null };

export type ReviewsPage = {
  overview: ReviewsOverview | null;
  reviews: ReviewItem[];
  nextCursor: { at: string; id: string } | null;
  byProduct: ProductRating[] | null;
  minForAverage: number;
};

export type ReportReason = 'abusive' | 'personal_info' | 'not_a_customer' | 'spam';

export const reviewsApi = {
  load: (storeId: string, filter: ReviewFilter, cursor: { at: string; id: string } | null): Promise<ReviewsPage> => {
    const params = new URLSearchParams({ filter });
    if (cursor !== null) {
      params.set('before', cursor.at);
      params.set('beforeId', cursor.id);
    }
    return api.get<ReviewsPage>(`/api/stores/${storeId}/reviews?${params.toString()}`);
  },
  reply: (storeId: string, id: string, body: string): Promise<{ ok: boolean }> =>
    api.post<{ ok: boolean }>(`/api/stores/${storeId}/reviews/${id}/reply`, { body }),
  report: (storeId: string, id: string, reason: ReportReason): Promise<{ ok: boolean }> =>
    api.post<{ ok: boolean }>(`/api/stores/${storeId}/reviews/${id}/report`, { reason }),
};

export type ComplaintTab = 'open' | 'escalated' | 'closed';
export type ComplaintStatus = 'open' | 'escalated' | 'resolved' | 'rejected';

export type ComplaintListItem = {
  id: string;
  reference: string;
  reason: string;
  customer: string;
  orderNumber: number;
  at: string;
  status: ComplaintStatus;
};

export type TimelineEvent = {
  type: string;
  side: 'customer' | 'store' | 'rider' | 'platform' | 'system';
  note: string | null;
  at: string;
  actor: string | null;
};

export type ComplaintDetail = {
  id: string;
  reference: string;
  reason: string;
  status: ComplaintStatus;
  text: string;
  at: string;
  reopenedCount: number;
  customer: { name: string; phone: string | null };
  order: {
    id: string;
    number: number;
    items: { label: string; amount: string }[];
    total: string;
    refunded: string;
    deliveredAt: string | null;
    riderName: string | null;
    paymentMethod: string;
    fulfilment: 'delivery' | 'pickup';
  };
  evidence: { id: string; side: string; kind: string; label: string; url: string | null }[];
  timeline: TimelineEvent[];
  decision: 'refunded' | 'rejected' | null;
  pendingRefund: string | null;
};

export const complaintsApi = {
  list: (storeId: string, tab: ComplaintTab): Promise<{ counts: Record<ComplaintTab, number>; complaints: ComplaintListItem[] }> =>
    api.get(`/api/stores/${storeId}/complaints?tab=${tab}`),
  get: (storeId: string, id: string): Promise<{ complaint: ComplaintDetail }> =>
    api.get<{ complaint: ComplaintDetail }>(`/api/stores/${storeId}/complaints/${id}`),
  resolve: (storeId: string, id: string, note: string, refundAmount?: string): Promise<{ complaint: ComplaintDetail }> =>
    api.post<{ complaint: ComplaintDetail }>(`/api/stores/${storeId}/complaints/${id}/resolve`, { note, refundAmount }),
  reject: (storeId: string, id: string, note: string): Promise<{ complaint: ComplaintDetail }> =>
    api.post<{ complaint: ComplaintDetail }>(`/api/stores/${storeId}/complaints/${id}/reject`, { note }),
  escalate: (storeId: string, id: string, note: string): Promise<{ complaint: ComplaintDetail }> =>
    api.post<{ complaint: ComplaintDetail }>(`/api/stores/${storeId}/complaints/${id}/escalate`, { note }),
  reopen: (storeId: string, id: string): Promise<{ complaint: ComplaintDetail }> =>
    api.post<{ complaint: ComplaintDetail }>(`/api/stores/${storeId}/complaints/${id}/reopen`),
};

export type CustomerSegment = 'all' | 'regular' | 'account' | 'guest';

export type CustomerRow = {
  key: string;
  name: string;
  phone: string | null;
  orders: number;
  spent: string;
  lastOrderAt: string;
  account: boolean;
  complaints: number;
};

export type CustomerList = {
  rows: CustomerRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<CustomerSegment, number>;
};

export type CustomerDetail = CustomerRow & {
  usualAddress: string | null;
  recent: { id: string; number: number; at: string; total: string; status: string }[];
  note: string | null;
};

export const customersApi = {
  list: (storeId: string, segment: CustomerSegment, q: string, page: number): Promise<CustomerList> => {
    const params = new URLSearchParams({ segment, page: String(page) });
    if (q !== '') params.set('q', q);
    return api.get<CustomerList>(`/api/stores/${storeId}/customers?${params.toString()}`);
  },
  get: (storeId: string, key: string): Promise<{ customer: CustomerDetail }> =>
    api.get<{ customer: CustomerDetail }>(`/api/stores/${storeId}/customers/${encodeURIComponent(key)}`),
  setNote: (storeId: string, key: string, note: string): Promise<{ note: string | null }> =>
    api.put<{ note: string | null }>(`/api/stores/${storeId}/customers/${encodeURIComponent(key)}/note`, { note }),
  /** A plain link: the browser sends the session cookie and saves the file. */
  exportUrl: (storeId: string): string => `/api/stores/${storeId}/customers/export`,
};

export type AnalyticsTab = 'summary' | 'orders' | 'revenue' | 'items' | 'payments' | 'delivery';
export type AnalyticsRange = 7 | 14 | 30;

export type MethodInfo = { key: string; name: string; kind: 'online' | 'offline' };

export type RevenueData = {
  dates: string[];
  methods: MethodInfo[];
  byDay: Record<string, Record<string, string>>;
  revenue: string;
  previousRevenue: string;
  orders: number;
  previousOrders: number;
  refunded: string;
  pendingNow: string;
  paidOut: string;
  automaticPayouts: number;
  repeatShare: number | null;
};

export type OrdersAnalytics = {
  dates: string[];
  perDay: Record<string, number>;
  total: number;
  previousTotal: number;
  deliveryShare: number | null;
  turnedAway: number;
  topReason: string | null;
  acceptMinutes: number | null;
  busiestHour: number | null;
};

export type ItemsAnalytics = {
  items: { name: string; sold: number; revenue: string }[];
  itemsSold: number;
  bestSeller: string | null;
  topEarner: string | null;
  outOfStockNow: number;
};

export type PaymentsAnalytics = {
  methods: (MethodInfo & { orders: number; revenue: string; successRate: number | null })[];
  paidOnlineShare: number | null;
  failedPayments: number;
  retriedAfterFailure: number;
  cashUnconfirmed: { orders: number; amount: string };
  refunds: { count: number; amount: string };
};

export type DeliveryAnalytics = {
  riders: { id: string; name: string; deliveries: number; avgMinutes: number | null; onTimeShare: number | null }[];
  orderToDoorMinutes: number | null;
  prepMinutes: number | null;
  waitingForRiderMinutes: number | null;
  returned: number;
  topReturnReason: string | null;
  etaMaxMinutes: number | null;
};

export type AnalyticsPayload =
  | { tab: 'summary' | 'revenue'; data: RevenueData }
  | { tab: 'orders'; data: OrdersAnalytics }
  | { tab: 'items'; data: ItemsAnalytics }
  | { tab: 'payments'; data: PaymentsAnalytics }
  | { tab: 'delivery'; data: DeliveryAnalytics };

export const analyticsApi = {
  load: (storeId: string, tab: AnalyticsTab, range: AnalyticsRange): Promise<AnalyticsPayload & { range: number; from: string; to: string }> =>
    api.get(`/api/stores/${storeId}/analytics/${tab}?range=${range}`),
  exportUrl: (storeId: string, tab: AnalyticsTab, range: AnalyticsRange): string => `/api/stores/${storeId}/analytics/${tab}/export?range=${range}`,
};

// ---------------------------------------------------------------------------
// The store's look — milestone 25 (ThemeStudio and Customize)
// ---------------------------------------------------------------------------


export type StoredLook = {
  inputs: ThemeInputs;
  colors: CompiledColors;
  dark: boolean;
  outline: boolean;
  /** False when this build's compiler would now produce a different palette from the one on record. */
  matchesCompiler?: boolean;
  updatedAt?: string;
  publishedAt?: string | null;
};

export type StoredDesign = Design & { updatedAt: string; publishedAt: string | null };

export type LookPayload = {
  draft: StoredLook | null;
  published: StoredLook | null;
  design: { draft: StoredDesign | null; published: StoredDesign | null; defaults: Design };
};

export const lookApi = {
  load: (storeId: string): Promise<LookPayload> => api.get<LookPayload>(`/api/stores/${storeId}/theme`),

  /** A draft is never gated: the studio shows what is wrong rather than refusing to remember it. */
  saveDraft: (storeId: string, inputs: ThemeInputs, design?: Design): Promise<unknown> =>
    api.put(`/api/stores/${storeId}/theme/draft`, { ...inputs, ...(design === undefined ? {} : { design }) }),

  publish: (storeId: string, inputs: ThemeInputs, design?: Design): Promise<unknown> =>
    api.post(`/api/stores/${storeId}/theme/publish`, { ...inputs, ...(design === undefined ? {} : { design }) }),

  /** Back to the platform's own look. The draft is kept. */
  revert: (storeId: string): Promise<{ reverted: boolean }> => api.delete<{ reverted: boolean }>(`/api/stores/${storeId}/theme/published`),

  uploadLogo: (storeId: string, file: Blob): Promise<{ url: string }> => upload<{ url: string }>(`/api/stores/${storeId}/uploads`, file),
};
