-- MBTA Reliability Tracker — migration 0001
--
-- Design notes live in CLAUDE.md. Two that matter most when reading this file:
--
--   1. Prediction identity is (service_date, trip_id, stop_sequence). NOT stop_id,
--      which is mutable on the MBTA V3 /predictions endpoint.
--   2. Prediction error is never stored. It is derived by joining a snapshot to an
--      arrival at rollup time. D1's free tier allows 5M row reads/day but only
--      100k row writes/day, so this schema deliberately trades reads for writes.
--
-- All timestamps are unix epoch SECONDS unless the column name says otherwise.
-- service_date is 'YYYY-MM-DD' in America/New_York, rolling over at 03:00 local.

-- ---------------------------------------------------------------------------
-- Config: which stops we watch. In the DB, not in code, so adding a stop is a
-- data change rather than a redeploy.
-- ---------------------------------------------------------------------------
CREATE TABLE watched_stops (
  stop_id      TEXT    NOT NULL,
  route_id     TEXT    NOT NULL,
  direction_id INTEGER NOT NULL,
  label        TEXT    NOT NULL,   -- human-readable, for the status page
  active       INTEGER NOT NULL DEFAULT 1,
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (stop_id, route_id, direction_id)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Append-only history of every prediction value we ever observed change.
--
-- NO SECONDARY INDEX. Deliberate — see the write budget in CLAUDE.md. The
-- matcher and the rollup job scan this table. If you add an index here you must
-- recalculate the daily write budget first.
-- ---------------------------------------------------------------------------
CREATE TABLE prediction_snapshots (
  id                    INTEGER PRIMARY KEY,  -- rowid alias, costs no extra write

  observed_at           INTEGER NOT NULL,     -- our poll time
  service_date          TEXT    NOT NULL,

  -- natural key of the prediction: (service_date, trip_id, stop_sequence)
  trip_id               TEXT    NOT NULL,
  stop_sequence         INTEGER NOT NULL,

  route_id              TEXT    NOT NULL,
  direction_id          INTEGER,
  stop_id               TEXT    NOT NULL,     -- mutable attribute, not part of the key

  -- what was promised. Nullable: a prediction may carry an arrival time, a
  -- departure time, both, or neither.
  predicted_arrival     INTEGER,
  predicted_departure   INTEGER,

  -- how far ahead the promise was made. Most important ML feature.
  -- NULL when predicted_arrival is NULL.
  horizon_sec           INTEGER,

  -- ADDED / CANCELLED / NO_DATA / SKIPPED / UNSCHEDULED / NULL.
  -- All three of predicted_arrival, predicted_departure and status being NULL
  -- means the vehicle will not make this stop.
  schedule_relationship TEXT,
  status                TEXT,

  -- 1 = first time we ever saw this natural key. Increments on each change.
  revision              INTEGER NOT NULL,

  -- vehicle state at the moment the prediction was made: a proxy for how far
  -- away the vehicle was, which the November model will need.
  vehicle_id            TEXT,
  vehicle_status        TEXT,                 -- IN_TRANSIT_TO / INCOMING_AT / STOPPED_AT
  vehicle_stop_sequence INTEGER,

  -- from /schedules, cached per service_date. Enables schedule deviation as a
  -- feature. NULL when the prediction has no associated schedule.
  scheduled_arrival     INTEGER
);

-- ---------------------------------------------------------------------------
-- Vehicle position observations, deduplicated: one row per meaningful state
-- change, not one per poll. This is the evidence the matcher uses to establish
-- actual arrival times.
-- ---------------------------------------------------------------------------
CREATE TABLE vehicle_observations (
  id                    INTEGER PRIMARY KEY,

  observed_at           INTEGER NOT NULL,     -- our poll time
  vehicle_updated_at    INTEGER NOT NULL,     -- MBTA's own timestamp — prefer this
  service_date          TEXT    NOT NULL,

  vehicle_id            TEXT    NOT NULL,
  trip_id               TEXT,
  route_id              TEXT,
  direction_id          INTEGER,

  current_status        TEXT    NOT NULL,     -- IN_TRANSIT_TO / INCOMING_AT / STOPPED_AT
  current_stop_sequence INTEGER,
  stop_id               TEXT
);

-- ---------------------------------------------------------------------------
-- What actually happened. One row per (service_date, trip_id, stop_id).
--
-- Written by the matcher, not the collector. Every row carries the provenance
-- and the error bar of its own measurement — never report an aggregate without
-- being able to state its uncertainty.
-- ---------------------------------------------------------------------------
CREATE TABLE arrivals (
  id                INTEGER PRIMARY KEY,

  service_date      TEXT    NOT NULL,
  trip_id           TEXT    NOT NULL,
  stop_id           TEXT    NOT NULL,
  stop_sequence     INTEGER,
  route_id          TEXT,
  direction_id      INTEGER,

  actual_arrival_at INTEGER,                  -- NULL for unresolved_dropout

  -- 'stopped_at'         observed STOPPED_AT the target stop      (~30s)
  -- 'sequence_advanced'  stop_sequence passed it, never seen stopped (~90s)
  -- 'unresolved_dropout' prediction vanished, no vehicle evidence  (unknown)
  -- 'skipped'            schedule_relationship said SKIPPED/CANCELLED
  source            TEXT    NOT NULL,
  uncertainty_sec   INTEGER,                  -- NULL when source is unresolved/skipped

  matched_at        INTEGER NOT NULL,

  UNIQUE (service_date, trip_id, stop_id)
);

-- ---------------------------------------------------------------------------
-- Pre-aggregated rollups so the dashboard never scans raw history.
--
-- This table IS the cache. Same invalidation and staleness questions as any
-- cache: what recomputes it, how stale can it be, what happens to a slice whose
-- underlying arrivals get re-matched later.
--
-- Recomputed by a scheduled job, not on read.
-- ---------------------------------------------------------------------------
CREATE TABLE rollup_error_by_slice (
  stop_id          TEXT    NOT NULL,
  route_id         TEXT    NOT NULL,
  direction_id     INTEGER NOT NULL,
  weekday          INTEGER NOT NULL,          -- 0 = Sunday
  hour             INTEGER NOT NULL,          -- 0-23, local
  horizon_bucket   TEXT    NOT NULL,          -- '0-3' | '3-6' | '6-12' | '12+' minutes

  n                INTEGER NOT NULL,          -- sample size. Always display this.
  mean_error_sec   REAL,                      -- signed; positive = arrived late
  median_error_sec REAL,
  p10_error_sec    REAL,
  p90_error_sec    REAL,
  pct_within_60s   REAL,

  computed_at      INTEGER NOT NULL,

  PRIMARY KEY (stop_id, route_id, direction_id, weekday, hour, horizon_bucket)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Collector state as a single JSON row per key.
--
-- Why not a row per prediction: that would roughly double the daily write
-- count. Why not Workers KV: its free tier allows 1,000 writes/day and the cron
-- fires 1,440 times/day.
--
-- Assumes a SINGLE WRITER. True for a cron-triggered Worker. Name this
-- assumption out loud before anyone else finds it.
-- ---------------------------------------------------------------------------
CREATE TABLE collector_state (
  key        TEXT    NOT NULL PRIMARY KEY,    -- 'prediction_state' | 'vehicle_state'
                                              -- | 'schedule_cache:<service_date>'
  value      TEXT    NOT NULL,                -- JSON
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- One row per cron invocation. Powers the status page and makes gaps in
-- collection visible instead of invisible. Prune to 7 days.
-- ---------------------------------------------------------------------------
CREATE TABLE collector_runs (
  id                INTEGER PRIMARY KEY,
  started_at        INTEGER NOT NULL,
  duration_ms       INTEGER,
  predictions_seen  INTEGER,
  snapshots_written INTEGER,
  vehicles_seen     INTEGER,
  vehicle_rows_written INTEGER,
  api_status        INTEGER,                  -- last HTTP status from MBTA
  error             TEXT                      -- NULL on success
);

-- ---------------------------------------------------------------------------
-- Seed: subway and bus only. Commuter Rail is excluded because stop_id is
-- mutable there (track assignments), which breaks the natural key.
--
-- direction_id 0 and 1 are both worth watching at a stop; start with one each
-- and expand once the write budget is measured against reality.
-- ---------------------------------------------------------------------------
INSERT INTO watched_stops (stop_id, route_id, direction_id, label, added_at) VALUES
  ('place-rugg',  'Orange', 0, 'Ruggles — Orange Line southbound',   unixepoch()),
  ('place-rugg',  'Orange', 1, 'Ruggles — Orange Line northbound',   unixepoch()),
  ('place-nuniv', 'Green-E', 0, 'Northeastern University — Green E outbound', unixepoch()),
  ('place-nuniv', 'Green-E', 1, 'Northeastern University — Green E inbound',  unixepoch());
