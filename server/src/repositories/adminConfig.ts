// server/src/repositories/adminConfig.ts — milestone 27, part B: the two configuration screens that touch the money every store reads.
// AdminPayments (what customers can pay with) and AdminCurrencies (how money is shown, rounded and converted).
//
// BOTH TAKE EFFECT THE MOMENT THEY ARE SAVED, which is a deliberate departure from the Currencies board's "Publish changes" button.
// The board stages edits across several currencies and publishes them together. There is no staging table, and inventing one to hold
// a half-edited currency invites a state nobody can see (which of three people's unpublished edits is live?). Each save is one
// currency in one transaction with one audit entry, so "what changed, who changed it, when" has a single answer.
//
// WHAT THE PAYMENTS BOARD DRAWS THAT NOTHING BACKS, and is therefore not here: a credentials vault with rotation, a Sandbox/Production
// switch, a "Run sandbox test payment" that charges and refunds a test number, a rollout setting (opt-in / default / pilot), the merchant
// fee and settlement schedule on a method, and a second-admin finance approval. Each is real work with a real design question behind
// it; a toggle that stores a value nothing reads would look finished and be a lie. What IS here is everything the schema holds: the
// countries and currencies a method works in, its limits, the words at checkout, its status and its incident note.

import { badRequest, conflict, db, notFound, withTransaction } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';

type Actor = { id: string; ip: string | null; userAgent: string | null };

async function audit(tx: Tx, a: Actor, action: string, summary: string, context: Record<string, unknown>): Promise<void> {
  await tx.query(`SELECT audit('config', $1, $2, $3, NULL, NULL, NULL, NULL, $4::inet, $5, NULL, $6::jsonb)`, [action, summary, a.id, a.ip, a.userAgent, JSON.stringify(context)]);
}

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

export type CurrencyRow = {
  code: string;
  name: string;
  symbol: string;
  position: 'before' | 'after';
  decimals: 0 | 2;
  separator: ',' | ' ' | '.';
  rounding: 0 | 10 | 50 | 100 | 500;
  enabled: boolean;
  isDefault: boolean;
  rateSource: 'feed' | 'manual';
  usdRate: number | null;
  rateUpdatedAt: string | null;
  tag: string;
  usage: string;
  /** Why this one cannot be switched off, if it cannot. */
  lockedReason: string | null;
};

export async function currencies(on: Queryable = db): Promise<CurrencyRow[]> {
  const r = await on.query<{ code: string; name: string; symbol: string; symbol_position: 'before' | 'after'; decimals: number; thousands_separator: string; cash_rounding: string; is_enabled: boolean; is_default: boolean; rate_source: 'feed' | 'manual'; usd_rate: string | null; rate_updated_at: Date | null; stores: string; countries: string | null; methods: string }>(
    `SELECT c.code, c.name, c.symbol, c.symbol_position, c.decimals, c.thousands_separator, c.cash_rounding::text, c.is_enabled, c.is_default, c.rate_source, c.usd_rate::text, c.rate_updated_at,
            (SELECT count(*) FROM stores s WHERE s.selling_currency = c.code)::text AS stores,
            (SELECT string_agg(k.name, ', ' ORDER BY k.name) FROM countries k WHERE k.default_currency_code = c.code) AS countries,
            (SELECT count(*) FROM payment_method_currencies p WHERE p.currency_code = c.code)::text AS methods
       FROM currencies c ORDER BY c.is_default DESC, c.is_enabled DESC, c.code`,
  );
  return r.rows.map((x) => {
    const stores = Number(x.stores);
    const locked = x.is_default ? 'The default currency is always on.' : stores > 0 ? `${stores} ${stores === 1 ? 'store sells' : 'stores sell'} in it.` : null;
    return {
      code: x.code, name: x.name, symbol: x.symbol, position: x.symbol_position, decimals: x.decimals as 0 | 2, separator: x.thousands_separator as ',', rounding: Number(x.cash_rounding) as 0, enabled: x.is_enabled, isDefault: x.is_default,
      rateSource: x.rate_source, usdRate: x.usd_rate === null ? null : Number(x.usd_rate), rateUpdatedAt: x.rate_updated_at?.toISOString() ?? null,
      tag: x.is_default ? `Default${x.countries === null ? '' : ` · ${x.countries}`}` : x.countries !== null ? (x.is_enabled ? x.countries : `${x.countries} · not launched`) : Number(x.methods) > 0 ? 'Display and cards only' : 'Not offered',
      usage: stores > 0 ? `${stores.toLocaleString('en-US')} ${stores === 1 ? 'store' : 'stores'}` : Number(x.methods) > 0 ? 'Payments only' : 'Not in use',
      lockedReason: locked,
    };
  });
}

