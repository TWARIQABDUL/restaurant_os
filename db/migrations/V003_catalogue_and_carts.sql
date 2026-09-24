-- V003_catalogue_and_carts.sql
--
-- Milestone 7. Products, the sections they sit in, their options, the variant
-- matrix, and the server-side cart.
--
-- THE VARIANT RULE, taken from AddProduct.dc.html rather than guessed:
--
--   variants = the cartesian product of the option groups whose mode is "pick
--   one", and ONLY those.
--
-- A "pick several" group is not a dimension. Extras on a burger (Cheese +500,
-- Fries +1,000) are chosen per line at checkout and priced per selection; they do
-- not multiply into variants. Size × Colour does: four sizes and three colours are
-- twelve variants, each with its own stock and SKU, and the storefront strikes
-- through the combinations that are sold out.
--
-- EVERY PRODUCT HAS AT LEAST ONE VARIANT, including a burger with no options at
-- all. The UI draws this as either "one stock number" or "stock for each variant",
-- but underneath it is one shape, because milestone 8's reserve_stock has to
-- decrement exactly one row atomically. Two places for stock would mean two code
-- paths through the function the plan calls the riskiest edit in the rewrite.
--
-- TENANCY IS DECLARATIVE. Every table here carries store_id, and every join
-- between two of them carries it too and composite-foreign-keys it. §2.3 warns
-- that one missing tenant predicate is "a cross-tenant leak that will not announce
-- itself" — so instead of relying on every query to remember, attaching one
-- store's option group to another store's product is made unrepresentable. The
-- pattern is V001's UNIQUE (id, scope) trick, applied to store_id.


-- =============================================================================
-- 1. products
-- =============================================================================

CREATE TABLE products (
    id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id          uuid          NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    name              text          NOT NULL,
    description       text          NOT NULL DEFAULT '',

    -- The price a variant starts from. A variant's price is this plus the deltas
    -- of its option values, computed rather than stored — AddProduct offers no way
    -- to price a variant independently, and what a customer actually paid belongs
    -- on the order line (milestone 8), not here.
    base_price        numeric(12,2) NOT NULL,

    -- Struck through beside the price when set. Only meaningful above it.
    compare_at_price  numeric(12,2),

    cover_image_url   text,

    -- Opt-in, per the inventory design: a restaurant switches items off when they
    -- sell out, a clothes shop counts them.
    track_stock       boolean       NOT NULL DEFAULT false,

    status            text          NOT NULL DEFAULT 'draft',
    position          integer       NOT NULL DEFAULT 0,

    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT products_name_present CHECK (btrim(name) <> ''),
    CONSTRAINT products_base_price_not_negative CHECK (base_price >= 0),
    CONSTRAINT products_compare_at_above_price
        CHECK (compare_at_price IS NULL OR compare_at_price > base_price),
    CONSTRAINT products_status_values CHECK (status IN ('draft', 'active')),

    -- Lets every child table carry store_id and composite-FK it, so a product and
    -- its variants, options and categories cannot belong to different stores.
    CONSTRAINT products_id_store_key UNIQUE (id, store_id)
);

COMMENT ON TABLE products IS
    'What a store sells. Called menu items, products, medicines or services depending on the store''s industry template — one table, read differently.';
COMMENT ON COLUMN products.base_price IS
    'The price a variant starts from. A variant price is this plus its option value deltas, computed at read time.';

-- Serves: the storefront catalogue, which lists a store's active products in the
-- merchant's chosen order. Partial because a draft is never listed.
CREATE INDEX products_store_position_idx ON products (store_id, position, id) WHERE status = 'active';

-- Serves: the merchant's Products board, which lists everything newest first.
CREATE INDEX products_store_created_idx ON products (store_id, created_at DESC);

CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- 2. categories — "Sections", "Collections", "Aisles", "Rooms"
-- =============================================================================
-- Free text on the product is gone. Categories.dc.html: "Products can sit in more
-- than one section", so this is a join, not a column — and "Order here is the
-- order on your store", so position is data.

