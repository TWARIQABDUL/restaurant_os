-- =============================================================================
-- V016 — signing in: revocation, invites, and the two code flows
-- =============================================================================
-- Milestone 15 of docs/migration/04-implementation-plan.md.
--
-- §5.4 said the one `users` table buys "one sign-in path, one password reset and one lockout policy,
-- which is what `Auth` draws". This is the rest of that: what the board draws beyond the password
-- field itself — a 2-step code for the Vendlyfy team, a reset code, a staff invite, and a password
-- change that "signs you out on every other device".
--
-- WHAT THIS FILE DOES NOT ADD: a sessions table.
--
-- §2.5 is firm that "the server is authoritative for all session and application state", and a
-- stateless token is in tension with that — the server cannot end a session it does not record. But
-- read what the board actually needs: "Keep me signed in on this device" is a max-age, and "This
-- signs you out on every other device" is all-sessions-except-the-one-being-used. Neither needs a row
-- per session; both fall out of a version counter on the user, bumped on a password change, with a
-- fresh cookie issued to whoever made the change.
--
-- A sessions table is what per-device sign-out and a "your devices" list would need, and the canvas
-- draws neither. So this is the smaller thing that is wholly sufficient, and the note is here so the
-- next person knows it was a decision rather than an oversight.
--
-- THE LOCKOUT POLICY IS NOT A TABLE EITHER, and that is also deliberate. The legacy login already
-- reasons it out at length (server/src/routes/auth.js): a rate limiter on the route, a bound on how
-- many candidate rows one address can turn into bcrypt work, a uniform error, and one comparison
-- spent even on a miss so timing does not reveal which addresses are registered. A counter column
-- would add a lockout an attacker can trigger against somebody else's account on purpose.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Revoking every session at once
-- -----------------------------------------------------------------------------

ALTER TABLE users
    ADD COLUMN session_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN users.session_version IS
    'Bumped to sign out every device. A session token carries the version it was issued at and the guard compares; a password change therefore invalidates every other session, which is what Auth promises.';

ALTER TABLE users
    ADD CONSTRAINT users_session_version_positive CHECK (session_version >= 1);


-- -----------------------------------------------------------------------------
-- 2. auth_codes — the 2-step code and the reset code, in one table
-- -----------------------------------------------------------------------------
-- Both are a short numeric code sent out of band, valid briefly, good once. Two tables would mean
-- two expiry policies and two attempt counters to keep in step, so `purpose` distinguishes them.
--
-- THE CODE IS HASHED. Six digits is a million combinations; stored in plaintext, a database leak is
-- an account takeover on every outstanding code. And because six digits is guessable, `attempts` is
-- bounded here rather than only at the endpoint — a bound the endpoint owns is a bound a second
-- endpoint can forget.

CREATE TABLE auth_codes (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    purpose       text        NOT NULL,

    -- sha256 of the code. Not bcrypt: a six-digit code has no entropy to protect with a slow hash,
    -- the row expires in minutes, and `attempts` is what actually bounds guessing.
    code_hash     bytea       NOT NULL,

    attempts      smallint    NOT NULL DEFAULT 0,

    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    consumed_at   timestamptz,

    CONSTRAINT auth_codes_purpose_values
        CHECK (purpose IN ('platform_two_step', 'password_reset')),
    CONSTRAINT auth_codes_expires_after_creation CHECK (expires_at > created_at),
    CONSTRAINT auth_codes_attempts_bounded CHECK (attempts BETWEEN 0 AND 5),
    CONSTRAINT auth_codes_code_hash_length CHECK (octet_length(code_hash) = 32)
);

COMMENT ON TABLE auth_codes IS
    'A short code sent out of band: the Vendlyfy team''s 2-step code, and a password reset. Hashed at rest and good once, with attempts bounded at the column so no endpoint can forget to bound them.';

-- Serves: finding the one live code for a person and a purpose, which is every read of this table.
CREATE INDEX auth_codes_live_idx ON auth_codes (user_id, purpose, expires_at DESC)
    WHERE consumed_at IS NULL;

