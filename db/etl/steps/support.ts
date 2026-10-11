// db/etl/steps/support.ts — complaints, reviews, and everything with no home (plan §5.5).
//
// "Orphaned TypeORM tables → nothing: check whether they hold rows, record the answer, do not carry them." The
// answer is recorded: an empty table is a counted zero in the report, a table with rows is ARCHIVED, never dropped.

import { Ctx, Unmapped, read } from '../lib.ts';
import { reasonCode } from './money.ts';
import type { MigratedOrder } from './orders.ts';

type Complaint = {
  id: string; tenant_id: string; order_id: string; issue_type: string; description: string; status: string; is_escalated: boolean | null;
  escalation_reason: string | null; resolution_notes: string | null; created_at: Date; updated_at: Date | null; refunded_amount: string | null;
};
type Review = { id: string; tenant_id: string; menu_item_id: string; customer_id: string; rating: number; comment: string | null; created_at: Date };

export async function complaints(ctx: Ctx, migrated: Map<string, MigratedOrder>): Promise<void> {
  const rows = await read<Complaint>(ctx, 'complaints', [
    'id', 'tenant_id', 'order_id', 'issue_type', 'description', 'status', 'is_escalated', 'escalation_reason', 'resolution_notes', 'created_at', 'updated_at', 'refunded_amount',
  ], 'created_at, id');
  for (const c of rows) {
    if (!migrated.has(c.order_id)) throw new Unmapped(`complaint ${c.id} is about order ${c.order_id}, which was not migrated`, 'Should be impossible.');
    const code = reasonCode(c.issue_type);
    const owner = await ctx.tgt.query<{ user_id: string }>(`SELECT user_id FROM store_members WHERE store_id = $1 AND role = 'owner' LIMIT 1`, [c.tenant_id]);
    const escalated = c.is_escalated === true && c.status === 'open';
    const status = escalated ? 'escalated' : c.status;
    if (!['open', 'escalated', 'resolved', 'rejected'].includes(status)) throw new Unmapped(`complaint ${c.id} has status "${c.status}"`, 'Unknown.');
    const closedAt = status === 'resolved' || status === 'rejected' ? (c.updated_at ?? c.created_at) : null;
    const escalatedBy = escalated ? owner.rows[0]?.user_id ?? null : null;
    if (escalated && escalatedBy === null) throw new Unmapped(`complaint ${c.id} is escalated but its store has no owner to attribute that to`, 'The new schema records who escalated.');
    if (escalated) ctx.decide('support', 'escalated-by', c.id, 'The old system did not record who escalated; the store owner is recorded.');

    const customer = (await ctx.tgt.query<{ customer_user_id: string | null }>(`SELECT customer_user_id FROM orders WHERE id = $1`, [c.order_id])).rows[0]?.customer_user_id ?? null;
    await ctx.tgt.query(
      `INSERT INTO complaints (id, store_id, order_id, customer_user_id, reason_code, detail, status, closed_at, escalated_by, escalated_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [c.id, c.tenant_id, c.order_id, customer, code, c.description, status, closedAt, escalatedBy, escalated ? (c.updated_at ?? c.created_at) : null, c.created_at, c.updated_at ?? c.created_at],
    );
    ctx.counter('complaints').written += 1;
    await ctx.tgt.query(
      `INSERT INTO complaint_events (complaint_id, store_id, sequence, event_type, from_status, to_status, actor_side, note, created_at)
       VALUES ($1,$2,1,'filed',NULL,'open','customer',$3,$4)`,
      [c.id, c.tenant_id, c.issue_type, c.created_at],
    );
    if (status !== 'open') {
      const type = status === 'escalated' ? 'escalated' : status;
      await ctx.tgt.query(
        `INSERT INTO complaint_events (complaint_id, store_id, sequence, event_type, from_status, to_status, actor_side, note, created_at)
         VALUES ($1,$2,2,$3,'open',$4,'system',$5,$6)`,
        [c.id, c.tenant_id, type, status, 'Migrated from the previous system. ' + (c.resolution_notes ?? c.escalation_reason ?? ''), c.updated_at ?? c.created_at],
      );
    }
    if (code === 'other' || c.resolution_notes !== null || c.escalation_reason !== null || c.refunded_amount !== null) {
      await ctx.archive('complaints', c.id, c.tenant_id, 'original issue type, resolution notes, escalation reason and refunded amount, which the new complaint holds only in part', {
        issue_type: c.issue_type, resolution_notes: c.resolution_notes, escalation_reason: c.escalation_reason, refunded_amount: c.refunded_amount,
      });
    }
  }
}

export async function reviews(ctx: Ctx): Promise<void> {
  const rows = await read<Review>(ctx, 'reviews', ['id', 'tenant_id', 'menu_item_id', 'customer_id', 'rating', 'comment', 'created_at'], 'created_at, id');
  for (const r of rows) {
    const customer = ctx.userMap.get(r.customer_id) ?? null;
    // A new review is about a PURCHASED line. The old one named only a product, so find the customer's latest order that sold it.
    const line = customer === null ? null : (await ctx.tgt.query<{ id: string; order_id: string }>(
      `SELECT oi.id, oi.order_id FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.store_id = oi.store_id
         JOIN product_variants v ON v.id = oi.variant_id
        WHERE v.product_id = $1 AND o.customer_user_id = $2 AND o.status IN ('delivered', 'collected') AND NOT EXISTS (SELECT 1 FROM reviews x WHERE x.order_item_id = oi.id)
        ORDER BY o.created_at DESC LIMIT 1`, [r.menu_item_id, customer])).rows[0] ?? null;
    if (line === null) {
      await ctx.archive('reviews', r.id, r.tenant_id, 'the new model reviews a purchased order line; this customer has no order for the product', r);
      ctx.decide('support', 'review-archived', r.id, 'A review could not be tied to an order line the customer bought, so it is archived instead of imported.');
      continue;
    }
    await ctx.tgt.query(
      `INSERT INTO reviews (id, store_id, product_id, order_id, order_item_id, customer_user_id, rating, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.id, r.tenant_id, r.menu_item_id, line.order_id, line.id, customer, r.rating, (r.comment ?? '').trim() === '' ? null : r.comment, r.created_at],
    );
    ctx.counter('reviews').written += 1;
  }
}