CREATE TABLE categories (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id    uuid        NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    name        text        NOT NULL,
    description text        NOT NULL DEFAULT '',
    image_url   text,

    -- The switch in Categories.dc.html. A section is shown on the storefront when
    -- it is visible AND has products; the emptiness half is derived, not stored,
    -- because storing it would be a second source of truth for a COUNT.
    is_visible  boolean     NOT NULL DEFAULT true,
    position    integer     NOT NULL DEFAULT 0,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT categories_name_present CHECK (btrim(name) <> ''),
    CONSTRAINT categories_id_store_key UNIQUE (id, store_id)
);

COMMENT ON TABLE categories IS
    'A grouping on the storefront. The word for it comes from the industry template: Sections, Collections, Aisles, Rooms.';

-- One name per store, case-insensitively: two sections called "Drinks" and
-- "drinks" would be a merchant mistake the storefront cannot render sensibly.
CREATE UNIQUE INDEX categories_store_name_key ON categories (store_id, lower(btrim(name)));

-- Serves: the storefront's category rail, in the merchant's order.
CREATE INDEX categories_store_position_idx ON categories (store_id, position, id) WHERE is_visible;

CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE product_categories (
    product_id  uuid    NOT NULL,
    category_id uuid    NOT NULL,
    store_id    uuid    NOT NULL,

    -- Where this product sits within this section, which differs per section.
    position    integer NOT NULL DEFAULT 0,

    PRIMARY KEY (product_id, category_id),

    -- Both sides carry store_id and both composite keys check it, so a product
    -- cannot be filed under another store's section.
    FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id) ON DELETE CASCADE,
    FOREIGN KEY (category_id, store_id) REFERENCES categories (id, store_id) ON DELETE CASCADE
);

COMMENT ON TABLE product_categories IS
    'Which sections a product appears in. Deleting a section removes these rows and keeps the products — Categories.dc.html: "Its 6 products stay in your catalog."';

-- Serves: listing one section's products in order. The primary key already serves
-- the other direction (this product's sections).
CREATE INDEX product_categories_category_idx ON product_categories (category_id, position);


-- =============================================================================
-- 3. Option groups and their values
-- =============================================================================
-- Was `add_ons`, which conflated three things: a store-wide extra, a per-product
-- size, and the stock of both.
--
-- A group belongs to a STORE and is attached to products through a join, so a
-- store-wide group — "Gift wrap", "Extras" — is simply one attached to several
-- products. There is no `scope` column: how a group is managed is a UI question,
-- and the Options panel in AddProduct is still undesigned, so a column encoding
-- that distinction now would be a guess.

CREATE TABLE option_groups (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id    uuid        NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    name        text        NOT NULL,

    -- 'one'     pick exactly one — a dimension of the variant matrix
    -- 'several' pick any number — priced add-ons on the line, NOT a dimension
    --
    -- The same two words the industry template's attribute presets use, so a
    -- preset can create a group directly.
    select_mode text        NOT NULL,

    -- A required 'one' group must be chosen before adding to the cart; Size is,
    -- Spice level might not be.
    is_required boolean     NOT NULL DEFAULT true,
    position    integer     NOT NULL DEFAULT 0,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT option_groups_name_present CHECK (btrim(name) <> ''),
    CONSTRAINT option_groups_select_mode_values CHECK (select_mode IN ('one', 'several')),

    -- 'several' groups are optional by definition: choosing none is a valid
    -- answer to "any extras?".
    CONSTRAINT option_groups_several_not_required
        CHECK (select_mode = 'one' OR is_required = false),

    CONSTRAINT option_groups_id_store_key UNIQUE (id, store_id)
);

COMMENT ON TABLE option_groups IS
    'A choice offered on a product: Size, Colour, Spice level, Extras. select_mode = one makes it a variant dimension; several makes it priced add-ons on the line.';

CREATE UNIQUE INDEX option_groups_store_name_key ON option_groups (store_id, lower(btrim(name)));

CREATE TRIGGER option_groups_set_updated_at BEFORE UPDATE ON option_groups
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE option_values (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    option_group_id uuid          NOT NULL,
    store_id        uuid          NOT NULL,

    label           text          NOT NULL,

    -- What choosing this adds to the price. Cheese +500 in AddProduct. Zero for a
    -- dimension like Size, where the variant price comes from the base.
    price_delta     numeric(12,2) NOT NULL DEFAULT 0,

    -- Sold out rather than deleted: Industries.dc.html strikes through unavailable
    -- combinations instead of hiding them, so the customer can see the size exists.
    is_available    boolean       NOT NULL DEFAULT true,
    position        integer       NOT NULL DEFAULT 0,

    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT option_values_label_present CHECK (btrim(label) <> ''),
    CONSTRAINT option_values_price_delta_not_negative CHECK (price_delta >= 0),

    FOREIGN KEY (option_group_id, store_id) REFERENCES option_groups (id, store_id) ON DELETE CASCADE,
    CONSTRAINT option_values_id_store_key UNIQUE (id, store_id),
    CONSTRAINT option_values_id_group_key UNIQUE (id, option_group_id)
);

COMMENT ON TABLE option_values IS
    'One choice within a group: M, Black, Hot, Cheese. price_delta is what choosing it adds.';

CREATE UNIQUE INDEX option_values_group_label_key ON option_values (option_group_id, lower(btrim(label)));

-- Serves: rendering a group's values in the merchant's order, on every product page.
CREATE INDEX option_values_group_position_idx ON option_values (option_group_id, position, id);

CREATE TRIGGER option_values_set_updated_at BEFORE UPDATE ON option_values
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE product_option_groups (
    product_id      uuid    NOT NULL,
    option_group_id uuid    NOT NULL,
    store_id        uuid    NOT NULL,
    position        integer NOT NULL DEFAULT 0,

    PRIMARY KEY (product_id, option_group_id),

    FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id) ON DELETE CASCADE,
    FOREIGN KEY (option_group_id, store_id) REFERENCES option_groups (id, store_id) ON DELETE RESTRICT
);

