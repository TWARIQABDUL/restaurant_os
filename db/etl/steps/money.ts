// db/etl/steps/money.ts — wallets, payouts, mobile-money transactions and refunds (plan §5.1, §5.5).
//
// THE LEDGER IS NOT REPLAYED. The old wallet_ledger is single-entry and misstates two movements (a refund labelled
// with the wrong pot, and a partial refund released in full — plan §5.1, traced to the cent). Recomputing a running
// balance from it would bake both errors into the new ledger for good. So:
//
//   * each store's new ledger OPENS with one `adjustment` entry per pot, equal to the OLD WALLET's balance — the
//     figure that is correct and that merchants have been shown — and every old ledger row is carried into
//     legacy_rows as history, marked not summable;
//   * the report then checks the new ledger's sums against the old wallets (they must agree) and states plainly that the
//     old ledger does not agree with the old wallets, by how much, and why.

import { Ctx, Unmapped, cents, read } from '../lib.ts';
import type { MigratedOrder } from './orders.ts';

type Wallet = { tenant_id: string; available_balance: string; pending_balance: string; currency: string };
type LedgerRow = { id: string; tenant_id: string; order_id: string | null; withdrawal_request_id: string | null; entry_type: string; amount: string; balance_type: string; note: string | null; created_at: Date };
type Withdrawal = { id: string; tenant_id: string; requested_by: string; initiated_by: string; amount: string; phone_number: string; status: string; failure_reason: string | null; requested_at: Date; processed_at: Date | null };
type Momo = {
  id: string; reference_id: string; type: string; purpose: string; tenant_id: string | null; order_id: string | null; withdrawal_request_id: string | null;
  refund_request_id: string | null; phone_number: string; amount: string; currency: string; status: string; momo_status_raw: string | null; failure_reason: string | null; created_at: Date; updated_at: Date;
};
type Refund = { id: string; order_id: string; requested_by: string | null; reason: string; status: string; reviewed_by: string | null; created_at: Date; reviewed_at: Date | null; amount: string | null };

export function reasonCode(text: string): 'item_missing' | 'wrong_item' | 'quality_problem' | 'arrived_late' | 'other' {
  const t = text.toLowerCase();
  if (/(missing|not (delivered|included)|forgot)/.test(t)) return 'item_missing';
  if (/(wrong|incorrect|different)/.test(t)) return 'wrong_item';
  if (/(cold|quality|bad|stale|spoil|rotten|damag|raw|burnt|burned|taste)/.test(t)) return 'quality_problem';
  if (/(late|slow|delay|waited|long)/.test(t)) return 'arrived_late';
  return 'other';
}

export async function wallets(ctx: Ctx): Promise<void> {
  const wallets = await read<Wallet>(ctx, 'wallets', ['tenant_id', 'available_balance', 'pending_balance', 'currency'], 'tenant_id');
  for (const w of wallets) {
    if (w.currency !== 'RWF') ctx.decide('money', 'currency-relabelled', w.tenant_id, `The wallet is labelled ${w.currency} (the mobile-money sandbox currency) on amounts that are RWF-sized; it is relabelled RWF, with no conversion.`);
    for (const pot of ['available', 'pending'] as const) {
      const amount = w[`${pot}_balance`];
      if (cents(amount) === 0n) continue;
      if (cents(amount) < 0n) throw new Unmapped(`wallet ${w.tenant_id} has a negative ${pot} balance (${amount})`, 'The new ledger refuses a negative pot. Resolve it in the old system first.');
      await ctx.tgt.query(
        `SELECT wallet_post($1, $2, 'adjustment', $3, $4, 'Previous system', NULL, NULL, NULL, NULL, NULL, $5, NULL)`,
        [w.tenant_id, pot, amount, `migrated:opening:${pot}`, 'Opening balance carried over from the previous system'],
      );
    }
    ctx.counter('wallets').written += 1;
  }
  ctx.decide('money', 'opening-balance', 'all', 'The new ledger opens with the old WALLET balances (not a replay of the old ledger). See plan §5.1 for why the old ledger cannot be summed.');

  const ledger = await read<LedgerRow>(ctx, 'wallet_ledger', ['id', 'tenant_id', 'order_id', 'withdrawal_request_id', 'entry_type', 'amount', 'balance_type', 'note', 'created_at'], 'tenant_id, created_at, id');
  for (const r of ledger) {
    await ctx.archive('wallet_ledger', r.id, r.tenant_id, 'history only, NOT summable: the old ledger is single-entry and misstates two movements (plan §5.1). The new ledger opens with the wallet balance instead.', r);
  }
}