-- AT MOST ONE LIVE CODE per person per purpose. Without this, asking for a new code leaves the old
-- one usable — so "Send again" would widen the guessing window instead of replacing it, and a
-- customer reading the older SMS would be told their correct code is wrong.
CREATE UNIQUE INDEX auth_codes_one_live_per_purpose
    ON auth_codes (user_id, purpose) WHERE consumed_at IS NULL;


-- -----------------------------------------------------------------------------
-- 3. staff_invites — how somebody joins a store they do not yet belong to
-- -----------------------------------------------------------------------------
-- Auth's own screen: "Join Nyama & Co. — Aline Uwase invited Patrick Niyonzima as a Manager."
--
-- THIS IS WHAT POST /members REFUSED TO DO. Milestone 11 made that endpoint create new accounts only,
-- and refuse an email that already has a Vendlyfy account with 409 ACCOUNT_EXISTS — because attaching
-- somebody to your store on nothing but their email address would hand you their real name and phone
-- from the staff list, and give them a store they never agreed to work at. An invite is the consent
-- that makes it safe: the person accepts, and only then does the membership exist.

CREATE TABLE staff_invites (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id       uuid        NOT NULL REFERENCES stores (id) ON DELETE CASCADE,

    -- The address the invite was sent to, and the role it grants. Not a foreign key to users: the
    -- invitee may have no account yet, which is the ordinary case.
    email          text        NOT NULL,
    role           text        NOT NULL,

    -- The name the inviter typed, so the acceptance screen can say who was invited before there is a
    -- user row to read it from.
    invitee_name   text        NOT NULL,

    -- sha256 of a long random token that only ever exists in the emailed link. Same reasoning as
    -- auth_codes, except this one has real entropy, so there is no attempt counter: guessing it is
    -- not a thing that happens.
    token_hash     bytea       NOT NULL,

    invited_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,

    accepted_at    timestamptz,
    accepted_user_id uuid      REFERENCES users (id) ON DELETE SET NULL,

    revoked_at     timestamptz,

    -- The same roles POST /members may grant. `owner` is excluded for the reason
    -- repositories/memberships.ts gives: granting ownership is a transfer, not a create.
    CONSTRAINT staff_invites_role_values CHECK (role IN ('admin', 'manager', 'rider')),
    CONSTRAINT staff_invites_email_shape
        CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    CONSTRAINT staff_invites_name_present CHECK (btrim(invitee_name) <> ''),
    CONSTRAINT staff_invites_expires_after_creation CHECK (expires_at > created_at),
    CONSTRAINT staff_invites_token_hash_length CHECK (octet_length(token_hash) = 32),

    -- An accepted invite names who accepted it, and an unaccepted one names nobody. Without this the
    -- two can disagree and "who is this membership from" stops being answerable.
    CONSTRAINT staff_invites_accepted_agrees
        CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL)),

    -- Accepted or revoked, not both.
    CONSTRAINT staff_invites_not_both_outcomes
        CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

COMMENT ON TABLE staff_invites IS
    'An offer of a store membership, accepted by the invitee. The consent that makes adding somebody to a store safe — see milestone 11''s POST /members, which refuses to do it without one.';
COMMENT ON COLUMN staff_invites.email IS
    'Not a foreign key to users: the ordinary case is inviting somebody with no account yet.';

-- Serves: the Settings → Staff panel listing what is outstanding for a store.
CREATE INDEX staff_invites_store_pending_idx ON staff_invites (store_id, created_at DESC)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- AT MOST ONE LIVE INVITE per address per store. A second would let one person accept twice, or —
-- worse — let a later invite with a different role sit behind an earlier one and grant whichever was
-- clicked. Re-inviting revokes and reissues instead, which the endpoint does.
CREATE UNIQUE INDEX staff_invites_one_live_per_email
    ON staff_invites (store_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Serves: accepting, which arrives holding only the token.
CREATE UNIQUE INDEX staff_invites_token_key ON staff_invites (token_hash);