COMMENT ON TABLE product_option_groups IS
    'Which option groups a product offers. A store-wide group attached here to two products is what "shared option group" means — there is no copy.';

-- Serves: "which products use this group", which the Options panel needs before
-- letting a merchant change or remove one.
CREATE INDEX product_option_groups_group_idx ON product_option_groups (option_group_id);


-- =============================================================================
-- 4. product_variants — the table the old schema could not express
-- =============================================================================
-- `add_ons` could say "M has 4 left" but never "Black/M has 4 left", because size
-- and colour were separate rows with separate stock. This is that table.

CREATE TABLE product_variants (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id     uuid        NOT NULL,
    store_id       uuid        NOT NULL,

    -- Generated from the option values by AddProduct (TS-BLK-M) and editable.
    -- Unique per store, not globally: two merchants may both use "TS-BLK-M".
    sku            text,

    -- Only meaningful when the product tracks stock. Enforced below.
    stock_quantity integer,

    -- Switched off by the merchant, independently of the count. A variant can be
    -- in stock and withdrawn, or out of stock and still listed struck through.
    is_available   boolean     NOT NULL DEFAULT true,

    -- Exactly one per product: the row a product with no "pick one" group sells
    -- through, so that stock always lives in one place.
    is_default     boolean     NOT NULL DEFAULT false,

    position       integer     NOT NULL DEFAULT 0,

    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT product_variants_stock_not_negative
        CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
    CONSTRAINT product_variants_sku_present CHECK (sku IS NULL OR btrim(sku) <> ''),

    FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id) ON DELETE CASCADE,
    CONSTRAINT product_variants_id_store_key UNIQUE (id, store_id),
    CONSTRAINT product_variants_id_product_key UNIQUE (id, product_id)
);

COMMENT ON TABLE product_variants IS
    'One purchasable combination. Every product has at least one — a product with no single-select options has exactly one default variant, so stock and SKU always live here and reserve_stock has one code path.';
COMMENT ON COLUMN product_variants.stock_quantity IS
    'NULL when the product does not track stock. Never both NULL and tracked: see product_variants_stock_matches_tracking.';

CREATE UNIQUE INDEX product_variants_store_sku_key
    ON product_variants (store_id, lower(btrim(sku))) WHERE sku IS NOT NULL;

-- Exactly one default per product.
CREATE UNIQUE INDEX product_variants_one_default_per_product
    ON product_variants (product_id) WHERE is_default;

-- Serves: a product page, listing its variants in order.
CREATE INDEX product_variants_product_position_idx ON product_variants (product_id, position, id);

-- Serves: the low-stock list on the merchant dashboard — "7 products are running
-- low" in States.dc.html. Partial, because a variant that does not track stock
-- can never be low.
CREATE INDEX product_variants_low_stock_idx
    ON product_variants (store_id, stock_quantity) WHERE stock_quantity IS NOT NULL;

