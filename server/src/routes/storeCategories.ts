// server/src/routes/storeCategories.ts — milestone 22.
//
//   GET    /api/stores/:storeId/categories              every section, in the merchant's order, with its counts
//   POST   /api/stores/:storeId/categories              add one
//   PATCH  /api/stores/:storeId/categories/:categoryId  rename, or show/hide
//   PUT    /api/stores/:storeId/categories/order        the complete new order
//   DELETE /api/stores/:storeId/categories/:categoryId  remove the section; its products stay
//
// The URL says "categories" and the screen says whatever the store's template calls them. The route is the
// platform's word (V003's table name); the config engine owns the vocabulary, and a route that localised
// itself would be a second place for it.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { bodyOf, requiredString } from '../api/validate.ts';
import { badRequest, notFound, withTransaction } from '../db/index.ts';
import * as categories from '../repositories/categories.ts';

const router = Router({ mergeParams: true });

function categoryIdOf(raw: unknown): string {
  if (!isUuid(raw)) throw badRequest('That is not a section.', 'INVALID_CATEGORY');
  return raw;
}

router.get(
  '/',
  requireStorePermission('products.write'),
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ categories: await categories.list(storeIdOf(req)) });
  }),
);

router.post(
  '/',
  requireStorePermission('products.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const name = requiredString(bodyOf(req.body), 'name');
    await withTransaction((tx) => categories.create(storeId, name, tx));
    res.status(201).json({ categories: await categories.list(storeId) });
  }),
);

// Declared BEFORE '/:categoryId' so "order" is not read as an id.
router.put(
  '/order',
  requireStorePermission('products.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const raw = bodyOf(req.body)['ids'];
    if (!Array.isArray(raw) || !raw.every(isUuid)) throw badRequest('ids must be the list of sections, in order.', 'INVALID');
    await withTransaction((tx) => categories.reorder(storeId, raw as string[], tx));
    res.json({ categories: await categories.list(storeId) });
  }),
);

router.patch(
  '/:categoryId',
  requireStorePermission('products.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const id = categoryIdOf(req.params['categoryId']);
    const body = bodyOf(req.body);
    const patch: { name?: string; isVisible?: boolean } = {};
    if (body['name'] !== undefined) patch.name = requiredString(body, 'name');
    if (body['isVisible'] !== undefined) {
      if (typeof body['isVisible'] !== 'boolean') throw badRequest('isVisible must be true or false.', 'INVALID');
      patch.isVisible = body['isVisible'];
    }
    const found = await withTransaction((tx) => categories.update(storeId, id, patch, tx));
    if (!found) throw notFound('That section does not exist.', 'CATEGORY_NOT_FOUND');
    res.json({ categories: await categories.list(storeId) });
  }),
);

router.delete(
  '/:categoryId',
  requireStorePermission('products.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const result = await withTransaction((tx) => categories.remove(storeId, categoryIdOf(req.params['categoryId']), tx));
    res.json({ ...result, categories: await categories.list(storeId) });
  }),
);

export default router;
