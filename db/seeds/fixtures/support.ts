// db/seeds/fixtures/support.ts
//
// Complaints, reviews, notifications and the audit log.
//
// ONE DELIBERATE DEPARTURE, and it is about ids rather than behaviour. A complaint
// and its first event are written here by hand, with the fixed id from context.ts,
// instead of through file_complaint() — because that function allocates the id
// itself and `complaint_events` composite-keys to it, so adopting a fixed id
// afterwards would break the very foreign key that keeps the thread inside one
// store. The deferred chain check still validates the pair at commit, so the
// invariant is exercised either way; everything AFTER the filing goes through the
// real functions, because those are the ones that move money.

import { STORE, STAFF, TEAM, CUSTOMER, ORDER, PRODUCT, COMPLAINT, REVIEW, REFUND, WITHDRAWAL, type Ctx } from './context.ts';

/** A complaint plus its filing event, keeping the fixed id. */
async function fileWithFixedId(
  ctx: Ctx,
  args: { id: string; store: string; order: string; customer: string | null; reason: string; detail: string },
): Promise<void> {
  await ctx.sql(
    `INSERT INTO complaints (id, store_id, order_id, customer_user_id, reason_code, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - interval '3 hours')`,
    [args.id, args.store, args.order, args.customer, args.reason, args.detail],
  );
  await ctx.sql(
    `INSERT INTO complaint_events (complaint_id, store_id, event_type, to_status, actor_side, actor_id, note, created_at)
     VALUES ($1, $2, 'filed', 'open', 'customer', $3, $4, now() - interval '3 hours')`,
    [args.id, args.store, args.customer, args.detail],
  );
}