CREATE TRIGGER product_variants_set_updated_at BEFORE UPDATE ON product_variants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE product_variant_values (
    variant_id      uuid NOT NULL,
    option_group_id uuid NOT NULL,
    option_value_id uuid NOT NULL,
    product_id      uuid NOT NULL,

    -- One value per group per variant: "Black/M", never "Black/White/M".
    PRIMARY KEY (variant_id, option_group_id),

    FOREIGN KEY (variant_id, product_id) REFERENCES product_variants (id, product_id) ON DELETE CASCADE,

    -- The value must belong to the group it is filed under. Without this pair of
    -- columns being keyed together, a variant could claim Size = Black.
    FOREIGN KEY (option_value_id, option_group_id) REFERENCES option_values (id, option_group_id) ON DELETE RESTRICT
);

COMMENT ON TABLE product_variant_values IS
    'The combination a variant is: one option value per single-select group. Integrity of the whole matrix is checked at commit by product_variant_matrix_check.';

-- Serves: finding the variant a customer selected, and "which variants use this
-- value" before a merchant removes one.
CREATE INDEX product_variant_values_value_idx ON product_variant_values (option_value_id);


-- =============================================================================
-- 5. Matrix integrity, checked at commit
-- =============================================================================
-- Three things have to be true of a product's variants, and none can be a column
-- constraint because each spans rows:
--
--   1. no variant names a group the product does not offer;
--   2. a variant names only single-select values — a "pick several" group is
--      priced per line, not a dimension;
--   3. every variant names exactly one value from each of the product's
--      single-select groups — no half-built combination;
--   4. no two variants of a product are the same combination, which would split
--      one combination's stock across two rows;
--   5. a product that tracks stock has a count on every variant, and one that
--      does not has none.
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger is the right tool: a variant
-- is inserted before its values, so a per-statement check would see every matrix
-- half-built. This runs once, at commit, on the products actually touched.

CREATE FUNCTION product_variant_matrix_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_product uuid;
    v_detail  text;
