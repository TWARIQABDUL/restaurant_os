// server/test/api/messaging.test.ts — milestone 28: from "something happened" to "a message is waiting", and out the door when a transport exists.
//
//   1. EVENTS BECOME MESSAGES without being called from where they happen: an order placed, accepted, assigned; an identity decision;
//      a failed payout — each found by a sweep of what the system already records.
//   2. ASKING TWICE SENDS NOTHING TWICE: the sweep is idempotent (the key names the event), so a timer, a second process and a crash
//      restart are all safe.
//   3. NOTHING IS PRETENDED. With no provider the rows WAIT, and are counted; a message with nowhere to go is a recorded `skipped`, not a
//      silent drop; a stale one is closed out rather than sent late; a failing provider is retried and then given up on, on the record.
//   4. THE WORDS ARE THE BOARD'S, for the store that sent them, with a real tracking link.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import { dispatch, enqueueAll, expireStale } from '../../src/jobs/messaging.ts';
import { overrideTransport } from '../../src/messaging/transport.ts';
import type { Outgoing } from '../../src/messaging/transport.ts';
import { normalisePhone, queueState } from '../../src/repositories/messaging.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { CONSOLE, ORDERS_BOARD, STORE, USER, cleanup, seedConsole, seedFixtures, seedOrdersBoard, seedStorefront } from './support.ts';

let api: Api;
const owner = (): string => tokenFor(USER.ownerA);

type Row = { channel: string; template: string; audience: string; recipient: string; sender: string; body: string; status: string; last_error: string | null; subject: string | null; body_html: string | null };
const rows = async (where: string, args: unknown[] = []): Promise<Row[]> =>
  (await sql<Row>(`SELECT channel, template, audience, recipient, sender, body, status, last_error, subject, body_html FROM message_outbox WHERE store_id = $1 AND ${where} ORDER BY queued_at, id`, [STORE.a, ...args])).rows;

before(async () => {
  process.env['CLIENT_URL'] = 'https://shop.test';
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  await seedConsole();
  await seedOrdersBoard();
  await sql(`UPDATE users SET phone = '078 111 0001' WHERE id = $1`, [USER.ownerA]);
  // Only the console fixtures and the one order this suite moves belong to the window; the rest of the board's orders were "placed" in the same instant.
  await sql(`UPDATE orders SET guest_email = 'aimable@example.test' WHERE id = $1`, [CONSOLE.oldestPending]);
  await sql(`UPDATE orders SET placed_at = now() - interval '5 hours' WHERE id = $1`, [CONSOLE.accepted]);
});

after(async () => {
  overrideTransport('sms', null);
  overrideTransport('email', null);
  delete process.env['MESSAGING_SMS'];
  await cleanup();
  await api.close();
  await closePool();
});

describe('phone numbers', () => {
  it('become the digits a gateway wants, or nothing', () => {
    assert.equal(normalisePhone('078 811 0001'), '250788110001');
    assert.equal(normalisePhone('+250 788 110 001'), '250788110001');
    assert.equal(normalisePhone('00250788110001'), '250788110001');
    assert.equal(normalisePhone('12'), null);
    assert.equal(normalisePhone(null), null);
    assert.equal(normalisePhone(''), null);
  });
});

describe('placing an order', () => {
  it('tells the customer by SMS and email, and the owner by SMS — in the store’s words, with a real tracking link', async () => {
    const added = await enqueueAll();
    assert.ok(added > 0);
    const sms = (await rows(`channel = 'sms' AND template = 'confirm' AND body LIKE '%#9002%'`))[0]!;
    assert.equal(sms.recipient, '250780000001');
    assert.equal(sms.sender, 'ESCALATIONS');
    assert.match(sms.body, /^Escalation Store A: we got order #9002 \(10,500 RWF\)\. We’ll text when it’s accepted\. Track: https:\/\/shop\.test\/escalation-store-a\/orders\/trk_console_9002$/);
    assert.equal(sms.status, 'queued');

    const email = (await rows(`channel = 'email' AND template = 'confirm' AND subject LIKE '%#9002'`))[0]!;
    assert.equal(email.recipient, 'aimable@example.test');
    assert.equal(email.subject, 'We got your order · #9002');
    assert.ok(email.body_html!.includes('Escalation Store A') && email.body_html!.includes('Passion Juice') && email.body_html!.includes('Track your order'));

    const merchant = (await rows(`template = 'newOrder' AND body LIKE '%#9002%'`))[0]!;
    assert.equal(merchant.audience, 'merchant');
    assert.equal(merchant.recipient, '250781110001');
    assert.match(merchant.body, /^Vendlyfy: new order #9002 · 10,500 RWF paid\. Accept in the app: https:\/\/shop\.test\/app\/escalation-store-a\/orders$/);
  });

  it('records the gap when there is nowhere to send, instead of dropping it', async () => {
    const e = await rows(`channel = 'email' AND template = 'confirm' AND subject LIKE '%#9003'`);
    assert.equal(e[0]!.status, 'skipped');
    assert.match(e[0]!.last_error ?? '', /No email address on file/);
  });

  it('asking again adds nothing', async () => {
    const before = Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM message_outbox WHERE store_id = $1`, [STORE.a])).rows[0]!.n);
    assert.equal(await enqueueAll(), 0);
    assert.equal(Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM message_outbox WHERE store_id = $1`, [STORE.a])).rows[0]!.n), before);
  });

  it('does not tell anyone about an order from five hours ago', async () => {
    assert.equal((await rows(`body LIKE '%#9004%'`)).length, 0);
  });
});

