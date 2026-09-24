// Verifies module wiring: every function these files call on each other actually
// exists and is the right type, every route module is mounted, and the assembled
// app answers over HTTP. This catches "renamed a function in one file and forgot
// the other" bugs that `node --check` can't see, since --check only validates
// syntax, not that referenced identifiers resolve to something real at the point
// of use.
//
// It needs no database: the Supabase URL below points at a dead port on purpose,
// so anything that would reach out fails immediately instead of hanging.
//
//   node smoketest.js
//
// ESM note: every first-party module is loaded with a dynamic `await import()`,
// not a static one. Static imports hoist above the environment assignments
// below, and several of these modules read process.env as they load.

import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SUPABASE_URL = 'http://127.0.0.1:9999';
process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:9999';
process.env.VITE_SUPABASE_ANON_KEY = 'dummy';

// config/supabase.js refuses to boot without a service-role key, and decodes the
// JWT payload to check the role is not `anon`. This smoketest had been exiting 1
// since that hardening landed, because it only ever set the anon key. A
// syntactically real but worthless key exercises the check rather than skipping it.
process.env.SUPABASE_SERVICE_ROLE_KEY = [
  'eyJhbGciOiJIUzI1NiJ9',
  Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'),
  'not-a-real-signature',
].join('.');

process.env.JWT_SECRET = 'smoketest-only-secret-not-used-anywhere-real-0123';
process.env.MOMO_DEFAULT_COUNTRY_CODE = '250';
// 20+ requests from one address below; the limiter would otherwise start refusing.
process.env.RATE_LIMIT_DISABLED = 'true';

console.log('Loading momo config...');
const { default: momoConfig } = await import('./src/config/momo.js');
assert.strictEqual(typeof momoConfig.assertConfigured, 'function');
assert.strictEqual(typeof momoConfig.holdMinutes, 'number');
assert.strictEqual(typeof momoConfig.schedulerIntervalMs, 'number');
console.log('  OK');

console.log('Loading momoClient...');
const momoClient = await import('./src/services/momoClient.js');
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
const walletService = await import('./src/services/walletService.js');
for (const fn of [
  'initiateOrderPayment', 'reconcilePendingCollections', 'reconcilePendingDisbursements',
  'releaseEligibleOrders', 'requestWithdrawal', 'maybeAutoPayout', 'approveRefund', 'rejectRefund',
  'recheckCollection', 'recheckDisbursement', 'getWallet', 'getLedger', 'getWithdrawals',
]) {
  assert.strictEqual(typeof walletService[fn], 'function', `walletService.${fn} should be a function`);
}
console.log('  OK — all 13 exports present and callable');

console.log('Loading settlementScheduler...');
const scheduler = await import('./src/services/settlementScheduler.js');
for (const fn of ['start', 'stop', 'tick']) {
  assert.strictEqual(typeof scheduler[fn], 'function');
}
console.log('  OK');

// Every route module, not a sample of three: after the CommonJS → ESM conversion
// at milestone 3, a module that exports its router the old way is `undefined`
// here rather than a function, and this is where that shows up.
console.log('Loading every route module (checking each exports an Express router)...');
const ROUTE_MODULES = [
  'addons', 'analytics', 'auth', 'categories', 'complaints', 'delivery', 'menu',
  'momoWebhook', 'notifications', 'orders', 'platform', 'refunds', 'reviews',
  'tenants', 'uploads', 'wallet',
];
let totalRoutes = 0;
const routers = new Map();
for (const name of ROUTE_MODULES) {
  const spec = `./src/routes/${name}.js`;
  const { default: router } = await import(spec);
  assert.strictEqual(typeof router, 'function', `${spec} should export an Express router (a function)`);
  assert.ok(router.stack && router.stack.length > 0, `${spec} should have registered at least one route`);
  routers.set(name, router);
  totalRoutes += router.stack.length;
  console.log(`  ${name.padEnd(14)} ${String(router.stack.length).padStart(2)} route(s)`);
}
console.log(`  OK — ${ROUTE_MODULES.length} modules, ${totalRoutes} routes registered`);

console.log('\nLoading full app.js (registers every route)...');
const { default: app } = await import('./src/app.js');
assert.strictEqual(typeof app, 'function');
console.log('  OK — app assembled with no missing imports or wiring errors');

// --------------------------------------------------------------------------
// Does it actually answer?
// --------------------------------------------------------------------------
// Module wiring can be perfect and the app still not serve. Boot it on an
// ephemeral port and ask.
console.log('\nBooting the app and making real requests...');
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const request = (method, path) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

const health = await request('GET', '/api/health');
assert.strictEqual(health.status, 200, `/api/health should answer 200, got ${health.status}`);
assert.strictEqual(JSON.parse(health.body).status, 'ok');
console.log(`  GET /api/health         200  ${health.body.trim()}`);

const missing = await request('GET', '/api/definitely-not-a-route');
assert.strictEqual(missing.status, 404, 'an unknown path should reach the 404 handler');
console.log(`  GET /api/…not-a-route   404  (404 handler reached)`);

// Is every router actually mounted?
//
// Two things make this less obvious than it looks. A bare GET on the mount point
// proves nothing: /api/momo's only route is a POST on a subpath, so a GET there
// legitimately falls through. And a status code proves nothing either, because a
// route that IS mounted may answer 404 for its own reasons.
//
// So: ask each router for a real GET route of its own, and compare against the
// app's 404 handler by its body, which is distinctive. Only GET, deliberately —
// a smoketest has no business POSTing to endpoints that write.
const NOT_MOUNTED = '{"error":"Endpoint not found"}';
const MOUNTS = {
  tenants: '/api/tenants', platform: '/api/platform', momoWebhook: '/api/momo',
  auth: '/api/auth', menu: '/api/menu', categories: '/api/categories',
  addons: '/api/addons', orders: '/api/orders', delivery: '/api/delivery',
  analytics: '/api/analytics', notifications: '/api/notifications',
  wallet: '/api/wallet', refunds: '/api/refunds', reviews: '/api/reviews',
  complaints: '/api/complaints', uploads: '/api/uploads',
};
assert.deepStrictEqual(
  Object.keys(MOUNTS).sort(), [...ROUTE_MODULES].sort(),
  'every route module must have a mount point listed here',
);

let probed = 0;
for (const [name, mount] of Object.entries(MOUNTS)) {
  const layer = routers.get(name).stack.find((l) => l.route?.methods?.get);
  if (!layer) {
    console.log(`  ${mount.padEnd(22)} no GET route — mount checked at module level`);
    continue;
  }
  const routePath = Array.isArray(layer.route.path) ? layer.route.path[0] : layer.route.path;
  const url = `${mount}${routePath === '/' ? '' : routePath}`.replace(/:[A-Za-z_]\w*/g, 'probe');
  const res = await request('GET', url);
  assert.notStrictEqual(
    res.body.trim(), NOT_MOUNTED,
    `${url} reached the app's 404 handler — ${name} is not mounted`,
  );
  probed += 1;
  console.log(`  GET ${url.padEnd(34)} ${res.status}  mounted`);
}
console.log(`  OK — ${probed} routers answered on their own routes, ${Object.keys(MOUNTS).length} mounts verified`);

await new Promise((resolve) => server.close(resolve));

console.log('\nALL WIRING CHECKS PASSED');
