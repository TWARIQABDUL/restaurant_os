// server/src/repositories/merchantReviews.ts — milestone 24, from project/ReviewsMerchant.dc.html.
//
// "Reviews go live straight away. You can reply publicly, or report one to Vendlyfy if it breaks the rules. You can't
// edit or remove them." — the board's own sentence, and V009 makes it a property of the tables rather than a promise:
// `reviews` is insert-only for every role, the reply is a table of its own PRECISELY so the review need not be
// updatable, and only a Vendlyfy team member can hide one. So this file has two writes and both go through V009's
// functions, which it wraps in the one check they do not make: that the review is THIS STORE'S.
//
// `reply_to_review()` and `report_review()` take a review id and nothing else — they were written for callers that
// already knew whose review it was. An unchecked id here would let a manager at one store reply to, or report,
// another store's reviews, so every write reads `store_id` first and answers "not found" for a stranger's.
//
// HIDDEN REVIEWS ARE NOT LISTED. Upholding a report hides one (V009), and the board has no "hidden" state: a review
// Vendlyfy has removed from the store is not something the merchant needs to reply to.

import { badRequest, db, notFound } from '../db/index.ts';
import type { Queryable, Tx } from '../db/index.ts';

export type ReviewFilter = 'all' | 'reply' | 'low';

export type ReviewRow = {
  id: string;
  product: string;
  /** "Pacifique I." — first name and last initial, as the board shows. A customer's whole name is not a review's to print. */
  customer: string;
  orderNumber: number;
  at: Date;
  rating: number;
  body: string | null;
  reply: string | null;
  /** The open report, if there is one: the merchant is waiting on Vendlyfy. */
  reported: { reason: string } | null;
};

export type ReviewsOverview = {
  averageRating: string | null;
  last90Days: number;
  needsReply: number;
  lowThisMonth: number;
  lowLastMonth: number;
  reportedOpen: number;
};

export type ProductRating = { id: string; name: string; count: number; average: string | null };

/** The board: "Stores show an average only after 3 reviews. Until then customers see the count." */
export const MIN_REVIEWS_FOR_AVERAGE = 3;

export async function overview(storeId: string, on: Queryable = db): Promise<ReviewsOverview> {
  const { rows } = await on.query<{
    avg: string | null;
    n: string;
    needs: string;
    low_this: string;
    low_last: string;
    reported: string;
  }>(
    `WITH local AS (SELECT date_trunc('month', store_local($1, now())) AS month_start)
     SELECT round(avg(r.rating) FILTER (WHERE r.created_at > now() - interval '90 days'), 1)::text AS avg,
            (count(*) FILTER (WHERE r.created_at > now() - interval '90 days'))::text AS n,
            (count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM review_replies p WHERE p.review_id = r.id)))::text AS needs,
            (count(*) FILTER (WHERE r.rating <= 2 AND store_local($1, r.created_at) >= l.month_start))::text AS low_this,
            (count(*) FILTER (WHERE r.rating <= 2 AND store_local($1, r.created_at) >= l.month_start - interval '1 month'
                                                  AND store_local($1, r.created_at) <  l.month_start))::text AS low_last,
            (SELECT count(*) FROM review_reports x WHERE x.store_id = $1 AND x.status = 'open')::text AS reported
       FROM reviews r CROSS JOIN local l
      WHERE r.store_id = $1 AND r.hidden_at IS NULL
      GROUP BY l.month_start`,
    [storeId],
  );
  const r = rows[0];
  // A store with no reviews at all gets no group row — every figure is then honestly zero.
  if (r === undefined) {
    const reported = await on.query<{ n: string }>(`SELECT count(*)::text AS n FROM review_reports WHERE store_id = $1 AND status = 'open'`, [storeId]);
    return { averageRating: null, last90Days: 0, needsReply: 0, lowThisMonth: 0, lowLastMonth: 0, reportedOpen: Number(reported.rows[0]?.n ?? '0') };
  }
  return {
    averageRating: r.avg,
    last90Days: Number(r.n),
    needsReply: Number(r.needs),
    lowThisMonth: Number(r.low_this),
    lowLastMonth: Number(r.low_last),
    reportedOpen: Number(r.reported),
  };
}

