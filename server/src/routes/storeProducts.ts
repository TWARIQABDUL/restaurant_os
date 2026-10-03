// server/src/routes/storeProducts.ts — milestone 22.
//
//   GET    /api/stores/:storeId/products              the Products list: a page, the tab counts
//   GET    /api/stores/:storeId/products/:productId   one product, as AddProduct reads it
//   POST   /api/stores/:storeId/products              create
//   PUT    /api/stores/:storeId/products/:productId   replace — the editor always sends the whole product
//   POST   /api/stores/:storeId/products/bulk         the bulk bar: activate · draft · category · delete
//
// PUT REPLACES, NOT PATCHES. The editor holds the whole product and "Save product" saves what is on screen;
// a partial update would need a rule for what an absent `groups` means (keep them? remove them?) and every
// answer is a bug for somebody. The repository diffs against what exists, so replacing is also what keeps
// existing option values, variants and their order history attached.
//
// ONE PERMISSION, products.write, for reads too. V001 has no products.read and none is needed: every role that
// can see the catalogue's admin can change it, and a permission nobody lacks is a row to keep in step.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { bodyOf, optionalPositiveInt, optionalString, requiredOneOf, requiredString } from '../api/validate.ts';
import type { Body } from '../api/validate.ts';
import { badRequest, notFound, withTransaction } from '../db/index.ts';
import * as products from '../repositories/products.ts';
import type { BulkAction, GroupInput, ListSort, ListTab, ProductInput } from '../repositories/products.ts';
import { MEDIA_PATH } from '../storage/images.ts';

const router = Router({ mergeParams: true });

const TABS = ['all', 'active', 'draft', 'low', 'out'] as const satisfies readonly ListTab[];
const SORTS = ['best', 'newest', 'price', 'stock'] as const satisfies readonly ListSort[];

function productIdOf(raw: unknown): string {
  if (!isUuid(raw)) throw badRequest('That is not a product.', 'INVALID_PRODUCT');
  return raw;
}

function asArray(body: Body, field: string): unknown[] {
  const raw = body[field];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest(`${field} must be a list.`, 'INVALID');
  return raw;
}

function asObject(raw: unknown, what: string): Body {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw badRequest(`${what} is malformed.`, 'INVALID');
  return raw as Body;
}

function money(raw: unknown, field: string): string {
  // The client sends strings; a number is accepted and stringified rather than rejected, because JSON makes
  // that distinction easy to lose. Never parsed to a float here — the repository checks the shape.
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string') return raw.trim();
  throw badRequest(`${field} is required.`, 'MISSING_FIELD');
}

function count(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw badRequest(`${field} has to be a whole number.`, 'INVALID_STOCK');
  return n;
}

