-- V006_money_reference_data.sql
--
-- Milestone 9, first part. Countries, currencies, payment methods and plans — the
-- platform reference data that earlier migrations deliberately left as bare text.
--
-- This file exists to close loose ends on purpose left open:
--   V001  stores.country and stores.selling_currency were format CHECKs only, and
--         `plan` was deferred here entirely.
--   V004  orders.payment_method was CHECK IN ('cash','momo') — a placeholder, since
--         "momo" is a category and not a method. MTN and Airtel are both momo.
--   V005  wallets.currency had no reference either.
--
-- Everything here is seeded from the admin boards, so a fresh database can onboard
-- a merchant: AdminCurrencies for the six currencies and their formatting,
-- AdminPayments for the providers and the five countries, AdminPlans for Starter
-- and Growth.
--
-- WHAT THE BOARDS SAY, and what the schema therefore has to make true:
--   "Each store picks its selling currency at sign-up, SET BY ITS COUNTRY."
--       → countries carry a default currency.
--   "The charge is always in the store's currency." Conversion is display only.
--       → orders.currency references a currency and is never converted.
--   "Payment methods list which currencies they can charge in."
--       → a join, with per-currency minimum and maximum.
--   "Cash rounding applies only to cash-on-delivery totals."
--       → it lives on the currency and is applied by packages/core's money module
--         to a cash total, never to a card or momo total.


-- =============================================================================
-- 1. currencies
-- =============================================================================

CREATE TABLE currencies (
    code                 char(3)       PRIMARY KEY,
    name                 text          NOT NULL,

    -- How it is written. The money formatter in packages/core is driven entirely by
    -- these five columns, so there is one implementation and no per-screen guessing.
    symbol               text          NOT NULL,
    symbol_position      text          NOT NULL,
    decimals             smallint      NOT NULL,
    thousands_separator  char(1)       NOT NULL,

    -- Zero means off. Applied ONLY to a cash-on-delivery total, so a rider does not
    -- need small change.
    cash_rounding        numeric(12,2) NOT NULL DEFAULT 0,

    is_enabled           boolean       NOT NULL DEFAULT false,

    -- The platform's default, offered to a store whose country has no currency of
    -- its own. Exactly one, and it cannot be disabled.
    is_default           boolean       NOT NULL DEFAULT false,

    -- Display conversion only. USD is the reference: usd_rate is "1 USD equals this
    -- many units". Never used to charge anybody.
    rate_source          text          NOT NULL DEFAULT 'feed',
    usd_rate             numeric(18,6),
    rate_updated_at      timestamptz,

    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT currencies_code_format CHECK (code ~ '^[A-Z]{3}$'),
    CONSTRAINT currencies_symbol_present CHECK (btrim(symbol) <> ''),
    CONSTRAINT currencies_symbol_position_values CHECK (symbol_position IN ('before', 'after')),
    -- The two the editor offers. A third is a migration, because the formatter and
    -- every stored amount's scale depend on it.
    CONSTRAINT currencies_decimals_values CHECK (decimals IN (0, 2)),
    CONSTRAINT currencies_separator_values CHECK (thousands_separator IN (',', ' ', '.')),
    -- The five the editor offers: off, 10, 50, 100, 500.
    CONSTRAINT currencies_cash_rounding_values CHECK (cash_rounding IN (0, 10, 50, 100, 500)),
    CONSTRAINT currencies_rate_source_values CHECK (rate_source IN ('feed', 'manual')),
    CONSTRAINT currencies_usd_rate_positive CHECK (usd_rate IS NULL OR usd_rate > 0),
    -- A rate with no timestamp cannot be aged out, and AdminCurrencies promises that
    -- a feed older than 24 hours hides converted prices rather than showing them wrong.
    CONSTRAINT currencies_rate_has_timestamp CHECK ((usd_rate IS NULL) = (rate_updated_at IS NULL)),
    -- The default is what a store falls back to; a disabled default would strand it.
    CONSTRAINT currencies_default_is_enabled CHECK (NOT is_default OR is_enabled)
);

