// server/test/api/urubutoCheckout.test.ts — payment provider switched to Urubuto Pay, 2026-10-25.
//
// Urubuto Pay is faked at `fetch`, same reasoning wallet.test.ts gives for MoMo: the one thing this suite
// must do and a real sandbox cannot is make the provider fail in a specific, repeatable way on demand.
//
//   1. THE HAPPY PATH IS TWO CALLS. create-invoice then initiate, in order, and the invoice number is
//      persisted the moment it exists.
//   2. A CRASH BETWEEN THE TWO CALLS IS RECOVERABLE. If initiate never went out, the next refresh() reuses
//      the SAME invoice and resumes — never a second invoice, since create-invoice has no idempotency key.
//   3. THE CALLBACK IS A NUDGE, NOT A FACT. It only triggers a re-check against the authenticated status
//      endpoint; a forged one for a real reference cannot pay an order that was never approved.
//   4. A REFUSAL VS A SILENCE. Urubuto Pay saying FAILED is definitive; a dropped connection on initiate
//      leaves the attempt pending for the next refresh() to resolve, exactly as MoMo's collections did.

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { closePool, sql } from '../../src/db/index.ts';
import * as collections from '../../src/repositories/collections.ts';
import { boot, call } from './client.ts';
import type { Api } from './client.ts';
import { cleanup, seedFixtures, seedStorefront } from './support.ts';

let api: Api;
const SLUG = 'escalation-store-a';
const JUICE_VARIANT = 'eeeeeeee-0000-4000-8000-000000000310';

// ---------------------------------------------------------------------------
// Urubuto Pay, faked
// ---------------------------------------------------------------------------

const URUBUTO = 'http://urubuto.invalid';
const realFetch = globalThis.fetch;

type Behaviour = {
  invoice: 'ok' | 'drop';
  initiate: 'ok' | 'drop' | 'conflict' | 'refused';
  status: 'PENDING' | 'SUCCESSFUL' | 'FAILED' | 'NOT_FOUND';
};
let behaviour: Behaviour = { invoice: 'ok', initiate: 'ok', status: 'PENDING' };
let invoiceCount = 0;
const initiated: { transactionId: string; payerCode: string }[] = [];

function envelope(data: unknown): string {
  return JSON.stringify({ timestamp: '2026-10-25 12:00:00', status: 200, data });
}

function fakeUrubuto(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(URUBUTO)) return realFetch(input, init);
    const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (url.endsWith('/v2/invoice/create')) {
      if (behaviour.invoice === 'drop') throw new TypeError('connection reset');
      invoiceCount += 1;
      return new Response(envelope({ invoice_number: `inv-${invoiceCount}`, status: 'UNPAID', amount: body['amount'], currency: body['currency'] }), { status: 200 });
    }
    if (url.endsWith('/v2/payment/initiate')) {
      if (behaviour.initiate === 'drop') throw new TypeError('connection reset');
      if (behaviour.initiate === 'conflict') return new Response(JSON.stringify({ status: 409, message: 'already exist' }), { status: 409 });
      if (behaviour.initiate === 'refused') return new Response(JSON.stringify({ status: 400, message: 'invalid payer code' }), { status: 400 });
      initiated.push({ transactionId: String(body['transaction_id']), payerCode: String(body['payer_code']) });
      return new Response(envelope({ internal_transaction_ref_number: 'urb-ref' }), { status: 200 });
    }
    if (url.endsWith('/v2/payment/transaction/status')) {
      if (behaviour.status === 'NOT_FOUND') return new Response(JSON.stringify({ status: 404, message: 'not found' }), { status: 404 });
      return new Response(envelope({ transaction_status: behaviour.status, amount: '0', currency: 'RWF' }), { status: 200 });
    }
    return new Response('not faked', { status: 500 });
  }) as typeof fetch;
}

const ENV_KEYS = ['URUBUTO_BASE_URL', 'URUBUTO_API_KEY', 'URUBUTO_MERCHANT_CODE', 'URUBUTO_SERVICE_CODE'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env['URUBUTO_BASE_URL'] = URUBUTO;
  process.env['URUBUTO_API_KEY'] = 'test-key';
  process.env['URUBUTO_MERCHANT_CODE'] = 'test-merchant';
  process.env['URUBUTO_SERVICE_CODE'] = 'test-service';
  fakeUrubuto();

  api = await boot();
  await seedFixtures();
  await seedStorefront();
});

