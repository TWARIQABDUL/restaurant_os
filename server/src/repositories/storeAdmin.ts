// server/src/repositories/storeAdmin.ts — milestone 25: what Settings writes.
//
// Milestone 11 gave Settings a READ (repositories/stores.ts: store, pickup, payout destination, methods). This is the
// other half, and the screens it serves are Settings' own panels: Delivery and pickup, Payments, Store details.
//
// EVERY WRITE IS SCOPED TO ONE STORE BY ITS FIRST PARAMETER, and the tenancy is the schema's, not this file's: zones,
// areas, hours, pickup and methods are all keyed on `store_id` and the composite foreign keys (zone_id, store_id) make
// a zone of another store unrepresentable. What this file adds is the checks that give a merchant a SENTENCE instead of a
// constraint name — which area is already in which zone, why the last payment method cannot be switched off.

import { badRequest, conflict, db, notFound } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';

const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export type Zone = {
  id: string;
  name: string;
  feeAmount: string;
  etaMinMinutes: number;
  etaMaxMinutes: number;
  isActive: boolean;
  areas: string[];
};

export type HoursRow = { day: number; opens: string; closes: string };
export type MethodInfo = { key: string; name: string; kind: 'online' | 'offline'; status: string };

export type SettingsExtra = {
  store: { name: string; slug: string; publicPhone: string | null; address: string | null; timeZone: string; acceptingOrders: boolean };
  zones: Zone[];
  hours: HoursRow[];
  catalogue: MethodInfo[];
};

export async function read(storeId: string, on: Queryable = db): Promise<SettingsExtra | null> {
  const store = await on.query<{ name: string; slug: string; public_phone: string | null; address: string | null; time_zone: string; accepting_orders: boolean }>(
    `SELECT name, slug, public_phone, address, time_zone, accepting_orders FROM stores WHERE id = $1`,
    [storeId],
  );
  const s = store.rows[0];
  if (s === undefined) return null;

  const zones = await on.query<{ id: string; name: string; fee: string; eta_min: number; eta_max: number; is_active: boolean; areas: string[] }>(
    `SELECT z.id, z.name, z.fee_amount::text AS fee, z.eta_min_minutes AS eta_min, z.eta_max_minutes AS eta_max, z.is_active,
            COALESCE(array_agg(a.area_name ORDER BY a.area_name) FILTER (WHERE a.area_name IS NOT NULL), '{}') AS areas
       FROM delivery_zones z
       LEFT JOIN delivery_zone_areas a ON a.zone_id = z.id
      WHERE z.store_id = $1
      GROUP BY z.id
      ORDER BY z.position, z.id`,
    [storeId],
  );
  const hours = await on.query<{ day: number; opens: string; closes: string }>(
    `SELECT day_of_week AS day, to_char(opens_at, 'HH24:MI') AS opens, to_char(closes_at, 'HH24:MI') AS closes
       FROM store_hours WHERE store_id = $1 ORDER BY day_of_week`,
    [storeId],
  );
  const catalogue = await on.query<MethodInfo>(`SELECT key, name, kind, status FROM payment_methods ORDER BY position`);

  return {
    store: { name: s.name, slug: s.slug, publicPhone: s.public_phone, address: s.address, timeZone: s.time_zone, acceptingOrders: s.accepting_orders },
    zones: zones.rows.map((z) => ({ id: z.id, name: z.name, feeAmount: z.fee, etaMinMinutes: z.eta_min, etaMaxMinutes: z.eta_max, isActive: z.is_active, areas: z.areas })),
    hours: hours.rows,
    catalogue: catalogue.rows,
  };
}

// ---------------------------------------------------------------------------
// Store details
// ---------------------------------------------------------------------------

export type DetailsInput = { name: string; publicPhone: string | null; address: string | null; timeZone: string };

export async function updateDetails(storeId: string, d: DetailsInput, tx: Tx): Promise<void> {
  if (d.name.trim().length < 2) throw badRequest('Give your store a name.', 'NAME_REQUIRED');
  if (d.publicPhone !== null && d.publicPhone.replace(/\D/g, '').length < 7) {
    throw badRequest('That phone number looks too short.', 'INVALID_PHONE');
  }
  // V021 validates the zone on write too; asking first turns its constraint name into a sentence.
  const zone = await tx.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [d.timeZone]);
  if (zone.rows.length === 0) throw badRequest('That is not a time zone we know. Try one like Africa/Kigali.', 'INVALID_TIME_ZONE');

  await tx.query(`UPDATE stores SET name = $2, public_phone = $3, address = $4, time_zone = $5 WHERE id = $1`, [
    storeId,
    d.name.trim(),
    d.publicPhone,
    d.address,
    d.timeZone,
  ]);
}

/**
 * Replaces the whole week. A day that is absent is a day the store is closed, which is how store_hours already means it
 * (V018: "a row per open day"). Opening and closing may be either way round — 18:00–01:00 is a grill that is still open at
 * 00:30 — but not the same minute, which would be open for no time at all.
 */
