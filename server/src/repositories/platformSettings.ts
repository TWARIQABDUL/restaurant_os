// server/src/repositories/platformSettings.ts — milestone 27, part C: the defaults every store inherits (V032).
//
// THREE KNOBS THE SYSTEM HAD AS CONSTANTS, now data a super admin can change and the audit log remembers:
//   payout_mode_default   how a new store is paid out until its owner chooses (manual withdrawals, or automatic each morning)
//   hold_minutes          how long a paid order sits in Pending before it is Available (was MOMO_HOLD_MINUTES)
//   automatic_payout_at   the time automatic payouts run, in each store's own clock (was DEFAULT_AUTOMATIC_AT)
//
// THE DATABASE WINS, THE ENVIRONMENT IS THE FLOOR. MOMO_HOLD_MINUTES stays as the value used if the row is somehow missing (it is
// seeded, so that is a bug, but a bug that falls back to what the server was deployed with is a bug nobody notices at 08:00). Every
// reader asks here, so there is one answer and not three copies of it; a read is one indexed row, so nothing caches it and a change
// is live on the next request.
//
// EACH VALUE IS VALIDATED HERE, not by the schema: the table is a bag of keys by design (see V032), and the code that gives a key its
// meaning is the code that knows what a sane value is.

import { badRequest, db, withTransaction } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';
import { holdMinutes as envHoldMinutes } from '../payments/momo.ts';

export type PlatformSettings = { payoutModeDefault: 'manual' | 'automatic'; holdMinutes: number; automaticPayoutAt: string };

export const HOLD_MIN = 5;
export const HOLD_MAX = 10_080;

export async function read(on: Queryable = db): Promise<PlatformSettings> {
  const r = await on.query<{ key: string; value: unknown }>(`SELECT key, value FROM platform_settings WHERE key IN ('payout_mode_default', 'hold_minutes', 'automatic_payout_at')`);
  const m = new Map(r.rows.map((x) => [x.key, x.value]));
  const mode = m.get('payout_mode_default');
  const hold = m.get('hold_minutes');
  const at = m.get('automatic_payout_at');
  return {
    payoutModeDefault: mode === 'automatic' ? 'automatic' : 'manual',
    holdMinutes: typeof hold === 'number' && Number.isInteger(hold) && hold >= 0 ? hold : envHoldMinutes(),
    automaticPayoutAt: typeof at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(at) ? at : '08:00',
  };
}

export const holdMinutes = async (on: Queryable = db): Promise<number> => (await read(on)).holdMinutes;

export type SettingsPatch = Partial<PlatformSettings>;

export async function update(patch: SettingsPatch, actor: { id: string; ip: string | null; userAgent: string | null }): Promise<PlatformSettings> {
  const writes: [string, unknown][] = [];
  if (patch.payoutModeDefault !== undefined) {
    if (patch.payoutModeDefault !== 'manual' && patch.payoutModeDefault !== 'automatic') throw badRequest('Payouts are manual or automatic.', 'INVALID_MODE');
    writes.push(['payout_mode_default', patch.payoutModeDefault]);
  }
  if (patch.holdMinutes !== undefined) {
    if (!Number.isInteger(patch.holdMinutes) || patch.holdMinutes < HOLD_MIN || patch.holdMinutes > HOLD_MAX) throw badRequest(`The hold period is between ${HOLD_MIN} minutes and 7 days.`, 'INVALID_HOLD');
    writes.push(['hold_minutes', patch.holdMinutes]);
  }
  if (patch.automaticPayoutAt !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.automaticPayoutAt)) throw badRequest('Use a time like 08:00.', 'INVALID_TIME');
    writes.push(['automatic_payout_at', patch.automaticPayoutAt]);
  }
  if (writes.length === 0) throw badRequest('Nothing to change.', 'NOTHING_TO_CHANGE');

  return withTransaction(
    async (tx: Tx) => {
      const before = await read(tx);
      for (const [key, value] of writes) {
        await tx.query(`UPDATE platform_settings SET value = $2::jsonb, updated_by = $3 WHERE key = $1`, [key, JSON.stringify(value), actor.id]);
      }
      const after = await read(tx);
      await tx.query(`SELECT audit('config', 'update_platform_settings', $1, $2, NULL, NULL, NULL, NULL, $3::inet, $4, NULL, $5::jsonb)`, [
        `Changed platform settings: ${writes.map(([k]) => k.replace(/_/g, ' ')).join(', ')}`, actor.id, actor.ip, actor.userAgent, JSON.stringify({ before, after }),
      ]);
      return after;
    },
    { label: 'PUT /admin/settings', retries: 0 },
  );
}
