-- MBTA Reliability Tracker — migration 0010
--
-- Two small tables that remove full-table scans from the read path, part of
-- the read-budget fix begun in 0009. Neither has a secondary index.

-- ---------------------------------------------------------------------------
-- 1. arrival_counts — per-day arrival counts for /api/summary.
--
-- /api/summary reported all-time totals by aggregating the whole arrivals table
-- three times per call (~136k rows each, growing forever). This table holds the
-- same counts at (service_date, slice, source) grain: ~30 rows per day.
--
-- Maintained by the matcher: after each run it recomputes the rows for exactly
-- the service dates it just wrote, reading those dates through the arrivals
-- UNIQUE (service_date, ...) index. Recompute, not increment — an upsert that
-- upgrades a row's source (unresolved_dropout -> stopped_at) moves a count
-- between sources, and increments would get that wrong silently.
--
-- WITHOUT ROWID with the natural key as primary key: no secondary index, so no
-- extra written row per write. WITHOUT ROWID forbids NULL key columns, so a NULL
-- route_id / direction_id in arrivals is stored as '' / -1. Those rows never
-- joined to watched_stops before either (NULL = x is not true); they still count
-- toward the totals and by-source figures, as they did before.
-- ---------------------------------------------------------------------------
CREATE TABLE arrival_counts (
  service_date  TEXT    NOT NULL,
  stop_id       TEXT    NOT NULL,
  route_id      TEXT    NOT NULL,
  direction_id  INTEGER NOT NULL,
  source        TEXT    NOT NULL,
  n             INTEGER NOT NULL,
  PRIMARY KEY (service_date, stop_id, route_id, direction_id, source)
) WITHOUT ROWID;

-- One-time backfill: a single full read of arrivals (~136k rows), paid once.
INSERT INTO arrival_counts (service_date, stop_id, route_id, direction_id, source, n)
SELECT service_date, stop_id, COALESCE(route_id, ''), COALESCE(direction_id, -1), source, COUNT(*)
  FROM arrivals
 GROUP BY 1, 2, 3, 4, 5;

-- ---------------------------------------------------------------------------
-- 2. collection_coverage — what the collector_runs prune deletes, summarised.
--
-- collector_runs keeps 7 days. It is also the only record of which minutes
-- were collected, and so of which hours of which days are trustworthy: from
-- 2026-09-02 to 2026-09-28 only ~20:00-01:30 local were. Pruning it outright
-- would delete the evidence of the outage along with the rows.
--
-- The prune folds each run into its UTC hour here before deleting it, in one
-- transaction, so collector_runs + collection_coverage always hold the full
-- history with nothing counted twice. UTC hours, not service dates: this is
-- about the collector's clock, and UTC needs no timezone rules in SQL.
-- ~24 rows/day.
-- ---------------------------------------------------------------------------
CREATE TABLE collection_coverage (
  hour_start     INTEGER PRIMARY KEY,   -- epoch seconds, UTC hour boundary
  runs           INTEGER NOT NULL,
  ok_runs        INTEGER NOT NULL,      -- error IS NULL: the tick stored its data
  d1_limit_runs  INTEGER NOT NULL
);