export type CurrencyPatch = { symbol?: string; position?: string; decimals?: number; separator?: string; rounding?: number; enabled?: boolean; rateSource?: string; usdRate?: number | null };

const POSITIONS = ['before', 'after'];
const SEPARATORS = [',', ' ', '.'];
const ROUNDINGS = [0, 10, 50, 100, 500];

export async function updateCurrency(code: string, p: CurrencyPatch, a: Actor): Promise<CurrencyRow> {
  const sets: string[] = [];
  const args: unknown[] = [code];
  const set = (col: string, v: unknown): void => { args.push(v); sets.push(`${col} = $${args.length}`); };

  if (p.symbol !== undefined) { const v = p.symbol.trim(); if (v === '' || v.length > 8) throw badRequest('The symbol is 1–8 characters.', 'INVALID_SYMBOL'); set('symbol', v); }
  if (p.position !== undefined) { if (!POSITIONS.includes(p.position)) throw badRequest('Position is before or after.', 'INVALID_POSITION'); set('symbol_position', p.position); }
  if (p.decimals !== undefined) { if (p.decimals !== 0 && p.decimals !== 2) throw badRequest('Decimals is 0 or 2.', 'INVALID_DECIMALS'); set('decimals', p.decimals); }
  if (p.separator !== undefined) { if (!SEPARATORS.includes(p.separator)) throw badRequest('Choose a comma, a space or a dot.', 'INVALID_SEPARATOR'); set('thousands_separator', p.separator); }
  if (p.rounding !== undefined) { if (!ROUNDINGS.includes(p.rounding)) throw badRequest('Cash rounding is off, 10, 50, 100 or 500.', 'INVALID_ROUNDING'); set('cash_rounding', p.rounding); }
  if (p.enabled !== undefined) set('is_enabled', p.enabled);
  if (p.rateSource !== undefined) { if (p.rateSource !== 'feed' && p.rateSource !== 'manual') throw badRequest('The rate comes from the feed or is set by hand.', 'INVALID_RATE_SOURCE'); set('rate_source', p.rateSource); }
  if (p.usdRate !== undefined) {
    if (p.usdRate !== null && !(p.usdRate > 0 && Number.isFinite(p.usdRate))) throw badRequest('A rate is a number above zero.', 'INVALID_RATE');
    set('usd_rate', p.usdRate);
    set('rate_updated_at', p.usdRate === null ? null : new Date());
  }
  if (sets.length === 0) throw badRequest('Nothing to change.', 'NOTHING_TO_CHANGE');

  await withTransaction(
    async (tx) => {
      const before = (await tx.query<{ is_enabled: boolean; is_default: boolean; stores: string }>(
        `SELECT is_enabled, is_default, (SELECT count(*) FROM stores WHERE selling_currency = currencies.code)::text AS stores FROM currencies WHERE code = $1 FOR UPDATE`, [code],
      )).rows[0];
      if (before === undefined) throw notFound('That currency does not exist.', 'NO_SUCH_CURRENCY');
      if (p.enabled === false && before.is_enabled) {
        if (before.is_default) throw conflict('The default currency cannot be switched off.', 'CURRENCY_IS_DEFAULT');
        if (Number(before.stores) > 0) throw conflict(`${before.stores} ${Number(before.stores) === 1 ? 'store sells' : 'stores sell'} in ${code}, so it can’t be switched off.`, 'CURRENCY_IN_USE');
      }
      await tx.query(`UPDATE currencies SET ${sets.join(', ')} WHERE code = $1`, args);
      await audit(tx, a, 'update_currency', `Changed ${code}: ${Object.keys(p).join(', ')}`, { currency: code, changes: p });
    },
    { label: 'PUT /admin/currencies', retries: 0 },
  );
  return (await currencies()).find((c) => c.code === code)!;
}

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------

