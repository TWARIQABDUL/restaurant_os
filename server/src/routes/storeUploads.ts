// server/src/routes/storeUploads.ts — milestone 22.
//
//   POST /api/stores/:storeId/uploads    the image's raw bytes as the body, Content-Type image/jpeg|png|webp
//   GET  /api/media/:storeId/:name        serves what was stored (public: a storefront <img> carries no session)
//
// RAW BYTES, NOT MULTIPART: no parser dependency, and the size cap is the one `express.raw` enforces before the
// body is buffered whole. The global JSON limit (200 kb) is untouched — this is the one route that mounts its
// own parser, for the one body that is not JSON.
//
// THE CLIENT'S Content-Type SELECTS THE PARSER AND NOTHING ELSE. What the file IS is decided by its first
// bytes (storage/images.ts sniff()), so declaring image/png on an HTML file stores nothing.
//
// SERVED WITH A SANDBOX CSP AND nosniff, belt and braces on a path that serves user-supplied bytes: even if a
// browser were talked into rendering one as a document, it could run nothing.

import express, { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { AppError, badRequest, notFound } from '../db/index.ts';
import { CONTENT_TYPE, MAX_IMAGE_BYTES, imageStore, sniff } from '../storage/images.ts';

export const uploadRouter = Router({ mergeParams: true });

uploadRouter.post(
  '/',
  requireStorePermission('products.write'),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES }),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppError({ status: 415, code: 'UNSUPPORTED_IMAGE', message: 'Upload a JPEG, PNG or WebP photo.' });
    }
    const kind = sniff(body);
    if (kind === null) {
      throw new AppError({ status: 415, code: 'UNSUPPORTED_IMAGE', message: 'That file is not a JPEG, PNG or WebP photo.' });
    }
    const url = await imageStore().put(storeId, body, kind);
    res.status(201).json({ url });
  }),
);

export const mediaRouter = Router();

mediaRouter.get(
  '/:storeId/:name',
  asyncHandler(async (req, res) => {
    const storeId = req.params['storeId'];
    const name = req.params['name'];
    if (!isUuid(storeId) || typeof name !== 'string') throw badRequest('Not an image.', 'INVALID');
    const found = await imageStore().read(storeId, name);
    if (found === null) throw notFound('That image does not exist.', 'IMAGE_NOT_FOUND');
    res.setHeader('Content-Type', CONTENT_TYPE[found.kind]);
    // The name is random and never reused, so the bytes behind it never change.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(found.bytes);
  }),
);
