// Build step 5: rollup tables.
//
// Two tables, both FULL RECOMPUTE. See the staleness policy in the README for why
// recompute rather than incremental patching, and for the cadence arithmetic.
//
// All aggregation happens inside D1 as INSERT ... SELECT. Nothing streams through
// the Worker: we already hit "Worker exceeded CPU time limit" on the backfill path
// at 258k snapshots, and pulling ~44,000 bucket-points into JS to aggregate them
// would hit the same wall. SQL keeps the row-by-row work server-side.

import { localHour, serviceDate } from './service-date';
import type { Env } from './collector';

/**
 * Each bucket is ONE EVALUATION HORIZON, named for it — not a band.
 *
 * A band label invites a "pick a row inside the band" rule, and measured on real
 * data that rule graded the old '0-3' band at a mean horizon of 40 seconds: the
 * last prediction before arrival, which converges to zero error and measures MBTA
 * at its easiest. It reported a median error of 1s and looked reasonable.
 */
const BUCKETS: { label: string; h: number }[] = [
  { label: '~1.5 min', h: 90 },
  { label: '~4.5 min', h: 270 },
  { label: '~9 min', h: 540 },
  { label: '~16 min', h: 960 },
];

/** Local hour at which the daily recompute runs. See README staleness policy. */
const RECOMPUTE_LOCAL_HOUR = 4;

export interface RollupStats {
  by_slice_rows: number;
  by_day_rows: number;
  rows_written: number;
  partial_dates: string[];
  duration_ms: number;
  error: string | null;
}

/**
 * Recover the America/New_York UTC offset for a row from data we already compute
 * correctly, rather than hardcoding -4 hours.
 *
 * D1 has no timezone database, so `localtime` is unavailable and a fixed offset
 * would be wrong for five months of the year. But `service_date` was computed in
 * TypeScript with the real rules, and it rolls at 03:00 local — so the offset is
 * whichever of EDT/EST makes (arrival - offset - 3h) land on that service_date.
 * Self-consistent with the collector by construction.
 */
const OFFSET_SQL = `(CASE
  WHEN date(a.actual_arrival_at - 14400 - 10800, 'unixepoch') = a.service_date THEN -14400
  ELSE -18000 END)`;

/**
 * The graded prediction for evaluation horizon H, and the eligibility rule.
 *
 * CARRY-FORWARD: the prediction in effect at horizon H is the LAST SNAPSHOT
 * WRITTEN with horizon_sec >= H — that is, the one with the smallest such
 * horizon_sec, since horizon decreases as time passes and rows are appended in
 * time order. Predictions persist on the display until revised, so an unrevised
 * prediction is still the prediction a rider saw.
 *
 * THE STORED horizon_sec IS A SELECTION CRITERION, NOT THE HORIZON BEING GRADED.
 * A row written at horizon 1100 can be the prediction in effect at horizon 300:
 * the stored value is frozen at write time while the displayed countdown keeps
 * decreasing. Reading it as "the horizon this row is about" is precisely the
 * mistake that produced the 40-second bucket.
 *
 * ELIGIBILITY, and why it is not a rule about ADDED trips: a (trip, stop) counts
 * toward horizon H only if it has any snapshot at horizon >= H. That is exactly
 * the population that could have had a prediction at H. It handles unscheduled
 * ADDED trips — which cannot have a 16-minute-out prediction by construction —
 * and equally handles the late-entering SCHEDULED trips (measured: 49 blocked at
 * ~9 min, 15 at ~4.5 min) that a rule about ADDED would have silently missed.
 * One rule, no exceptions. is_added stays a dimension so the two can be compared.
 */
function gradedSql(h: number): string {
  return `
    SELECT a.stop_id, a.route_id, a.direction_id, a.service_date,
           CASE WHEN a.trip_id LIKE 'ADDED%' THEN 1 ELSE 0 END AS is_added,
           CAST(strftime('%w', a.service_date) AS INTEGER) AS weekday,
           CAST(strftime('%H', a.actual_arrival_at + ${OFFSET_SQL}, 'unixepoch') AS INTEGER) AS hour,
           a.actual_arrival_at - p.predicted_arrival AS err,
           ROW_NUMBER() OVER (
             PARTITION BY a.service_date, a.trip_id, a.stop_id
             ORDER BY p.horizon_sec ASC
           ) AS pick
      FROM arrivals a
      JOIN prediction_snapshots p
        ON p.service_date = a.service_date
       AND p.trip_id      = a.trip_id
       AND p.stop_id      = a.stop_id
     WHERE a.actual_arrival_at IS NOT NULL
       AND p.predicted_arrival IS NOT NULL
       AND p.horizon_sec >= ${h}`;
}

/**
 * Percentiles by ordinal rank. SQLite has no percentile aggregate, so rank within
 * each group and pick. Every group also carries n — nothing in this project
 * reports a median without its sample size.
 */
function statsSql(groupCols: string[], h: number, label: string): string {
  const g = groupCols.join(', ');
  return `
    WITH graded AS (${gradedSql(h)}),
    picked AS (SELECT * FROM graded WHERE pick = 1),
    ranked AS (
      SELECT ${g}, err,
             ROW_NUMBER() OVER (PARTITION BY ${g} ORDER BY err) AS r,
             COUNT(*)     OVER (PARTITION BY ${g})              AS c,
             AVG(err)     OVER (PARTITION BY ${g})              AS mean_err,
             AVG(CASE WHEN ABS(err) <= 60 THEN 1.0 ELSE 0.0 END)
               OVER (PARTITION BY ${g})                         AS within60
        FROM picked
    )
    SELECT ${g}, '${label}' AS horizon_bucket, MAX(c) AS n,
           MAX(mean_err) AS mean_error_sec,
           MAX(CASE WHEN r = (c + 1) / 2 THEN err END) AS median_error_sec,
           MAX(CASE WHEN r = MAX(1, CAST(c * 0.1 AS INTEGER)) THEN err END) AS p10_error_sec,
           MAX(CASE WHEN r = MAX(1, CAST(c * 0.9 AS INTEGER)) THEN err END) AS p90_error_sec,
           MAX(within60) AS pct_within_60s
      FROM ranked GROUP BY ${g}`;
}