COMMENT ON TABLE currencies IS
    'How money is written, rounded and converted. The formatter in packages/core reads only these columns, so there is one implementation of "what does 3500 look like".';
COMMENT ON COLUMN currencies.cash_rounding IS
    'Applied only to cash-on-delivery totals. A card or momo total is never rounded — that difference is exactly the kind that goes unnoticed for a month.';
COMMENT ON COLUMN currencies.usd_rate IS
    'Display conversion only: "≈ $2.40" beside the real price. The charge is always in the store''s own currency.';

CREATE UNIQUE INDEX currencies_one_default ON currencies (is_default) WHERE is_default;

CREATE TRIGGER currencies_set_updated_at BEFORE UPDATE ON currencies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO currencies (code, name, symbol, symbol_position, decimals, thousands_separator,
                        cash_rounding, is_enabled, is_default) VALUES
    ('RWF', 'Rwandan franc',      'RWF', 'after',  0, ',',  50, true,  true),
    ('UGX', 'Ugandan shilling',   'UGX', 'before', 0, ',', 500, true,  false),
    ('KES', 'Kenyan shilling',    'KSh', 'before', 0, ',',  10, true,  false),
    ('TZS', 'Tanzanian shilling', 'TSh', 'before', 0, ',', 100, false, false),
    ('BIF', 'Burundian franc',    'FBu', 'after',  0, ' ', 100, false, false),
    -- Enabled for display conversion and card charges, per its tag on the board. No
    -- store sells in it today.
    ('USD', 'US dollar',          '$',   'before', 2, ',',   0, true,  false);


-- =============================================================================
-- 2. countries
-- =============================================================================

CREATE TABLE countries (
    code                  char(2)     PRIMARY KEY,
    name                  text        NOT NULL,

    -- "Each store picks its selling currency at sign-up, set by its country."
    default_currency_code char(3)     NOT NULL REFERENCES currencies (code) ON DELETE RESTRICT,

    is_enabled            boolean     NOT NULL DEFAULT false,
    created_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT countries_code_format CHECK (code ~ '^[A-Z]{2}$')
);

COMMENT ON TABLE countries IS
    'Where the platform operates. A country''s default currency is what a store signing up there sells in.';

INSERT INTO countries (code, name, default_currency_code, is_enabled) VALUES
    ('RW', 'Rwanda',   'RWF', true),
    ('UG', 'Uganda',   'UGX', true),
    ('KE', 'Kenya',    'KES', true),
    -- Modelled but not launched, which is Part 9's answer to multi-country scope:
    -- model all of it, enable Rwanda first.
    ('TZ', 'Tanzania', 'TZS', false),
    ('BI', 'Burundi',  'BIF', false);


-- =============================================================================
-- 3. payment_methods
-- =============================================================================
-- AdminPayments lists the ONLINE providers it has to integrate with. Cash is not on
-- that board because there is nothing to integrate: no provider, no webhook, no
-- success rate. It is still a payment method an order can name, so it lives here
-- with kind = 'offline' and is exempt from the country and currency joins below.

CREATE TABLE payment_methods (
    key             text        PRIMARY KEY,
    name            text        NOT NULL,
    short_name      text        NOT NULL,

    kind            text        NOT NULL,

    -- What the customer reads at checkout, and the line under it.
    customer_label  text        NOT NULL,
    customer_hint   text        NOT NULL,

    -- Online only.
    provider        text,
    webhook_url     text,

    status          text        NOT NULL DEFAULT 'draft',

    -- AdminPayments shows a live incident note on a degraded provider, which
    -- checkout surfaces: "Slow approvals since 13:10."
    incident_note   text,

    position        integer     NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT payment_methods_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT payment_methods_kind_values CHECK (kind IN ('online', 'offline')),
    CONSTRAINT payment_methods_status_values CHECK (status IN ('draft', 'live', 'paused')),
    -- An online method without a provider and a webhook cannot be charged through.
    CONSTRAINT payment_methods_online_has_provider CHECK (
        (kind = 'online' AND provider IS NOT NULL AND webhook_url IS NOT NULL)
     OR (kind = 'offline' AND provider IS NULL AND webhook_url IS NULL)
    )
);

