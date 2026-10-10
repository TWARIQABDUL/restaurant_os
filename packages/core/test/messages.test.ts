// packages/core/test/messages.test.ts — milestone 28: the email and SMS templates, as pure functions.
//
//   1. EVERY SMS FITS ONE MESSAGE for the board's own sample order — with the longest store name in the board's tweak set — because a
//      message that quietly becomes two is billed as two and arrives out of order.
//   2. THE BUTTON IS ALWAYS READABLE: dark text on a light brand colour, white on a dark one, the board's rule, by the theme engine's contrast.
//   3. NOTHING TYPED BY A STRANGER REACHES THE MARKUP UNESCAPED.
//   4. THE SENDER ID is letters only, at most eleven, and never empty.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CUSTOMER_MESSAGES, SMS_ONLY_MESSAGES, SMS_LIMIT, contrast, emailColours, renderCustomerEmail, renderEmailHtml, renderSms, sampleContext, senderId, smsFit } from '../src/index.ts';

const STORES = ['Nyama & Co.', 'Kigali Kicks', 'Run Rwanda', 'Inzu Threads Boutique & Home'];

describe('SMS', () => {
  it('every template fits one message for the sample order, for every store name', () => {
    for (const store of STORES) {
      for (const key of [...CUSTOMER_MESSAGES, ...SMS_ONLY_MESSAGES]) {
        const text = renderSms(key, sampleContext(store));
        // Platform messages are signed "Vendlyfy", not by the store; the longest customer one is the rider-on-the-way.
        const fit = smsFit(text);
        assert.ok(fit.fits, `${key} for ${store} is ${fit.count} characters: ${text}`);
      }
    }
  });

  it('says what the board says', () => {
    const c = sampleContext('Nyama & Co.');
    assert.equal(renderSms('confirm', c), 'Nyama & Co.: we got order #1026 (9,000 RWF). We’ll text when it’s accepted. Track: vndl.fy/k3x9');
    assert.equal(renderSms('assigned', c), 'Nyama & Co.: Eric (RAD 482 K) is on the way with #1026. Pay 9,000 RWF cash. Call: 078 455 9012');
    assert.equal(renderSms('kycOk', c), 'Vendlyfy: you’re verified. Payouts to MoMo 078•••4412 start tomorrow at 08:00.');
    assert.equal(renderSms('payoutFail', { ...c, reason: 'MoMo name mismatch' }), 'Vendlyfy: payout of 41,000 RWF failed (MoMo name mismatch). Money is back in your balance. Fix: vndl.fy/k3x9');
  });

  it('leaves out what it does not know instead of printing "undefined"', () => {
    for (const key of [...CUSTOMER_MESSAGES, ...SMS_ONLY_MESSAGES]) {
      const text = renderSms(key, { store: 'Nyama & Co.', number: 7 });
      assert.ok(!/undefined|null|NaN/.test(text), `${key}: ${text}`);
    }
    assert.equal(renderSms('assigned', { store: 'Nyama', number: 7, rider: 'Eric' }), 'Nyama: Eric is on the way with #7.');
    assert.equal(renderSms('rejected', { store: 'Nyama', number: 7, paid: false }), 'Nyama couldn’t take order #7.');
  });

  it('counts characters, not bytes, and says when it would be split', () => {
    assert.deepEqual(smsFit('é'.repeat(160)), { count: 160, fits: true, parts: 1 });
    assert.deepEqual(smsFit('x'.repeat(161)), { count: 161, fits: false, parts: 2 });
    assert.equal(SMS_LIMIT, 160);
  });
});

describe('sender id', () => {
  it('is letters, uppercase, at most eleven, and never empty', () => {
    assert.equal(senderId('Nyama & Co.'), 'NYAMACO');
    assert.equal(senderId('Café Müller'), 'CAFEMULLER');
    assert.equal(senderId('Inzu Threads Boutique'), 'INZUTHREADS');
    assert.equal(senderId('24/7'), 'VENDLYFY');
    assert.equal(senderId('日本'), 'VENDLYFY');
  });
});

describe('the email', () => {
  it('the button text is readable on every brand colour in the board’s set, light or dark', () => {
    for (const brand of ['#1D6B47', '#E4572E', '#C6F432', '#17160F', '#FFFFFF', '#F4D35E', '#2A55A0']) {
      const c = emailColours(brand);
      assert.ok(contrast(c.button, c.onButton) >= 4.5, `${brand} → ${c.onButton}: ${contrast(c.button, c.onButton).toFixed(2)}`);
    }
    assert.equal(emailColours('#C6F432').onButton, '#17160F', 'lime flips to dark text');
    assert.equal(emailColours('#1D6B47').onButton, '#FFFFFF', 'green keeps white');
  });

  it('carries the store’s name, colour and the order, and the cash line only for cash', () => {
    const c = sampleContext('Nyama & Co.');
    const email = renderCustomerEmail('assigned', c);
    assert.equal(email.subject, 'Eric is bringing your order · #1026');
    assert.equal(email.payLabel, 'cash on delivery');
    assert.equal(renderCustomerEmail('assigned', { ...c, cashDue: undefined }).payLabel, 'MTN MoMo');
    const html = renderEmailHtml(email, { name: 'Nyama & Co.', mark: 'N', phone: '078 812 3456', brand: '#1D6B47' }, { number: 1026, placedAt: 'Wed 23 Sep, 13:58', lines: [{ quantity: 2, name: 'Chicken burger', amount: '7,000 RWF' }], delivery: '2,000 RWF', total: '9,000 RWF' }, 'https://x.test/t');
    assert.ok(html.includes('background:#1D6B47') && html.includes('Nyama &amp; Co.') && html.includes('Total · cash on delivery') && html.includes('078 812 3456'));
    assert.ok(html.includes('Order emails can’t be turned off.'));
  });

  it('escapes everything a stranger can type', () => {
    const email = renderCustomerEmail('confirm', { ...sampleContext('<b>Evil</b>'), customer: '<script>alert(1)</script>' });
    const html = renderEmailHtml(email, { name: '<b>Evil</b>', mark: '"><img src=x>', phone: null, brand: '#1D6B47' }, { number: 1, placedAt: 'now', lines: [{ quantity: 1, name: '<img onerror=x>', amount: '1' }], delivery: null, total: '1' }, 'https://x.test/?a="b"');
    assert.ok(!html.includes('<script>') && !html.includes('<img') && !html.includes('<b>Evil'), html);
    assert.ok(html.includes('&lt;script&gt;') && html.includes('&quot;'));
  });
});
