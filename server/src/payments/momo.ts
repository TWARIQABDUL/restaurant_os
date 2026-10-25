// server/src/payments/momo.ts — milestone 17.
//
// THE COLLECTION HALF (requestToPay, collectionStatus) IS ORPHANED since 2026-10-25 — checkout moved to
// Urubuto Pay (payments/urubuto.ts, repositories/collections.ts). Kept, not deleted: routes/momoWebhook.ts
// still imports isConfigured() for its now-dead collection callback (see that file's header), and deleting
// working, tested code that costs nothing to keep is not this change's job. The DISBURSEMENT half below is
// very much alive — payouts stay on MTN MoMo; see payments/disbursements.ts for the provider-selection
// shim that will let that move later without a deploy.
//
// The MTN MoMo Collections client, carried across from server/src/services/momoClient.js.
//
// §1.2 lists this under what DOES NOT CHANGE: "the MTN MoMo integration including the webhook that
// re-verifies status rather than trusting its callback". So this is a port, not a rewrite — the request
// shapes, the header names, the token cache and the phone normalisation are the legacy module's, because
// they are what MTN's sandbox and production actually accept and that knowledge was paid for once.
//
// WHAT CHANGED IN THE PORT, and only this: types, and the disbursement half is left behind. Disbursements
// are payouts and refunds, which belong to the merchant console rather than to checkout; bringing them now
// would be code with no caller.
//
// THE CALLBACK IS NOT TRUSTED, which is the part of the legacy design worth repeating in full: MTN's
// callback is unsigned, so anybody who guesses a reference id could otherwise post a "SUCCESSFUL" result and
// be believed. The callback is a "check now" nudge; the status is then re-read from MoMo's authenticated
// endpoint. routes/momoWebhook.ts is where that happens.
//
// THE REFERENCE ID IS THE PROVIDER'S IDEMPOTENCY KEY and the caller has already persisted it in
// `momo_transactions` before calling here. That ordering is what lets a crash between "sent" and "recorded"
// be recovered: the row exists, so the status can be re-read. Generating one inside this module would make
// that impossible, which is why it does not.

import { randomUUID } from 'node:crypto';

export type MomoStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

export type MomoConfig = {
  baseUrl: string;
  targetEnvironment: string;
  /** The sandbox only ever settles in EUR whatever market it targets — the legacy module's own note. */
  currency: string;
  /** Prefixed to a locally-formatted number. Without it, "078…" cannot be normalised correctly. */
  defaultCountryCode: string;
  /** Base HTTPS URL of THIS server, reachable from the internet. Optional; absent means polling only. */
  callbackUrlBase: string;
  subscriptionKey: string;
  apiUser: string;
  apiKey: string;
  /** Paying a merchant out is a different MTN product with its own subscription and API user. */
  disbursement: { subscriptionKey: string; apiUser: string; apiKey: string };
};

export type Product = 'collection' | 'disbursement';

/**
 * Read from the environment on each call rather than at module load.
 *
 * Milestone 11 found that a module-scope `process.env` read initialises BEFORE the entrypoint loads `.env`,
 * which made three tuning variables silently inert. Same trap, same fix.
 */
export function momoConfig(): MomoConfig {
  const environment = process.env['MOMO_ENVIRONMENT'] ?? 'sandbox';
  return {
    baseUrl: process.env['MOMO_BASE_URL'] ?? 'https://sandbox.momodeveloper.mtn.com',
    targetEnvironment:
      environment === 'sandbox' ? 'sandbox' : (process.env['MOMO_TARGET_ENVIRONMENT'] ?? 'mtnrwanda'),
    currency: process.env['MOMO_CURRENCY'] ?? 'EUR',
    defaultCountryCode: process.env['MOMO_DEFAULT_COUNTRY_CODE'] ?? '',
    callbackUrlBase: process.env['MOMO_CALLBACK_URL_BASE'] ?? '',
    subscriptionKey: process.env['MOMO_COLLECTION_SUBSCRIPTION_KEY'] ?? '',
    apiUser: process.env['MOMO_COLLECTION_API_USER'] ?? '',
    apiKey: process.env['MOMO_COLLECTION_API_KEY'] ?? '',
    disbursement: {
      subscriptionKey: process.env['MOMO_DISBURSEMENT_SUBSCRIPTION_KEY'] ?? '',
      apiUser: process.env['MOMO_DISBURSEMENT_API_USER'] ?? '',
      apiKey: process.env['MOMO_DISBURSEMENT_API_KEY'] ?? '',
    },
  };
}

/** Whether a payout can be attempted at all. Checked BEFORE funds are reserved — see repositories/payouts.ts. */
export function isDisbursementConfigured(config: MomoConfig = momoConfig()): boolean {
  const d = config.disbursement;
  return d.subscriptionKey !== '' && d.apiUser !== '' && d.apiKey !== '';
}

