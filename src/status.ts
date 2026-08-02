// The write-budget guardrail.
//
// D1's free tier allows 100,000 row writes per day. Measured consumption is
// ~60,000-95,000. Exceeding it does not degrade gracefully: writes start
// failing, and every minute lost is unrecoverable because MBTA predictions are
// ephemeral. This module is what makes that visible before it happens.
//
// THE RESET BOUNDARY IS UTC, NOT THE SERVICE DATE. Cloudflare's daily quota
// resets at 00:00 UTC. Everything else in this project uses a service date that
// rolls over at 03:00 America/New_York. Using the service date here would
// misreport the budget by 4-5 hours of writes every single day.

import type { Env } from './collector';

/** D1 free tier, rows written per UTC day. */
export const DAILY_WRITE_LIMIT = 100_000;

/** Fractions of the daily limit at which the reported level changes. */
const WARN_AT = 0.7;
const CRITICAL_AT = 0.9;

/** A tick is due every 60s; beyond this we are missing ticks and losing data. */
const STALE_AFTER_SEC = 150;

const DAY_SEC = 86_400;

export type BudgetLevel = 'ok' | 'warn' | 'critical';

export function utcDayStart(now: number): number {
  return Math.floor(now / DAY_SEC) * DAY_SEC;
}

function level(fraction: number): BudgetLevel {
  if (fraction >= CRITICAL_AT) return 'critical';
  if (fraction >= WARN_AT) return 'warn';
  return 'ok';
}

/**
 * Project end-of-day writes from what has been spent so far.
 *
 * Two estimates, because neither is trustworthy alone:
 *
 *   recent_rate — the last hour's rate held for the rest of the UTC day. Responds
 *                 immediately to a change in write volume, but overshoots badly
 *                 when the current hour is a rush-hour peak, and undershoots
 *                 overnight.
 *   flat_rate   — today's average rate so far held for the rest of the day.
 *                 Steadier, but slow to react and meaningless early in the day.
 *
 * The reported level uses the HIGHER of the two. A guardrail that under-reports
 * is worse than useless, because the failure it guards against is silent.
 */
export function project(
  writesToday: number,
  writesLastHour: number,
  now: number,
): {
  projected_eod: number;
  projected_by_recent_rate: number;
  projected_by_flat_rate: number;
  level: BudgetLevel;
} {
  const elapsed = Math.max(1, now - utcDayStart(now));
  const remaining = Math.max(0, DAY_SEC - elapsed);

  const recentPerSec = writesLastHour / Math.min(3600, elapsed);
  const flatPerSec = writesToday / elapsed;

  const byRecent = Math.round(writesToday + recentPerSec * remaining);
  const byFlat = Math.round(writesToday + flatPerSec * remaining);
  const projected = Math.max(byRecent, byFlat);

  return {
    projected_eod: projected,
    projected_by_recent_rate: byRecent,
    projected_by_flat_rate: byFlat,
    level: level(projected / DAILY_WRITE_LIMIT),
  };
}

interface RunRow {
  started_at: number;
  duration_ms: number | null;
  predictions_seen: number | null;
  snapshots_written: number | null;
  vehicle_rows_written: number | null;
  rows_written: number | null;
  api_status: number | null;
  error: string | null;
  error_kind: string | null;
  per_slice_counts: string | null;
  concurrent_tick: number | null;
}

/**
 * `rows_written` is NULL for rows recorded before migration 0003. Reconstruct it
 * from the columns that did exist so the budget counter is not silently short by
 * however many ticks predate the migration.
 */
const ROWS_WRITTEN_SQL =
  'COALESCE(rows_written, snapshots_written + vehicle_rows_written + 2)';

/**
 * Horizon buckets, in seconds. Upper bound is MAX_STORED_HORIZON_SEC: nothing
 * above 20 minutes is stored post-cap, so a '12+' bucket would silently mix the
 * capped and pre-cap eras.
 */
const BUCKET_SQL = `CASE
  WHEN p.horizon_sec < 180  THEN '0-3'
  WHEN p.horizon_sec < 360  THEN '3-6'
  WHEN p.horizon_sec < 720  THEN '6-12'
  ELSE '12-20' END`;

/**
 * Preliminary error summary. Computed on the fly over a bounded recent window —
 * no rollup table until step 5.
 *
 * THE GRADING UNIT IS HORIZON, NOT REVISION. A rider sees one prediction: the one
 * on screen when they looked. So each (trip, stop) contributes exactly ONE point
 * per horizon bucket, chosen as the snapshot with the largest horizon_sec inside
 * that bucket — the prediction displayed as the trip first entered the band.
 *
 * Grading every revision instead would let a trip MBTA fidgeted about 40 times
 * outvote a stable trip 40:1. Fidgeting correlates with delay, so that would
 * weight the average toward chaotic trips — a sampling artefact of our own making.
 *
 * Error is signed, actual minus predicted: positive means the train arrived later
 * than promised. Horizon is the horizon MBTA DISPLAYED, not true time remaining,
 * so a train running 10 minutes late has its "5 minute" snapshot graded at +10
 * minutes. That is what the rider experienced, and it is intended.
 */
