// server/src/routes/storeCustomers.ts — milestone 24.
//
//   GET /api/stores/:storeId/customers?segment=all|regular|account|guest&q=&page=    the list, with segment counts
//   GET /api/stores/:storeId/customers/export                                          every customer, as CSV
//   GET /api/stores/:storeId/customers/:key                                            one, with recent orders and the note
//   PUT /api/stores/:storeId/customers/:key/note                                       { note } — staff only; empty removes it
//
// THE KEY IS THE PERSON'S NINE-DIGIT PHONE IDENTITY (V026's customer_key) or `u:<user id>` for an account with no
// number. It is validated by shape before it reaches a query: it is typed into a URL, and it is the only thing between
// "this store's customer" and a lookup.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { authOf, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { bodyOf, optionalPositiveInt } from '../api/validate.ts';
import { badRequest, notFound, withTransaction } from '../db/index.ts';
import * as customers from '../repositories/merchantCustomers.ts';
import type { Segment } from '../repositories/merchantCustomers.ts';

const router = Router({ mergeParams: true });

const KEY = /^(\d{7,9}|u:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function keyOf(raw: unknown): string {
  if (typeof raw !== 'string' || !KEY.test(raw)) throw badRequest('That is not a customer.', 'INVALID_CUSTOMER');
  return raw;
}

router.get(
  '/',
  requireStorePermission('customers.read'),
  asyncHandler(async (req, res) => {
    const segment = (['all', 'regular', 'account', 'guest'] as const).find((s) => s === req.query['segment']) ?? 'all';
    const q = typeof req.query['q'] === 'string' ? req.query['q'].slice(0, 80) : '';
    const page = optionalPositiveInt(req.query['page'], 'page') ?? 1;
    res.setHeader('Cache-Control', 'no-store');
    res.json(await customers.list(storeIdOf(req), segment as Segment, q, page));
  }),
);

// Declared BEFORE '/:key' so "export" is not read as a customer.
router.get(
  '/export',
  requireStorePermission('customers.read'),
  asyncHandler(async (req, res) => {
    const rows = await customers.exportRows(storeIdOf(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="customers.csv"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(customers.toCsv(rows));
  }),
);

router.get(
  '/:key',
  requireStorePermission('customers.read'),
  asyncHandler(async (req, res) => {
    const found = await customers.get(storeIdOf(req), keyOf(req.params['key']));
    if (found === null) throw notFound('That customer has not ordered here.', 'CUSTOMER_NOT_FOUND');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ customer: found });
  }),
);

router.put(
  '/:key/note',
  requireStorePermission('customers.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const key = keyOf(req.params['key']);
    const raw = bodyOf(req.body)['note'];
    if (typeof raw !== 'string') throw badRequest('note is required.', 'MISSING_FIELD');
    if (raw.length > 500) throw badRequest('Keep the note under 500 characters.', 'TOO_LONG');
    const ok = await withTransaction((tx) => customers.setNote(storeId, key, raw, authOf(req).context.userId, tx));
    if (!ok) throw notFound('That customer has not ordered here.', 'CUSTOMER_NOT_FOUND');
    res.json({ note: raw.trim() === '' ? null : raw.trim() });
  }),
);

export default router;
