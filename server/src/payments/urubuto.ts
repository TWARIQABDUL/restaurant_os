// server/src/payments/urubuto.ts — milestone 17's successor, decided 2026-10-25.
//
// THE COLLECTIONS CLIENT, replacing MTN MoMo (payments/momo.ts) for checkout. Ported from a working
// reference integration (a NestJS payment service, not this codebase) rather than built from the API
// docs alone, because the reference project's own code comments record real-world quirks the docs don't:
// a 409 response body can carry `status: 401`; `payer_code` must be an invoice number, not our own id;
// a repeated `transaction_id` is itself the idempotency key.
//
// SAME DESIGN AS MOMO.TS, ON PURPOSE: no DB access here (repositories/collections.ts owns that), config
// read on every call (not at module load — the `.env`-after-imports trap milestone 11 found), a definitive
// (4xx) vs ambiguous (timeout/network/5xx) error split, and a reference id the CALLER generates and persists
// before any request goes out. What's different, because Urubuto Pay's API is shaped differently from
// MTN's:
//
//   TWO CALLS, NOT ONE. MTN's requestToPay takes one call. Urubuto Pay needs an invoice first
//   (POST /v2/invoice/create — no idempotency key, never retried on an unknown outcome) and then a payment
//   initiated against it (POST /v2/payment/initiate — idempotent on OUR transaction_id, safe to retry).
//
//   ONE STATIC API KEY, not a Basic-auth token exchange per product. Sent as both `Authorization` and
//   `x-api-key` — the reference project's own comment: "the reference says Authorization: upg:… in prose
//   but declares an x-api-key security scheme in the OpenAPI spec. We send both until UrubutoPay confirms."
//
// THE WEBHOOK STILL DOES NOT TRUST THE CALLBACK BODY, even though Urubuto Pay's callbacks are authenticated
// (routes/urubutoWebhook.ts issues the JWT it later verifies) — decided 2026-10-25: the callback is a nudge
// to re-check the authenticated status endpoint, same as MoMo's, because the reference project's own code
// documents payload quirks (e.g. `transaction_id` sometimes holding Urubuto's own reference instead of
// ours) that are not worth trusting for money.

export type UrubutoConfig = {
  baseUrl: string;
  apiKey: string;
  merchantCode: string;
  serviceCode: string;
  timeoutMs: number;
};

/** Read from the environment on each call — see momo.ts's header for why. */
export function urubutoConfig(): UrubutoConfig {
  const timeout = Number(process.env['URUBUTO_HTTP_TIMEOUT_MS']);
  return {
    baseUrl: (process.env['URUBUTO_BASE_URL'] ?? '').replace(/\/+$/, ''),
    apiKey: process.env['URUBUTO_API_KEY'] ?? '',
    merchantCode: process.env['URUBUTO_MERCHANT_CODE'] ?? '',
    serviceCode: process.env['URUBUTO_SERVICE_CODE'] ?? '',
    timeoutMs: Number.isInteger(timeout) && timeout >= 1000 && timeout <= 60000 ? timeout : 15000,
  };
}

export function isConfigured(config: UrubutoConfig = urubutoConfig()): boolean {
  return config.baseUrl !== '' && config.apiKey !== '' && config.merchantCode !== '' && config.serviceCode !== '';
}

export class UrubutoNotConfigured extends Error {
  constructor() {
    super('Urubuto Pay is not configured: URUBUTO_BASE_URL, URUBUTO_API_KEY, URUBUTO_MERCHANT_CODE and URUBUTO_SERVICE_CODE are all required.');
    this.name = 'UrubutoNotConfigured';
  }
}

// ---------------------------------------------------------------------------
// Errors — the definitive (4xx) vs ambiguous (timeout/network/5xx) split collections.ts relies on.
// ---------------------------------------------------------------------------

