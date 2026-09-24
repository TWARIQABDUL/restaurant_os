-- V002_industry_config.sql
--
-- Milestone 6. "Industries are configurations, not apps" — the claim
-- Industries.dc.html makes and this file has to make true in data.
--
-- A component gets two primitives and no more: t(key) for a word and has(module)
-- for a feature gate. If a component ever branches on an industry name, the
-- config engine has failed. That means every difference between a restaurant and
-- a pharmacy must be expressible as rows here.
--
-- SOURCES. AdminIndustries.dc.html is the editor, so its list of modules is what
-- the platform offers and its eight templates are the data this must hold.
-- Industries.dc.html is the architecture explainer; where the two disagree, the
-- editor wins and the difference is recorded at the bottom of this file.
--
-- WHY THE MODULE LIST IS A TABLE AND NOT A jsonb ARRAY. A template referring to
-- module 'stok' would make has('stock') false for every store on that template,
-- silently and forever. A foreign key makes that unrepresentable. Same reasoning
-- as role_permissions in V001: the failure mode of a typo is silence, so the
-- typo has to be impossible rather than unlikely.


-- =============================================================================
-- 1. Validators
-- =============================================================================
-- CHECK constraints cannot contain subqueries, but they can call an IMMUTABLE
-- function. That is how the nested shapes below get validated at the column
-- rather than in whichever writer happens to remember.

