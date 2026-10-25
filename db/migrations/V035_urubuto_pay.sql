-- V035_urubuto_pay.sql
--
-- Payment provider decided 2026-10-25: Urubuto Pay replaces MTN MoMo for collections (checkout). Disbursements
-- (merchant payouts) stay on MTN MoMo for now — Urubuto Pay supports them, but that integration is not built;
-- see jobs/settlement.ts and repositories/payouts.ts for the DISBURSEMENT_PROVIDER switch that makes turning it
-- on later a config change, not a deploy.
--
-- WHAT DID NOT CHANGE: `payment_methods.key = 'mtn_momo'` stays the customer-facing label. A shopper still pays
-- with "MTN Mobile Money" — Urubuto Pay's MOMO channel settles through the same network underneath. What moved
-- is the BACKEND integration (which API this server calls), which is why this migration adds a `gateway`
-- column rather than touching the ~15 places `mtn_momo` already appears in UI copy, analytics and admin
-- screens (see the mapping done before this migration). `gateway` and `payment_method_key` answer different
-- questions: one is "how the customer paid" (channel), the other is "which integration we called" (backend).
--
-- WHY A SECOND COLUMN FOR invoice_number: Urubuto Pay's collection flow is two calls, not one.
-- `POST /v2/invoice/create` (no idempotency key — never retried on an unknown outcome) returns an invoice
-- number, which becomes `payer_code` on `POST /v2/payment/initiate` (idempotent on OUR `transaction_id`,
-- which is `momo_transactions.reference_id` unchanged). A crash between the two calls must not re-create the
-- invoice, so the number is persisted as soon as it exists — see repositories/collections.ts.

ALTER TABLE momo_transactions
    ADD COLUMN gateway text NOT NULL DEFAULT 'mtn_direct',
    ADD COLUMN invoice_number text;

ALTER TABLE momo_transactions
    ADD CONSTRAINT momo_gateway_values CHECK (gateway IN ('mtn_direct', 'urubuto')),
    -- Only a collection goes through the invoice/initiate dance; a disbursement (still MTN-direct-only) never has one.
    ADD CONSTRAINT momo_invoice_number_collection_only CHECK (invoice_number IS NULL OR direction = 'collection');

COMMENT ON COLUMN momo_transactions.gateway IS
    'Which integration handled this attempt — mtn_direct (the legacy MTN Open API client) or urubuto (Urubuto Pay). Not the same as payment_methods.key, which is customer-facing.';

COMMENT ON COLUMN momo_transactions.invoice_number IS
    'Urubuto Pay''s invoice number for a collection attempt, the payer_code on /v2/payment/initiate. Null for mtn_direct rows and for any row before its invoice exists.';