BEGIN
    v_product := COALESCE(NEW.product_id, OLD.product_id);

    -- The product may have been deleted in the same transaction.
    IF NOT EXISTS (SELECT 1 FROM products WHERE id = v_product) THEN
        RETURN NULL;
    END IF;

    -- 1. A variant may not name a group the product does not offer.
    --
    -- Checked BEFORE the count below, because this is the cause and the count
    -- mismatch is merely its symptom — reporting the symptom first sent readers
    -- looking for a missing choice when the real problem was an extra one.
    SELECT string_agg(DISTINCT pv.option_group_id::text, ', ') INTO v_detail
      FROM product_variant_values pv
      JOIN product_variants v ON v.id = pv.variant_id
     WHERE v.product_id = v_product
       AND NOT EXISTS (
         SELECT 1 FROM product_option_groups pog
          WHERE pog.product_id = v_product AND pog.option_group_id = pv.option_group_id
       );
    IF v_detail IS NOT NULL THEN
        RAISE EXCEPTION 'variant of product % names option group(s) % that the product does not offer', v_product, v_detail;
    END IF;

    -- 2. A variant is a combination of single-select choices ONLY.
    --
    -- Naming a 'several' group here is the mistake this catches: Extras are priced
    -- per line at checkout, not a dimension of the matrix, so a variant that names
    -- Cheese would multiply the matrix by the add-ons and split their stock. The
    -- count check below would refuse it too, but it would report a missing choice
    -- when the problem is a choice that does not belong.
    SELECT string_agg(DISTINCT g.name, ', ') INTO v_detail
      FROM product_variant_values pv
      JOIN product_variants v ON v.id = pv.variant_id
      JOIN option_groups g ON g.id = pv.option_group_id
     WHERE v.product_id = v_product
       AND g.select_mode <> 'one';
    IF v_detail IS NOT NULL THEN
        RAISE EXCEPTION 'variant of product % names group(s) %, which are line add-ons and not variant dimensions', v_product, v_detail
            USING HINT = 'Only "pick one" groups form the variant matrix. A "pick several" group is chosen per line at checkout.';
    END IF;

    -- 3. Each variant covers exactly the single-select groups the product offers.
    SELECT string_agg(x.id::text, ', ') INTO v_detail
      FROM (
        SELECT v.id
          FROM product_variants v
         WHERE v.product_id = v_product
           AND (
             SELECT count(*) FROM product_variant_values pv
              WHERE pv.variant_id = v.id
           ) <> (
             SELECT count(*) FROM product_option_groups pog
              JOIN option_groups g ON g.id = pog.option_group_id
             WHERE pog.product_id = v_product AND g.select_mode = 'one'
           )
      ) x;
    IF v_detail IS NOT NULL THEN
        RAISE EXCEPTION 'variant(s) % do not name one value from each single-select option group of product %', v_detail, v_product
            USING HINT = 'A variant is one full combination. Add the missing choice, or remove the group from the product.';
    END IF;

    -- 4. No duplicate combinations.
    IF EXISTS (
        SELECT 1 FROM (
            SELECT array_agg(pv.option_value_id ORDER BY pv.option_value_id) AS combo
              FROM product_variants v
              LEFT JOIN product_variant_values pv ON pv.variant_id = v.id
             WHERE v.product_id = v_product
             GROUP BY v.id
        ) c
        GROUP BY c.combo
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'product % has two variants with the same combination', v_product
            USING HINT = 'One combination is one row, or its stock is split between two.';
    END IF;

    -- 5. Stock tracking is all or nothing across a product's variants.
    SELECT string_agg(v.id::text, ', ') INTO v_detail
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
     WHERE v.product_id = v_product
       AND (p.track_stock AND v.stock_quantity IS NULL);
    IF v_detail IS NOT NULL THEN
        RAISE EXCEPTION 'product % tracks stock, so variant(s) % need a count', v_product, v_detail
            USING HINT = 'Set stock_quantity, or turn track_stock off for the product.';
    END IF;

    SELECT string_agg(v.id::text, ', ') INTO v_detail
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
     WHERE v.product_id = v_product
       AND (NOT p.track_stock AND v.stock_quantity IS NOT NULL);
    IF v_detail IS NOT NULL THEN
        RAISE EXCEPTION 'product % does not track stock, so variant(s) % must not carry a count', v_product, v_detail
            USING HINT = 'A count nobody maintains is worse than no count. Turn track_stock on, or clear stock_quantity.';
    END IF;

    RETURN NULL;
END;
$init$;

CREATE CONSTRAINT TRIGGER product_variants_matrix_check
    AFTER INSERT OR UPDATE OR DELETE ON product_variants
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION product_variant_matrix_check();

CREATE CONSTRAINT TRIGGER product_variant_values_matrix_check
    AFTER INSERT OR UPDATE OR DELETE ON product_variant_values
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION product_variant_matrix_check();


-- =============================================================================
-- 6. Product flags
-- =============================================================================
-- The registry is in V002. A product may only carry a flag its store's industry
-- template offers: "prescription required" on a burger is not a feature, it is a
-- bug, and components would render an Rx badge for it.

CREATE TABLE product_product_flags (
    product_id uuid NOT NULL,
    store_id   uuid NOT NULL,
    flag_key   text NOT NULL REFERENCES product_flags (key) ON DELETE RESTRICT,

    PRIMARY KEY (product_id, flag_key),
    FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id) ON DELETE CASCADE
);

COMMENT ON TABLE product_product_flags IS
    'Flags on one product. Constrained to the flags the store''s pinned industry template offers — see product_flag_offered_by_template.';

CREATE FUNCTION product_flag_offered_by_template() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_template uuid;
    v_version  integer;
BEGIN
    -- A BEFORE trigger runs before the foreign key, so a flag that does not exist
    -- at all would be reported here as "your template does not offer it" — true but
    -- misleading. Let product_product_flags_flag_key_fkey name it.
    IF NOT EXISTS (SELECT 1 FROM product_flags WHERE key = NEW.flag_key) THEN
        RETURN NEW;
    END IF;

    SELECT s.industry_template_id, s.industry_template_version
      INTO v_template, v_version
      FROM stores s WHERE s.id = NEW.store_id;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'store % has no industry template, so it offers no product flags', NEW.store_id
            USING HINT = 'Pin the store to a published template first.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM industry_template_version_product_flags f
         WHERE f.template_id = v_template AND f.version = v_version AND f.flag_key = NEW.flag_key
    ) THEN
        RAISE EXCEPTION 'the industry template of store % does not offer the product flag %', NEW.store_id, NEW.flag_key
            USING HINT = 'A flag the template does not offer would render a badge for a feature this store does not have.';
    END IF;

    RETURN NEW;
