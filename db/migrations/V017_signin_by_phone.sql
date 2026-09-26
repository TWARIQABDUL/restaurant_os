-- =============================================================================
-- V017 — signing in with a phone number
-- =============================================================================
-- Milestone 15. Auth's rider signs in as "078 455 9012", so the identifier on the sign-in form is an
-- email OR a phone — and a phone typed by a person is never typed the same way twice: "078 455 9012",
-- "0784559012", "+250 784 559 012".
--
-- WHY THIS IS A MIGRATION AND NOT A `WHERE regexp_replace(...)`. Without an index, matching a
-- normalised phone is a sequential scan of `users` on every sign-in attempt — and `users` is the table
-- that grows fastest, because every customer of every store is a row in it. A login path that scans it
-- is a denial of service that needs one valid-looking identifier and no credentials at all.
--
-- The normalisation has to be IMMUTABLE to be indexable, which is why it is a function rather than an
-- expression repeated at each call site: an expression index and a query have to agree character for
-- character, and two copies of a regex do not stay identical.
-- =============================================================================

CREATE FUNCTION digits(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path = pg_catalog
AS $init$
    -- Everything that is not 0-9 removed. A leading +250 and a leading 0 are therefore NOT the same
    -- string, which is correct: this normalises typography, not dialling plans. Two spellings of one
    -- number match; two numbers never do.
    SELECT regexp_replace(value, '[^0-9]', '', 'g');
$init$;

COMMENT ON FUNCTION digits(text) IS
    'A phone number with the punctuation removed, so "078 455 9012" and "0784559012" match. IMMUTABLE so it can be indexed; normalises typography only, never dialling plans.';

-- Serves: the phone arm of the sign-in lookup. Partial, because most users have no phone — V001 only
-- requires one for staff the board gives one to — and a partial index is smaller and untouched by
-- every customer row that has none.
CREATE INDEX users_phone_digits_idx ON users (digits(phone)) WHERE phone IS NOT NULL;

COMMENT ON INDEX users_phone_digits_idx IS
    'Signing in with a phone number. Without it the phone arm of the sign-in lookup scans users, which is the fastest-growing table on the platform.';
