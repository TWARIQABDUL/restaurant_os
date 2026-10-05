// server/src/routes/storeSettings.ts — milestone 11.
//
// The third endpoint a manager must not reach.
//
// GUARDED BY settings.write ON A GET, which looks wrong and is not. There is no
// settings.read in role_permissions, because Auth's invite screen describes a manager as
// someone who "can't SEE payouts, the wallet or store settings". Seeing the panel and
// editing it are one capability on the board, so they are one permission in the rows.
// Inventing a settings.read here would make the guard disagree with what the invite
// screen tells the person being invited.
//
// A store's IDENTITY — its name, slug and currency — is not behind this permission. A
// manager needs it to render any screen at all, and they get it from GET /api/session,
// which lists the stores they are a member of.
//
// MILESTONE 25 ADDS THE WRITES, every one behind this same permission:
//
//   PUT    /details              name, public phone, address, time zone
//   PUT    /hours                the whole week
//   POST   /zones                a delivery zone, with its areas
//   PUT    /zones/:zoneId        change one
//   DELETE /zones/:zoneId
//   PUT    /pickup               { enabled, address, readyMinutes, instructions }
//   PUT    /payments/:key        { connected }
//   PUT    /payout               { methodKey, phone, password } — the password is REQUIRED, see the route
//
// Features and business type are the config routes (storeConfig.ts); Staff is members.ts. Settings is a screen over
// all of them, which is why none of those moved.

import { Router } from 'express';
import { AppError, badRequest, notFound, readConsistent, withTransaction } from '../db/index.ts';
import { asyncHandler } from '../api/handler.ts';
import { bodyOf, optionalString, requiredOneOf, requiredString } from '../api/validate.ts';
import { authOf, isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import * as storeAdmin from '../repositories/storeAdmin.ts';
import * as stores from '../repositories/stores.ts';
import * as users from '../repositories/users.ts';

const router = Router({ mergeParams: true });

/** GET /api/stores/:storeId/settings — store details, pickup, payout destination, methods. */
router.get(
  '/',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);

    // One consistent read across four tables. A payout destination that disagrees with
    // the payment methods beside it on screen reads as a bug, and two plain reads a
    // millisecond apart can produce exactly that.
    const settings = await readConsistent(
      (tx) => stores.findSettings(storeId, tx),
      'GET /api/stores/:storeId/settings',
    );

    if (settings === null) throw notFound('That store no longer exists.');

    res.json({
      store: {
        id: settings.store.id,
        slug: settings.store.slug,
        name: settings.store.name,
        status: settings.store.status,
        country: settings.store.country,
        currency: settings.store.selling_currency,
        planKey: settings.store.plan_key,
        customDomain: settings.store.custom_domain,
        industryTemplateId: settings.store.industry_template_id,
        industryTemplateVersion: settings.store.industry_template_version,
      },
      // Absent when the store does not offer pickup — V007's own words. Null rather
      // than an empty object, so "not offered" and "offered with nothing filled in"
      // stay distinguishable.
      pickup:
        settings.pickup === null
          ? null
          : {
              address: settings.pickup.address,
              readyMinutes: settings.pickup.ready_minutes,
              instructions: settings.pickup.instructions,
            },
      payout:
        settings.payout === null
          ? null
          : {
              methodKey: settings.payout.payout_method_key,
              phone: settings.payout.payout_phone,
              settlementMode: settings.payout.settlement_mode,
              automaticAt: settings.payout.automatic_at,
            },
      paymentMethods: settings.paymentMethods.map((m) => ({
        key: m.payment_method_key,
        isConnected: m.is_connected,
        connectedAt: m.connected_at,
      })),
    });
  }),
);

// ---------------------------------------------------------------------------
// Milestone 25 — the extra read, and the writes
// ---------------------------------------------------------------------------

/** GET /extra — zones, hours, the platform's payment catalogue and the store's own details: the panels' data. */
router.get(
  '/extra',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const extra = await storeAdmin.read(storeIdOf(req));
    if (extra === null) throw notFound('That store no longer exists.');
    res.setHeader('Cache-Control', 'no-store');
    res.json(extra);
  }),
);

router.put(
  '/details',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const body = bodyOf(req.body);
    await withTransaction((tx) =>
      storeAdmin.updateDetails(
        storeId,
        {
          name: requiredString(body, 'name', { max: 80 }),
          publicPhone: optionalString(body, 'publicPhone', { max: 30 }),
          address: optionalString(body, 'address', { max: 200 }),
          timeZone: requiredString(body, 'timeZone', { max: 64 }),
        },
        tx,
      ),
    );
    res.json((await storeAdmin.read(storeId))?.store);
  }),
);

router.put(
  '/hours',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const raw = bodyOf(req.body)['days'];
    if (!Array.isArray(raw)) throw badRequest('days must be a list.', 'INVALID');
    const rows = raw.map((d) => {
      const o = bodyOf(d);
      return { day: Number(o['day']), opens: requiredString(o, 'opens'), closes: requiredString(o, 'closes') };
    });
    await withTransaction((tx) => storeAdmin.replaceHours(storeId, rows, tx));
    res.json({ hours: (await storeAdmin.read(storeId))?.hours });
  }),
);

