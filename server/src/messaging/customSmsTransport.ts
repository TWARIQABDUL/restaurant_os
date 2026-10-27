// server/src/messaging/customSmsTransport.ts — the SMS half of milestone 28's transport seam, replacing the
// Twilio decision (2026-10-20, never funded/live) with a self-built service, decided 2026-10-27.
//
//   POST https://sms-intergration.onrender.com/api/sms/send
//     headers: X-API-Key: <SMS_API_KEY>, Content-Type: application/json
//     body:    { "to": "+2507...", "body": "..." }
//     200/201: { "id": "<provider's own id>" }
//     4xx/5xx: { "error": "<message>" }
//
// Verified live against the real service before this shipped: a real send (201, a real id), a wrong API
// key (401, {"error":"missing or invalid X-API-Key header"}), and a malformed phone number (400,
// {"error":"to must be a valid E.164-ish phone number, ..."}) — so the error branch below is reading a
// shape this service actually sends, not a guess.
//
// Throws rather than silently logging when the env vars are not set — same reasoning as
// sendgridTransport.ts and twilioTransport.ts: MESSAGING_SMS=custom with no key is a misconfiguration, and
// the honest signal is message_outbox staying visibly stuck (last_error), not a quiet no-op.

import type { Outgoing, Transport } from './transport.ts';

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') throw new Error(`${name} is not set; MESSAGING_SMS=custom has no credentials to send with`);
  return v;
}

// message_outbox.recipient is digits-only (repositories/messaging.ts's normalisePhone: "gateways differ on
// '+', none on digits"); this service needs E.164 with the '+', added here at the edge, not stored.
function e164(recipient: string): string {
  const digits = recipient.replace(/\D/g, '');
  return `+${digits}`;
}

export const customSmsTransport: Transport = {
  name: 'custom',
  async send(m: Outgoing) {
    const url = process.env['SMS_API_URL'] ?? 'https://sms-intergration.onrender.com/api/sms/send';
    const apiKey = required('SMS_API_KEY');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: e164(m.recipient), body: m.body }),
    });
    const payload = (await response.json()) as { id?: string; error?: string };
    if (!response.ok) throw new Error(`The SMS service rejected the message (${response.status}): ${payload.error ?? 'no detail'}`);
    return { providerRef: payload.id ?? `custom-sms-${m.id}` };
  },
};