describe('an order moving', () => {
  it('accepting it tells the customer; assigning a rider tells the rider — and only those', async () => {
    const acc = await call(api, 'POST', `/api/stores/${STORE.a}/orders/${CONSOLE.oldestPending}/accept`, { token: owner() });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    const asg = await call(api, 'POST', `/api/stores/${STORE.a}/orders/${ORDERS_BOARD.readyDelivery}/assign-rider`, { token: owner(), body: { riderUserId: USER.riderA } });
    assert.equal(asg.status, 200, JSON.stringify(asg.body));
    assert.ok((await enqueueAll()) > 0);

    const approved = (await rows(`channel = 'sms' AND template = 'approved'`))[0]!;
    assert.match(approved.body, /^Escalation Store A: order #9002 accepted and being prepared\. Track: https:\/\/shop\.test\/escalation-store-a\/orders\/trk_console_9002$/);

    const job = (await rows(`template = 'riderJob'`))[0]!;
    assert.equal(job.audience, 'rider');
    assert.equal(job.recipient, '250784559012');
    assert.match(job.body, /^Vendlyfy: new delivery #\d+ from Escalation Store A to KG 11 Ave\. Open app\.$/);
    assert.equal((await rows(`template = 'approved' AND audience = 'rider'`)).length, 0, 'the rider is not told the customer’s news');
  });
});

describe('identity and payouts', () => {
  it('a verification and a failed payout reach the owner by SMS, once', async () => {
    await sql(`SELECT notify($1, 'identity_verified', 'msg-test-verified', '{}'::jsonb, NULL, NULL, NULL, NULL, NULL)`, [STORE.a]);
    await sql(`INSERT INTO withdrawals (store_id, amount, phone, status, failure_reason, initiated_by, idempotency_key) VALUES ($1, 41000, '250781234412', 'failed', 'MoMo name mismatch', 'automatic', 'msg-test-withdrawal-1')`, [STORE.a]);
    await enqueueAll();
    const ok = (await rows(`template = 'kycOk'`))[0]!;
    assert.equal(ok.recipient, '250781110001');
    assert.match(ok.body, /^Vendlyfy: you’re verified\./);
    const fail = (await rows(`template = 'payoutFail'`))[0]!;
    assert.match(fail.body, /^Vendlyfy: payout of 41,000 RWF failed \(MoMo name mismatch\)\. Money is back in your balance\. Fix: https:\/\/shop\.test\/app\/money$/);
    assert.equal(await enqueueAll(), 0, 'and not again');
  });
});

describe('sending', () => {
  it('with no provider, nothing leaves and the queue is counted', async () => {
    const sent = await dispatch();
    assert.equal(sent, 0);
    const state = await queueState();
    assert.ok(state.sms.queued > 0 && state.email.queued >= 0);
    assert.equal(state.sms.configured, false);
    assert.equal((await rows(`status = 'sent'`)).length, 0);
  });

  it('with the development transport, queued messages are marked sent with where and what they got', async () => {
    process.env['MESSAGING_SMS'] = 'log';
    const log = console.log;
    const printed: string[] = [];
    console.log = (...a: unknown[]) => void printed.push(a.join(' '));
    try {
      const sent = await dispatch();
      assert.ok(sent > 0);
    } finally {
      console.log = log;
    }
    assert.ok(printed.some((l) => l.includes('SMS from') && l.includes('250780000001')));
    const sentRow = (await sql<{ provider: string; provider_ref: string; sent_at: Date | null; attempts: number }>(`SELECT provider, provider_ref, sent_at, attempts FROM message_outbox WHERE store_id = $1 AND status = 'sent' LIMIT 1`, [STORE.a])).rows[0]!;
    assert.equal(sentRow.provider, 'log');
    assert.match(sentRow.provider_ref, /^log-/);
    assert.ok(sentRow.sent_at !== null && sentRow.attempts === 1);
    assert.equal((await rows(`channel = 'email' AND status = 'sent'`)).length, 0, 'email has no transport, so it did not move');
    delete process.env['MESSAGING_SMS'];
  });

  it('a failing provider is retried and then given up on, on the record', async () => {
    await sql(`INSERT INTO message_outbox (store_id, channel, template, audience, recipient, sender, body, idempotency_key) VALUES ($1, 'sms', 'ready', 'customer', '250780000009', 'TEST', 'Test: order #1 is ready.', 'msg-test-failing')`, [STORE.a]);
    let calls = 0;
    overrideTransport('sms', { name: 'broken', send: async (_m: Outgoing) => { calls += 1; throw new Error('gateway timeout'); } });
    for (let i = 0; i < 6; i += 1) await dispatch();
    overrideTransport('sms', null);
    const row = (await sql<{ status: string; attempts: number; last_error: string }>(`SELECT status, attempts, last_error FROM message_outbox WHERE idempotency_key = 'msg-test-failing'`)).rows[0]!;
    assert.deepEqual([row.status, row.attempts, row.last_error], ['failed', 5, 'gateway timeout']);
    assert.equal(calls, 5, 'five tries, no sixth');
  });

  it('a message that waited too long is closed out, not sent late', async () => {
    await sql(`INSERT INTO message_outbox (store_id, channel, template, audience, recipient, sender, body, idempotency_key, queued_at) VALUES ($1, 'sms', 'ready', 'customer', '250780000008', 'TEST', 'Test: order #2 is ready.', 'msg-test-stale', now() - interval '5 hours')`, [STORE.a]);
    assert.ok((await expireStale()) >= 1);
    const row = (await sql<{ status: string; last_error: string }>(`SELECT status, last_error FROM message_outbox WHERE idempotency_key = 'msg-test-stale'`)).rows[0]!;
    assert.equal(row.status, 'skipped');
    assert.match(row.last_error, /Too old to send/);
  });
});
