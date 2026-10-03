// client/src/rider/api.ts — milestone 21.
//
// Every call the rider's own app makes. One rule the console's api.ts (milestone 19) already set:
// the store is always the uuid here, resolved from the URL's slug through GET /api/session — never
// the slug itself, because the guard on every /api/stores/:storeId/rider route reads the membership
// for that id.

import { api } from '../app/api.ts';
import type { CurrencyFormat } from '../app/core.ts';
import type { OrderLine } from '../console/api.ts';

export type RiderJobStatus = 'assigned' | 'out' | 'delivered' | 'returned';

export type RiderJob = {
  id: string;
  orderNumber: number;
  status: RiderJobStatus;
  storeName: string;
  storeAddress: string | null;
  customer: string;
  phone: string | null;
  address: string | null;
  paymentMethod: string;
  cashDue: string | null;
  total: string;
  placedAt: string;
  lines: OrderLine[];
};

export type RiderHome = {
  storeName: string;
  currency: CurrencyFormat;
  me: { name: string; phone: string | null; plateNumber: string };
  availability: 'available' | 'off_duty';
  cashHeld: string;
  jobs: RiderJob[];
};

export type TransitionOutcome = { ok: boolean; status?: string };

export const rider = {
  home: (storeId: string): Promise<RiderHome> => api.get<RiderHome>(`/api/stores/${storeId}/rider`),

  setAvailability: (storeId: string, available: boolean): Promise<{ availability: 'available' | 'off_duty' }> =>
    api.put<{ availability: 'available' | 'off_duty' }>(`/api/stores/${storeId}/rider/availability`, { available }),

  pickedUp: (storeId: string, orderId: string): Promise<TransitionOutcome> =>
    api.post<TransitionOutcome>(`/api/stores/${storeId}/rider/orders/${orderId}/picked-up`),

  delivered: (storeId: string, orderId: string): Promise<TransitionOutcome> =>
    api.post<TransitionOutcome>(`/api/stores/${storeId}/rider/orders/${orderId}/delivered`),

  confirmCash: (storeId: string, orderId: string, reportedAmount: string): Promise<TransitionOutcome> =>
    api.post<TransitionOutcome>(`/api/stores/${storeId}/rider/orders/${orderId}/confirm-cash`, { reportedAmount }),

  returned: (storeId: string, orderId: string, reason: string): Promise<TransitionOutcome> =>
    api.post<TransitionOutcome>(`/api/stores/${storeId}/rider/orders/${orderId}/returned`, { reason }),
};
