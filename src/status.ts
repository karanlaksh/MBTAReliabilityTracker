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
import { serviceDate } from './service-date';
import { fetchAccountUsage, type AccountUsage } from './usage';

/** D1 free tier, rows written per UTC day. */
export const DAILY_WRITE_LIMIT = 100_000;

/**
 * D1 free tier, rows read per UTC day, ACCOUNT-WIDE.
 *
 * The one that actually failed. From at least 2026-09-02 to 2026-09-28 it was
 * exhausted by ~05:30-06:30 UTC every day and the collector lost ~18 hours of
 * data a day, while this endpoint watched only writes. See migration 0009.
 */
export const DAILY_READ_LIMIT = 5_000_000;

/**
 * collector_runs has no index on started_at. Ticks are one a minute and ids only
 * increase, so the last N ids bound a time window without paying for one. The
 * started_at filter still applies inside the bound, so the only failure mode is
 * undercounting if a window held more than N runs — 1,440/day plus the odd
 * manual or concurrent tick is well inside these margins.
 */
const RUNS_PER_UTC_DAY_BOUND = 2_000;

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
  limit: number = DAILY_WRITE_LIMIT,
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
    level: level(projected / limit),
  };
}

/**
 * The read-budget block of /status. Same projection and thresholds as writes.
 *
 * When usage cannot be fetched the level is 'unknown', never 'ok'. An absent
 * counter reading as healthy is how this ran unnoticed for four weeks.
 */
export function readBudget(
  usage: AccountUsage | null,
  usageError: string | null,
  now: number,
): Record<string, unknown> {
  const dayStart = utcDayStart(now);
  const reset = { utc_day_start: dayStart, seconds_until_reset: dayStart + DAY_SEC - now };
  if (!usage) {
    return { limit: DAILY_READ_LIMIT, level: 'unknown', error: usageError, ...reset };
  }
  const used = usage.rows_read_today;
  const projection = project(used, usage.rows_read_last_hour, now, DAILY_READ_LIMIT);
  return {
    limit: DAILY_READ_LIMIT,
    source: 'cloudflare_graphql_account_total',
    used_today: used,
    remaining: Math.max(0, DAILY_READ_LIMIT - used),
    pct_used: Number(((100 * used) / DAILY_READ_LIMIT).toFixed(1)),
    pct_projected: Number(((100 * projection.projected_eod) / DAILY_READ_LIMIT).toFixed(1)),
    ...projection,
    reads_last_hour: usage.rows_read_last_hour,
    exhausted: used >= DAILY_READ_LIMIT,
    ...reset,
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
 * Bounded by service_date, not matched_at. Nothing indexes matched_at, so the old
 * `matched_at >= ?` filter read the whole arrivals table on every call. The
 * UNIQUE (service_date, trip_id, stop_id) index makes a service_date range a
 * real range read.
 */
async function arrivalsSummary(env: Env, sinceServiceDate: string) {
  const { results } = await env.DB.prepare(
    `SELECT source, COUNT(*) AS n,
            SUM(CASE WHEN actual_arrival_at IS NULL THEN 1 ELSE 0 END) AS without_time,
            SUM(implausible) AS implausible,
            CAST(AVG(uncertainty_sec) AS INTEGER) AS mean_uncertainty_sec
       FROM arrivals WHERE service_date >= ? GROUP BY source ORDER BY n DESC`,
  )
    .bind(sinceServiceDate)
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
  // Fetched from Cloudflare, not D1, and BEFORE touching D1: when the read
  // budget is exhausted every D1 query below fails, and this block is the one
  // thing that can still say why.
  let usage: AccountUsage | null = null;
  let usageError: string | null = null;
  try {
    usage = await fetchAccountUsage(env, now);
  } catch (err) {
    usageError = err instanceof Error ? err.message : String(err);
  }
  const reads = readBudget(usage, usageError, now);

  let d1: Record<string, unknown>;
  try {
    d1 = await buildD1Status(env, now);
  } catch (err) {
    // Previously an uncaught 500 with no explanation. Now a 503 that names D1.
    return {
      collecting: false,
      d1_error: err instanceof Error ? err.message : String(err),
      read_budget: reads,
      now,
    };
  }

  const writeBudget = d1.write_budget as Record<string, unknown>;
  return {
    ...d1,
    // Exhausted reads refuse the collector's dedup-state read, so nothing new is
    // stored even though collector_runs rows still land (they are writes).
    collecting: Boolean(d1.collecting) && reads.exhausted !== true,
    write_budget: {
      ...writeBudget,
      // Cloudflare's account total beside our own count. Ours only sees what the
      // collector reports about itself; a gap between the two is unaccounted
      // writes (matcher, rollup, manual queries).
      account_reported_today: usage?.rows_written_today ?? null,
    },
    read_budget: reads,
  };
}

async function buildD1Status(env: Env, now: number): Promise<Record<string, unknown>> {
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
         FROM collector_runs
        WHERE id > (SELECT MAX(id) FROM collector_runs) - ${RUNS_PER_UTC_DAY_BOUND}
          AND started_at >= ?`,
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
         FROM collector_runs
        WHERE id > (SELECT MAX(id) FROM collector_runs) - ${RUNS_PER_UTC_DAY_BOUND}
          AND started_at >= ?`,
    )
      .bind(Math.max(dayStart, now - 3600))
      .first<{ writes: number; runs: number }>(),

    // Grouped by kind so a budget failure is never buried in a pile of unrelated
    // MBTA 503s. This is the query the guardrail exists for.
    env.DB.prepare(
      `SELECT error_kind, COUNT(*) AS n, MAX(started_at) AS last_at
         FROM collector_runs
        WHERE id > (SELECT MAX(id) FROM collector_runs) - ${RUNS_PER_UTC_DAY_BOUND}
          AND started_at >= ? AND error_kind IS NOT NULL
        GROUP BY error_kind ORDER BY n DESC`,
    )
      .bind(dayStart)
      .all<{ error_kind: string; n: number; last_at: number }>(),
  ]);

  // Bounded window for the derived summaries: the last three service dates
  // (today's open one plus the two before it), roughly the old 48h of matches.
  const summarySince = serviceDate(now - 172_800);
  const bySource = await arrivalsSummary(env, summarySince);

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
    // NO ERROR SUMMARY HERE, deliberately. This endpoint used to compute median
    // and p90 by horizon bucket using band-based selection: pick a row whose
    // stored horizon_sec falls inside the band. Measured, that graded the '0-3'
    // band at a mean horizon of 40 SECONDS -- the last prediction before arrival,
    // which converges to zero error. It reported a median of 1s and looked fine.
    //
    // The rollups use carry-forward at fixed evaluation points and disagree with
    // it. Two numbers for the same quantity in one codebase is how the wrong one
    // reaches a chart, so the wrong one is gone. Error figures come from
    // /api/error-by-horizon. /status is operational health only.
    // Never report an aggregate without its sample size and its unfulfilled rate.
    // A median error that quietly excludes the trains that never came is
    // systematically optimistic, and optimistic in exactly the cases that matter.
    matching: {
      window_since_service_date: summarySince,
      arrivals_by_source: bySource,
      graded_predictions: graded,
      unfulfilled,
      unfulfilled_rate: graded > 0 ? Number((unfulfilled / graded).toFixed(4)) : null,
      // Reported beside the rate, not inside it: MBTA published a departure time
      // but never an arrival time, so there was nothing to fulfil. Grading
      // departures is scoped out, not impossible — see README.
      no_arrival_predicted: notPromised,
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