async function errorByHorizon(env: Env, since: number) {
  const { results } = await env.DB.prepare(
    `WITH graded AS (
       SELECT p.service_date, p.trip_id, p.stop_id, ${BUCKET_SQL} AS bucket,
              p.horizon_sec,
              a.actual_arrival_at - p.predicted_arrival AS err
         FROM prediction_snapshots p
         JOIN arrivals a
           ON a.service_date = p.service_date
          AND a.trip_id      = p.trip_id
          AND a.stop_id      = p.stop_id
        WHERE a.actual_arrival_at IS NOT NULL
          AND p.predicted_arrival IS NOT NULL
          AND p.horizon_sec BETWEEN 0 AND 1200
          AND p.observed_at >= ?
     ),
     picked AS (
       SELECT bucket, err,
              ROW_NUMBER() OVER (
                PARTITION BY service_date, trip_id, stop_id, bucket
                ORDER BY horizon_sec DESC
              ) AS pick
         FROM graded
     ),
     ranked AS (
       SELECT bucket, err,
              ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY err) AS rn,
              COUNT(*)     OVER (PARTITION BY bucket)              AS c
         FROM picked WHERE pick = 1
     )
     SELECT bucket,
            MAX(c) AS n,
            MAX(CASE WHEN rn = (c + 1) / 2 THEN err END) AS median_error_sec,
            MAX(CASE WHEN rn = MAX(1, CAST(c * 0.9 AS INTEGER)) THEN err END) AS p90_error_sec
       FROM ranked GROUP BY bucket`,
  )
    .bind(since)
    .all<{ bucket: string; n: number; median_error_sec: number; p90_error_sec: number }>();

  const order = ['0-3', '3-6', '6-12', '12-20'];
  return (results ?? []).sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
}

async function arrivalsSummary(env: Env, since: number) {
  const { results } = await env.DB.prepare(
    `SELECT source, COUNT(*) AS n,
            SUM(CASE WHEN actual_arrival_at IS NULL THEN 1 ELSE 0 END) AS without_time,
            SUM(implausible) AS implausible,
            CAST(AVG(uncertainty_sec) AS INTEGER) AS mean_uncertainty_sec
       FROM arrivals WHERE matched_at >= ? GROUP BY source ORDER BY n DESC`,
  )
    .bind(since)
    .all<{
      source: string;
      n: number;
      without_time: number;
      implausible: number;
      mean_uncertainty_sec: number;
    }>();
  return results ?? [];
}