COMMENT ON TABLE payment_methods IS
    'How a customer can pay. Online methods carry a provider and a webhook; cash is offline and needs neither, which is why AdminPayments does not list it.';
COMMENT ON COLUMN payment_methods.status IS
    'draft | live | paused. Only a live method may be named on a new order — enforced by orders_payment_method_usable.';

CREATE TRIGGER payment_methods_set_updated_at BEFORE UPDATE ON payment_methods
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO payment_methods (key, name, short_name, kind, customer_label, customer_hint,
                             provider, webhook_url, status, position) VALUES
    ('cash', 'Cash on delivery', 'CASH', 'offline',
     'Cash on delivery', 'Pay the rider when it arrives', NULL, NULL, 'live', 1),
    ('mtn_momo', 'MTN MoMo', 'MTN', 'online',
     'MTN Mobile Money', 'Approve on your phone',
     'MTN MoMo Collections API', 'https://api.example.invalid/hooks/mtn-momo', 'live', 2),
    ('airtel_money', 'Airtel Money', 'AIRTEL', 'online',
     'Airtel Money', 'Approve on your phone',
     'Airtel Africa Open API', 'https://api.example.invalid/hooks/airtel', 'live', 3),
    ('mpesa', 'M-Pesa', 'M-PESA', 'online',
     'M-Pesa', 'Approve with your M-Pesa PIN',
     'Safaricom Daraja API', 'https://api.example.invalid/hooks/mpesa', 'draft', 4);

-- The webhook hosts are placeholders: they depend on the domain decision in Part 9,
-- which is still open. example.invalid is reserved by RFC 2606 and can never
-- resolve, so a half-configured deployment fails loudly instead of posting a
-- customer's payment confirmation to somebody else's server.


CREATE TABLE payment_method_countries (
    payment_method_key text NOT NULL REFERENCES payment_methods (key) ON DELETE CASCADE,
    country_code       char(2) NOT NULL REFERENCES countries (code) ON DELETE RESTRICT,

    PRIMARY KEY (payment_method_key, country_code)
);

COMMENT ON TABLE payment_method_countries IS
    'Where an online method can be offered. MTN covers Rwanda and Uganda; M-Pesa is Kenya only.';

INSERT INTO payment_method_countries (payment_method_key, country_code) VALUES
    ('mtn_momo', 'RW'), ('mtn_momo', 'UG'),
    ('airtel_money', 'RW'),
    ('mpesa', 'KE');


CREATE TABLE payment_method_currencies (
    payment_method_key text          NOT NULL REFERENCES payment_methods (key) ON DELETE CASCADE,
    currency_code      char(3)       NOT NULL REFERENCES currencies (code) ON DELETE RESTRICT,

    -- "Payment methods list which currencies they can charge in", with the limits
    -- the provider imposes. A checkout above the maximum has to say so before the
    -- customer tries.
    min_amount         numeric(12,2) NOT NULL,
    max_amount         numeric(12,2) NOT NULL,

    PRIMARY KEY (payment_method_key, currency_code),

    CONSTRAINT pmc_amounts_positive CHECK (min_amount >= 0 AND max_amount > 0),
    CONSTRAINT pmc_max_above_min CHECK (max_amount > min_amount)
);

COMMENT ON TABLE payment_method_currencies IS
    'Which currencies a method can charge in, and the provider''s limits in each.';

INSERT INTO payment_method_currencies (payment_method_key, currency_code, min_amount, max_amount) VALUES
    ('mtn_momo', 'RWF', 100, 2000000),
    ('mtn_momo', 'UGX', 100, 2000000),
    ('airtel_money', 'RWF', 100, 1000000),
    ('mpesa', 'KES', 10, 250000);


