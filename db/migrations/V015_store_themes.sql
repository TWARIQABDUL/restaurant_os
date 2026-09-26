-- =============================================================================
-- V015 — a store's look, draft and published
-- =============================================================================
-- Milestone 13 of docs/migration/04-implementation-plan.md.
--
-- ThemeStudio's promise, which this file exists to make true: "no store can publish something
-- unreadable." §3 says how — "The API must re-run the compiler on publish and reject any token
-- set that is not its own output" — and that is necessary but not sufficient, because it is a
-- rule in application code. The database can do better.
--
-- WHAT IS ENFORCED HERE, DECLARATIVELY. Postgres can compute a WCAG contrast ratio: it is
-- arithmetic over six hex digits. So a PUBLISHED theme whose body text, muted text, button text,
-- badge text or banner text falls below 4.5:1 is refused at the column, by any writer — the API,
-- a later migration, somebody at a psql prompt.
--
-- THIS IS NOT A SECOND COMPILER, and the distinction matters. §3 warns that duplicating the
-- theme engine is "the likeliest source of 'the preview doesn't match the live store'". The
-- functions below do not DERIVE a palette from eight inputs; they CHECK a palette that arrives.
-- Derivation stays in packages/core, in one place, and the database independently refuses a
-- result that is unreadable however it was produced.
--
-- DOUBLE PRECISION, not numeric, throughout the contrast maths. Both Postgres' `power(double,
-- double)` and JavaScript's `Math.pow` are IEEE 754 doubles over the same C library, so the two
-- implementations agree bit for bit. With `numeric` they would differ in the last places, and a
-- theme the compiler called publishable at 4.50000001 could be refused here — a false rejection
-- that would look like a bug in the studio.
--
-- WHAT IS STILL THE API'S JOB. That the stored colours are the compiler's OWN output for the
-- stored inputs. No constraint can know that without re-deriving, so it is checked at the
-- endpoint (routes/storeTheme.ts) and tested there. The database's guarantee is weaker and
-- independent: whatever the numbers are, they are readable.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Hex colours, and contrast
-- -----------------------------------------------------------------------------

CREATE FUNCTION is_hex_color(value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog
AS $init$
    -- Upper case only, six digits, no shorthand. The compiler emits exactly this form
    -- (packages/core's toHex), so accepting '#abc' here would accept something the compiler
    -- never produces and the client's own validator would then have to widen for.
    SELECT value ~ '^#[0-9A-F]{6}$';
$init$;

COMMENT ON FUNCTION is_hex_color(text) IS
    'The one form a compiled theme token takes: #RRGGBB, upper case. Called from CHECK constraints so a malformed colour is refused at the column.';

CREATE FUNCTION wcag_channel(value double precision) RETURNS double precision
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog
AS $init$
    -- The sRGB→linear transfer. THE THRESHOLD IS 0.03928, which is WCAG 2.0's; the current text
    -- says 0.04045. packages/core uses 0.03928 because the design canvas's own compiler does,
    -- and the two must agree — a disagreement in the fourth decimal is enough to make this
    -- constraint refuse a theme the compiler approved.
    SELECT CASE WHEN value <= 0.03928::double precision
                THEN value / 12.92::double precision
                ELSE power((value + 0.055::double precision) / 1.055::double precision,
                           2.4::double precision)
           END;
$init$;

CREATE FUNCTION wcag_luminance(color text) RETURNS double precision
    LANGUAGE sql IMMUTABLE
    -- public as well as pg_catalog, because this one CALLS wcag_channel. V002's validators are
    -- self-contained and get away with pg_catalog alone; copying that here made the function
    -- unable to see the one directly above it.
    SET search_path = pg_catalog, public
AS $init$
    -- Every cast is explicit. Without the double-precision cast on 255, int / numeric gives
    -- numeric and wcag_channel(numeric) does not exist — which is how this migration failed the
    -- first time it was applied, and a silent numeric path is exactly what the header rules out.
    SELECT 0.2126::double precision * wcag_channel((('x' || substr(color, 2, 2))::bit(8)::int)::double precision / 255.0::double precision)
         + 0.7152::double precision * wcag_channel((('x' || substr(color, 4, 2))::bit(8)::int)::double precision / 255.0::double precision)
         + 0.0722::double precision * wcag_channel((('x' || substr(color, 6, 2))::bit(8)::int)::double precision / 255.0::double precision);
$init$;

CREATE FUNCTION wcag_contrast(a text, b text) RETURNS double precision
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog, public
AS $init$
    SELECT (greatest(wcag_luminance(a), wcag_luminance(b)) + 0.05::double precision)
         / (least(wcag_luminance(a), wcag_luminance(b)) + 0.05::double precision);
$init$;

COMMENT ON FUNCTION wcag_contrast(text, text) IS
    'WCAG contrast ratio, 1 to 21, in double precision so it agrees bit for bit with packages/core. The CHECK constraints on store_themes are built from it.';


-- -----------------------------------------------------------------------------
-- 2. store_themes
-- -----------------------------------------------------------------------------
-- One draft and one published row per store, which is what the primary key says. The same shape
-- V002 gives a template's versions, and for the same reason: ThemeStudio edits "the" draft, so
-- two would make "Save draft" ambiguous.
--
-- NO VERSION HISTORY, deliberately. A template version is pinned by stores and must therefore be
-- immutable and numbered (V002). A store's own theme is pinned by nobody: ThemeStudio's button
-- reads "Apply" and the board promises the new look is live. Republishing overwrites.

CREATE TABLE store_themes (
    store_id            uuid        NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
    status              text        NOT NULL,

    -- --- the eight inputs the merchant chose --------------------------------
    -- Stored so the studio can reopen what they picked, and so publish can re-derive from them.
    -- A palette without its inputs could be checked but never edited again.
    input_brand         text        NOT NULL,
    -- NULL means "let Vendlyfy pick", which is the studio's accMode: the harmony then decides.
    input_accent        text,
    input_harmony       text        NOT NULL,
    input_mood          text        NOT NULL,
    input_shape         text        NOT NULL,
    input_heading_font  text        NOT NULL,
    input_card_treatment text       NOT NULL,
    input_hero          text        NOT NULL,

    -- --- the twelve colours the compiler derived ----------------------------
    -- Prefixed, uniformly, because `text`, `primary` and `border` are all awkward or reserved as
    -- bare column names and a mixed convention is worse than a prefix.
    color_bg            text        NOT NULL,
    color_surface       text        NOT NULL,
    color_text          text        NOT NULL,
    color_muted         text        NOT NULL,
    color_border        text        NOT NULL,
    color_primary       text        NOT NULL,
    color_on_primary    text        NOT NULL,
    color_accent        text        NOT NULL,
    color_on_accent     text        NOT NULL,
    color_tint          text        NOT NULL,
    color_hero_bg       text        NOT NULL,
    color_hero_text     text        NOT NULL,

    -- Derived by the compiler, stored because components need them and must not re-derive:
    -- dark decides shadows and image treatments, outline decides whether a button gets a border.
    is_dark             boolean     NOT NULL,
    needs_outline       boolean     NOT NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    published_at        timestamptz,

    PRIMARY KEY (store_id, status),

    CONSTRAINT store_themes_status_values CHECK (status IN ('draft', 'published')),
    CONSTRAINT store_themes_published_at_agrees
        CHECK ((status = 'published') = (published_at IS NOT NULL)),

    -- The input enums, from ThemeStudio's own controls. A value outside them would compile to
    -- the default silently, which is the class of failure V002 refuses with foreign keys.
    CONSTRAINT store_themes_harmony_values
        CHECK (input_harmony IN ('complementary', 'analogous', 'split', 'mono')),
    CONSTRAINT store_themes_mood_values CHECK (input_mood IN ('light', 'warm', 'dark')),
    CONSTRAINT store_themes_shape_values CHECK (input_shape IN ('sharp', 'soft', 'round')),
    CONSTRAINT store_themes_heading_font_values
        CHECK (input_heading_font IN ('modern', 'editorial', 'sport', 'classic')),
    CONSTRAINT store_themes_card_treatment_values
        CHECK (input_card_treatment IN ('flat', 'outlined', 'shadow')),
    CONSTRAINT store_themes_hero_values CHECK (input_hero IN ('soft', 'fill')),

    CONSTRAINT store_themes_input_brand_hex CHECK (is_hex_color(input_brand)),
    CONSTRAINT store_themes_input_accent_hex
        CHECK (input_accent IS NULL OR is_hex_color(input_accent)),

    CONSTRAINT store_themes_color_bg_hex CHECK (is_hex_color(color_bg)),
    CONSTRAINT store_themes_color_surface_hex CHECK (is_hex_color(color_surface)),
    CONSTRAINT store_themes_color_text_hex CHECK (is_hex_color(color_text)),
    CONSTRAINT store_themes_color_muted_hex CHECK (is_hex_color(color_muted)),
    CONSTRAINT store_themes_color_border_hex CHECK (is_hex_color(color_border)),
    CONSTRAINT store_themes_color_primary_hex CHECK (is_hex_color(color_primary)),
    CONSTRAINT store_themes_color_on_primary_hex CHECK (is_hex_color(color_on_primary)),
    CONSTRAINT store_themes_color_accent_hex CHECK (is_hex_color(color_accent)),
    CONSTRAINT store_themes_color_on_accent_hex CHECK (is_hex_color(color_on_accent)),
    CONSTRAINT store_themes_color_tint_hex CHECK (is_hex_color(color_tint)),
    CONSTRAINT store_themes_color_hero_bg_hex CHECK (is_hex_color(color_hero_bg)),
    CONSTRAINT store_themes_color_hero_text_hex CHECK (is_hex_color(color_hero_text)),

    -- ===== THE PROMISE ====================================================
    -- "No store can publish something unreadable." A DRAFT may be anything — a merchant is
    -- mid-decision and the studio shows them what is wrong — but a PUBLISHED row must pass every
    -- text check. Five constraints rather than one, so a refusal names which text is unreadable.
    CONSTRAINT store_themes_body_text_readable
        CHECK (status <> 'published' OR wcag_contrast(color_text, color_bg) >= 4.5),
    CONSTRAINT store_themes_muted_text_readable
        CHECK (status <> 'published' OR wcag_contrast(color_muted, color_bg) >= 4.5),
    CONSTRAINT store_themes_button_text_readable
        CHECK (status <> 'published' OR wcag_contrast(color_on_primary, color_primary) >= 4.5),
    CONSTRAINT store_themes_badge_text_readable
        CHECK (status <> 'published' OR wcag_contrast(color_on_accent, color_accent) >= 4.5),
    CONSTRAINT store_themes_banner_text_readable
        CHECK (status <> 'published' OR wcag_contrast(color_hero_text, color_hero_bg) >= 4.5),

    -- The one check a theme may fail and still publish, because failing it is what the outline
    -- exists for. `needs_outline` must AGREE with the measurement — a theme claiming it does not
    -- need an outline while its buttons vanish into the page is the state this forbids.
    CONSTRAINT store_themes_outline_agrees
        CHECK (status <> 'published'
               OR needs_outline = (wcag_contrast(color_primary, color_bg) < 3.0))
);

COMMENT ON TABLE store_themes IS
    'A store''s look. One draft and one published row. A published row is refused unless every text pair reaches 4.5:1 — the database''s own half of ThemeStudio''s promise, independent of the compiler that produced the colours.';
COMMENT ON COLUMN store_themes.input_accent IS
    'NULL means "let Vendlyfy pick": the harmony decides. A value means the merchant chose it and the harmony is irrelevant.';
COMMENT ON COLUMN store_themes.needs_outline IS
    'Derived, and checked: true exactly when the button colour is within 3:1 of the page. Components read it rather than re-measuring.';

-- Serves: the storefront resolving one store's published theme, on every page load.
CREATE INDEX store_themes_published_idx ON store_themes (store_id) WHERE status = 'published';

CREATE TRIGGER store_themes_set_updated_at BEFORE UPDATE ON store_themes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
