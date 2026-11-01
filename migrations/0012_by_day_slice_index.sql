-- MBTA Reliability Tracker — migration 0012
--
-- A secondary index on rollup_error_by_day, for the trip assistant's day-level
-- lookup (src/ask.ts): one slice's daily median and p90 across all history.
--
-- Why: the table's primary key leads with service_date, so filtering by slice
-- cannot seek and scans the whole table — 3,890 rows on 2026-11-01, growing
-- ~55-60 rows per service date. That is a per-question cost that scales with
-- accumulated data, the same shape as the September read-budget exhaustion.
-- With this index the lookup reads the slice's own rows: ~70, growing ~1 a day.
--
-- Why not bound the scan with a date range instead: it works (~1,600 rows for
-- four weeks, constant), but the answer's hour share comes from the all-history
-- grid, so the median and p90 would cover a different window from the share
-- beside them in the same sentence. One answer, two windows, nothing to say so.
--
-- WRITE COST — this does not contradict the no-secondary-index rule in
-- CLAUDE.md. That rule protects prediction_snapshots, which takes ~31-34k
-- writes a weekday (measured Oct 26-30): an index there would add about a third
-- of the 100k/day cap. This table is rewritten 3 service dates per rollup run
-- (BY_DAY_RECENT_DAYS), ~60 rows each: ~180 deletes + ~180 inserts, so the
-- index adds ~360 written rows a day (~0.4% of the cap), plus ~360 per manual
-- POST /rollup. Building it is a one-time ~3,890 writes.
--
-- Column order: the assistant's equality filters first, service_date last, so a
-- slice's rows are contiguous and come back in date order.

CREATE INDEX idx_by_day_slice
  ON rollup_error_by_day (stop_id, route_id, direction_id, horizon_bucket, is_added, service_date);
