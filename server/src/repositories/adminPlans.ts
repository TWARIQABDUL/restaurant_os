// server/src/repositories/adminPlans.ts — milestone 27, part C: AdminPlans.
//
// PRICES ARE NULL, AND THAT IS A VALUE. V006 seeded Starter and Growth with no price and no fees because "finance has not confirmed
// them" (Part 9), and the board prints `[PRICE]` and `[FEE]` placeholders for the same reason. So an empty field here saves NULL —
// "not decided" — never zero, which would read as "free" to anything that later charges by it. Nothing in the system charges a plan
// fee yet (no code reads these columns), so editing them changes what the console SHOWS and what will be charged when something does.
//
// WHAT THE BOARD ADDS THAT IS NOT BUILT: per-plan feature switches (custom domain, analytics beyond 30 days, CSV export …) and the
// "saving notifies the N stores" step. There is no plan_features table and nothing enforces a plan's limits, so a switch would be a
// label on nothing; and notifying stores needs the notice-period decision the board leaves as `[NOTICE PERIOD]`. Both are said on the
// screen. The staff limit IS a real column, but nothing enforces it either — it is saved, shown, and flagged as not enforced yet.

import { badRequest, conflict, db, notFound, withTransaction } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';

export type PlanRow = {
  key: string;
  name: string;
  isDefault: boolean;
  stores: number;
  monthlyPrice: number | null;
  paymentFeePercent: number | null;
  withdrawalFee: number | null;
  currency: string;
  staffAccountLimit: number | null;
};

export async function plans(on: Queryable = db): Promise<PlanRow[]> {
  const r = await on.query<{ key: string; name: string; is_default: boolean; stores: string; monthly_price: string | null; payment_fee_percent: string | null; withdrawal_fee: string | null; currency_code: string | null; staff_account_limit: number | null }>(
    `SELECT p.key, p.name, p.is_default, (SELECT count(*) FROM stores s WHERE s.plan_key = p.key)::text AS stores,
            p.monthly_price::text, p.payment_fee_percent::text, p.withdrawal_fee::text, p.currency_code, p.staff_account_limit
       FROM plans p ORDER BY p.position, p.key`,
  );
  const n = (v: string | null): number | null => (v === null ? null : Number(v));
  return r.rows.map((x) => ({ key: x.key, name: x.name, isDefault: x.is_default, stores: Number(x.stores), monthlyPrice: n(x.monthly_price), paymentFeePercent: n(x.payment_fee_percent), withdrawalFee: n(x.withdrawal_fee), currency: x.currency_code ?? 'RWF', staffAccountLimit: x.staff_account_limit }));
}

export type PlanPatch = { monthlyPrice: number | null; paymentFeePercent: number | null; withdrawalFee: number | null; staffAccountLimit: number | null };

export async function updatePlan(key: string, p: PlanPatch, actor: { id: string; ip: string | null; userAgent: string | null }): Promise<PlanRow> {
  const money = (v: number | null, what: string): void => {
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > 100_000_000)) throw badRequest(`${what} is a number from 0 up, or empty if it isn’t decided.`, 'INVALID_AMOUNT');
  };
  money(p.monthlyPrice, 'The monthly price');
  money(p.withdrawalFee, 'The withdrawal fee');
  if (p.paymentFeePercent !== null && (!Number.isFinite(p.paymentFeePercent) || p.paymentFeePercent < 0 || p.paymentFeePercent > 100)) throw badRequest('A fee percentage is between 0 and 100, or empty.', 'INVALID_FEE');
  if (p.staffAccountLimit !== null && (!Number.isInteger(p.staffAccountLimit) || p.staffAccountLimit < 1 || p.staffAccountLimit > 10_000)) throw badRequest('The staff limit is a whole number, or empty for unlimited.', 'INVALID_LIMIT');

  await withTransaction(
    async (tx) => {
      const before = (await tx.query<{ name: string }>(`SELECT name FROM plans WHERE key = $1 FOR UPDATE`, [key])).rows[0];
      if (before === undefined) throw notFound('That plan does not exist.', 'NO_SUCH_PLAN');
      // A price or a withdrawal fee needs a currency (the table says so); the plan's own is kept, RWF where it has none.
      const priced = p.monthlyPrice !== null || p.withdrawalFee !== null;
      const r = await tx.query(
        `UPDATE plans SET monthly_price = $2, payment_fee_percent = $3, withdrawal_fee = $4, staff_account_limit = $5, currency_code = CASE WHEN $6 THEN COALESCE(currency_code, 'RWF') ELSE currency_code END WHERE key = $1`,
        [key, p.monthlyPrice, p.paymentFeePercent, p.withdrawalFee, p.staffAccountLimit, priced],
      );
      if ((r.rowCount ?? 0) === 0) throw conflict('That plan could not be saved.', 'NOT_SAVED');
      await tx.query(`SELECT audit('config', 'update_plan', $1, $2, NULL, NULL, NULL, NULL, $3::inet, $4, NULL, $5::jsonb)`, [`Changed the ${before.name} plan`, actor.id, actor.ip, actor.userAgent, JSON.stringify({ plan: key, changes: p })]);
    },
    { label: 'PUT /admin/plans', retries: 0 },
  );
  return (await plans()).find((x) => x.key === key)!;
}
