-- V009_reviews_and_replies.sql
--
-- Milestone 9, fourth part. Product reviews, the merchant's public reply, and the
-- one route by which a review can be taken down.
--
-- ReviewsMerchant.dc.html states the rule the whole design hangs on, in its own
-- subheading: "Reviews go live straight away. You can reply publicly, or report one
-- to Vendlyfy if it breaks the rules. YOU CAN'T EDIT OR REMOVE THEM." And
-- ReviewsCustomer repeats it to the customer: "Nyama & Co. can reply but can't edit
-- or delete it."
--
-- A schema where that is a promise made by an endpoint is a schema where it is
-- false the first time somebody writes a new endpoint. So:
--
--   * `reviews` is INSERT-ONLY for everyone. The merchant's reply is a different
--     table, which is why it can exist at all — if the reply were a column, the
--     table would have to be updatable and the promise would go with it.
--   * the only mutable thing on a review is the platform's moderation decision,
--     and it moves through one function.
--
-- Three more things the boards settle:
--
--   1. REVIEWS ARE PER PRODUCT, not per store. "By product" lists an average each,
--      the product page shows that product's reviews, and the merchant list reads
--      "Grilled chicken · Pacifique I. · #1027".
--
--   2. "ORDERED HERE" IS STRUCTURAL. Every review on both boards carries the badge,
--      and the sign-in sheet explains why: "Reviews come from customers with an
--      account, so we can show that they really ordered." A review therefore names
--      the ORDER LINE it is about, by composite key — so a review of something the
--      person never bought cannot be written, rather than being filtered out later.
--
--   3. THE AVERAGE IS HIDDEN BELOW THREE REVIEWS. "We show an average once there are
--      3 reviews, so one opinion doesn't decide it." That is a display rule two
--      different screens obey, so it lives in one view and neither of them repeats
--      it.


-- =============================================================================
-- 1. reviews
-- =============================================================================

CREATE TABLE reviews (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id         uuid        NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    -- What is being reviewed. Derived from the order line below and pinned to it by
    -- a trigger; it is here because every read is by product.
    product_id       uuid        NOT NULL,

    -- The purchase. order_item_id is the grain: one review per line bought, so
    -- somebody who orders the same thing next month may say so again, and somebody
    -- who never ordered it has nothing to hang a review on.
    order_id         uuid        NOT NULL,
    order_item_id    uuid        NOT NULL,

    -- "Reviews come from customers with an account" — so unlike a complaint, this
    -- is not open to a guest. Shown as their first name.
    customer_user_id uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

    rating           smallint    NOT NULL,

    -- "What did you like, or not? (optional)" — a rating alone is a review, and the
    -- product page has copy for it: "(No comment, just a rating.)".
    body             text,

    -- Moderation, and the ONLY part of a review that can change. Vendlyfy's, never
    -- the merchant's: hidden_by references platform_members.
    hidden_at        timestamptz,
    hidden_by        uuid        REFERENCES platform_members (user_id) ON DELETE RESTRICT,
    hidden_reason    text,

    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reviews_rating_range CHECK (rating BETWEEN 1 AND 5),

    -- An empty string is not "no comment"; it is a blank a form sent. Store one or
    -- the other, so a reader never has to know the difference.
    CONSTRAINT reviews_body_not_blank CHECK (body IS NULL OR btrim(body) <> ''),

    -- Hiding something is a decision with a decider and a reason, all three or none.
    CONSTRAINT reviews_hidden_complete
        CHECK ((hidden_at IS NULL) = (hidden_by IS NULL)
               AND (hidden_at IS NULL) = (hidden_reason IS NULL)),

    -- ONE REVIEW PER LINE BOUGHT.
    CONSTRAINT reviews_order_item_key UNIQUE (order_item_id),

    -- Referenced by review_replies and review_reports, so their store cannot drift.
    CONSTRAINT reviews_id_store_key UNIQUE (id, store_id),

    FOREIGN KEY (order_id, store_id) REFERENCES orders (id, store_id) ON DELETE RESTRICT,
    FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id) ON DELETE RESTRICT,

    -- The badge, as a key. order_items carries UNIQUE (id, order_id) for exactly
    -- this kind of use.
    FOREIGN KEY (order_item_id, order_id) REFERENCES order_items (id, order_id) ON DELETE RESTRICT
);