-- =============================================================================
-- 4. plans and what they include
-- =============================================================================

CREATE TABLE plan_features (
    key         text        PRIMARY KEY,
    label       text        NOT NULL,
    description text        NOT NULL,
    position    integer     NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT plan_features_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$')
);

COMMENT ON TABLE plan_features IS
    'Commercial entitlements, which are NOT the same axis as industry modules. A module is what a business type does; a feature is what a plan permits. See the note at the foot of this file.';

INSERT INTO plan_features (key, label, description, position) VALUES
    ('delivery_and_riders', 'Delivery and riders',
     'Assign orders to riders and track deliveries.', 1),
    ('custom_domain', 'Custom domain',
     'Serve the storefront from the merchant''s own domain.', 2),
    ('theme_studio', 'Theme studio',
     'Compile and publish a store theme from the eight inputs.', 3),
    ('analytics_beyond_30_days', 'Analytics beyond 30 days',
     'History older than the rolling 30-day window.', 4),
    ('csv_export', 'CSV export',
     'Export orders, products and customers.', 5);


CREATE TABLE plans (
    key                 text          PRIMARY KEY,
    name                text          NOT NULL,

    -- AdminPlans: "Prices and fees are placeholders until finance confirms them."
    -- Nullable rather than zero, because zero is a price and NULL is "not decided" —
    -- and a store must not be billed from a number nobody agreed.
    monthly_price       numeric(12,2),
    -- numeric(6,3), not (5,3): (5,3) tops out at 99.999, which would make the
    -- "<= 100" CHECK below unreachable and leave the TYPE quietly enforcing a
    -- business rule. The rule belongs in the constraint, where it is readable.
    payment_fee_percent numeric(6,3),
    withdrawal_fee      numeric(12,2),
    currency_code       char(3)       REFERENCES currencies (code) ON DELETE RESTRICT,

    -- NULL means unlimited, which is what Growth shows.
    staff_account_limit integer,

    is_default          boolean       NOT NULL DEFAULT false,
    position            integer       NOT NULL DEFAULT 0,

    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT plans_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT plans_amounts_not_negative CHECK (
        (monthly_price IS NULL OR monthly_price >= 0)
    AND (withdrawal_fee IS NULL OR withdrawal_fee >= 0)
    ),
    CONSTRAINT plans_fee_percent_sane
        CHECK (payment_fee_percent IS NULL OR (payment_fee_percent >= 0 AND payment_fee_percent <= 100)),
    CONSTRAINT plans_staff_limit_positive
        CHECK (staff_account_limit IS NULL OR staff_account_limit > 0),
    -- A price without a currency is not a price.
    CONSTRAINT plans_price_has_currency
        CHECK ((monthly_price IS NULL AND withdrawal_fee IS NULL) OR currency_code IS NOT NULL)
);

COMMENT ON TABLE plans IS
    'What a store pays and what it gets. Prices are NULL until finance confirms them — see Part 9.';
COMMENT ON COLUMN plans.staff_account_limit IS
    'NULL is unlimited. Enforced when a store admin creates a member, at milestone 11.';

CREATE UNIQUE INDEX plans_one_default ON plans (is_default) WHERE is_default;

CREATE TRIGGER plans_set_updated_at BEFORE UPDATE ON plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO plans (key, name, staff_account_limit, is_default, position) VALUES
    ('starter', 'Starter', 3, true, 1),
    ('growth', 'Growth', NULL, false, 2);


CREATE TABLE plan_feature_grants (
    plan_key    text NOT NULL REFERENCES plans (key) ON DELETE CASCADE,
    feature_key text NOT NULL REFERENCES plan_features (key) ON DELETE RESTRICT,

    PRIMARY KEY (plan_key, feature_key)
);

COMMENT ON TABLE plan_feature_grants IS
    'Which features a plan includes. Absence is exclusion, so a new feature is off everywhere until granted deliberately.';

