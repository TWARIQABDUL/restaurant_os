// server/test/api/adminOps.test.ts — milestone 27, part C: audit log, all orders, platform settings, admin team, plans, industry templates.
//
//   1. THE SAME WALL, AND NOW INSIDE IT: no session → 401, a store's owner/admin/manager → 403, and the three scoped TEAM roles each see
//      exactly the screens their permissions give them and no others (V032) — a support person cannot read the audit log, a finance
//      person cannot edit a template, a verification person cannot see a payout.
//   2. THE TEAM CANNOT LOCK ITSELF OUT: nobody changes or removes their own role, and the last super admin can be neither demoted nor
//      removed. A removed member's session ends and their token opens nothing.
//   3. SETTINGS ARE READ WHERE THEY ARE USED: changing the hold period changes what the merchant's wallet says, and the default payout
//      mode is what a store's FIRST payout destination starts in.
//   4. A PUBLISHED TEMPLATE VERSION NEVER CHANGES: editing a live template makes a draft; publishing makes the next version; existing
//      stores move only when the admin says so. (A throwaway template, not the seeded ones — published versions cannot be deleted.)
//   5. PLANS: an empty price is "not decided" (NULL), never zero.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { closePool, sql } from '../../src/db/index.ts';
import { boot, call, tokenFor } from './client.ts';
import type { Api } from './client.ts';
import { FIXTURE_PASSWORD, STORE, USER, cleanup, seedAuthPasswords, seedConsole, seedFixtures, seedStorefront } from './support.ts';

let api: Api;
const team = (): string => tokenFor(USER.superAdmin);
type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => v as Json;
const list = (v: unknown): Json[] => v as Json[];
const get = (path: string, token = team()): ReturnType<typeof call> => call(api, 'GET', `/api/admin${path}`, { token });
const post = (path: string, body: unknown = {}, token = team()): ReturnType<typeof call> => call(api, 'POST', `/api/admin${path}`, { token, body });
const put = (path: string, body: unknown, token = team()): ReturnType<typeof call> => call(api, 'PUT', `/api/admin${path}`, { token, body });
const del = (path: string, token = team()): ReturnType<typeof call> => call(api, 'DELETE', `/api/admin${path}`, { token });

const TPL = 'zz_test_template';
const SETTINGS_BEFORE: Json = {};

async function dropTemplate(): Promise<void> {
  // Published versions and their children are frozen by trigger for EVERYONE (V002) — that is the feature — so teardown disables them
  // for one transaction, as support.ts does for the append-only tables.
  const url = process.env['OWNER_DATABASE_URL'];
  if (url === undefined || url === '') throw new Error('OWNER_DATABASE_URL is not set; run through npm run api:test');
  const owner = new Client({ connectionString: url });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('ALTER TABLE industry_template_versions DISABLE TRIGGER USER');
    await owner.query('ALTER TABLE industry_template_version_modules DISABLE TRIGGER USER');
    await owner.query('ALTER TABLE industry_template_version_product_flags DISABLE TRIGGER USER');
    await owner.query(`UPDATE stores SET industry_template_id = NULL, industry_template_version = NULL WHERE industry_template_id IN (SELECT id FROM industry_templates WHERE key = $1)`, [TPL]);
    const t = `(SELECT id FROM industry_templates WHERE key = '${TPL}')`;
    await owner.query(`DELETE FROM industry_template_version_modules WHERE template_id = ${t}`);
    await owner.query(`DELETE FROM industry_template_version_product_flags WHERE template_id = ${t}`);
    await owner.query(`DELETE FROM industry_template_versions WHERE template_id = ${t}`);
    await owner.query(`DELETE FROM industry_templates WHERE key = $1`, [TPL]);
    await owner.query('ALTER TABLE industry_template_version_product_flags ENABLE TRIGGER USER');
    await owner.query('ALTER TABLE industry_template_version_modules ENABLE TRIGGER USER');
    await owner.query('ALTER TABLE industry_template_versions ENABLE TRIGGER USER');
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  } finally {
    await owner.end();
  }
}

