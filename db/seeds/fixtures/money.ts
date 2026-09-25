// db/seeds/fixtures/money.ts
//
// Money, and it is all moved through the functions rather than inserted.
//
// That is not fastidiousness. `wallets.pending_balance` and `available_balance` are
// maintained by the ledger's own trigger and a direct UPDATE is refused, so a seed
// that wanted particular balances would have to write particular ledger entries —
// and the entries have a chained `sequence` and `balance_after` that must follow
// their predecessor. The only way to produce a coherent wallet is to move money the
// way the application will: record_momo_collection_success, release_eligible_orders,
// approve_refund, request_withdrawal, reverse_failed_withdrawal, confirm_cash_payment.
//
// §4.5 asks for one ledger entry of each type. There are seven, and the last of them
// — `adjustment` — is the only one no application path produces, so it is written
// here explicitly: a correction has to be possible and has to be visible.

import { STORE, STAFF, TEAM, ORDER, MOMO, REFUND, WITHDRAWAL, PHONE, type Ctx } from './context.ts';

export async function seedMoney(ctx: Ctx): Promise<void> {
  ctx.step('Money');

  // ------------------------------------------------------------------
  // Collections. A MoMo request in flight, and four that succeeded.
  // ------------------------------------------------------------------
  const collections: [string, string, string, string][] = [
    [MOMO.escrow, ORDER.paidEscrow, STORE.nyama, PHONE.pacifique],
    [MOMO.released, ORDER.paidReleased, STORE.nyama, PHONE.sandrine],
    [MOMO.inzu, ORDER.inzuRefunded, STORE.inzu, PHONE.alice],
    [MOMO.tech, ORDER.techDisputed, STORE.techhub, PHONE.hirwa],
    [MOMO.inzuSecond, ORDER.returned, STORE.inzu, PHONE.alice],
  ];

  for (const [momoId, orderId, store, phone] of collections) {
    await ctx.sql(
      `INSERT INTO momo_transactions (id, store_id, order_id, direction, reference_id, phone,
                                      amount, currency, payment_method_key)
       SELECT $1, $2, $3, 'collection', $4, $5, o.total_amount, 'RWF', 'mtn_momo'
         FROM orders o WHERE o.id = $3`,
      [momoId, store, orderId, `ref_seed_${momoId.slice(-8)}`, phone],
    );
    await ctx.sql(`SELECT record_momo_collection_success($1)`, [momoId]);
  }

  // One still unresolved, so the "Approve on your phone" state has a row behind it.
  await ctx.sql(
    `INSERT INTO momo_transactions (store_id, order_id, direction, reference_id, phone, amount, currency, payment_method_key)
     SELECT $1, o.id, 'collection', 'ref_in_flight_0001', $2, o.total_amount, 'RWF', 'mtn_momo'
       FROM orders o WHERE o.id = $3`,
    [STORE.nyama, PHONE.aimable, ORDER.pending],
  );
  ctx.ok(`${collections.length} collections credited to escrow, 1 still waiting on a PIN`);

  // Money from the discounted order too, so Analytics has more than four paid days.
  await ctx.sql(
    `INSERT INTO momo_transactions (store_id, order_id, direction, reference_id, phone, amount, currency, payment_method_key)
     SELECT $1, o.id, 'collection', 'ref_discounted_001', $2, o.total_amount, 'RWF', 'mtn_momo'
       FROM orders o WHERE o.id = $3`,
    [STORE.nyama, PHONE.grace, ORDER.discounted],
  );
  await ctx.sql(
    `SELECT record_momo_collection_success(id) FROM momo_transactions WHERE reference_id = 'ref_discounted_001'`,
  );

  // ------------------------------------------------------------------
  // Escrow. One order's hold has elapsed and one has not, so the wallet has money
  // in BOTH pots — which is what the Wallet screen is drawn against.
  // ------------------------------------------------------------------
  await ctx.sql(
    `UPDATE orders SET paid_at = now() - interval '3 days'
      WHERE id = ANY ($1)`,
    [[ORDER.paidReleased, ORDER.inzuRefunded, ORDER.techDisputed, ORDER.discounted, ORDER.returned]],
  );
  const released = await ctx.sql<{ released_order_id: string }>(`SELECT * FROM release_eligible_orders(60)`);
  ctx.ok(`${released.rows.length} orders out of escrow; ${collections.length - released.rows.length + 1} still held`);

  // ------------------------------------------------------------------
  // Refunds, in all four states the boards draw.
  // ------------------------------------------------------------------
  // 1. Partial, approved and paid — AdminDisputes' own example, 3,000 of 12,500.
  await ctx.sql(
    `INSERT INTO refunds (id, store_id, order_id, amount, reason_code, reason_note, requested_by)
     VALUES ($1, $2, $3, 3000, 'item_missing', 'The salad and fries were not packed.', $4)`,
    [REFUND.partial, STORE.nyama, ORDER.paidReleased, STAFF.aline],
  );
  await ctx.sql(`SELECT approve_refund($1, $2, 2500)`, [REFUND.partial, TEAM.diane]);

  // 2. Rejected, with a reason the merchant reads.
  await ctx.sql(
    `INSERT INTO refunds (id, store_id, order_id, amount, reason_code, reason_note, requested_by)
     VALUES ($1, $2, $3, 1500, 'arrived_late', 'Customer says it took 70 minutes.', $4)`,
    [REFUND.rejected, STORE.nyama, ORDER.paidReleased, STAFF.aline],
  );
  await ctx.sql(
    `SELECT reject_refund($1, $2, 'Delivered inside the window the customer was quoted.')`,
    [REFUND.rejected, TEAM.diane],
  );

  // 3. Full, approved and paid, at Inzu — the wrong-size return.
  await ctx.sql(
    `INSERT INTO refunds (id, store_id, order_id, amount, reason_code, requested_by)
     SELECT $1, $2, $3, o.total_amount, 'wrong_item', $4 FROM orders o WHERE o.id = $3`,
    [REFUND.inzuFull, STORE.inzu, ORDER.inzuRefunded, STAFF.kevin],
  );
  await ctx.sql(`SELECT approve_refund($1, $2)`, [REFUND.inzuFull, TEAM.diane]);

  // ------------------------------------------------------------------
  // Withdrawals. One paid, one that failed and was reversed — "MoMo: account name
  // mismatch", which is the audit log's own example.
  // ------------------------------------------------------------------
  await ctx.sql(
    `SELECT request_withdrawal($1, 15000, $2, 'seed_payout_0001', $3, 'automatic')`,
    [STORE.nyama, PHONE.aline, STAFF.aline],
  );
  await ctx.sql(
    `UPDATE withdrawals SET id = $1, status = 'completed', completed_at = now() - interval '1 day'
      WHERE idempotency_key = 'seed_payout_0001'`,
    [WITHDRAWAL.paid],
  );

  await ctx.sql(
    `SELECT request_withdrawal($1, 4000, $2, 'seed_payout_0002', $3, 'manual')`,
    [STORE.nyama, PHONE.aline, STAFF.aline],
  );
  await ctx.sql(
    `UPDATE withdrawals SET id = $1 WHERE idempotency_key = 'seed_payout_0002'`,
    [WITHDRAWAL.failed],
  );
  await ctx.sql(
    `SELECT reverse_failed_withdrawal($1, 'MoMo: account name mismatch')`,
    [WITHDRAWAL.failed],
  );
  ctx.ok('1 payout completed, 1 failed and reversed so the money came back');

  // ------------------------------------------------------------------
  // A correction. `adjustment` is the one entry type no application path writes,
  // and V005 kept it precisely so that a mistake can be put right in the open
  // rather than by editing a balance.
  // ------------------------------------------------------------------
  await ctx.sql(
    `SELECT wallet_post($1, 'available', 'adjustment', 2500, 'seed_goodwill_0001',
                        'Vendlyfy goodwill', NULL, NULL, NULL, NULL, NULL,
                        'Goodwill credit after the 21 Sep outage', $2)`,
    [STORE.nyama, TEAM.diane],
  );

  // ------------------------------------------------------------------
  // The queued refund, LAST, because it holds a store's payouts and everything above
  // needed them open. This is §5.3's fifth state, and the shortfall is REAL: Inzu's
  // available balance is drained by a payout first, so the refund that follows cannot
  // be covered — which is AdminDisputes' "Not enough available" word for word.
  // ------------------------------------------------------------------
  const inzuAvailable = await ctx.sql<{ available: string }>(
    `SELECT available_balance::text AS available FROM wallets WHERE store_id = $1`,
    [STORE.inzu],
  );
  const drain = Number(inzuAvailable.rows[0]!.available) - 1_000;
  if (drain <= 0) throw new Error(`Inzu has ${inzuAvailable.rows[0]!.available} available; nothing to drain`);
  await ctx.sql(
    `SELECT request_withdrawal($1, $2, $3, 'seed_payout_0003', $4, 'manual')`,
    [STORE.inzu, drain, PHONE.kevin, STAFF.kevin],
  );

  await ctx.sql(
    `INSERT INTO refunds (id, store_id, order_id, amount, reason_code, reason_note, requested_by)
     SELECT $1, $2, o.id, o.total_amount, 'quality_problem', 'Customer says the shirt arrived creased and marked.', $3
       FROM orders o WHERE o.id = $4`,
    [REFUND.queued, STORE.inzu, STAFF.kevin, ORDER.returned],
  );
  await ctx.sql(`SELECT approve_refund($1, $2)`, [REFUND.queued, TEAM.diane]);
  const after = await ctx.sql<{ status: string; approved: string }>(
    `SELECT status, approved_amount::text AS approved FROM refunds WHERE id = $1`,
    [REFUND.queued],
  );
  if (after.rows[0]!.status !== 'queued') {
    throw new Error(`the refund meant to queue is ${after.rows[0]!.status} — Inzu had more than expected`);
  }
  ctx.ok(
    `a refund of ${after.rows[0]!.approved} is approved and WAITING on 1,000 available ` +
      "— Inzu Threads' payouts are held until it settles",
  );

  // ------------------------------------------------------------------
  // Cash. The rider collected less than the total, which never reaches the ledger:
  // the merchant already had the money, so a shortfall is theirs and lives on the
  // order and the day's reconciliation.
  // ------------------------------------------------------------------
  await ctx.sql(
    `SELECT confirm_cash_payment($1, (SELECT total_amount - 1000 FROM orders WHERE id = $1), $2)`,
    [ORDER.cashShort, STAFF.patrick],
  );

  // A day that is a running account of several hand-ins, and closes with a gap the
  // rider is carrying into next shift.
  await ctx.sql(
    `INSERT INTO rider_cash_handovers (store_id, rider_user_id, amount, handed_at, received_by, note) VALUES
       ($1, $2, 6000, now() - interval '1 day 6 hours', $3, 'Handed in at 12:00'),
       ($1, $2, 4500, now() - interval '1 day 2 hours', $3, 'Second hand-in, end of shift')`,
    [STORE.nyama, STAFF.olivier, STAFF.patrick],
  );
  await ctx.sql(
    `INSERT INTO rider_cash_settlements (store_id, rider_user_id, business_date, expected_amount,
                                         handed_over_amount, counted_amount, gap_resolution, gap_note,
                                         closed_by, closed_at)
     -- gap = expected - handed_over - counted. The two hand-ins above come to 10,500
     -- and nothing was left to count at close, so the day is 1,000 short.
     VALUES ($1, $2, current_date - 1, 11500, 10500, 0, 'carry_over',
             'Olivier brings the last 1,000 next shift.', $3, now() - interval '1 day')`,
    [STORE.nyama, STAFF.olivier, STAFF.patrick],
  );
  // And a day that balanced, so CashReport has a clean one beside the awkward one.
  await ctx.sql(
    `INSERT INTO rider_cash_handovers (store_id, rider_user_id, amount, handed_at, received_by)
       VALUES ($1, $2, 8000, now() - interval '2 days 3 hours', $3)`,
    [STORE.nyama, STAFF.eric, STAFF.patrick],
  );
  await ctx.sql(
    `INSERT INTO rider_cash_settlements (store_id, rider_user_id, business_date, expected_amount,
                                         handed_over_amount, counted_amount, closed_by, closed_at)
     VALUES ($1, $2, current_date - 2, 8000, 8000, 0, $3, now() - interval '2 days')`,
    [STORE.nyama, STAFF.eric, STAFF.patrick],
  );
  ctx.ok('a cash order short by 1,000, one day carried over and one that balanced');

  // ------------------------------------------------------------------
  // Prove it, here rather than in a test: the ledger has every entry type, and the
  // balances are the ledger's own sums.
  // ------------------------------------------------------------------
  const types = await ctx.sql<{ missing: string | null }>(
    `SELECT string_agg(t.kind, ', ' ORDER BY t.kind) AS missing
       FROM (VALUES ('order_payment_received'), ('escrow_released_out'), ('escrow_released_in'),
                    ('refund_paid'), ('withdrawal_reserved'), ('withdrawal_reversed'), ('adjustment')) t(kind)
      WHERE NOT EXISTS (SELECT 1 FROM wallet_ledger l WHERE l.entry_type = t.kind)`,
  );
  if (types.rows[0]!.missing) {
    throw new Error(`the ledger is missing entry types: ${types.rows[0]!.missing}`);
  }

  const drift = await ctx.sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM wallets w
      WHERE w.pending_balance <> (SELECT COALESCE(sum(amount), 0) FROM wallet_ledger
                                   WHERE store_id = w.store_id AND pot = 'pending')
         OR w.available_balance <> (SELECT COALESCE(sum(amount), 0) FROM wallet_ledger
                                     WHERE store_id = w.store_id AND pot = 'available')`,
  );
  if (Number(drift.rows[0]!.n) !== 0) {
    throw new Error(`${drift.rows[0]!.n} wallet(s) disagree with their ledger`);
  }
  ctx.ok('all 7 ledger entry types present, and every balance is its own ledger’s sum');
}
