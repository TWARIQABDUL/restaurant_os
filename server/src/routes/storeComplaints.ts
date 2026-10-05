// server/src/routes/storeComplaints.ts — milestone 24.
//
//   GET  /api/stores/:storeId/complaints?tab=open|escalated|closed    the list and the three tab counts
//   GET  /api/stores/:storeId/complaints/:id                          one thread, with its order and evidence
//   POST /api/stores/:storeId/complaints/:id/resolve    { note, refundAmount? }  — a refund is a REQUEST to Vendlyfy
//   POST /api/stores/:storeId/complaints/:id/reject     { note }
//   POST /api/stores/:storeId/complaints/:id/escalate   { note }
//   POST /api/stores/:storeId/complaints/:id/reopen
//
// A MOVE ON A COMPLAINT THAT HAS ALREADY MOVED IS A 409 NAMING WHERE IT IS NOW, not a 500 and not a silent no-op: two
// managers on one complaint is ordinary, and the second needs to be told.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { authOf, isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { bodyOf, requiredString } from '../api/validate.ts';
import { badRequest, notFound, withTransaction } from '../db/index.ts';
import * as complaints from '../repositories/merchantComplaints.ts';
import type { ComplaintTab } from '../repositories/merchantComplaints.ts';

const router = Router({ mergeParams: true });

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

function complaintIdOf(raw: unknown): string {
  if (!isUuid(raw)) throw badRequest('That is not a complaint.', 'INVALID_COMPLAINT');
  return raw;
}

router.get(
  '/',
  requireStorePermission('support.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const tab = (['open', 'escalated', 'closed'] as const).find((t) => t === req.query['tab']) ?? 'open';
    const [counts, items] = await Promise.all([complaints.counts(storeId), complaints.list(storeId, tab as ComplaintTab)]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ counts, complaints: items });
  }),
);

router.get(
  '/:complaintId',
  requireStorePermission('support.write'),
  asyncHandler(async (req, res) => {
    const found = await complaints.get(storeIdOf(req), complaintIdOf(req.params['complaintId']));
    if (found === null) throw notFound('That complaint does not exist.', 'COMPLAINT_NOT_FOUND');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ complaint: found });
  }),
);

router.post(
  '/:complaintId/resolve',
  requireStorePermission('support.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const id = complaintIdOf(req.params['complaintId']);
    const body = bodyOf(req.body);
    const note = requiredString(body, 'note', { max: 1000 });

    let refund: { amount: string; reason: string } | null = null;
    const raw = body['refundAmount'];
    if (raw !== undefined && raw !== null && raw !== '') {
      const amount = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
      if (!MONEY.test(amount) || Number(amount) <= 0) throw badRequest('Enter the refund as an amount above zero.', 'INVALID_AMOUNT');
      // The complaint's own reason becomes the refund's, which is what resolve_complaint() does when none is given.
      refund = { amount, reason: '' };
    }

    await withTransaction((tx) =>
      complaints.resolve(storeId, id, authOf(req).context.userId, note, refund === null ? null : { amount: refund.amount, reason: refund.reason }, tx),
    );
    res.json({ complaint: await complaints.get(storeId, id) });
  }),
);

router.post(
  '/:complaintId/reject',
  requireStorePermission('support.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const id = complaintIdOf(req.params['complaintId']);
    const note = requiredString(bodyOf(req.body), 'note', { max: 1000 });
    await withTransaction((tx) => complaints.reject(storeId, id, authOf(req).context.userId, note, tx));
    res.json({ complaint: await complaints.get(storeId, id) });
  }),
);

router.post(
  '/:complaintId/escalate',
  requireStorePermission('support.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const id = complaintIdOf(req.params['complaintId']);
    const note = requiredString(bodyOf(req.body), 'note', { max: 1000 });
    await withTransaction((tx) => complaints.escalate(storeId, id, authOf(req).context.userId, note, tx));
    res.json({ complaint: await complaints.get(storeId, id) });
  }),
);

router.post(
  '/:complaintId/reopen',
  requireStorePermission('support.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const id = complaintIdOf(req.params['complaintId']);
    await withTransaction((tx) => complaints.reopen(storeId, id, authOf(req).context.userId, tx));
    res.json({ complaint: await complaints.get(storeId, id) });
  }),
);

export default router;