before(async () => {
  api = await boot();
  await seedFixtures();
  await seedStorefront();
  await seedAuthPasswords();
  await seedConsole();
  const s = asJson(asJson((await get('/settings')).body)['settings']);
  Object.assign(SETTINGS_BEFORE, s);
});

after(async () => {
  await put('/settings', SETTINGS_BEFORE).catch(() => undefined);
  await sql(`UPDATE plans SET monthly_price = NULL, payment_fee_percent = NULL, withdrawal_fee = NULL, staff_account_limit = 3 WHERE key = 'starter'`);
  await dropTemplate();
  await cleanup();
  await api.close();
  await closePool();
});

describe('the wall', () => {
  const routes: [string, string][] = [
    ['GET', '/audit'], ['POST', '/audit/verify'], ['GET', '/orders'], ['GET', '/settings'], ['PUT', '/settings'], ['GET', '/team'], ['POST', '/team'],
    ['PUT', `/team/${STORE.a}`], ['DELETE', `/team/${STORE.a}`], ['GET', '/plans'], ['PUT', '/plans/starter'], ['GET', '/templates'], ['GET', '/templates/food'],
    ['PUT', '/templates/food'], ['POST', '/templates/food/publish'],
  ];
  it('no session → 401; a store owner, admin or manager → 403, on every route', async () => {
    for (const [method, path] of routes) assert.equal((await call(api, method, `/api/admin${path}`, method === 'GET' ? {} : { body: {} })).status, 401, `${method} ${path}`);
    for (const t of [tokenFor(USER.ownerA), tokenFor(USER.adminA), tokenFor(USER.managerA)]) {
      for (const [method, path] of routes) assert.equal((await call(api, method, `/api/admin${path}`, method === 'GET' ? { token: t } : { token: t, body: {} })).status, 403, `${method} ${path}`);
    }
  });
});

