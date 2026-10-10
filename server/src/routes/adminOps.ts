// server/src/routes/adminOps.ts — milestone 27, part C: the last six admin screens. Mounted at /api/admin beside routes/admin.ts and
// routes/adminMoney.ts, held to the same rule — every route names a PLATFORM permission, none is reachable by a store role.
//
//   GET  /audit · POST /audit/verify          audit.read
//   GET  /orders                              merchants.read
//   GET/PUT /settings                         platform_settings.manage
//   GET  /messages                            platform_settings.manage — what is waiting to be sent, and what went
//   GET/POST /team · PUT/DELETE /team/:id     platform_members.create   (only super_admin holds it — a member cannot make a bigger one)
//   GET  /plans · PUT /plans/:key             plans.manage
//   GET  /templates[/:key] · PUT /templates/:key · POST /templates/:key/publish     templates.manage

import type { Request } from 'express';
import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, requiredEmail, requiredOneOf, requiredString } from '../api/validate.ts';
import { badRequest } from '../db/index.ts';
import { authOf, isUuid, requirePlatformPermission } from '../middleware/authorize.ts';
import * as ops from '../repositories/adminOps.ts';
import * as plans from '../repositories/adminPlans.ts';
import * as team from '../repositories/adminTeam.ts';
import * as templates from '../repositories/adminTemplates.ts';
import * as settings from '../repositories/platformSettings.ts';

const router = Router();
const actorOf = (req: Request): { id: string; ip: string | null; userAgent: string | null } => ({ id: authOf(req).context.userId, ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 300) ?? null });

function uuidParam(req: Request, name: string): string {
  const v = req.params[name];
  if (!isUuid(v)) throw badRequest('That is not a valid id.', 'INVALID_ID');
  return v;
}
const slugParam = (req: Request, name: string): string => {
  const v = String(req.params[name]);
  if (!/^[a-z][a-z0-9_]*$/.test(v)) throw badRequest('That is not a valid name.', 'INVALID_KEY');
  return v;
};
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

// ---- audit log ------------------------------------------------------------

router.get(
  '/audit',
  requirePlatformPermission('audit.read'),
  asyncHandler(async (req, res) => {
    const cat = req.query['category'];
    const category = (ops.AUDIT_CATEGORIES as readonly string[]).includes(String(cat)) ? (cat as ops.AuditCategory) : null;
    const before = typeof req.query['before'] === 'string' && /^\d{1,15}$/.test(req.query['before']) ? Number(req.query['before']) : null;
    res.json(await ops.auditPage({ category, before, limit: 50 }));
  }),
);

router.post(
  '/audit/verify',
  requirePlatformPermission('audit.read'),
  asyncHandler(async (_req, res) => {
    res.json(await ops.verifyChain());
  }),
);

// ---- all orders -----------------------------------------------------------

router.get(
  '/orders',
  requirePlatformPermission('merchants.read'),
  asyncHandler(async (req, res) => {
    const filter = ops.ORDER_FILTERS.includes(req.query['filter'] as ops.OrderFilter) ? (req.query['filter'] as ops.OrderFilter) : 'today';
    const search = typeof req.query['q'] === 'string' ? req.query['q'].slice(0, 80) : '';
    let before: { at: string; id: string } | null = null;
    if (typeof req.query['before'] === 'string') {
      const [at, id] = req.query['before'].split('|');
      if (at === undefined || id === undefined || Number.isNaN(Date.parse(at)) || !isUuid(id)) throw badRequest('That is not a place in the list.', 'INVALID_CURSOR');
      before = { at, id };
    }
    res.json(await ops.orders({ filter, search, before, limit: 50 }));
  }),
);

// ---- platform settings ----------------------------------------------------

router.get(
  '/settings',
  requirePlatformPermission('platform_settings.manage'),
  asyncHandler(async (_req, res) => {
    res.json({ settings: await settings.read(), health: await ops.health(), limits: { holdMin: settings.HOLD_MIN, holdMax: settings.HOLD_MAX } });
  }),
);

router.put(
  '/settings',
  requirePlatformPermission('platform_settings.manage'),
  asyncHandler(async (req, res) => {
    const b = bodyOf(req.body);
    const patch: settings.SettingsPatch = {};
    if (typeof b['payoutModeDefault'] === 'string') patch.payoutModeDefault = b['payoutModeDefault'] as 'manual';
    if (b['holdMinutes'] !== undefined) patch.holdMinutes = Number(b['holdMinutes']);
    if (typeof b['automaticPayoutAt'] === 'string') patch.automaticPayoutAt = b['automaticPayoutAt'];
    res.json({ settings: await settings.update(patch, actorOf(req)), health: await ops.health(), limits: { holdMin: settings.HOLD_MIN, holdMax: settings.HOLD_MAX } });
  }),
);

