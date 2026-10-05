// client/src/console/settingsApi.ts — milestone 25.
//
// Every read and write Settings makes, named once, in the same style as api.ts (shapes beside the calls, no component
// composes a URL). Kept in its own file because Settings is five panels over five different server surfaces — the
// settings routes, the config routes, the members routes — and api.ts is already the longest file in the console.

import { api } from '../app/api.ts';
import type { EffectiveConfig } from '../app/core.ts';

// ---------------------------------------------------------------------------
// Settings' own reads and writes (routes/storeSettings.ts)
// ---------------------------------------------------------------------------

export type Zone = {
  id: string;
  name: string;
  feeAmount: string;
  etaMinMinutes: number;
  etaMaxMinutes: number;
  isActive: boolean;
  areas: string[];
};

export type HoursRow = { day: number; opens: string; closes: string };
export type MethodInfo = { key: string; name: string; kind: 'online' | 'offline'; status: string };

export type SettingsExtra = {
  store: { name: string; slug: string; publicPhone: string | null; address: string | null; timeZone: string; acceptingOrders: boolean };
  zones: Zone[];
  hours: HoursRow[];
  catalogue: MethodInfo[];
};

export type SettingsBase = {
  pickup: { address: string; readyMinutes: number; instructions: string | null } | null;
  payout: { methodKey: string; phone: string; settlementMode: 'manual' | 'automatic'; automaticAt: string | null } | null;
  paymentMethods: { key: string; isConnected: boolean; connectedAt: string | null }[];
};

export type ZoneInput = { name: string; fee: string; etaMin: number; etaMax: number; areas: string[] };

const s = (storeId: string): string => `/api/stores/${storeId}/settings`;

export const settingsApi = {
  load: async (storeId: string): Promise<{ base: SettingsBase; extra: SettingsExtra }> => {
    const [base, extra] = await Promise.all([api.get<SettingsBase>(s(storeId)), api.get<SettingsExtra>(`${s(storeId)}/extra`)]);
    return { base, extra };
  },

  saveDetails: (storeId: string, d: { name: string; publicPhone: string | null; address: string | null; timeZone: string }): Promise<SettingsExtra['store']> =>
    api.put<SettingsExtra['store']>(`${s(storeId)}/details`, d),

  saveHours: (storeId: string, days: HoursRow[]): Promise<{ hours: HoursRow[] }> => api.put<{ hours: HoursRow[] }>(`${s(storeId)}/hours`, { days }),

  createZone: (storeId: string, z: ZoneInput): Promise<{ zones: Zone[] }> => api.post<{ zones: Zone[] }>(`${s(storeId)}/zones`, z),
  updateZone: (storeId: string, id: string, z: ZoneInput): Promise<{ zones: Zone[] }> => api.put<{ zones: Zone[] }>(`${s(storeId)}/zones/${id}`, z),
  deleteZone: (storeId: string, id: string): Promise<{ zones: Zone[] }> => api.delete<{ zones: Zone[] }>(`${s(storeId)}/zones/${id}`),

  savePickup: (storeId: string, p: { enabled: false } | { enabled: true; address: string; readyMinutes: number; instructions?: string }): Promise<{ ok: boolean }> =>
    api.put<{ ok: boolean }>(`${s(storeId)}/pickup`, p),

  setMethod: (storeId: string, key: string, connected: boolean): Promise<{ ok: boolean }> =>
    api.put<{ ok: boolean }>(`${s(storeId)}/payments/${encodeURIComponent(key)}`, { connected }),

  /** Needs the signed-in person's password: this is the setting that redirects the store's money. */
  savePayout: (storeId: string, p: { methodKey: string; phone: string; password: string }): Promise<{ payout: SettingsBase['payout'] }> =>
    api.put<{ payout: SettingsBase['payout'] }>(`${s(storeId)}/payout`, p),
};

// ---------------------------------------------------------------------------
// Features and business type (routes/storeConfig.ts)
// ---------------------------------------------------------------------------

export type OfferedTemplate = { key: string; name: string; accentColor?: string; version?: number };

export const configApi = {
  templates: (storeId: string): Promise<{ templates: OfferedTemplate[] }> => api.get<{ templates: OfferedTemplate[] }>(`/api/stores/${storeId}/config/templates`),

  setTemplate: (storeId: string, templateKey: string): Promise<{ changed: boolean; template: { key: string; name: string; version: number } }> =>
    api.put(`/api/stores/${storeId}/config/template`, { templateKey }),

  /** `true`/`false` switches a module for this store; `null` removes the override so the template's own choice applies. */
  setModules: (storeId: string, modules: Record<string, boolean | null>): Promise<{ config: EffectiveConfig }> =>
    api.patch<{ config: EffectiveConfig }>(`/api/stores/${storeId}/config/overrides`, { modules }),
};

// ---------------------------------------------------------------------------
// Staff (routes/members.ts)
// ---------------------------------------------------------------------------

export type Member = {
  user_id: string;
  name: string;
  email: string;
  phone: string | null;
  role: 'owner' | 'admin' | 'manager' | 'rider';
  created_at: string;
  created_by: string | null;
  plate_number: string | null;
  availability: string | null;
};

export type NewStaff = {
  name: string;
  email: string;
  password: string;
  role: 'admin' | 'manager' | 'rider';
  phone?: string;
  plateNumber?: string;
};

export const staffApi = {
  list: (storeId: string): Promise<{ members: Member[] }> => api.get<{ members: Member[] }>(`/api/stores/${storeId}/members`),
  create: (storeId: string, input: NewStaff): Promise<{ created: boolean; member: { userId: string; name: string; email: string; role: string } }> =>
    api.post(`/api/stores/${storeId}/members`, input),
  remove: (storeId: string, userId: string): Promise<{ removed: boolean; role: string | null }> =>
    api.delete<{ removed: boolean; role: string | null }>(`/api/stores/${storeId}/members/${userId}`),
  /** The owner's reset (§5.4): sets a new password for somebody on the staff and ends their other sessions. */
  resetPassword: (storeId: string, userId: string, password: string): Promise<{ ok?: boolean }> =>
    api.post<{ ok?: boolean }>(`/api/stores/${storeId}/members/${userId}/password`, { password }),
};
