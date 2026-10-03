-- =============================================================================
-- V024 — the merchant's catalogue: private option groups and product photos
-- =============================================================================
-- Milestone 22 of docs/migration/04-implementation-plan.md: `Products`,
-- `AddProduct` and `Categories`.
--
-- TWO THINGS THE BOARDS DRAW AND THE SCHEMA COULD NOT HOLD.
--
-- 1. AN OPTION GROUP THAT BELONGS TO ONE PRODUCT. V003 made `option_groups`
--    unique per store by name, because it was written for the group the seed
--    shares ("Extras", on two burgers and a wrap). But AddProduct's editor
--    creates "Size" INSIDE a product: Everyday T-Shirt has S/M/L/XL and a pair
--    of jeans would have 28/30/32, and both are called Size. Under the old
--    index the second product could not be saved; sharing one "Size" group
--    instead would put 28 on a T-shirt. So a group now has an optional owner:
--
--        product_id NULL      shared across the store — the index it always had
--        product_id = <uuid>  private to that product — unique within it only
--
--    A private group is deleted with its product (cascade), and cannot be
--    attached to any other product: `product_option_groups` is held to that by
--    a trigger, because a composite FK cannot express "NULL or equal".
--
-- 2. MORE THAN ONE PHOTO. `products.cover_image_url` is one column and the
--    editor has "Add photos … The first photo is the cover." `product_images`
--    holds the set, in order, and a trigger keeps the cover equal to the first
--    — so the storefront's existing reads need not change and the two can
--    never disagree.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT ADD: functions. The save of a whole
-- product (information, photos, options, variants, categories) is one
-- transaction in `repositories/products.ts` rather than one plpgsql function:
-- V003's matrix rules are DEFERRED constraint triggers precisely so an
-- ordinary transaction can build a product up in any order and be checked once
-- at COMMIT, and a function would only re-spell the same writes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Private option groups
-- ---------------------------------------------------------------------------

ALTER TABLE option_groups
    ADD COLUMN product_id uuid;

ALTER TABLE option_groups
    ADD CONSTRAINT option_groups_private_product_fkey
        FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id) ON DELETE CASCADE;

COMMENT ON COLUMN option_groups.product_id IS
    'NULL: shared by the store, attachable to any of its products. Set: private to that product, created by AddProduct''s editor and deleted with it.';

DROP INDEX option_groups_store_name_key;

CREATE UNIQUE INDEX option_groups_shared_name_key
    ON option_groups (store_id, lower(btrim(name))) WHERE product_id IS NULL;

CREATE UNIQUE INDEX option_groups_private_name_key
    ON option_groups (product_id, lower(btrim(name))) WHERE product_id IS NOT NULL;

-- Serves: the editor loading one product's own groups, and the cascade above.
CREATE INDEX option_groups_product_idx ON option_groups (product_id) WHERE product_id IS NOT NULL;

CREATE FUNCTION option_group_private_to_owner() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_owner uuid;
BEGIN
    SELECT g.product_id INTO v_owner FROM option_groups g WHERE g.id = NEW.option_group_id;

    IF v_owner IS NOT NULL AND v_owner <> NEW.product_id THEN
        RAISE EXCEPTION 'option group % belongs to product %, so product % cannot offer it', NEW.option_group_id, v_owner, NEW.product_id
            USING HINT = 'A group made inside one product''s editor is private to it. Make it a shared group to use it on several products.';
    END IF;

    RETURN NEW;
END;
$init$;

COMMENT ON FUNCTION option_group_private_to_owner() IS
    'A private option group may be attached only to the product that owns it. Not a composite FK: product_id is nullable on the group, and "NULL or equal" is not something a foreign key says.';

CREATE TRIGGER product_option_groups_private_only BEFORE INSERT OR UPDATE ON product_option_groups
    FOR EACH ROW EXECUTE FUNCTION option_group_private_to_owner();

-- ---------------------------------------------------------------------------
-- 2. Product photos
-- ---------------------------------------------------------------------------

CREATE TABLE product_images (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id  uuid        NOT NULL,
    store_id    uuid        NOT NULL,

    -- A path the image store resolves, not a vendor URL: '/api/media/<store>/<key>' today. Keeping it a
    -- string the storage layer owns is what lets the bucket move (Part 9's open decision) without a
    -- migration of every row.
    url         text        NOT NULL,

    position    integer     NOT NULL DEFAULT 0,

    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT product_images_url_present CHECK (btrim(url) <> ''),

    FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id) ON DELETE CASCADE
);

COMMENT ON TABLE product_images IS
    'A product''s photos in order. The first is the cover — products.cover_image_url is kept equal to it by a trigger.';

-- Serves: the editor loading one product's photos, in order; and the cover trigger.
-- A constraint rather than a bare index, because only a constraint can be DEFERRABLE: reordering two photos
-- swaps their positions, which is momentarily a duplicate.
ALTER TABLE product_images
    ADD CONSTRAINT product_images_product_position_key UNIQUE (product_id, position)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION product_images_sync_cover() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
DECLARE
    v_product uuid;
BEGIN
    v_product := COALESCE(NEW.product_id, OLD.product_id);

    UPDATE products p
       SET cover_image_url = (
             SELECT i.url FROM product_images i
              WHERE i.product_id = v_product
              ORDER BY i.position, i.id
              LIMIT 1
           )
     WHERE p.id = v_product
       AND p.cover_image_url IS DISTINCT FROM (
             SELECT i.url FROM product_images i
              WHERE i.product_id = v_product
              ORDER BY i.position, i.id
              LIMIT 1
           );

    RETURN NULL;
END;
$init$;

COMMENT ON FUNCTION product_images_sync_cover() IS
    'products.cover_image_url is the first photo. A trigger rather than application code, so the storefront''s card and the editor''s first thumbnail cannot show two different pictures.';

CREATE TRIGGER product_images_cover AFTER INSERT OR UPDATE OR DELETE ON product_images
    FOR EACH ROW EXECUTE FUNCTION product_images_sync_cover();

-- At most eight, matching the editor's grid — and a cap the database holds, so a script cannot attach
-- four thousand pictures to one product.
CREATE FUNCTION product_images_limit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $init$
BEGIN
    IF (SELECT count(*) FROM product_images WHERE product_id = NEW.product_id) > 8 THEN
        RAISE EXCEPTION 'product % already has 8 photos', NEW.product_id
            USING HINT = 'Remove one before adding another.';
    END IF;
    RETURN NULL;
END;
$init$;

CREATE CONSTRAINT TRIGGER product_images_at_most_eight
    AFTER INSERT ON product_images
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION product_images_limit();

-- ---------------------------------------------------------------------------
-- 3. The Products list's own queries
-- ---------------------------------------------------------------------------
-- Serves: the Products screen's search by name, a store's whole catalogue newest first, and the
-- "Drafts" tab. products_store_created_idx already serves "Newest"; the others are below.

-- Serves: the list ordered by merchant position across ALL statuses. V003's products_store_position_idx
-- is partial (status = 'active') for the storefront, so the console's unfiltered list cannot use it.
CREATE INDEX products_store_position_all_idx ON products (store_id, position, id);
