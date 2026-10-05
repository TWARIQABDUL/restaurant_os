// client/src/onboarding/api.ts — milestone 26. The three calls "Create your store" makes before there is a session.

import { api } from '../app/api.ts';

export type Industry = { key: string; name: string; accentColor?: string };

export const onboardingApi = {
  templates: (): Promise<{ templates: Industry[] }> => api.get<{ templates: Industry[] }>('/api/onboarding/templates'),

  /** The address a business name would get, and whether it is free. Empty when the name has nothing usable in it. */
  slug: (name: string): Promise<{ slug: string; available: boolean }> => api.get<{ slug: string; available: boolean }>(`/api/onboarding/slug?name=${encodeURIComponent(name)}`),

  /** Account and store in one transaction; the response sets the session cookie, so the next calls are the owner's. */
  create: (input: { name: string; email: string; phone?: string; password: string; businessName: string; slug: string; templateKey: string | null }): Promise<{ storeId: string; slug: string; userId: string }> =>
    api.post<{ storeId: string; slug: string; userId: string }>('/api/onboarding', input),
};
