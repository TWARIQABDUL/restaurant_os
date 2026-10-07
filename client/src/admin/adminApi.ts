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