export type MethodStatus = 'draft' | 'live' | 'paused';

export type MethodRow = {
  key: string;
  name: string;
  short: string;
  kind: 'online' | 'offline';
  status: MethodStatus;
  countries: string[];
  currencies: string[];
};

export type MethodDetail = MethodRow & {
  provider: string | null;
  webhook: string | null;
  customerLabel: string;
  customerHint: string;
  incidentNote: string | null;
  limits: { currency: string; min: number | null; max: number | null }[];
  stores: number;
  health: { rate: number | null; attempts: number };
  readiness: { key: string; label: string; ok: boolean; sub: string }[];
  history: { at: string; who: string; what: string }[];
  catalogue: { countries: { code: string; name: string; enabled: boolean }[]; currencies: { code: string; enabled: boolean }[] };
};

export async function methods(on: Queryable = db): Promise<MethodRow[]> {
  const r = await on.query<{ key: string; name: string; short_name: string; kind: 'online' | 'offline'; status: MethodStatus; countries: string[] | null; currencies: string[] | null }>(
    `SELECT pm.key, pm.name, pm.short_name, pm.kind, pm.status,
            (SELECT array_agg(country_code ORDER BY country_code) FROM payment_method_countries c WHERE c.payment_method_key = pm.key) AS countries,
            (SELECT array_agg(currency_code ORDER BY currency_code) FROM payment_method_currencies c WHERE c.payment_method_key = pm.key) AS currencies
       FROM payment_methods pm ORDER BY pm.position, pm.key`,
  );
  return r.rows.map((x) => ({ key: x.key, name: x.name, short: x.short_name, kind: x.kind, status: x.status, countries: x.countries ?? [], currencies: x.currencies ?? [] }));
}