// ---- messages --------------------------------------------------------------

router.get(
  '/messages',
  requirePlatformPermission('platform_settings.manage'),
  asyncHandler(async (_req, res) => {
    res.json(await ops.messages());
  }),
);

// ---- team -----------------------------------------------------------------

router.get(
  '/team',
  requirePlatformPermission('platform_members.create'),
  asyncHandler(async (_req, res) => {
    res.json(await team.team());
  }),
);

router.post(
  '/team',
  requirePlatformPermission('platform_members.create'),
  asyncHandler(async (req, res) => {
    const b = bodyOf(req.body);
    const added = await team.add({ name: requiredString(b, 'name', { min: 2, max: 120 }), email: requiredEmail(b), role: requiredOneOf(b, 'role', team.TEAM_ROLES), password: requiredString(b, 'password', { min: 10, max: 200 }) }, actorOf(req));
    res.status(201).json({ member: added, ...(await team.team()) });
  }),
);

router.put(
  '/team/:id',
  requirePlatformPermission('platform_members.create'),
  asyncHandler(async (req, res) => {
    await team.setRole(uuidParam(req, 'id'), requiredOneOf(bodyOf(req.body), 'role', team.TEAM_ROLES), actorOf(req));
    res.json(await team.team());
  }),
);

router.delete(
  '/team/:id',
  requirePlatformPermission('platform_members.create'),
  asyncHandler(async (req, res) => {
    await team.remove(uuidParam(req, 'id'), actorOf(req));
    res.json(await team.team());
  }),
);

// ---- plans ----------------------------------------------------------------

router.get(
  '/plans',
  requirePlatformPermission('plans.manage'),
  asyncHandler(async (_req, res) => {
    res.json({ plans: await plans.plans() });
  }),
);

router.put(
  '/plans/:key',
  requirePlatformPermission('plans.manage'),
  asyncHandler(async (req, res) => {
    const b = bodyOf(req.body);
    res.json(await plans.updatePlan(slugParam(req, 'key'), { monthlyPrice: num(b['monthlyPrice']), paymentFeePercent: num(b['paymentFeePercent']), withdrawalFee: num(b['withdrawalFee']), staffAccountLimit: num(b['staffAccountLimit']) }, actorOf(req)));
  }),
);

// ---- industry templates ---------------------------------------------------

router.get(
  '/templates',
  requirePlatformPermission('templates.manage'),
  asyncHandler(async (_req, res) => {
    res.json({ templates: await templates.templates() });
  }),
);

router.get(
  '/templates/:key',
  requirePlatformPermission('templates.manage'),
  asyncHandler(async (req, res) => {
    const found = await templates.template(slugParam(req, 'key'));
    if (found === null) {
      res.status(404).json({ error: 'That template does not exist.', code: 'NO_SUCH_TEMPLATE' });
      return;
    }
    res.json(found);
  }),
);

router.put(
  '/templates/:key',
  requirePlatformPermission('templates.manage'),
  asyncHandler(async (req, res) => {
    const b = bodyOf(req.body);
    const w = (typeof b['words'] === 'object' && b['words'] !== null ? b['words'] : {}) as Record<string, unknown>;
    const words = Object.fromEntries(templates.WORD_KEYS.map((k) => [k, typeof w[k] === 'string' ? w[k] : ''])) as templates.Words;
    const modules = Array.isArray(b['modules']) ? (b['modules'] as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    const attributes = Array.isArray(b['attributes'])
      ? (b['attributes'] as unknown[]).map((a) => {
          const o = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
          return { name: typeof o['name'] === 'string' ? o['name'] : '', pick: o['pick'] as 'one', ...(o['priced'] === true ? { priced: true } : {}) };
        })
      : [];
    res.json(await templates.saveDraft(slugParam(req, 'key'), { words, modules, attributes }, actorOf(req)));
  }),
);

router.post(
  '/templates/:key/publish',
  requirePlatformPermission('templates.manage'),
  asyncHandler(async (req, res) => {
    const rollout = requiredOneOf(bodyOf(req.body), 'rollout', ['new', 'all'] as const);
    res.json(await templates.publish(slugParam(req, 'key'), rollout, actorOf(req)));
  }),
);

export default router;
