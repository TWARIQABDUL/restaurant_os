/**
 * Integration tests for sign-in.
 *
 * These exist because a change that looked correct in isolation — scoping the
 * login lookup to the request's store — locked real users out of production.
 * The failure was invisible to every check we had: it type-checked, it built,
 * it passed a manual smoke test in a browser with empty storage. What it did
 * not survive was a browser that remembered a different store.
 *
 * Run with:  npm test
 *
 * NOTE: these run against whatever DATABASE the server env points at. Every row
 * they create uses the LOGIN_TEST_ prefix and is removed in the teardown, but
 * point this at a scratch project rather than production if you have one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
// These tests deliberately drive many failed logins from one address.
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-not-used-anywhere-real-0123456789';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const bcrypt = require('bcryptjs');
const supabase = require('../src/config/supabase');
const app = require('../src/app');

const EMAIL = `login_test_${Date.now()}@example.invalid`;
const PW_ADMIN = 'admin-password-A1!';
const PW_CUSTOMER = 'customer-password-B2!';
const PW_WRONG = 'not-the-password-C3!';

let server;
let baseUrl;
let storeA; // the admin account's store
let storeB; // a different store, where the same email is a customer

function request(path, { method = 'GET', body = null, slug } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (slug) headers['X-Tenant-Slug'] = slug;
    const req = http.request(`${baseUrl}${path}`, { method, headers }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(raw); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.setTimeout(30000, () => { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const login = (password, slug) =>
  request('/api/auth/login', { method: 'POST', body: { email: EMAIL, password }, slug });

test.before(async () => {
  const { data: tenants, error } = await supabase
    .from('tenants').select('id, slug').eq('active', true).limit(2);
  if (error) throw new Error(`cannot read tenants: ${error.message}`);
  assert.ok(tenants && tenants.length >= 2, 'these tests need at least two active stores');
  [storeA, storeB] = tenants;

  await supabase.from('users').delete().eq('email', EMAIL);
  const { error: insertErr } = await supabase.from('users').insert([
    {
      name: 'Login Test Admin', email: EMAIL, role: 'admin', tenant_id: storeA.id,
      password_hash: await bcrypt.hash(PW_ADMIN, 12),
    },
    {
      name: 'Login Test Customer', email: EMAIL, role: 'customer', tenant_id: storeB.id,
      password_hash: await bcrypt.hash(PW_CUSTOMER, 12),
    },
  ]);
  if (insertErr) throw new Error(`cannot seed test users: ${insertErr.message}`);

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await supabase.from('users').delete().eq('email', EMAIL);
  if (server) await new Promise((r) => server.close(r));
});

// ── The regression that caused the outage ─────────────────────────────────

test('signs in from the global page with no store named', async () => {
  const res = await login(PW_ADMIN);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin');
  assert.equal(res.body.user.tenant_id, storeA.id);
});

test('signs in even when a DIFFERENT store is named — the outage case', async () => {
  // A slug remembered from browsing another storefront must never exclude the
  // right account. This is the exact shape that locked users out.
  const res = await login(PW_ADMIN, storeB.slug);
  assert.equal(res.status, 200, 'a stale store must not reject a correct password');
  assert.equal(res.body.user.role, 'admin');
});

test('the named store decides which account when both passwords would match', async () => {
  const onB = await login(PW_CUSTOMER, storeB.slug);
  assert.equal(onB.status, 200);
  assert.equal(onB.body.user.tenant_id, storeB.id, 'should land on the customer account in store B');

  const onA = await login(PW_ADMIN, storeA.slug);
  assert.equal(onA.status, 200);
  assert.equal(onA.body.user.tenant_id, storeA.id);
});

test('with no store named, the more privileged account wins', async () => {
  const res = await login(PW_ADMIN);
  assert.equal(res.body.user.role, 'admin');
});

test('the same email in another store signs in with ITS password', async () => {
  const res = await login(PW_CUSTOMER);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'customer');
  assert.equal(res.body.user.tenant_id, storeB.id);
});

// ── Rejections ────────────────────────────────────────────────────────────

test('rejects a wrong password', async () => {
  const res = await login(PW_WRONG);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid email or password');
});

test('rejects an unknown email with the same message', async () => {
  // The response must not distinguish "no such account" from "wrong password",
  // or it becomes a way to enumerate who has an account.
  const res = await request('/api/auth/login', {
    method: 'POST',
    body: { email: `nobody_${Date.now()}@example.invalid`, password: PW_ADMIN },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid email or password');
});

test('never returns the password hash', async () => {
  const res = await login(PW_ADMIN);
  assert.equal(res.body.user.password_hash, undefined);
});

test('sets an httpOnly session cookie', async () => {
  const cookie = await new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, (res) => { res.resume(); resolve(res.headers['set-cookie']); });
    req.on('error', reject);
    req.write(JSON.stringify({ email: EMAIL, password: PW_ADMIN }));
    req.end();
  });
  assert.ok(cookie, 'a session cookie must be set');
  assert.match(cookie.join(';'), /HttpOnly/i);
});

test('rejects a malformed email before touching the database', async () => {
  const res = await request('/api/auth/login', {
    method: 'POST', body: { email: 'not-an-email', password: PW_ADMIN },
  });
  assert.equal(res.status, 400);
});