export async function method(key: string, on: Queryable = db): Promise<MethodDetail | null> {
  const row = (await methods(on)).find((m) => m.key === key);
  if (row === undefined) return null;
  const d = (await on.query<{ provider: string | null; webhook_url: string | null; customer_label: string; customer_hint: string; incident_note: string | null; stores: string; ok: string; total: string }>(
    `SELECT pm.provider, pm.webhook_url, pm.customer_label, pm.customer_hint, pm.incident_note,
            (SELECT count(*) FROM store_payment_methods x WHERE x.payment_method_key = pm.key AND x.is_connected)::text AS stores,
            (SELECT count(*) FROM momo_transactions t WHERE t.payment_method_key = pm.key AND t.direction = 'collection' AND t.status = 'successful' AND t.created_at >= now() - interval '1 hour')::text AS ok,
            (SELECT count(*) FROM momo_transactions t WHERE t.payment_method_key = pm.key AND t.direction = 'collection' AND t.status IN ('successful', 'failed') AND t.created_at >= now() - interval '1 hour')::text AS total
       FROM payment_methods pm WHERE pm.key = $1`, [key],
  )).rows[0]!;
  const limits = (await on.query<{ currency_code: string; min_amount: string | null; max_amount: string | null }>(
    `SELECT currency_code, min_amount::text, max_amount::text FROM payment_method_currencies WHERE payment_method_key = $1 ORDER BY currency_code`, [key],
  )).rows.map((l) => ({ currency: l.currency_code, min: l.min_amount === null ? null : Number(l.min_amount), max: l.max_amount === null ? null : Number(l.max_amount) }));
  const history = (await on.query<{ created_at: Date; actor_label: string; summary: string }>(
    `SELECT created_at, actor_label, summary FROM audit_log WHERE context->>'method' = $1 ORDER BY sequence DESC LIMIT 6`, [key],
  )).rows.map((h) => ({ at: h.created_at.toISOString(), who: h.actor_label, what: h.summary }));
  const cat = {
    countries: (await on.query<{ code: string; name: string; is_enabled: boolean }>(`SELECT code, name, is_enabled FROM countries ORDER BY is_enabled DESC, name`)).rows.map((c) => ({ code: c.code.trim(), name: c.name, enabled: c.is_enabled })),
    currencies: (await on.query<{ code: string; is_enabled: boolean }>(`SELECT code, is_enabled FROM currencies ORDER BY is_enabled DESC, code`)).rows.map((c) => ({ code: c.code.trim(), enabled: c.is_enabled })),
  };
  const total = Number(d.total);
  const online = row.kind === 'online';
  const readiness = [
    { key: 'countries', label: 'Available somewhere', ok: row.countries.length > 0, sub: row.countries.length > 0 ? row.countries.join(' · ') : 'Pick at least one country' },
    { key: 'currencies', label: 'Can charge in a currency', ok: limits.length > 0, sub: limits.length > 0 ? limits.map((l) => l.currency).join(', ') : 'Pick at least one currency' },
    { key: 'words', label: 'Checkout wording written', ok: d.customer_label.trim() !== '' && d.customer_hint.trim() !== '', sub: 'A name and a hint customers will read' },
    ...(online ? [
      { key: 'provider', label: 'Provider named', ok: d.provider !== null && d.provider.trim() !== '', sub: d.provider ?? 'Nothing says who processes it' },
      { key: 'webhook', label: 'Webhook address set', ok: d.webhook_url !== null && d.webhook_url.trim() !== '', sub: d.webhook_url ?? 'The provider has nowhere to report to' },
    ] : []),
  ];
  return { ...row, provider: d.provider, webhook: d.webhook_url, customerLabel: d.customer_label, customerHint: d.customer_hint, incidentNote: d.incident_note, limits, stores: Number(d.stores), health: { rate: total === 0 ? null : (Number(d.ok) / total) * 100, attempts: total }, readiness, history, catalogue: cat };
}

export type MethodPatch = { countries?: string[]; currencies?: { code: string; min: number | null; max: number | null }[]; customerLabel?: string; customerHint?: string; incidentNote?: string | null };