export async function buildStatus(env: Env, now: number): Promise<Record<string, unknown>> {
  const dayStart = utcDayStart(now);

  const [last, today, hour, failures] = await Promise.all([
    env.DB.prepare(
      `SELECT started_at, duration_ms, predictions_seen, snapshots_written,
              vehicle_rows_written, rows_written, api_status, error, error_kind,
              per_slice_counts, concurrent_tick
         FROM collector_runs ORDER BY id DESC LIMIT 1`,
    ).first<RunRow>(),

    env.DB.prepare(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(${ROWS_WRITTEN_SQL}), 0) AS writes,
              COALESCE(SUM(snapshots_written), 0) AS snapshots,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(concurrent_tick), 0) AS concurrent,
              MAX(CASE WHEN concurrent_tick = 1 THEN started_at END) AS last_concurrent_at
         FROM collector_runs WHERE started_at >= ?`,
    )
      .bind(dayStart)
      .first<{
        runs: number;
        writes: number;
        snapshots: number;
        failed: number;
        concurrent: number;
        last_concurrent_at: number | null;
      }>(),

    env.DB.prepare(
      `SELECT COALESCE(SUM(${ROWS_WRITTEN_SQL}), 0) AS writes, COUNT(*) AS runs
         FROM collector_runs WHERE started_at >= ?`,
    )
      .bind(Math.max(dayStart, now - 3600))
      .first<{ writes: number; runs: number }>(),

    // Grouped by kind so a budget failure is never buried in a pile of unrelated
    // MBTA 503s. This is the query the guardrail exists for.
    env.DB.prepare(
      `SELECT error_kind, COUNT(*) AS n, MAX(started_at) AS last_at
         FROM collector_runs
        WHERE started_at >= ? AND error_kind IS NOT NULL
        GROUP BY error_kind ORDER BY n DESC`,
    )
      .bind(dayStart)
      .all<{ error_kind: string; n: number; last_at: number }>(),
  ]);

  // Bounded window for the derived summaries: 48h of matched arrivals.
  const summarySince = now - 172_800;
  const [bySource, errorSummary] = await Promise.all([
    arrivalsSummary(env, summarySince),
    errorByHorizon(env, summarySince),
  ]);

  // Unfulfilled = a prediction that never produced an arrival. 'skipped' and
  // 'unresolved_dropout' both count; 'no_arrival_predicted' does NOT, because
  // MBTA never promised an arrival there. Un-promised is not unfulfilled, and
  // conflating them would inflate this rate with cases that are not failures.
  const UNFULFILLED = new Set(['skipped', 'unresolved_dropout']);
  const graded = bySource
    .filter((r) => r.source !== 'no_arrival_predicted')
    .reduce((n, r) => n + r.n, 0);
  const unfulfilled = bySource
    .filter((r) => UNFULFILLED.has(r.source))
    .reduce((n, r) => n + r.n, 0);
  const notPromised = bySource
    .filter((r) => r.source === 'no_arrival_predicted')
    .reduce((n, r) => n + r.n, 0);

  const writesToday = Number(today?.writes ?? 0);
  const projection = project(writesToday, Number(hour?.writes ?? 0), now);

  const secondsSinceLastRun = last ? now - last.started_at : null;
  const stale = secondsSinceLastRun === null || secondsSinceLastRun > STALE_AFTER_SEC;

  const byKind: Record<string, { count: number; last_at: number }> = {};
  for (const row of failures?.results ?? []) {
    byKind[row.error_kind] = { count: row.n, last_at: row.last_at };
  }
  const d1LimitHits = byKind['d1_limit']?.count ?? 0;

  return {
    // --- liveness -----------------------------------------------------------
    // `collecting` is false if we are stale OR actively hitting the write limit.
    // Those are the two states in which data is being permanently lost.
    collecting: !stale && d1LimitHits === 0,
    stale,
    seconds_since_last_run: secondsSinceLastRun,
    now,

    // --- write budget -------------------------------------------------------
    write_budget: {
      limit: DAILY_WRITE_LIMIT,
      used_today: writesToday,
      remaining: Math.max(0, DAILY_WRITE_LIMIT - writesToday),
      pct_used: Number(((100 * writesToday) / DAILY_WRITE_LIMIT).toFixed(1)),
      pct_projected: Number(
        ((100 * projection.projected_eod) / DAILY_WRITE_LIMIT).toFixed(1),
      ),
      ...projection,
      writes_last_hour: Number(hour?.writes ?? 0),
      // Quota resets at 00:00 UTC, not at the 03:00 America/New_York service-date
      // boundary used elsewhere in this project.
      utc_day_start: dayStart,
      seconds_until_reset: dayStart + DAY_SEC - now,
    },

    // --- concurrency --------------------------------------------------------
    // Ticks that stood down because another invocation held the dedup state row.
    // A cluster of these at a deploy timestamp is the known benign artefact; a
    // steady trickle at ordinary times is not, and means cron delivery is
    // genuinely overlapping.
    concurrency: {
      concurrent_ticks_today: Number(today?.concurrent ?? 0),
      last_concurrent_at: today?.last_concurrent_at ?? null,
    },

    // --- failures, classified ----------------------------------------------
    failures: {
      // Non-zero means writes are being rejected right now and the data for
      // those ticks is gone for good.
      d1_limit_hits_today: d1LimitHits,
      runs_today: Number(today?.runs ?? 0),
      failed_runs_today: Number(today?.failed ?? 0),
      by_kind: byKind,
    },

    // --- matching -----------------------------------------------------------
    // Never report an aggregate without its sample size and its unfulfilled rate.
    // A median error that quietly excludes the trains that never came is
    // systematically optimistic, and optimistic in exactly the cases that matter.
    matching: {
      window_hours: 48,
      arrivals_by_source: bySource,
      graded_predictions: graded,
      unfulfilled,
      unfulfilled_rate: graded > 0 ? Number((unfulfilled / graded).toFixed(4)) : null,
      // Reported beside the rate, not inside it: MBTA published a departure time
      // but never an arrival time, so there was nothing to fulfil. Grading
      // departures is scoped out, not impossible — see README.
      no_arrival_predicted: notPromised,
      error_by_horizon_bucket: errorSummary,

      // Matched arrivals more than an hour from what was last predicted. These
      // indicate a matcher fault, not a transit event — an unbounded turnaround
      // search once produced 167 of them, wrong by up to 16 hours.
      //
      // FLAGGED, NEVER DROPPED, and still present in every aggregate above.
      // Filtering them would preferentially remove the largest errors, which are
      // mostly real delays, truncating the tail this project exists to measure.
      // A non-zero count means investigate the matcher, not the data.
      implausible: {
        count: bySource.reduce((n, r) => n + (r.implausible ?? 0), 0),
        note: 'flagged only; these rows remain in all figures above',
      },
    },

    // --- last tick ----------------------------------------------------------
    last_run: last
      ? {
          ...last,
          per_slice_counts: last.per_slice_counts
            ? (JSON.parse(last.per_slice_counts) as Record<string, number>)
            : null,
        }
      : null,
    snapshots_today: Number(today?.snapshots ?? 0),
  };
}