function zoneFrom(body: Record<string, unknown>): storeAdmin.ZoneInput {
  const areas = body['areas'];
  if (areas !== undefined && !Array.isArray(areas)) throw badRequest('areas must be a list.', 'INVALID');
  const fee = body['fee'];
  return {
    name: requiredString(body, 'name', { max: 80 }),
    fee: typeof fee === 'number' ? String(fee) : typeof fee === 'string' ? fee.trim() : '',
    etaMin: Number(body['etaMin']),
    etaMax: Number(body['etaMax']),
    areas: (areas ?? []).map((a) => String(a).slice(0, 80)),
  };
}

router.post(
  '/zones',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const input = zoneFrom(bodyOf(req.body));
    await withTransaction((tx) => storeAdmin.createZone(storeId, input, tx));
    res.status(201).json({ zones: (await storeAdmin.read(storeId))?.zones });
  }),
);

router.put(
  '/zones/:zoneId',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const zoneId = req.params['zoneId'];
    if (!isUuid(zoneId)) throw badRequest('That is not a zone.', 'INVALID_ZONE');
    const input = zoneFrom(bodyOf(req.body));
    await withTransaction((tx) => storeAdmin.updateZone(storeId, zoneId, input, tx));
    res.json({ zones: (await storeAdmin.read(storeId))?.zones });
  }),
);

router.delete(
  '/zones/:zoneId',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const zoneId = req.params['zoneId'];
    if (!isUuid(zoneId)) throw badRequest('That is not a zone.', 'INVALID_ZONE');
    const removed = await withTransaction((tx) => storeAdmin.deleteZone(storeId, zoneId, tx));
    if (!removed) throw notFound('That zone does not exist.', 'ZONE_NOT_FOUND');
    res.json({ zones: (await storeAdmin.read(storeId))?.zones });
  }),
);

router.put(
  '/pickup',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const body = bodyOf(req.body);
    if (typeof body['enabled'] !== 'boolean') throw badRequest('enabled must be true or false.', 'INVALID');
    const input = body['enabled']
      ? { address: requiredString(body, 'address', { max: 200 }), readyMinutes: Number(body['readyMinutes']), instructions: optionalString(body, 'instructions', { max: 300 }) }
      : null;
    await withTransaction((tx) => storeAdmin.setPickup(storeId, input, tx));
    res.json({ ok: true });
  }),
);

router.put(
  '/payments/:key',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const key = req.params['key'];
    const connected = bodyOf(req.body)['connected'];
    if (typeof key !== 'string' || !/^[a-z_]{2,40}$/.test(key)) throw badRequest('That is not a payment method.', 'INVALID_METHOD');
    if (typeof connected !== 'boolean') throw badRequest('connected must be true or false.', 'INVALID');
    await withTransaction((tx) => storeAdmin.setMethodConnected(storeId, key, connected, tx));
    res.json({ ok: true });
  }),
);

/**
 * PUT /payout — change where the store's money goes.
 *
 * THE ONE SETTING THAT REDIRECTS MONEY, so it asks for the signed-in person's password again, every time. A session
 * cookie is proof somebody once signed in on that browser, not that the person at it now is the owner — and "change the
 * payout number, then withdraw" is exactly what a stolen session would do. The password is checked BEFORE anything is
 * written, a wrong one is a 403 that changes nothing, and a change is recorded in the audit log (category `money`), with
 * the old number masked, so the owner can see it happened.
 */
router.put(
  '/payout',
  requireStorePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const body = bodyOf(req.body);
    const methodKey = requiredOneOf(body, 'methodKey', ['mtn_momo', 'airtel_money', 'mpesa'] as const);
    const phone = requiredString(body, 'phone', { max: 30 });
    const password = requiredString(body, 'password', { max: 200 });

    const credentials = await users.findCredentialsById(context.userId);
    if (credentials === null || !(await users.verifyPassword(password, credentials.password_hash))) {
      throw new AppError({ status: 403, code: 'WRONG_PASSWORD', message: 'That password is not right, so nothing was changed.' });
    }

    await withTransaction(async (tx) => {
      const r = await storeAdmin.setPayoutDestination(storeId, methodKey, phone, tx);
      await tx.query(`SELECT audit('money', 'payout_destination_changed', $1, $2, $3, $4)`, [
        `Payout destination changed to ${methodKey} ${maskTail(phone)}`,
        context.userId,
        storeId,
        r.previousPhone === null ? 'There was no destination before.' : `It was ${maskTail(r.previousPhone)}.`,
      ]);
    });

    const fresh = await stores.findSettings(storeId);
    res.json({ payout: fresh?.payout ?? null });
  }),
);

/** "••• 4412" — enough to recognise a number in a log, not enough to use it. */
function maskTail(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length < 4 ? '•••' : `••• ${d.slice(-4)}`;
}


export default router;
