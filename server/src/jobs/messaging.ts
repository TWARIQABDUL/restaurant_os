// server/src/jobs/messaging.ts — milestone 28: enqueue what happened, then send what is waiting.
//
// TWO STEPS ON ONE TIMER, kept separate because they fail differently. ENQUEUEING reads our own tables and cannot fail for a reason
// outside the database; SENDING talks to somebody else and can fail for any reason at all. A provider outage must not stop the next
// order's message from being written down, and a bug in a template must not stop the queue from draining.
//
// WITH NO TRANSPORT CONFIGURED (the default — see messaging/transport.ts) the second step does nothing and the rows wait. That is the
// honest state, and it is visible: Platform settings counts the queue per channel.
//
// A MESSAGE THAT FAILS IS RETRIED, FIVE TIMES, THEN GIVEN UP ON. Giving up is a recorded `failed` row with the error — not a silent
// drop, and not an infinite retry that sends a stale "your order is ready" an hour after the order was delivered.

import { db, withTransaction } from '../db/index.ts';
import { transportFor } from '../messaging/transport.ts';
import * as messaging from '../repositories/messaging.ts';

const MAX_ATTEMPTS = 5;
const BATCH = 50;

export async function enqueueAll(): Promise<number> {
  return (await messaging.sweepOrderEvents()) + (await messaging.sweepMerchantEvents());
}

/** Sends up to a batch of queued messages per channel. Returns how many left. */
export async function dispatch(): Promise<number> {
  let sent = 0;
  for (const channel of ['sms', 'email'] as const) {
    const transport = transportFor(channel);
    if (transport === null) continue;

    const batch = await db.query<{ id: string; recipient: string; sender: string; subject: string | null; body: string; body_html: string | null; attempts: number }>(
      `SELECT id, recipient, sender, subject, body, body_html, attempts FROM message_outbox
        WHERE channel = $1 AND status = 'queued' AND queued_at > now() - make_interval(mins => $2)
        ORDER BY queued_at LIMIT ${BATCH}`,
      [channel, messaging.windowMinutes() * 2],
    );
    for (const m of batch.rows) {
      try {
        const { providerRef } = await transport.send({ id: m.id, channel, recipient: m.recipient, sender: m.sender, subject: m.subject, body: m.body, bodyHtml: m.body_html });
        await db.query(`UPDATE message_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, provider = $2, provider_ref = $3, last_error = NULL WHERE id = $1 AND status = 'queued'`, [m.id, transport.name, providerRef]);
        sent += 1;
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300);
        await db.query(`UPDATE message_outbox SET attempts = attempts + 1, last_error = $2, status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'queued' END WHERE id = $1`, [m.id, reason, MAX_ATTEMPTS]);
      }
    }
  }
  return sent;
}

/** Anything still queued past twice the window is stale — told too late to be useful — and is closed out rather than sent. */
export async function expireStale(): Promise<number> {
  return withTransaction(
    async (tx) => (await tx.query(`UPDATE message_outbox SET status = 'skipped', last_error = 'Too old to send: the moment had passed.' WHERE status = 'queued' AND queued_at <= now() - make_interval(mins => $1)`, [messaging.windowMinutes() * 2])).rowCount ?? 0,
    { label: 'messaging expire', retries: 0 },
  );
}

let timer: NodeJS.Timeout | null = null;

export function startMessagingLoop(everyMs = Number(process.env['MESSAGING_INTERVAL_MS']) || 20_000): void {
  if (timer !== null || process.env['MESSAGING_SCHEDULER'] === 'off') return;
  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    enqueueAll()
      .then(() => dispatch())
      .then(() => expireStale())
      .catch((cause: unknown) => console.error('[messaging] sweep failed:', cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref();
}

export function stopMessagingLoop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}
