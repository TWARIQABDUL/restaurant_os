// server/src/routes/adminMoney.ts — milestone 27, part B: the platform team's money and configuration endpoints. Mounted at /api/admin
// beside routes/admin.ts, and held to the same rule: every route names a PLATFORM permission and none is reachable by a store role.
//
//   GET  /payouts?tab=                          payouts.process
//   POST /payouts/:id/retry                     payouts.process
//   GET  /disputes?tab=  ·  /disputes/:kind/:id        refunds.approve or disputes.resolve
//   POST /disputes/:kind/:id/decision           refunds.approve (a refund request) · disputes.resolve (an escalation)
//   GET  /currencies  ·  PUT /currencies/:code  currencies.manage
//   GET  /payment-methods[/:key]  ·  PUT /payment-methods/:key  ·  POST /payment-methods/:key/publish|pause|resume   payment_methods.manage
//
// A DECISION'S PERMISSION DEPENDS ON WHAT IS BEING DECIDED. A refund request and an escalated dispute reach the same money by different
// doors (adminDisputes.ts), and AdminTeam draws roles that hold one without the other — a finance role approves refunds, a support
// role resolves disputes — so the guard is chosen by the `:kind` in the path rather than collapsed into one "decide" permission.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, optionalString, requiredOneOf } from '../api/validate.ts';
import { badRequest, forbidden } from '../db/index.ts';
import { authOf, isUuid, requirePlatformPermission, requireSession } from '../middleware/authorize.ts';
import * as config from '../repositories/adminConfig.ts';
import * as disputes from '../repositories/adminDisputes.ts';
import * as payouts from '../repositories/adminPayouts.ts';

const router = Router();

const actorOf = (req: Request): { id: string; ip: string | null; userAgent: string | null } => ({ id: authOf(req).context.userId, ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 300) ?? null });

function uuidParam(req: Request, name: string): string {
  const v = req.params[name];
  if (!isUuid(v)) throw badRequest('That is not a valid id.', 'INVALID_ID');
  return v;
}

/** Any one of these. requireSession authenticates; this decides. */
const requireAny = (...permissions: string[]): RequestHandler[] => [
  requireSession,
  (req: Request, _res: Response, next: NextFunction): void => {
    const held = authOf(req).context.permissions;
    next(permissions.some((p) => held.includes(p)) ? undefined : forbidden('You do not have access to do that.'));
  },
];

const refundsGuard = requirePlatformPermission('refunds.approve');
const disputesGuard = requirePlatformPermission('disputes.resolve');
const byKind: RequestHandler = (req, res, next) => (req.params['kind'] === 'dispute' ? disputesGuard : refundsGuard)(req, res, next);

// ---- payouts --------------------------------------------------------------

router.get(
  '/payouts',
  requirePlatformPermission('payouts.process'),
  asyncHandler(async (req, res) => {
    const tab = payouts.PAYOUT_TABS.includes(req.query['tab'] as payouts.PayoutTab) ? (req.query['tab'] as payouts.PayoutTab) : 'problem';
    res.json(await payouts.page(tab));
  }),
);

router.post(
  '/payouts/:id/retry',
  requirePlatformPermission('payouts.process'),
  asyncHandler(async (req, res) => {
    const r = await payouts.retry(uuidParam(req, 'id'), authOf(req).context.userId, { ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 300) ?? null });
    res.status(r.replay ? 200 : 201).json(r);
  }),
);

// ---- refunds & disputes ---------------------------------------------------

router.get(
  '/disputes',
  ...requireAny('refunds.approve', 'disputes.resolve'),
  asyncHandler(async (req, res) => {
    const tab = disputes.DISPUTE_TABS.includes(req.query['tab'] as disputes.DisputeTab) ? (req.query['tab'] as disputes.DisputeTab) : 'refunds';
    res.json(await disputes.queue(tab));
  }),
);

function kindOf(req: Request): disputes.Kind {
  const k = req.params['kind'];
  if (k !== 'refund' && k !== 'dispute') throw badRequest('That is not a refund or a dispute.', 'INVALID_KIND');
  return k;
}

router.get(
  '/disputes/:kind/:id',
  byKind,
  asyncHandler(async (req, res) => {
    const found = await disputes.detail(kindOf(req), uuidParam(req, 'id'));
    if (found === null) {
      res.status(404).json({ error: 'That item does not exist.', code: 'NO_SUCH_ITEM' });
      return;
    }
    res.json(found);
  }),
);