afterEach(async () => {
  while (openShoppers.length > 0) await openShoppers.pop()!.close().catch(() => {});
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await cleanup();
  await api.close();
  await closePool();
});

// Tracked and closed in afterEach, not by each test's own final line — a `boot()` server left listening
// after an assertion throws keeps the process's event loop alive, which hangs the WHOLE suite (not just
// this file) long after the last test result has printed. Found the hard way: a wrong status-code
// assertion here once left the runner alive for over an hour with nothing left to do.
const openShoppers: Api[] = [];
async function shopper(): Promise<Api> {
  const who = await boot();
  openShoppers.push(who);
  return who;
}

async function placeOrder(who: Api): Promise<{ code: string; orderId: string }> {
  await call(who, 'POST', `/api/storefront/${SLUG}/cart/items`, { body: { variantId: JUICE_VARIANT, optionValueIds: [], quantity: 1 } });
  const quoted = await call(who, 'GET', `/api/storefront/${SLUG}/checkout?fulfilment=pickup`);
  const total = String((quoted.body['quote'] as Record<string, unknown>)['total']);
  const placed = await call(who, 'POST', `/api/storefront/${SLUG}/orders`, {
    body: {
      idempotencyKey: `urubuto-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      fulfilment: 'pickup',
      paymentMethod: 'mtn_momo',
      expectedTotal: total,
      name: 'Urubuto Tester',
      phone: '078 812 3456',
      email: 'tester@vendlyfy.example',
    },
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const code = String((placed.body['order'] as Record<string, unknown>)['trackingCode']);
  const { rows } = await sql<{ id: string }>(`SELECT id FROM orders WHERE tracking_code = $1`, [code]);
  return { code, orderId: rows[0]!.id };
}

describe('starting a collection via Urubuto Pay', () => {
  it('creates an invoice, then initiates, and persists both on the row', async () => {
    behaviour = { invoice: 'ok', initiate: 'ok', status: 'PENDING' };
    const who = await shopper();
    const { code } = await placeOrder(who);

    const reply = await call(who, 'POST', `/api/storefront/${SLUG}/orders/${code}/payment`, { body: { phone: '250788123456' } });
    assert.equal(reply.status, 202, JSON.stringify(reply.body));

    const { rows } = await sql<{ gateway: string; invoice_number: string | null; provider_status: string | null; status: string }>(
      `SELECT gateway, invoice_number, provider_status, status FROM momo_transactions WHERE order_id = (SELECT id FROM orders WHERE tracking_code = $1)`,
      [code],
    );
    assert.equal(rows[0]?.gateway, 'urubuto');
    assert.ok(rows[0]?.invoice_number?.startsWith('inv-'));
    assert.equal(rows[0]?.provider_status, 'initiated');
    assert.equal(rows[0]?.status, 'pending');
    assert.ok(initiated.some((x) => x.payerCode === rows[0]?.invoice_number), 'the invoice number was sent as payer_code');
    await who.close();
  });

  it('a conflict on initiate (already exists) is treated as success, not a refusal', async () => {
    behaviour = { invoice: 'ok', initiate: 'conflict', status: 'PENDING' };
    const who = await shopper();
    const { code } = await placeOrder(who);

    const reply = await call(who, 'POST', `/api/storefront/${SLUG}/orders/${code}/payment`, { body: { phone: '250788123456' } });
    assert.equal(reply.status, 202, JSON.stringify(reply.body));
    assert.equal(reply.body['started'], true);
    await who.close();
  });

  it('a definitive refusal on initiate leaves the attempt pending, not failed — the ambiguity is real', async () => {
    // initiate refusing with 400 is still "the request reached Urubuto Pay and was answered" from this
    // module's point of view: initiatePayment() throws, start() catches it as provider_unavailable, and
    // the row is deliberately NOT marked failed (same reasoning as a network drop) because create-invoice
    // already succeeded and a human has to decide whether that invoice is safe to retry against.
    behaviour = { invoice: 'ok', initiate: 'refused', status: 'PENDING' };
    const who = await shopper();
    const { code } = await placeOrder(who);

    const reply = await call(who, 'POST', `/api/storefront/${SLUG}/orders/${code}/payment`, { body: { phone: '250788123456' } });
    // Only 'requested' gets 202 — 'provider_unavailable' is 200 with a warning (routes/storefrontCheckout.ts).
    assert.equal(reply.status, 200);
    assert.equal(reply.body['started'], false, 'provider_unavailable, not a clean start');

    const { rows } = await sql<{ status: string; invoice_number: string | null }>(
      `SELECT status, invoice_number FROM momo_transactions WHERE order_id = (SELECT id FROM orders WHERE tracking_code = $1)`,
      [code],
    );
    assert.equal(rows[0]?.status, 'pending');
    assert.ok(rows[0]?.invoice_number !== null, 'the invoice survives for the next attempt to reuse');
    await who.close();
  });

  it('resumes a send that crashed before initiate ever went out, reusing the same invoice', async () => {
    behaviour = { invoice: 'ok', initiate: 'drop', status: 'PENDING' };
    const who = await shopper();
    const { code } = await placeOrder(who);
    await call(who, 'POST', `/api/storefront/${SLUG}/orders/${code}/payment`, { body: { phone: '250788123456' } });

    const before = await sql<{ reference_id: string; invoice_number: string | null; provider_status: string | null }>(
      `SELECT reference_id, invoice_number, provider_status FROM momo_transactions WHERE order_id = (SELECT id FROM orders WHERE tracking_code = $1)`,
      [code],
    );
    const invoiceBefore = before.rows[0]?.invoice_number;
    assert.ok(invoiceBefore !== null, 'the invoice was created before initiate failed');
    assert.notEqual(before.rows[0]?.provider_status, 'initiated');

    // Now let initiate succeed, and poll — the same invoice must be reused, not a second one created.
    behaviour = { invoice: 'ok', initiate: 'ok', status: 'PENDING' };
    const countBefore = invoiceCount;
    const result = await collections.refresh(before.rows[0]!.reference_id);
    assert.equal(result?.status, 'pending');
    assert.equal(invoiceCount, countBefore, 'create-invoice was NOT called again');

    const after2 = await sql<{ invoice_number: string | null; provider_status: string | null }>(
      `SELECT invoice_number, provider_status FROM momo_transactions WHERE order_id = (SELECT id FROM orders WHERE tracking_code = $1)`,
      [code],
    );
    assert.equal(after2.rows[0]?.invoice_number, invoiceBefore, 'same invoice, reused');
    assert.equal(after2.rows[0]?.provider_status, 'initiated', 'the resumed send went through');
    await who.close();
  });
});

describe('resolving a collection via Urubuto Pay', () => {
  it('SUCCESSFUL pays the order, exactly once', async () => {
    behaviour = { invoice: 'ok', initiate: 'ok', status: 'PENDING' };
    const who = await shopper();
    const { code, orderId } = await placeOrder(who);
    await call(who, 'POST', `/api/storefront/${SLUG}/orders/${code}/payment`, { body: { phone: '250788123456' } });

    behaviour = { ...behaviour, status: 'SUCCESSFUL' };
    const poll = await call(who, 'GET', `/api/storefront/${SLUG}/orders/${code}/payment`);
    assert.equal(poll.status, 200);
    assert.equal((poll.body['payment'] as Record<string, unknown>)['status'], 'successful');

    const { rows } = await sql<{ payment_status: string }>(`SELECT payment_status FROM orders WHERE id = $1`, [orderId]);
    assert.equal(rows[0]?.payment_status, 'paid');
    await who.close();
  });

  it('FAILED resolves the attempt and lets a new one start', async () => {
    behaviour = { invoice: 'ok', initiate: 'ok', status: 'PENDING' };
    const who = await shopper();
    const { code } = await placeOrder(who);
    await call(who, 'POST', `/api/storefront/${SLUG}/orders/${code}/payment`, { body: { phone: '250788123456' } });

    behaviour = { ...behaviour, status: 'FAILED' };
    const poll = await call(who, 'GET', `/api/storefront/${SLUG}/orders/${code}/payment`);
    assert.equal((poll.body['payment'] as Record<string, unknown>)['status'], 'failed');

    behaviour = { ...behaviour, status: 'PENDING' };
    const retry = await call(who, 'POST', `/api/storefront/${SLUG}/orders/${code}/payment`, { body: { phone: '250788123456' } });
    assert.equal(retry.status, 202, 'a new attempt is allowed once the old one resolved');
    await who.close();
  });

  it('a webhook callback for a reference it never had does nothing (collections.refresh returns null)', async () => {
    const result = await collections.refresh('11111111-1111-1111-1111-111111111111');
    assert.equal(result, null);
  });
});
