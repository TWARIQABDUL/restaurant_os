-- =============================================================================
-- V027 — a store's design: layout, homepage sections and logo, draft and published
-- =============================================================================
-- Milestone 25 of docs/migration/04-implementation-plan.md: `Customize`, `ThemeStudio`, `Settings`.
--
-- THE TWO STUDIOS EDIT TWO THINGS THAT ARE NOT THE SAME THING. ThemeStudio's eight inputs compile into a PALETTE
-- (V015's store_themes: twelve colours, gated on readability). Customize edits what ISN'T a colour: whether products
-- are a grid or a list, which homepage sections are shown, and the logo. Widening store_themes for them would have
-- put layout choices behind a WCAG gate that has nothing to say about them, and made every layout change republish a
-- palette — so they are a table of their own, with the same two states.
--
-- DRAFT AND PUBLISHED, like the theme, because Customize says so itself: "Changes are saved as a draft", and Publish is
-- one button for the whole look. The publish route writes both tables in one transaction, so a store never has a new
-- palette with the old layout or the reverse.
--
-- THE PRODUCTS SECTION CANNOT BE SWITCHED OFF. The board draws it locked, and `show_products` is not a column: a
-- storefront with no products is not a design choice, and a column that could say so is a column somebody will set.
--
-- THE LOGO IS A PATH THIS SERVER ISSUED, never a URL. `/api/media/…` is what the upload endpoint (milestone 22) returns;
-- accepting any URL here would let a store point its header at a tracking pixel, and the CHECK says so at the column.
-- =============================================================================

CREATE TABLE store_designs (
    store_id           uuid        NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
    status             text        NOT NULL,

    product_layout     text        NOT NULL DEFAULT 'grid',
    show_promo         boolean     NOT NULL DEFAULT true,
    show_categories    boolean     NOT NULL DEFAULT true,
    show_featured      boolean     NOT NULL DEFAULT true,
    show_info          boolean     NOT NULL DEFAULT true,
    logo_url           text,

    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    published_at       timestamptz,

    PRIMARY KEY (store_id, status),

    CONSTRAINT store_designs_status_values CHECK (status IN ('draft', 'published')),
    CONSTRAINT store_designs_layout_values CHECK (product_layout IN ('grid', 'list')),
    CONSTRAINT store_designs_published_at_agrees CHECK ((status = 'published') = (published_at IS NOT NULL)),
    CONSTRAINT store_designs_logo_is_ours CHECK (logo_url IS NULL OR (logo_url LIKE '/api/media/%' AND length(logo_url) <= 300))
);

COMMENT ON TABLE store_designs IS
    'What Customize edits: product layout, which homepage sections show, the logo. Not colours — those are store_themes. Draft and published, written together by one publish.';

CREATE TRIGGER store_designs_set_updated_at BEFORE UPDATE ON store_designs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
