-- V036_manual_momo.sql
--
-- A third checkout payment method: MoMo paid by the customer dialing a USSD code themselves and sending
-- a screenshot as proof over WhatsApp, rather than through an automated provider (Urubuto Pay/MTN MoMo,
-- V035) or cash on delivery. No provider, no webhook — same bucket as cash in `payment_methods.kind`
-- ('offline' requires neither, per `payment_methods_online_has_provider`, V006).
--
-- WHY THIS IS NOT A REUSE OF CASH'S COLUMNS. Cash confirms AT DELIVERY — `mark_delivered()` (V022) calls
-- `confirm_cash_payment()` automatically the moment a rider hands the order off, because "delivered" and
-- "the money arrived" happen in the same conversation. Manual MoMo has no such moment: the customer sends
-- proof whenever they dial, which can be before the order is even accepted, and a human has to go look at
-- WhatsApp and decide. Reusing `cash_reported_amount`/`cash_confirmed_at` would force an unrelated
-- "confirmed at delivery" shape onto a flow that has none, so this is its own pair of columns and its own
-- confirm function, mirroring V005's `confirm_cash_payment()` in SHAPE (locked, idempotent, no ledger
-- entry — this money never reaches the platform wallet either) without sharing its semantics.

-- =============================================================================
-- 1. The method itself
-- =============================================================================

INSERT INTO payment_methods (key, name, short_name, kind, customer_label, customer_hint,
                             provider, webhook_url, status, position) VALUES
    ('momo_manual', 'MoMo (USSD + WhatsApp)', 'MOMO', 'offline',
     'MoMo (USSD + WhatsApp)', 'Dial a code, then send your payment proof on WhatsApp',
     NULL, NULL, 'live', 5);

-- No `payment_method_countries`/`payment_method_currencies` rows: 'offline' methods skip both the
-- country and currency agreement entirely (checkout.ts's `paymentOptions()`, and the trigger below).


-- =============================================================================
-- 2. Per-store configuration: which MoMo number to show, which WhatsApp number to send proof to
-- =============================================================================
--
-- NOT A CREDENTIAL in the sense V007's own comment on this table means (a provider API key): these are
-- plain phone numbers a merchant already hands out to customers, same category as `stores.public_phone`.
-- They live here, not on `stores`, because they are specific to ONE payment method and meaningless for
-- any other row in `store_payment_methods`.

ALTER TABLE store_payment_methods
    ADD COLUMN manual_momo_number    text,
    ADD COLUMN manual_momo_whatsapp  text;

ALTER TABLE store_payment_methods
    ADD CONSTRAINT spm_manual_momo_fields_are_manual_momo_only CHECK (
        payment_method_key = 'momo_manual'
     OR (manual_momo_number IS NULL AND manual_momo_whatsapp IS NULL)
    ),
    -- Connecting the method with no number to dial would show a blank USSD code, which the storefront
    -- cannot recover from — refuse the connection itself rather than discover it at checkout.
    ADD CONSTRAINT spm_manual_momo_connected_has_number CHECK (
        NOT (payment_method_key = 'momo_manual' AND is_connected)
     OR manual_momo_number IS NOT NULL
    );

COMMENT ON COLUMN store_payment_methods.manual_momo_number IS
    'The MoMo number customers dial the USSD code to, for the momo_manual method only. Required once connected.';
COMMENT ON COLUMN store_payment_methods.manual_momo_whatsapp IS
    'Where customers send payment proof, for the momo_manual method only. Falls back to manual_momo_number at the application layer when left blank — not defaulted here, so "the merchant never set one" stays a fact this column can still tell.';


-- =============================================================================
-- 3. The order side: confirming it happened
-- =============================================================================

ALTER TABLE orders
    ADD COLUMN momo_manual_confirmed_at  timestamptz,
    ADD COLUMN momo_manual_confirmed_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN momo_manual_note          text;

ALTER TABLE orders
    ADD CONSTRAINT orders_manual_momo_fields_are_manual_momo_only CHECK (
        payment_method = 'momo_manual'
     OR (momo_manual_confirmed_at IS NULL AND momo_manual_confirmed_by IS NULL AND momo_manual_note IS NULL)
    );

COMMENT ON COLUMN orders.momo_manual_confirmed_at IS
    'When staff matched a WhatsApp payment proof to this order and confirmed it. Unlike cash, there is no automatic trigger point — this is always a human decision, at any order status.';

-- `orders_paid_at_agrees` (V004) already requires `(payment_status = 'unpaid') = (paid_at IS NULL)` for
-- EVERY method, so confirm_manual_momo_payment() below satisfies it the same way confirm_cash_payment()
-- does, with no change needed to that constraint.

CREATE FUNCTION confirm_manual_momo_payment(
    p_order_id      uuid,
    p_confirmed_by  uuid,
    p_note          text DEFAULT NULL
) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    -- Idempotent: confirming twice finds nothing unconfirmed and returns false, same contract as
    -- confirm_cash_payment() — "already confirmed" is a fact to report, not an error to raise.
    UPDATE orders
       SET momo_manual_confirmed_at = now(),
           momo_manual_confirmed_by = p_confirmed_by,
           momo_manual_note = p_note,
           payment_status = 'paid',
           paid_at = COALESCE(paid_at, now())
     WHERE id = p_order_id
       AND payment_method = 'momo_manual'
       AND momo_manual_confirmed_at IS NULL;

    RETURN FOUND;
END;
$init$;

COMMENT ON FUNCTION confirm_manual_momo_payment IS
    'Records that staff matched a WhatsApp payment proof to this order and marks it paid. Writes no ledger entry — like cash, this money never reaches the platform''s wallet, the merchant already has it directly.';
