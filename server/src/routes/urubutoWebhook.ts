// server/src/routes/urubutoWebhook.ts — payment provider switched to Urubuto Pay, decided 2026-10-25.
//
// Two endpoints, ported from a working reference integration's own webhook design (ours to issue, not
// Urubuto's to sign):
//
//   POST /api/urubuto/webhook/auth      Urubuto Pay trades {user_name, password} (credentials WE issued
//                                        it, URUBUTO_WEBHOOK_USERNAME / URUBUTO_WEBHOOK_PASSWORD_HASH) for
//                                        a Bearer JWT WE mint (URUBUTO_JWT_SECRET), which it then presents
//                                        on every later call. So "is this really Urubuto Pay calling" is
//                                        answered by a secret we control, not one it does.
//   POST /api/urubuto/webhook/callback  Payment/invoice/disbursement events. Guarded by that JWT.
//
// THE CALLBACK BODY IS STILL NOT TRUSTED FOR MONEY, decided 2026-10-25 even though this JWT makes the
// CALLER authenticated (unlike MTN MoMo's unsigned callback): it is read only far enough to find which
// transaction to re-check, and collections.refresh() is what actually asks Urubuto Pay's authenticated
// status endpoint. The reference integration this was ported from documents its own payload quirks (e.g.
// `transaction_id` sometimes holding Urubuto's own reference instead of ours) — not worth trusting
// outright for what is, after all, whether an order got paid.
//
// MOUNTED OUTSIDE THE CSRF LAYER, same exception momoWebhook.ts already is: Urubuto Pay cannot echo a
// double-submit cookie. The auth endpoint is the one place that DOES need its own secret (the
// username/password above), because unlike MoMo's callback this one hands out a credential (a JWT) that
// then grants access to the callback endpoint.

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { authLimiter, webhookLimiter } from '../middleware/rateLimit.js';
import * as collections from '../repositories/collections.ts';

const router = Router();

const TOKEN_ISSUER = 'vendlyfy-payment-service';
const TOKEN_AUDIENCE = 'urubutopay-webhook';

function jwtSecret(): string {
  const secret = process.env['URUBUTO_JWT_SECRET'];
  if (secret === undefined || secret.length < 32) throw new Error('URUBUTO_JWT_SECRET is not set (or too short); needed to issue/verify the webhook token');
  return secret;
}

/** `YYYY-MM-DD HH:MM:SS`, Africa/Kigali, no zone marker — what Urubuto Pay's own responses use. */
const KIGALI_TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Kigali',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
function urubutoTimestamp(): string {
  const p: Record<string, string> = {};
  for (const part of KIGALI_TIME.formatToParts(new Date())) p[part.type] = part.value;
  return `${p['year']}-${p['month']}-${p['day']} ${p['hour']}:${p['minute']}:${p['second']}`;
}

router.post('/webhook/auth', authLimiter, async (req, res) => {
  const body = req.body as Record<string, unknown> | null;
  const userName = typeof body?.['user_name'] === 'string' ? body['user_name'] : '';
  const password = typeof body?.['password'] === 'string' ? body['password'] : '';

  if (userName === '' || password === '') {
    res.status(400).json({
      message: 'Validation failed',
      error: 'Bad Request',
      validation: { body: { source: 'body', keys: ['user_name', 'password'].filter((k) => body?.[k] === undefined), message: 'user_name and password are required' } },
    });
    return;
  }

  const expectedUser = process.env['URUBUTO_WEBHOOK_USERNAME'] ?? '';
  const expectedHash = process.env['URUBUTO_WEBHOOK_PASSWORD_HASH'] ?? '';
  // Both checks always run, even when the username is already known to be wrong — a response that is
  // fast for "unknown username" and slow for "wrong password" tells an attacker which one they got right.
  const passwordOk = expectedHash !== '' && (await bcrypt.compare(password, expectedHash));
  const usernameOk = expectedUser !== '' && userName === expectedUser;

  if (!usernameOk || !passwordOk) {
    res.status(401).json({ timestamp: urubutoTimestamp(), message: 'Invalid credentials', status: 401 });
    return;
  }

  const ttl = process.env['URUBUTO_WEBHOOK_TOKEN_TTL'] ?? '24h';
  const options: jwt.SignOptions = {
    algorithm: 'HS256',
    expiresIn: ttl as jwt.SignOptions['expiresIn'],
    subject: 'urubutopay',
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    jwtid: randomUUID(),
  };
  const token = jwt.sign({ scope: 'urubuto-webhook' }, jwtSecret(), options);

  res.status(200).json({ timestamp: urubutoTimestamp(), status: 200, message: 'Successful', data: { token: `Bearer ${token}` } });
});

function verifyWebhookToken(req: { headers: { authorization?: string } }): boolean {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  if (match === null) return false;
  try {
    jwt.verify(match[1]!, jwtSecret(), { algorithms: ['HS256'], issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE });
    return true;
  } catch {
    return false;
  }
}

router.post('/webhook/callback', webhookLimiter, (req, res) => {
  if (!verifyWebhookToken(req)) {
    res.status(401).json({ status: 401, message: 'Unauthorized' });
    return;
  }

  // Answer first, always: a webhook made to wait is a webhook that gets retried, and nothing here is
  // worth telling the caller about before collections.refresh() actually runs.
  res.status(200).json({ timestamp: urubutoTimestamp(), status: 200, message: 'Callback received successfully' });

  const body = req.body as Record<string, unknown> | null;
  // Documented as `transaction_id`; the reference integration found real callbacks sometimes carry it
  // under `internal_transaction_id` instead — both are checked, neither is trusted for anything but WHICH
  // row to re-check.
  const candidate = body?.['transaction_id'] ?? body?.['internal_transaction_id'];
  const transactionId = typeof candidate === 'string' ? candidate : null;
  if (transactionId === null) return;

  void collections.refresh(transactionId).catch((error: unknown) => {
    console.error(`[urubuto] recheck failed for collection ${transactionId}:`, error instanceof Error ? error.message : String(error));
  });
});

export default router;