export class UrubutoError extends Error {
  readonly httpStatus: number | undefined;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'UrubutoError';
    this.httpStatus = httpStatus;
  }
}
/** The request was malformed. Definitive — retrying the same body will not help. */
export class UrubutoValidationError extends UrubutoError {}
/** The API key, merchant code or service code was refused. Definitive. */
export class UrubutoAuthError extends UrubutoError {}
/** The thing asked about does not exist at Urubuto Pay (e.g. a transaction/invoice id it never saw). */
export class UrubutoNotFoundError extends UrubutoError {}
/** "Already exists" — collections.ts treats this as success, not a refusal (see initiatePayment). */
export class UrubutoConflictError extends UrubutoError {}
/** 5xx. Ambiguous — the request may have been processed; only retry calls an idempotency key makes safe. */
export class UrubutoServerError extends UrubutoError {}
/** No answer within the timeout. Ambiguous, same reasoning as UrubutoServerError. */
export class UrubutoTimeoutError extends UrubutoError {}
/** Could not reach Urubuto Pay at all (DNS, connection refused, …). Ambiguous. */
export class UrubutoNetworkError extends UrubutoError {}
/** A 2xx response whose body does not have the shape this client asked for. */
export class UrubutoUnexpectedResponseError extends UrubutoError {}

type Envelope<T> = { timestamp: string; status: number; message?: string; data: T };

const RETRY_BASE_DELAY_MS = 250;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Extra attempts after a timeout, network failure or 5xx. Only pass this for an idempotent call. */
async function post<T>(path: string, body: object, config: UrubutoConfig, retries = 0): Promise<Envelope<T>> {
  if (!isConfigured(config)) throw new UrubutoNotConfigured();
  const attempts = 1 + Math.max(0, retries);
  let lastError: UrubutoError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await send<T>(path, body, config);
    } catch (err) {
      if (!(err instanceof UrubutoError)) throw err;
      lastError = err;
      const retryable = err instanceof UrubutoTimeoutError || err instanceof UrubutoNetworkError || err instanceof UrubutoServerError;
      if (!retryable || attempt === attempts) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError!;
}

