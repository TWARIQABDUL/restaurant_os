// Verifies module wiring: every function these files call on each other
// actually exists and is the right type. This catches "renamed a function
// in one file and forgot the other" bugs that node --check can't see,
// since --check only validates syntax, not that referenced identifiers
// resolve to something real at the point of use.

process.env.VITE_SUPABASE_URL = 'http://localhost:9999';
process.env.VITE_SUPABASE_ANON_KEY = 'dummy';
process.env.JWT_SECRET = 'dummy';
process.env.MOMO_DEFAULT_COUNTRY_CODE = '250';

const assert = require('assert');

console.log('Loading momo config...');
const momoConfig = require('./src/config/momo');
assert.strictEqual(typeof momoConfig.assertConfigured, 'function');
assert.strictEqual(typeof momoConfig.holdMinutes, 'number');
assert.strictEqual(typeof momoConfig.schedulerIntervalMs, 'number');
console.log('  OK');

console.log('Loading momoClient...');
const momoClient = require('./src/services/momoClient');
for (const fn of ['normalizePhone', 'generateReferenceId', 'requestToPay', 'getRequestToPayStatus', 'transfer', 'getTransferStatus', 'pollUntilResolved']) {
  assert.strictEqual(typeof momoClient[fn], 'function', `momoClient.${fn} should be a function`);
}
assert.strictEqual(momoClient.normalizePhone('+250 78 000 0001'), '250780000001', 'international with punctuation');
assert.strictEqual(momoClient.normalizePhone('00250780000001'), '250780000001', 'international via 00 prefix');
assert.strictEqual(momoClient.normalizePhone('0780000001'), '250780000001', 'LOCAL format with leading 0 - the way someone types their own number');
assert.strictEqual(typeof momoClient.generateReferenceId(), 'string');
assert.notStrictEqual(momoClient.generateReferenceId(), momoClient.generateReferenceId(), 'reference ids must be unique per call');
console.log('  OK');

console.log('Loading walletService...');
const walletService = require('./src/services/walletService');
for (const fn of [
  'initiateOrderPayment', 'reconcilePendingCollections', 'reconcilePendingDisbursements',
  'releaseEligibleOrders', 'requestWithdrawal', 'maybeAutoPayout', 'approveRefund', 'rejectRefund',
  'recheckCollection', 'recheckDisbursement', 'getWallet', 'getLedger', 'getWithdrawals',
]) {
  assert.strictEqual(typeof walletService[fn], 'function', `walletService.${fn} should be a function`);
}
console.log('  OK — all 13 exports present and callable');

console.log('Loading settlementScheduler...');
const scheduler = require('./src/services/settlementScheduler');
for (const fn of ['start', 'stop', 'tick']) {
  assert.strictEqual(typeof scheduler[fn], 'function');
}
console.log('  OK');

console.log('Loading route modules (checking they export an Express router)...');
for (const mod of ['./src/routes/wallet', './src/routes/refunds', './src/routes/momoWebhook']) {
  const router = require(mod);
  assert.strictEqual(typeof router, 'function', `${mod} should export an Express router (a function)`);
  assert.ok(router.stack && router.stack.length > 0, `${mod} should have registered at least one route`);
  console.log(`  ${mod}: ${router.stack.length} route(s) registered - OK`);
}

console.log('\nLoading full app.js (registers every route, including modified orders.js/tenants.js)...');
const app = require('./src/app');
assert.strictEqual(typeof app, 'function');
console.log('  OK — app assembled with no missing requires or wiring errors');

console.log('\nALL WIRING CHECKS PASSED');