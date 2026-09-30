-- MBTA Reliability Tracker — migration 0011
--
-- The typical-week grid, rebuilt on COMPOSABLE statistics so it accumulates
-- across service dates.
--
-- Why this exists: rollup_error_by_slice held medians, and medians do not
-- compose — a cell could only be recomputed from every prediction behind it,
-- which the read budget limited to a rolling 7 days. That gave each cell about
-- one day of data (mean n 7), so the display gate (60% of cells at n >= 20) could
-- never open, however long the collector ran.
--
-- A cell here holds only sums and counts. Adding a new service date is exact
-- arithmetic — n + n', sum + sum' — so a date is folded in ONCE, when it is
-- final, and never re-read. That is also why the "prediction error is never
-- stored" rule in CLAUDE.md still holds: no per-prediction row is kept, only
-- per-cell totals that merge without approximation.
--
-- All four are stored; only the share within 60s is displayed (it is exact, it
-- resists outliers, and it reads without a footnote: "4 in 10 predictions at
-- Ruggles at 8am are within a minute"). The mean signed error and mean absolute
-- error are kept for later views; recovering them later would mean re-reading
-- every folded date.
--
-- WITHOUT ROWID with the cell key as primary key: no secondary index, so no
-- extra written row per upsert.
CREATE TABLE rollup_grid_totals (
  stop_id        TEXT    NOT NULL,
  route_id       TEXT    NOT NULL,
  direction_id   INTEGER NOT NULL,
  weekday        INTEGER NOT NULL,   -- 0 = Sunday, from service_date
  hour           INTEGER NOT NULL,   -- local hour of the actual arrival
  horizon_bucket TEXT    NOT NULL,
  is_added       INTEGER NOT NULL,
  n              INTEGER NOT NULL,   -- graded predictions
  sum_err        INTEGER NOT NULL,   -- Σ signed error, seconds  -> mean = sum_err / n
  sum_abs_err    INTEGER NOT NULL,   -- Σ |error|, seconds       -> MAE  = sum_abs_err / n
  n_within_60    INTEGER NOT NULL,   -- count with |error| <= 60 -> share = n_within_60 / n
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (stop_id, route_id, direction_id, weekday, hour, horizon_bucket, is_added)
) WITHOUT ROWID;

-- One row per service date already folded into rollup_grid_totals. The fold and
-- this marker commit in one transaction, and the fold refuses a date that has a
-- marker, so re-running can never count a date twice.
CREATE TABLE rollup_grid_folded (
  service_date TEXT    PRIMARY KEY,
  folded_at    INTEGER NOT NULL,
  rows_read    INTEGER            -- D1's own measure of what folding it cost
) WITHOUT ROWID;