async function send<T>(path: string, body: object, config: UrubutoConfig): Promise<Envelope<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      // The reference says `Authorization: upg:…` in prose but declares an `x-api-key` security scheme
      // in the OpenAPI spec — sent as both until Urubuto Pay confirms which one it actually reads.
      headers: { Authorization: config.apiKey, 'x-api-key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw new UrubutoTimeoutError(`Urubuto Pay did not answer ${path} within ${config.timeoutMs}ms`);
    throw new UrubutoNetworkError(`Could not reach Urubuto Pay for ${path}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => '');
  let json: Record<string, unknown> | undefined;
  try {
    const parsed = text === '' ? undefined : JSON.parse(text);
    json = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    json = undefined;
  }

  // Urubuto Pay sometimes returns HTTP 409 with a body whose own `status` is 401 — the body wins.
  const bodyStatus = typeof json?.['status'] === 'number' ? (json['status'] as number) : undefined;
  const status = bodyStatus !== undefined && bodyStatus >= 400 ? bodyStatus : response.status;

  if (status >= 400) {
    const message = typeof json?.['message'] === 'string' ? (json['message'] as string) : `Urubuto Pay returned ${status}`;
    if (status === 400) throw new UrubutoValidationError(message, response.status);
    if (status === 401 || status === 403) throw new UrubutoAuthError(message, response.status);
    if (status === 404) throw new UrubutoNotFoundError(message, response.status);
    if (status === 409) throw new UrubutoConflictError(message, response.status);
    if (status >= 500) throw new UrubutoServerError(message, response.status);
    throw new UrubutoError(message, response.status);
  }

  if (json === undefined || typeof json['data'] !== 'object' || json['data'] === null) {
    throw new UrubutoUnexpectedResponseError(`Unexpected response shape from ${path}`, response.status);
  }
  return json as Envelope<T>;
}

/** `0781234567`, `781234567`, `+250 781-234-567` -> `250781234567`. Other numbers are only cleaned. */
export function normalizePhone(raw: string): string {
  let digits = String(raw ?? '').replace(/[\s+()-]/g, '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(digits)) digits = `250${digits.slice(1)}`;
  else if (/^7\d{8}$/.test(digits)) digits = `250${digits}`;
  return digits;
}

// ---------------------------------------------------------------------------
// Invoice — POST /v2/invoice/create. No idempotency key: never retried on an unknown outcome.
// ---------------------------------------------------------------------------

export async function createInvoice(
  input: { phone: string; amount: string; currency: string },
  config: UrubutoConfig = urubutoConfig(),
): Promise<string> {
  const { data } = await post<{ invoice_number: string }>(
    '/v2/invoice/create',
    {
      merchant_code: config.merchantCode,
      service_code: config.serviceCode,
      payer_phone_number: normalizePhone(input.phone),
      amount: Number(input.amount),
      currency: input.currency,
      allow_custom_amount: false,
    },
    config,
    // deliberately no retries
  );
  if (typeof data.invoice_number !== 'string' || data.invoice_number === '') {
    throw new UrubutoUnexpectedResponseError('Create-invoice response has no invoice_number');
  }
  return data.invoice_number;
}

// ---------------------------------------------------------------------------
// Payment — POST /v2/payment/initiate. Idempotent on `transactionId` (OUR reference id).
// ---------------------------------------------------------------------------

export type InitiateResult = { alreadyInitiated: boolean };

export async function initiatePayment(
  input: { invoiceNumber: string; transactionId: string; phone: string; amount: string; payerName: string; payerEmail: string },
  config: UrubutoConfig = urubutoConfig(),
): Promise<InitiateResult> {
  const body = {
    merchant_code: config.merchantCode,
    service_code: config.serviceCode,
    payer_code: input.invoiceNumber,
    payer_names: input.payerName.trim() === '' ? 'Customer' : input.payerName.trim(),
    payer_email: input.payerEmail,
    amount: Number(input.amount),
    channel_name: 'MOMO',
    phone_number: normalizePhone(input.phone),
    transaction_id: input.transactionId,
  };
  try {
    // Safe to retry on a timeout or 5xx: the same transaction_id never creates a second payment.
    await post<{ internal_transaction_ref_number?: string }>('/v2/payment/initiate', body, config, 2);
    return { alreadyInitiated: false };
  } catch (err) {
    if (err instanceof UrubutoConflictError && /already exist/i.test(err.message)) return { alreadyInitiated: true };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Status — POST /v2/payment/transaction/status. Read-only, safe to retry. The only thing believed.
// ---------------------------------------------------------------------------

export type UrubutoStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

/** `null` = Urubuto Pay has never heard of this transaction_id (never initiated, or lost before this call). */
export async function paymentStatus(
  transactionId: string,
  config: UrubutoConfig = urubutoConfig(),
): Promise<{ status: UrubutoStatus; reason: string | null } | null> {
  try {
    const { data } = await post<{ transaction_status?: string; reason?: unknown }>(
      '/v2/payment/transaction/status',
      { merchant_code: config.merchantCode, transaction_id: transactionId },
      config,
      2,
    );
    // Real-world values seen by the reference integration: PENDING, PENDING_SETTLEMENT, VALID, FAILED —
    // docs claim SUCCESSFUL/FAILED/PENDING. PENDING_SETTLEMENT is treated as paid (money has been taken);
    // VALID (full settlement) is not required for this to count as paid — matches MoMo's "paid at" meaning.
    const raw = data.transaction_status;
    const status: UrubutoStatus = raw === 'SUCCESSFUL' || raw === 'VALID' || raw === 'PENDING_SETTLEMENT' ? 'SUCCESSFUL' : raw === 'FAILED' ? 'FAILED' : 'PENDING';
    const reason = typeof data.reason === 'string' ? data.reason : null;
    return { status, reason };
  } catch (err) {
    if (err instanceof UrubutoNotFoundError) return null;
    throw err;
  }
}