INSERT INTO plan_feature_grants (plan_key, feature_key) VALUES
    ('starter', 'delivery_and_riders'),
    ('starter', 'theme_studio'),
    ('growth', 'delivery_and_riders'),
    ('growth', 'custom_domain'),
    ('growth', 'theme_studio'),
    ('growth', 'analytics_beyond_30_days'),
    ('growth', 'csv_export');


-- =============================================================================
-- 5. Closing the loose ends
-- =============================================================================

-- stores: country and currency become references, and the plan arrives.
ALTER TABLE stores
    ADD COLUMN plan_key text NOT NULL DEFAULT 'starter'
        REFERENCES plans (key) ON DELETE RESTRICT,
    ADD CONSTRAINT stores_country_fkey
        FOREIGN KEY (country) REFERENCES countries (code) ON DELETE RESTRICT,
    ADD CONSTRAINT stores_currency_fkey
        FOREIGN KEY (selling_currency) REFERENCES currencies (code) ON DELETE RESTRICT;

COMMENT ON COLUMN stores.plan_key IS
    'Every store is on a plan. Defaults to the Starter plan rather than being nullable, because "no plan" is not a state the billing or entitlement code can read.';

-- Serves: AdminPlans' store counts, and the rollout that notifies a plan's stores.
CREATE INDEX stores_plan_idx ON stores (plan_key);

-- A store must sell in an ENABLED currency, and be in an ENABLED country. A
-- foreign key cannot say "enabled", so this is a trigger.
CREATE FUNCTION stores_assert_country_and_currency_open() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_ok boolean;
BEGIN
    SELECT is_enabled INTO v_ok FROM countries WHERE code = NEW.country;
    IF v_ok IS NULL THEN
        RETURN NEW;   -- stores_country_fkey owns "no such country"
    END IF;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'the platform is not open in % yet', NEW.country
            USING HINT = 'Enable the country in AdminPayments before onboarding a store there.';
    END IF;

    SELECT is_enabled INTO v_ok FROM currencies WHERE code = NEW.selling_currency;
    IF v_ok IS NULL THEN
        RETURN NEW;   -- stores_currency_fkey owns "no such currency"
    END IF;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'currency % is not enabled', NEW.selling_currency
            USING HINT = 'A store cannot sell in a currency the platform has not turned on.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER stores_country_and_currency_open
    BEFORE INSERT OR UPDATE OF country, selling_currency ON stores
    FOR EACH ROW EXECUTE FUNCTION stores_assert_country_and_currency_open();


-- wallets: the currency is a reference, and must match the store it belongs to.
ALTER TABLE wallets
    ADD CONSTRAINT wallets_currency_fkey
        FOREIGN KEY (currency) REFERENCES currencies (code) ON DELETE RESTRICT;


-- orders: payment_method becomes a reference, and currency does too.
--
-- The old CHECK allowed 'momo', which is a category rather than a method — MTN and
-- Airtel are both momo, and an order that only records "momo" cannot say which
-- provider to reconcile against.
ALTER TABLE orders
    DROP CONSTRAINT orders_payment_method_values,
    ADD CONSTRAINT orders_payment_method_fkey
        FOREIGN KEY (payment_method) REFERENCES payment_methods (key) ON DELETE RESTRICT,
    ADD CONSTRAINT orders_currency_fkey
        FOREIGN KEY (currency) REFERENCES currencies (code) ON DELETE RESTRICT;

-- The cash-only columns in V004 were written against payment_method = 'cash', which
-- is still the key of the offline method, so that constraint keeps its meaning.

-- An order may only name a method that is LIVE, and that can actually charge the
-- store's country and the order's currency. Without this, a checkout offers a
-- provider that will refuse the charge — which the customer experiences as their
-- money not arriving.
CREATE FUNCTION orders_assert_payment_method_usable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_kind    text;
    v_status  text;
    v_country char(2);
    v_min     numeric(12,2);
    v_max     numeric(12,2);