export async function seedSupport(ctx: Ctx): Promise<void> {
  ctx.step('Complaints');

  // 1. Open — the merchant owes a reply. Complaints.dc.html's first card.
  await fileWithFixedId(ctx, {
    id: COMPLAINT.open, store: STORE.nyama, order: ORDER.paidEscrow, customer: CUSTOMER.pacifique,
    reason: 'item_missing',
    detail: 'The salad wasn’t in the bag. Everything else was fine.',
  });
  await ctx.sql(
    `INSERT INTO complaint_evidence (complaint_id, store_id, side, kind, label, storage_key, uploaded_by) VALUES
       ($1, $2, 'customer', 'photo', 'Photo of bag',     'ev/bag.jpg',     $3),
       ($1, $2, 'customer', 'photo', 'Photo of receipt', 'ev/receipt.jpg', $3)`,
    [COMPLAINT.open, STORE.nyama, CUSTOMER.pacifique],
  );

  // 2. Escalated — rejected, reopened, then sent to Vendlyfy. The full argument.
  await fileWithFixedId(ctx, {
    id: COMPLAINT.escalated, store: STORE.techhub, order: ORDER.techDisputed, customer: CUSTOMER.hirwa,
    reason: 'other',
    detail: 'Rider says delivered but nothing came.',
  });
  await ctx.sql(
    `SELECT reject_complaint($1, $2, 'Our rider has a delivery photo at the gate.')`,
    [COMPLAINT.escalated, STAFF.habimana],
  );
  await ctx.sql(
    `SELECT reopen_complaint($1, 'customer', $2, 'That photo is not my gate.')`,
    [COMPLAINT.escalated, CUSTOMER.hirwa],
  );
  await ctx.sql(
    `SELECT escalate_complaint($1, $2, 'We disagree on what was delivered. Please decide.')`,
    [COMPLAINT.escalated, STAFF.habimana],
  );
  await ctx.sql(
    `INSERT INTO complaint_evidence (complaint_id, store_id, side, kind, label, storage_key) VALUES
       ($1, $2, 'rider', 'photo', 'Rider photo at gate', 'ev/gate.jpg')`,
    [COMPLAINT.escalated, STORE.techhub],
  );
  await ctx.sql(
    `INSERT INTO complaint_evidence (complaint_id, store_id, side, kind, label) VALUES
       ($1, $2, 'rider', 'location_log', 'GPS log 16:05')`,
    [COMPLAINT.escalated, STORE.techhub],
  );

  // 3. Resolved, with a refund request behind it that Vendlyfy has already paid.
  await fileWithFixedId(ctx, {
    id: COMPLAINT.resolved, store: STORE.nyama, order: ORDER.paidReleased, customer: CUSTOMER.sandrine,
    reason: 'arrived_late',
    detail: 'Waited 70 minutes.',
  });
  await ctx.sql(
    `SELECT resolve_complaint($1, $2, 'Sorry — a rider fell ill. Next order’s delivery is on us.')`,
    [COMPLAINT.resolved, STAFF.aline],
  );

  // 4. Rejected, and reopenable — the state the board tells the customer about.
  await fileWithFixedId(ctx, {
    id: COMPLAINT.rejected, store: STORE.nyama, order: ORDER.delivered, customer: CUSTOMER.sandrine,
    reason: 'quality_problem',
    detail: 'The wrap was cold by the time it arrived.',
  });
  await ctx.sql(
    `SELECT reject_complaint($1, $2, 'It left the kitchen hot and was delivered in 22 minutes.')`,
    [COMPLAINT.rejected, STAFF.patrick],
  );

  const complaintStates = await ctx.sql<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM complaints GROUP BY status ORDER BY status`,
  );
  ctx.ok(complaintStates.rows.map((r) => `${r.n} ${r.status}`).join(', '));

  // ------------------------------------------------------------------
  ctx.step('Reviews');
  // ------------------------------------------------------------------
  // Written directly, for the same id reason as complaints. The purchase-verify
  // trigger still runs: every one of these has to name an order line its own
  // customer actually bought, which is what "Ordered here" means.
  type R = { id: string; order: string; product: string; customer: string; rating: number; body: string | null };
  const reviews: R[] = [
    { id: REVIEW.fiveStar, order: ORDER.paidReleased, product: PRODUCT.grilledChicken, customer: CUSTOMER.sandrine, rating: 5, body: 'Juicy and the pili-pili butter is perfect. Big portion.' },
    { id: REVIEW.twoStarReplied, order: ORDER.paidEscrow, product: PRODUCT.grilledChicken, customer: CUSTOMER.pacifique, rating: 2, body: 'Tasty but arrived cold.' },
    { id: REVIEW.fourStarReplied, order: ORDER.collected, product: PRODUCT.mangoJuice, customer: CUSTOMER.pacifique, rating: 4, body: 'Fresh, though I waited a while at the counter.' },
    { id: REVIEW.ratingOnly, order: ORDER.delivered, product: PRODUCT.veggieWrap, customer: CUSTOMER.sandrine, rating: 4, body: null },
    { id: REVIEW.oneStarReported, order: ORDER.lunchOffer, product: PRODUCT.chickenBurger, customer: CUSTOMER.jeanpaul, rating: 1, body: 'Worst place ever, call 078 000 22 to complain' },
    { id: REVIEW.inzu, order: ORDER.inzuRefunded, product: PRODUCT.linenTee, customer: CUSTOMER.alice, rating: 3, body: 'Lovely fabric, wrong size sent.' },
  ];

  for (const r of reviews) {
    const line = await ctx.sql<{ id: string; store_id: string }>(
      `SELECT i.id, i.store_id FROM order_items i
         JOIN product_variants v ON v.id = i.variant_id
        WHERE i.order_id = $1 AND v.product_id = $2
        LIMIT 1`,
      [r.order, r.product],
    );
    if (line.rows.length === 0) throw new Error(`no line for review ${r.id}`);
    await ctx.sql(
      `INSERT INTO reviews (id, store_id, order_id, order_item_id, customer_user_id, rating, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(days => $8))`,
      [r.id, line.rows[0]!.store_id, r.order, line.rows[0]!.id, r.customer, r.rating, r.body, reviews.indexOf(r) + 1],
    );
  }

  await ctx.sql(
    `SELECT reply_to_review($1, $2, 'Sorry about that — a rider was delayed. Message us for a free drink next time.')`,
    [REVIEW.twoStarReplied, STAFF.aline],
  );
  await ctx.sql(
    `SELECT reply_to_review($1, $2, 'Thank you! We have added a second till at lunchtime.')`,
    [REVIEW.fourStarReplied, STAFF.aline],
  );

  // Reported and upheld, so a hidden review exists — and the averages have to
  // ignore it, which is the thing worth having a fixture for.
  const report = await ctx.sql<{ id: string }>(
    `SELECT report_review($1, $2, 'personal_info', 'There is a phone number in the text.') AS id`,
    [REVIEW.oneStarReported, STAFF.aline],
  );
  await ctx.sql(
    `SELECT moderate_review($1, $2, 'uphold', 'Contains a phone number.')`,
    [report.rows[0]!.id, TEAM.grace],
  );
  // And one still open, so Vendlyfy's moderation queue is not empty.
  await ctx.sql(
    `SELECT report_review($1, $2, 'not_a_customer', 'We have no record of this person.')`,
    [REVIEW.inzu, STAFF.kevin],
  );

  const hidden = await ctx.sql<{ visible: string; hidden: string }>(
    `SELECT count(*) FILTER (WHERE hidden_at IS NULL)::text AS visible,
            count(*) FILTER (WHERE hidden_at IS NOT NULL)::text AS hidden FROM reviews`,
  );
  ctx.ok(
    `${hidden.rows[0]!.visible} visible reviews and ${hidden.rows[0]!.hidden} hidden by Vendlyfy, ` +
      '2 with a merchant reply, 1 report still open',
  );

  // ------------------------------------------------------------------
  ctx.step('Notifications');
  // ------------------------------------------------------------------
  const notified: [string, string, Record<string, unknown>, string | null, string | null, string | null][] = [
    ['order_placed', `order_placed:${ORDER.pending}`, { order_number: 1031, total_amount: '8500', customer_name: 'Aimable K.' }, ORDER.pending, null, null],
    ['order_picked_up', `picked:${ORDER.out}`, { order_number: 1026, rider_name: 'Claude Habineza' }, ORDER.out, null, null],
    ['order_delivered', `delivered:${ORDER.delivered}`, { order_number: 1024, customer_name: 'Sandrine K.' }, ORDER.delivered, null, null],
    ['order_declined', `declined:${ORDER.rejected}`, { order_number: 1022, actor_name: 'Patrick Mukama', reason: 'An item is out of stock' }, ORDER.rejected, null, null],
    ['complaint_filed', `complaint:${COMPLAINT.open}`, { order_number: 1023, reason: 'item_missing', customer_name: 'Pacifique I.' }, null, COMPLAINT.open, null],
    ['review_posted', `review:${REVIEW.twoStarReplied}`, { rating: 2, product_name: 'Grilled chicken' }, null, null, REVIEW.twoStarReplied],
  ];

  for (const [type, key, payload, order, complaint, review] of notified) {
    await ctx.sql(
      `SELECT notify($1, $2, $3, $4::jsonb, NULL, $5, $6, $7)`,
      [STORE.nyama, type, key, JSON.stringify(payload), order, complaint, review],
    );
  }
  // The two an owner sees and a manager must not.
  await ctx.sql(
    `SELECT notify($1, 'payout_sent', $2, $3::jsonb, NULL, NULL, NULL, NULL, $4)`,
    [STORE.nyama, `payout:${WITHDRAWAL.paid}`,
     JSON.stringify({ amount: '15000', destination: 'MTN MoMo 078 ••• 4412' }), WITHDRAWAL.paid],
  );
  await ctx.sql(
    `SELECT notify($1, 'identity_verified', $2, '{}'::jsonb)`,
    [STORE.nyama, `kyc:${STORE.nyama}`],
  );

  // One read by the owner, so the unread dot differs per person — which is the
  // property a single `is_read` column could not have expressed.
  const first = await ctx.sql<{ id: string }>(
    `SELECT id FROM notifications WHERE store_id = $1 ORDER BY created_at LIMIT 1`,
    [STORE.nyama],
  );
  await ctx.sql(`SELECT mark_notification_read($1, $2)`, [first.rows[0]!.id, STAFF.aline]);

  // A device with the chime off, which is the per-device preference V010 exists for.
  await ctx.sql(
    `SELECT set_device_sound('seed-device-alines-own-phone-01', $1, false)`,
    [STAFF.aline],
  );
  await ctx.sql(
    `SELECT set_device_sound('seed-device-counter-tablet-0001', $1, true)`,
    [STAFF.aline],
  );

  const unread = await ctx.sql<{ owner: string; manager: string }>(
    `SELECT unread_notification_count($1, $3)::text AS owner,
            unread_notification_count($2, $3)::text AS manager`,
    [STAFF.aline, STAFF.patrick, STORE.nyama],
  );
  ctx.ok(
    `8 notifications — ${unread.rows[0]!.owner} unread for the owner, ` +
      `${unread.rows[0]!.manager} for the manager, who cannot see the two about money`,
  );

  // ------------------------------------------------------------------
  ctx.step('Audit log');
  // ------------------------------------------------------------------
  // The KYC fixtures already wrote four entries by doing real things. These are the
  // ones no other fixture produces, taken from AdminAudit's own rows.
  await ctx.sql(
    `SELECT audit('config', 'publish_template', 'Published Fashion template v1 · new stores only',
                  $1, NULL, 'Changed: default attributes')`,
    [TEAM.grace],
  );
  await ctx.sql(
    `SELECT audit('store', 'suspend_store', 'Suspended store · counterfeit goods reported',
                  $1, $2, E'Open orders cancelled and refunded: 3\\nPayouts held')`,
    [TEAM.grace, STORE.deals4u],
  );
  await ctx.sql(
    `SELECT audit('money', 'approve_refund', 'Approved partial refund 2,500 of 15,500 RWF',
                  $1, $2, 'Deducted from Available in one step', 'refund', $3)`,
    [TEAM.diane, STORE.nyama, REFUND.partial],
  );
  await ctx.sql(
    `SELECT audit('money', 'retry_payout', 'Retried payout 41,000 RWF · failed again',
                  $1, $2, 'MoMo: account name mismatch', 'withdrawal', $3)`,
    [TEAM.diane, STORE.nyama, WITHDRAWAL.failed],
  );
  await ctx.sql(
    `SELECT audit('sensitive', 'view_as_merchant', 'Viewed as merchant for 6 min', $1, $2,
                  E'Support ticket #4412\\nRead-only session · owner notified by SMS',
                  NULL, NULL, '41.186.0.21', 'Mozilla/5.0', now() - interval '40 minutes',
                  '{"ticket": 4412}'::jsonb)`,
    [TEAM.grace, STORE.nyama],
  );
  await ctx.sql(
    `SELECT audit('access', 'invite_sent', 'Invite sent · role Support', $1, NULL,
                  E'Invited by Grace Kamanzi\\nMust set up 2-step before first sign-in')`,
    [TEAM.grace],
  );
  // An access event with nobody behind it, which the log has to be able to record.
  await ctx.sql(
    `SELECT audit('access', 'failed_sign_in', '3 failed sign-ins · grace@vendlyfy.example',
                  NULL, NULL, E'Sign-in paused for this account\\nIP 102.22.0.7',
                  NULL, NULL, '102.22.0.7', NULL, NULL, '{}'::jsonb, 'Unknown')`,
  );

  const chain = await ctx.sql<{ n: string; broken: string }>(
    `SELECT (SELECT count(*)::text FROM audit_log) AS n,
            (SELECT count(*)::text FROM verify_audit_chain()) AS broken`,
  );
  if (Number(chain.rows[0]!.broken) !== 0) {
    throw new Error(`the seeded audit log does not verify: ${chain.rows[0]!.broken} break(s)`);
  }
  ctx.ok(`${chain.rows[0]!.n} audit entries, and the chain verifies`);
}