router.post(
  '/disputes/:kind/:id/decision',
  byKind,
  asyncHandler(async (req, res) => {
    const body = bodyOf(req.body);
    const outcome = requiredOneOf(body, 'outcome', ['approve', 'reject'] as const);
    const amountRaw = body['amount'];
    const amount = typeof amountRaw === 'number' ? String(amountRaw) : optionalString(body, 'amount', { max: 14 });
    res.json(await disputes.decide(kindOf(req), uuidParam(req, 'id'), authOf(req).context.userId, { outcome, note: optionalString(body, 'note', { max: 500 }) ?? '', amount }));
  }),
);

// ---- currencies -----------------------------------------------------------

router.get(
  '/currencies',
  requirePlatformPermission('currencies.manage'),
  asyncHandler(async (_req, res) => {
    res.json({ currencies: await config.currencies() });
  }),
);

router.put(
  '/currencies/:code',
  requirePlatformPermission('currencies.manage'),
  asyncHandler(async (req, res) => {
    const code = String(req.params['code']);
    if (!/^[A-Z]{3}$/.test(code)) throw badRequest('That is not a currency code.', 'INVALID_CODE');
    const b = bodyOf(req.body);
    const patch: config.CurrencyPatch = {};
    if (typeof b['symbol'] === 'string') patch.symbol = b['symbol'];
    if (typeof b['position'] === 'string') patch.position = b['position'];
    if (typeof b['decimals'] === 'number') patch.decimals = b['decimals'];
    if (typeof b['separator'] === 'string') patch.separator = b['separator'];
    if (typeof b['rounding'] === 'number') patch.rounding = b['rounding'];
    if (typeof b['enabled'] === 'boolean') patch.enabled = b['enabled'];
    if (typeof b['rateSource'] === 'string') patch.rateSource = b['rateSource'];
    if (b['usdRate'] === null || typeof b['usdRate'] === 'number') patch.usdRate = b['usdRate'] as number | null;
    res.json(await config.updateCurrency(code, patch, actorOf(req)));
  }),
);

// ---- payment methods ------------------------------------------------------

router.get(
  '/payment-methods',
  requirePlatformPermission('payment_methods.manage'),
  asyncHandler(async (_req, res) => {
    res.json({ methods: await config.methods() });
  }),
);

const keyOf = (req: Request): string => {
  const k = String(req.params['key']);
  if (!/^[a-z][a-z0-9_]*$/.test(k)) throw badRequest('That is not a payment method.', 'INVALID_KEY');
  return k;
};

router.get(
  '/payment-methods/:key',
  requirePlatformPermission('payment_methods.manage'),
  asyncHandler(async (req, res) => {
    const found = await config.method(keyOf(req));
    if (found === null) {
      res.status(404).json({ error: 'That payment method does not exist.', code: 'NO_SUCH_METHOD' });
      return;
    }
    res.json(found);
  }),
);

router.put(
  '/payment-methods/:key',
  requirePlatformPermission('payment_methods.manage'),
  asyncHandler(async (req, res) => {
    const b = bodyOf(req.body);
    const patch: config.MethodPatch = {};
    if (Array.isArray(b['countries'])) patch.countries = (b['countries'] as unknown[]).filter((c): c is string => typeof c === 'string' && /^[A-Z]{2}$/.test(c));
    if (Array.isArray(b['currencies'])) {
      patch.currencies = (b['currencies'] as unknown[]).map((c) => {
        const o = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
        const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
        if (typeof o['code'] !== 'string' || !/^[A-Z]{3}$/.test(o['code'])) throw badRequest('That is not a currency.', 'INVALID_CODE');
        const min = n(o['min']);
        const max = n(o['max']);
        if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) throw badRequest('A limit is a number.', 'INVALID_LIMITS');
        return { code: o['code'], min, max };
      });
    }
    if (typeof b['customerLabel'] === 'string') patch.customerLabel = b['customerLabel'];
    if (typeof b['customerHint'] === 'string') patch.customerHint = b['customerHint'];
    if (b['incidentNote'] === null || typeof b['incidentNote'] === 'string') patch.incidentNote = b['incidentNote'] as string | null;
    res.json(await config.updateMethod(keyOf(req), patch, actorOf(req)));
  }),
);

for (const [path, to] of [['publish', 'live'], ['resume', 'live'], ['pause', 'paused']] as const) {
  router.post(
    `/payment-methods/:key/${path}`,
    requirePlatformPermission('payment_methods.manage'),
    asyncHandler(async (req, res) => {
      res.json(await config.setStatus(keyOf(req), to, actorOf(req)));
    }),
  );
}

export default router;
