// server/src/messaging/otp.ts — sends a password-reset or two-step code by email.
//
// These two codes (server/src/routes/password.ts, server/src/routes/session.ts) are synchronous and
// short-lived (V016's auth_codes expire in minutes), so they go straight through transportFor('email')
// rather than through message_outbox: a sweep's retry window is wrong for something this time-sensitive.
// When no email transport is configured, or a configured one fails, the code is still logged — the same
// fallback transport.ts's own "log" provider gives everything else — so nothing is silently lost in dev.

import { randomUUID } from 'node:crypto';
import { transportFor } from './transport.ts';

export async function sendCodeEmail(to: string, label: string, code: string, expiresAt: Date): Promise<void> {
  const body = `Your ${label} is ${code}. It expires at ${expiresAt.toISOString()}.`;
  const transport = transportFor('email');
  if (transport === null) {
    console.log(`[auth] ${label} for ${to}: ${code} (expires ${expiresAt.toISOString()})`);
    return;
  }
  try {
    await transport.send({ id: randomUUID(), channel: 'email', recipient: to, sender: 'Vendlyfy', subject: `Your ${label}`, body, bodyHtml: null });
  } catch (err) {
    console.error(`[auth] failed to send ${label} to ${to}:`, err);
    console.log(`[auth] ${label} for ${to}: ${code} (expires ${expiresAt.toISOString()})`);
  }
}