export async function runRollup(env: Env, startedAtMs: number): Promise<RollupStats> {
  const now = Math.floor(startedAtMs / 1000);
  const stats: RollupStats = {
    by_slice_rows: 0,
    by_day_rows: 0,
    rows_written: 0,
    partial_dates: [],
    duration_ms: 0,
    error: null,
  };

  try {
    // The service date currently in progress. Its arrivals are still being
    // matched — settlement waits 30 minutes past last predicted arrival — so any
    // figure for it is incomplete by construction, not by accident.
    const openDate = serviceDate(now);
    stats.partial_dates = [openDate];

    // --- table 1: the typical-week grid -----------------------------------
    // DELETE + INSERT rather than upsert: a full recompute must also remove cells
    // that no longer have data, which an upsert cannot do. The delete roughly
    // doubles the write cost and is budgeted for.
    const sliceCols = ['stop_id', 'route_id', 'direction_id', 'weekday', 'hour', 'is_added'];
    await env.DB.prepare('DELETE FROM rollup_error_by_slice').run();
    for (const b of BUCKETS) {
      const res = await env.DB.prepare(
        `INSERT INTO rollup_error_by_slice
           (stop_id, route_id, direction_id, weekday, hour, horizon_bucket, is_added,
            n, mean_error_sec, median_error_sec, p10_error_sec, p90_error_sec,
            pct_within_60s, computed_at)
         SELECT stop_id, route_id, direction_id, weekday, hour, horizon_bucket, is_added,
                n, mean_error_sec, median_error_sec, p10_error_sec, p90_error_sec,
                pct_within_60s, ${now}
           FROM (${statsSql(sliceCols, b.h, b.label)})`,
      ).run();
      stats.by_slice_rows += res.meta?.changes ?? 0;
    }

    // --- table 2: day grain ------------------------------------------------
    // Exists because table 1 has NO DATE DIMENSION and so cannot express a
    // before/during/after comparison at all. Its purpose is time series, and
    // specifically Green-E: Aug 3-7 running vs Aug 8-16 suspended, on Orange and
    // bus 39 — slices that stay collectable through both windows.
    const dayCols = ['service_date', 'stop_id', 'route_id', 'direction_id', 'is_added'];
    await env.DB.prepare('DELETE FROM rollup_error_by_day').run();
    for (const b of BUCKETS) {
      const res = await env.DB.prepare(
        `INSERT INTO rollup_error_by_day
           (service_date, stop_id, route_id, direction_id, horizon_bucket, is_added,
            n, mean_error_sec, median_error_sec, p10_error_sec, p90_error_sec,
            pct_within_60s, arrivals_total, unfulfilled, no_arrival_predicted,
            is_partial, computed_at)
         SELECT s.service_date, s.stop_id, s.route_id, s.direction_id,
                s.horizon_bucket, s.is_added,
                s.n, s.mean_error_sec, s.median_error_sec, s.p10_error_sec,
                s.p90_error_sec, s.pct_within_60s,
                d.graded, d.unfulfilled, d.not_promised,
                CASE WHEN s.service_date >= ?1 THEN 1 ELSE 0 END,
                ${now}
           FROM (${statsSql(dayCols, b.h, b.label)}) s
           LEFT JOIN (
             SELECT service_date, stop_id, route_id, direction_id,
                    SUM(CASE WHEN source <> 'no_arrival_predicted' THEN 1 ELSE 0 END) AS graded,
                    SUM(CASE WHEN source IN ('skipped','unresolved_dropout') THEN 1 ELSE 0 END) AS unfulfilled,
                    SUM(CASE WHEN source = 'no_arrival_predicted' THEN 1 ELSE 0 END) AS not_promised
               FROM arrivals GROUP BY 1,2,3,4
           ) d
             ON d.service_date = s.service_date AND d.stop_id = s.stop_id
            AND d.route_id = s.route_id AND d.direction_id = s.direction_id`,
      )
        .bind(openDate)
        .run();
      stats.by_day_rows += res.meta?.changes ?? 0;
    }

    stats.rows_written = stats.by_slice_rows + stats.by_day_rows;
  } catch (err) {
    stats.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('rollup failed', stats.error);
  }

  stats.duration_ms = Date.now() - startedAtMs;
  return stats;
}

/**
 * Whether this matcher tick should also recompute rollups.
 *
 * Gated on LOCAL hour rather than a fixed UTC cron. 04:00 local is 08:00 UTC in
 * summer but 09:00 UTC in winter, so a fixed UTC schedule would drift — and it
 * would drift onto 03:00 local, which is the service-date rollover boundary and
 * the worst possible moment to sample.
 *
 * 04:00 local, not midnight: service dates roll at 03:00 and settlement waits 30
 * minutes past a trip's last predicted arrival, so the previous service date is
 * not fully graded until roughly 03:30-04:00. A midnight recompute would leave
 * the most recent day partially graded every single time.
 */
export function shouldRecompute(now: number, minuteOfHour: number): boolean {
  return localHour(now) === RECOMPUTE_LOCAL_HOUR && minuteOfHour < 15;
}

export const __test = { BUCKETS, shouldRecompute, gradedSql, statsSql };
