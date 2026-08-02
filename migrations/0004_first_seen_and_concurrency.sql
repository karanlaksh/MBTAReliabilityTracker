-- MBTA Reliability Tracker — migration 0004
--
-- Three things, all consequences of the 20-minute horizon cap shipped in the
-- previous deploy.
--
-- ---------------------------------------------------------------------------
-- 1. The prediction's origin, preserved across suppressed writes.
--
-- The horizon cap means the first row we STORE for a prediction is usually not
-- the first time we SAW it. Observed in production: trip 78493012 was revised 66
-- times outside the window, and its first stored row carries revision 67. The
-- revision count survived, but MBTA's original estimate did not — and "what did
-- they first say, and how far did it move" is precisely the question this
-- project exists to answer.
--
-- Tracked in the dedup state blob from the first observation at ANY horizon, and
-- stamped onto every written row. Both are properties of the prediction rather
-- than of the snapshot, so they repeat across a prediction's rows; that is
-- intentional and costs nothing, because D1 bills rows written, not columns.
--
-- Rows written before this migration keep NULL. Not backfilled — the information
-- was never captured and inventing it would be worse than admitting the gap.
-- ---------------------------------------------------------------------------
ALTER TABLE prediction_snapshots ADD COLUMN first_seen_at INTEGER;
ALTER TABLE prediction_snapshots ADD COLUMN first_predicted_arrival INTEGER;

-- ---------------------------------------------------------------------------
-- 2. Concurrent-tick detection.
--
-- Observed once in 324 intervals, at a deploy boundary: two invocations 2
-- seconds apart. The dedup state is a single JSON row updated read-modify-write,
-- so two overlapping ticks would last-write-wins each other — losing revision
-- increments and duplicating snapshot rows, in exactly the feature the horizon
-- cap was shipped to protect.
--
-- The collector now claims the state row with a compare-and-set before writing
-- anything. A tick that loses the race records itself here with
-- concurrent_tick = 1 and writes no data rows.
--
-- 1 = this tick was skipped because another invocation held the state row.
-- ---------------------------------------------------------------------------
ALTER TABLE collector_runs ADD COLUMN concurrent_tick INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. When the horizon cap started, so rollups can tell the two eras apart.
--
-- Rows collected before this instant include predictions at every horizon. Rows
-- after it are capped at 1200s. Any rollup spanning the boundary MUST filter
-- `horizon_sec <= 1200 OR horizon_sec IS NULL`, or the pre-cap era will appear
-- to have systematically worse accuracy purely because it contains long-horizon
-- predictions that the post-cap era does not.
--
-- The timestamp is the first production tick that ran the capped build, read
-- from collector_runs rather than guessed: snapshots_written dropped from 58 to
-- 19 between 01:05:55Z and 01:06:55Z on 2026-08-02.
--
-- Stored as JSON so the threshold travels with the timestamp — a later change to
-- MAX_STORED_HORIZON_SEC needs a new marker, not a silent reinterpretation of
-- this one.
-- ---------------------------------------------------------------------------
INSERT INTO collector_state (key, value, updated_at)
VALUES (
  'horizon_cap_activated_at',
  json_object(
    'activated_at', strftime('%s', '2026-08-02 01:06:55'),
    'max_horizon_sec', 1200,
    'note', 'rollups spanning this instant must filter horizon_sec <= 1200 OR IS NULL'
  ),
  unixepoch()
)
ON CONFLICT(key) DO NOTHING;
