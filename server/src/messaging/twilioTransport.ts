// server/src/messaging/twilioTransport.ts — the SMS half of milestone 28's transport seam, decided 2026-10-20:
// Twilio for SMS. Not live yet (the account is not funded), but wired now exactly as the plan's own header
// promised — "nothing else in the system changes" — so switching it on later is TWILIO_ACCOUNT_SID /
// TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER in the environment, no deploy of new code.
//
// Plain fetch against Twilio's REST API (https://www.twilio.com/docs/messaging), not the `twilio` SDK: a
// single POST with Basic Auth needs no extra dependency, and this server already reaches outside services
// this way (payments/momo.ts).
//
// Throws rather than silently logging when the three env vars are not all set — same reasoning as
// sendgridTransport.ts: MESSAGING_SMS=twilio with no credentials is a misconfiguration, and the honest
// signal is message_outbox staying visibly stuck (last_error), not a quiet no-op.

import type { Outgoing, Transport } from './transport.ts';

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') throw new Error(`${name} is not set; MESSAGING_SMS=twilio has no credentials to send with`);
  return v;
}

// message_outbox.recipient is digits-only (repositories/messaging.ts's normalisePhone: "gateways differ on
// '+', none on digits"); Twilio's API needs E.164, so the '+' is added here, at the edge, not stored.
function e164(recipient: string): string {
  const digits = recipient.replace(/\D/g, '');
  return `+${digits}`;
}

export const twilioTransport: Transport = {
  name: 'twilio',
  async send(m: Outgoing) {
    const accountSid = required('TWILIO_ACCOUNT_SID');
    const authToken = required('TWILIO_AUTH_TOKEN');
    const from = required('TWILIO_FROM_NUMBER');

    const body = new URLSearchParams({ To: e164(m.recipient), From: from, Body: m.body });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const payload = (await response.json()) as { sid?: string; message?: string; code?: number };
    if (!response.ok) throw new Error(`Twilio rejected the message (${payload.code ?? response.status}): ${payload.message ?? 'no detail'}`);
    return { providerRef: payload.sid ?? `twilio-${m.id}` };
  },
};
