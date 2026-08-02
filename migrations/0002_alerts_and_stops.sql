-- MBTA Reliability Tracker — migration 0002
--
-- Purpose: capture service alerts, so a gap in the data carries its own
-- explanation, and expand the watched set before the Aug 8–16 Green-E diversion.
--
-- Motivation: the Green Line E branch is shut between North Station and Heath St
-- on Aug 1–2 and again Aug 8–16. Northeastern University sits on that stretch.
-- Without alert capture, those days look identical to a broken collector.
--
-- With it, they become the most interesting slice in the dataset: prediction
-- accuracy before / during / after a known, planned service disruption.

-- ---------------------------------------------------------------------------
-- watched_stops metadata
--
-- mode: terminal and bus stops need to be analysed separately from mid-line
-- subway stops, so the rollup can avoid comparing unlike things.
--
-- stop_role: at a terminus, trains sit and depart rather than arrive, and MBTA's
-- own display guidance says to show departure_time rather than arrival_time
-- there. Terminal "arrival" predictions therefore mean something different.
-- Tag it now so this is a filter later rather than a confound discovered later.
-- ---------------------------------------------------------------------------
ALTER TABLE watched_stops ADD COLUMN mode TEXT;       -- 'subway' | 'bus'
ALTER TABLE watched_stops ADD COLUMN stop_role TEXT;  -- 'mid_line' | 'terminus'

UPDATE watched_stops SET mode = 'subway', stop_role = 'mid_line'
  WHERE stop_id IN ('place-rugg', 'place-nuniv');

-- ---------------------------------------------------------------------------
-- Per-slice prediction counts, as JSON on the existing run row.
--
-- Deliberately NOT a table of one row per slice per tick: that would add
-- ~6,000-12,000 writes/day for data that is only ever read as a group. Stored
-- as a single JSON column so it costs zero additional writes.
--
-- Shape: {"place-rugg|Orange|0": 5, "place-nuniv|Green-E|1": 0, ...}
--
-- This is what lets the status page say "Green-E returned 0 predictions AND an
-- alert was active" rather than just showing a suspicious flat line.
-- ---------------------------------------------------------------------------
ALTER TABLE collector_runs ADD COLUMN per_slice_counts TEXT;

-- ---------------------------------------------------------------------------
-- Alert history.
--
-- Append-only and deduplicated on content: alerts change rarely, so this costs
-- on the order of tens to low hundreds of writes per day, not thousands.
--
-- No index, same reasoning as prediction_snapshots — the rollup joins by
-- scanning, and this table stays small.
--
-- Whether an alert was active for a given prediction is DERIVED at rollup time
-- by joining observed_at against the active period. Not stored per prediction.
-- Same principle as prediction error.
-- ---------------------------------------------------------------------------
CREATE TABLE alert_snapshots (
  id                  INTEGER PRIMARY KEY,

  observed_at         INTEGER NOT NULL,   -- our poll time
  service_date        TEXT    NOT NULL,

  alert_id            TEXT    NOT NULL,   -- MBTA's alert id, stable across updates
  mbta_updated_at     INTEGER,            -- MBTA's own updated_at; prefer for dedup

  -- SHUTTLE / DETOUR / DELAY / STOP_CLOSURE / STATION_CLOSURE / SUSPENSION /
  -- SERVICE_CHANGE / etc. SHUTTLE and SUSPENSION are the ones that produce
  -- zero-prediction periods.
  effect              TEXT,
  cause               TEXT,
  severity            INTEGER,            -- 0-10
  lifecycle           TEXT,               -- NEW / ONGOING / UPCOMING / ONGOING_UPCOMING

  header              TEXT,               -- human-readable, for the status page

  -- An alert can have several active periods. Store the one that covers or next
  -- follows observed_at; the full list goes in active_periods_json.
  active_period_start INTEGER,
  active_period_end   INTEGER,            -- NULL = open-ended
  active_periods_json TEXT,

  -- JSON arrays of affected route_ids / stop_ids, from informed_entity.
  -- Denormalised on purpose: joining these is a rollup-time scan, and the table
  -- is small enough that scanning is cheaper than the write cost of an index.
  affected_routes     TEXT,
  affected_stops      TEXT,

  -- 1 when this alert overlaps a currently active watched_stops slice. Computed
  -- by the collector at write time because it needs the watched set, which the
  -- rollup job would otherwise have to re-derive.
  affects_watched     INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- New watched slices.
--
-- Orange Line additions are unaffected by the Green-E diversion, so the dataset
-- keeps a clean baseline through August.
--
-- place-masta  Massachusetts Avenue — mid-line, walkable from campus
-- place-forhl  Forest Hills — southern terminus. Tagged as such; terminal
--              arrival semantics differ and must not be pooled with mid-line
--              stops in a rollup.
--
-- Bus route 39 is INTENTIONALLY NOT SEEDED HERE. Bus stop_ids are numeric and
-- not guessable — resolve them from /stops?filter[route]=39 and insert the real
-- ones. Route 39 runs Forest Hills to Back Bay along Huntington Ave, parallel to
-- the Green-E stretch being shut down, so it should absorb displaced riders
-- during the diversion. Pick a stop near Northeastern, both directions.
-- ---------------------------------------------------------------------------
INSERT INTO watched_stops
  (stop_id, route_id, direction_id, label, mode, stop_role, added_at)
VALUES
  ('place-masta', 'Orange', 0, 'Massachusetts Ave — Orange southbound',
     'subway', 'mid_line', unixepoch()),
  ('place-masta', 'Orange', 1, 'Massachusetts Ave — Orange northbound',
     'subway', 'mid_line', unixepoch()),
  ('place-forhl', 'Orange', 0, 'Forest Hills — Orange southbound (terminus)',
     'subway', 'terminus', unixepoch()),
  ('place-forhl', 'Orange', 1, 'Forest Hills — Orange northbound (terminus)',
     'subway', 'terminus', unixepoch());

-- ---------------------------------------------------------------------------
-- Route 39 stops, resolved from /stops?filter[route]=39&filter[direction_id]=N
-- on 2026-08-01, choosing the nearest stop to Northeastern in each direction.
--
-- Unlike the subway, the two directions are DIFFERENT physical stops on opposite
-- sides of Huntington Ave, not two directions at one parent station — hence two
-- distinct stop_ids rather than one repeated. Bus stops have no parent_station,
-- so these numeric ids are what predictions and vehicles report directly, and
-- the collector's parent-station normalisation is a no-op for them.
--
--   41391  Huntington Ave @ Opera Pl   128 m from campus, outbound to Forest Hills
--   81317  360 Huntington Ave          111 m from campus, inbound to Back Bay
--
-- Both are intermediate stops far from either terminus, so mid_line.
-- ---------------------------------------------------------------------------
INSERT INTO watched_stops
  (stop_id, route_id, direction_id, label, mode, stop_role, added_at)
VALUES
  ('41391', '39', 0, 'Huntington Ave @ Opera Pl — Route 39 outbound',
     'bus', 'mid_line', unixepoch()),
  ('81317', '39', 1, '360 Huntington Ave — Route 39 inbound',
     'bus', 'mid_line', unixepoch());
