// server/src/routes/storeKyc.ts — milestone 26: the merchant's identity check.
//
//   GET  /api/stores/:storeId/kyc                    where the check stands (KYCOutcomes' four screens) + whether verified
//   POST /api/stores/:storeId/kyc/documents/:part    one part's raw bytes — id_front | id_back | face_video
//   POST /api/stores/:storeId/kyc/submit             everything is there: send it to the reviewer
//
// WHO: `settings.write`, which is the owner and admins. It is the same permission as the payout number, because it
// guards the same thing — whether this store's money can leave — and a manager's own message says as much ("can't see
// payouts, the wallet or store settings").
//
// NOTHING HERE RETURNS A DOCUMENT. A merchant uploads and is told the state; nobody reads a file back through the
// merchant's API, so a stolen session cannot be used to download somebody's ID. Viewing is the reviewer's (M27), through
// a route of its own that writes an audit entry.
//
// RAW BYTES, as storeUploads.ts does and for the same reasons. WHAT A FILE IS is decided by its first bytes, not by the
// header the client declared.

import express, { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { AppError, badRequest } from '../db/index.ts';
import { requireStorePermission, storeIdOf, authOf } from '../middleware/authorize.ts';
import * as kyc from '../repositories/kyc.ts';
import { kycEncryptionConfigured } from '../crypto/kyc.ts';
import { sniff } from '../storage/images.ts';

export const storeKycRoutes = Router({ mergeParams: true });

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

/** WebM starts with the EBML magic; MP4 and QuickTime carry `ftyp` at byte 4. Phones record one or the other. */
export function sniffVideo(b: Uint8Array): 'webm' | 'mp4' | null {
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b.length > 12 && String.fromCharCode(b[4]!, b[5]!, b[6]!, b[7]!) === 'ftyp') return 'mp4';
  return null;
}

const isPart = (v: unknown): v is kyc.Part => v === 'id_front' || v === 'id_back' || v === 'face_video';

storeKycRoutes.get(
  '/',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    res.json(await kyc.status(storeIdOf(req)));
  }),
);

storeKycRoutes.post(
  '/documents/:part',
  requireStorePermission('settings.write'),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'video/webm', 'video/mp4', 'video/quicktime'], limit: MAX_VIDEO_BYTES }),
  asyncHandler(async (req, res) => {
    const part = req.params['part'];
    if (!isPart(part)) throw badRequest('That is not part of the check.', 'INVALID_PART');
    if (!kycEncryptionConfigured()) {
      // Refuse, rather than store an identity document unsealed. The message is for whoever runs the server.
      throw new AppError({ status: 503, code: 'KYC_NOT_CONFIGURED', message: 'Identity checks are not set up on this server yet.' });
    }

    const type = req.query['type'] === 'passport' ? 'passport' : 'national_id';
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError({ status: 415, code: 'UNSUPPORTED_FILE', message: 'Send a photo or a video.' });

    let contentType: string;
    if (part === 'face_video') {
      const kind = sniffVideo(body);
      if (kind === null) throw new AppError({ status: 415, code: 'UNSUPPORTED_FILE', message: 'That is not a video we can read. Record it again.' });
      if (body.length > MAX_VIDEO_BYTES) throw new AppError({ status: 413, code: 'TOO_LARGE', message: 'That video is too large. Record it again.' });
      contentType = kind === 'webm' ? 'video/webm' : 'video/mp4';
    } else {
      const kind = sniff(body);
      if (kind === null) throw new AppError({ status: 415, code: 'UNSUPPORTED_FILE', message: 'Upload a JPEG, PNG or WebP photo.' });
      if (body.length > MAX_PHOTO_BYTES) throw new AppError({ status: 413, code: 'TOO_LARGE', message: 'That photo is too large. Take it again.' });
      contentType = kind === 'jpg' ? 'image/jpeg' : kind === 'png' ? 'image/png' : 'image/webp';
    }

    const result = await kyc.attach(storeIdOf(req), authOf(req).context.userId, { part, documentType: type, bytes: body, contentType });
    res.status(201).json(result);
  }),
);

storeKycRoutes.post(
  '/submit',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    res.json(await kyc.submit(storeIdOf(req)));
  }),
);
