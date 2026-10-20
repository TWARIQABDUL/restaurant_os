// server/src/messaging/transport.ts — milestone 28: how a queued message actually leaves.
//
// A TRANSPORT IS ONE FUNCTION, and the vendor decision is one line. `send` takes a rendered message and either returns a reference from
// whoever carried it or throws. Nothing about templates, recipients or retries lives here: those are the outbox's. Choosing an SMS gateway
// later means writing one of these for it and naming it in MESSAGING_SMS; nothing else in the system changes.
//
//   MESSAGING_SMS / MESSAGING_EMAIL = none       (the default)  nothing is sent; rows stay queued and the admin console counts them
//                                   = log                        development: prints the message and marks it sent (provider "log")
//                                   = sendgrid (MESSAGING_EMAIL only, decided 2026-10-20)  real email via SendGrid; see sendgridTransport.ts
//                                   = twilio   (MESSAGING_SMS only, decided 2026-10-20)    real SMS via Twilio; see twilioTransport.ts
//
// "none" IS THE DEFAULT AND IT IS DELIBERATE. A server that comes up with no provider configured must not pretend messages left —
// a customer who is never told their order was accepted is a real failure, and the only honest signal is a queue that is visibly
// not draining. (Part 9: "No SMS provider exists … SMS is an unmade vendor decision.")

import { sendgridTransport } from './sendgridTransport.ts';
import { twilioTransport } from './twilioTransport.ts';

export type Outgoing = { id: string; channel: 'sms' | 'email'; recipient: string; sender: string; subject: string | null; body: string; bodyHtml: string | null };

export interface Transport {
  readonly name: string;
  send(message: Outgoing): Promise<{ providerRef: string }>;
}

const logTransport: Transport = {
  name: 'log',
  async send(m) {
    const head = m.channel === 'sms' ? `SMS from ${m.sender} to ${m.recipient}` : `EMAIL from ${m.sender} to ${m.recipient} — ${m.subject ?? ''}`;
    console.log(`[messaging] ${head}\n            ${m.body.replaceAll('\n', '\n            ')}`);
    return { providerRef: `log-${m.id}` };
  },
};

const overrides: Partial<Record<'sms' | 'email', Transport>> = {};

/** The tests' seam: stand in for a provider (a failing one, a recording one) without touching the environment. Null removes it. */
export function overrideTransport(channel: 'sms' | 'email', t: Transport | null): void {
  if (t === null) delete overrides[channel];
  else overrides[channel] = t;
}

/** The transport configured for a channel, or null when none is — read on every call, so setting the variable takes effect without a restart. */
export function transportFor(channel: 'sms' | 'email'): Transport | null {
  const forced = overrides[channel];
  if (forced !== undefined) return forced;
  const name = (process.env[channel === 'sms' ? 'MESSAGING_SMS' : 'MESSAGING_EMAIL'] ?? 'none').trim().toLowerCase();
  if (name === 'log') return logTransport;
  if (name === 'sendgrid' && channel === 'email') return sendgridTransport;
  if (name === 'twilio' && channel === 'sms') return twilioTransport;
  return null;
}