export async function replaceHours(storeId: string, rows: HoursRow[], tx: Tx): Promise<void> {
  const seen = new Set<number>();
  for (const r of rows) {
    if (!Number.isInteger(r.day) || r.day < 1 || r.day > 7) throw badRequest('A day is 1 (Monday) to 7 (Sunday).', 'INVALID_DAY');
    if (seen.has(r.day)) throw badRequest('A day appears twice.', 'DUPLICATE_DAY');
    seen.add(r.day);
    if (!CLOCK.test(r.opens) || !CLOCK.test(r.closes)) throw badRequest('Times look like 09:00.', 'INVALID_TIME');
    if (r.opens === r.closes) throw badRequest('Opening and closing at the same time is not open at all. Leave the day out to close it.', 'INVALID_HOURS');
  }
  await tx.query(`DELETE FROM store_hours WHERE store_id = $1`, [storeId]);
  for (const r of rows) {
    await tx.query(`INSERT INTO store_hours (store_id, day_of_week, opens_at, closes_at) VALUES ($1, $2, $3::time, $4::time)`, [storeId, r.day, r.opens, r.closes]);
  }
}

// ---------------------------------------------------------------------------
// Delivery zones and pickup
// ---------------------------------------------------------------------------

export type ZoneInput = { name: string; fee: string; etaMin: number; etaMax: number; areas: string[] };

