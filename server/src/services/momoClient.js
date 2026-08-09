// Thin wrapper around the MTN MoMo Open API (Collections + Disbursements).
// Uses Node's built-in fetch (Node 18+) — no extra HTTP dependency needed.
//
// Every call that mutates money (requestToPay, transfer) is designed to be
// called with a reference ID that the CALLER already persisted (in
// momo_transactions) before calling this module — see walletService.js.
// That way, if the process crashes between "sent the request" and
// "recorded the result", the reconciliation sweep in settlementScheduler.js
// can still find it and check its real status with MoMo, instead of the
// transaction being silently lost.

const crypto = require('crypto');
const momo = require('../config/momo');

const tokenCache = { collection: null, disbursement: null };

/**
 * MoMo wants MSISDN digits only — no '+', no leading '00', no local trunk
 * prefix. Handles the three formats people actually type:
 *   "+250 78 000 0001"  -> "250780000001"  (international, spaced/punctuated)
 *   "0250780000001"     -> "250780000001"  (international via '00' prefix)
 *   "0780000001"        -> "250780000001"  (LOCAL format, the way someone
 *                                            would naturally write their own
 *                                            number — needs defaultCountryCode
 *                                            configured to convert correctly)
 */
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0') && momo.defaultCountryCode) {
    // A country code never legitimately starts with '0' (it's reserved as
    // a trunk prefix), so a leading 0 here always means "local format".
    digits = momo.defaultCountryCode + digits.slice(1);
  }
  return digits;
}

function generateReferenceId() {
  return crypto.randomUUID();
}

async function getToken(product) {
  const cached = tokenCache[product];
  if (cached && cached.expiresAt > Date.now() + 5000) {
    return cached.token;
  }

  momo.assertConfigured(product);
  const creds = momo[product];
  const basicAuth = Buffer.from(`${creds.apiUser}:${creds.apiKey}`).toString('base64');

  const res = await fetch(`${momo.baseUrl}/${product}/token/`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Ocp-Apim-Subscription-Key': creds.subscriptionKey,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MoMo ${product} token request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  tokenCache[product] = {
    token: data.access_token,
    expiresAt: Date.now() + (parseInt(data.expires_in, 10) || 3600) * 1000,
  };
  return data.access_token;
}

/**
 * Initiate a collection (customer pays the platform).
 * referenceId must be a UUID the caller generated and already persisted.
 * Returns immediately (MoMo replies 202 and processes async) — the caller
 * polls getRequestToPayStatus or waits for the callback.
 */
async function requestToPay({ amount, phone, referenceId, payerMessage, payeeNote, callbackUrl }) {
  const token = await getToken('collection');

  const res = await fetch(`${momo.baseUrl}/collection/v1_0/requesttopay`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Reference-Id': referenceId,
      'X-Target-Environment': momo.targetEnvironment,
      'Ocp-Apim-Subscription-Key': momo.collection.subscriptionKey,
      ...(callbackUrl ? { 'X-Callback-Url': callbackUrl } : {}),
    },
    body: JSON.stringify({
      amount: Number(amount).toFixed(2),
      currency: momo.currency,
      externalId: referenceId,
      payer: { partyIdType: 'MSISDN', partyId: normalizePhone(phone) },
      payerMessage: String(payerMessage || 'Order payment').slice(0, 160),
      payeeNote: String(payeeNote || 'Order payment').slice(0, 160),
    }),
  });

  if (res.status !== 202) {
    const body = await res.text().catch(() => '');
    throw new Error(`MoMo requestToPay failed (${res.status}): ${body}`);
  }

  return { referenceId };
}

/** status is one of PENDING | SUCCESSFUL | FAILED */
async function getRequestToPayStatus(referenceId) {
  const token = await getToken('collection');
  const res = await fetch(`${momo.baseUrl}/collection/v1_0/requesttopay/${referenceId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Target-Environment': momo.targetEnvironment,
      'Ocp-Apim-Subscription-Key': momo.collection.subscriptionKey,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MoMo requestToPay status check failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * Initiate a disbursement (platform pays a phone number) — used for both
 * tenant withdrawals and customer refunds.
 */
async function transfer({ amount, phone, referenceId, payerMessage, payeeNote, callbackUrl }) {
  const token = await getToken('disbursement');

  const res = await fetch(`${momo.baseUrl}/disbursement/v1_0/transfer`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Reference-Id': referenceId,
      'X-Target-Environment': momo.targetEnvironment,
      'Ocp-Apim-Subscription-Key': momo.disbursement.subscriptionKey,
      ...(callbackUrl ? { 'X-Callback-Url': callbackUrl } : {}),
    },
    body: JSON.stringify({
      amount: Number(amount).toFixed(2),
      currency: momo.currency,
      externalId: referenceId,
      payee: { partyIdType: 'MSISDN', partyId: normalizePhone(phone) },
      payerMessage: String(payerMessage || 'Payout').slice(0, 160),
      payeeNote: String(payeeNote || 'Payout').slice(0, 160),
    }),
  });

  if (res.status !== 202) {
    const body = await res.text().catch(() => '');
    throw new Error(`MoMo transfer failed (${res.status}): ${body}`);
  }

  return { referenceId };
}

async function getTransferStatus(referenceId) {
  const token = await getToken('disbursement');
  const res = await fetch(`${momo.baseUrl}/disbursement/v1_0/transfer/${referenceId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Target-Environment': momo.targetEnvironment,
      'Ocp-Apim-Subscription-Key': momo.disbursement.subscriptionKey,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MoMo transfer status check failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * Poll a status-check function until it resolves to SUCCESSFUL/FAILED or
 * times out. Sandbox transactions typically resolve within a few seconds
 * since there's no real subscriber approving a PIN prompt; production
 * transactions can take much longer, which is why this has a timeout and
 * callers must ALSO fall back to the periodic reconciliation sweep rather
 * than assuming this poll is the only chance to learn the outcome.
 */
async function pollUntilResolved(checkFn, { timeoutMs = 20000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  let last = { status: 'PENDING' };
  while (Date.now() - start < timeoutMs) {
    last = await checkFn();
    if (last.status === 'SUCCESSFUL' || last.status === 'FAILED') {
      return last;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return last;
}

module.exports = {
  normalizePhone,
  generateReferenceId,
  requestToPay,
  getRequestToPayStatus,
  transfer,
  getTransferStatus,
  pollUntilResolved,
};