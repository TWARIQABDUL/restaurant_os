// client/src/console/kycApi.ts — milestone 26. Every call the identity check makes, named once (api.ts's style).

import { api, upload } from '../app/api.ts';

export type Part = 'id_front' | 'id_back' | 'face_video';
export type DocumentType = 'national_id' | 'passport';
export type Outcome = 'none' | 'building' | 'inReview' | 'redoRequested' | 'rejected' | 'approved';
export type PartState = 'missing' | 'received' | 'accepted' | 'retake';

export type KycStatus = {
  outcome: Outcome;
  verified: boolean;
  submission: null | {
    id: string;
    reference: number;
    documentType: DocumentType;
    submittedAt: string;
    decisionNote: string | null;
    parts: { part: Part; state: PartState; purged: boolean }[];
  };
};

const k = (storeId: string): string => `/api/stores/${storeId}/kyc`;

export const kycApi = {
  status: (storeId: string): Promise<KycStatus> => api.get<KycStatus>(k(storeId)),

  /** One part's bytes. The server decides what the file IS from its first bytes, whatever the type says. */
  upload: (storeId: string, part: Part, file: Blob, documentType: DocumentType): Promise<KycStatus> =>
    upload<KycStatus>(`${k(storeId)}/documents/${part}?type=${documentType}`, file),

  submit: (storeId: string): Promise<KycStatus> => api.post<KycStatus>(`${k(storeId)}/submit`),
};
