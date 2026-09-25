-- =============================================================================
-- V014 — the payout keyset's index
-- =============================================================================
-- Milestone 11 of docs/migration/04-implementation-plan.md, and it exists because of
-- a measurement rather than a design change. §2.3 requires "EXPLAIN (ANALYZE, BUFFERS)
-- before merge on request-path queries, against seeded volumes"; this is what that
-- review produced.
--
-- THE QUERY. server/src/repositories/money.ts, listPayouts() — the Wallet board's payout
-- history, keyset paginated:
--
--     SELECT … FROM withdrawals
--      WHERE store_id = $1
--        AND (requested_at, id) < ($2, $3)
--      ORDER BY requested_at DESC, id DESC
--      LIMIT $4
--
-- THE CURSOR HAS TO CARRY `id`. Two payouts requested in the same transaction share
-- `now()` to the microsecond, and a cursor on the timestamp alone either skips the second
-- or repeats the first. Milestone 10's notifications shipped that bug and had to fix it.
--
-- WHAT WAS MEASURED. 40,000 payouts for one store, all on one timestamp — the tie group
-- the cursor exists for — asking for page 2 of 26:
--
--     (store_id, requested_at DESC)            6,231 buffers   23.8 ms   15,860 rows
--                                                                        discarded by a
--                                                                        filter
--     (store_id, requested_at DESC, id DESC)      26 buffers    0.095 ms  0 discarded
--
-- 240× fewer pages. With only two columns the row-value comparison is a filter applied
-- after the index has already returned the whole tie group; with `id` in the index it is
-- part of the seek, and `ORDER BY requested_at DESC, id DESC` is then an ordered walk with
-- no sort at all — the Incremental Sort that appeared even on well-spread data disappears.
--
-- WHY THIS REPLACES THE OLD INDEX RATHER THAN JOINING IT. The new index has the old one's
-- columns as its leading prefix, so it serves everything the old one served — the store's
-- payout list, newest first. Keeping both would tax every write on withdrawals to answer
-- the same questions twice. §2.3: "Over-indexing taxes every write and is invisible until
-- it isn't."
--
-- NOT CONCURRENTLY, deliberately. §2.3 asks for CONCURRENTLY "on populated production
-- tables", and this table is not one: this is the greenfield database, where withdrawals
-- holds the seed's three rows until milestone 29's ETL fills it. A plain CREATE INDEX
-- keeps this migration inside its transaction, which is worth more here than an online
-- build of an index on an empty table. The ETL runs AFTER this, so it populates the right
-- index from the start.
-- =============================================================================

DROP INDEX withdrawals_store_requested_idx;

-- Serves: the Wallet board's payout history and its keyset cursor. Composite leading with
-- the tenant column, per §2.3's index policy.
CREATE INDEX withdrawals_store_keyset_idx
    ON withdrawals (store_id, requested_at DESC, id DESC);

COMMENT ON INDEX withdrawals_store_keyset_idx IS
    'The payout list and its keyset cursor. id is in the index, not only in the cursor: without it a tie group of payouts sharing one timestamp is filtered after the fact rather than sought — measured at 6,231 buffers against 26.';