/** Whether a collection can be attempted at all. Part 9: where provider credentials live is still open. */
export function isConfigured(config: MomoConfig = momoConfig()): boolean {
  return config.subscriptionKey !== '' && config.apiUser !== '' && config.apiKey !== '';
}

export class MomoNotConfigured extends Error {
  constructor() {
    super(
      'MTN MoMo is not configured: MOMO_COLLECTION_SUBSCRIPTION_KEY, MOMO_COLLECTION_API_USER and ' +
        'MOMO_COLLECTION_API_KEY are all required.',
    );
    this.name = 'MomoNotConfigured';
  }
}

/**
 * MoMo wants MSISDN digits only — no '+', no leading '00', no local trunk prefix. The three formats people
 * actually type, from the legacy module:
 *
 *   "+250 78 000 0001"  -> "250780000001"   international, spaced or punctuated
 *   "0250780000001"     -> "250780000001"   international via a '00' prefix
 *   "0780000001"        -> "250780000001"   LOCAL, the way somebody writes their own number
 *
 * The last one needs defaultCountryCode. A country code never legitimately starts with '0' — it is reserved
 * as a trunk prefix — so a leading zero here always means local format.
 */
export function normalizePhone(phone: string, config: MomoConfig = momoConfig()): string {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0') && config.defaultCountryCode !== '') {
    digits = config.defaultCountryCode + digits.slice(1);
  }
  return digits;
}

/** A reference id for a new attempt. Persisted by the caller BEFORE the request goes out — see the header. */
export function newReferenceId(): string {
  return randomUUID();
}

type CachedToken = { token: string; expiresAt: number };
const tokenCache: Record<Product, CachedToken | null> = { collection: null, disbursement: null };

function credentials(config: MomoConfig, product: Product): { subscriptionKey: string; apiUser: string; apiKey: string } {
  return product === 'collection'
    ? { subscriptionKey: config.subscriptionKey, apiUser: config.apiUser, apiKey: config.apiKey }
    : config.disbursement;
}

async function token(config: MomoConfig, product: Product = 'collection'): Promise<string> {
  const cached = tokenCache[product];
  if (cached !== null && cached.expiresAt > Date.now() + 5_000) return cached.token;
  if (product === 'collection' ? !isConfigured(config) : !isDisbursementConfigured(config)) throw new MomoNotConfigured();

  const c = credentials(config, product);
  const basic = Buffer.from(`${c.apiUser}:${c.apiKey}`).toString('base64');
  const res = await fetch(`${config.baseUrl}/${product}/token/`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Ocp-Apim-Subscription-Key': c.subscriptionKey },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MoMo ${product} token request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: string | number };
  const value = data.access_token;
  if (typeof value !== 'string' || value === '') throw new Error('MoMo returned no access token');
  const ttl = Number(data.expires_in) || 3600;
  tokenCache[product] = { token: value, expiresAt: Date.now() + ttl * 1000 };
  return value;
}

/** Cleared between tests, and after a credential change. */
export function clearTokenCache(): void {
  tokenCache.collection = null;
  tokenCache.disbursement = null;
}

/**
 * Ask a customer to approve a payment. Returns as soon as MoMo accepts the request (202); the outcome
 * arrives later, through the callback or a status re-read.
 */
export async function requestToPay(
  input: { amount: string; phone: string; referenceId: string; payerMessage?: string; payeeNote?: string },
  config: MomoConfig = momoConfig(),
): Promise<void> {
  const access = await token(config);
  const callbackUrl =
    config.callbackUrlBase === ''
      ? undefined
      : `${config.callbackUrlBase}/api/momo/callback/collection/${input.referenceId}`;

  const res = await fetch(`${config.baseUrl}/collection/v1_0/requesttopay`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
      'X-Reference-Id': input.referenceId,
      'X-Target-Environment': config.targetEnvironment,
      'Ocp-Apim-Subscription-Key': config.subscriptionKey,
      ...(callbackUrl === undefined ? {} : { 'X-Callback-Url': callbackUrl }),
    },
    body: JSON.stringify({
      // The amount arrives here as a decimal string from the database and is NOT put through a float on
      // the way, which is the one thing the legacy version did that this does not.
      amount: input.amount,
      currency: config.currency,
      externalId: input.referenceId,
      payer: { partyIdType: 'MSISDN', partyId: normalizePhone(input.phone, config) },
      payerMessage: (input.payerMessage ?? 'Order payment').slice(0, 160),
      payeeNote: (input.payeeNote ?? 'Order payment').slice(0, 160),
    }),
  });

  if (res.status !== 202) {
    const body = await res.text().catch(() => '');
    throw new Error(`MoMo requestToPay failed (${res.status}): ${body}`);
  }
}

