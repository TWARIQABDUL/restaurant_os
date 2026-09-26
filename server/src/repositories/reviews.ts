// server/src/repositories/reviews.ts — milestone 16.
//
// `ReviewsCustomer` is the product page, and reviews are most of it: a summary with a star
// distribution, the list, the merchant's replies, and the sheet that writes one.
//
// THE THREE-REVIEW RULE IS NOT IMPLEMENTED HERE. V009 put it in `product_rating_summary` and said why:
// "We show an average once there are 3 reviews, so one opinion doesn't decide it" is a display rule
// two different screens obey, "and a rule two screens implement separately is a rule they will
// eventually disagree about". `average_rating` is NULL below the threshold, which a caller cannot
// accidentally render as a number. This repository reads the view.
//
// NEITHER IS "ORDERED HERE". V009 makes it structural: a review names the ORDER LINE it is about by
// composite key, so a review of something the person never bought cannot be written rather than being
// filtered out afterwards. Which means posting one needs a line to hang it on — findReviewTarget() is
// that lookup, and it is the only thing standing between the board's "Write a review" button and an
// exception from a trigger.

import { db } from '../db/index.ts';
import type { Queryable } from '../db/index.ts';

const MAX_PAGE = 50;

/** The star distribution, and the average only when the design says it may be shown. */
export type RatingSummary = {
  reviewCount: number;
  /** NULL below three reviews — "too few for a rating". Not zero, and not the real average rounded. */
  averageRating: string | null;
  counts: { 1: number; 2: number; 3: number; 4: number; 5: number };
};

export type ReviewItem = {
  id: string;
  rating: number;
  /** Null when the customer left only a rating: the board renders "(No comment, just a rating.)". */
  body: string | null;
  /** First name only — "Shown with your first name". */
  authorFirstName: string;
  createdAt: Date;
  reply: { body: string; createdAt: Date } | null;
};

export type ReviewCursor = { createdAt: string; id: string };

export type ReviewPage = { items: ReviewItem[]; nextCursor: ReviewCursor | null };

/**
 * The line a review of this product would attach to, and the review already on it.
 *
 * THREE STATES, NOT TWO, and the third one is why this type carries `existingReview` rather than the
 * lookup simply skipping reviewed lines:
 *
 *   a line with no review   they can write one
 *   a line with a review    they already did — hand it back rather than pretending they cannot
 *   no line at all          nothing of theirs has arrived yet
 *
 * The middle case is the retry: the POST succeeded, the response was lost on a bad connection, and the
 * client sent it again. Filtering reviewed lines out of this query — which is what it did first — turns
 * that retry into "you can review this once an order with it has arrived", said to somebody whose
 * review is already live. V009 built post_review() to be idempotent on the line precisely so that "a
 * double-tapped Post is not a mistake worth showing anybody"; a caller that cannot reach it defeats
 * that.
 */
export type ReviewTarget = {
  orderItemId: string;
  orderId: string;
  orderCode: string;
  productName: string;
  /** The review already on this line, if there is one. */
  existingReview: { id: string; rating: number; body: string | null } | null;
};

const EMPTY_COUNTS = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as const;

type SummaryRow = {
  product_id: string;
  review_count: string;
  average_rating: string | null;
  one_star: string;
  two_star: string;
  three_star: string;
  four_star: string;
  five_star: string;
};

function toSummary(row: SummaryRow): RatingSummary {
  return {
    reviewCount: Number(row.review_count),
    averageRating: row.average_rating,
    counts: {
      1: Number(row.one_star),
      2: Number(row.two_star),
      3: Number(row.three_star),
      4: Number(row.four_star),
      5: Number(row.five_star),
    },
  };
}

/**
 * Rating summaries for a page of products, in one query.
 *
 * ONE QUERY FOR THE WHOLE PAGE rather than one per card: twenty-four products on a grid would be
 * twenty-four round trips, and the grid cannot paint until the last of them lands. Products with no
 * reviews are present in the answer with zeroes, because the view includes every product — so a caller
 * can index straight into the map without handling a miss.
 */
export async function summariesFor(
  productIds: readonly string[],
  on: Queryable = db,
): Promise<Map<string, RatingSummary>> {
  const out = new Map<string, RatingSummary>();
  if (productIds.length === 0) return out;

  const { rows } = await on.query<SummaryRow>(
    `SELECT product_id, review_count::text, average_rating::text,
            one_star::text, two_star::text, three_star::text, four_star::text, five_star::text
       FROM product_rating_summary
      WHERE product_id = ANY ($1::uuid[])`,
    [productIds],
  );
  for (const row of rows) out.set(row.product_id, toSummary(row));

  // A product the view did not return cannot happen — it is a LEFT JOIN over `products` — but a
  // caller indexing into this map should not have to know that.
  for (const id of productIds) {
    if (!out.has(id)) out.set(id, { reviewCount: 0, averageRating: null, counts: { ...EMPTY_COUNTS } });
  }
  return out;
}

export async function summaryFor(productId: string, on: Queryable = db): Promise<RatingSummary> {
  const found = await summariesFor([productId], on);
  return found.get(productId) ?? { reviewCount: 0, averageRating: null, counts: { ...EMPTY_COUNTS } };
}