type Raw = {
  id: string;
  product: string;
  name: string | null;
  order_number: number;
  created_at: Date;
  rating: number;
  body: string | null;
  reply: string | null;
  report_reason: string | null;
};

const PAGE = 20;

/** "Pacifique Irakoze" -> "Pacifique I."; one word stays one word; nothing becomes "A customer". */
export function shortName(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter((p) => p !== '');
  if (parts.length === 0) return 'A customer';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0)}.`;
}

export async function list(
  storeId: string,
  filter: ReviewFilter,
  cursor: { at: string; id: string } | null,
  on: Queryable = db,
): Promise<{ items: ReviewRow[]; nextCursor: { at: string; id: string } | null }> {
  const { rows } = await on.query<Raw>(
    `SELECT r.id, p.name AS product, u.name, o.order_number, r.created_at, r.rating, r.body,
            rr.body AS reply,
            (SELECT x.reason_code FROM review_reports x WHERE x.review_id = r.id AND x.status = 'open') AS report_reason
       FROM reviews r
       JOIN products p ON p.id = r.product_id
       JOIN orders o ON o.id = r.order_id AND o.store_id = r.store_id
       LEFT JOIN users u ON u.id = r.customer_user_id
       LEFT JOIN review_replies rr ON rr.review_id = r.id
      WHERE r.store_id = $1 AND r.hidden_at IS NULL
        AND ($2 = 'all' OR ($2 = 'reply' AND rr.review_id IS NULL) OR ($2 = 'low' AND r.rating <= 2))
        AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $5`,
    [storeId, filter, cursor?.at ?? null, cursor?.id ?? null, PAGE + 1],
  );
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      product: r.product,
      customer: shortName(r.name),
      orderNumber: r.order_number,
      at: r.created_at,
      rating: r.rating,
      body: r.body,
      reply: r.reply,
      reported: r.report_reason === null ? null : { reason: r.report_reason },
    })),
    nextCursor: rows.length > PAGE && last !== undefined ? { at: last.created_at.toISOString(), id: last.id } : null,
  };
}

export async function byProduct(storeId: string, on: Queryable = db): Promise<ProductRating[]> {
  const { rows } = await on.query<{ id: string; name: string; n: string; avg: string | null }>(
    `SELECT p.id, p.name, count(r.id)::text AS n, round(avg(r.rating), 1)::text AS avg
       FROM products p
       LEFT JOIN reviews r ON r.product_id = p.id AND r.hidden_at IS NULL
      WHERE p.store_id = $1 AND p.status = 'active'
      GROUP BY p.id, p.name
      ORDER BY count(r.id) DESC, p.name
      LIMIT 8`,
    [storeId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.n), average: Number(r.n) >= MIN_REVIEWS_FOR_AVERAGE ? r.avg : null }));
}

async function ownReview(storeId: string, reviewId: string, tx: Queryable): Promise<void> {
  const { rows } = await tx.query(`SELECT 1 FROM reviews WHERE id = $1 AND store_id = $2 AND hidden_at IS NULL`, [reviewId, storeId]);
  if (rows.length === 0) throw notFound('That review does not exist.', 'REVIEW_NOT_FOUND');
}

export async function reply(storeId: string, reviewId: string, userId: string, body: string, tx: Tx): Promise<void> {
  const text = body.trim();
  if (text === '') throw badRequest('Write a reply first.', 'REPLY_REQUIRED');
  if (text.length > 1000) throw badRequest('Keep the reply under 1,000 characters.', 'TOO_LONG');
  await ownReview(storeId, reviewId, tx);
  await tx.query(`SELECT reply_to_review($1, $2, $3)`, [reviewId, userId, text]);
}

export const REPORT_REASONS = ['abusive', 'personal_info', 'not_a_customer', 'spam'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export async function report(storeId: string, reviewId: string, userId: string, reason: ReportReason, tx: Tx): Promise<void> {
  await ownReview(storeId, reviewId, tx);
  await tx.query(`SELECT report_review($1, $2, $3)`, [reviewId, userId, reason]);
}