END;
$init$;

CREATE TRIGGER product_flags_offered BEFORE INSERT OR UPDATE ON product_product_flags
    FOR EACH ROW EXECUTE FUNCTION product_flag_offered_by_template();


-- =============================================================================
-- 7. carts — server-side, because §2.5 allows no browser storage
-- =============================================================================
-- States.dc.html promises two things: a cart survives losing the network, and it
-- is "kept for 7 days". Neither can rest on localStorage, which §2.5 rules out as
-- a source of truth and which a browser with site data blocked does not have at
-- all. So the cart lives here, keyed either by the signed-in customer or by an
-- opaque anonymous session cookie.
--
-- NO PRICES ARE STORED. States.dc.html: "Prices are re-checked at checkout; any
-- change is shown before paying." A price copied into the cart would be a second
-- source of truth that goes stale silently.

CREATE TABLE carts (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id             uuid        NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    -- Exactly one of these. A signed-in customer's cart follows the account; an
    -- anonymous one follows a cookie the server issued.
    user_id              uuid        REFERENCES users (id) ON DELETE CASCADE,
    anonymous_session_id text,

    expires_at           timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT carts_one_owner CHECK (
        (user_id IS NOT NULL AND anonymous_session_id IS NULL)
     OR (user_id IS NULL AND anonymous_session_id IS NOT NULL)
    ),
    -- Long enough not to be guessable, since holding it is holding the cart.
    CONSTRAINT carts_session_id_length
        CHECK (anonymous_session_id IS NULL OR char_length(anonymous_session_id) BETWEEN 20 AND 128),

    CONSTRAINT carts_id_store_key UNIQUE (id, store_id)
);

COMMENT ON TABLE carts IS
    'A cart, server-side. One per customer per store, or one per anonymous session per store. Survives a browser with storage disabled, which is the point.';
COMMENT ON COLUMN carts.expires_at IS
    'Seven days, as States.dc.html promises. A sweep deletes past this; nothing reads an expired cart.';

-- One cart per person per store, whichever kind of person.
CREATE UNIQUE INDEX carts_store_user_key ON carts (store_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX carts_store_session_key
    ON carts (store_id, anonymous_session_id) WHERE anonymous_session_id IS NOT NULL;

-- Serves: the expiry sweep.
CREATE INDEX carts_expires_at_idx ON carts (expires_at);

CREATE TRIGGER carts_set_updated_at BEFORE UPDATE ON carts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE cart_items (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id    uuid        NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
    variant_id uuid        NOT NULL,
    store_id   uuid        NOT NULL,

    quantity   integer     NOT NULL DEFAULT 1,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT cart_items_quantity_positive CHECK (quantity > 0),

    -- The variant must belong to the same store as the cart.
    FOREIGN KEY (variant_id, store_id) REFERENCES product_variants (id, store_id) ON DELETE RESTRICT,
    CONSTRAINT cart_items_id_cart_key UNIQUE (id, cart_id)
);

COMMENT ON TABLE cart_items IS
    'One line. A variant, a quantity, and any "pick several" option values chosen for this line — two lines of the same burger with different extras are two lines.';

-- Serves: reading a cart.
CREATE INDEX cart_items_cart_idx ON cart_items (cart_id, created_at);

CREATE TRIGGER cart_items_set_updated_at BEFORE UPDATE ON cart_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE cart_item_option_values (
    cart_item_id    uuid NOT NULL,
    option_value_id uuid NOT NULL,
    cart_id         uuid NOT NULL,

    PRIMARY KEY (cart_item_id, option_value_id),

    FOREIGN KEY (cart_item_id, cart_id) REFERENCES cart_items (id, cart_id) ON DELETE CASCADE,
    FOREIGN KEY (option_value_id) REFERENCES option_values (id) ON DELETE RESTRICT
);

COMMENT ON TABLE cart_item_option_values IS
    'The "pick several" choices on one line — Cheese and Extra sauce. The single-select choices are already the variant, so they are not repeated here.';
