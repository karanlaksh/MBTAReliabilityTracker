-- MBTA Reliability Tracker — migration 0007
--
-- Build step 5: rollup tables.
--
-- ---------------------------------------------------------------------------
-- BUCKETS ARE NOW LABELLED BY EVALUATION POINT, NOT BY BAND.
--
-- migration 0001 defined horizon_bucket as '0-3' | '3-6' | '6-12' | '12+'.
-- Both halves of that are now wrong:
--
--   '12+' predates the horizon cap. Nothing above 1200s has been written since
--   2026-08-02, so an open-ended top band cannot be populated and would silently
--   mix the pre-cap and post-cap eras if it ever were.
--
--   The band labels themselves were actively misleading. A band label invites a
--   "pick a row inside the band" rule, and measured on real data that rule graded
--   the '0-3' band at a mean horizon of 40 SECONDS -- i.e. the last prediction
--   before arrival, which converges to zero error and measures MBTA at its
--   easiest. It reported a median error of 1s. The label is what let that look
--   reasonable.
--
-- So a bucket is now a single evaluation horizon, named for it:
--
--   '~1.5 min'  graded at  90s
--   '~4.5 min'  graded at 270s
--   '~9 min'    graded at 540s
--   '~16 min'   graded at 960s
--
-- Each point sits inside its old band, so the four are still comparable to the
-- earlier preliminary figures, but nothing about the name suggests a range.
--
-- ---------------------------------------------------------------------------
-- CARRY-FORWARD, and what horizon_sec means here.
--
-- The prediction graded at horizon H is THE LAST SNAPSHOT WRITTEN WITH
-- horizon_sec >= H. Predictions persist on the display until revised, so that row
-- is what a rider saw when the countdown showed H.
--
-- CRITICAL: the stored horizon_sec is a SELECTION CRITERION, NOT THE HORIZON
-- BEING GRADED. A row written at horizon 1100 can be the prediction in effect at
-- horizon 300 -- the stored value stays fixed while the displayed countdown keeps
-- decreasing. Reading horizon_sec as "the horizon this row is about" is the
-- mistake that produced the 40-second '0-3' bucket.
--
-- This is why a trip contributes to a bucket even with no row inside the old
-- band: change-based dedup only writes on revision, and an unrevised prediction
-- is still the prediction in effect.
--
-- ---------------------------------------------------------------------------
-- is_added is a DIMENSION, NOT A FILTER.
--
-- ADDED trips are unscheduled service, and unscheduled service is inserted during
-- disruption -- precisely the population a diversion comparison is about.
-- Filtering them would delete the signal. They also cannot have a 16-minute-out
-- prediction by construction, so their absence from the long-horizon bucket is
-- ineligibility rather than missing data, and splitting on this dimension is what
-- makes that visible instead of confounding.
-- ---------------------------------------------------------------------------

-- Recreated rather than altered: the bucket vocabulary changed and is_added joins
-- the primary key. The table has never held a row, so nothing is lost.
DROP TABLE IF EXISTS rollup_error_by_slice;

-- ---------------------------------------------------------------------------
-- 1. The "typical week" grid. Bounded cardinality regardless of how many days
--    accumulate: 10 slices x 7 weekdays x ~20 hours x 4 buckets x 2 = ~11,200
--    cells maximum.
--
--    Deliberately populated now even though it is far too sparse to display --
--    roughly 6 bucket-points per cell today, which is nowhere near enough for a
--    median. Populating it now means the schema does not change once it is dense
--    enough to be useful.
-- ---------------------------------------------------------------------------
CREATE TABLE rollup_error_by_slice (
  stop_id          TEXT    NOT NULL,
  route_id         TEXT    NOT NULL,
  direction_id     INTEGER NOT NULL,
  weekday          INTEGER NOT NULL,          -- 0 = Sunday, local
  hour             INTEGER NOT NULL,          -- 0-23, local
  horizon_bucket   TEXT    NOT NULL,          -- '~1.5 min' | '~4.5 min' | '~9 min' | '~16 min'
  is_added         INTEGER NOT NULL,          -- 1 = unscheduled (ADDED) trip

  n                INTEGER NOT NULL,          -- sample size. ALWAYS displayed.
  mean_error_sec   REAL,                      -- signed; positive = arrived late
  median_error_sec REAL,
  p10_error_sec    REAL,
  p90_error_sec    REAL,
  pct_within_60s   REAL,

  computed_at      INTEGER NOT NULL,

  PRIMARY KEY (stop_id, route_id, direction_id, weekday, hour, horizon_bucket, is_added)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 2. Day grain. ~80 rows/day (10 slices x 4 buckets x 2 is_added values).
--
--    Exists because table 1 has NO DATE DIMENSION and therefore cannot express a
--    before/during/after comparison at all. Its whole purpose is time series and
--    specifically the Green-E diversion: Aug 3-7 running vs Aug 8-16 suspended,
--    on Orange and bus 39, which are unaffected slices that stay collectable
--    throughout both windows.
--
--    is_added is carried here too, beyond the minimum needed for the comparison,
--    because "did unscheduled service behave differently during the diversion"
--    is unanswerable without it and table 1 cannot answer it for lack of a date.
--    The cost is ~40 extra rows/day.
--
--    unfulfilled and no_arrival_predicted are counted per row so no figure from
--    this table can be quoted without its denominator context: a median that
--    excludes the trains that never came is optimistic in exactly the cases that
--    matter.
-- ---------------------------------------------------------------------------
CREATE TABLE rollup_error_by_day (
  service_date          TEXT    NOT NULL,
  stop_id               TEXT    NOT NULL,
  route_id              TEXT    NOT NULL,
  direction_id          INTEGER NOT NULL,
  horizon_bucket        TEXT    NOT NULL,
  is_added              INTEGER NOT NULL,

  n                     INTEGER NOT NULL,
  mean_error_sec        REAL,
  median_error_sec      REAL,
  p10_error_sec         REAL,
  p90_error_sec         REAL,
  pct_within_60s        REAL,

  -- Denominator context, repeated per bucket row for the (date, slice).
  arrivals_total        INTEGER,   -- graded arrivals for this slice/date
  unfulfilled           INTEGER,   -- skipped + unresolved_dropout
  no_arrival_predicted  INTEGER,   -- un-promised; NOT part of unfulfilled

  computed_at           INTEGER NOT NULL,

  PRIMARY KEY (service_date, stop_id, route_id, direction_id, horizon_bucket, is_added)
) WITHOUT ROWID;
