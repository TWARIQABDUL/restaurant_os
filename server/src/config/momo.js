// MTN MoMo Open API configuration.
//
// Collections and Disbursements are SEPARATE products on the MoMo developer
// portal (momodeveloper.mtn.com) — you subscribe to each independently and
// get a separate subscription key + API user + API key for each.
//
// Sandbox setup (one-time, done on momodeveloper.mtn.com):
//   1. Sign up / sign in, subscribe to "Collections" and "Disbursements".
//   2. For EACH product, grab the Primary Key from "Manage subscriptions".
//   3. Create an API user:
//        POST {baseUrl}/v1_0/apiuser
//        Headers: X-Reference-Id: <new uuid v4>, Ocp-Apim-Subscription-Key: <primary key>
//        Body: { "providerCallbackHost": "<your-callback-domain>" }
//      The X-Reference-Id you generated IS the api user id — save it.
//   4. Create an API key for that user:
//        POST {baseUrl}/v1_0/apiuser/{apiUserId}/apikey
//      Save the returned apiKey.
//   5. Put all of this in your .env (see .env.example).
//
// Do this once for Collections credentials and once for Disbursements —
// they are independent identities even though they hit the same base URL.

const environment = process.env.MOMO_ENVIRONMENT || 'sandbox';
const baseUrl = process.env.MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com';

const config = {
  environment,
  baseUrl,
  targetEnvironment: environment === 'sandbox' ? 'sandbox' : (process.env.MOMO_TARGET_ENVIRONMENT || 'mtnrwanda'),
  currency: process.env.MOMO_CURRENCY || 'EUR', // sandbox only ever settles in EUR regardless of target market
  // Country code (no '+', no leading 0) to prepend when a phone number is
  // given in local format (e.g. "0780000001"). Required for local-format
  // numbers to normalize correctly — international-format input works
  // regardless of whether this is set.
  defaultCountryCode: process.env.MOMO_DEFAULT_COUNTRY_CODE || '',
  callbackHost: process.env.MOMO_CALLBACK_HOST || '',
  // Base HTTPS URL of THIS server, reachable from the internet, e.g.
  // "https://api.yourdomain.com". Optional — if unset, the system runs
  // purely on the polling/reconciliation sweep, which is fully correct
  // on its own, just slower to notice a result (up to ~1 scheduler tick).
  callbackUrlBase: process.env.MOMO_CALLBACK_URL_BASE || '',

  collection: {
    subscriptionKey: process.env.MOMO_COLLECTION_SUBSCRIPTION_KEY,
    apiUser: process.env.MOMO_COLLECTION_API_USER,
    apiKey: process.env.MOMO_COLLECTION_API_KEY,
  },
  disbursement: {
    subscriptionKey: process.env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY,
    apiUser: process.env.MOMO_DISBURSEMENT_API_USER,
    apiKey: process.env.MOMO_DISBURSEMENT_API_KEY,
  },

  // How long a paid order sits in escrow before it's eligible for release,
  // absent a pending refund request. Tenants can be switched to 'auto'
  // settlement (payout happens the instant funds are released) via
  // tenants.settings.payments.settlementMode — default is 'manual'
  // (admin has to click "Withdraw").
  holdMinutes: parseInt(process.env.MOMO_HOLD_MINUTES || '60', 10),

  // How often the settlement scheduler sweeps for reconciliation + release.
  schedulerIntervalMs: parseInt(process.env.MOMO_SCHEDULER_INTERVAL_MS || '60000', 10),
};

function assertConfigured(product) {
  const creds = config[product];
  const missing = ['subscriptionKey', 'apiUser', 'apiKey'].filter(k => !creds[k]);
  if (missing.length > 0) {
    throw new Error(
      `MoMo ${product} is not configured — missing env vars: ${missing
        .map(k => `MOMO_${product.toUpperCase()}_${k === 'subscriptionKey' ? 'SUBSCRIPTION_KEY' : k === 'apiUser' ? 'API_USER' : 'API_KEY'}`)
        .join(', ')}`
    );
  }
}

module.exports = { ...config, assertConfigured };