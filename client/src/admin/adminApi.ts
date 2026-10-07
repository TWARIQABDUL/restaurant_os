// client/src/admin/adminApi.ts — milestone 27. Every call the Vendlyfy team's console makes (api.ts's style: shapes beside calls).

import { api } from '../app/api.ts';

export type Me = { id: string; name: string; email: string; role: string | null; permissions: string[] };

export type Range = 'today' | 'week' | 'month';

export type Kpi = { key: 'sales' | 'orders' | 'stores' | 'signups' | 'payment'; value: number | null; previous: number | null; note: string | null };

export type Overview = {
  range: Range;
  kpis: Kpi[];
  queue: { kind: 'identity' | 'payout' | 'disputes' | 'template'; title: string; sub: string; ageHours: number | null; count: number }[];
  providers: { key: string; name: string; short: string; rate: number | null; attempts: number; status: 'operational' | 'degraded' | 'quiet' | 'paused'; note: string | null }[];
  industries: { name: string; amount: number; share: number }[];
  activity: { at: string; who: string; what: string }[];
};

export type MerchantTab = 'pending' | 'active' | 'suspended';
export type IdentityState = 'none' | 'building' | 'in_review' | 'redo_requested' | 'rejected' | 'approved';

export type MerchantRow = {
  id: string;
  slug: string;
  name: string;
  status: 'pending' | 'active' | 'suspended';
  identity: IdentityState;
  identityCaseId: string | null;
  owner: { name: string; phone: string | null } | null;
  industry: string | null;
  plan: string | null;
  sales30: number;
  createdAt: string;
};

export type MerchantList = {
  rows: MerchantRow[];
  hasMore: boolean;
  counts: Record<MerchantTab, number>;
  filters: { industries: { key: string; name: string }[]; plans: { key: string; name: string }[] };
};

export type MerchantDetail = MerchantRow & {
  orders: number;
  openDisputes: number;
  suspension: { reason: string; note: string | null; at: string; by: string } | null;
  checks: { key: string; label: string; state: 'ok' | 'warn' | 'wait'; note: string }[];
  payout: string;
};

export type QueueItem = {
  id: string;
  reference: number;
  owner: string;
  store: string;
  storeId: string;
  documentType: 'national_id' | 'passport';
  ageHours: number;
  flag: { tone: 'ok' | 'warn' | 'bad'; label: string };
};

export type Part = 'id_front' | 'id_back' | 'face_video';
export type CheckState = 'pass' | 'warn' | 'fail' | 'open';

export type CaseDetail = {
  id: string;
  reference: number;
  status: 'submitted' | 'in_review' | 'redo_requested' | 'approved' | 'rejected';
  storeId: string;
  storeName: string;
  storeSlug: string;
  owner: string;
  documentType: 'national_id' | 'passport';
  submittedAt: string;
  decisionNote: string | null;
  documents: { part: Part; contentType: string; byteSize: number | null; purged: boolean; outcome: 'accepted' | 'retake' | null }[];
  checks: { code: string; label: string; by: 'computed' | 'reviewer'; state: CheckState; note: string }[];
  fields: { fullName: string | null; accountName: string; dateOfBirth: string | null; expiresOn: string | null; idNumberMasked: string | null; hasIdNumber: boolean };
};

export const adminApi = {
  me: (): Promise<Me> => api.get<Me>('/api/admin/me'),
  overview: (range: Range): Promise<Overview> => api.get<Overview>(`/api/admin/overview?range=${range}`),

  merchants: (q: { tab: MerchantTab; q: string; industry: string; plan: string }): Promise<MerchantList> => {
    const p = new URLSearchParams({ tab: q.tab });
    if (q.q !== '') p.set('q', q.q);
    if (q.industry !== '') p.set('industry', q.industry);
    if (q.plan !== '') p.set('plan', q.plan);
    return api.get<MerchantList>(`/api/admin/merchants?${p.toString()}`);
  },
  merchant: (id: string): Promise<MerchantDetail> => api.get<MerchantDetail>(`/api/admin/merchants/${id}`),
  suspend: (id: string, reason: string, note: string): Promise<MerchantDetail> => api.post<MerchantDetail>(`/api/admin/merchants/${id}/suspend`, { reason, ...(note === '' ? {} : { note }) }),
  reinstate: (id: string): Promise<MerchantDetail> => api.post<MerchantDetail>(`/api/admin/merchants/${id}/reinstate`),

  queue: (): Promise<{ queue: QueueItem[] }> => api.get<{ queue: QueueItem[] }>('/api/admin/kyc'),
  case: (id: string): Promise<CaseDetail> => api.get<CaseDetail>(`/api/admin/kyc/${id}`),
  /** A URL, not a fetch: the browser loads it as an image or video, with the session cookie. Every load is an audit entry. */
  documentUrl: (id: string, part: Part): string => `/api/admin/kyc/${id}/documents/${part}`,
  saveDetails: (id: string, d: { fullName: string; dateOfBirth: string; expiresOn: string; idNumber: string }): Promise<CaseDetail> =>
    api.put<CaseDetail>(`/api/admin/kyc/${id}/details`, { fullName: d.fullName, dateOfBirth: d.dateOfBirth, expiresOn: d.expiresOn, ...(d.idNumber === '' ? {} : { idNumber: d.idNumber }) }),
  setCheck: (id: string, code: string, outcome: 'pass' | 'warn' | 'fail'): Promise<CaseDetail> => api.put<CaseDetail>(`/api/admin/kyc/${id}/checks/${code}`, { outcome }),
  reveal: (id: string, reason: string): Promise<{ idNumber: string }> => api.post<{ idNumber: string }>(`/api/admin/kyc/${id}/reveal`, { reason }),
  decide: (id: string, outcome: 'approve' | 'reject' | 'redo', note: string, part?: 'front' | 'back' | 'video'): Promise<CaseDetail> =>
    api.post<CaseDetail>(`/api/admin/kyc/${id}/decision`, { outcome, ...(note === '' ? {} : { note }), ...(part === undefined ? {} : { part }) }),
};

