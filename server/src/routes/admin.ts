// server/src/routes/admin.ts — milestone 27: the platform team's API. Mounted at /api/admin.
//
// EVERY ROUTE NAMES ITS PLATFORM PERMISSION, and none of them names a store in the path's guard: a store comes from
// `:storeId` as DATA the platform is acting on, never as a membership the caller must hold. That is the whole difference
// between this file and every other router — and the reason there are escalation tests for it (test/api/admin.test.ts): a
// merchant, however senior, holds no platform permission, and a platform admin is not thereby a member of any store.
//
//   GET  /me                                  who this is, and what the platform lets them do
//   GET  /overview?range=                     merchants.read
//   GET  /merchants  ·  /merchants/:storeId   merchants.read
//   POST /merchants/:storeId/suspend|reinstate   stores.suspend
//   GET  /kyc  ·  /kyc/:id                    kyc.review
//   GET  /kyc/:id/documents/:part             kyc.review — AUDITED, never cached
//   PUT  /kyc/:id/details · /kyc/:id/checks/:code    kyc.review
//   POST /kyc/:id/reveal · /kyc/:id/decision  kyc.review — the reveal needs a reason on the record

import type { Request } from 'express';
import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, optionalString, requiredOneOf, requiredString } from '../api/validate.ts';
import { badRequest, conflict, notFound, withTransaction } from '../db/index.ts';
import { authOf, isUuid, requirePlatformPermission } from '../middleware/authorize.ts';
import * as admin from '../repositories/admin.ts';
import * as review from '../repositories/kycReview.ts';

const router = Router();

const ctxOf = (req: Request): review.Ctx => ({ ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 300) ?? null, verifiedAt: null });

function uuidParam(req: Request, name: string): string {
  const v = req.params[name];
  if (!isUuid(v)) throw badRequest('That is not a valid id.', 'INVALID_ID');
  return v;
}

router.get(
  '/me',
  requirePlatformPermission('merchants.read'),
  asyncHandler(async (req, res) => {
    const { context } = authOf(req);
    res.json({ id: context.userId, name: context.name, email: context.email, role: context.platformRole, permissions: context.permissions });
  }),
);

router.get(
  '/overview',
  requirePlatformPermission('merchants.read'),
  asyncHandler(async (req, res) => {
    const range = admin.RANGES.includes(req.query['range'] as admin.Range) ? (req.query['range'] as admin.Range) : 'today';
    res.json(await admin.overview(range));
  }),
);

router.get(
  '/merchants',
  requirePlatformPermission('merchants.read'),
  asyncHandler(async (req, res) => {
    const tab = admin.MERCHANT_TABS.includes(req.query['tab'] as admin.MerchantTab) ? (req.query['tab'] as admin.MerchantTab) : 'pending';
    const str = (k: string): string => (typeof req.query[k] === 'string' ? (req.query[k] as string).trim().slice(0, 80) : '');
    res.json(await admin.listMerchants({ tab, search: str('q'), industry: str('industry') || null, plan: str('plan') || null, limit: 50 }));
  }),
);

router.get(
  '/merchants/:storeId',
  requirePlatformPermission('merchants.read'),
  asyncHandler(async (req, res) => {
    const found = await admin.merchantDetail(uuidParam(req, 'storeId'));
    if (found === null) throw notFound('That store does not exist.', 'NO_SUCH_STORE');
    res.json(found);
  }),
);

router.post(
  '/merchants/:storeId/suspend',
  requirePlatformPermission('stores.suspend'),
  asyncHandler(async (req, res) => {
    const body = bodyOf(req.body);
    const reason = requiredOneOf(body, 'reason', Object.keys(admin.SUSPEND_REASONS) as [string, ...string[]]);
    const note = optionalString(body, 'note', { max: 500 });
    const storeId = uuidParam(req, 'storeId');
    await withTransaction((tx) => admin.suspend(storeId, authOf(req).context.userId, reason, note, ctxOf(req), tx), { label: 'POST /admin/merchants/suspend', retries: 0 });
    res.json(await admin.merchantDetail(storeId));
  }),
);

router.post(
  '/merchants/:storeId/reinstate',
  requirePlatformPermission('stores.suspend'),
  asyncHandler(async (req, res) => {
    const storeId = uuidParam(req, 'storeId');
    await withTransaction((tx) => admin.reinstate(storeId, authOf(req).context.userId, ctxOf(req), tx), { label: 'POST /admin/merchants/reinstate', retries: 0 });
    res.json(await admin.merchantDetail(storeId));
  }),
);