export async function updateMethod(key: string, p: MethodPatch, a: Actor): Promise<MethodDetail> {
  await withTransaction(
    async (tx) => {
      const m = (await tx.query<{ status: MethodStatus; name: string }>(`SELECT status, name FROM payment_methods WHERE key = $1 FOR UPDATE`, [key])).rows[0];
      if (m === undefined) throw notFound('That payment method does not exist.', 'NO_SUCH_METHOD');

      if (p.countries !== undefined) {
        const open = new Set((await tx.query<{ code: string }>(`SELECT code FROM countries WHERE is_enabled`)).rows.map((c) => c.code.trim()));
        if (p.countries.some((c) => !open.has(c))) throw badRequest('One of those countries is not open yet.', 'COUNTRY_NOT_OPEN');
        if (m.status === 'live' && p.countries.length === 0) throw conflict('A live method has to be available somewhere. Pause it instead.', 'LIVE_NEEDS_COUNTRY');
        await tx.query(`DELETE FROM payment_method_countries WHERE payment_method_key = $1`, [key]);
        for (const c of p.countries) await tx.query(`INSERT INTO payment_method_countries (payment_method_key, country_code) VALUES ($1, $2)`, [key, c]);
      }
      if (p.currencies !== undefined) {
        const open = new Set((await tx.query<{ code: string }>(`SELECT code FROM currencies WHERE is_enabled`)).rows.map((c) => c.code.trim()));
        for (const c of p.currencies) {
          if (!open.has(c.code)) throw badRequest(`${c.code} is not turned on yet. Turn it on in Currencies first.`, 'CURRENCY_NOT_OPEN');
          if ((c.min !== null && c.min < 0) || (c.max !== null && c.max <= 0) || (c.min !== null && c.max !== null && c.min > c.max)) throw badRequest(`The limits for ${c.code} don’t make sense.`, 'INVALID_LIMITS');
        }
        if (m.status === 'live' && p.currencies.length === 0) throw conflict('A live method has to charge in at least one currency. Pause it instead.', 'LIVE_NEEDS_CURRENCY');
        await tx.query(`DELETE FROM payment_method_currencies WHERE payment_method_key = $1`, [key]);
        for (const c of p.currencies) await tx.query(`INSERT INTO payment_method_currencies (payment_method_key, currency_code, min_amount, max_amount) VALUES ($1, $2, $3, $4)`, [key, c.code, c.min, c.max]);
      }
      const sets: string[] = [];
      const args: unknown[] = [key];
      if (p.customerLabel !== undefined) { const v = p.customerLabel.trim(); if (v === '' || v.length > 60) throw badRequest('The name customers see is 1–60 characters.', 'INVALID_LABEL'); args.push(v); sets.push(`customer_label = $${args.length}`); }
      if (p.customerHint !== undefined) { const v = p.customerHint.trim(); if (v.length > 120) throw badRequest('The hint is at most 120 characters.', 'INVALID_HINT'); args.push(v); sets.push(`customer_hint = $${args.length}`); }
      if (p.incidentNote !== undefined) { const v = p.incidentNote === null ? null : p.incidentNote.trim() || null; if (v !== null && v.length > 200) throw badRequest('The incident note is at most 200 characters.', 'INVALID_NOTE'); args.push(v); sets.push(`incident_note = $${args.length}`); }
      if (sets.length > 0) await tx.query(`UPDATE payment_methods SET ${sets.join(', ')} WHERE key = $1`, args);
      await audit(tx, a, 'update_payment_method', `Edited ${m.name}: ${Object.keys(p).join(', ')}`, { method: key, changes: p });
    },
    { label: 'PUT /admin/payment-methods', retries: 0 },
  );
  return (await method(key))!;
}

/** draft → live (only when every readiness line is true), live → paused, paused → live. The one place a status changes. */
export async function setStatus(key: string, to: 'live' | 'paused', a: Actor): Promise<MethodDetail> {
  await withTransaction(
    async (tx) => {
      const m = (await tx.query<{ status: MethodStatus; name: string }>(`SELECT status, name FROM payment_methods WHERE key = $1 FOR UPDATE`, [key])).rows[0];
      if (m === undefined) throw notFound('That payment method does not exist.', 'NO_SUCH_METHOD');
      if (m.status === to) throw conflict(`${m.name} is already ${to}.`, 'NO_CHANGE');
      if (to === 'paused' && m.status === 'draft') throw conflict('A draft has nothing to pause.', 'IS_DRAFT');
      if (to === 'live' && m.status === 'draft') {
        const d = await method(key, tx);
        const missing = d!.readiness.filter((r) => !r.ok).map((r) => r.label.toLowerCase());
        if (missing.length > 0) throw conflict(`Not ready to publish: ${missing.join('; ')}.`, 'NOT_READY');
      }
      await tx.query(`UPDATE payment_methods SET status = $2 WHERE key = $1`, [key, to]);
      await audit(tx, a, to === 'paused' ? 'pause_payment_method' : m.status === 'draft' ? 'publish_payment_method' : 'resume_payment_method',
        to === 'paused' ? `Paused ${m.name} on every checkout` : m.status === 'draft' ? `Published ${m.name}` : `Turned ${m.name} back on`, { method: key });
    },
    { label: 'POST /admin/payment-methods/status', retries: 0 },
  );
  return (await method(key))!;
}