/** Notifications, orphaned tables and platform settings. */
export async function leftovers(ctx: Ctx): Promise<void> {
  const notes = await ctx.src.query<{ id: string; tenant_id: string; user_id: string | null; message: string; icon: string | null; action_url: string | null; is_read: boolean | null; created_at: Date }>(
    `SELECT "id","tenant_id","user_id","message","icon","action_url","is_read","created_at" FROM public.notifications ORDER BY created_at, id`,
  );
  ctx.counter('notifications').read += notes.rows.length;
  for (const n of notes.rows) await ctx.archive('notifications', n.id, n.tenant_id, 'old free-text notifications: the new inbox is typed events with their own routes, so these are history only', n);

  for (const table of ['addon_groups', 'addon_items', 'menu_item_addon_groups', 'delivery_assignments', 'delivery_persons', 'posts']) {
    const exists = await ctx.src.query<{ x: string | null }>(`SELECT to_regclass($1) AS x`, [`public.${table}`]);
    if (exists.rows[0]?.x === null) { ctx.decide('leftovers', 'orphan-table', table, 'does not exist in the source'); continue; }
    // SELECT * is deliberate and confined to this one line: these are tables the new schema does not model, so there is no column list to
    // name — the whole row IS the thing being archived, and a column nobody knew about should come across too. (The new server's pool bans it.)
    const all = await ctx.src.query<Record<string, unknown>>(`SELECT * FROM public."${table}"`);  
    ctx.counter(table).read += all.rows.length;
    if (all.rows.length === 0) { ctx.decide('leftovers', 'orphan-table', table, 'empty — nothing to carry'); continue; }
    for (const row of all.rows) await ctx.archive(table, String(row['id'] ?? ''), null, 'a table from the TypeORM era that the new schema does not carry', row);
    ctx.decide('leftovers', 'orphan-table', table, `${all.rows.length} row(s) archived in legacy_rows — decide before cutover whether they matter.`);
  }

  const settings = await ctx.src.query<{ allowed_currencies: string[]; default_settlement_mode: string; default_hold_minutes: number }>(
    `SELECT "allowed_currencies","default_settlement_mode","default_hold_minutes" FROM public.platform_settings LIMIT 1`,
  );
  const s = settings.rows[0];
  if (s !== undefined) {
    await ctx.tgt.query(`UPDATE platform_settings SET value = to_jsonb($1::int) WHERE key = 'hold_minutes'`, [s.default_hold_minutes]);
    await ctx.tgt.query(`UPDATE platform_settings SET value = to_jsonb($1::text) WHERE key = 'payout_mode_default'`, [s.default_settlement_mode === 'auto' ? 'automatic' : 'manual']);
    ctx.decide('leftovers', 'platform-settings', 'hold + payout mode', `Hold ${s.default_hold_minutes} min and ${s.default_settlement_mode === 'auto' ? 'automatic' : 'manual'} payouts carried across. The old allowed currencies (${s.allowed_currencies.join(', ')}) were a sandbox setting and are not carried: the new system's currencies are managed in Admin → Currencies.`);
  }
}
