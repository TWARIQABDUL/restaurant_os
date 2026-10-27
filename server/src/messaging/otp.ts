// server/src/messaging/otp.ts — sends a password-reset or two-step code by email and, when the
// account has a phone on file, by SMS too.
//
// These two codes (server/src/routes/password.ts, server/src/routes/session.ts) are synchronous and
// short-lived (V016's auth_codes expire in minutes), so they go straight through transportFor(...)
// rather than through message_outbox: a sweep's retry window is wrong for something this time-sensitive.
// The two channels are independent and best-effort — a phone-less account still gets its email, and a
// failing SMS provider must not block the email arm (or vice versa). When a channel has no transport
// configured, or a configured one fails, the code is still logged — the same fallback transport.ts's
// own "log" provider gives everything else — so nothing is silently lost in dev.

import { randomUUID } from 'node:crypto';
import { transportFor } from './transport.ts';

export type OtpContact = { email: string; phone: string | null };

// The fallback log line's shape (`${label} for ${recipient}: ${code} (expires ...)`) is scraped by
// server/test/api/auth.test.ts's lastCode() via `: (\d{6}) ` — keep the code directly after a colon
// and a space, with a space after it, if this is ever touched again.
function logFallback(recipient: string, label: string, code: string, expiresAt: Date): void {
  console.log(`[auth] ${label} for ${recipient}: ${code} (expires ${expiresAt.toISOString()})`);
}

async function sendVia(channel: 'sms' | 'email', recipient: string, label: string, code: string, expiresAt: Date): Promise<void> {
  const transport = transportFor(channel);
  if (transport === null) {
    logFallback(recipient, label, code, expiresAt);
    return;
  }
  const body = `Your ${label} is ${code}. It expires at ${expiresAt.toISOString()}.`;
  try {
    await transport.send({ id: randomUUID(), channel, recipient, sender: 'Vendlyfy', subject: `Your ${label}`, body, bodyHtml: null });
  } catch (err) {
    console.error(`[auth] failed to send ${label} to ${recipient} via ${channel}:`, err);
    logFallback(recipient, label, code, expiresAt);
  }
}

export async function sendCode(to: OtpContact, label: string, code: string, expiresAt: Date): Promise<void> {
  await Promise.all([
    sendVia('email', to.email, label, code, expiresAt),
    ...(to.phone !== null ? [sendVia('sms', to.phone, label, code, expiresAt)] : []),
  ]);
}