export async function withdrawals(ctx: Ctx): Promise<void> {
  const rows = await read<Withdrawal>(ctx, 'withdrawal_requests', ['id', 'tenant_id', 'requested_by', 'initiated_by', 'amount', 'phone_number', 'status', 'failure_reason', 'requested_at', 'processed_at'], 'tenant_id, requested_at, id');
  const STATUS: Record<string, string> = { pending: 'pending', processing: 'processing', completed: 'completed', failed: 'failed', rejected: 'rejected' };
  for (const w of rows) {
    const status = STATUS[w.status];
    if (status === undefined) throw new Unmapped(`withdrawal ${w.id} has status "${w.status}"`, 'Add it to db/etl/steps/money.ts.');
    const initiated = w.initiated_by === 'auto' ? 'automatic' : w.initiated_by;
    if (initiated !== 'manual' && initiated !== 'automatic') throw new Unmapped(`withdrawal ${w.id} initiated_by "${w.initiated_by}"`, 'Unknown.');
    let reason = w.failure_reason;
    if (status === 'failed' && (reason ?? '').trim() === '') { reason = 'Failed in the previous system (reason not recorded)'; ctx.decide('money', 'failure-reason', w.id, 'A failed payout had no reason; a stated placeholder is stored.'); }
    await ctx.tgt.query(
      `INSERT INTO withdrawals (id, store_id, amount, phone, status, failure_reason, initiated_by, idempotency_key, requested_by, requested_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [w.id, w.tenant_id, w.amount, w.phone_number, status, status === 'failed' ? reason : null, initiated, `migrated:${w.id}`,
       ctx.userMap.get(w.requested_by) ?? null, w.requested_at, status === 'completed' ? (w.processed_at ?? w.requested_at) : null],
    );
    ctx.counter('withdrawal_requests').written += 1;
  }
}

export async function momo(ctx: Ctx, migrated: Map<string, MigratedOrder>): Promise<void> {
  const rows = await read<Momo>(ctx, 'momo_transactions', [
    'id', 'reference_id', 'type', 'purpose', 'tenant_id', 'order_id', 'withdrawal_request_id', 'refund_request_id', 'phone_number', 'amount', 'currency',
    'status', 'momo_status_raw', 'failure_reason', 'created_at', 'updated_at',
  ], 'created_at, id');
  for (const m of rows) {
    if (m.purpose === 'refund') {
      await ctx.archive('momo_transactions', m.id, m.tenant_id, 'a refund payout: the new schema records disbursements against withdrawals only, and the refund itself carries its settlement', m);
      continue;
    }
    const direction = m.type;
    const storeId = m.tenant_id ?? (m.order_id !== null ? migrated.get(m.order_id)?.storeId ?? null : null);
    if (storeId === null) throw new Unmapped(`mobile-money transaction ${m.id} belongs to no store`, 'Cannot place it.');
    await ctx.tgt.query(
      `INSERT INTO momo_transactions (id, store_id, order_id, direction, reference_id, phone, amount, currency, status, provider_status, provider_message, created_at, resolved_at, withdrawal_id, payment_method_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'RWF',$8,$9,$10,$11,$12,$13,'mtn_momo')`,
      [m.id, storeId, direction === 'collection' ? m.order_id : null, direction, m.reference_id, m.phone_number, m.amount, m.status, m.momo_status_raw, m.failure_reason,
       m.created_at, m.status === 'pending' ? null : m.updated_at, direction === 'disbursement' ? m.withdrawal_request_id : null],
    );
    ctx.counter('momo_transactions').written += 1;
  }
  if (rows.some((m) => m.currency !== 'RWF')) ctx.decide('money', 'currency-relabelled', 'momo_transactions', 'Mobile-money rows labelled with the sandbox currency are relabelled RWF, with no conversion.');
}

export async function refunds(ctx: Ctx, migrated: Map<string, MigratedOrder>): Promise<void> {
  const rows = await read<Refund>(ctx, 'refund_requests', ['id', 'order_id', 'requested_by', 'reason', 'status', 'reviewed_by', 'created_at', 'reviewed_at', 'amount'], 'created_at, id');
  for (const r of rows) {
    const order = migrated.get(r.order_id);
    if (order === undefined) throw new Unmapped(`refund request ${r.id} is for order ${r.order_id}, which was not migrated`, 'Should be impossible.');
    if (order.paymentStatus === 'unpaid') {
      await ctx.archive('refund_requests', r.id, order.storeId, 'a refund approved against an order that was never paid (the old bug in plan §5.1); the new schema refuses it', r);
      continue;
    }
    const amount = r.amount ?? order.total;
    const approved = r.status === 'approved' || r.status === 'completed';
    const status = approved ? 'approved' : r.status === 'rejected' ? 'rejected' : r.status === 'pending' ? 'pending' : null;
    if (status === null) throw new Unmapped(`refund request ${r.id} has status "${r.status}"`, 'Unknown.');
    if (r.amount === null) ctx.decide('money', 'refund-amount', r.id, `The request named no amount, so the full order total (${order.total}) is used.`);
    const code = reasonCode(r.reason);
    await ctx.tgt.query(
      `INSERT INTO refunds (id, store_id, order_id, amount, reason_code, reason_note, status, requested_by, reviewed_by, reviewed_at, rejection_reason, created_at, approved_amount, settled_at, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'merchant')`,
      [r.id, order.storeId, r.order_id, amount, code, code === 'other' ? r.reason : null, status, ctx.userMap.get(r.requested_by ?? '') ?? null,
       status === 'pending' ? null : ctx.userMap.get(r.reviewed_by ?? '') ?? null, status === 'pending' ? null : (r.reviewed_at ?? r.created_at),
       status === 'rejected' ? 'Rejected in the previous system (reason not recorded)' : null, r.created_at,
       approved ? amount : null, approved ? (r.reviewed_at ?? r.created_at) : null],
    );
    ctx.counter('refund_requests').written += 1;
  }
}