function cleanZone(z: ZoneInput): ZoneInput {
  const name = z.name.trim();
  if (name === '') throw badRequest('Give the zone a name.', 'NAME_REQUIRED');
  if (!MONEY.test(z.fee)) throw badRequest('Enter the delivery fee as an amount, like 1000.', 'INVALID_FEE');
  if (!Number.isInteger(z.etaMin) || !Number.isInteger(z.etaMax) || z.etaMin < 1 || z.etaMax < z.etaMin || z.etaMax > 720) {
    throw badRequest('The delivery time needs a shortest and a longest, in minutes, shortest first.', 'INVALID_ETA');
  }
  const seen = new Set<string>();
  const areas: string[] = [];
  for (const raw of z.areas) {
    const a = raw.trim().replace(/\s+/g, ' ');
    if (a === '' || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    areas.push(a);
  }
  if (areas.length > 40) throw badRequest('A zone can cover up to 40 areas.', 'TOO_MANY_AREAS');
  return { name, fee: z.fee, etaMin: z.etaMin, etaMax: z.etaMax, areas };
}

async function setAreas(storeId: string, zoneId: string, areas: string[], tx: Tx): Promise<void> {
  if (areas.length > 0) {
    // One zone per area per store (V007: otherwise the fee depends on read order). Say which zone has it.
    const clash = await tx.query<{ area_name: string; zone: string }>(
      `SELECT a.area_name, z.name AS zone
         FROM delivery_zone_areas a JOIN delivery_zones z ON z.id = a.zone_id
        WHERE a.store_id = $1 AND a.zone_id <> $2 AND lower(btrim(a.area_name)) = ANY($3::text[])
        LIMIT 1`,
      [storeId, zoneId, areas.map((a) => a.toLowerCase())],
    );
    const c = clash.rows[0];
    if (c !== undefined) throw conflict(`${c.area_name} is already delivered under “${c.zone}”. An area can be in one zone.`, 'AREA_TAKEN');
  }
  await tx.query(`DELETE FROM delivery_zone_areas WHERE zone_id = $1`, [zoneId]);
  for (const a of areas) {
    await tx.query(`INSERT INTO delivery_zone_areas (zone_id, store_id, area_name) VALUES ($1, $2, $3)`, [zoneId, storeId, a]);
  }
}

function nameTaken(name: string): Error {
  return conflict(`You already have a zone called “${name}”.`, 'NAME_TAKEN');
}

export async function createZone(storeId: string, input: ZoneInput, tx: Tx): Promise<string> {
  const z = cleanZone(input);
  const dup = await tx.query(`SELECT 1 FROM delivery_zones WHERE store_id = $1 AND lower(btrim(name)) = lower($2)`, [storeId, z.name]);
  if (dup.rows.length > 0) throw nameTaken(z.name);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO delivery_zones (store_id, name, fee_amount, eta_min_minutes, eta_max_minutes, position)
     VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT max(position) FROM delivery_zones WHERE store_id = $1), 0) + 1)
     RETURNING id`,
    [storeId, z.name, z.fee, z.etaMin, z.etaMax],
  );
  const id = rows[0]!.id;
  await setAreas(storeId, id, z.areas, tx);
  return id;
}

export async function updateZone(storeId: string, zoneId: string, input: ZoneInput, tx: Tx): Promise<void> {
  const z = cleanZone(input);
  const own = await tx.query(`SELECT 1 FROM delivery_zones WHERE id = $1 AND store_id = $2 FOR UPDATE`, [zoneId, storeId]);
  if (own.rows.length === 0) throw notFound('That zone does not exist.', 'ZONE_NOT_FOUND');
  const dup = await tx.query(`SELECT 1 FROM delivery_zones WHERE store_id = $1 AND id <> $2 AND lower(btrim(name)) = lower($3)`, [storeId, zoneId, z.name]);
  if (dup.rows.length > 0) throw nameTaken(z.name);
  await tx.query(`UPDATE delivery_zones SET name = $3, fee_amount = $4, eta_min_minutes = $5, eta_max_minutes = $6 WHERE id = $1 AND store_id = $2`, [
    zoneId,
    storeId,
    z.name,
    z.fee,
    z.etaMin,
    z.etaMax,
  ]);
  await setAreas(storeId, zoneId, z.areas, tx);
}

export async function deleteZone(storeId: string, zoneId: string, tx: Tx): Promise<boolean> {
  const r = await tx.query(`DELETE FROM delivery_zones WHERE id = $1 AND store_id = $2`, [zoneId, storeId]);
  return (r.rowCount ?? 0) > 0;
}

export type PickupInput = { address: string; readyMinutes: number; instructions: string | null };

/** `null` turns pickup off: the row IS the offer ("absent when the store does not offer pickup", V007). */
export async function setPickup(storeId: string, p: PickupInput | null, tx: Tx): Promise<void> {
  if (p === null) {
    await tx.query(`DELETE FROM store_pickup_settings WHERE store_id = $1`, [storeId]);
    return;
  }
  if (p.address.trim() === '') throw badRequest('Say where customers collect from.', 'ADDRESS_REQUIRED');
  if (!Number.isInteger(p.readyMinutes) || p.readyMinutes < 1 || p.readyMinutes > 1440) throw badRequest('Ready time is a number of minutes.', 'INVALID_ETA');
  await tx.query(
    `INSERT INTO store_pickup_settings (store_id, address, ready_minutes, instructions) VALUES ($1, $2, $3, $4)
     ON CONFLICT (store_id) DO UPDATE SET address = EXCLUDED.address, ready_minutes = EXCLUDED.ready_minutes, instructions = EXCLUDED.instructions`,
    [storeId, p.address.trim(), p.readyMinutes, p.instructions],
  );
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Connects or disconnects a payment method for this store.
 *
 * A method the platform has not made active cannot be connected (a draft or paused one would take orders it cannot take),
 * and the LAST connected method cannot be switched off: a store that accepts no payment at all cannot take an order, and
 * "my checkout went blank" is a worse way to find that out than a sentence here.
 */
export async function setMethodConnected(storeId: string, key: string, connected: boolean, tx: Tx): Promise<void> {
  const method = await tx.query<{ status: string; name: string }>(`SELECT status, name FROM payment_methods WHERE key = $1`, [key]);
  const m = method.rows[0];
  if (m === undefined) throw notFound('That payment method does not exist.', 'METHOD_NOT_FOUND');

  if (connected) {
    if (m.status !== 'live') throw conflict(`${m.name} is not available right now.`, 'METHOD_UNAVAILABLE');
    await tx.query(
      `INSERT INTO store_payment_methods (store_id, payment_method_key, is_connected, connected_at) VALUES ($1, $2, true, now())
       ON CONFLICT (store_id, payment_method_key) DO UPDATE SET is_connected = true, connected_at = COALESCE(store_payment_methods.connected_at, now())`,
      [storeId, key],
    );
    return;
  }

  const others = await tx.query(
    `SELECT 1 FROM store_payment_methods WHERE store_id = $1 AND is_connected AND payment_method_key <> $2 LIMIT 1`,
    [storeId, key],
  );
  if (others.rows.length === 0) throw conflict('Keep at least one way to get paid — customers couldn’t check out without it.', 'LAST_METHOD');
  await tx.query(`UPDATE store_payment_methods SET is_connected = false, connected_at = NULL WHERE store_id = $1 AND payment_method_key = $2`, [storeId, key]);
}

/**
 * Where payouts go. The CALLER has already verified the signed-in person's password — see the route — because this is the
 * one setting that redirects the store's money, and a stolen session should not be able to do it.
 */
export async function setPayoutDestination(storeId: string, methodKey: string, phone: string, tx: Tx): Promise<{ previousPhone: string | null }> {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) throw badRequest('That does not look like a mobile money number.', 'INVALID_PHONE');

  const method = await tx.query<{ kind: string; status: string }>(`SELECT kind, status FROM payment_methods WHERE key = $1`, [methodKey]);
  const m = method.rows[0];
  if (m === undefined || m.kind !== 'online' || m.status !== 'live') {
    throw badRequest('Payouts go to a mobile money account, like MTN MoMo or Airtel Money.', 'INVALID_PAYOUT_METHOD');
  }

  const previous = await tx.query<{ payout_phone: string }>(`SELECT payout_phone FROM store_payout_settings WHERE store_id = $1 FOR UPDATE`, [storeId]);
  await tx.query(
    `INSERT INTO store_payout_settings (store_id, payout_method_key, payout_phone, settlement_mode) VALUES ($1, $2, $3, 'manual')
     ON CONFLICT (store_id) DO UPDATE SET payout_method_key = EXCLUDED.payout_method_key, payout_phone = EXCLUDED.payout_phone`,
    [storeId, methodKey, phone.trim()],
  );
  return { previousPhone: previous.rows[0]?.payout_phone ?? null };
}
