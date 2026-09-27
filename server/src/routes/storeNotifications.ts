// server/src/routes/storeNotifications.ts — milestone 19, from project/Notifications.dc.html.
//
//   GET  /api/stores/:storeId/notifications              the panel, by keyset, All or Unread
//   POST /api/stores/:storeId/notifications/read-all     "Mark all as read"
//   POST /api/stores/:storeId/notifications/:id/read     one, when it is opened
//   GET  /api/stores/:storeId/notifications/alert        the new-order alert, and whether this device chimes
//   PUT  /api/stores/:storeId/notifications/sound        the per-device switch
//
// THE ALERT IS DERIVED, NOT PUSHED, and that is the whole reason it works the way the board describes. The
// board's own sentence is the specification: "Shows on every signed-in screen at this store." An alert held in
// one session's memory could not do that; an alert that IS "the oldest order nobody has accepted" is the same
// answer to everybody who asks, with no coordination between them at all. Accepting it in Orders makes it
// disappear everywhere, because it stops being pending.
//
// SO THIS IS POLLED RATHER THAN PUSHED — for now, and the note is here so the next person knows it was a
// decision. §1.2 keeps Socket.io in the stack and the legacy server still runs it; a socket would cut the
// latency from seconds to none. What polling buys is that the alert is correct after a reload, after a network
// drop, on a second tablet and on a screen that was asleep — none of which a socket gives for free. When the
// merchant console moves onto sockets the endpoint does not change; only how often it is asked.
//
// THE CHIME'S REPEAT IS THE CLIENT'S. "Chime repeats every 20 seconds until someone accepts or opens it" is a
// timer, and a timer belongs where the sound is. This endpoint says whether the alert exists, how old it is, and
// whether THIS device has sound on.

import { Router } from 'express';
import { asyncHandler } from '../api/handler.ts';
import { authOf, isUuid, requireStorePermission, storeIdOf } from '../middleware/authorize.ts';
import { badRequest, notFound } from '../db/index.ts';
import { bodyOf } from '../api/validate.ts';
import { deviceOf } from '../auth/device.ts';
import * as notifications from '../repositories/notifications.ts';

const router = Router({ mergeParams: true });

router.get(
  '/',
  requireStorePermission('orders.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);

    const unreadOnly = req.query['unread'] === 'true';
    const rawBefore = req.query['before'];
    const rawBeforeId = req.query['beforeId'];
    const beforeId = isUuid(rawBeforeId) ? rawBeforeId : null;

    if (rawBeforeId !== undefined && rawBeforeId !== '' && beforeId === null) {
      throw badRequest('beforeId must be the id from the previous page.', 'INVALID_CURSOR');
    }
    const before = typeof rawBefore === 'string' && rawBefore !== '' ? rawBefore : null;
    if (before !== null && Number.isNaN(Date.parse(before))) {
      throw badRequest('before must be a timestamp.', 'INVALID_CURSOR');
    }
    // Both halves or neither: V010's cursor IS the pair, because rows written by one transaction share a
    // timestamp and a half cursor steps over all of them.
    if ((before === null) !== (beforeId === null)) {
      throw badRequest('A cursor needs both before and beforeId.', 'INVALID_CURSOR');
    }

    const page = await notifications.inbox(context.userId, storeId, {
      limit: 20,
      before: before === null || beforeId === null ? null : { createdAt: before, id: beforeId },
      unreadOnly,
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      notifications: page.items,
      nextCursor: page.nextCursor,
      unread: await notifications.unreadCount(context.userId, storeId),
    });
  }),
);

router.post(
  '/read-all',
  requireStorePermission('orders.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    await notifications.markAllRead(context.userId, storeId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ unread: await notifications.unreadCount(context.userId, storeId) });
  }),
);

router.post(
  '/:notificationId/read',
  requireStorePermission('orders.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);
    const id = req.params['notificationId'];
    if (!isUuid(id)) throw badRequest('That is not a notification.', 'INVALID_NOTIFICATION');

    // V010 RAISES for a notification outside this person's inbox — "Reading something addressed to somebody else
    // is not a read; it is a bug worth hearing about." Turned into a 404 here so a guessed id reveals nothing
    // about whether it exists.
    try {
      await notifications.markRead(id, context.userId);
    } catch {
      throw notFound('That is not in your notifications.', 'NO_SUCH_NOTIFICATION');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ unread: await notifications.unreadCount(context.userId, storeId) });
  }),
);

/**
 * The new-order alert, and whether this device should make a noise about it.
 *
 * `waitingSeconds` is the board's own timer — the alert shows "0:07" and counts up — and it comes from the
 * order's `placed_at` rather than from when the client first saw it. That matters after a reload: a merchant who
 * refreshes sees how long the customer has been waiting, not how long this tab has been open.
 */
router.get(
  '/alert',
  requireStorePermission('orders.read'),
  asyncHandler(async (req, res) => {
    const storeId = storeIdOf(req);
    const { context } = authOf(req);

    // Issued on this read, not on a write: the console asks for the alert first, and a device with no name could
    // be told the chime is on and then not be able to turn it off.
    const device = deviceOf(req, res);
    const sound = await notifications.deviceSound(device, context.userId);
    const alert = await notifications.pendingAlert(storeId);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      alert:
        alert === null
          ? null
          : {
              ...alert,
              waitingSeconds: Math.max(0, Math.floor((Date.now() - alert.placedAt.getTime()) / 1000)),
            },
      sound,
    });
  }),
);

router.put(
  '/sound',
  requireStorePermission('orders.read'),
  asyncHandler(async (req, res) => {
    const { context } = authOf(req);
    const body = bodyOf(req.body);
    const enabled = body['enabled'];
    if (typeof enabled !== 'boolean') {
      throw badRequest('Say whether the chime is on.', 'MISSING_FIELD');
    }

    const device = deviceOf(req, res);
    await notifications.setDeviceSound(device, context.userId, enabled);

    res.setHeader('Cache-Control', 'no-store');
    res.json({ sound: enabled });
  }),
);

export default router;
