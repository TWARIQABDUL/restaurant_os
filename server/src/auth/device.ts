// server/src/auth/device.ts — milestone 19.
//
// Which DEVICE a signed-in person is using, so the new-order chime can be off on one and on at another.
//
// `Notifications` says it in the alert's own subtitle: "Sound is off for this device. The alert still shows on
// screen." The plan recorded the consequence at milestone 9 — "the notification sound preference is per
// device", and `notification_devices` "takes it literally — one row per device, identified by a server-issued
// httpOnly cookie, which is the only way to honour the wording with no browser storage (§2.5)."
//
// SO THE COOKIE IS THE DEVICE'S NAME, NOT A CREDENTIAL. It grants nothing: V010's set_device_sound() refuses a
// token belonging to somebody else, so a stolen cookie cannot even be reassigned, and the worst it can do is
// tell you whether a chime is on. It is httpOnly anyway, because a value no script needs is a value no script
// should reach.
//
// A YEAR, because a device is a device for a long time and re-issuing one would silently turn the chime back on
// for a merchant who deliberately turned it off.

import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';

const COOKIE_NAME = 'vf_device';
const TTL_SECONDS = 365 * 24 * 60 * 60;

/** What V010's column allows, and long enough not to collide across a shop's tablets. */
const SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

export function readDeviceToken(req: Request): string | null {
  const raw = (req.cookies as Record<string, unknown> | undefined)?.[COOKIE_NAME];
  return typeof raw === 'string' && SHAPE.test(raw) ? raw : null;
}

export function newDeviceToken(): string {
  return randomBytes(24).toString('base64url');
}

export function setDeviceCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: TTL_SECONDS * 1000,
  });
}

/**
 * The device this request is on, issuing a name if it has none.
 *
 * Issued on a READ rather than only on a write, unlike the shopper cookie — because the first thing the console
 * does is ask whether the chime is on, and a device with no name would be told "on" and then be unable to turn
 * it off without a reload.
 */
export function deviceOf(req: Request, res: Response): string {
  const existing = readDeviceToken(req);
  if (existing !== null) return existing;
  const issued = newDeviceToken();
  setDeviceCookie(res, issued);
  return issued;
}