describe('the team', () => {
  const made: Record<string, { id: string; token: string }> = {};

  it('lists the team with the board’s matrix, computed from the permission rows', async () => {
    const t = asJson((await get('/team')).body);
    assert.ok(list(t['members']).some((m) => m['userId'] === USER.superAdmin && m['role'] === 'super_admin'));
    assert.deepEqual(t['roles'], ['super_admin', 'support', 'finance', 'verification']);
    const row = (label: RegExp): Json => list(t['matrix']).find((r) => label.test(String(r['label'])))!;
    assert.deepEqual(asJson(row(/Manage the admin team/)['roles']), { super_admin: true, support: false, finance: false, verification: false });
    assert.deepEqual(asJson(row(/identity checks/)['roles']), { super_admin: true, support: false, finance: false, verification: true });
    assert.deepEqual(asJson(row(/refunds and disputes/)['roles']), { super_admin: true, support: true, finance: true, verification: false });
    assert.deepEqual(asJson(row(/Retry failed payouts/)['roles']), { super_admin: true, support: false, finance: true, verification: false });
    assert.deepEqual(asJson(row(/audit log/)['roles']), { super_admin: true, support: false, finance: false, verification: false });
  });

  it('adds a teammate: validated, unique, audited — and they can sign in as that role', async () => {
    assert.equal((await post('/team', { name: 'S', email: 'x@escalation.test', role: 'support', password: 'a-long-enough-one' })).status, 400, 'a name too short');
    assert.equal((await post('/team', { name: 'Sam Support', email: 'sam@escalation.test', role: 'janitor', password: 'a-long-enough-one' })).status, 400, 'a role that does not exist');
    assert.equal((await post('/team', { name: 'Sam Support', email: 'sam@escalation.test', role: 'support', password: 'short' })).status, 400, 'a weak password');
    for (const [role, name] of [['support', 'Sam Support'], ['finance', 'Fay Finance'], ['verification', 'Val Verification']] as const) {
      const r = await post('/team', { name, email: `${role}@escalation.test`, role, password: 'a-long-enough-one' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const id = String(asJson(r.body['member'])['userId']);
      made[role] = { id, token: tokenFor(id) };
    }
    assert.equal((await post('/team', { name: 'Sam Again', email: 'SUPPORT@escalation.test', role: 'support', password: 'a-long-enough-one' })).status, 409, 'the same email, any case');
    assert.ok(Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'add_team_member' AND actor_id = $1`, [USER.superAdmin])).rows[0]!.n) >= 3);
    assert.equal(asJson((await get('/me', made['support']!.token)).body)['role'], 'support');
  });

  it('each role sees the screens its permissions give it, and no others', async () => {
    const can = async (role: string, path: string): Promise<number> => (await get(path, made[role]!.token)).status;
    assert.deepEqual([await can('support', '/disputes'), await can('support', '/audit'), await can('support', '/team'), await can('support', '/plans'), await can('support', '/payouts')], [200, 403, 403, 403, 403]);
    assert.deepEqual([await can('finance', '/plans'), await can('finance', '/payouts'), await can('finance', '/currencies'), await can('finance', '/templates'), await can('finance', '/kyc')], [200, 200, 200, 403, 403]);
    assert.deepEqual([await can('verification', '/kyc'), await can('verification', '/orders'), await can('verification', '/payouts'), await can('verification', '/disputes'), await can('verification', '/settings')], [200, 200, 403, 403, 403]);
    assert.equal((await post('/merchants/' + STORE.a + '/suspend', { reason: 'fraud' }, made['finance']!.token)).status, 403, 'finance cannot suspend');
    assert.equal((await post('/team', { name: 'Eve', email: 'eve@escalation.test', role: 'super_admin', password: 'a-long-enough-one' }, made['support']!.token)).status, 403, 'a team member cannot make a bigger one');
  });

  it('changes a role, and not your own', async () => {
    const r = await put(`/team/${made['support']!.id}`, { role: 'finance' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(list(r.body['members']).find((m) => m['userId'] === made['support']!.id)!['role'], 'finance');
    assert.equal((await put(`/team/${made['support']!.id}`, { role: 'finance' })).status, 409, 'no change');
    assert.equal((await put(`/team/${USER.superAdmin}`, { role: 'support' })).status, 409, 'not your own');
    assert.equal((await put(`/team/${made['support']!.id}`, { role: 'janitor' })).status, 400);
    assert.equal((await put('/team/00000000-0000-4000-8000-000000000bad', { role: 'support' })).status, 404);
    assert.equal(await (async () => (await get('/plans', made['support']!.token)).status)(), 200, 'and the new role applies on the very next request');
  });

  it('removes a teammate: their token opens nothing, and you cannot remove yourself', async () => {
    assert.equal((await del(`/team/${USER.superAdmin}`)).status, 409);
    const gone = await del(`/team/${made['verification']!.id}`);
    assert.equal(gone.status, 200);
    assert.ok(!list(gone.body['members']).some((m) => m['userId'] === made['verification']!.id));
    assert.equal((await get('/kyc', made['verification']!.token)).status, 401, 'the session ended (signed out everywhere)');
    assert.equal((await del(`/team/${made['verification']!.id}`)).status, 404, 'and they are no longer on the team');
  });

  it('two super admins demoting each other at once leave one standing — the team cannot lock itself out', async () => {
    // Make exactly two super admins for the length of the test: the fixture one and a promoted teammate. Everyone else who holds the role
    // is demoted for the moment and put back after — their rows stay (the log and reviews refer to them), only the role is borrowed.
    const original = (await sql<{ user_id: string; role: string }>(`SELECT user_id, role FROM platform_members`)).rows;
    const second = made['finance']!;
    try {
      await sql(`UPDATE platform_members SET role = 'support' WHERE role = 'super_admin' AND user_id <> $1`, [USER.superAdmin]);
      await sql(`UPDATE platform_members SET role = 'super_admin' WHERE user_id = $1`, [second.id]);
      const [a, b] = await Promise.all([put(`/team/${second.id}`, { role: 'support' }, tokenFor(USER.superAdmin)), put(`/team/${USER.superAdmin}`, { role: 'support' }, tokenFor(second.id))]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200, 'one of them goes through');
      assert.ok([403, 409].includes(statuses[1]!), `and the other is refused (${statuses[1]})`);
      const left = Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM platform_members WHERE role = 'super_admin'`)).rows[0]!.n);
      assert.equal(left, 1, 'exactly one super admin remains');
    } finally {
      for (const o of original) await sql(`UPDATE platform_members SET role = $2 WHERE user_id = $1`, [o.user_id, o.role]);
    }
  });
});