CREATE FUNCTION config_is_words(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog
AS $init$
    -- An object whose keys are the four the editor shows, with non-empty values.
    -- A fifth key is a platform capability change, so it is a migration, not data.
    SELECT jsonb_typeof(value) = 'object'
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_each(value) AS e(k, v)
            WHERE e.k NOT IN ('product', 'catalog', 'category', 'option')
               OR jsonb_typeof(e.v) <> 'string'
               OR btrim(e.v #>> '{}') = ''
       );
$init$;

COMMENT ON FUNCTION config_is_words(jsonb) IS
    'Words a merchant and customer see, keyed by what the platform calls the thing. Read by t().';

CREATE FUNCTION config_is_attributes(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog
AS $init$
    -- [{ "name": "Size", "pick": "one" | "several", "priced": true? }]
    -- AdminIndustries renders these as one-tap suggestions in Add product, and
    -- Industries' food.json is where "priced" comes from.
    -- PRESENCE IS CHECKED BEFORE TYPE, and that order is the whole correctness of
    -- this function. `item -> 'name'` on an object without a name is SQL NULL, and
    -- `jsonb_typeof(NULL) <> 'string'` evaluates to NULL — not true — so a type
    -- check alone lets a missing field through silently. The `?` tests make every
    -- expression after them non-NULL.
    SELECT jsonb_typeof(value) = 'array'
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(value) AS a(item)
            WHERE jsonb_typeof(a.item) <> 'object'
               OR NOT (a.item ? 'name')
               OR NOT (a.item ? 'pick')
               OR jsonb_typeof(a.item -> 'name') <> 'string'
               OR jsonb_typeof(a.item -> 'pick') <> 'string'
               OR btrim(a.item ->> 'name') = ''
               OR (a.item ->> 'pick') NOT IN ('one', 'several')
               OR (a.item ? 'priced' AND jsonb_typeof(a.item -> 'priced') <> 'boolean')
               OR EXISTS (
                   SELECT 1 FROM jsonb_object_keys(a.item) AS k(key)
                    WHERE k.key NOT IN ('name', 'pick', 'priced')
               )
       );
$init$;

CREATE FUNCTION config_is_order_steps(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog
AS $init$
    -- [{ "key": "pharmacist_check", "label": "Pharmacist check" }], ordered.
    --
    -- Two fields, not one, because the key is what code and history refer to
    -- while the label is per-industry wording — Services calls its first step
    -- "Booked" where Food calls it "New", and both mean the same state.
    --
    -- Keys must be unique: a duplicate would make the customer timeline ambiguous
    -- about which step an order is on.
    -- Presence before type, for the reason spelled out in config_is_attributes:
    -- a missing field makes the comparison NULL rather than true, and a step with
    -- no label would otherwise pass and break the customer timeline at runtime.
    SELECT jsonb_typeof(value) = 'array'
       AND jsonb_array_length(value) >= 2
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(value) AS s(item)
            WHERE jsonb_typeof(s.item) <> 'object'
               OR NOT (s.item ? 'key')
               OR NOT (s.item ? 'label')
               OR jsonb_typeof(s.item -> 'key') <> 'string'
               OR jsonb_typeof(s.item -> 'label') <> 'string'
               OR (s.item ->> 'key') !~ '^[a-z][a-z0-9_]*$'
               OR btrim(s.item ->> 'label') = ''
               OR EXISTS (
                   SELECT 1 FROM jsonb_object_keys(s.item) AS k(key)
                    WHERE k.key NOT IN ('key', 'label')
               )
       )
       AND (
           SELECT count(DISTINCT s.item ->> 'key') = jsonb_array_length(value)
             FROM jsonb_array_elements(value) AS s(item)
       );
$init$;


-- =============================================================================
-- 2. What the platform offers
-- =============================================================================
-- Two registries. A template may only switch on a module that exists and only
-- carry a flag the components know how to render.

CREATE TABLE modules (
    key         text        PRIMARY KEY,
    label       text        NOT NULL,
    description text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT modules_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$')
);

COMMENT ON TABLE modules IS
    'Feature gates a template can switch on. has(module) reads these. Adding one is a migration because a module without code behind it does nothing.';

INSERT INTO modules (key, label, description) VALUES
    ('modifiers',    'Priced extras (modifiers)', 'Option values that add to the line total, like cheese on a burger.'),
    ('delivery',     'Delivery',                  'The store delivers, so checkout collects an address and orders can be assigned to a rider.'),
    ('pickup',       'Pickup',                    'The customer collects, so checkout offers a time instead of an address.'),
    ('table',        'Table ordering (QR)',       'A QR code at a table starts an order already scoped to it.'),
    ('scheduled',    'Scheduled orders',          'The customer chooses a future slot rather than ordering for now.'),
    ('stock',        'Stock tracking',            'Products carry counts, are reserved at checkout, and go out of stock on their own.'),
    ('appointments', 'Appointments',              'A product is booked for a time with a staff member rather than dispatched.'),
    ('rx',           'Prescription flag',         'Enables the prescription_required product flag and the checkout step it adds.');

CREATE TABLE product_flags (
    key         text        PRIMARY KEY,
    label       text        NOT NULL,
    description text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT product_flags_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$')
);

COMMENT ON TABLE product_flags IS
    'Flags a product can carry that components already know how to render — a badge on the card, an extra step at checkout, a note on the order.';

INSERT INTO product_flags (key, label, description) VALUES
    ('prescription_required', 'Prescription required',
     'Shows an Rx badge on the product card, changes the Add button to "Add · upload prescription", and adds a photo-upload step at checkout.');


-- =============================================================================
-- 3. Templates, and their versions
-- =============================================================================

CREATE TABLE industry_templates (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    key          text        NOT NULL,
    name         text        NOT NULL,

    -- AdminIndustries gives each template a dot colour in the list. Template
    -- metadata, not a store's theme — a store's accent is its own (milestone 13).
    accent_color text        NOT NULL,

    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT industry_templates_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT industry_templates_accent_format CHECK (accent_color ~ '^#[0-9A-F]{6}$')
);

COMMENT ON TABLE industry_templates IS
    'A business type a merchant can pick at sign-up. The configuration itself lives on its versions.';

CREATE UNIQUE INDEX industry_templates_key_key ON industry_templates (key);

CREATE TRIGGER industry_templates_set_updated_at BEFORE UPDATE ON industry_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE industry_template_versions (
    template_id  uuid        NOT NULL REFERENCES industry_templates (id) ON DELETE RESTRICT,
    version      integer     NOT NULL,
    status       text        NOT NULL DEFAULT 'draft',

    words        jsonb       NOT NULL,
    attributes   jsonb       NOT NULL DEFAULT '[]',
    order_steps  jsonb       NOT NULL,

    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,

    PRIMARY KEY (template_id, version),

    CONSTRAINT itv_version_positive CHECK (version >= 1),
    CONSTRAINT itv_status_values CHECK (status IN ('draft', 'published')),

    -- A published version has a publication time and a draft does not. Without
    -- this the two can disagree, and "when did this store's config change" stops
    -- being answerable.
    CONSTRAINT itv_published_at_agrees CHECK ((status = 'published') = (published_at IS NOT NULL)),

    CONSTRAINT itv_words_valid CHECK (config_is_words(words)),
    CONSTRAINT itv_attributes_valid CHECK (config_is_attributes(attributes)),
    CONSTRAINT itv_order_steps_valid CHECK (config_is_order_steps(order_steps)),

    -- Referenced by the composite foreign key from stores, so that a store can
    -- only pin a version that exists.
    CONSTRAINT itv_template_version_key UNIQUE (template_id, version)
);

COMMENT ON TABLE industry_template_versions IS
    'One version of a template. A published version is IMMUTABLE, because stores pin to it — changing it would silently reconfigure every store on it.';
COMMENT ON COLUMN industry_template_versions.status IS
    'draft | published. Publishing is one-way: a new change is a new version, which is what makes a pinned version trustworthy.';

-- At most one draft per template: AdminIndustries edits "the" draft, so two would
-- make "Save draft" ambiguous.
CREATE UNIQUE INDEX itv_one_draft_per_template
    ON industry_template_versions (template_id) WHERE status = 'draft';

-- Serves: resolving the current configuration — the highest published version of
-- a template — which the config resolver does on a cache miss.
CREATE INDEX itv_published_lookup
    ON industry_template_versions (template_id, version DESC) WHERE status = 'published';


-- A published version is immutable. This is the guarantee the whole pinning model
-- rests on: if v4 can change, a store pinned to v4 is pinned to nothing.
CREATE FUNCTION industry_template_version_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'published' THEN
            RAISE EXCEPTION 'cannot delete published template version %/%', OLD.template_id, OLD.version
                USING HINT = 'Stores pin to published versions. Publish a new version instead.';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status = 'published' THEN
        RAISE EXCEPTION 'cannot modify published template version %/%', OLD.template_id, OLD.version
            USING HINT = 'A published version is immutable because stores pin to it. Create a new version.';
    END IF;

    -- draft -> published is the one transition, and it may not rewrite the
    -- configuration on its way through: publishing records a decision, it does not
    -- make one.
    IF NEW.status = 'published' AND (
           NEW.words IS DISTINCT FROM OLD.words
        OR NEW.attributes IS DISTINCT FROM OLD.attributes
        OR NEW.order_steps IS DISTINCT FROM OLD.order_steps
    ) THEN
        RAISE EXCEPTION 'publishing template version %/% may not also change it', OLD.template_id, OLD.version
            USING HINT = 'Save the draft first, then publish it, so that what was reviewed is what ships.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER industry_template_versions_freeze
    BEFORE UPDATE OR DELETE ON industry_template_versions
    FOR EACH ROW EXECUTE FUNCTION industry_template_version_freeze();


-- =============================================================================
-- 4. What each version switches on
-- =============================================================================

CREATE TABLE industry_template_version_modules (
    template_id uuid    NOT NULL,
    version     integer NOT NULL,
    module_key  text    NOT NULL REFERENCES modules (key) ON DELETE RESTRICT,

    PRIMARY KEY (template_id, version, module_key),
    FOREIGN KEY (template_id, version)
        REFERENCES industry_template_versions (template_id, version) ON DELETE CASCADE
);

COMMENT ON TABLE industry_template_version_modules IS
    'Modules a version turns on by default. Absence means off. Merchants can still change these in Settings, which is what stores.config_overrides carries.';

CREATE TABLE industry_template_version_product_flags (
    template_id uuid    NOT NULL,
    version     integer NOT NULL,
    flag_key    text    NOT NULL REFERENCES product_flags (key) ON DELETE RESTRICT,

    PRIMARY KEY (template_id, version, flag_key),
    FOREIGN KEY (template_id, version)
        REFERENCES industry_template_versions (template_id, version) ON DELETE CASCADE
);

COMMENT ON TABLE industry_template_version_product_flags IS
    'Product flags available to stores on this version. Pharmacy carries prescription_required.';


-- The published version's module and flag sets are part of what is frozen. A
-- version whose payload cannot change but whose module list can is not immutable.
CREATE FUNCTION industry_template_child_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_template uuid;
    v_version  integer;
    v_status   text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_template := OLD.template_id; v_version := OLD.version;
    ELSE
        v_template := NEW.template_id; v_version := NEW.version;
    END IF;

    SELECT status INTO v_status FROM industry_template_versions
     WHERE template_id = v_template AND version = v_version;

    -- NULL when the parent row is going away in the same statement, which is the
    -- ON DELETE CASCADE of a draft and is allowed.
    IF v_status = 'published' THEN
        RAISE EXCEPTION 'cannot change % of published template version %/%', TG_TABLE_NAME, v_template, v_version
            USING HINT = 'A published version is immutable. Create a new version.';
    END IF;

    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$init$;

CREATE TRIGGER itvm_freeze
    BEFORE INSERT OR UPDATE OR DELETE ON industry_template_version_modules
    FOR EACH ROW EXECUTE FUNCTION industry_template_child_freeze();

CREATE TRIGGER itvpf_freeze
    BEFORE INSERT OR UPDATE OR DELETE ON industry_template_version_product_flags
    FOR EACH ROW EXECUTE FUNCTION industry_template_child_freeze();


-- =============================================================================
-- 5. A store's configuration
-- =============================================================================

ALTER TABLE stores
    ADD COLUMN industry_template_id      uuid,
    ADD COLUMN industry_template_version integer,
    ADD COLUMN config_overrides          jsonb NOT NULL DEFAULT '{}';

-- Both or neither: half a pin resolves to nothing.
ALTER TABLE stores
    ADD CONSTRAINT stores_template_pin_complete
        CHECK ((industry_template_id IS NULL) = (industry_template_version IS NULL)),
    ADD CONSTRAINT stores_template_pin_fkey
        FOREIGN KEY (industry_template_id, industry_template_version)
        REFERENCES industry_template_versions (template_id, version) ON DELETE RESTRICT,
    ADD CONSTRAINT stores_config_overrides_is_object
        CHECK (jsonb_typeof(config_overrides) = 'object');

COMMENT ON COLUMN stores.industry_template_version IS
    'Pinned, not floating. Publishing a new template version does not move a store to it — AdminIndustries makes that an explicit rollout choice.';
COMMENT ON COLUMN stores.config_overrides IS
    'What this merchant changed in Settings. Merged over the pinned version by the config resolver; the template is never edited per store.';

-- Serves: AdminIndustries' store counts per template, and the rollout that
-- updates existing stores on one.
CREATE INDEX stores_template_idx ON stores (industry_template_id, industry_template_version)
    WHERE industry_template_id IS NOT NULL;

-- A store may only pin a PUBLISHED version. A foreign key cannot express that,
-- because status is mutable while the key is being written; a trigger can.
CREATE FUNCTION stores_assert_published_pin() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_status text;
BEGIN
    -- A BEFORE trigger runs before the CHECK and FOREIGN KEY constraints, so it
    -- must not assume either already holds. Both cases below belong to a
    -- constraint that names them precisely; raising here instead would replace a
    -- clear error with a misleading one.
    IF NEW.industry_template_id IS NULL OR NEW.industry_template_version IS NULL THEN
        RETURN NEW;   -- stores_template_pin_complete owns a half-written pin
    END IF;

    SELECT status INTO v_status FROM industry_template_versions
     WHERE template_id = NEW.industry_template_id AND version = NEW.industry_template_version;

    IF v_status IS NULL THEN
        RETURN NEW;   -- stores_template_pin_fkey owns a version that does not exist
    END IF;

    IF v_status <> 'published' THEN
        RAISE EXCEPTION 'store % cannot pin template version %/% because it is not published',
            NEW.slug, NEW.industry_template_id, NEW.industry_template_version
            USING HINT = 'A draft is unreviewed configuration. Publish it first.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER stores_published_pin BEFORE INSERT OR UPDATE OF industry_template_id, industry_template_version
    ON stores FOR EACH ROW EXECUTE FUNCTION stores_assert_published_pin();


-- Overrides must name things that exist. The same argument as the module table:
-- an override of 'stok' is silently ignored forever.
CREATE FUNCTION stores_assert_valid_overrides() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_bad text;
BEGIN
    -- Same reason as stores_assert_published_pin: this runs before the CHECK, and
    -- jsonb_object_keys on an array raises an internal error that tells the caller
    -- nothing. Let stores_config_overrides_is_object say it.
    IF jsonb_typeof(NEW.config_overrides) <> 'object' THEN
        RETURN NEW;
    END IF;

    SELECT string_agg(k.key, ', ') INTO v_bad
      FROM jsonb_object_keys(NEW.config_overrides) AS k(key)
     WHERE k.key NOT IN ('words', 'modules');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'unknown config override section(s): %', v_bad
            USING HINT = 'Only "words" and "modules" may be overridden per store.';
    END IF;

    IF NEW.config_overrides ? 'words' AND NOT config_is_words(NEW.config_overrides -> 'words') THEN
        RAISE EXCEPTION 'config_overrides.words is not a valid word map'
            USING HINT = 'Keys must be product, catalog, category or option, with non-empty text values.';
    END IF;

    IF NEW.config_overrides ? 'modules' THEN
        IF jsonb_typeof(NEW.config_overrides -> 'modules') <> 'object' THEN
            RAISE EXCEPTION 'config_overrides.modules must be an object of module key to boolean';
        END IF;

        SELECT string_agg(e.k, ', ') INTO v_bad
          FROM jsonb_each(NEW.config_overrides -> 'modules') AS e(k, v)
         WHERE jsonb_typeof(e.v) <> 'boolean';
        IF v_bad IS NOT NULL THEN
            RAISE EXCEPTION 'config override for module(s) % must be true or false', v_bad;
        END IF;

        SELECT string_agg(e.k, ', ') INTO v_bad
          FROM jsonb_each(NEW.config_overrides -> 'modules') AS e(k, v)
         WHERE NOT EXISTS (SELECT 1 FROM modules m WHERE m.key = e.k);
        IF v_bad IS NOT NULL THEN
            RAISE EXCEPTION 'unknown module(s) in config_overrides: %', v_bad
                USING HINT = 'See the modules table. An override of a module that does not exist would be ignored silently.';
        END IF;
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER stores_valid_overrides BEFORE INSERT OR UPDATE OF config_overrides
    ON stores FOR EACH ROW EXECUTE FUNCTION stores_assert_valid_overrides();


-- =============================================================================
-- 6. The eight templates AdminIndustries draws
-- =============================================================================
-- These ship in the migration rather than in a seed script, because a database
-- with no industry templates cannot onboard a merchant — Onboarding's first
-- question is the business type. Reference data the product does not work without
-- belongs with the schema; dev fixtures belong in db/seeds.
--
-- Everything starts at v1 and published, except Pharmacy. The board shows it as a
-- draft with "Not offered yet", so it ships as a draft: no store can pin it, and
-- the draft path is exercised by real data rather than only by a test. The board's
-- v4 and v5 are its own fictional history; inventing version numbers would make
-- published_at a lie.

INSERT INTO industry_templates (key, name, accent_color) VALUES
    ('food',        'Food & drinks', '#1D6B47'),
    ('fashion',     'Fashion',       '#1F437F'),
    ('beauty',      'Beauty',        '#9D174D'),
    ('electronics', 'Electronics',   '#C2410C'),
    ('grocery',     'Grocery',       '#1A7443'),
    ('pharmacy',    'Pharmacy',      '#2F6570'),
    ('furniture',   'Furniture',     '#8A5A2B'),
    ('services',    'Services',      '#4B3A83');

-- Word maps and presets, verbatim from the editor. Note how little differs: the
-- same four keys, the same two attribute rules. That similarity is the argument
-- the Industries board is making.
-- Every version is born a DRAFT, gets its modules attached, and is published at
-- the end of this file. That is not a workaround: a published version is frozen
-- including its module list, so a version cannot be born published — its modules
-- arrive in a second statement. The editor works the same way, which means this
-- seed exercises the real publish path rather than a back door into it.
INSERT INTO industry_template_versions
    (template_id, version, status, words, attributes, order_steps)
SELECT t.id, 1, 'draft', v.words::jsonb, v.attributes::jsonb, v.order_steps::jsonb
  FROM industry_templates t
  JOIN (VALUES
    ('food', 'published',
     '{"product":"Menu items","catalog":"Menu","category":"Sections","option":"Extras"}',
     '[{"name":"Size","pick":"one"},{"name":"Extras","pick":"several","priced":true},{"name":"Spice level","pick":"one"}]',
     '[{"key":"new","label":"New"},{"key":"preparing","label":"Preparing"},{"key":"ready","label":"Ready"},{"key":"delivered","label":"Delivered"}]'),

    ('fashion', 'published',
     '{"product":"Products","catalog":"Shop","category":"Collections","option":"Variants"}',
     '[{"name":"Size","pick":"one"},{"name":"Color","pick":"one"},{"name":"Material","pick":"one"}]',
     '[{"key":"new","label":"New"},{"key":"packed","label":"Packed"},{"key":"out_for_delivery","label":"Out for delivery"},{"key":"delivered","label":"Delivered"}]'),

    ('beauty', 'published',
     '{"product":"Products","catalog":"Shop","category":"Brands","option":"Shades"}',
     '[{"name":"Shade","pick":"one"},{"name":"Size","pick":"one"},{"name":"Skin type","pick":"one"}]',
     '[{"key":"new","label":"New"},{"key":"packed","label":"Packed"},{"key":"out_for_delivery","label":"Out for delivery"},{"key":"delivered","label":"Delivered"}]'),

    ('electronics', 'published',
     '{"product":"Products","catalog":"Shop","category":"Brands","option":"Configurations"}',
     '[{"name":"Storage","pick":"one"},{"name":"Color","pick":"one"},{"name":"Warranty","pick":"one"}]',
     '[{"key":"new","label":"New"},{"key":"packed","label":"Packed"},{"key":"out_for_delivery","label":"Out for delivery"},{"key":"delivered","label":"Delivered"}]'),

    ('grocery', 'published',
     '{"product":"Products","catalog":"Aisles","category":"Aisles","option":"Pack sizes"}',
     '[{"name":"Weight","pick":"one"},{"name":"Pack size","pick":"one"}]',
     '[{"key":"new","label":"New"},{"key":"picking","label":"Picking"},{"key":"out_for_delivery","label":"Out for delivery"},{"key":"delivered","label":"Delivered"}]'),

    -- The whole point of the Industries board: a new business type is a config,
    -- not a redesign. An extra step between new and preparing, and one product
    -- flag that components already know how to render.
    ('pharmacy', 'draft',
     '{"product":"Medicines","catalog":"Shop","category":"Sections","option":"Pack sizes"}',
     '[{"name":"Strength","pick":"one"},{"name":"Pack size","pick":"one"}]',
     '[{"key":"new","label":"New"},{"key":"pharmacist_check","label":"Pharmacist check"},{"key":"preparing","label":"Preparing"},{"key":"ready","label":"Ready"},{"key":"delivered","label":"Delivered"}]'),

    ('furniture', 'published',
     '{"product":"Products","catalog":"Showroom","category":"Rooms","option":"Finishes"}',
     '[{"name":"Finish","pick":"one"},{"name":"Size","pick":"one"},{"name":"Assembly","pick":"several"}]',
     '[{"key":"new","label":"New"},{"key":"made_to_order","label":"Made to order"},{"key":"out_for_delivery","label":"Out for delivery"},{"key":"delivered","label":"Delivered"}]'),

    -- Services has no delivery and no pickup, and its first step is "Booked". The
    -- same order machine, read differently.
    ('services', 'published',
     '{"product":"Services","catalog":"Services","category":"Categories","option":"Add-ons"}',
     '[{"name":"Duration","pick":"one"},{"name":"Staff member","pick":"one"},{"name":"Add-ons","pick":"several"}]',
     '[{"key":"booked","label":"Booked"},{"key":"confirmed","label":"Confirmed"},{"key":"in_progress","label":"In progress"},{"key":"done","label":"Done"}]')
  ) AS v(key, status, words, attributes, order_steps) ON v.key = t.key;

-- Modules on by default, from the editor's toggles. Absence is off.
INSERT INTO industry_template_version_modules (template_id, version, module_key)
SELECT t.id, 1, m.module_key
  FROM industry_templates t
  JOIN (VALUES
    ('food', 'modifiers'), ('food', 'delivery'), ('food', 'pickup'), ('food', 'table'),
    ('fashion', 'delivery'), ('fashion', 'pickup'), ('fashion', 'stock'),
    ('beauty', 'delivery'), ('beauty', 'pickup'), ('beauty', 'stock'), ('beauty', 'appointments'),
    ('electronics', 'delivery'), ('electronics', 'pickup'), ('electronics', 'stock'),
    ('grocery', 'delivery'), ('grocery', 'pickup'), ('grocery', 'scheduled'), ('grocery', 'stock'),
    ('pharmacy', 'delivery'), ('pharmacy', 'pickup'), ('pharmacy', 'stock'), ('pharmacy', 'rx'),
    ('furniture', 'delivery'), ('furniture', 'scheduled'), ('furniture', 'stock'),
    ('services', 'modifiers'), ('services', 'scheduled'), ('services', 'appointments')
  ) AS m(key, module_key) ON m.key = t.key;

INSERT INTO industry_template_version_product_flags (template_id, version, flag_key)
SELECT t.id, 1, 'prescription_required'
  FROM industry_templates t WHERE t.key = 'pharmacy';


-- Publish everything except Pharmacy, now that each version is complete. This is
-- the draft -> published transition the freeze trigger allows exactly once.
UPDATE industry_template_versions v
   SET status = 'published', published_at = now()
  FROM industry_templates t
 WHERE t.id = v.template_id
   AND t.key <> 'pharmacy';


-- =============================================================================
-- Where the two boards disagree, recorded rather than resolved
-- =============================================================================
-- AdminIndustries' editor offers the eight modules seeded above. Industries'
-- illustrative JSON and product cards mention others that the editor does not:
--
--   expiry_dates · table_ordering (the editor calls it `table`) · variants ·
--   stock_per_variant · reviews · brands · specs_table · warranty · serial_numbers
--
-- Some are plainly modules the platform will want; others look like prose on a
-- card rather than a switch. Seeding a module with no code behind it would make
-- has() return true for a feature that does not exist, which is worse than the
-- gap. They are a question for the designer, and adding any of them later is an
-- INSERT plus the code that honours it.