COMMENT ON TABLE reviews IS
    'A customer''s rating of a product they bought, tied to the order line that proves it. Insert-only: a merchant can reply but cannot edit or remove a review, and only Vendlyfy can hide one.';
COMMENT ON COLUMN reviews.product_id IS
    'Derived from the order line''s variant and pinned to it by a trigger. It exists because every read of this table is by product.';
COMMENT ON COLUMN reviews.hidden_at IS
    'Set only by moderate_review(), only by a Vendlyfy team member, and only after a report. A hidden review leaves the averages and the product page; it is not deleted.';

-- Serves: the product page, newest first, visible only.
CREATE INDEX reviews_product_idx ON reviews (product_id, created_at DESC) WHERE hidden_at IS NULL;

-- Serves: the merchant's list across the whole store, and its "1-2 stars" and
-- "last 90 days" filters, which both read this in created_at order.
CREATE INDEX reviews_store_idx ON reviews (store_id, created_at DESC);

-- Serves: the order screen, and "this customer's reviews" on Customers.
CREATE INDEX reviews_order_idx ON reviews (order_id);
CREATE INDEX reviews_customer_idx ON reviews (customer_user_id, created_at DESC);


-- The two things about a review that must be true of the purchase behind it: the
-- product is the one on the line, and the customer is the one who placed the order.
-- Both are cross-row facts, so neither can be a CHECK.
CREATE FUNCTION reviews_verify_purchase() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_product  uuid;
    v_customer uuid;
    v_status   text;
BEGIN
    SELECT v.product_id INTO v_product
      FROM order_items i JOIN product_variants v ON v.id = i.variant_id
     WHERE i.id = NEW.order_item_id AND i.order_id = NEW.order_id;

    IF NOT FOUND THEN
        -- The composite key to order_items owns this too, but product_id is derived
        -- below and would be left NULL — so the failure would surface as a NOT NULL
        -- on a column the caller never sets. Say the true thing instead.
        RAISE EXCEPTION 'order line % is not on order %', NEW.order_item_id, NEW.order_id
            USING HINT = 'A review names the line it is about, and the line must belong to the order.';
    END IF;

    -- product_id is derived, never passed in: the caller leaves it NULL and this
    -- runs before the NOT NULL is checked.
    NEW.product_id := v_product;

    SELECT customer_user_id, status INTO v_customer, v_status
      FROM orders WHERE id = NEW.order_id;

    IF v_customer IS DISTINCT FROM NEW.customer_user_id THEN
        RAISE EXCEPTION 'user % did not place order %', NEW.customer_user_id, NEW.order_id
            USING HINT = 'A review belongs to the customer on the order. Guest orders cannot be reviewed — reviewing needs an account.';
    END IF;

    -- "Ordered here" means it arrived. Reviewing something still being cooked is
    -- reviewing nothing, and the two terminal states a customer reaches are
    -- delivered and collected.
    IF v_status NOT IN ('delivered', 'collected') THEN
        RAISE EXCEPTION 'order % is % — there is nothing to review yet', NEW.order_id, v_status
            USING HINT = 'A review needs a delivered or collected order behind it.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER reviews_verify_purchase BEFORE INSERT ON reviews
    FOR EACH ROW EXECUTE FUNCTION reviews_verify_purchase();


-- Insert-only, except for the moderation columns. Spelled out as one trigger so
-- that "the merchant cannot edit or remove a review" is a property of the table
-- rather than of whichever code path is asked to.
CREATE FUNCTION reviews_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a review cannot be deleted (review %)', OLD.id
            USING HINT = 'Reviews go live straight away and stay. Vendlyfy can hide one after a report; nobody can remove it.';
    END IF;

    IF NEW.store_id      IS DISTINCT FROM OLD.store_id
    OR NEW.product_id    IS DISTINCT FROM OLD.product_id
    OR NEW.order_id      IS DISTINCT FROM OLD.order_id
    OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
    OR NEW.customer_user_id IS DISTINCT FROM OLD.customer_user_id
    OR NEW.rating        IS DISTINCT FROM OLD.rating
    OR NEW.body          IS DISTINCT FROM OLD.body
    OR NEW.created_at    IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'a review cannot be edited (review %)', OLD.id
            USING HINT = 'What the customer wrote is theirs. Reply to it, or report it to Vendlyfy.';
    END IF;

    -- And a hiding cannot be undone by a second write that leaves no trace; it is
    -- lifted through moderate_review(), which records the lifting.
    RETURN NEW;