describe('platform settings', () => {
  it('reads the defaults and a health panel that only claims what it measures', async () => {
    const r = asJson((await get('/settings')).body);
    assert.deepEqual(Object.keys(asJson(r['settings'])).sort(), ['automaticPayoutAt', 'holdMinutes', 'payoutModeDefault']);
    const health = list(r['health']);
    assert.equal(health[0]!['name'], 'API');
    const sms = health.find((h) => h['name'] === 'SMS gateway')!;
    assert.equal(sms['state'], 'off', 'no SMS gateway exists, so it is not given a green dot');
    assert.ok(health.some((h) => h['name'] === 'Payout scheduler'));
  });

  it('refuses nonsense', async () => {
    assert.equal((await put('/settings', { holdMinutes: 1 })).status, 400);
    assert.equal((await put('/settings', { holdMinutes: 1_000_000 })).status, 400);
    assert.equal((await put('/settings', { holdMinutes: 'soon' })).status, 400);
    assert.equal((await put('/settings', { automaticPayoutAt: '25:00' })).status, 400);
    assert.equal((await put('/settings', { payoutModeDefault: 'sometimes' })).status, 400);
    assert.equal((await put('/settings', {})).status, 400);
  });

  it('a change is saved, audited, and is what the merchant’s wallet reads next', async () => {
    const r = await put('/settings', { holdMinutes: 120, automaticPayoutAt: '09:30' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(asJson(r.body['settings'])['holdMinutes'], 120);
    const entry = (await sql<{ summary: string; context: Json }>(`SELECT summary, context FROM audit_log WHERE action = 'update_platform_settings' ORDER BY sequence DESC LIMIT 1`)).rows[0]!;
    assert.match(entry.summary, /hold minutes, automatic payout at/);
    assert.equal(asJson(entry.context['before'])['holdMinutes'], SETTINGS_BEFORE['holdMinutes']);
    const wallet = asJson((await call(api, 'GET', `/api/stores/${STORE.a}/wallet`, { token: tokenFor(USER.ownerA) })).body);
    assert.equal(wallet['holdMinutes'], 120);
  });

  it('the default payout mode is what a store’s FIRST payout destination starts in — and no later change touches it', async () => {
    await put('/settings', { payoutModeDefault: 'automatic', automaticPayoutAt: '09:30' });
    // The fixture store arrives with a payout destination; "first" means a store that has none.
    await sql(`DELETE FROM store_payout_settings WHERE store_id = $1`, [STORE.a]);
    const owner = tokenFor(USER.ownerA);
    const set = await call(api, 'PUT', `/api/stores/${STORE.a}/settings/payout`, { token: owner, body: { methodKey: 'mtn_momo', phone: '0781234567', password: FIXTURE_PASSWORD } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const row = (await sql<{ settlement_mode: string; automatic_at: string }>(`SELECT settlement_mode, automatic_at::text FROM store_payout_settings WHERE store_id = $1`, [STORE.a])).rows[0]!;
    assert.deepEqual([row.settlement_mode, row.automatic_at], ['automatic', '09:30:00']);
    await put('/settings', { payoutModeDefault: 'manual' });
    await call(api, 'PUT', `/api/stores/${STORE.a}/settings/payout`, { token: owner, body: { methodKey: 'mtn_momo', phone: '0781234999', password: FIXTURE_PASSWORD } });
    assert.equal((await sql<{ settlement_mode: string }>(`SELECT settlement_mode FROM store_payout_settings WHERE store_id = $1`, [STORE.a])).rows[0]!.settlement_mode, 'automatic', 'changing the number keeps the mode the owner has');
  });
});

describe('audit log', () => {
  it('lists newest first with a reason and an address where there is one, and filters by type', async () => {
    const all = asJson((await get('/audit')).body);
    const rows = list(all['rows']);
    assert.ok(rows.length > 0 && rows.length <= 50);
    const seqs = rows.map((r) => Number(r['sequence']));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a), 'newest first');
    const cfg = list(asJson((await get('/audit?category=config')).body)['rows']);
    assert.ok(cfg.length > 0 && cfg.every((r) => r['category'] === 'config'));
    assert.ok(cfg.some((r) => /platform settings/.test(String(r['what']))));
    const none = list(asJson((await get('/audit?category=nonsense')).body)['rows']);
    assert.ok(none.length > 0, 'an unknown type is no filter, not an error');
  });

  it('pages by sequence, with no overlap', async () => {
    const first = asJson((await get('/audit')).body);
    const last = Number(list(first['rows']).at(-1)!['sequence']);
    const next = list(asJson((await get(`/audit?before=${last}`)).body)['rows']);
    assert.ok(next.every((r) => Number(r['sequence']) < last));
  });

  it('proves the chain on request', async () => {
    const r = await post('/audit/verify');
    assert.equal(r.status, 200);
    assert.equal(r.body['ok'], true);
    assert.ok(Number(r.body['entries']) > 0);
  });
});

describe('all orders', () => {
  it('lists across stores, flags what needs attention in words, and is read-only', async () => {
    const r = asJson((await get('/orders?filter=attention')).body);
    const flagged = list(r['rows']).find((o) => /^No reply in \d+ min$/.test(String(o['flag'])))!;
    assert.ok(flagged !== undefined, 'the 30-minute-old pending order is flagged');
    assert.equal(flagged['store'], 'Escalation Store A');
    assert.ok(Number(asJson(r['counts'])['attention']) >= 1);
    for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await call(api, m, '/api/admin/orders', { token: team(), body: {} })).status, 404, `no ${m}`);
  });

  it('searches by order number, store or customer, beyond today', async () => {
    const byNumber = list(asJson((await get('/orders?q=%239002')).body)['rows']);
    assert.ok(byNumber.some((o) => o['number'] === 9002));
    const byStore = list(asJson((await get('/orders?q=Escalation%20Store%20A')).body)['rows']);
    assert.ok(byStore.length > 0 && byStore.every((o) => o['store'] === 'Escalation Store A'));
    assert.equal(list(asJson((await get('/orders?q=%25')).body)['rows']).length, 0, 'a wildcard is a search, not a pattern');
  });

  it('pages with a cursor and no overlap, and rejects a cursor it did not issue', async () => {
    const first = asJson((await get('/orders?filter=open')).body);
    const rows = list(first['rows']);
    assert.ok(rows.length > 0);
    const cursor = String(rows.at(-1)!['cursor']);
    const next = list(asJson((await get(`/orders?filter=open&before=${encodeURIComponent(cursor)}`)).body)['rows']);
    const ids = new Set(rows.map((o) => o['id']));
    assert.ok(next.every((o) => !ids.has(o['id'])));
    assert.equal((await get('/orders?before=nonsense')).status, 400);
  });

  it('open means not finished; cash unpaid means cash not yet collected', async () => {
    const open = list(asJson((await get('/orders?filter=open')).body)['rows']);
    assert.ok(open.every((o) => !['delivered', 'collected', 'cancelled', 'rejected', 'returned', 'closed_return'].includes(String(o['status']))));
    const cash = list(asJson((await get('/orders?filter=cash')).body)['rows']);
    assert.ok(cash.every((o) => o['paymentMethod'] === 'cash' && o['paymentStatus'] === 'unpaid'));
  });
});

