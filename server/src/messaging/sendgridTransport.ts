// server/src/messaging/sendgridTransport.ts — the email half of milestone 28's transport seam, decided 2026-10-20:
// SendGrid for email, both for message_outbox (order/merchant emails) and for the two OTP code paths
// (server/src/routes/password.ts, server/src/routes/session.ts), which call it directly rather than through
// the outbox — a code with a 10-minute expiry cannot wait on a sweep's retry window.
//
// Reuses the legacy driver's env vars (SENDGRID_API_KEY, EMAIL_FROM — see server/src/config/email.js) rather
// than inventing new names; both drivers wrap @sendgrid/mail independently and that is fine, since the legacy
// one goes away at cutover.
//
// Throws rather than silently logging when SENDGRID_API_KEY is unset: MESSAGING_EMAIL=sendgrid with no key is a
// misconfiguration, not "no provider" — the queue staying visibly stuck (message_outbox's last_error) is the
// honest signal transport.ts's header already commits to, not a quiet fallback that hides it.

import sgMail from '@sendgrid/mail';
import type { Outgoing, Transport } from './transport.ts';

let initialised = false;
function client(): typeof sgMail {
  if (!initialised) {
    const key = process.env.SENDGRID_API_KEY;
    if (key === undefined || key.trim() === '') throw new Error('SENDGRID_API_KEY is not set; MESSAGING_EMAIL=sendgrid has no key to send with');
    sgMail.setApiKey(key);
    initialised = true;
  }
  return sgMail;
}

export const sendgridTransport: Transport = {
  name: 'sendgrid',
  async send(m: Outgoing) {
    const from = process.env.EMAIL_FROM ?? 'noreply@vendlyfy.com';
    try {
      const [response] = await client().send({
        to: m.recipient,
        from: { email: from, name: m.sender },
        subject: m.subject ?? '(no subject)',
        text: m.body,
        ...(m.bodyHtml === null ? {} : { html: m.bodyHtml }),
      });
      const ref = response.headers['x-message-id'];
      return { providerRef: typeof ref === 'string' ? ref : `sendgrid-${m.id}` };
    } catch (err) {
      const body = (err as { response?: { body?: unknown } }).response?.body;
      throw new Error(`SendGrid rejected the message: ${body === undefined ? String(err) : JSON.stringify(body)}`);
    }
  },
};