BEGIN
    SELECT kind, status INTO v_kind, v_status
      FROM payment_methods WHERE key = NEW.payment_method;
    IF v_kind IS NULL THEN
        RETURN NEW;   -- orders_payment_method_fkey owns "no such method"
    END IF;

    IF v_status <> 'live' THEN
        RAISE EXCEPTION 'payment method % is %, so it cannot take a new order', NEW.payment_method, v_status
            USING HINT = 'A draft or paused method must not be offered at checkout.';
    END IF;

    -- Cash needs no provider, so it needs no country or currency agreement either.
    IF v_kind = 'offline' THEN
        RETURN NEW;
    END IF;

    SELECT country INTO v_country FROM stores WHERE id = NEW.store_id;

    IF NOT EXISTS (
        SELECT 1 FROM payment_method_countries
         WHERE payment_method_key = NEW.payment_method AND country_code = v_country
    ) THEN
        RAISE EXCEPTION '% is not available in %', NEW.payment_method, v_country;
    END IF;

    SELECT min_amount, max_amount INTO v_min, v_max
      FROM payment_method_currencies
     WHERE payment_method_key = NEW.payment_method AND currency_code = NEW.currency;

    IF v_min IS NULL THEN
        RAISE EXCEPTION '% cannot charge in %', NEW.payment_method, NEW.currency
            USING HINT = 'AdminPayments lists which currencies each method can charge in.';
    END IF;

    -- NOTE ON THE TRIGGER TIMING BELOW. This has to be an AFTER trigger, and the
    -- reason is a trap: total_amount is a STORED GENERATED column, and Postgres
    -- computes generated columns AFTER before-triggers run. In a BEFORE trigger
    -- NEW.total_amount is therefore NULL, `NULL < v_min` is NULL rather than true,
    -- and this entire check silently passes everything. It was written BEFORE first
    -- and did exactly that.
    --
    -- The alternative — re-deriving subtotal + delivery - discount here — would
    -- duplicate arithmetic that must never drift from the generated column's own.
    IF NEW.total_amount < v_min OR NEW.total_amount > v_max THEN
        RAISE EXCEPTION '% takes between % and % in %, not %',
            NEW.payment_method, v_min, v_max, NEW.currency, NEW.total_amount
            USING HINT = 'Tell the customer before they try, not after the provider refuses.';
    END IF;

    RETURN NEW;
END;
$init$;

-- AFTER, not BEFORE, so that total_amount is populated — see the note in the
-- function. A RAISE in an AFTER trigger still aborts the statement, so nothing is
-- let through; the only difference is that the generated column is readable.
CREATE TRIGGER orders_payment_method_usable
    AFTER INSERT ON orders
    FOR EACH ROW EXECUTE FUNCTION orders_assert_payment_method_usable();

COMMENT ON FUNCTION orders_assert_payment_method_usable IS
    'On INSERT only: an existing order keeps its method even after that method is paused, because history must stay readable. Runs AFTER insert because it reads the GENERATED total.';


-- momo_transactions: record WHICH provider handled it.
ALTER TABLE momo_transactions
    ADD COLUMN payment_method_key text REFERENCES payment_methods (key) ON DELETE RESTRICT;

COMMENT ON COLUMN momo_transactions.payment_method_key IS
    'Which provider this attempt went through. The old schema assumed MTN; with Airtel and M-Pesa in the same table, reconciliation needs to know.';


-- =============================================================================
-- Two overlaps recorded rather than resolved
-- =============================================================================
-- 1. `plan_features.delivery_and_riders` and the industry module `delivery` gate the
--    same capability from different directions: one commercial, one by business
--    type. The effective answer is presumably "the module is on AND the plan grants
--    it", but no board states that, so the resolver at milestone 12 has to decide it
--    deliberately rather than inherit it from here.
--
-- 2. AdminPlans says "Price and fee changes take effect after [NOTICE PERIOD];
--    feature changes apply immediately." That needs effective-dated prices, which
--    cannot be designed until the notice period is a number. Prices are NULL here
--    for the same reason, so nothing is billed from a figure nobody agreed.
