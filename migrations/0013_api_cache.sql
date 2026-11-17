-- MBTA Reliability Tracker — migration 0013
--
-- A response cache for the public read-only API (src/cache.ts).
--
-- Why: every GET /api/* ran its D1 queries on every request. The Worker set
-- Cache-Control: s-maxage=3600, but Cloudflare does not edge-cache a response a
-- Worker generates itself, so that header bought nothing at the Worker. Measured
-- per call (D1 insights, 2026-11-16): error-by-day 13,353 rows, the grid behind
-- error-by-slice 8,397, summary's alert lookup alone 25,656. The endpoints are
-- public, so the number of requests — not the number of rollups — set the read
-- bill, against the 5M/day account-wide budget the collector depends on.
--
-- Why D1 and not the Workers Cache API: the Cache API is per data center (one
-- miss per colo per key), its behaviour on workers.dev is not documented, and a
-- rollup cannot purge it globally. A primary-key lookup here is one row read,
-- shows up in D1 insights where it can be measured, and DELETE FROM api_cache
-- invalidates everywhere at once.
--
-- WITHOUT ROWID so the TEXT primary key IS the table: a rowid table would add an
-- automatic index on key, a second written row per cache fill.
--
-- WRITE COST: one row per cache miss. Keys are path + allowlisted params, so
-- the key space is bounded by what the page can ask for (~4 page endpoints plus
-- one per heatmap selection). Every rollup deletes all rows, so it never grows
-- past a day's keys. Tens of writes a day; nothing like the snapshot table.

CREATE TABLE api_cache (
  key          TEXT PRIMARY KEY,
  body         TEXT NOT NULL,
  generated_at INTEGER NOT NULL,  -- epoch seconds the handler actually ran
  expires_at   INTEGER NOT NULL   -- epoch seconds; backstop, rollups invalidate first
) WITHOUT ROWID;