END;
$init$;

CREATE TRIGGER reviews_immutable BEFORE UPDATE OR DELETE ON reviews
    FOR EACH ROW EXECUTE FUNCTION reviews_immutable();


-- =============================================================================
-- 2. review_replies
-- =============================================================================
-- "Post reply" becomes "Edit reply" once there is one, so a reply is editable
-- where a review is not — and there is exactly one per review.

CREATE TABLE review_replies (
    review_id  uuid        PRIMARY KEY,
    store_id   uuid        NOT NULL,

    body       text        NOT NULL,

    -- Whoever wrote it must be staff OF THIS STORE. store_id is on the row and NOT
    -- NULL, so the composite key needs no companion column.
    author_id  uuid,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT review_replies_body_not_blank CHECK (btrim(body) <> ''),

    FOREIGN KEY (review_id, store_id) REFERENCES reviews (id, store_id) ON DELETE CASCADE,
    FOREIGN KEY (author_id, store_id) REFERENCES store_members (user_id, store_id)
        ON DELETE SET NULL (author_id)
);

COMMENT ON TABLE review_replies IS
    'The merchant''s public reply, shown under the review. One per review, editable — which is why it is a table of its own rather than a column on an insert-only one.';

CREATE TRIGGER review_replies_set_updated_at BEFORE UPDATE ON review_replies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- 3. review_reports
-- =============================================================================
-- "Report a review to Vendlyfy if it breaks the rules", with the board's own four
-- reasons, and the consequence stated on the card: "Vendlyfy will review it. IT
-- STAYS VISIBLE UNTIL THEY DECIDE."

CREATE TABLE review_reports (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id   uuid        NOT NULL,
    store_id    uuid        NOT NULL,

    -- The four the board offers, as codes. The words are the designer's.
    reason_code text        NOT NULL,
    note        text,

    reported_by uuid        REFERENCES users (id) ON DELETE SET NULL,

    status      text        NOT NULL DEFAULT 'open',

    -- Vendlyfy's decision. Upheld hides the review; dismissed leaves it.
    decided_by  uuid        REFERENCES platform_members (user_id) ON DELETE RESTRICT,
    decided_at  timestamptz,
    decision_note text,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT review_reports_reason_values CHECK (reason_code IN (
        'abusive', 'personal_info', 'not_a_customer', 'spam')),
    CONSTRAINT review_reports_status_values
        CHECK (status IN ('open', 'upheld', 'dismissed')),

    -- Open means undecided, and decided means all of it: who, when, and why.
    CONSTRAINT review_reports_decision_agrees
        CHECK ((status = 'open') = (decided_at IS NULL)),
    CONSTRAINT review_reports_decision_complete
        CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
    CONSTRAINT review_reports_decision_has_reason
        CHECK (decided_at IS NULL OR btrim(COALESCE(decision_note, '')) <> ''),

    FOREIGN KEY (review_id, store_id) REFERENCES reviews (id, store_id) ON DELETE RESTRICT
);

COMMENT ON TABLE review_reports IS
    'A report against a review, decided by Vendlyfy. Upholding one hides the review; dismissing leaves it visible, which is what it was throughout.';

-- ONE REPORT AT A TIME PER REVIEW. The merchant cannot queue the same complaint
-- twice, and Vendlyfy is not asked the same question twice at once. Once decided, a
-- new report with new information is allowed.
CREATE UNIQUE INDEX review_reports_one_open_per_review
    ON review_reports (review_id) WHERE status = 'open';

-- Serves: Vendlyfy's queue, oldest first, and the merchant's "Reported, under
-- review" count.
CREATE INDEX review_reports_open_idx ON review_reports (created_at) WHERE status = 'open';
CREATE INDEX review_reports_store_idx ON review_reports (store_id, created_at DESC);

CREATE TRIGGER review_reports_set_updated_at BEFORE UPDATE ON review_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- A review is hidden if and only if a report against it was upheld. Deferred,
-- because moderate_review writes both rows in one transaction and neither is valid
-- without the other.
CREATE FUNCTION reviews_hidden_needs_upheld_report() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_review uuid;
    v_hidden boolean;