describe('plans', () => {
  it('lists the plans with their stores; an empty price is NULL, not zero', async () => {
    const p = list(asJson((await get('/plans')).body)['plans']);
    const starter = p.find((x) => x['key'] === 'starter')!;
    assert.equal(starter['monthlyPrice'], null);
    assert.equal(starter['isDefault'], true);
    const r = await put('/plans/starter', { monthlyPrice: '', paymentFeePercent: 2.5, withdrawalFee: 300, staffAccountLimit: 5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body['monthlyPrice'], r.body['paymentFeePercent'], r.body['withdrawalFee'], r.body['staffAccountLimit']], [null, 2.5, 300, 5]);
    assert.equal((await sql<{ c: string | null }>(`SELECT currency_code AS c FROM plans WHERE key = 'starter'`)).rows[0]!.c, 'RWF', 'a fee needs a currency, and gets the platform’s');
  });

  it('refuses a negative price, a fee above 100%, and a staff limit that is not a whole number', async () => {
    assert.equal((await put('/plans/starter', { monthlyPrice: -1 })).status, 400);
    assert.equal((await put('/plans/starter', { paymentFeePercent: 101 })).status, 400);
    assert.equal((await put('/plans/starter', { staffAccountLimit: 2.5 })).status, 400);
    assert.equal((await put('/plans/starter', { staffAccountLimit: 0 })).status, 400);
    assert.equal((await put('/plans/nothing', { staffAccountLimit: 3 })).status, 404);
    assert.ok(Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'update_plan'`)).rows[0]!.n) >= 1);
  });
});

describe('industry templates', () => {
  async function seedTemplate(): Promise<void> {
    const id = (await sql<{ id: string }>(`INSERT INTO industry_templates (key, name, accent_color) VALUES ($1, 'Test business', '#123456') RETURNING id`, [TPL])).rows[0]!.id;
    await sql(
      `INSERT INTO industry_template_versions (template_id, version, status, words, attributes, order_steps, published_at)
            VALUES ($1, 1, 'draft', '{"product":"Things","catalog":"Shop","category":"Groups","option":"Choices"}', '[{"name":"Size","pick":"one"}]', '[{"key":"new","label":"New"},{"key":"done","label":"Done"}]', NULL)`,
      [id],
    );
    // Children are written while it is a draft — the freeze applies the moment it is published — and then it is published, as an admin would.
    await sql(`INSERT INTO industry_template_version_modules (template_id, version, module_key) VALUES ($1, 1, 'delivery')`, [id]);
    await sql(`UPDATE industry_template_versions SET status = 'published', published_at = now() WHERE template_id = $1 AND version = 1`, [id]);
    await sql(`UPDATE stores SET industry_template_id = $1, industry_template_version = 1 WHERE id = $2`, [id, STORE.b]);
  }
  const edit = { words: { product: 'Goods', catalog: 'Store', category: 'Aisles', option: 'Picks' }, modules: ['delivery', 'pickup'], attributes: [{ name: 'Size', pick: 'one' }, { name: 'Colour', pick: 'several' }] };

  it('lists the templates with their live version, draft and stores; opens one', async () => {
    await seedTemplate();
    const all = list(asJson((await get('/templates')).body)['templates']);
    assert.ok(all.some((t) => t['key'] === 'food' && t['liveVersion'] !== null));
    const mine = all.find((t) => t['key'] === TPL)!;
    assert.deepEqual([mine['liveVersion'], mine['hasDraft'], mine['stores']], [1, false, 1]);
    const d = asJson((await get(`/templates/${TPL}`)).body);
    assert.deepEqual([d['version'], d['state']], [1, 'live']);
    assert.equal(asJson(d['words'])['product'], 'Things');
    assert.ok(list(asJson(d['catalogue'])['modules']).length >= 8);
    assert.equal((await get('/templates/nothing_here')).status, 404);
  });

  it('refuses a bad edit and creates nothing', async () => {
    assert.equal((await put(`/templates/${TPL}`, { ...edit, words: { ...edit.words, product: '' } })).status, 400);
    assert.equal((await put(`/templates/${TPL}`, { ...edit, modules: ['teleport'] })).status, 400);
    assert.equal((await put(`/templates/${TPL}`, { ...edit, attributes: [{ name: 'Size', pick: 'one' }, { name: ' size ', pick: 'one' }] })).status, 400);
    assert.equal((await put(`/templates/${TPL}`, { ...edit, attributes: [{ name: 'Size', pick: 'maybe' }] })).status, 400);
    assert.equal(asJson(list(asJson((await get('/templates')).body)['templates']).find((t) => t['key'] === TPL)!)['hasDraft'], false);
  });

  it('editing a LIVE template makes a draft one version up, and what stores read does not move', async () => {
    const r = await put(`/templates/${TPL}`, edit);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body['version'], r.body['state'], r.body['hasDraft'], r.body['liveVersion']], [2, 'draft', true, 1]);
    assert.equal(asJson(r.body['words'])['product'], 'Goods');
    assert.deepEqual(r.body['modules'], ['delivery', 'pickup']);
    const live = (await sql<{ words: Json }>(`SELECT words FROM industry_template_versions v JOIN industry_templates t ON t.id = v.template_id WHERE t.key = $1 AND v.version = 1`, [TPL])).rows[0]!;
    assert.equal(live.words['product'], 'Things', 'the live version is untouched');
    assert.equal((await sql<{ v: number }>(`SELECT industry_template_version AS v FROM stores WHERE id = $1`, [STORE.b])).rows[0]!.v, 1);
    // A second edit changes the same draft, not a third version.
    const again = await put(`/templates/${TPL}`, { ...edit, words: { ...edit.words, product: 'Wares' } });
    assert.deepEqual([again.body['version'], asJson(again.body['words'])['product']], [2, 'Wares']);
  });

  it('publishing for NEW stores only leaves existing stores where they are', async () => {
    const r = await post(`/templates/${TPL}/publish`, { rollout: 'new' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['updated'], 0);
    assert.deepEqual([asJson(r.body['template'])['liveVersion'], asJson(r.body['template'])['hasDraft']], [2, false]);
    assert.equal((await sql<{ v: number }>(`SELECT industry_template_version AS v FROM stores WHERE id = $1`, [STORE.b])).rows[0]!.v, 1);
    assert.equal((await post(`/templates/${TPL}/publish`, { rollout: 'new' })).status, 409, 'nothing left to publish');
    assert.equal((await post(`/templates/${TPL}/publish`, { rollout: 'sometimes' })).status, 400);
  });

  it('publishing and updating existing stores repins them — and a merchant’s own overrides survive', async () => {
    await sql(`UPDATE stores SET config_overrides = '{"words":{"category":"Treatments"}}'::jsonb WHERE id = $1`, [STORE.b]);
    await put(`/templates/${TPL}`, { ...edit, words: { ...edit.words, product: 'Items' } });
    const r = await post(`/templates/${TPL}/publish`, { rollout: 'all' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['updated'], 1);
    assert.equal((await sql<{ v: number }>(`SELECT industry_template_version AS v FROM stores WHERE id = $1`, [STORE.b])).rows[0]!.v, 3);
    const overrides = (await sql<{ o: Json }>(`SELECT config_overrides AS o FROM stores WHERE id = $1`, [STORE.b])).rows[0]!.o;
    assert.equal(asJson(overrides['words'])['category'], 'Treatments', 'what the merchant customised is kept');
    const entry = (await sql<{ summary: string }>(`SELECT summary FROM audit_log WHERE action = 'publish_template' ORDER BY sequence DESC LIMIT 1`)).rows[0]!;
    assert.match(entry.summary, /v3 · updated 1 existing store/);
  });
});