/** The real status, read from MoMo's authenticated endpoint. The only thing that is believed. */
export async function collectionStatus(
  referenceId: string,
  config: MomoConfig = momoConfig(),
): Promise<{ status: MomoStatus; reason: string | null }> {
  const access = await token(config);
  const res = await fetch(`${config.baseUrl}/collection/v1_0/requesttopay/${referenceId}`, {
    headers: {
      Authorization: `Bearer ${access}`,
      'X-Target-Environment': config.targetEnvironment,
      'Ocp-Apim-Subscription-Key': config.subscriptionKey,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MoMo status check failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { status?: string; reason?: unknown };
  const status: MomoStatus =
    data.status === 'SUCCESSFUL' || data.status === 'FAILED' ? data.status : 'PENDING';
  const reason =
    typeof data.reason === 'string'
      ? data.reason
      : typeof data.reason === 'object' && data.reason !== null && 'message' in data.reason
        ? String((data.reason as { message: unknown }).message)
        : null;
  return { status, reason };
}

// ---------------------------------------------------------------------------
// Disbursements — paying a merchant out. Milestone 23.
// ---------------------------------------------------------------------------

/**
 * A payout MoMo REFUSED, as opposed to one it never answered. The difference decides everything downstream:
 * a refusal (HTTP 4xx — a number that is not registered, a malformed request) is definitive, so the money can
 * go straight back to Available. A network failure or a 5xx is NOT: the request may have reached MTN and the
 * response been lost, and returning the money then risks paying out twice. Those are left `processing` for
 * the status re-read to decide.
 */
export class DisbursementRefused extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`MoMo refused the transfer (${status}): ${body}`);
    this.name = 'DisbursementRefused';
    this.status = status;
  }
}

/**
 * Pay a phone number. Returns when MoMo accepts the request (202); the outcome arrives later.
 *
 * `referenceId` is X-Reference-Id, MTN's own idempotency key, and the caller wrote it to momo_transactions
 * BEFORE this call — so a repeat of this call for the same reference cannot pay twice.
 */
export async function transfer(
  input: { amount: string; phone: string; referenceId: string; payerMessage?: string; payeeNote?: string },
  config: MomoConfig = momoConfig(),
): Promise<void> {
  const access = await token(config, 'disbursement');
  const callbackUrl =
    config.callbackUrlBase === ''
      ? undefined
      : `${config.callbackUrlBase}/api/momo/callback/disbursement/${input.referenceId}`;

  const res = await fetch(`${config.baseUrl}/disbursement/v1_0/transfer`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
      'X-Reference-Id': input.referenceId,
      'X-Target-Environment': config.targetEnvironment,
      'Ocp-Apim-Subscription-Key': config.disbursement.subscriptionKey,
      ...(callbackUrl === undefined ? {} : { 'X-Callback-Url': callbackUrl }),
    },
    body: JSON.stringify({
      amount: input.amount,
      currency: config.currency,
      externalId: input.referenceId,
      payee: { partyIdType: 'MSISDN', partyId: normalizePhone(input.phone, config) },
      payerMessage: (input.payerMessage ?? 'Vendlyfy payout').slice(0, 160),
      payeeNote: (input.payeeNote ?? 'Vendlyfy payout').slice(0, 160),
    }),
  });

  if (res.status === 202) return;
  const body = await res.text().catch(() => '');
  // 409 is "that reference already exists": the transfer WAS accepted earlier, so this is not a refusal.
  if (res.status === 409) return;
  if (res.status >= 400 && res.status < 500) throw new DisbursementRefused(res.status, body);
  throw new Error(`MoMo transfer failed (${res.status}): ${body}`);
}

/** The real state of a payout, from MoMo's authenticated endpoint. `unknown` is a 404: it was never sent. */
export async function transferStatus(
  referenceId: string,
  config: MomoConfig = momoConfig(),
): Promise<{ status: MomoStatus | 'UNKNOWN'; reason: string | null }> {
  const access = await token(config, 'disbursement');
  const res = await fetch(`${config.baseUrl}/disbursement/v1_0/transfer/${referenceId}`, {
    headers: {
      Authorization: `Bearer ${access}`,
      'X-Target-Environment': config.targetEnvironment,
      'Ocp-Apim-Subscription-Key': config.disbursement.subscriptionKey,
    },
  });

  if (res.status === 404) return { status: 'UNKNOWN', reason: null };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MoMo transfer status check failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { status?: string; reason?: unknown };
  const status: MomoStatus = data.status === 'SUCCESSFUL' || data.status === 'FAILED' ? data.status : 'PENDING';
  const reason =
    typeof data.reason === 'string'
      ? data.reason
      : typeof data.reason === 'object' && data.reason !== null && 'message' in data.reason
        ? String((data.reason as { message: unknown }).message)
        : null;
  return { status, reason };
}

/** How long a paid order sits in Pending before the sweep moves it to Available. The legacy server's knob. */
export function holdMinutes(): number {
  const n = Number(process.env['MOMO_HOLD_MINUTES']);
  return Number.isInteger(n) && n >= 0 ? n : 60;
}