/**
 * One page of a product's reviews, newest first, by keyset.
 *
 * HIDDEN REVIEWS ARE ABSENT, matching the partial index and the view: V009 hides after an upheld
 * report and counts them for nothing.
 *
 * THE FIRST NAME IS TAKEN HERE, NOT IN A COMPONENT. "Shown with your first name" is a promise about
 * what is published, and a component that sliced the full name would be one refactor away from
 * publishing the surname. split_part on the first space is what the boards draw — "Jean-Paul" keeps
 * its hyphen and "Pacifique I." keeps nothing after the space.
 */
export async function listForProduct(
  productId: string,
  options: { limit?: number; after?: ReviewCursor | null } = {},
  on: Queryable = db,
): Promise<ReviewPage> {
  const limit = Math.min(Math.max(1, options.limit ?? 10), MAX_PAGE);
  const after = options.after ?? null;

  const { rows } = await on.query<{
    id: string;
    rating: number;
    body: string | null;
    first_name: string;
    created_at: Date;
    reply_body: string | null;
    reply_created_at: Date | null;
  }>(
    `SELECT r.id, r.rating, r.body,
            split_part(btrim(u.name), ' ', 1) AS first_name,
            r.created_at,
            p.body       AS reply_body,
            p.created_at AS reply_created_at
       FROM reviews r
       JOIN users u ON u.id = r.customer_user_id
       LEFT JOIN review_replies p ON p.review_id = r.id
      WHERE r.product_id = $1
        AND r.hidden_at IS NULL
        AND ($2::timestamptz IS NULL
             OR ($3::uuid IS NULL AND r.created_at < $2::timestamptz)
             OR ($3::uuid IS NOT NULL AND (r.created_at, r.id) < ($2::timestamptz, $3::uuid)))
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $4`,
    [productId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
  );

  const items: ReviewItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    rating: r.rating,
    body: r.body,
    authorFirstName: r.first_name,
    createdAt: r.created_at,
    reply:
      r.reply_body === null || r.reply_created_at === null
        ? null
        : { body: r.reply_body, createdAt: r.reply_created_at },
  }));

  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? { createdAt: last.createdAt.toISOString(), id: last.id }
      : null;

  return { items, nextCursor };
}

/**
 * A line of this product that this customer bought and that has arrived.
 *
 * WHY THE SERVER PICKS THE LINE. The board's sheet asks for a rating and a sentence, and nothing else —
 * it never asks "which of your orders is this about?", because a shopper does not think of it that way.
 * But V009's grain is the order line: "one review per line bought, so somebody who orders the same thing
 * next month may say so again". So the server resolves the one from the other.
 *
 * AN UNREVIEWED LINE WINS, and among those the most recent — the order they are most likely to have in
 * mind. Only when every line already carries a review does it return a reviewed one, which is what makes
 * the retry case answerable. That ordering is the whole logic of this query.
 *
 * NULL IS AN ANSWER, NOT AN ERROR. It means "you have nothing of this to review", which the sheet
 * renders as its own sentence rather than as a failure.
 */
export async function findReviewTarget(
  storeId: string,
  customerUserId: string,
  productId: string,
  on: Queryable = db,
): Promise<ReviewTarget | null> {
  const { rows } = await on.query<{
    order_item_id: string;
    order_id: string;
    tracking_code: string;
    product_name: string;
    review_id: string | null;
    review_rating: number | null;
    review_body: string | null;
  }>(
    `SELECT i.id AS order_item_id, o.id AS order_id, o.tracking_code, p.name AS product_name,
            r.id AS review_id, r.rating AS review_rating, r.body AS review_body
       FROM order_items i
       JOIN orders o ON o.id = i.order_id
       JOIN product_variants v ON v.id = i.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN reviews r ON r.order_item_id = i.id
      WHERE o.store_id = $1
        AND o.customer_user_id = $2
        AND v.product_id = $3
        -- "Ordered here" means it arrived. The two terminal states a customer reaches, as V009's
        -- purchase trigger spells out, are delivered and collected.
        AND o.status IN ('delivered', 'collected')
      -- Unreviewed first, then newest. See the note on ReviewTarget for why a reviewed line is still
      -- returned rather than filtered away.
      ORDER BY (r.id IS NOT NULL), o.created_at DESC, i.id DESC
      LIMIT 1`,
    [storeId, customerUserId, productId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    orderItemId: row.order_item_id,
    orderId: row.order_id,
    orderCode: row.tracking_code,
    productName: row.product_name,
    existingReview:
      row.review_id === null || row.review_rating === null
        ? null
        : { id: row.review_id, rating: row.review_rating, body: row.review_body },
  };
}

/**
 * Post a review of a line, or hand back the one already there.
 *
 * IDEMPOTENT BY THE LINE, and it is post_review() that makes it so rather than this: "Reviewing twice
 * is reviewing once, and the second caller is handed the first review rather than an error — a
 * double-tapped Post is not a mistake worth showing anybody." That is exactly the double-submit case,
 * settled in the database where two concurrent requests both meet the unique index.
 */
export async function post(
  orderItemId: string,
  customerUserId: string,
  rating: number,
  body: string | null,
  on: Queryable = db,
): Promise<string> {
  const { rows } = await on.query<{ id: string }>(
    `SELECT post_review($1, $2, $3, $4) AS id`,
    [orderItemId, customerUserId, rating, body],
  );
  const id = rows[0]?.id;
  if (id === undefined || id === null) {
    // post_review() returns the existing review when the insert conflicts, so a null here means the
    // function's own contract was broken rather than that the caller did anything wrong.
    throw new Error(`post_review returned no id for order line ${orderItemId}`);
  }
  return id;
}