router.get(
  '/kyc',
  requirePlatformPermission('kyc.review'),
  asyncHandler(async (_req, res) => {
    res.json({ queue: await review.queue() });
  }),
);

router.get(
  '/kyc/:id',
  requirePlatformPermission('kyc.review'),
  asyncHandler(async (req, res) => {
    const found = await review.caseDetail(uuidParam(req, 'id'));
    if (found === null) throw notFound('No such identity check.', 'NO_SUCH_CASE');
    res.json(found);
  }),
);

router.get(
  '/kyc/:id/documents/:part',
  requirePlatformPermission('kyc.review'),
  asyncHandler(async (req, res) => {
    const part = req.params['part'];
    if (part !== 'id_front' && part !== 'id_back' && part !== 'face_video') throw badRequest('That is not part of the check.', 'INVALID_PART');
    const file = await review.openDocument(uuidParam(req, 'id'), part, authOf(req).context.userId, ctxOf(req));
    res.setHeader('Content-Type', file.contentType);
    // An identity document is never cached by anything between the disk and the reviewer's screen, and cannot run as a page.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(file.bytes);
  }),
);

router.put(
  '/kyc/:id/details',
  requirePlatformPermission('kyc.review'),
  asyncHandler(async (req, res) => {
    const body = bodyOf(req.body);
    const date = (field: string): string | null => {
      const v = optionalString(body, field, { max: 10 });
      if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`${field} is a date like 1994-03-14.`, 'INVALID_DATE');
      return v;
    };
    const idNumber = optionalString(body, 'idNumber', { max: 40 });
    if (idNumber !== null && idNumber.replace(/[\s-]/g, '').length < 6) throw badRequest('That ID number is too short.', 'INVALID_ID_NUMBER');
    const id = uuidParam(req, 'id');
    await withTransaction((tx) => review.recordDetails(id, authOf(req).context.userId, { fullName: optionalString(body, 'fullName', { max: 120 }), dateOfBirth: date('dateOfBirth'), expiresOn: date('expiresOn'), idNumber }, ctxOf(req), tx), { label: 'PUT /admin/kyc/details', retries: 0 });
    res.json(await review.caseDetail(id));
  }),
);

router.put(
  '/kyc/:id/checks/:code',
  requirePlatformPermission('kyc.review'),
  asyncHandler(async (req, res) => {
    const body = bodyOf(req.body);
    const outcome = requiredOneOf(body, 'outcome', ['pass', 'warn', 'fail'] as const);
    const note = optionalString(body, 'note', { max: 200 });
    const id = uuidParam(req, 'id');
    await withTransaction((tx) => review.setCheck(id, String(req.params['code']), outcome, note, tx), { label: 'PUT /admin/kyc/checks', retries: 0 });
    res.json(await review.caseDetail(id));
  }),
);

router.post(
  '/kyc/:id/reveal',
  requirePlatformPermission('kyc.review'),
  asyncHandler(async (req, res) => {
    const reason = requiredString(bodyOf(req.body), 'reason', { min: 3, max: 200 });
    const id = uuidParam(req, 'id');
    const number = await withTransaction((tx) => review.reveal(id, authOf(req).context.userId, reason, ctxOf(req), tx), { label: 'POST /admin/kyc/reveal', retries: 0 });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ idNumber: number });
  }),
);

router.post(
  '/kyc/:id/decision',
  requirePlatformPermission('kyc.review'),
  asyncHandler(async (req, res) => {
    const body = bodyOf(req.body);
    const outcome = requiredOneOf(body, 'outcome', ['approve', 'reject', 'redo'] as const);
    const note = optionalString(body, 'note', { max: 500 });
    const part = optionalString(body, 'part', { max: 10 });
    const id = uuidParam(req, 'id');
    const decided = await withTransaction((tx) => review.decide(id, authOf(req).context.userId, outcome, note, part, tx), { label: 'POST /admin/kyc/decision', retries: 0 });
    if (!decided) throw conflict('Someone else already decided this check.', 'ALREADY_DECIDED');
    res.json(await review.caseDetail(id));
  }),
);

export default router;
