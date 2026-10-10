-- V033_message_outbox.sql
--
-- Milestone 28. Messages.dc.html designs eleven transactional messages — six to customers by email AND SMS, five to merchants and riders
-- by SMS — and Part 9 records the fact that blocks sending any of them: "No SMS provider exists … SMS is an unmade vendor decision."
--
-- THE OUTBOX IS WHAT LETS THE REST BE BUILT WITHOUT THAT DECISION. Every message the system wants to send is written here, in the same
-- shape whatever carries it: who it is for, what it says (already rendered, so the record IS the message), why it exists (an
-- idempotency key naming the event), and where it has got to. A transport — a real SMS gateway, SendGrid, or the development one that
-- prints — picks up `queued` rows and marks them. Until a provider is chosen the rows simply wait, visibly: Platform settings' Health
-- panel counts them, so "nothing is being sent" is a number somebody can see rather than a silence.
--
--   idempotency_key  UNIQUE. "order_event:<id>:customer:sms" can be enqueued by every sweep forever and exists once. This is what makes
--                    the sweeps (jobs/messaging.ts) safe to run on a timer, twice, or from two processes.
--   status           queued → sent | failed. `skipped` is for a message that was never going to be deliverable (an order with no phone
--                    number for an SMS) and is recorded rather than silently dropped, so "why did they not hear from us" has an answer.
--   body             the plain text (the whole message, for SMS). body_html is the email's, rendered in the store's colours.
--
-- RECIPIENTS ARE PERSONAL DATA (a phone number, an email address) and the body names a customer and an order. Rows are deleted by the
-- retention sweep once old; nothing here is an audit record (that is audit_log) — it is the delivery queue and its short memory.

CREATE TABLE message_outbox (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id        uuid        REFERENCES stores (id) ON DELETE CASCADE,
    order_id        uuid,

    channel         text        NOT NULL,
    template        text        NOT NULL,
    audience        text        NOT NULL,

    recipient       text        NOT NULL,
    sender          text        NOT NULL,
    subject         text,
    body            text        NOT NULL,
    body_html       text,

    idempotency_key text        NOT NULL,

    status          text        NOT NULL DEFAULT 'queued',
    attempts        integer     NOT NULL DEFAULT 0,
    last_error      text,
    provider        text,
    provider_ref    text,

    queued_at       timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT message_outbox_channel_values CHECK (channel IN ('sms', 'email')),
    CONSTRAINT message_outbox_audience_values CHECK (audience IN ('customer', 'merchant', 'rider')),
    CONSTRAINT message_outbox_status_values CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
    CONSTRAINT message_outbox_recipient_present CHECK (btrim(recipient) <> ''),
    CONSTRAINT message_outbox_body_present CHECK (btrim(body) <> ''),
    CONSTRAINT message_outbox_email_has_subject CHECK (channel <> 'email' OR btrim(COALESCE(subject, '')) <> ''),
    CONSTRAINT message_outbox_sent_is_stamped CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
    CONSTRAINT message_outbox_attempts_not_negative CHECK (attempts >= 0)
);

COMMENT ON TABLE message_outbox IS
    'Every SMS and email the system wants to send, rendered, with where it has got to. A transport picks up queued rows; with no provider chosen they wait, and the admin console counts them.';

CREATE UNIQUE INDEX message_outbox_idempotency_key ON message_outbox (idempotency_key);

-- Serves: the dispatcher — the oldest queued message per channel, and Platform settings' count of what is waiting.
CREATE INDEX message_outbox_queue_idx ON message_outbox (channel, queued_at) WHERE status = 'queued';

-- Serves: the retention sweep, and "what did we send this order" from the store's side.
CREATE INDEX message_outbox_order_idx ON message_outbox (order_id) WHERE order_id IS NOT NULL;

CREATE TRIGGER message_outbox_set_updated_at BEFORE UPDATE ON message_outbox
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Serves: the sweeps. They read "what happened to an order in the last two hours", and order_events had an index by order and none by time.
CREATE INDEX order_events_created_idx ON order_events (created_at);

-- Serves: the same sweeps, for the two messages that are not an order MOVING but an order being PLACED — "we got your order" and the
-- merchant's "new order". Placing an order writes no order_events row (history starts at its first transition), so the sweep reads orders
-- by when they were placed, across every store.
CREATE INDEX orders_placed_at_idx ON orders (placed_at);
