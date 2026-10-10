-- V032_admin_team_and_settings.sql
--
-- Milestone 27, part C. Three things the last six admin screens stand on.
--
-- 1. THE TEAM ROLES AdminTeam DRAWS. V001 defined `super_admin` only and left a note in its own CHECK: "AdminTeam (milestone 27) adds
--    the scoped team roles it draws … and widens this CHECK in its own migration." This is that migration. The board's matrix has
--    four columns — Super admin, Support, Finance, Verification — and each is a set of permission rows, so what a role can do stays
--    a query (`SELECT … FROM role_permissions WHERE role = …`) rather than code.
--
--      support       sees stores and orders, decides refunds and disputes, suspends and reinstates stores
--      finance       sees stores and orders, decides refunds and disputes, retries payouts, changes plans, fees,
--                    payment methods and currencies
--      verification  sees stores and orders, reviews identity checks (and may reveal an ID number, with its reason on the record)
--
--    AND NOTHING ELSE. In particular only super_admin holds platform_members.create — a team member cannot make a bigger team member —
--    and only super_admin reads the audit log, changes platform settings or edits templates.
--
-- 2. THREE PERMISSIONS the new screens ask for: plans.manage (Plans & fees), templates.manage (Industry templates) and
--    platform_settings.manage (Platform settings). Separate strings for the reason V031 gave: a finance role changes prices and a
--    support role does not, and "config.write" could not say so.
--
-- 3. platform_settings, the one small table AdminSettings needs. The board edits three defaults the system had as constants or as an
--    environment variable — how a new store is paid out, how long money is held after payment, when automatic payouts run — and
--    "defaults for every store, changes are logged" needs a place to keep them that is not a deploy. A key/value table, not a column
--    per setting: these are three today and a platform's list of knobs only grows, and each value is validated by the code that reads
--    it, not by a schema that would have to be migrated for every new knob. Rows are seeded, never inserted by the application, so a
--    missing key is a bug and not a default.

ALTER TABLE platform_members DROP CONSTRAINT platform_members_role_values;
ALTER TABLE platform_members ADD CONSTRAINT platform_members_role_values
    CHECK (role IN ('super_admin', 'support', 'finance', 'verification'));

ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_scope_role_coherent;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_scope_role_coherent CHECK (
    (scope = 'store'    AND role IN ('owner', 'admin', 'manager', 'rider', 'customer'))
 OR (scope = 'platform' AND role IN ('super_admin', 'support', 'finance', 'verification'))
);

INSERT INTO role_permissions (scope, role, permission) VALUES
    ('platform', 'super_admin', 'plans.manage'),
    ('platform', 'super_admin', 'templates.manage'),
    ('platform', 'super_admin', 'platform_settings.manage'),

    ('platform', 'support', 'merchants.read'),
    ('platform', 'support', 'refunds.approve'),
    ('platform', 'support', 'disputes.resolve'),
    ('platform', 'support', 'stores.suspend'),

    ('platform', 'finance', 'merchants.read'),
    ('platform', 'finance', 'refunds.approve'),
    ('platform', 'finance', 'disputes.resolve'),
    ('platform', 'finance', 'payouts.process'),
    ('platform', 'finance', 'payment_methods.manage'),
    ('platform', 'finance', 'currencies.manage'),
    ('platform', 'finance', 'plans.manage'),

    ('platform', 'verification', 'merchants.read'),
    ('platform', 'verification', 'kyc.review');

CREATE TABLE platform_settings (
    key         text        PRIMARY KEY,
    value       jsonb       NOT NULL,
    updated_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT platform_settings_key_format CHECK (key ~ '^[a-z][a-z0-9_]*$')
);

COMMENT ON TABLE platform_settings IS
    'Defaults every store inherits. Seeded, edited from the admin console, each change an audit entry. The code that reads a key validates its value.';

CREATE TRIGGER platform_settings_set_updated_at BEFORE UPDATE ON platform_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO platform_settings (key, value) VALUES
    ('payout_mode_default', '"manual"'),
    ('hold_minutes',        '60'),
    ('automatic_payout_at', '"08:00"');
