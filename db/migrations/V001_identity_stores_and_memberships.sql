-- V001_identity_stores_and_memberships.sql
--
-- Milestone 5. The first tables: who exists, what a store is, and who may act in
-- one. §5.4 of docs/migration/04-implementation-plan.md is the specification.
--
-- The one idea this file is built around: ROLE IS NOT A COLUMN ON A PERSON.
-- `Auth`'s store picker requires one person to be Owner at one store and Manager
-- at another. A `role` column cannot express that, so a role is a property of a
-- membership — a row joining a person to a store.
--
-- DELIBERATELY NOT HERE, each with the migration that owns it:
--
--   industry_template_id + pinned version, config overrides   V002, milestone 6
--   draft_theme / published_theme                             milestone 13
--   plan (FK to plans & fees)                                 milestone 9
--   KYC state, delivery zones, payment methods                milestone 9
--   password reset, email verification, lockout               milestone 15
--
-- A column that cannot be constrained yet is a column that holds garbage, so each
-- of those lands with the table that gives it meaning rather than as a nullable
-- placeholder now.


-- =============================================================================
-- stores
-- =============================================================================
-- Was `tenants`. A store is the unit of everything: a catalogue, a wallet, staff,
-- customers, a theme.

CREATE TABLE stores (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The storefront's path segment today and its subdomain label if the domain
    -- decision goes that way. Lower-case, digits and single hyphens, so it is
    -- safe in both a path and a hostname without further escaping.
    slug             text        NOT NULL,

    name             text        NOT NULL,

    -- Set when a merchant brings their own domain. Nullable and unique: the
    -- subdomain-vs-path decision (Part 9) then becomes configuration rather than
    -- a table rewrite.
    custom_domain    text,

    -- ISO 3166-1 alpha-2, and ISO 4217. The currencies table arrives at
    -- milestone 9 and will add the foreign key; the shape is constrained now so
    -- that what is stored in the meantime is already valid.
    country          char(2)     NOT NULL,
    selling_currency char(3)     NOT NULL,

    -- The three states AdminMerchants draws. KYC is a separate lifecycle
    -- (milestone 9) — a store can be active with verification outstanding, which
    -- is exactly what the "payouts locked until verified" state means.
    status           text        NOT NULL DEFAULT 'pending',

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT stores_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT stores_slug_length CHECK (char_length(slug) BETWEEN 2 AND 63),

    -- A slug becomes a path segment today and a subdomain label if the domain
    -- decision goes that way, so a store called 'api' or 'admin' would shadow the
    -- application's own routes. Refuse them at the column rather than discover it
    -- when a merchant picks one.
    CONSTRAINT stores_slug_not_reserved CHECK (slug NOT IN (
        'api', 'app', 'admin', 'www', 'mail', 'ftp', 'assets', 'static', 'public',
        'auth', 'login', 'logout', 'signup', 'signin', 'register', 'password',
        'account', 'accounts', 'dashboard', 'settings', 'checkout', 'cart',
        'orders', 'order', 'products', 'health', 'status', 'support', 'help',
        'about', 'terms', 'privacy', 'blog', 'docs', 'vendlyfy', 'store', 'stores'
    )),
    CONSTRAINT stores_country_format CHECK (country ~ '^[A-Z]{2}$'),
    CONSTRAINT stores_currency_format CHECK (selling_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT stores_status_values CHECK (status IN ('pending', 'active', 'suspended')),
    CONSTRAINT stores_custom_domain_format
        CHECK (custom_domain IS NULL OR custom_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
);

COMMENT ON TABLE stores IS
    'One merchant storefront. The unit that owns a catalogue, a wallet, staff and customers.';
COMMENT ON COLUMN stores.status IS
    'pending | active | suspended. Verification state is separate: a store can be active with KYC outstanding.';

-- Serves: resolving a storefront from its URL, on every storefront request.
CREATE UNIQUE INDEX stores_slug_key ON stores (slug);

-- Serves: resolving a storefront from the Host header, once custom domains land.
CREATE UNIQUE INDEX stores_custom_domain_key ON stores (custom_domain) WHERE custom_domain IS NOT NULL;

-- Serves: AdminMerchants' list, which is filtered by status and newest first.
CREATE INDEX stores_status_created_at_idx ON stores (status, created_at DESC);

CREATE TRIGGER stores_set_updated_at BEFORE UPDATE ON stores
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- users — identity only
-- =============================================================================
-- Email, phone, password. No role, no store affiliation for staff: that is what
-- store_members and platform_members are for.
--
-- THE SCOPE DISCRIMINATOR. §5.4 chose one users table over separate staff and
-- customer tables, because it keeps one sign-in path, one password reset and one
-- lockout policy — which is what `Auth` draws.
--
--   scope = 'platform'  a person who can hold memberships: merchant staff and the
--                       Vendlyfy team. Email unique across the platform.
--                       store_id must be NULL.
--   scope = 'store'     a customer of exactly one store. CustomerAccount is
--                       explicit: "This account is only for Nyama & Co. Other
--                       stores on Vendlyfy ask separately." Email unique WITHIN
--                       that store. store_id required.
--
-- ONE EMAIL MAY THEREFORE HAVE SEVERAL ROWS — one platform identity and one
-- customer account per store, each with its own password. That is not an
-- oversight; it is the behaviour server/test/auth.login.test.js pins down, and
-- the reason it exists is that scoping the sign-in lookup wrongly once locked
-- real users out of production. Milestone 15 owns which row a sign-in resolves
-- to; this file only makes the shape possible and keeps it unambiguous.

CREATE TABLE users (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    scope         text        NOT NULL,
    store_id      uuid        REFERENCES stores (id) ON DELETE RESTRICT,

    email         text        NOT NULL,
    phone         text,
    password_hash text        NOT NULL,
    name          text        NOT NULL,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_scope_values CHECK (scope IN ('platform', 'store')),

    -- The discriminator and store_id must agree, or a "customer" with no store
    -- becomes a platform identity by accident.
    CONSTRAINT users_scope_store_agree CHECK (
        (scope = 'platform' AND store_id IS NULL)
        OR (scope = 'store' AND store_id IS NOT NULL)
    ),

    CONSTRAINT users_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

    -- Referenced by the composite foreign keys on the membership tables below, so
    -- that a membership can require a PLATFORM-scoped user declaratively rather
    -- than through a trigger. See store_members.
    CONSTRAINT users_id_scope_key UNIQUE (id, scope)
);

COMMENT ON TABLE users IS
    'Identity only: email, phone, password. Roles live on store_members and platform_members.';
COMMENT ON COLUMN users.scope IS
    'platform = can hold memberships (staff, Vendlyfy team). store = a customer of one store. One email may have one platform row and one store row per store, each with its own password.';

-- Uniqueness, and the two rules are different by design.
-- Serves: sign-in, and the "email already registered" check.
CREATE UNIQUE INDEX users_platform_email_key
    ON users (lower(email)) WHERE scope = 'platform';
CREATE UNIQUE INDEX users_store_email_key
    ON users (store_id, lower(email)) WHERE scope = 'store';

-- Serves: sign-in from the global page, which names no store and so cannot use
-- either partial index above — Postgres only uses a partial index when the query
-- implies its predicate. Without this, every global sign-in is a sequential scan.
CREATE INDEX users_email_idx ON users (lower(email));

-- Serves: a store's customer list (Customers board), and the FK's cascade check.
CREATE INDEX users_store_id_idx ON users (store_id) WHERE store_id IS NOT NULL;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- store_members — staff, and the roles they hold
-- =============================================================================
-- One row per person per store. The primary key is what stops one person holding
-- two roles in one store, which would make "what may they do here" ambiguous.
--
-- CUSTOMERS ARE NOT HERE. A customer is a store-scoped `users` row; putting them
-- here too would mean two places to look for the same fact. The role list below
-- is staff only, and the CHECK enforces it.

CREATE TABLE store_members (
    user_id    uuid        NOT NULL,

    -- Always 'platform'. It exists only to carry the composite foreign key below.
    user_scope text        NOT NULL DEFAULT 'platform',

    store_id   uuid        NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,
    role       text        NOT NULL,

    -- Who granted this. §5.4's delegated creation is an authorization rule, and a
    -- rule without a record of its use cannot be reviewed after the fact.
    created_by uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, store_id),

    CONSTRAINT store_members_role_values CHECK (role IN ('owner', 'admin', 'manager', 'rider')),

    -- A store-scoped customer must never acquire staff privileges by being given a
    -- membership. This is why users carries UNIQUE (id, scope): the constraint is
    -- declarative, so it holds against any writer — a repository, a migration, or
    -- somebody at a psql prompt — rather than only against code that remembers.
    CONSTRAINT store_members_user_is_platform_scoped CHECK (user_scope = 'platform'),
    FOREIGN KEY (user_id, user_scope) REFERENCES users (id, scope) ON DELETE CASCADE
);

COMMENT ON TABLE store_members IS
    'Staff membership: one role for one person in one store. Many stores per person — that is the case Auth''s store picker draws.';
COMMENT ON COLUMN store_members.user_scope IS
    'Always platform. Carries the composite FK to users (id, scope) so a store-scoped customer cannot be given staff privileges.';

-- Serves: the Settings → Staff panel, listing a store's members by role.
-- Leads with store_id because the primary key already leads with user_id, which
-- serves the other direction (this person's memberships, for the store picker).
CREATE INDEX store_members_store_role_idx ON store_members (store_id, role);

CREATE TRIGGER store_members_set_updated_at BEFORE UPDATE ON store_members
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- platform_members — the Vendlyfy team
-- =============================================================================
-- Separate from store_members because the scopes must not be confusable. §5.4's
-- first escalation test is that a store admin cannot grant a platform role; two
-- tables mean that is not a matter of validating a string, it is a different
-- table the endpoint must not write.

CREATE TABLE platform_members (
    user_id    uuid        NOT NULL,
    user_scope text        NOT NULL DEFAULT 'platform',
    role       text        NOT NULL,

    created_by uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id),

    -- super_admin is the only platform role this milestone defines. AdminTeam
    -- (milestone 27) adds the scoped team roles it draws — support, finance,
    -- reviewer — and widens this CHECK in its own migration.
    CONSTRAINT platform_members_role_values CHECK (role IN ('super_admin')),

    CONSTRAINT platform_members_user_is_platform_scoped CHECK (user_scope = 'platform'),
    FOREIGN KEY (user_id, user_scope) REFERENCES users (id, scope) ON DELETE CASCADE
);

COMMENT ON TABLE platform_members IS
    'The Vendlyfy team. A separate table from store_members so that granting a platform role is a different write, not a different string.';

CREATE TRIGGER platform_members_set_updated_at BEFORE UPDATE ON platform_members
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================================
-- role_permissions — permissions are data, not code branches
-- =============================================================================
-- §5.4: "A component asks whether a role may do something; it never contains the
-- list." Auth's invite screen renders a role's permissions in prose and AdminTeam
-- is a whole board about roles; both read from here.

CREATE TABLE role_permissions (
    scope      text NOT NULL,
    role       text NOT NULL,
    permission text NOT NULL,

    PRIMARY KEY (scope, role, permission),

    CONSTRAINT role_permissions_scope_values CHECK (scope IN ('platform', 'store')),
    CONSTRAINT role_permissions_permission_format CHECK (permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),

    -- Without this, a typo — 'manger' for 'manager' — stores cleanly, the
    -- authorization guard finds no permissions for the real role, and the failure
    -- shows up as a manager who can do nothing rather than as an error.
    --
    -- The pair must also be coherent: 'super_admin' is not a store role and
    -- 'owner' is not a platform one. §5.4's first escalation rule is that a store
    -- admin may grant only store roles, and this is the data-level half of it.
    --
    -- 'customer' is listed as a store role because §5.4's model includes it, and
    -- it deliberately has no permission rows: a customer's capabilities are not
    -- console permissions. A lookup for it correctly returns nothing.
    CONSTRAINT role_permissions_scope_role_coherent CHECK (
        (scope = 'store'    AND role IN ('owner', 'admin', 'manager', 'rider', 'customer'))
     OR (scope = 'platform' AND role IN ('super_admin'))
    )
);

COMMENT ON TABLE role_permissions IS
    'What each role may do. Read by the authorization guard and rendered by Auth''s invite screen and AdminTeam.';
COMMENT ON COLUMN role_permissions.role IS
    'Spans both scopes, so it is not a foreign key to either membership table. The scope/role pair is kept coherent by a CHECK.';

-- Serves: resolving a role's permission set on a request, and rendering it.
-- The primary key already leads with (scope, role), which is that lookup.

INSERT INTO role_permissions (scope, role, permission) VALUES
    -- owner and admin: full control of their own store, including money and
    -- settings, and they create other members within it.
    ('store', 'owner',   'orders.read'),
    ('store', 'owner',   'orders.update'),
    ('store', 'owner',   'orders.assign_rider'),
    ('store', 'owner',   'products.write'),
    ('store', 'owner',   'stock.write'),
    ('store', 'owner',   'wallet.read'),
    ('store', 'owner',   'payouts.request'),
    ('store', 'owner',   'settings.write'),
    ('store', 'owner',   'staff.create'),
    ('store', 'admin',   'orders.read'),
    ('store', 'admin',   'orders.update'),
    ('store', 'admin',   'orders.assign_rider'),
    ('store', 'admin',   'products.write'),
    ('store', 'admin',   'stock.write'),
    ('store', 'admin',   'wallet.read'),
    ('store', 'admin',   'payouts.request'),
    ('store', 'admin',   'settings.write'),
    ('store', 'admin',   'staff.create'),

    -- manager: Auth's invite screen, verbatim — "accept and update orders, assign
    -- riders, edit products and stock", and "can't see payouts, the wallet or
    -- store settings". The absence of wallet.read, payouts.request and
    -- settings.write below is the second half of that sentence.
    ('store', 'manager', 'orders.read'),
    ('store', 'manager', 'orders.update'),
    ('store', 'manager', 'orders.assign_rider'),
    ('store', 'manager', 'products.write'),
    ('store', 'manager', 'stock.write'),

    -- rider: their own deliveries only. The scoping to "own" is enforced by the
    -- query, not by the permission — a permission cannot express a row filter.
    ('store', 'rider',   'deliveries.own_read'),
    ('store', 'rider',   'deliveries.own_update'),

    -- super_admin: everything, every store. Listed explicitly rather than as a
    -- wildcard, so that "what can the platform team do" is answerable by reading
    -- rows instead of by reading code.
    ('platform', 'super_admin', 'stores.create'),
    ('platform', 'super_admin', 'stores.suspend'),
    ('platform', 'super_admin', 'platform_members.create'),
    ('platform', 'super_admin', 'merchants.read'),
    ('platform', 'super_admin', 'kyc.review'),
    ('platform', 'super_admin', 'refunds.approve'),
    ('platform', 'super_admin', 'disputes.resolve'),
    ('platform', 'super_admin', 'payouts.process'),
    ('platform', 'super_admin', 'audit.read');