BEGIN
    IF TG_TABLE_NAME = 'reviews' THEN
        v_review := NEW.id;
    ELSE
        v_review := NEW.review_id;
    END IF;

    SELECT hidden_at IS NOT NULL INTO v_hidden FROM reviews WHERE id = v_review;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_hidden AND NOT EXISTS (
        SELECT 1 FROM review_reports WHERE review_id = v_review AND status = 'upheld'
    ) THEN
        RAISE EXCEPTION 'review % is hidden with no upheld report behind it', v_review
            USING HINT = 'A review is taken down by a decision on a report, through moderate_review().';
    END IF;

    IF NOT v_hidden AND EXISTS (
        SELECT 1 FROM review_reports WHERE review_id = v_review AND status = 'upheld'
    ) THEN
        RAISE EXCEPTION 'review % has an upheld report against it but is still visible', v_review
            USING HINT = 'Upholding a report hides the review. Dismiss it instead to leave the review up.';
    END IF;

    RETURN NULL;
END;
$init$;

CREATE CONSTRAINT TRIGGER reviews_hidden_agrees
    AFTER INSERT OR UPDATE OF hidden_at ON reviews
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION reviews_hidden_needs_upheld_report();

CREATE CONSTRAINT TRIGGER review_reports_hidden_agrees
    AFTER INSERT OR UPDATE OF status ON review_reports
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION reviews_hidden_needs_upheld_report();


-- =============================================================================
-- 4. The display rule, in one place
-- =============================================================================
-- "Stores show an average only after 3 reviews. Until then customers see the
-- count." Both the product page and the merchant's "By product" panel obey it, and
-- a rule two screens implement separately is a rule they will eventually disagree
-- about. The threshold is here, once.
--
-- average_rating is NULL below the threshold — not zero, and not the real average
-- rounded off. NULL is what "we are not showing one" looks like in a column, and a
-- caller cannot accidentally render it as a number.

CREATE VIEW product_rating_summary AS
SELECT p.id                                              AS product_id,
       p.store_id,
       count(r.id)                                       AS review_count,
       CASE WHEN count(r.id) >= 3
            THEN round(avg(r.rating)::numeric, 1) END    AS average_rating,
       count(r.id) FILTER (WHERE r.rating = 5)           AS five_star,
       count(r.id) FILTER (WHERE r.rating = 4)           AS four_star,
       count(r.id) FILTER (WHERE r.rating = 3)           AS three_star,
       count(r.id) FILTER (WHERE r.rating = 2)           AS two_star,
       count(r.id) FILTER (WHERE r.rating = 1)           AS one_star,
       count(r.id) FILTER (WHERE r.rating <= 2)          AS low_rated,
       max(r.created_at)                                 AS latest_review_at
  FROM products p
  LEFT JOIN reviews r ON r.product_id = p.id AND r.hidden_at IS NULL
 GROUP BY p.id, p.store_id;

COMMENT ON VIEW product_rating_summary IS
    'Ratings per product, with the design''s own rule applied: average_rating is NULL until there are three reviews, and hidden reviews count for nothing. Every product appears, including those with none.';


-- =============================================================================
-- 5. The functions
-- =============================================================================