// ---------------------------------------------------------------------------
// Part B — money and configuration
// ---------------------------------------------------------------------------

export type PayoutTab = 'problem' | 'held' | 'live' | 'done';

export type PayoutRow = {
  id: string;
  storeId: string;
  store: string;
  kind: 'Automatic' | 'Manual' | 'Held';
  destination: string;
  amount: number;
  at: string | null;
  status: 'failed' | 'held' | 'processing' | 'completed' | 'rejected';
  note: string;
  canRetry: boolean;
};

export type PayoutsPage = {
  tab: PayoutTab;
  rows: PayoutRow[];
  counts: Record<PayoutTab, number>;
  kpis: { runTotal: number; runStores: number; failed: number; held: number; holdMinutes: number };
};

export type DisputeTab = 'refunds' | 'disputes' | 'closed';
export type DisputeKind = 'refund' | 'dispute';

export type DisputeItem = {
  kind: DisputeKind;
  id: string;
  title: string;
  store: string;
  storeId: string;
  order: number;
  customer: string;
  ageHours: number;
  status: 'open' | 'approved' | 'queued' | 'rejected';
};

export type DisputeDetail = {
  kind: DisputeKind;
  id: string;
  title: string;
  status: DisputeItem['status'];
  store: { id: string; name: string };
  order: { id: string; number: number; items: { label: string; amount: string }[]; total: string; refunded: string; payment: string; line: string };
  customer: string;
  requested: string;
  maxRefund: string;
  wallet: { available: string; pending: string };
  history: string;
  thread: { who: string; side: 'customer' | 'store' | 'platform' | 'rider' | 'system'; at: string; text: string }[];
  evidence: { label: string; side: string }[];
  closedNote: string | null;
  refundBlocked: string | null;
};

export type Currency = {
  code: string;
  name: string;
  symbol: string;
  position: 'before' | 'after';
  decimals: 0 | 2;
  separator: ',' | ' ' | '.';
  rounding: 0 | 10 | 50 | 100 | 500;
  enabled: boolean;
  isDefault: boolean;
  rateSource: 'feed' | 'manual';
  usdRate: number | null;
  rateUpdatedAt: string | null;
  tag: string;
  usage: string;
  lockedReason: string | null;
};

export type CurrencyPatch = Partial<{ symbol: string; position: string; decimals: number; separator: string; rounding: number; enabled: boolean; rateSource: string; usdRate: number | null }>;

export type MethodStatus = 'draft' | 'live' | 'paused';
export type MethodRow = { key: string; name: string; short: string; kind: 'online' | 'offline'; status: MethodStatus; countries: string[]; currencies: string[] };
export type MethodDetail = MethodRow & {
  provider: string | null;
  webhook: string | null;
  customerLabel: string;
  customerHint: string;
  incidentNote: string | null;
  limits: { currency: string; min: number | null; max: number | null }[];
  stores: number;
  health: { rate: number | null; attempts: number };
  readiness: { key: string; label: string; ok: boolean; sub: string }[];
  history: { at: string; who: string; what: string }[];
  catalogue: { countries: { code: string; name: string; enabled: boolean }[]; currencies: { code: string; enabled: boolean }[] };
};
export type MethodPatch = Partial<{ countries: string[]; currencies: { code: string; min: number | null; max: number | null }[]; customerLabel: string; customerHint: string; incidentNote: string | null }>;

export const adminMoneyApi = {
  payouts: (tab: PayoutTab): Promise<PayoutsPage> => api.get<PayoutsPage>(`/api/admin/payouts?tab=${tab}`),
  retry: (id: string): Promise<{ withdrawalId: string; replay: boolean }> => api.post<{ withdrawalId: string; replay: boolean }>(`/api/admin/payouts/${id}/retry`),

  disputes: (tab: DisputeTab): Promise<{ items: DisputeItem[]; counts: Record<DisputeTab, number> }> => api.get<{ items: DisputeItem[]; counts: Record<DisputeTab, number> }>(`/api/admin/disputes?tab=${tab}`),
  dispute: (kind: DisputeKind, id: string): Promise<DisputeDetail> => api.get<DisputeDetail>(`/api/admin/disputes/${kind}/${id}`),
  decide: (kind: DisputeKind, id: string, d: { outcome: 'approve' | 'reject'; note: string; amount?: string }): Promise<DisputeDetail> => api.post<DisputeDetail>(`/api/admin/disputes/${kind}/${id}/decision`, d),

  currencies: (): Promise<{ currencies: Currency[] }> => api.get<{ currencies: Currency[] }>('/api/admin/currencies'),
  saveCurrency: (code: string, patch: CurrencyPatch): Promise<Currency> => api.put<Currency>(`/api/admin/currencies/${code}`, patch),

  methods: (): Promise<{ methods: MethodRow[] }> => api.get<{ methods: MethodRow[] }>('/api/admin/payment-methods'),
  method: (key: string): Promise<MethodDetail> => api.get<MethodDetail>(`/api/admin/payment-methods/${key}`),
  saveMethod: (key: string, patch: MethodPatch): Promise<MethodDetail> => api.put<MethodDetail>(`/api/admin/payment-methods/${key}`, patch),
  setMethodStatus: (key: string, action: 'publish' | 'pause' | 'resume'): Promise<MethodDetail> => api.post<MethodDetail>(`/api/admin/payment-methods/${key}/${action}`),
};