function parseInput(body: Body): ProductInput {
  const status = requiredOneOf(body, 'status', ['active', 'draft'] as const);

  const images = asArray(body, 'images').map((u) => {
    // Only paths this server issued: a client cannot make a product's cover an arbitrary third-party URL
    // (a tracking pixel) by naming one.
    if (typeof u !== 'string' || !u.startsWith(`${MEDIA_PATH}/`)) throw badRequest('A photo was not uploaded here. Add it again.', 'INVALID_PHOTO');
    return u;
  });

  const groups: GroupInput[] = asArray(body, 'groups').map((raw) => {
    const g = asObject(raw, 'An option');
    if (g['shared'] === true) {
      if (!isUuid(g['id'])) throw badRequest('A shared option is malformed.', 'INVALID');
      return { shared: true, id: g['id'] };
    }
    const mode = requiredOneOf(g, 'mode', ['one', 'several'] as const);
    const id = g['id'] === undefined || g['id'] === null ? null : isUuid(g['id']) ? g['id'] : (() => { throw badRequest('An option id is malformed.', 'INVALID'); })();
    const values = asArray(g, 'values').map((vraw) => {
      const v = asObject(vraw, 'A value');
      return {
        key: requiredString(v, 'key', { max: 80 }),
        label: requiredString(v, 'label', { max: 60 }),
        priceDelta: v['priceDelta'] === undefined || v['priceDelta'] === '' ? '0' : money(v['priceDelta'], 'priceDelta'),
      };
    });
    return { shared: false, id, name: requiredString(g, 'name', { max: 60 }), mode, values };
  });

  const variants = asArray(body, 'variants').map((raw) => {
    const v = asObject(raw, 'A variant');
    return {
      combo: asArray(v, 'combo').map((k) => {
        if (typeof k !== 'string') throw badRequest('A variant is malformed.', 'INVALID');
        return k;
      }),
      sku: optionalString(v, 'sku', { max: 64 }),
      stock: count(v['stock'], 'stock'),
      available: v['available'] === false ? false : true,
    };
  });

  const categoryIds = asArray(body, 'categoryIds').map((c) => {
    if (!isUuid(c)) throw badRequest('A section is malformed.', 'INVALID');
    return c;
  });

  return {
    name: requiredString(body, 'name', { max: 120 }),
    description: typeof body['description'] === 'string' ? body['description'].trim().slice(0, 2000) : '',
    price: money(body['price'], 'price'),
    compareAtPrice: body['compareAtPrice'] === undefined || body['compareAtPrice'] === null || body['compareAtPrice'] === '' ? null : money(body['compareAtPrice'], 'compareAtPrice'),
    status,
    categoryIds,
    images,
    trackStock: body['trackStock'] === true,
    sku: optionalString(body, 'sku', { max: 64 }),
    stock: count(body['stock'], 'stock'),
    groups,
    variants,
  };
}

router.get(
  '/',
  requireStorePermission('products.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const tab = (TABS as readonly string[]).includes(String(req.query['tab'])) ? (req.query['tab'] as ListTab) : 'all';
    const sort = (SORTS as readonly string[]).includes(String(req.query['sort'])) ? (req.query['sort'] as ListSort) : 'newest';
    const cat = req.query['category'];
    const q = typeof req.query['q'] === 'string' ? req.query['q'].trim().slice(0, 80) : '';
    const result = await products.list(storeId, {
      tab,
      q,
      sort,
      categoryId: isUuid(cat) ? cat : null,
      page: optionalPositiveInt(req.query['page'], 'page') ?? 1,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  }),
);

router.post(
  '/bulk',
  requireStorePermission('products.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const body = bodyOf(req.body);
    const ids = asArray(body, 'ids').filter(isUuid);
    if (ids.length === 0) throw badRequest('Select at least one product.', 'NOTHING_SELECTED');
    if (ids.length > 200) throw badRequest('Select up to 200 products at a time.', 'TOO_MANY');

    const kind = requiredOneOf(body, 'action', ['activate', 'draft', 'category', 'delete'] as const);
    let action: BulkAction;
    if (kind === 'category') {
      const categoryId = body['categoryId'];
      if (!isUuid(categoryId)) throw badRequest('Choose a section.', 'INVALID');
      action = { kind, categoryId };
    } else {
      action = { kind };
    }

    const result = await withTransaction((tx) => products.bulk(storeId, ids, action, tx));
    res.json(result);
  }),
);

router.get(
  '/:productId',
  requireStorePermission('products.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const product = await products.get(storeId, productIdOf(req.params['productId']));
    if (product === null) throw notFound('That product does not exist.', 'PRODUCT_NOT_FOUND');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ product });
  }),
);

router.post(
  '/',
  requireStorePermission('products.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const input = parseInput(bodyOf(req.body));
    const product = await withTransaction((tx) => products.save(storeId, null, input, tx));
    res.status(201).json({ product });
  }),
);

router.put(
  '/:productId',
  requireStorePermission('products.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const id = productIdOf(req.params['productId']);
    const input = parseInput(bodyOf(req.body));
    const product = await withTransaction((tx) => products.save(storeId, id, input, tx));
    res.json({ product });
  }),
);

export default router;