CREATE FUNCTION post_review(
    p_order_item_id uuid,
    p_customer_id   uuid,
    p_rating        integer,
    p_body          text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store uuid;
    v_order uuid;
    v_id    uuid;
BEGIN
    SELECT store_id, order_id INTO v_store, v_order
      FROM order_items WHERE id = p_order_item_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'order line % does not exist', p_order_item_id;
    END IF;

    -- Reviewing twice is reviewing once, and the second caller is handed the first
    -- review rather than an error: a double-tapped Post is not a mistake worth
    -- showing anybody.
    INSERT INTO reviews (store_id, product_id, order_id, order_item_id,
                         customer_user_id, rating, body)
         -- product_id is left to the trigger, which fills it from the line's
         -- variant before the NOT NULL is checked.
         VALUES (v_store, NULL, v_order,
                 p_order_item_id, p_customer_id, p_rating,
                 NULLIF(btrim(COALESCE(p_body, '')), ''))
    ON CONFLICT (order_item_id) DO NOTHING
      RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT id INTO v_id FROM reviews WHERE order_item_id = p_order_item_id;
    END IF;

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION post_review IS
    'Posts a review of a line the customer bought, or returns the one already there. Live immediately: there is no moderation queue, by design.';


CREATE FUNCTION reply_to_review(
    p_review_id uuid,
    p_author_id uuid,
    p_body      text
) RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store uuid;
BEGIN
    IF btrim(COALESCE(p_body, '')) = '' THEN
        RAISE EXCEPTION 'an empty reply says nothing; delete it instead';
    END IF;

    SELECT store_id INTO v_store FROM reviews WHERE id = p_review_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'review % does not exist', p_review_id;
    END IF;

    -- "Post reply" and "Edit reply" are the same button in two states, so they are
    -- the same call. The composite key on (author_id, store_id) is what refuses a
    -- reply written by somebody else's staff.
    INSERT INTO review_replies (review_id, store_id, body, author_id)
         VALUES (p_review_id, v_store, btrim(p_body), p_author_id)
    ON CONFLICT (review_id) DO UPDATE
       SET body = excluded.body, author_id = excluded.author_id;
END;
$init$;


CREATE FUNCTION report_review(
    p_review_id   uuid,
    p_reported_by uuid,
    p_reason_code text,
    p_note        text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_store uuid;
    v_id    uuid;
BEGIN
    SELECT store_id INTO v_store FROM reviews WHERE id = p_review_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'review % does not exist', p_review_id;
    END IF;

    INSERT INTO review_reports (review_id, store_id, reason_code, note, reported_by)
         VALUES (p_review_id, v_store, p_reason_code,
                 NULLIF(btrim(COALESCE(p_note, '')), ''), p_reported_by)
    ON CONFLICT (review_id) WHERE status = 'open' DO NOTHING
      RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT id INTO v_id FROM review_reports
         WHERE review_id = p_review_id AND status = 'open';
    END IF;

    RETURN v_id;
END;
$init$;

COMMENT ON FUNCTION report_review IS
    'Reports a review to Vendlyfy, or returns the report already open against it. The review stays visible throughout.';


CREATE FUNCTION moderate_review(
    p_report_id uuid,
    p_decided_by uuid,
    p_outcome   text,
    p_note      text
) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_review uuid;
    v_reason text;
BEGIN
    IF p_outcome NOT IN ('uphold', 'dismiss') THEN
        RAISE EXCEPTION 'a report is upheld or dismissed, not %', p_outcome;
    END IF;

    IF btrim(COALESCE(p_note, '')) = '' THEN
        RAISE EXCEPTION 'a moderation decision needs a reason on the record';
    END IF;

    -- The single-shot claim. Two reviewers deciding one report: one wins, and the
    -- review is not hidden twice or hidden and then un-hidden.
    UPDATE review_reports
       SET status = CASE p_outcome WHEN 'uphold' THEN 'upheld' ELSE 'dismissed' END,
           decided_by = p_decided_by, decided_at = now(), decision_note = btrim(p_note)
     WHERE id = p_report_id AND status = 'open'
     RETURNING review_id, reason_code INTO v_review, v_reason;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF p_outcome = 'uphold' THEN
        UPDATE reviews
           SET hidden_at = now(), hidden_by = p_decided_by,
               hidden_reason = v_reason || ': ' || btrim(p_note)
         WHERE id = v_review AND hidden_at IS NULL;
    END IF;

    RETURN true;
END;
$init$;

COMMENT ON FUNCTION moderate_review IS
    'Vendlyfy decides a report. Upholding hides the review and records why; dismissing leaves it up. Returns false if it was already decided.';


-- =============================================================================
-- Recorded rather than invented
-- =============================================================================
-- 1. THE DISPLAY NAME. The customer sheet says "Shown with your first name" and the
--    merchant list shows "Anonymous123" for somebody whose account is named that.
--    So the name is not stored on the review: it is users.name, cut at the first
--    space when shown to the public. A copy on the review would be a second name
--    that stops following a correction.
--
-- 2. THE KPIs on ReviewsMerchant — average over 90 days, how many need a reply,
--    1-2 star this month, reported and under review — are all derived from this
--    table, product_rating_summary, review_replies and review_reports. None is a
--    stored counter, because a stored counter is a second truth.
--
-- 3. NO REVIEW OF A GUEST ORDER. The sheet is explicit that reviewing needs an
--    account, and customer_user_id is NOT NULL, so a guest checkout produces an
--    order nobody can review. Whether the guest should be offered an account at
--    that point is a product decision for the storefront work, not a column.
